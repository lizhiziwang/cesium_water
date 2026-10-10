/**
 * ============================================================================
 *  ue5-water-material.js
 *  UE5 SingleLayerWater 近似 —— Cesium CustomShader 高性能水面（Web / 无第三方依赖）
 * ============================================================================
 *  依赖：CesiumJS >= 1.104（用到 Model.fromGltfAsync / CustomShader / TextureUniform）
 *
 *  设计要点
 *  1. 载体：Cesium.Model 加载「运行时生成的 glTF 面片（含 TANGENT）」，不用 Fabric 材质、
 *     不用内置 Water 材质、不用半透明 Translucent 材质流程（透明度由 shader alpha 控制）。
 *  2. 顶点：4 层 Gerstner 波位移，手动展开（shader 内无任何循环）。
 *  3. 片元：菲涅尔(IOR 1.33) + 吸收/散射近似 + 【四层】法线滚动贴图 +
 *     解析天空反射（地平线渐变 + 太阳盘 + 太阳辉光光路）+ 浪峰泡沫。
 *  4. 所有可调参数通过 uniform 暴露，命名对标 UE5 SingleLayerWater。
 *
 *  运动速度怎么控制（详见 README 第三节 E）
 *  - t = uTime × uTimeScale：uTime 由 createWater 每帧写入（默认墙钟秒），
 *    uTimeScale 是全局倍率 —— 它同时缩放顶点 Gerstner 相位与四层法线贴图的滚动。
 *    千万别改用 czm_frameNumber/60：那会让速度随帧率变（30fps 只有一半快）。
 *  - 顶点真实位移波：uGerstnerSpeed（相速度倍率）。
 *    实际相速度 c = sqrt(g·λ/(2π)) × uGerstnerSpeed，λ 由 uGerstnerWavelength 定。
 *  - 片元细节滚动：uWaveSpeedLow/Mid/High（单位 tile/秒）。
 *    实际世界速度 = uWaveSpeed × tileSize，tileSize = planeSize / uTiling。
 *
 *  与第一版的关键差别（为什么第一版看起来"均匀"）
 *  - 法线贴图：原来用整数频率正弦叠加，出来是规则网格；现改为可平铺 value-noise FBM，
 *    并有山谷/脊线混合，才像真实水面。
 *  - 采样器：原来 Sampler 默认 minificationFilter=LINEAR、anisotropy=1，法线贴图既没有
 *    mipmap 也没有各向异性过滤，掠射角下细节必然糊掉/闪掉 —— 只能靠"把 tile 放大到 500 m"
 *    来回避，结果就是一层光滑光泽面。现在开 LINEAR_MIPMAP_LINEAR + anisotropy，
 *    细节尺度可以做到米级。
 *  - 反射：原来是天顶/地平两色插值，没有地平线、没有太阳，所以"反光均匀"；
 *    现在是解析天空 + 太阳盘 + 辉光光路。
 *
 *  融入真实场景（贴到公开影像海面上）
 *  - 面片按经纬度落在真实海域（site: lon/lat/height），高度 ≈ 海平面。
 *  - uEdgeFade：面片四边 alpha 渐隐（占边长比例），让它溶解进下方的真实影像海面，
 *    而不是浮着一块生硬的方片。材质 alphaMode:BLEND，直接改 material.alpha 实现。
 *
 *  水下效果（对齐 UE5 Water 的水下）
 *  - 水面从【下方】看：uUnderwater 置 1 后切换为「斯涅尔窗 + 全反射」模型 ——
 *    入射角小于水→空气临界角(48.75°)的锥内，光折射出去看到亮天空（斯涅尔窗）；
 *    锥外全反射，看到的是暗的水体。这是水下抬头看水面的关键特征。
 *  - 场景级水下雾：createUnderwater() 加一个 PostProcessStage，用【深度纹理】还原
 *    眼空间距离后做 Beer–Lambert 距离雾 + 水下色彩分级 + 暗角 + 轻微折射扰动。
 *    相机在海面以下时启用，uAmount 做平滑过渡。
 *
 *  已知局限（详见 README.md）
 *  - 不能采样屏幕深度 => 无真实水体厚度、无折射、无岸边深度泡沫，吸收散射用视角光程近似。
 *  - 不能采样场景颜色 => 反射用解析天空近似，非 SSR。
 * ============================================================================
 */
(function (global) {
  'use strict';

  // ==========================================================================
  // 顶点着色器：4 层 Gerstner 波
  // ==========================================================================
  const VERTEX_SHADER = `
// ============================ 顶点着色器 ============================
// 1) 位移在 (T, N, B) 正交局部基中求解，与 Cesium 对 glTF Y-up 的转换细节解耦；
// 2) 4 层波完全手动展开（禁止循环）；
// 3) 通过 varying 把波面法线与波峰高度传给片元。
//
// 【重要 · 顶点端不要引用 tangentMC】
// Cesium 用正则扫描着色器源码来推断「用到了哪些顶点属性」，而且是【连注释一起扫】
// （它内部直接对原始文本跑正则，不做注释剥离）。一旦扫到 tangentMC 这个名字，
// 本着色器的顶点输入结构体里就会生成 vec4 tangentMC（类型取自 glTF TANGENT
// 访问器 = VEC4），而 Cesium 内部 ProcessedAttributes 中的 tangentMC 是硬编码
// vec3，它自动生成的初始化语句就成了 vec4 = vec3，编译直接 dimension mismatch
// 失败（Cesium 1.119 实测）。所以这里连注释都不能出现那个名字。
// 本面片在模型空间是 XZ 平面（法线 +Y、切向 +X），是生成 glTF 时已知的固定约定，
// 因此切向改由 normalMC 正交化推导。

// 单层 Gerstner：累加位置增量与两个切向量（均为 TBN 坐标系下的分量）
// p      : 平面局部坐标 (沿 T, 沿 B)
// dir    : 波传播方向（平面内单位向量）
// k      : 波数 = 2π/λ
// amp    : 振幅（米）
// Q      : 陡度（Q*k*amp <= 1 可避免自交）
// omega  : 角频率（深水色散关系 sqrt(g*k) * 速度系数）
void gerstner(vec2 p, vec2 dir, float k, float amp, float Q, float omega, float t,
              inout float dT, inout float dN, inout float dB,
              inout vec3 dPdt, inout vec3 dPdb) {
  float theta = k * dot(dir, p) - omega * t;
  float S = sin(theta);
  float C = cos(theta);
  float WA = k * amp;

  dT += Q * amp * dir.x * C;
  dB += Q * amp * dir.y * C;
  dN += amp * S;

  // 解析偏导：直接得到精确波面法线，无需再采样高度场
  dPdt += vec3(-Q * dir.x * dir.x * WA * S, dir.x * WA * C, -Q * dir.x * dir.y * WA * S);
  dPdb += vec3(-Q * dir.x * dir.y * WA * S, dir.y * WA * C, -Q * dir.y * dir.y * WA * S);
}

void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
  vec3 pos = vsInput.attributes.positionMC;

  // 局部正交基（面片为平面，由 normalMC 正交化出切向）
  vec3 Nm = normalize(vsInput.attributes.normalMC);
  vec3 Tm = normalize(vec3(1.0, 0.0, 0.0) - Nm * Nm.x);
  vec3 Bm = normalize(cross(Tm, Nm));

  vec2 p = vec2(dot(pos, Tm), dot(pos, Bm));

  // 动画时间：由 JS 侧每帧写入的 uTime（秒）驱动，再乘全局倍率 uTimeScale。
  // 【不要】在这里写 czm_frameNumber / 60.0 —— 那样速度会和真实帧率耦合：
  // 30 fps 的水波只有 60 fps 的一半快，144 fps 就是 2.4 倍。UE5 用的是 uTime（秒）。
  float t = uTime * uTimeScale;

  // 基准波长（米）由 uGerstnerWavelength 给出
  float k0 = 6.283185307179586 / max(uGerstnerWavelength, 1.0);

  // 4 个互不相同的传播方向
  vec2 dirA = normalize(vec2( 1.00,  0.28));
  vec2 dirB = normalize(vec2( 0.58,  0.81));
  vec2 dirC = normalize(vec2(-0.39,  0.92));
  vec2 dirD = normalize(vec2(-0.88,  0.47));

  // 波长比 1 : 1/1.613 : 1/2.597 : 1/4.167（等比衰减，接近真实波谱）
  // 振幅权重之和 = 1，故 uGerstnerHeight 就是最大起伏（米）
  float kA = k0 * 1.000;  float aA = uGerstnerHeight * 0.40;
  float kB = k0 * 1.613;  float aB = uGerstnerHeight * 0.28;
  float kC = k0 * 2.597;  float aC = uGerstnerHeight * 0.20;
  float kD = k0 * 4.167;  float aD = uGerstnerHeight * 0.12;

  float dT = 0.0, dN = 0.0, dB = 0.0;
  vec3  dPdt = vec3(1.0, 0.0, 0.0);
  vec3  dPdb = vec3(0.0, 0.0, 1.0);

  float g = 9.81;
  gerstner(p, dirA, kA, aA, uGerstnerSteepness, sqrt(g * kA) * uGerstnerSpeed, t, dT, dN, dB, dPdt, dPdb);
  gerstner(p, dirB, kB, aB, uGerstnerSteepness, sqrt(g * kB) * uGerstnerSpeed, t, dT, dN, dB, dPdt, dPdb);
  gerstner(p, dirC, kC, aC, uGerstnerSteepness, sqrt(g * kC) * uGerstnerSpeed, t, dT, dN, dB, dPdt, dPdb);
  gerstner(p, dirD, kD, aD, uGerstnerSteepness, sqrt(g * kD) * uGerstnerSpeed, t, dT, dN, dB, dPdt, dPdb);

  // 波面法线（TBN 坐标系）——平面时退化为 (0,1,0)
  vec3 nTbn = normalize(cross(dPdb, dPdt));

  vsOutput.positionMC = pos + Tm * dT + Nm * dN + Bm * dB;

  v_nTbn  = nTbn;
  v_crest = clamp(dN / max(uGerstnerHeight, 1e-4) * 0.5 + 0.5, 0.0, 1.0);
}
`;

  // ==========================================================================
  // 片元着色器：UE5 SingleLayerWater 近似
  // ==========================================================================
  const FRAGMENT_SHADER = `
// ============================ 片元着色器 ============================
// 对标 UE5 SingleLayerWater，受 Cesium 限制：
//  - 无屏幕深度采样 => 无真实水体厚度，"吸收/散射"用视角光程近似；
//  - 无反射探针/SSR => 反射用解析天空（地平线渐变 + 太阳盘 + 辉光）近似；
//  - 无深度缓冲泡沫 => 只做"浪峰斜率泡沫"，岸边深度泡沫不实现。
//
// 【重要】片元端登记到的属性必须都是 EC / texCoord 结尾的安全类型。
// Cesium 的属性扫描连注释一起扫，所以本文件的注释里也不出现那些名字的前缀形式。

void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec2 uv = fsInput.attributes.texCoord_0;

  // ---------- 眼空间 TBN：由模型属性构造（等价 czm_normal，但更稳妥）----------
  vec3 Te = normalize(fsInput.attributes.tangentEC);
  vec3 Ne = normalize(fsInput.attributes.normalEC);
  Te = normalize(Te - Ne * dot(Ne, Te));
  vec3 Be = normalize(cross(Ne, Te));
  mat3 modelToEye = mat3(Te, Ne, Be);   // 模型空间 -> 眼空间（旋转）

  // 同上：时间来自 JS 写入的 uTime × uTimeScale，不用 czm_frameNumber（帧率耦合）
  float t = uTime * uTimeScale;

  vec3  posEC    = fsInput.attributes.positionEC;
  float viewDist = length(posEC);
  vec3  V        = normalize(-posEC);          // 表面 -> 眼睛

  // ---------- 1. 四层法线：涌浪(大尺度) / 粗 / 中 / 细 ----------
  // 旋转用精确的 3-4-5 与 1-2-√5 比值，省掉三角函数；
  // 采样时把 UV 旋转过去，取到法线后再转回来（乘转置矩阵）。
  mat2 R1  = mat2( 0.8,      0.6,     -0.6,      0.8);       // +36.87°
  mat2 R1T = mat2( 0.8,     -0.6,      0.6,      0.8);
  mat2 R2  = mat2( 0.894427, -0.447214, 0.447214, 0.894427); // -26.57°
  mat2 R2T = mat2( 0.894427,  0.447214, -0.447214, 0.894427);
  mat2 R3  = mat2( 0.28,     0.96,     -0.96,     0.28);     // +73.74°
  mat2 R3T = mat2( 0.28,    -0.96,      0.96,     0.28);

  vec2 d0 = vec2( 0.86,  0.51);
  vec2 d1 = vec2(-0.42,  0.91);
  vec2 d2 = vec2( 0.31, -0.95);
  vec2 d3 = vec2(-0.71, -0.70);

  vec2 q0 = uv * uTilingLow  + d0 * (t * uWaveSpeedLow);
  vec2 q1 = (R1 * uv) * uTilingMid  + d1 * (t * uWaveSpeedMid);
  vec2 q2 = (R2 * uv) * uTilingHigh + d2 * (t * uWaveSpeedHigh);
  vec2 q3 = (R3 * uv) * uTilingSwell + d3 * (t * uWaveSpeedSwell);   // 最粗：涌浪

  vec3 n0 = texture(uNormalMap0, q0).xyz * 2.0 - 1.0;

  // 用最粗一层去扰动中/细两层的 UV：细纹"骑"在大浪上，同时打散每层
  // 各自的平铺 repetition（否则 tile 重复图案会暴露成规则的网格纹）
  q1 += n0.xy * uDomainWarp * 0.60;
  vec3 n1 = texture(uNormalMap1, q1).xyz * 2.0 - 1.0;
  q2 += n0.xy * uDomainWarp;
  vec3 n2 = texture(uNormalMap2, q2).xyz * 2.0 - 1.0;
  vec3 n3 = texture(uNormalMap3, q3).xyz * 2.0 - 1.0;

  vec2 s0 = n0.xy;
  vec2 s1 = R1T * n1.xy;
  vec2 s2 = R2T * n2.xy;
  vec2 s3 = R3T * n3.xy;

  // 最细一层按距离淡出（mipmap + 各向异性已保证采样质量，这里只是让远景更"整"）
  float fadeHigh = 1.0 - smoothstep(uFadeNear, uFadeFar, viewDist);

  // 【跨尺度能量守恒】细层淡出时必须把权重交给粗层，否则远处总法线方差越来越小，
  // 整片海就"越远越平"。所以涌浪层权重随距离【增大】（与细层相反）：
  //   近处 0.18（只是轻微倾斜）→ 远处 0.78（撑起整片海的明暗波带）
  // 这样远处靠低频波带、近处靠高频碎波，法线总能量大致守恒，不会出现"细节悬崖"。
  float swellBoost = mix(uStrengthSwellFar, uStrengthSwellNear, fadeHigh);

  vec2 slope = s3 * swellBoost
             + s0 * uStrengthLow
             + s1 * uStrengthMid
             + s2 * uStrengthHigh * fadeHigh;

  // ---------- 2. 合成波面法线（顶点 Gerstner + 片元涟漪）----------
  vec3 nTbn = normalize(vec3(v_nTbn.x + slope.x * uNormalStrength,
                             v_nTbn.y,
                             v_nTbn.z + slope.y * uNormalStrength));
  vec3 N = normalize(modelToEye * nTbn);

  // ---------- 3. 太阳 ----------
  vec3 L     = normalize(czm_sunDirectionEC);
  vec3 upEC  = Ne;      // 面片法线 ≈ 世界的"上"，用来判断反射方向的仰角

  // ---------- 4. 菲涅尔（IOR = 1.33 => F0 = ((1-1.33)/(1+1.33))^2 ≈ 0.0201）----------
  const float F0 = 0.0201;
  float NdV     = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdV, uFresnelPower);

  // ---------- 5. 解析天空反射 ----------
  // 仰角 elev: 反射方向与"上"的夹角余弦；0 = 地平线，1 = 天顶
  vec3  R    = reflect(-V, N);
  float elev = dot(R, upEC);
  float skyT = clamp(elev, 0.0, 1.0);

  // 天顶 -> 地平线 渐变，再压一层地平线雾带，形成那条典型的亮边
  vec3 sky = mix(uHorizonColor, uSkyColor, pow(skyT, uSkyGradientPow));
  sky = mix(sky, uHorizonHaze, (1.0 - smoothstep(0.0, 0.12, skyT)) * uHorizonHazeStrength);

  // 【地平线以下反射的是"远处的海面"，不是天空 —— 不能只把天空色乘暗】
  // 反射方向落到地平线以下，打到的是远场海面/地表。之前偷懒用 sky *= (1-0.70)：
  // 亮色天空被压暗后是"中灰"，再被高菲涅尔（这类背坡面片 NdV 小）放大，
  // 就是大片平灰斑块（实测用户截图红框）。
  // 正确做法：往"远海色"（深水基色方向的暗青蓝）混合 —— 明暗波带的对比还在
  // （这就是 uBelowHorizonDark 的作用），但色调是暗海而不是死灰。
  float belowT = 1.0 - smoothstep(-0.06, 0.0, elev);       // 1 = 地平线以下
  vec3  farSea  = uAbsorptionColor * 0.85 + uScatteringColor * 0.08;
  vec3  reflCol = mix(sky, farSea, belowT * uBelowHorizonDark);

  float sunDot = dot(R, L);

  // 【宽角前向散射】真实天空在太阳周围一大片区域都会变亮（气溶胶 + 分子散射），
  // 不只是太阳盘本身。缺了它，水面反光没有"方向感"。
  // 但注意量级：这是"增亮"，不是"加白色洪水"。pow 取 20（约 10° 内最强、45° 外基本
  // 衰减完），强度给 0.45 左右 —— 给大了整个反射面会被冲成灰白（第一版 0.55/pow6 就翻车）。
  sky += pow(max(sunDot, 0.0), 20.0) * uSkyForwardScatter * uSunColor;

  // 太阳盘（镜面里的太阳像） + 窄辉光（贴着光路的核心）
  float sunDisc = smoothstep(uSunDiscCos, uSunDiscCos + 0.0004, sunDot);
  float sunGlow = pow(max(sunDot, 0.0), uSunGlowPow);
  vec3  reflected = reflCol
                  + sunDisc * uSunDiscIntensity * uSunColor
                  + sunGlow * uSunGlowIntensity * uSunColor;

  // 波峰高度（0.5 = 平均水面）。泡沫与背光透光都要用，所以提前算。
  float crest = clamp(v_crest, 0.0, 1.0);

  // ---------- 6. 水体吸收 / 散射（无屏幕深度，用视角光程近似）----------
  // 【关键】吸收量级必须是"每米"的真实值，不能拿深水基色（近似黑）当系数用 ——
  // 那样 exp(-0.002 × path) ≈ 1，thinness 只在 0.96~0.90 之间摆动，
  // 整片水就成了与深度无关的一块平色（第一版正是这个毛病）。
  // 真实海水：红光吸收最快（~0.4/m）、蓝绿最慢（~0.04/m）→ 水呈青蓝。
  // 这一项就是 UE 水面"近处偏青、远处沉暗"那层深浅梯度的来源。
  float opticalPath = uDepthScale / max(NdV, 0.12);
  vec3  transmit    = exp(-uAbsorptionCoeff * uAbsorptionStrength * opticalPath);
  float thinness    = dot(transmit, vec3(0.2126, 0.7152, 0.0722));
  vec3  bodyColor   = mix(uAbsorptionColor, uScatteringColor, thinness);

  // ---------- 6.5 背光波峰透光 ----------
  // 视线朝着太阳看时，光会从波峰背面透过来，波峰呈亮青绿色 —— UE 水面的标志性特征，
  // 也是"死水"和"活水"的分界。用 V·(−L) 做背光权重，乘波峰高度。
  float crestHi = smoothstep(0.45, 1.0, crest);
  float backLit = pow(max(dot(V, -L), 0.0), 4.0);
  bodyColor += uScatteringColor * (backLit * crestHi * uCrestTranslucency);

  // ---------- 7. 太阳高光：各向异性拉伸，形成顺着风向的闪鳞 ----------
  // 【高光 LOD】远处纹素在屏幕上被严重压缩，mipmap 把高频法线平均掉了，
  // 此时仍用 uSpecularPower（≈几度的高光瓣）必然打不中任何波面斜率，
  // 结果太阳光路就是一片平滑的白斑 —— 真实/UE 的做法是随距离展宽高光瓣
  // （roughness 随纹素覆盖增大），于是远处呈现的是"随波纹闪动的宽带"。
  vec3  H     = normalize(L + V);
  float NdH   = max(dot(N, H), 0.0);
  float TdH   = dot(Te, H);
  float aniso = mix(1.0, sqrt(max(1.0 - TdH * TdH, 0.0)), uSpecularAniso);
  float specPow = mix(uSpecularPowerFar, uSpecularPower, fadeHigh);
  float spec  = uSpecularIntensity * pow(NdH, specPow) * aniso;
  spec *= smoothstep(-0.05, 0.25, dot(N, L));    // 太阳落到地平线下即无高光

  // ---------- 8. 浪峰泡沫 ----------
  // 泡沫主要由【法线坡度】驱动（逐纹素、细碎、随波纹滚动），顶点波峰只做低频调制；
  // 再叠一层中层法线的 R 通道当"破碎噪声"，避免泡沫连成大片棉花团。
  // （顶点网格是 20 m 一格，单靠 crest 出来的泡沫必然是一颗颗大圆包。）
  // crest 已在第 5 节算过。
  float slopeMag = length(slope);
  float brk      = texture(uNormalMap1, q1 * 0.53).r;
  float foamMask = slopeMag * (0.85 + 0.5 * brk) + crest * 0.30;
  float foam     = smoothstep(uFoamThreshold, uFoamThreshold + uFoamSharpness, foamMask);

  // ---------- 9. 合成 ----------
  vec3 color = mix(bodyColor, reflected, fresnel);
  color += spec * uSunColor;
  color  = mix(color, uFoamColor, foam);

  // ---------- 9.5 大气透视：与 Cesium 给地表影像加的距离雾保持一致 ----------
  // Cesium 对 globe 上的影像瓦片会应用 scene.fog（远处被压向天色），而模型是 UNLIT
  // 的 CustomShader，【不会】自动得到这层雾。不补上的话，拉远看时水面比周围的
  // 影像海面更深、更饱和 —— 一眼就能看出那是一块"贴上去的方片"。
  // 这里用与 czm_fog 相同的二次型 1 - exp(-(d·ρ)²)，密度做成可调以便对齐不同底图。
  float hazeT = 1.0 - exp(-pow(viewDist * uHazeDensity, 2.0));
  color = mix(color, uHorizonHaze, hazeT);

  // ---------- 10. 水下：从下方看水面（斯涅尔窗 + 全反射）----------
  // 相机在水面以下时，水面就成了"天花板"。物理上：
  //  - 入射角 < 水→空气临界角 48.75°：光折射出去看到天空 → 亮锥（斯涅尔窗）
  //  - 更大角度：全反射，光被弹回水里 → 看到的是暗的水体
  // 这正是水下抬头那几个亮"光窗"的成因，也是水下画面里最容易一眼认出的特征。
  // 【太阳透光】窗心还要能看见太阳（折射后的烈日 + 辉光），见下方 uSunBody/uSunHalo。
  // 注意 N 仍是朝上的几何法线，而水下时 V 朝下（表面→眼睛），故入射角取 |dot(N,V)| 的余角。
  // 【逐片元判定观察侧】水面用"水上"还是"水下"模型，由每个片元自己定：
  // V 是"片元→眼睛"，眼睛在片元下方时它朝下（dot(Ne,V)<0）。
  // 【不要】再拿 CPU 的 uUnderwater 来 max/门控 —— 模式有迟滞、波峰波谷又有 ±振幅，
  // "模式已水下、眼睛其实在波谷之上"时从上方看会退化成无波平板（实测截图）；
  // 反过来"模式还是水上、眼睛已低于眼前浪头"时不按水下画则是一片平黑。
  // 侧判定对两种错位都免疫，水上/水下的过渡正好发生在视线掠过水面的那圈像素上。
  // uUnderwater 现在只管后处理（色彩分级/光柱/背景压色）。
  float sideSign = dot(Ne, V);
  float underHere = 1.0 - smoothstep(-0.015, 0.015, sideSign);
  if (underHere > 0.001) {
    float cosI = clamp(abs(dot(N, V)), 0.0, 1.0);
    float sinI = sqrt(max(0.0, 1.0 - cosI * cosI));
    const float SIN_CRIT = 0.7519;                      // sin(48.75°)
    float wnd = 1.0 - smoothstep(SIN_CRIT - 0.14, SIN_CRIT + 0.09, sinI);
    // 临界角附近常有一圈"亮边"：光沿水面掠射时折射率急剧变化，窗沿会比窗心还亮一线
    float rim = smoothstep(SIN_CRIT - 0.20, SIN_CRIT - 0.02, sinI)
              * (1.0 - smoothstep(SIN_CRIT - 0.02, SIN_CRIT + 0.16, sinI));

    // 【太阳透光】水下抬头之所以能看见太阳，是因为视线穿过水面时按斯涅尔定律折射出去。
    // 把"眼→水面"的视线用 refract(水→空气, n=1.333) 折到空气一侧，再与太阳方向比对：
    // 对齐就是太阳本体（很窄的高次幂），稍偏是贴盘辉光，再外是大范围天空增亮。
    // 缺了它，窗里只是一片平滑天色 —— 看着"闷、假"，这正是与 UE 水下差距最大的一处。
    // 注意：N 朝上、入射方向(眼→面)也朝上，GLSL refract 要求法线迎着入射光，故用 -N。
    // 波面法线抖动会让折射方向左右晃 -> 太阳不再是死点，而是随波闪动的亮斑（真实且好看）。
    // 【曝光】太阳本体/辉光的系数不能给大：窗心一旦顶到纯白，后处理的 god rays 会把
    // 整个窗区连带糊成一片白（实测第一版 4.0/1.30 直接过曝）。
    vec3  eyeToSurf = normalize(-V);
    vec3  refrAir   = refract(eyeToSurf, -N, 1.333);
    float refrOK    = step(1e-4, dot(refrAir, refrAir));       // 全反射时 refract 返回 0 向量
    float usc       = max(dot(normalize(refrAir + 1e-5), L), 0.0) * refrOK;
    float uSunBody  = pow(usc, 900.0) * 1.40;                  // 太阳本体（够宽，抵消波面抖动）
    float uSunHalo  = pow(usc, 40.0) * 0.75                    // 贴盘辉光
                    + pow(usc, 8.0)  * 0.15;                   // 大范围天空增亮

    vec3 skyThru = mix(uHorizonColor, uSkyColor, 0.55) * 1.05
                 + (uSunBody + uSunHalo) * uSunColor;          // 窗内：折射出去的天空 + 太阳透光
    vec3 tir     = uAbsorptionColor + uScatteringColor * 0.10;  // 窗外：全反射，看到的是水体而非死黑
    vec3 underCol = mix(tir, skyThru, wnd);

    // 水下距离雾：光从水面传到眼睛这段光程的衰减。viewDist 正好就是这段距离 ——
    // 【这里必须在水shader里做，不能交给后处理】：水面是半透明(BLEND)材质，
    // 不写深度，后处理在水面上读到的深度是背后的天空/海底(几百米)，
    // 雾会直接吃满，整个画面糊成一色（实测全屏变成一片均匀深蓝）。
    float fog = clamp(1.0 - exp(-viewDist * uUnderFogDensity), 0.0, uUnderMaxFog);
    underCol = mix(underCol, uUnderDeepColor, fog);

    underCol += rim * uSunColor * 0.25;                 // 窗沿亮环：临界角处的掠射高亮带
    underCol += foam * 0.12 * uSunColor;                // 波峰碎浪在窗边上闪
    color = mix(color, underCol, underHere);
  }

  // ---------- 11. 边缘羽化：把面片"贴进"真实场景 ----------
  // uv 在 0..1 之间（生成 glTF 时写入的 TEXCOORD_0）。
  // 取到四边的最小距离，最外圈 uEdgeFade（占边长比例）内 alpha 渐隐到 0 ——
  // 这样 8 km 面片不再是浮在真实海面上的一块方片，而是边缘溶解进下方影像。
  // 材质是 alphaMode:BLEND，所以直接改 material.alpha 即可。
  float edge     = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float edgeFade = (uEdgeFade > 0.0) ? smoothstep(0.0, uEdgeFade, edge) : 1.0;

  material.diffuse = color;
  material.alpha   = mix(uAlpha, 1.0, foam) * edgeFade;
}
`;

  // ==========================================================================
  // 运行时生成 glTF 2.0 (.glb) 面片
  //  - 平面位于 glTF 的 XZ 平面、法线 +Y（glTF 标准 Y-up 的水平地面）
  //  - 必须携带 TANGENT：片元端用 normalEC/tangentEC 构造 TBN，从而不依赖 czm_normal
  // ==========================================================================
  function buildPlaneGlb(segments, size) {
    const N = segments + 1;
    const vCount = N * N;
    const iCount = segments * segments * 6;

    const positions = new Float32Array(vCount * 3);
    const normals = new Float32Array(vCount * 3);
    const tangents = new Float32Array(vCount * 4);
    const uvs = new Float32Array(vCount * 2);

    let pi = 0, ni = 0, ti = 0, ui = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const fx = i / segments;
        const fz = j / segments;
        positions[pi++] = (fx - 0.5) * size;
        positions[pi++] = 0;
        positions[pi++] = (fz - 0.5) * size;
        normals[ni++] = 0; normals[ni++] = 1; normals[ni++] = 0;
        tangents[ti++] = 1; tangents[ti++] = 0; tangents[ti++] = 0; tangents[ti++] = 1;
        uvs[ui++] = fx; uvs[ui++] = fz;
      }
    }

    const indices = new Uint32Array(iCount);
    let k = 0;
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        indices[k++] = a; indices[k++] = c; indices[k++] = b;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      }
    }

    const posLen = positions.byteLength;
    const nrmLen = normals.byteLength;
    const tanLen = tangents.byteLength;
    const uvLen = uvs.byteLength;
    const idxLen = indices.byteLength;
    const binLen = posLen + nrmLen + tanLen + uvLen + idxLen;

    const bin = new Uint8Array(binLen);
    let o = 0;
    bin.set(new Uint8Array(positions.buffer), o); o += posLen;
    bin.set(new Uint8Array(normals.buffer), o); o += nrmLen;
    bin.set(new Uint8Array(tangents.buffer), o); o += tanLen;
    bin.set(new Uint8Array(uvs.buffer), o); o += uvLen;
    bin.set(new Uint8Array(indices.buffer), o); o += idxLen;

    const half = size / 2;
    const json = {
      asset: { version: '2.0', generator: 'ue5-water-material.js' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{
        primitives: [{
          attributes: { POSITION: 0, NORMAL: 1, TANGENT: 2, TEXCOORD_0: 3 },
          indices: 4, material: 0, mode: 4,
        }],
      }],
      materials: [{
        name: 'WaterSurface',
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.4 },
        alphaMode: 'BLEND',
        doubleSided: true,
      }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: vCount, type: 'VEC3', min: [-half, 0, -half], max: [half, 0, half] },
        { bufferView: 1, componentType: 5126, count: vCount, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: vCount, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: vCount, type: 'VEC2' },
        { bufferView: 4, componentType: 5125, count: iCount, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posLen, target: 34962 },
        { buffer: 0, byteOffset: posLen, byteLength: nrmLen, target: 34962 },
        { buffer: 0, byteOffset: posLen + nrmLen, byteLength: tanLen, target: 34962 },
        { buffer: 0, byteOffset: posLen + nrmLen + tanLen, byteLength: uvLen, target: 34962 },
        { buffer: 0, byteOffset: posLen + nrmLen + tanLen + uvLen, byteLength: idxLen, target: 34963 },
      ],
      buffers: [{ byteLength: binLen }],
    };

    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const binPad = (4 - (binLen % 4)) % 4;
    const jsonChunkLen = jsonBytes.length + jsonPad;
    const binChunkLen = binLen + binPad;
    const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

    const glb = new ArrayBuffer(total);
    const dv = new DataView(glb);
    const u8 = new Uint8Array(glb);
    let p = 0;
    dv.setUint32(p, 0x46546c67, true); p += 4;               // 'glTF'
    dv.setUint32(p, 2, true); p += 4;                        // version 2
    dv.setUint32(p, total, true); p += 4;                    // total length
    dv.setUint32(p, jsonChunkLen, true); p += 4;             // JSON chunk length
    dv.setUint32(p, 0x4e4f534a, true); p += 4;               // 'JSON'
    u8.set(jsonBytes, p); p += jsonBytes.length;
    for (let i = 0; i < jsonPad; i++) u8[p++] = 0x20;        // 空格补齐
    dv.setUint32(p, binChunkLen, true); p += 4;              // BIN chunk length
    dv.setUint32(p, 0x004e4942, true); p += 4;               // 'BIN\0'
    u8.set(bin, p); p += binLen;
    for (let i = 0; i < binPad; i++) u8[p++] = 0;            // 0 补齐
    return glb;
  }

  // ==========================================================================
  // 程序化生成「可平铺」法线贴图（不引入任何外部贴图资源）
  //
  //  高度场 = 可平铺 value-noise 的 FBM 叠加（lattice 取模实现无缝）
  //  法线   = 对高度场做环绕有限差分 -> 归一化 -> RGB 编码
  //
  //  为什么不用整数频率正弦叠加：那样叠出来是规则网格，水面看起来是"均匀的"。
  //  lattice 尺寸在 x/y 上取不同值可以让纹理出现各向异性的"风纹"。
  // ==========================================================================
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 可平铺 FBM 高度场
   * @param {number} size   边长（2 的幂）
   * @param {object} opts   { seed, octaves, gridX, gridY, gain, ridge }
   * @returns {Float32Array} size*size，归一化到 0..1
   */
  function makeTileableHeightField(size, opts) {
    opts = opts || {};
    const seed = opts.seed >>> 0;
    const octaves = opts.octaves || 5;
    const gain = typeof opts.gain === 'number' ? opts.gain : 0.55;
    const ridge = typeof opts.ridge === 'number' ? opts.ridge : 0.0;
    const rnd = mulberry32(seed);

    const h = new Float32Array(size * size);
    let amp = 1.0;
    let gx = Math.max(2, Math.round(opts.gridX || 3));
    let gy = Math.max(2, Math.round(opts.gridY || 2));

    for (let o = 0; o < octaves; o++) {
      const lat = new Float32Array(gx * gy);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();

      for (let y = 0; y < size; y++) {
        const fy = (y / size) * gy;
        const iy0 = Math.floor(fy) % gy;
        const iy1 = (iy0 + 1) % gy;
        const ty = fy - Math.floor(fy);
        const sy = ty * ty * (3 - 2 * ty);          // smoothstep 插值
        const row0 = iy0 * gx, row1 = iy1 * gx, rowH = y * size;

        for (let x = 0; x < size; x++) {
          const fx = (x / size) * gx;
          const ix0 = Math.floor(fx) % gx;
          const ix1 = (ix0 + 1) % gx;
          const tx = fx - Math.floor(fx);
          const sx = tx * tx * (3 - 2 * tx);

          const v00 = lat[row0 + ix0], v10 = lat[row0 + ix1];
          const v01 = lat[row1 + ix0], v11 = lat[row1 + ix1];
          const v0 = v00 + (v10 - v00) * sx;
          const v1 = v01 + (v11 - v01) * sx;
          let v = v0 + (v1 - v0) * sy;

          // ridge：把谷底折成尖脊，水面更有"碎浪"感（可选）
          if (ridge > 0.0) v = v + (1.0 - Math.abs(v * 2.0 - 1.0) - v) * ridge;

          h[rowH + x] += amp * v;
        }
      }

      amp *= gain;
      gx *= 2;
      gy *= 2;
    }

    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < h.length; i++) {
      const v = h[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const inv = 1 / Math.max(mx - mn, 1e-9);
    for (let i = 0; i < h.length; i++) h[i] = (h[i] - mn) * inv;
    return h;
  }

  /**
   * 高度场 -> 法线贴图 RGBA 数据（环绕有限差分，自动归一化到指定最大倾角）
   * 约定：R 对应 U 方向（即切向 T），G 对应 V 方向（即副切向 B）
   */
  function heightFieldToNormalData(h, size, targetSlope) {
    const slope = typeof targetSlope === 'number' ? targetSlope : 0.6;
    const dx = new Float32Array(size * size);
    const dy = new Float32Array(size * size);
    let maxMag = 1e-9;

    for (let y = 0; y < size; y++) {
      const yc = y * size;
      const yp = ((y + 1) % size) * size;
      const ym = ((y - 1 + size) % size) * size;
      for (let x = 0; x < size; x++) {
        const xp = (x + 1) % size;
        const xm = (x - 1 + size) % size;
        const gx = (h[yc + xp] - h[yc + xm]) * 0.5;
        const gy = (h[yp + x] - h[ym + x]) * 0.5;
        const i = yc + x;
        dx[i] = gx; dy[i] = gy;
        const m = Math.sqrt(gx * gx + gy * gy);
        if (m > maxMag) maxMag = m;
      }
    }

    const data = new Uint8Array(size * size * 4);
    const k = slope / maxMag;
    for (let i = 0; i < size * size; i++) {
      const nx = -dx[i] * k;
      const ny = -dy[i] * k;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = i * 4;
      data[o]     = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
    return data;
  }

  /**
   * 生成水面法线贴图 uniform（开启 mipmap + 各向异性过滤）
   *
   * 【关键】Cesium 的 Sampler 默认 minificationFilter=LINEAR、maximumAnisotropy=1，
   * 也就是既没有 mipmap 也没有各向异性。而 Cesium 的 WebGL2 纹理路径会在
   * minificationFilter 是 mipmap 家族时自动 generateMipmap()，maximumAnisotropy 也
   * 会在扩展可用时直接透传。水面几乎是全掠射角观察，不开各向异性必然糊成一片。
   */
  function makeWaterNormalUniform(size, opts) {
    const h = makeTileableHeightField(size, opts);
    const data = heightFieldToNormalData(h, size, (opts && opts.targetSlope) || 0.6);
    const o = opts || {};
    return new Cesium.TextureUniform({
      typedArray: data,
      width: size,
      height: size,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      repeat: true,                                                    // REPEAT 双向
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
      maximumAnisotropy: o.maximumAnisotropy || 8,
    });
  }

  // 四层法线贴图的默认配方（尺度从粗到细）
  //  gridX/gridY 是第 0 个 octave 的 lattice 密度（每个 octave 翻倍）。
  //  密度太低会让 tile 里只有几个大鼓包 —— 平铺 repetition 一眼就能看出来；
  //  密度太高则最高频超出纹素密度，mipmap 之后又糊回去。4×3 ~ 6×5 比较稳。
  const NORMAL_LAYERS = [
    { seed: 20240621, octaves: 5, gridX: 4, gridY: 3, gain: 0.55, ridge: 0.10, targetSlope: 0.50 },
    { seed: 987654321, octaves: 5, gridX: 5, gridY: 4, gain: 0.55, ridge: 0.18, targetSlope: 0.55 },
    { seed: 135791357, octaves: 5, gridX: 6, gridY: 5, gain: 0.52, ridge: 0.28, targetSlope: 0.60 },
    // 第 4 层【涌浪】：tile 很大（~800 m），gridX≠gridY 做出长脊 -> 像成排的涌浪带。
    // 它专门负责大尺度：远处高频被 mipmap 抹平后，就靠这一层撑住"整片海"的明暗。
    { seed: 24681357, octaves: 6, gridX: 4, gridY: 2, gain: 0.58, ridge: 0.0, targetSlope: 0.45 },
  ];

  // 颜色统一转线性：CustomShader 的 material.diffuse 恒为线性空间
  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function hexToLinear(hex) {
    const col = Cesium.Color.fromCssColorString(hex);
    return new Cesium.Cartesian3(
      srgbToLinear(col.red), srgbToLinear(col.green), srgbToLinear(col.blue)
    );
  }

  // ==========================================================================
  // 参数预置：写实海洋 / 湖泊
  //
  //  【铺贴尺度是怎么定的】uTiling* 是"整块 8000 m 面片上铺几遍"，于是
  //    texel 世界尺寸 = 8000 / (uTiling × 256)。
  //  掠射角下 mipmap + 各向异性(8x) 大约能扛 8:1 的压缩，再细就会摩尔纹/闪，
  //  所以 texel 尺寸压在 0.05 ~ 0.5 m 这一档，而不是一味调大 uTiling：
  //    ocean: 62  遍 → 129 m/tile · texel 0.50 m（涌浪级别的明暗起伏）
  //           200 遍 →  40 m/tile · texel 0.16 m（主波纹）
  //           640 遍 → 12.5 m/tile · texel 0.05 m（近处碎波，远处淡出）
  //  uWaveSpeed* 的单位是 tile/秒；换算成米/秒 = speed × tileSize。
  // ==========================================================================
  const PRESETS = {
    ocean: {
      // ---- 对标 UE5 SingleLayerWater 的核心参数 ----
      //  uAbsorptionCoeff 是【每米】的真实吸收系数（UE 的 AbsorptionCoefficients）：
      //  红光 0.42/m 被吃掉最快、蓝绿最慢 → 水自然呈青蓝。深水基色另由 uAbsorptionColor 给。
      uAbsorptionCoeff:   [0.42, 0.085, 0.045],
      uAbsorptionStrength: 1.0,      // 面板上的总控倍率
      uAbsorptionColor:   '#07222e', // 无限深时的水色（不要给纯黑，会成死黑）
      uScatteringColor:   '#2a8fa3',
      uFresnelPower:      5.0,
      uWaveSpeedLow:      0.003,     // 129 m tile × 0.003 ≈ 0.39 m/s
      uWaveSpeedMid:      0.018,     //  40 m tile × 0.018 ≈ 0.72 m/s
      uWaveSpeedHigh:     0.088,     // 12.5 m tile × 0.088 ≈ 1.10 m/s
      uSpecularIntensity: 1.6,
      uFoamThreshold:     0.55,
      uFoamColor:         '#eef7f5',

      // ---- 法线（涌浪 + 粗/中/细）----
      uNormalStrength:    1.00,
      uTilingLow:         62,        // 粗：129 m / tile（涌浪明暗）
      uTilingMid:         200,       // 中：40 m / tile（主波纹）
      uTilingHigh:        640,       // 细：12.5 m / tile（近处碎波）
      uStrengthLow:       0.42,
      uStrengthMid:       0.60,
      uStrengthHigh:      0.38,
      // ---- 第四层：涌浪（大尺度）----
      uTilingSwell:       10,        // 800 m / tile，texel 3.1 m
      uStrengthSwellNear: 0.18,      // 近处：只是给水面一点大尺度倾斜
      uStrengthSwellFar:  0.78,      // 远处：细层淡出后由它撑起明暗波带
      uWaveSpeedSwell:    0.030,     // 800 m tile × 0.030 ≈ 24 m/s（与顶点波同量级）
      uDomainWarp:        0.35,
      uFadeNear:          300,       // 细层从 300 m 开始淡出，2000 m 全消失
      uFadeFar:           2000,

      // ---- Gerstner 顶点波（4 层）----
      uGerstnerHeight:    1.8,
      uGerstnerWavelength: 340,
      uGerstnerSteepness: 0.85,
      uGerstnerSpeed:     1.0,

      // ---- 高光 / 泡沫 / 通透度 ----
      uSpecularPower:     1200,
      uSpecularPowerFar:  90,        // 远处高光瓣展宽（高光 LOD）
      uSpecularAniso:     0.60,
      uFoamSharpness:     0.22,
      uAlpha:             0.98,
      uDepthScale:        6.0,       // 参考光程（米）：越大水越快变深
      uCrestTranslucency: 0.30,      // 背光波峰透光强度
      // ---- 融入真实场景：面片边缘羽化（占边长的比例）----
      // 0 = 不羽化（会看到一块生硬的方片）；0.06 = 最外圈 6%（8000 m 面片 => 480 m）
      // 的 alpha 渐隐到 0，与下方的真实影像海面无缝衔接。
      uEdgeFade:          0.06,
      // ---- 水下：水面从下方看的模型（0=正常水上，1=完全水下）----
      // 由 createUnderwater 的过渡量每帧写入，相机越过海面时自动切换。
      uUnderwater:        0.0,
      uUnderFogDensity:   0.045,     // 水下：光程衰减（1/m），能见度约 40~60 m
      uUnderMaxFog:       0.96,      // 水下：雾上限
      uUnderDeepColor:    '#0d3b4d', // 水下：远处水体收敛色（线性空间，光照用）
      // ---- 融入真实场景：大气透视（匹配 Cesium 给影像加的距离雾）----
      // 二次型 1-exp(-(d·ρ)²)。ρ=2.5e-5 时：3 km 约 1%、10 km 约 6%、15 km 约 13%（温和的地平线融合）。
      uHazeDensity:       2.5e-5,

      // ---- 解析天空 ----
      uSkyColor:          '#2f6092', // 天顶色（只影响水里的反射）：够暗才显得水深
      uHorizonColor:      '#a9c6d8',
      uHorizonHaze:       '#dfeef2',
      uHorizonHazeStrength: 0.30,
      uSkyGradientPow:    0.55,
      uSkyForwardScatter: 0.45,      // 太阳附近的宽角前向散射（让反光有方向）
      uBelowHorizonDark:  0.70,      // 反射落到地平线以下时混入"远海色"的比例（远场明暗波带的来源）
      uSunColor:          '#fff2d8',
      uSunDiscCos:        0.99960,
      uSunDiscIntensity:  3.0,
      uSunGlowIntensity:  0.45,
      uSunGlowPow:        260,
    },
    lake: {
      uAbsorptionCoeff:   [0.40, 0.09, 0.12],   // 蓝被吃掉更多 → 偏绿
      uAbsorptionStrength: 0.8,
      uAbsorptionColor:   '#10281f',
      uScatteringColor:   '#4f9a83',
      uFresnelPower:      6.5,
      uWaveSpeedLow:      0.001,
      uWaveSpeedMid:      0.005,
      uWaveSpeedHigh:     0.026,
      uSpecularIntensity: 0.85,
      uFoamThreshold:     0.72,
      uFoamColor:         '#f6fbf8',

      uNormalStrength:    0.62,
      uTilingLow:         40,
      uTilingMid:         130,
      uTilingHigh:        420,
      uStrengthLow:       0.40,
      uStrengthMid:       0.50,
      uStrengthHigh:      0.30,
      uTilingSwell:       22,        // 364 m / tile（湖面尺度小）
      uStrengthSwellNear: 0.14,
      uStrengthSwellFar:  0.52,
      uWaveSpeedSwell:    0.006,
      uDomainWarp:        0.22,
      uFadeNear:          200,
      uFadeFar:           1400,

      uGerstnerHeight:    0.22,
      uGerstnerWavelength: 46,
      uGerstnerSteepness: 0.55,
      uGerstnerSpeed:     0.75,

      uSpecularPower:     1800,
      uSpecularPowerFar:  140,
      uSpecularAniso:     0.35,
      uFoamSharpness:     0.14,
      uAlpha:             0.90,
      uDepthScale:        3.0,
      uCrestTranslucency: 0.12,
      uEdgeFade:          0.06,      // 面片边缘羽化（融入真实场景）
      uUnderwater:        0.0,       // 水下：水面从下方看的模型
      uUnderFogDensity:   0.045,     // 水下：光程衰减（1/m）
      uUnderMaxFog:       0.96,      // 水下：雾上限
      uHazeDensity:       2.5e-5,    // 大气透视（匹配影像距离雾）

      uSkyColor:          '#4c7ea6',
      uHorizonColor:      '#cfe0e6',
      uHorizonHaze:       '#eef4f4',
      uHorizonHazeStrength: 0.42,
      uSkyGradientPow:    0.62,
      uSkyForwardScatter: 0.40,
      uBelowHorizonDark:  0.55,
      uSunColor:          '#fff6e2',
      uSunDiscCos:        0.99960,
      uSunDiscIntensity:  2.2,
      uSunGlowIntensity:  1.0,
      uSunGlowPow:        160,
    },
  };

  // ==========================================================================
  // 水下效果：场景级后处理（色彩分级 + 暗角 + 折射扰动）
  //
  //  【为什么后处理不做距离雾】水面是半透明(BLEND)材质，不写深度缓冲 ——
  //  后处理在水面上读到的深度是它背后的天空/海底（几百米），雾会直接吃满，
  //  整幅画面糊成一色（实测全屏变成均匀深蓝，斯涅尔窗完全看不见）。
  //  所以水下距离雾放在【水面着色器】里（uUnderFogDensity，用 viewDist 光程，物理正确），
  //  背景的水色由 Cesium 自己的 scene.fog 负责（createUnderwater 里切换）。
  //  后处理只做：压红提蓝绿的水下色彩分级 + 暗角 + 折射扰动。
  //
  //  【坑】后处理拿到的是【显示空间(sRGB)】的颜色（scene.highDynamicRange 默认 false），
  //  所以这里的颜色必须用 sRGB 的 0~1 值。千万别用 hexToLinear —— 那是给
  //  CustomShader（在线性空间做光照）准备的，拿来当水色整幅画面会暗一个数量级（实测全黑）。
  // ==========================================================================
  const UNDERWATER_FRAGMENT_SHADER = `
// ============================ 水下后处理 ============================
uniform sampler2D colorTexture;

uniform float uAmount;        // 0 = 水上（直通），1 = 完全水下
uniform vec3  uShallowColor;  // 水下基调（近处/浅水）
uniform float uVignette;      // 暗角强度
uniform float uDistortion;    // 折射扰动幅度（uv 比例）
uniform float uTime;          // 墙钟秒（与帧率解耦）

// ---- 太阳光柱 (god rays / 屏幕空间体积光) ----
uniform vec2  uSunScreen;         // 太阳在屏幕上的 UV（允许落在画面外，故不钳到 0~1）
uniform float uGodRayIntensity;   // 光柱总强度
uniform float uGodRayCount;       // 光束数量（着色器内取整，保证接缝连续）
uniform float uGodRayLength;      // 延展距离（径向衰减）
uniform float uGodRayUp;          // 抬头程度 0~1：越抬头光柱越强

in vec2 v_textureCoordinates;

void main(void)
{
  vec2 uv = v_textureCoordinates;
  vec3 src = texture(colorTexture, uv).rgb;

  if (uAmount <= 0.001) {
    out_FragColor = vec4(src, 1.0);
    return;
  }

  // 1) 折射扰动：水体晃动带来的整体抖动
  vec2 wob = vec2(sin(uv.y * 27.0 + uTime * 1.9),
                  cos(uv.x * 23.0 - uTime * 1.4)) * uDistortion;
  vec3 col = texture(colorTexture, clamp(uv + wob, vec2(0.0), vec2(1.0))).rgb;

  // 2) 太阳光柱（god rays / 上帝光）—— 水下"太阳透光"的主体
  //    光柱是沿【折射后的太阳方向】下行的平行光束。平行光束在屏幕上会汇聚到它们的
  //    消失点 —— 恰好就是太阳的屏幕位置。所以用"以 uSunScreen 为心的角向条纹"画光束：
  //    atan 求方位角 -> 整数倍正弦条纹（整数倍保证跨越 ±π 接缝连续）-> pow 收束成
  //    一根根分离的光柱，再乘径向衰减（离太阳越远越弱）。
  //    相位里叠两个低频摆动 + 一层缓慢翻滚的空间噪声，光束会跟着水面晃，
  //    有"透进晃动水层"的体积感，而不是一把死掉的扇子。
  //    （对比第一版径向累加采样：光源一大就把半屏糊成奶雾，光束永远立不起来。）
  if (uGodRayIntensity > 0.001 && uGodRayUp > 0.001) {
    vec2  d   = uv - uSunScreen;
    float ang = atan(d.y, d.x);
    float cnt = floor(uGodRayCount + 0.5);                 // 取整：保证接缝连续
    float wob = 2.2 * sin(ang * 4.0 - uTime * 0.23)
              + 1.4 * sin(ang * 9.0 + uTime * 0.31);
    float beams = 0.5 + 0.5 * sin(ang * cnt + uTime * 0.18 + wob);
    beams = pow(max(beams, 0.0), 1.8);                     // 低次幂：束更宽更柔（高了像镭射）
    // 每根束的亮度不同（整数倍谐波 -> 接缝仍连续）：等距等亮会像百叶窗
    beams *= 0.55 + 0.45 * sin(ang * cnt * 3.0 + 1.7);
    // 径向衰减必须"缓"：太阳方位与视线夹角大时，汇聚点会跑到画面外甚至侧面，
    // 衰减陡了整片光束就没了（实测 2.2 时太阳方位偏 50°，光柱几乎不可见）。
    float radial = exp(-length(d) * uGodRayLength);
    // 越靠画面上沿越亮：水下抬头时上沿更贴近水面，光束在那里最强（像挂在水面下）
    float surfBias = mix(1.15, 0.55, smoothstep(0.0, 1.0, 1.0 - uv.y));
    float churn  = 0.75 + 0.25 * sin((uv.x + uv.y) * 9.0 + uTime * 0.6)
                             * sin((uv.x - uv.y) * 7.0 - uTime * 0.4);
    vec3 beamCol = vec3(0.72, 0.90, 1.0);                  // 水下光束色（偏青但别太饱和）
    col += beamCol * beams * radial * surfBias * churn * uGodRayIntensity * uGodRayUp;
    // 太阳周围的柔光晕（bloom 感）
    col += vec3(0.80, 0.95, 1.0) * exp(-length(d) * 3.5) * 0.30 * uGodRayIntensity * uGodRayUp;
  }

  // 3) 水下色彩分级：红光被水吸收最快 -> 压红、留蓝绿，再整体压向水色
  col = vec3(col.r * 0.60, col.g * 1.00, col.b * 1.12);
  col = mix(col, uShallowColor, 0.14);

  // 4) 暗角：水下视野收窄的暗示
  vec2 q = uv - 0.5;
  col *= 1.0 - uVignette * dot(q, q) * 2.4;

  out_FragColor = vec4(mix(src, col, uAmount), 1.0);
}
`;

  /** '#rrggbb' -> sRGB 空间的 0~1（注意：后处理在显示空间工作，不要转线性） */
  function hexToRgb01(hex) {
    const v = parseInt(String(hex).replace('#', ''), 16) || 0;
    return new Cesium.Cartesian3(
      ((v >> 16) & 255) / 255.0,
      ((v >> 8) & 255) / 255.0,
      (v & 255) / 255.0
    );
  }

  /**
   * 创建水下效果（场景级后处理 + 背景/雾切换）。
   * @param {Cesium.Viewer} viewer
   * @param {Object} [options]
   * @param {Object} [options.water]   createWater 的返回值；传入后过渡量会同步到
   *                                   水面的 uUnderwater（切换成"从下方看水面"的模型）
   * @param {Object} [options.uniforms] 覆盖默认参数（uShallowColor/uVignette/uDistortion）
   * @param {Number} [options.fadeSeconds=0] 入水/出水的过渡时长。**默认 0 = 硬切**：
   *                                   入水是"穿过界面"的瞬时事件，做渐变会被感知为
   *                                   "水面切换慢半拍"（实测用户反馈就是延迟）；要柔和
   *                                   过渡再显式传 0.3~0.6
   */
  function createUnderwater(viewer, options) {
    options = options || {};
    const scene = viewer.scene;
    const water = options.water || null;
    const fadeSeconds = (options.fadeSeconds === undefined) ? 0 : options.fadeSeconds;

    const state = Object.assign({
      uShallowColor: '#2f7f96',   // 水下画面基调（后处理分级用）
      uDeepColor:    '#0d3b4d',   // 背景/雾色（scene.fog 与远处水体收敛到这个颜色）
      uFogDensity:   0.006,       // scene.fog 的水下密度（把地表/天空压进水色）
      uVignette:     0.40,
      uDistortion:   0.0016,
      // ---- 太阳光柱（god rays）----
      uGodRayIntensity: 1.20,     // 光柱总强度
      uGodRayCount:     14.0,     // 光束数量（着色器内自动取整）
      uGodRayLength:    0.80,     // 径向衰减（给大了光柱只聚在太阳附近，太阳偏出画面就全没）
    }, options.uniforms || {});

    const clockNow = function () {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    };
    const originMs = clockNow();

    // 记住水上时的场景设置，出水时要还原。
    // 注意逐项判空：不同 Cesium 版本的 Scene 上这些属性不保证都在。
    const saved = { hasFogColor: false, skyAtmosphere: false, skyBox: false, baseColor: null, hasBaseColor: false };
    try {
      if (scene.fog && scene.fog.color && typeof scene.fog.color.clone === 'function') {
        saved.hasFogColor = true;
        saved.fogColor = scene.fog.color.clone();
        saved.fogDensity = scene.fog.density;
      }
    } catch (e) {}
    saved.skyAtmosphere = scene.skyAtmosphere ? scene.skyAtmosphere.show : false;
    saved.skyBox = scene.skyBox ? scene.skyBox.show : false;
    try {
      if (scene.globe && scene.globe.baseColor && typeof scene.globe.baseColor.clone === 'function') {
        saved.hasBaseColor = true;
        saved.baseColor = scene.globe.baseColor.clone();
      }
    } catch (e) {}
    // 影像层透明度：水下把底图渐隐掉，让 globe 退化成"深水色的实心球"（相当于看不见海床）
    const layers = scene.imageryLayers;
    const savedAlphas = [];
    for (let i = 0; i < layers.length; i++) savedAlphas.push(layers.get(i).alpha);
    const deepColor = Cesium.Color.fromCssColorString(state.uDeepColor);

    const stage = new Cesium.PostProcessStage({
      name: 'ue5water_underwater',
      fragmentShader: UNDERWATER_FRAGMENT_SHADER,
      uniforms: {
        uAmount:       0.0,
        uShallowColor: hexToRgb01(state.uShallowColor),
        uVignette:     state.uVignette,
        uDistortion:   state.uDistortion,
        uTime:         function () { return (clockNow() - originMs) / 1000.0; },
        // 太阳光柱：uSunScreen / uGodRayUp 每帧由 preUpdate 写入
        uSunScreen:       new Cesium.Cartesian2(0.5, 1.3),
        uGodRayIntensity: state.uGodRayIntensity,
        uGodRayCount:     state.uGodRayCount,
        uGodRayLength:    state.uGodRayLength,
        uGodRayUp:        1.0,
      },
    });
    scene.postProcessStages.add(stage);
    stage.enabled = false;      // 水上时完全不参与渲染（零开销）

    // ---- 太阳的屏幕位置：光柱的径向原点 ----
    // 【折射修正】水下看到的光柱是折射后的下行光束，其屏幕汇聚点是"水中的太阳视位置"，
    // 不是天上真太阳的位置。斯涅尔：sin(θ水) = sin(θ空气)/1.333，方位角不变。
    // 低角度太阳时两者差得极远：11° 仰角的真太阳，水中视位置在 42.6°（几乎抬头正前方）。
    // 用真太阳投影会把光柱原点放到画面外甚至相机背后（实测 y=-0.57，光束全歪）。
    // 取不到行星历表 / 太阳在画面后方时，退化为"画面正上方之外"的虚拟原点：光柱仍
    // 自上而下斜射，只是不跟随真实太阳 —— 保证效果不会整块消失。
    const sunScreen  = new Cesium.Cartesian2(0.5, 1.3);
    const scratchSun = new Cesium.Cartesian3();
    const scratchUp  = new Cesium.Cartesian3();
    const scratchHor = new Cesium.Cartesian3();
    const scratchDir = new Cesium.Cartesian3();

    function updateSunScreen() {
      let ux = 0.5, uy = 1.3, ok = false;
      const PP = Cesium.Simon1994PlanetaryPositions;
      if (PP && PP.computeSunPositionInEarthInertialFrame && Cesium.Transforms &&
          Cesium.Transforms.computeIcrfToFixedMatrix) {
        try {
          const time = viewer.clock.currentTime;
          const posI = PP.computeSunPositionInEarthInertialFrame(time, scratchSun);
          const icrf2fixed = Cesium.Transforms.computeIcrfToFixedMatrix(time);
          if (Cesium.defined(icrf2fixed)) {
            Cesium.Matrix3.multiplyByVector(icrf2fixed, posI, posI);
            Cesium.Cartesian3.normalize(posI, posI);          // 真太阳方向（ECEF）
            const up   = Cesium.Cartesian3.normalize(scene.camera.positionWC, scratchUp);
            const vDot = Cesium.Cartesian3.dot(posI, up);     // cos(θ空气)
            Cesium.Cartesian3.multiplyByScalar(up, vDot, scratchHor);
            const hor = Cesium.Cartesian3.subtract(posI, scratchHor, scratchHor);  // 水平分量
            const sinAir = Cesium.Cartesian3.magnitude(hor);
            if (sinAir > 1e-6) {
              Cesium.Cartesian3.divideByScalar(hor, sinAir, hor);
              const sinWat = Math.min(0.999, sinAir / 1.333); // 斯涅尔：水→空气临界 1/1.333
              const cosWat = Math.sqrt(1.0 - sinWat * sinWat);
              Cesium.Cartesian3.multiplyByScalar(up, cosWat, posI);                  // 折射后方向
              Cesium.Cartesian3.multiplyByScalar(hor, sinWat, scratchDir);
              Cesium.Cartesian3.add(posI, scratchDir, posI);
            }
            Cesium.Cartesian3.multiplyByScalar(posI, 1.0e6, posI);
            Cesium.Cartesian3.add(scene.camera.positionWC, posI, posI);
            const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, posI);
            if (Cesium.defined(win)) {
              const w = scene.canvas.clientWidth || scene.drawingBufferWidth;
              const h = scene.canvas.clientHeight || scene.drawingBufferHeight;
              if (w > 0 && h > 0) { ux = win.x / w; uy = 1.0 - win.y / h; ok = true; }
            }
          }
        } catch (e) { ok = false; }
      }
      if (!ok) { ux = 0.5; uy = 1.3; }
      // 钳到"扩展画面框"内：允许原点在画面外一段（光束从画面边缘斜射进来），
      // 但不能跑太远 —— 径向衰减会把整片光束压没（实测太阳方位偏 50° 时就是这样）。
      sunScreen.x = Cesium.Math.clamp(ux, -0.6, 1.6);
      sunScreen.y = Cesium.Math.clamp(uy, -0.6, 1.6);
    }

    let amount = 0;             // 当前过渡量
    let target = 0;             // 目标（0/1）
    let written = -1;           // 上次写到 uniform 的值
    let lastMs = originMs;

    const removeTick = scene.preUpdate.addEventListener(function () {
      const now = clockNow();
      const dt = Math.min((now - lastMs) / 1000.0, 0.1);   // 卡顿时钳一下，避免跳变
      lastMs = now;

      const step = fadeSeconds > 0 ? dt / fadeSeconds : 1;
      if (amount < target) amount = Math.min(target, amount + step);
      else if (amount > target) amount = Math.max(target, amount - step);

      if (Math.abs(amount - written) > 0.002) {
        written = amount;
        stage.uniforms.uAmount = amount;
        // 关键：把过渡量同步给水面材质 —— 水面要从"水上"平滑切成"水下看天花板"
        if (water && water.setUniform) water.setUniform('uUnderwater', amount);

        // 背景：把地表与天空压进水色。
        //  - globe.baseColor：把"没有影像的地方"直接变成水色（最可靠，所有版本都有）
        //  - scene.fog.color：若该版本支持则一并调，把远处地表也压进水色
        //  - 【天空不再隐藏】深水下抬头视线几乎全被水面面片挡住，真实天空本来就不可见；
        //    而在波谷/面片边缘这些"漏出天空"的角度，藏天空只会得到一整块黑（实测截图），
        //    露出蓝天反而是自然的水天线。所以 skyAtmosphere/skyBox 保持原样。
        if (saved.hasBaseColor && scene.globe.baseColor) {
          scene.globe.baseColor = Cesium.Color.lerp(saved.baseColor, deepColor, amount, scene.globe.baseColor);
        }
        for (let i = 0; i < scene.imageryLayers.length && i < savedAlphas.length; i++) {
          scene.imageryLayers.get(i).alpha = savedAlphas[i] * (1.0 - amount);
        }
        if (saved.hasFogColor) {
          scene.fog.color = Cesium.Color.lerp(saved.fogColor, deepColor, amount, scene.fog.color);
          scene.fog.density = Cesium.Math.lerp(saved.fogDensity, state.uFogDensity, amount);
        }
      }

      // 每帧刷新太阳屏幕位置与"抬头程度"（相机在动，这两个量必须逐帧更新，不能只在过渡时算）
      if (stage.enabled || amount > 0.001) {
        updateSunScreen();
        stage.uniforms.uSunScreen = sunScreen;
        const cam = scene.camera;
        const up  = Cesium.Cartesian3.normalize(cam.positionWC, scratchUp);
        const lookUp = Cesium.Cartesian3.dot(cam.directionWC, up);      // = sin(俯仰角)
        stage.uniforms.uGodRayUp = Cesium.Math.clamp(lookUp * 1.8 + 0.15, 0.0, 1.0);
      }

      const need = amount > 0.001 || target > 0.5;
      if (stage.enabled !== need) stage.enabled = need;
    });

    return {
      stage: stage,
      state: state,

      /** 入水 / 出水（平滑过渡，fadeSeconds 秒） */
      setUnderwater: function (on) {
        target = on ? 1 : 0;
        if (target > 0) stage.enabled = true;
        return target > 0.5;
      },
      isUnderwater: function () { return target > 0.5; },
      getAmount: function () { return amount; },

      /** 调试：当前太阳的屏幕 UV（光柱径向原点；y>1 表示在画面上沿之外） */
      getSunScreen: function () { return { x: sunScreen.x, y: sunScreen.y }; },

      setUniform: function (key, value) {
        state[key] = value;
        if (stage.uniforms[key] === undefined) return;
        stage.uniforms[key] = isColorKey(key) ? hexToRgb01(value) : value;
      },

      destroy: function () {
        if (removeTick) removeTick();
        // 还原被改掉的场景设置，避免留下"半水下"状态
        if (saved.hasFogColor) {
          scene.fog.color = saved.fogColor;
          scene.fog.density = saved.fogDensity;
        }
        if (saved.hasBaseColor && scene.globe.baseColor) scene.globe.baseColor = saved.baseColor;
        for (let i = 0; i < scene.imageryLayers.length && i < savedAlphas.length; i++) {
          scene.imageryLayers.get(i).alpha = savedAlphas[i];
        }
        if (scene.skyAtmosphere) scene.skyAtmosphere.show = saved.skyAtmosphere;
        if (scene.skyBox) scene.skyBox.show = saved.skyBox;
        scene.postProcessStages.remove(stage);
      },
    };
  }

  function isColorKey(key) {
    return /Color$/.test(key) || key === 'uHorizonHaze';
  }

  function toUniformValue(key, raw) {
    // vec3 参数可以写成数组（吸收系数这类"物理量"不该用取色器调，用数组更直白）
    if (Array.isArray(raw)) return new Cesium.Cartesian3(raw[0], raw[1], raw[2]);
    if (isColorKey(key) && typeof raw === 'string') return hexToLinear(raw);
    return Number(raw);
  }

  // ==========================================================================
  // 创建水面：把所有步骤封装到一个调用里
  //   options.onStep(name) 可选：用于把内部各阶段上报给调用方（诊断用）
  // ==========================================================================
  async function createWater(viewer, options) {
    options = options || {};
    const planeSize = options.planeSize || 8000;
    const segments = options.segments || 400;
    const normalTexSize = options.normalTexSize || 256;
    const site = options.site || { lon: 120.0, lat: 30.0, height: 12.0 };
    const preset = options.preset || 'ocean';
    const report = (typeof options.onStep === 'function') ? options.onStep : function () {};

    // uTimeScale 不放进 PRESETS：它是"播放器"级别的控制，切换预置不该把它重置回 1.0
    const state = Object.assign({ uTimeScale: 1.0 }, PRESETS[preset], options.uniforms || {});

    report('生成四层法线贴图（可平铺 FBM + mipmap）');
    const normal0 = makeWaterNormalUniform(normalTexSize, NORMAL_LAYERS[0]);
    const normal1 = makeWaterNormalUniform(normalTexSize, NORMAL_LAYERS[1]);
    const normal2 = makeWaterNormalUniform(normalTexSize, NORMAL_LAYERS[2]);
    const normal3 = makeWaterNormalUniform(normalTexSize, NORMAL_LAYERS[3]);

    report('构建 CustomShader');
    const customShader = new Cesium.CustomShader({
      lightingModel: Cesium.LightingModel.UNLIT,   // 光照全部自算，走 UNLIT 最省
      varyings: {
        v_nTbn:  Cesium.VaryingType.VEC3,          // 波面法线（TBN 坐标系）
        v_crest: Cesium.VaryingType.FLOAT,         // 归一化波峰高度（泡沫用）
      },
      uniforms: {
        // ---- 动画时间（由 createWater 每帧写入）----
        //  uTime      : 秒。默认来自墙钟（performance.now），因此不受帧率影响。
        //  uTimeScale : 全局速度倍率。0 = 完全静止（出静帧/截图），2 = 两倍速。
        //              它同时缩放【顶点 Gerstner 相位】和【四层法线贴图的滚动】，
        //              所以是"整体快慢"的总控；分层比例仍由 uWaveSpeed* 决定。
        uTime:      { type: Cesium.UniformType.FLOAT, value: 0.0 },
        uTimeScale: { type: Cesium.UniformType.FLOAT, value: state.uTimeScale },

        // ---- 对标 UE5 SingleLayerWater 的核心参数 ----
        uAbsorptionCoeff:   { type: Cesium.UniformType.VEC3,  value: new Cesium.Cartesian3(
                                state.uAbsorptionCoeff[0], state.uAbsorptionCoeff[1], state.uAbsorptionCoeff[2]) },
        uAbsorptionStrength:{ type: Cesium.UniformType.FLOAT, value: state.uAbsorptionStrength },
        uAbsorptionColor:   { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uAbsorptionColor) },
        uScatteringColor:   { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uScatteringColor) },
        uFresnelPower:      { type: Cesium.UniformType.FLOAT, value: state.uFresnelPower },
        uWaveSpeedLow:      { type: Cesium.UniformType.FLOAT, value: state.uWaveSpeedLow },
        uWaveSpeedMid:      { type: Cesium.UniformType.FLOAT, value: state.uWaveSpeedMid },
        uWaveSpeedHigh:     { type: Cesium.UniformType.FLOAT, value: state.uWaveSpeedHigh },
        uSpecularIntensity: { type: Cesium.UniformType.FLOAT, value: state.uSpecularIntensity },
        uFoamThreshold:     { type: Cesium.UniformType.FLOAT, value: state.uFoamThreshold },
        uFoamColor:         { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uFoamColor) },

        // ---- 四层法线贴图 ----
        uNormalMap0: { type: Cesium.UniformType.SAMPLER_2D, value: normal0 },
        uNormalMap1: { type: Cesium.UniformType.SAMPLER_2D, value: normal1 },
        uNormalMap2: { type: Cesium.UniformType.SAMPLER_2D, value: normal2 },
        uNormalMap3: { type: Cesium.UniformType.SAMPLER_2D, value: normal3 },

        // ---- 法线细纹控制 ----
        uNormalStrength:    { type: Cesium.UniformType.FLOAT, value: state.uNormalStrength },
        uTilingLow:         { type: Cesium.UniformType.FLOAT, value: state.uTilingLow },
        uTilingMid:         { type: Cesium.UniformType.FLOAT, value: state.uTilingMid },
        uTilingHigh:        { type: Cesium.UniformType.FLOAT, value: state.uTilingHigh },
        uStrengthLow:       { type: Cesium.UniformType.FLOAT, value: state.uStrengthLow },
        uStrengthMid:       { type: Cesium.UniformType.FLOAT, value: state.uStrengthMid },
        uStrengthHigh:      { type: Cesium.UniformType.FLOAT, value: state.uStrengthHigh },
        uTilingSwell:       { type: Cesium.UniformType.FLOAT, value: state.uTilingSwell },
        uStrengthSwellNear: { type: Cesium.UniformType.FLOAT, value: state.uStrengthSwellNear },
        uStrengthSwellFar:  { type: Cesium.UniformType.FLOAT, value: state.uStrengthSwellFar },
        uWaveSpeedSwell:    { type: Cesium.UniformType.FLOAT, value: state.uWaveSpeedSwell },
        uDomainWarp:        { type: Cesium.UniformType.FLOAT, value: state.uDomainWarp },
        uFadeNear:          { type: Cesium.UniformType.FLOAT, value: state.uFadeNear },
        uFadeFar:           { type: Cesium.UniformType.FLOAT, value: state.uFadeFar },

        // ---- Gerstner ----
        uGerstnerHeight:     { type: Cesium.UniformType.FLOAT, value: state.uGerstnerHeight },
        uGerstnerWavelength: { type: Cesium.UniformType.FLOAT, value: state.uGerstnerWavelength },
        uGerstnerSteepness:  { type: Cesium.UniformType.FLOAT, value: state.uGerstnerSteepness },
        uGerstnerSpeed:      { type: Cesium.UniformType.FLOAT, value: state.uGerstnerSpeed },

        // ---- 高光 / 泡沫 / 通透度 ----
        uSpecularPower:     { type: Cesium.UniformType.FLOAT, value: state.uSpecularPower },
        uSpecularPowerFar:  { type: Cesium.UniformType.FLOAT, value: state.uSpecularPowerFar },
        uSpecularAniso:     { type: Cesium.UniformType.FLOAT, value: state.uSpecularAniso },
        uFoamSharpness:     { type: Cesium.UniformType.FLOAT, value: state.uFoamSharpness },
        uAlpha:             { type: Cesium.UniformType.FLOAT, value: state.uAlpha },
        uEdgeFade:          { type: Cesium.UniformType.FLOAT, value: state.uEdgeFade || 0.0 },
        uUnderwater:        { type: Cesium.UniformType.FLOAT, value: state.uUnderwater || 0.0 },
        uUnderFogDensity:   { type: Cesium.UniformType.FLOAT, value: state.uUnderFogDensity || 0.0 },
        uUnderMaxFog:       { type: Cesium.UniformType.FLOAT, value: state.uUnderMaxFog || 1.0 },
        uUnderDeepColor:    { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uUnderDeepColor) },
        uHazeDensity:       { type: Cesium.UniformType.FLOAT, value: (state.uHazeDensity === undefined) ? 0.0 : state.uHazeDensity },
        uDepthScale:        { type: Cesium.UniformType.FLOAT, value: state.uDepthScale },
        uCrestTranslucency: { type: Cesium.UniformType.FLOAT, value: state.uCrestTranslucency },

        // ---- 解析天空 ----
        uSkyColor:            { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uSkyColor) },
        uHorizonColor:        { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uHorizonColor) },
        uHorizonHaze:         { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uHorizonHaze) },
        uHorizonHazeStrength: { type: Cesium.UniformType.FLOAT, value: state.uHorizonHazeStrength },
        uSkyGradientPow:      { type: Cesium.UniformType.FLOAT, value: state.uSkyGradientPow },
        uSkyForwardScatter:   { type: Cesium.UniformType.FLOAT, value: state.uSkyForwardScatter },
        uBelowHorizonDark:    { type: Cesium.UniformType.FLOAT, value: state.uBelowHorizonDark },
        uSunColor:            { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uSunColor) },
        uSunDiscCos:          { type: Cesium.UniformType.FLOAT, value: state.uSunDiscCos },
        uSunDiscIntensity:    { type: Cesium.UniformType.FLOAT, value: state.uSunDiscIntensity },
        uSunGlowIntensity:    { type: Cesium.UniformType.FLOAT, value: state.uSunGlowIntensity },
        uSunGlowPow:          { type: Cesium.UniformType.FLOAT, value: state.uSunGlowPow },
      },
      vertexShaderText: VERTEX_SHADER,
      fragmentShaderText: FRAGMENT_SHADER,
    });

    // 运行时生成 glb；Cesium 用文件幻数 "glTF" 识别 GLB，blob URL（无 .glb 后缀）同样可用
    report('生成 glTF 面片');
    const glb = buildPlaneGlb(segments, planeSize);
    const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));

    const center = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, site.height);
    report('加载 Model（glTF 解析 / GPU 上传）');
    const model = await Cesium.Model.fromGltfAsync({
      url: url,
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(center),
      customShader: customShader,
      allowPicking: false,
      show: true,
    });
    report('加入场景');
    viewer.scene.primitives.add(model);

    // ---- 每帧推进 uTime（秒）----
    // timeSource: 'wall'（默认）用墙钟 → 速度与帧率无关，换台机器也是同一个速度；
    //             'frame' 退回旧的 czm_frameNumber/60 行为（按 60fps 折算），
    //                     只有在需要与 Cesium 内部帧序列严格同步时才用。
    const timeSource = options.timeSource || 'wall';
    const clockNow = function () {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    };
    const originMs = clockNow();
    const originFrame = (viewer.scene.frameState && viewer.scene.frameState.frameNumber) || 0;
    let lastSeconds = 0;

    const removeTick = viewer.scene.preUpdate.addEventListener(function () {
      let seconds;
      if (timeSource === 'frame') {
        const f = (viewer.scene.frameState && viewer.scene.frameState.frameNumber) || originFrame;
        seconds = (f - originFrame) / 60.0;
      } else {
        seconds = (clockNow() - originMs) / 1000.0;
      }
      if (seconds === lastSeconds) return;      // 同一帧内不重复写 uniform
      lastSeconds = seconds;
      customShader.setUniform('uTime', seconds);
    });

    // 注意：这里不再 report('完成') —— 约定是「最后一次上报之后由调用方收尾」，
    // 否则诊断面板上会永远挂着一个 pending 的"水面：完成"。

    return {
      model: model,
      customShader: customShader,
      presets: PRESETS,
      state: state,
      center: center,
      site: site,                    // { lon, lat, height }：水面高度即 site.height
      surfaceHeight: site.height,
      url: url,
      segmentCount: segments,
      planeSize: planeSize,

      /** 更新单个 uniform（颜色传 '#rrggbb'，数值传 number） */
      setUniform: function (key, value) {
        state[key] = value;
        customShader.setUniform(key, toUniformValue(key, value));
      },

      /** 应用整套预置参数 */
      applyPreset: function (name) {
        Object.assign(state, PRESETS[name]);
        Object.keys(PRESETS[name]).forEach(function (k) {
          customShader.setUniform(k, toUniformValue(k, state[k]));
        });
        return state;
      },

      /** 暂停 / 继续 / 设倍率：0 = 静止（适合截图对比），1 = 正常，2 = 两倍速 */
      setTimeScale: function (s) {
        state.uTimeScale = Number(s);
        customShader.setUniform('uTimeScale', state.uTimeScale);
        return state.uTimeScale;
      },
      pause: function () { return this.setTimeScale(0); },
      resume: function () { return this.setTimeScale(1); },

      /** 拆除：停掉每帧回调、移除模型、释放 blob URL */
      destroy: function () {
        if (removeTick) removeTick();
        viewer.scene.primitives.remove(model);
        URL.revokeObjectURL(url);
      },
    };
  }

  global.Ue5Water = {
    VERTEX_SHADER: VERTEX_SHADER,
    FRAGMENT_SHADER: FRAGMENT_SHADER,
    PRESETS: PRESETS,
    NORMAL_LAYERS: NORMAL_LAYERS,
    buildPlaneGlb: buildPlaneGlb,
    makeTileableHeightField: makeTileableHeightField,
    heightFieldToNormalData: heightFieldToNormalData,
    makeWaterNormalUniform: makeWaterNormalUniform,
    hexToLinear: hexToLinear,
    createWater: createWater,
    createUnderwater: createUnderwater,
  };
})(typeof window !== 'undefined' ? window : globalThis);
