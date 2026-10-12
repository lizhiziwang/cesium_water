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
  // Frostbite 大气 —— 共享 GLSL 块（天穹与水面共用同一份代码）
  //   Sébastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere
  //   Rendering Technique"（EGSR 2020，即 Frostbite 大气）：
  //     · Transmittance LUT   —— 预计算「某高度 + 某天顶角 → 大气顶」的透过率
  //     · Multi-scattering LUT —— 预计算多次散射（无限次散射用几何级数近似）
  //     · 天空射线步进         —— 单次散射 + 多次散射 + 太阳盘
  //     · 气透视               —— 相机→片元 这段光程的透过率与入散射
  //
  //   【为什么全部在眼空间里算】
  //   CustomShader 片元端能直接拿到的空间量只有 positionEC，以及 czm_* 内置量；
  //   所以这里只额外传一个 uniform：uAtmoCenterEC =「地心在眼空间的位置」
  //   （每帧 = viewMatrix × (0,0,0)，即视图矩阵的平移列）。有了它就能推出：
  //     相机半径 r = |uAtmoCenterEC|、相机处"上" up0 = -normalize(uAtmoCenterEC)、
  //     采样点半径 ri = |p0 + t·rd|、太阳在该点的天顶角 cos = dot(up_i, sunDir)。
  //   于是天穹的片元和水的片元可以共用同一段大气代码，参数、LUT 也完全一致。
  //
  //   【两个 LUT 的参数化必须与 JS 生成端严格一致】（见 buildTransmittanceLUT）
  //     v 轴：v = (r² − Rb²)/(Rt² − Rb²)     —— 近地面分配更多行（密度变化快）
  //     u 轴：u = sqrt((mu − muH(r))/(1 − muH(r)))，muH = 地平线天顶角余弦
  //           —— 采样点密度偏向地平线（掠射时透过率变化最快的地方）
  // ==========================================================================
  const ATMOSPHERE_GLSL = `
// ============================ Frostbite 大气（共享） ============================
// 【uniform 声明不在这里】Cesium 的 CustomShader 会按 uniformMap 自动生成
// uniform 声明并注入着色器头部 —— 这里再写一遍就是 redefinition（实测编译失败）。
// 各 uniform 的含义见 atmoUniformSet() 的字段注释。
//
//   uAtmoTransLUT / uAtmoMultiLUT  两张 LUT（HALF_FLOAT，线性过滤）
//   uAtmoCenterEC                  地心在【眼空间】的位置（每帧写入，唯一的逐帧 uniform）
//   uAtmoRayleigh / uAtmoRayleighH 瑞利散射系数 (1/m) 与标高 (m)
//   uAtmoMieScatter/MieAbsorb/MieH/MieG  米氏散射/吸收系数、标高、相函数 g
//   uAtmoOzone / OzoneCenter / OzoneWidth  臭氧吸收 (1/m) 与帐篷分布参数 (m)
//   uAtmoBottomR / uAtmoTopR       地面 / 大气顶半径 (m)
//   uAtmoH0 / uAtmoHScale          高度映射 h = h0·(e^(v·K)−1) 的两个常数
//   uAtmoMultiScale / uAtmoSunIrradiance / uAtmoExposure   亮度三总控
//   uAtmoSunDiscCos / uAtmoSunDiscScale    太阳盘（cos 角半径 / 强度）
//   uAtmoSkySteps / uAtmoAPSteps   天空 / 气透视步进数
//   uAtmoEnabled                   0 = 水面退回解析天空（A/B 用）
//
// 以下两个【不是大气参数，而是水面侧的合成控制】（只在本文件的片元着色器里用，
// 天穹不读；默认值见 PRESETS 的 uAtmoApScale / uAtmoReflGain）：
//   uAtmoApScale    气透视强度 0..1（1 = 标准 color·T+S，0 = 关闭）
//   uAtmoReflGain   物理天空反射强度（1 = 完全按物理；<1 压暗，见 §5 注释）
//   uAtmoReflTint   地平线附近反射的色相校正（向 uHorizonColor 靠，见 §5 注释）

const float ATMO_PI = 3.141592653589793;
const int   ATMO_SKY_MAX = 64;        // 循环上限必须是常量（GLSL ES 约束）
const int   ATMO_AP_MAX  = 16;

float atmoDensR(float h) { return exp(-h / max(uAtmoRayleighH, 1.0)); }
float atmoDensM(float h) { return exp(-h / max(uAtmoMieH, 1.0)); }
// 臭氧：以 25 km 为中心的帐篷（tent）分布，Hillaire 的写法
float atmoDensO(float h) { return max(0.0, 1.0 - abs(h - uAtmoOzoneCenter) / max(uAtmoOzoneWidth, 1.0)); }

float atmoMuHorizon(float r) {
  float k = min(1.0, uAtmoBottomR / max(r, 1.0));
  return -sqrt(max(0.0, 1.0 - k * k));
}
// 高度 → v：指数映射（近地面分辨率高），与 JS 的 atmoVFromH 逐字对应
float atmoVFromH(float h) { return log(1.0 + max(h, 0.0) / uAtmoH0) / uAtmoHScale; }
// (r, mu) → LUT 的 uv（与 JS 生成端逐字对应，改一边必须改另一边）
vec2 atmoUv(float r, float mu) {
  float v = clamp(atmoVFromH(r - uAtmoBottomR), 0.0, 1.0);
  float mh = atmoMuHorizon(r);
  // 地平线以下直接钳到地平线 —— 天空积分用不到它，气透视的「除法技巧」也要求如此
  float u = sqrt(clamp((mu - mh) / max(1.0 - mh, 1e-6), 0.0, 1.0));
  return vec2(u, v);
}
vec3 atmoTransmittance(float r, float mu) {
  return texture(uAtmoTransLUT, atmoUv(r, mu)).rgb;
}
// 多次散射 LUT 的 u 轴是线性的 mu ∈ [-1,1]（它的量随天顶角变化平缓）
vec3 atmoMultiScatter(float r, float mu) {
  float v = clamp(atmoVFromH(r - uAtmoBottomR), 0.0, 1.0);
  return texture(uAtmoMultiLUT, vec2(clamp(mu * 0.5 + 0.5, 0.0, 1.0), v)).rgb;
}

// 射线与地面球的最近正向交点，无交返回 -1
float atmoGroundT(float r, float mu) {
  float b = r * mu;
  float c = r * r - uAtmoBottomR * uAtmoBottomR;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  float sq = sqrt(d);
  float t0 = -b - sq;
  if (t0 > 0.0) return t0;
  float t1 = -b + sq;
  return t1 > 0.0 ? t1 : -1.0;
}
// 射线离开大气顶的正向交点（相机在大气层内，故取远根）
float atmoTopT(float r, float mu) {
  float b = r * mu;
  float c = r * r - uAtmoTopR * uAtmoTopR;
  return -b + sqrt(max(b * b - c, 0.0));
}
// 太阳被行星本身遮挡的软判据（决定昼夜分界与晨昏线，比"相机处太阳高度"正确：
// 高空样点即使地面已日落仍能看到太阳，这正是暮光发亮的来源）
float atmoSunOcclusion(float r, float muSun) {
  float mh = atmoMuHorizon(r);
  return smoothstep(mh - 0.015, mh + 0.015, muSun);
}

float atmoPhaseR(float c) { return 0.05968310365946075 * (1.0 + c * c); }  // 3/(16π)
float atmoPhaseM(float c) {                                              // Henyey-Greenstein
  float g = uAtmoMieG;
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * ATMO_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// 单个步长的散射源项（不含累积透过率）
vec3 atmoScatterSource(float h, float cosSun, float ri, float muSun) {
  float dR = atmoDensR(h);
  float dM = atmoDensM(h);
  vec3  Tsun = atmoTransmittance(ri, muSun) * atmoSunOcclusion(ri, muSun);
  vec3  multi = atmoMultiScatter(ri, muSun) * uAtmoMultiScale;
  vec3  scat = dR * uAtmoRayleigh * atmoPhaseR(cosSun)
             + dM * uAtmoMieScatter * atmoPhaseM(cosSun);
  // 多次散射：各向同性，用 (瑞利+米氏) 的散射系数加权 —— Hillaire 的写法
  vec3  iso = (dR * uAtmoRayleigh + dM * uAtmoMieScatter) * multi;
  return (scat * Tsun + iso) * uAtmoSunIrradiance;
}

// ---- 程序化云层（v21：天穹与水面反射共用，水面终于"有东西可反"）----
// 【为什么这是真实感最大的一块】真实海面的观感大半来自反射的天空【内容】：
// 云、云隙亮边、晨昏染色。纯渐变天空反射到掠射水面上就是一片平滑色 —— 水面
// 再怎么调都像"漆出来的"。云放共享 GLSL 里，atmoSkyRadiance 出口统一合成，
// 天穹 / 水面反射 / 水下斯涅尔窗三处自动共享同一朵云，色调严格一致。
// 【世界固定 + 无大数精度】云 UV 用「世界方向投影」：rdW.xz/dot(rdW,upW)，
// 只依赖视线的世界方向 —— 相机平移/旋转云都不跟手，且没有 ECEF 6.4e6 大数的
// float32 精度问题（rdW 是单位向量）。
float atmoHash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float atmoNoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = atmoHash21(i);
  float b = atmoHash21(i + vec2(1.0, 0.0));
  float c = atmoHash21(i + vec2(0.0, 1.0));
  float d = atmoHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float atmoFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    v += amp * atmoNoise2(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    amp *= 0.5;
  }
  return v;
}
// 返回 vec4(cloudRGB, alpha)。rdEC/sunDir 均为眼空间；up0 = 相机处径向"上"（眼空间）
// 【v22 视差】云不再"画在无穷远"，而是 uCloudHeight 米高处的一层：
//   · 射线-云层求交带【起点海拔】（orgW：天穹=相机位置；反射/折射近似同用相机）
//     ⇒ 缩放升降时云场真实地收敛/发散（above = 云高-海拔 乘进投影里）；
//   · uv 以固定地理锚点 uCloudAnchorWC 为原点 ⇒ 平移时云随地理位置滑动（真视差）；
//   · 起点接近云层高度时整体淡出（天穹几何只能画"头顶的云"，脚下的云层不属于天穹）。
vec4 atmoCloudLayer(vec3 rdEC, vec3 up0, vec3 sunDir, float tSec) {
  vec3 rdW  = mat3(czm_inverseView) * rdEC;      // 眼空间 → 世界（ECEF 方向）
  vec3 orgW = czm_inverseView[3].xyz;            // 射线起点（世界系）
  float camAlt = length(orgW) - uAtmoBottomR;    // 起点海拔（地心半径-地面半径）
  float above  = uCloudHeight - camAlt;          // 起点到云层的垂直距离
  if (above < 1.0) return vec4(0.0);             // 已到云层之上：高空不再有"贴脸云"
  // 锚点局部地平坐标系（锚点未设时退化用起点自身径向；锚点在极点时 east 未定义，不适用）
  vec3 upA    = (length(uCloudAnchorWC) > 1.0) ? normalize(uCloudAnchorWC) : normalize(orgW);
  vec3 eastA  = normalize(cross(vec3(0.0, 0.0, 1.0), upA));
  vec3 northA = cross(upA, eastA);
  float ru = dot(rdW, upA);
  if (ru < 0.035) return vec4(0.0);              // 地平线以下 / 贴地平线：交给大气雾
  vec3 dPerp = rdW - upA * ru;                   // 射线的水平分量
  // uv =（起点相对锚点的水平位置 + 沿射线打到云层的水平偏移）/ 云团特征尺寸
  //    水平偏移 = dPerp·above/ru（= above/tan(仰角)）。缩放改变 above、平移改变 rel，
  //    两者都真实响应相机 —— 修掉 v21 "怎么缩放云都纹丝不动"（当时只是常数 3.0 的
  //    纯方向投影，云等效在无穷远，位置/高度完全不影响云场）。
  vec3 rel = orgW - uCloudAnchorWC;
  vec2 uv = vec2(dot(rel, eastA) + dot(dPerp, eastA) * above / ru,
                 dot(rel, northA) + dot(dPerp, northA) * above / ru) / uCloudScale;
  uv += tSec * uCloudSpeed * vec2(0.72, 0.36);   // 随风漂移
  float tDeck = above / ru;                      // 沿射线到云层的斜距（m）：掠射时穿过更厚的云
  // 掠射 LOD：仰角越低 uv 越大，细八度会出高频闪烁 —— 把噪声坐标整体粗化。
  // 这是让云能延伸到地平线附近的关键（不然只能用淡出杀掉半边天，天显得空）。
  vec2 uvL = uv * mix(0.45, 1.0, smoothstep(0.05, 0.30, ru));
  // ---------- 形状场：大尺度团块为主 + 中尺度起伏 ----------
  // 两级尺度叠加 → 云有大小之分（单尺度 FBM = 满屏同尺寸棉花球）。
  // atmoFbm 自身的 5 个八度（最高 17× 频率）正好当云体内部的侵蚀细节，不必再单采。
  // fBig 权重 0.85：云要成"团"；fMid 只做边缘破碎 —— 权重一高云就碎成斑点（实测）。
  vec2 q = uvL + 0.30 * vec2(atmoFbm(uvL * 1.9 + 3.1), atmoFbm(uvL * 1.9 + 7.7));
  float fBig = atmoFbm(q * 1.25);
  float fMid = atmoFbm(q * 3.10 + 11.0);
  float cover = clamp(uCloudCover, 0.0, 1.0);
  float thr = mix(0.86, 0.22, cover);
  float d = (fBig * 0.85 + fMid * 0.15) - thr;
  if (d <= 0.0) return vec4(0.0);
  float dens = clamp(d * 2.6, 0.0, 1.0);         // 核心浓、边缘薄
  // ---------- 光学厚度：不透明度 = 1 - exp(-密度 × 斜距) ----------
  // 【真实感的分界】旧版用 smoothstep 出二值 alpha ⇒ 每朵云都是"实心剪纸"。
  // 真实云是水汽：薄边半透明、核心不透明；近地平线斜距几十 km ⇒ 云连成一片厚云海。
  float od = dens * tDeck / (uCloudScale * 4.5);
  float alpha = 1.0 - exp(-od * mix(2.0, 5.0, clamp(uCloudSharp * 1.4, 0.0, 1.0)));
  if (alpha <= 0.003) return vec4(0.0);
  // ---------- 自阴影：沿太阳方向偏移再取一次中尺度密度 ----------
  // 朝太阳那侧更薄 → 受光；更厚 → 被自身挡住。给出"亮边 + 暗身"的立体感。
  // （只按"离太阳远近"调亮度 = 肥皂泡；云立不立体全看这一步。）
  // sunDir 是眼空间，转到世界系后投到锚点地平坐标系（与 uv 同一坐标系，偏移才有地理意义）。
  vec3 sunW = mat3(czm_inverseView) * sunDir;
  vec2 sunUV = normalize(vec2(dot(sunW, eastA), dot(sunW, northA)) + vec2(1e-4, 0.0));
  float fSun = atmoFbm((q + sunUV * 0.16) * 3.10 + 11.0);
  float dSun = (fBig * 0.85 + fSun * 0.15) - thr;
  // 【v23 关键教训：辐亮度必须与天空同量级，否则全是死白】
  // 云的合成亮度 = col × 0.30 × 曝光40 = 12×col，过 Reinhard 再过 sRGB 伽马：
  //   col 0.15 → 显示 0.82；col 1.15 → 显示 0.97 —— 旧版 [0.42,1.14] 全被压进
  //   0.83~0.93 的"死白带"，怎么调明暗都看不见（改暗端/改阴影强度全无效，实测）。
  // 正确量级：colDark ~0.06（显示 0.75 灰底）、colLit ~0.58（显示 0.94 亮边）。
  float lit  = exp(-max(dSun, 0.0) * 8.0);
  // 云底更暗：仰角越高 = 越是在看云的底面（真实积云的底几乎是平的灰蓝色）
  float baseView = smoothstep(0.10, 0.58, ru);
  vec3 cloudCol = mix(vec3(0.055, 0.070, 0.105), vec3(0.58, 0.56, 0.52), lit);
  cloudCol *= mix(1.0, 0.80, baseView);
  // 银边：薄的云边 + 视线贴近太阳 → 前向散射的亮边（量级随云色一起压小）
  float rim = (1.0 - dens) * pow(max(dot(rdEC, sunDir), 0.0), 6.0);
  cloudCol += vec3(0.10, 0.093, 0.080) * rim;
  // 晨昏染色：太阳低时云被红光化（与物理大气的地平线暖色同一逻辑）
  float sunUp = clamp(dot(up0, sunDir) * 4.0 + 0.22, 0.0, 1.0);
  cloudCol = mix(cloudCol * vec3(1.22, 0.83, 0.62), cloudCol, sunUp);
  // ---------- 空气透视：远处的云失去对比、溶进大气 ----------
  // 没有这一步，远云会和近云一样黑白分明 → 天穹像贴了张高清贴图。
  // 溶进的目标色 ≈ 天空地平线的辐亮度量级（L~0.10，对应显示 ~0.87 的霾色）。
  float haze = 1.0 - exp(-tDeck / 22000.0);
  cloudCol = mix(cloudCol, vec3(0.105, 0.108, 0.115), haze * 0.85);
  // 低仰角淡出（配合掠射 LOD 粗化，云可以延伸到 ~6° 仰角再交给大气雾）
  alpha *= smoothstep(0.045, 0.11, ru);
  // 接近云层高度时淡出（最后 500 m）：穿云前云场先收敛再消失，观感自然
  alpha *= smoothstep(0.0, 500.0, above);
  return vec4(cloudCol, alpha);
}

// 天空辐亮度：沿 rd 从相机出发积分到大气顶（或地面），sunDiscScale = 0 时不出太阳盘
//   rCam = |地心→相机|，mu = dot(rd, up0)，返回已曝光、已 tone map 的线性显示色
vec3 atmoSkyRadiance(vec3 rd, vec3 sunDir, float rCam, float mu, float steps, float sunDiscScale) {
  vec3  p0 = -uAtmoCenterEC;                    // 相机相对地心
  vec3  up0 = p0 / max(rCam, 1.0);
  float tTop = atmoTopT(rCam, mu);
  float tGnd = atmoGroundT(rCam, mu);
  float tMax = (tGnd > 0.0 && tGnd < tTop) ? tGnd : tTop;
  float dt = tMax / max(steps, 1.0);

  vec3  L = vec3(0.0);
  vec3  T = vec3(1.0);
  float cosSun = dot(rd, sunDir);
  for (int i = 0; i < ATMO_SKY_MAX; i++) {
    if (float(i) >= steps) break;
    float t  = (float(i) + 0.5) * dt;
    vec3  p  = p0 + rd * t;
    float ri = length(p);
    vec3  upi = p / max(ri, 1e-3);
    float h  = max(ri - uAtmoBottomR, 0.0);
    float muSun = dot(upi, sunDir);
    vec3  ext = atmoDensR(h) * uAtmoRayleigh
              + atmoDensM(h) * (uAtmoMieScatter + uAtmoMieAbsorb)
              + atmoDensO(h) * uAtmoOzone;
    vec3  Tstep = exp(-ext * dt);
    // 段内解析积分： ∫₀^dt T(t) dt = T(0)·(1 − exp(−ext·dt))/ext
    vec3  segT = (1.0 - Tstep) / max(ext, vec3(1e-9));
    L += atmoScatterSource(h, cosSun, ri, muSun) * T * segT;
    T *= Tstep;
  }

  // 太阳盘：加在积分末尾（它在大气层外，故只被整段透过率衰减）
  if (sunDiscScale > 0.0) {
    float disc = smoothstep(uAtmoSunDiscCos, uAtmoSunDiscCos + (1.0 - uAtmoSunDiscCos) * 0.6,
                            cosSun);
    L += disc * sunDiscScale * T * atmoSunOcclusion(rCam, dot(up0, sunDir)) * uAtmoSunIrradiance;
  }

  // 云层合成：云在天空【之前】，同时遮住积分出的天色与太阳盘。
  // 放在曝光/tone map 之前 ⇒ 天穹、水面反射、水下斯涅尔窗三处色调严格一致。
  // 云辐亮度用太阳辐亮度同量级（真实云的反照率远高于瑞利天空，云比蓝天亮一个量级是对的）
  vec4 cl = atmoCloudLayer(rd, up0, sunDir, uCloudTime);
  L = mix(L, cl.rgb * uAtmoSunIrradiance * 0.30, cl.a);

  // 曝光 + Reinhard tone map：天穹与水面反射共用同一个函数 ⇒ 色调严格一致
  vec3 c = L * uAtmoExposure;
  return c / (1.0 + c);
}

// 气透视：相机 → 距离 tPoint 处的片元。输出该段透过率与入散射（均已曝光+tone map）
void atmoAerialPerspective(vec3 rd, float tPoint, vec3 sunDir, out vec3 apT, out vec3 apS) {
  vec3  p0 = -uAtmoCenterEC;
  float rCam = length(p0);
  float mu = dot(rd, p0 / max(rCam, 1.0));
  // 远处只算到大气顶为止
  float tTop = atmoTopT(rCam, mu);
  float tGnd = atmoGroundT(rCam, mu);
  float tLim = (tGnd > 0.0 && tGnd < tTop) ? tGnd : tTop;
  float t = min(tPoint, tLim);
  float dt = t / max(uAtmoAPSteps, 1.0);

  vec3  T = vec3(1.0);
  vec3  L = vec3(0.0);
  float cosSun = dot(rd, sunDir);
  for (int i = 0; i < ATMO_AP_MAX; i++) {
    if (float(i) >= uAtmoAPSteps) break;
    float ti = (float(i) + 0.5) * dt;
    vec3  p  = p0 + rd * ti;
    float ri = length(p);
    vec3  upi = p / max(ri, 1e-3);
    float h  = max(ri - uAtmoBottomR, 0.0);
    float muSun = dot(upi, sunDir);
    vec3  ext = atmoDensR(h) * uAtmoRayleigh
              + atmoDensM(h) * (uAtmoMieScatter + uAtmoMieAbsorb)
              + atmoDensO(h) * uAtmoOzone;
    vec3  Tstep = exp(-ext * dt);
    vec3  segT = (1.0 - Tstep) / max(ext, vec3(1e-9));
    L += atmoScatterSource(h, cosSun, ri, muSun) * T * segT;
    T *= Tstep;
  }
  apT = T;
  vec3 c = L * uAtmoExposure;
  apS = c / (1.0 + c);
}
`;

  // ==========================================================================
  // 片元着色器：UE5 SingleLayerWater 近似
  // ==========================================================================
  const FRAGMENT_SHADER = ATMOSPHERE_GLSL + `
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

  // 一阶微坡项：d(NdV) 恰好 = "坡度向量 · 视线在切平面的投影"。
  // 掠射角下（低机位看远水面，NdV≈0.2）它就是灰板问题的钥匙 —— 见下一节。
  // 【只取涟漪层】涌浪层(s3)是真实的大尺度倾斜（远处权重 0.78、坡度可达 0.4），
  // 它对反射仰角的影响已经完整包含在 R 里，绝不能再进放大项 ——
  // 否则远场 elev 被推 ±1.2、skyT 大面积撞钳位，整片海退化成灰斑（实测翻车）。
  vec2  Vtb         = vec2(dot(Te, V), dot(Be, V));
  vec2  slopeRipple = slope - s3 * swellBoost;
  float micro       = dot(slopeRipple * uNormalStrength, Vtb);

  // ---------- 5. 解析天空反射 ----------
  // 仰角 elev: 反射方向与"上"的夹角余弦；0 = 地平线，1 = 天顶
  // 【掠射"灰板"】低机位看中景水面时 NdV≈0.2，fresnel 高达 0.4~0.7 —— 颜色六七成
  // 是反射的天空；而掠射角反射到的是【地平线附近的平滑渐变】，涟漪让反射仰角
  // 抖动的那一点点（实测 Δelev 仅 ±0.03，被 mipmap 平均 + 归一化压缩）根本显不出
  // 结构，于是一整片一整片的缓坡成了无纹理的平坦石板灰（实测用户截图、8m 机位可复现）。
  // 物理上反射角的抖动 ≈ 2× 微坡抖动 —— 这里把 micro 直接加回 elev 并放大补偿：
  // 让反射的"天空采样位置"随涟漪高频移动，灰板碎成随波流动的明暗。
  vec3  R    = reflect(-V, N);
  float microC = clamp(micro * 3.0, -0.35, 0.35);   // 微坡补偿（两种天空模式共用）
  float elev = dot(R, upEC) + microC;
  float skyT = clamp(elev, 0.0, 1.0);
  float sunDot = dot(R, L);

  vec3  reflCol;
  if (uAtmoEnabled > 0.5) {
    // ---- Frostbite 物理天空反射 ----
    // 与天穹共用 atmoSkyRadiance + 同一批 uniform ⇒ 水天色调严格自洽，不再靠
    // 手调 uSkyColor/uHorizonColor 对齐。反射从片元出发与从相机出发的差别相对
    // 大气尺度可忽略，直接用相机处的天穹；微坡补偿照旧加在反射仰角上。
    float rCamA = length(uAtmoCenterEC);
    vec3  up0A  = -uAtmoCenterEC / max(rCamA, 1.0);
    vec3  rdR   = normalize(R + up0A * microC);
    // 【地平线以下必须钳到地平线再查天空，否则背光波面整体塌黑】
    // 掠射角下大量波面（尤其背光侧）的反射方向落到地平线以下；物理积分对
    // "打到地面"的射线只有沿途稀薄入散射、末端接地后地表辐射为 0 ——
    // 实测 el=-4° 背光方向亮度只有旧解析版的 1/6，且地平线上下有 4 倍断层。
    // 语义上掠射的远海 fresnel≈1，反射的就是地平线天空本身，所以钳到地平线
    // 采样（保住方位角 → 太阳侧亮、背光侧暗的方向感还在），再与解析分支
    // 一样按 belowT 混向远海色。clamped 后地平线上下无缝。
    float elevR  = dot(rdR, up0A);
    vec3  rdSky  = normalize(rdR - up0A * min(elevR, 0.0));
    float belowT = 1.0 - smoothstep(-0.06, 0.0, elev);       // 1 = 地平线以下
    vec3  farSea = uAbsorptionColor * 0.45 + uScatteringColor * 0.30;
    // 反射里不出太阳盘：太阳亮路由下面的 spec/sunGlow 专管，两套太阳会穿帮。
    // 步数封顶 20：反射是"第二跳"光线，天穹那份精度在水面里看不出差别
    // （数值验证 20/32/64 步差异 <4%）。
    // 【uAtmoReflGain / uAtmoReflTint：物理天空反射的强度与色相校正】
    // 低太阳高度角下地平线天空在物理上是【暖白】的：太阳光斜穿大气被红光化，
    // 数值实测（el=11°）地平线 B-R = -0.05（暖）、朝太阳方向 (0.91,0.87,0.76)，
    // 天顶才是蓝的 —— 这是物理正确的结果。但掠射水面 fresnel 0.6~0.9 ⇒ 水色几乎
    // 等于这层暖白天空，中远景整片成灰白板：
    //   中远景水面实测  物理 (0.739,0.754,0.727)【近无彩色】 vs 旧解析天空 (0.489,0.638,0.724)【蓝】
    //   —— 亮度接近，差的是色度（B-R：0.00 vs 0.24）。而【对无彩色做饱和度提升无效】
    //   （R≈G≈B 时围绕亮度缩放仍是同一个值），只能乘一个色相。
    // 这里把面板上已有的 uHorizonColor（用户选定的地平线蓝）归一化到亮度 1 当滤镜：
    //   只改色相、不改明暗，且【只在地平线附近生效】—— 仰角升高后物理天空本来就是蓝的，
    //   不做干预（保持物理）。1.0 = 完全不干预（纯物理）。
    float elevSky = dot(rdSky, up0A);
    reflCol = atmoSkyRadiance(rdSky, L, rCamA, elevSky, min(uAtmoSkySteps, 20.0), 0.0);
    vec3  tintHC  = uHorizonColor / max(dot(uHorizonColor, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    reflCol *= mix(vec3(1.0), tintHC, uAtmoReflTint * (1.0 - smoothstep(0.02, 0.30, elevSky)));
    // uAtmoReflGain：真实海面的粗糙微坡（几何遮蔽）会让掠射的实际反射率低于理想
    // Fresnel，且远处的海始终比它上方的天空【暗一截】。乘 <1 的增益同时得到这两点。
    reflCol *= uAtmoReflGain;
    reflCol  = mix(reflCol, farSea, belowT * uBelowHorizonDark);
  } else {
    // ---- 解析天空（uAtmoEnabled=0 时退回）----
    // 天顶 -> 地平线 渐变，再压一层地平线雾带，形成那条典型的亮边
    vec3 sky = mix(uHorizonColor, uSkyColor, pow(skyT, uSkyGradientPow));
    sky = mix(sky, uHorizonHaze, (1.0 - smoothstep(0.0, 0.12, skyT)) * uHorizonHazeStrength);
    // 【地平线以下反射的是"远处的海面"，不是天空 —— 不能只把天空色乘暗】
    // 反射方向落到地平线以下，打到的是远场海面/地表。往"远海色"（深水基色方向的
    // 暗青蓝）混合 —— 明暗波带的对比还在，但色调是暗海而不是死灰。
    float belowT = 1.0 - smoothstep(-0.06, 0.0, elev);       // 1 = 地平线以下
    vec3  farSea  = uAbsorptionColor * 0.45 + uScatteringColor * 0.30;
    sky += pow(max(sunDot, 0.0), 20.0) * uSkyForwardScatter * uSunColor;
    reflCol = mix(sky, farSea, belowT * uBelowHorizonDark);
  }

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

  // ---------- 7. 太阳高光：GGX 各向异性（UE 同款公式，v21）----------
  // 【为什么换 GGX】旧实现是 Blinn-Phong 幂（pow(NdH, n)）：峰值尖锐、衰减是指数型
  // 的"断崖"；真实波面的坡度是统计分布，UE 的 SingleLayerWater 用 GGX —— 长尾衰减
  // 让光路从"亮核+硬边"变成"亮核+渐远的银色尾迹"，这正是实拍海面光路的样子。
  // 【高光 LOD 保留】粗糙度随距离增大（= 旧版"远处展宽高光瓣"的物理化表述），
  // 换算沿用 α=sqrt(2/(n+2))，与旧参数量纲对齐：uSpecularPower 1200 / Far 260 不用重调。
  // 【各向异性】UE 的 D_GGXaniso：沿切向（风流方向）拉长高光瓣 —— 闪鳞被拉成横向鳞片。
  vec3  H    = normalize(L + V);
  float NdH  = max(dot(N, H), 0.0);
  float NdVc = max(dot(N, V), 1e-3);
  float NdLc = max(dot(N, L), 0.0);
  float rough = mix(sqrt(2.0 / (uSpecularPowerFar + 2.0)),
                    sqrt(2.0 / (uSpecularPower + 2.0)), fadeHigh);
  float ani  = clamp(uSpecularAniso, 0.0, 0.9);
  float kA   = sqrt(max(1.0 - 0.9 * ani, 1e-3));
  float at   = rough / kA;                       // 切向粗糙度（拉长方向）
  float bt   = rough * kA;                       // 副切向粗糙度
  float ToH  = dot(Te, H);
  float BoH  = dot(Be, H);
  float a2   = at * bt;
  vec3  vw   = vec3(bt * ToH, at * BoH, a2 * NdH);
  float v2   = dot(vw, vw);
  float D    = a2 / max(ATMO_PI * v2 * v2, 1e-7);
  D *= ATMO_PI * a2 * a2 * a2;                   // 峰值归一化：NoH=1 ⇒ D=1（旧版峰值行为对齐，参数不炸）
                                                 // 【v21 修正】原写成 *π*a2，实际峰值 = 1/a2² ≈ 3.6e5
                                                 // （rough=0.0408 时），整片海面被高光打爆成纯白。
                                                 // 底式在 NoH=1 处 = 1/(π·a2³)，故正确因子是 π·a2³。
  float VoH  = max(dot(V, H), 0.0);
  float F    = 0.0201 + 0.9799 * pow(1.0 - VoH, 5.0);   // Schlick（IOR 1.33 的 F0）
  float rv   = sqrt(max(NdVc * NdVc * (1.0 - rough * rough) + rough * rough, 1e-6));
  float rl   = sqrt(max(NdLc * NdLc * (1.0 - rough * rough) + rough * rough, 1e-6));
  float Vis  = 0.5 / max(NdLc * rv + NdVc * rl, 1e-4);  // Smith 联合近似（UE 同款）
  float spec = uSpecularIntensity * D * F * Vis * NdLc;
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

  // ---------- 9.5 大气透视 ----------
  // Cesium 对 globe 上的影像瓦片会应用 scene.fog（远处被压向天色），而模型是 UNLIT
  // 的 CustomShader，【不会】自动得到这层雾。不补上的话，拉远看时水面比周围的
  // 影像海面更深、更饱和 —— 一眼就能看出那是一块"贴上去的方片"。
  if (uAtmoEnabled > 0.5) {
    // ---- Frostbite 物理气透视：沿视线从相机积分到片元，替代手调二次雾 ----
    // 与天穹同一套物理：远处水面自然沉入大气色，水天线不再需要雾色对齐。
    // 合成式 color·T + S：apT 是原始光谱透过率（≤1），apS 已曝光 + tone map ——
    // 水色是手调的显示空间颜色，这个组合正是把"水面"压进"大气"的标准近似。
    vec3 apT, apS;
    atmoAerialPerspective(normalize(posEC), viewDist, L, apT, apS);
    // 【uAtmoApScale：气透视强度 —— 用户反馈"大片灰白"的第一来源】
    // 全强度 AP 在这个场景里比旧解析雾强 20~50 倍（数值：3 km 处 apS=(0.305,0.264,0.229)
    // 而旧解析雾只有 0.56%；8 km apS≈0.53、旧雾 3.9%），且 apS 是【中性偏暖】的
    // （多次散射各向同性 + 低太阳的米氏），叠在深青水色上 ⇒ 中远景整片灰白。
    // 实测合成：3 km 水色从 (0.01,0.12,0.15) 被拉到 (0.31,0.37,0.37) —— 55% 中灰。
    // 用 mix 而不是直接缩放：uAtmoApScale=1 仍是标准合成式 color·T+S（物理），
    // =0 完全关闭，中间值线性插值，单调、可预期。
    color = mix(color, color * apT + apS, clamp(uAtmoApScale, 0.0, 1.0));
  } else {
    // 解析雾：与 czm_fog 相同的二次型 1 - exp(-(d·ρ)²)，密度可调以便对齐不同底图
    float hazeT = 1.0 - exp(-pow(viewDist * uHazeDensity, 2.0));
    color = mix(color, uHorizonHaze, hazeT);
  }

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

    vec3 skyThru;
    if (uAtmoEnabled > 0.5 && refrOK > 0.5) {
      // 窗内直接看折射方向的物理天空（与天穹同一函数）—— 水下看到的天色也自洽。
      // 太阳透光仍用上面的解析盘：折射方向随波面抖动，物理太阳盘（0.27°）会被
      // 抖成噪声，解析的 900 次幂宽盘才是"随波闪动的亮斑"的正确量级。
      vec3 rdRe = normalize(refrAir);
      float rCamU = length(uAtmoCenterEC);
      vec3  up0U  = -uAtmoCenterEC / max(rCamU, 1.0);
      skyThru = atmoSkyRadiance(rdRe, L, rCamU, dot(rdRe, up0U), min(uAtmoSkySteps, 16.0), 0.0)
              + (uSunBody + uSunHalo) * uSunColor;
    } else {
      skyThru = mix(uHorizonColor, uSkyColor, 0.55) * 1.05
              + (uSunBody + uSunHalo) * uSunColor;           // 窗内：折射出去的天空 + 太阳透光
    }
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
  // Frostbite 大气 —— JS 侧：参数、LUT 生成、天穹、对外接口
  //
  //  【LUT 为什么要预计算】每像素实时积分整层大气（几十步 × 每步密度/透过率）
  //  在天空上还撑得住，但水面每个像素都要再算一次反射方向 + 一次气透视，
  //  成本立刻翻几倍。Hillaire 的办法是把两件与视角无关的积分预先烘成小贴图：
  //    · transmittance 256×64：三个通道的透过率，随「半径 + 天顶角」变化
  //    · multi-scattering 32×32：多次散射的辐亮度，随「半径 + 太阳天顶角」变化
  //  生成成本：transmittance 约 1M 次采样、multi-scattering 约 2M 次 ——
  //  两者都是纯算术，在 JS 里总耗时约 0.3~1 s（启动时一次，之后零成本）。
  //
  //  【参数化必须与 GLSL 侧逐字一致】改这里就必须同步改 atmoUv() / atmoMultiScatter()。
  // ==========================================================================
  const ATMOSPHERE_PRESET = {
    bottomRadius: 6368000,        // 运行时会被 site 的实际地心半径覆盖
    topRadius: 6468000,           // 默认 = 地面 + 100 km
    rayleighScattering: [5.802e-6, 13.558e-6, 33.100e-6],   // (1/m) 瑞利散射系数
    rayleighScaleHeight: 8000,    // 瑞利标高 (m)
    mieScattering: 3.996e-6,      // 米氏散射系数 (1/m)
    mieAbsorption: 4.400e-6,      // 米氏吸收系数 (1/m)
    mieScaleHeight: 1200,         // 米氏标高 (m)
    miePhaseG: 0.8,               // HG 相函数各向异性（决定太阳周围的强前向散射）
    ozoneAbsorption: [0.650e-6, 1.881e-6, 0.085e-6],         // 臭氧吸收（蓝天的来源之一）
    ozoneCenterHeight: 25000,
    ozoneWidth: 15000,
    multiScatteringFactor: 0.5,   // 几何级数公比 f：多次散射 ≈ L2/(1−f)
    sunAngularRadius: 0.004675,   // 太阳角半径 ≈0.268°
    sunIrradiance: 1.0,
    exposure: 40.0,               // 曝光（把散射辐亮度映射到显示区间）
    transmittanceLutWidth: 256,
    transmittanceLutHeight: 64,
    multiLutSize: 32,
    skySteps: 32,                 // 天空步进数（常量上限见 GLSL 的 ATMO_SKY_MAX）
    apSteps: 8,                   // 气透视步进数
    // ---- 程序化云层（v21：天穹/水面反射/水下斯涅尔窗共享同一朵云）----
    cloudCover: 0.42,             // 云量 0..1（0 晴空 / 1 阴天）
    cloudSharp: 0.30,             // 云边缘软硬（越大越碎越"絮"）
    cloudSpeed: 0.008,            // 漂移速度（uv/秒，量级 ~ 真实微风）
    // ---- 云层视差（v22：云是有高度的一层，缩放/平移相机会真实改变云场）----
    cloudHeight: 2200,            // 云底离地高度 m（决定"拉近拉远时云的收敛发散"）
    cloudScale: 650,              // 云团特征尺寸 m（一个 FBM 特征对应的世界尺寸）
  };

  // ---- 与 GLSL 逐字对应的参数化 ----
  //
  // 【高度映射：不用 Hillaire 原版的 r² 线性映射】
  // 原版 v ∈ [0,1] → r = sqrt(Rb² + v(Rt²−Rb²))，在 64 行下近地面每行跨约 1560 m，
  // 而米氏标高只有 1200 m —— 结果是"海平面相机"采样到的其实是 788 m 高处的透过率，
  // 天空整体偏亮、夕阳不够红（自检里相对误差 -10% 就是这么来的）。
  // 海洋 Demo 的相机永远贴着地面，所以改成【指数映射】把分辨率压到近地面：
  //     h(v) = H0·(e^(v·K) − 1),  K = ln(1 + hMax/H0)
  //   64 行时：最底行中心 ≈ 10 m，10 km 处仍有 ~1 km 的分辨率。
  const ATMO_H0 = 500;                       // 指数映射的参考高度 (m)
  function atmoHeightMapping(P) {
    if (P.h0 === undefined) {
      P.h0 = ATMO_H0;
      P.hScale = Math.log1p(Math.max(P.topRadius - P.bottomRadius, 1) / P.h0);
    }
    return P;
  }
  function atmoHFromV(v, P) { return P.h0 * Math.expm1(Math.min(Math.max(v, 0), 1) * P.hScale); }
  function atmoVFromH(h, P) { return Math.log1p(Math.max(h, 0) / P.h0) / P.hScale; }
  function atmoRadiusFromV(v, P) { return P.bottomRadius + atmoHFromV(v, P); }
  function atmoMuHorizonJS(r, Rb) {
    const k = Math.min(1, Rb / Math.max(r, 1e-6));
    return -Math.sqrt(Math.max(0, 1 - k * k));
  }
  function atmoMuFromU(u, r, Rb) {
    const mh = atmoMuHorizonJS(r, Rb);
    const t = Math.min(Math.max(u, 0), 1);
    return mh + (1 - mh) * t * t;
  }
  function atmoUFromMu(mu, r, Rb) {
    const mh = atmoMuHorizonJS(r, Rb);
    return Math.sqrt(Math.min(Math.max((mu - mh) / Math.max(1 - mh, 1e-6), 0), 1));
  }
  function atmoTentOzone(h, P) {
    return Math.max(0, 1 - Math.abs(h - P.ozoneCenterHeight) / P.ozoneWidth);
  }
  // 分段指数积分：∫exp(-h/H)dt，h 在该段内按线性近似
  function atmoSegExp(h1, h2, invScaleH, dt) {
    const dh = h2 - h1;
    const e1 = Math.exp(-h1 * invScaleH);
    if (Math.abs(dh) < 1e-6) return dt * e1;
    const e2 = Math.exp(-h2 * invScaleH);
    return dt * (e1 - e2) / (dh * invScaleH);
  }
  // LUT 双线性采样（与 GLSL 的 texture() 行为一致，供 multi-scattering 生成与校验用）
  function atmoSampleLutChannel(lut, u, v, ch) {
    const W = lut.width, H = lut.height, d = lut.data;
    const x = u * W - 0.5, y = v * H - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const cx0 = Math.min(Math.max(x0, 0), W - 1), cx1 = Math.min(Math.max(x0 + 1, 0), W - 1);
    const cy0 = Math.min(Math.max(y0, 0), H - 1), cy1 = Math.min(Math.max(y0 + 1, 0), H - 1);
    const a = d[(cy0 * W + cx0) * 4 + ch], b = d[(cy0 * W + cx1) * 4 + ch];
    const c = d[(cy1 * W + cx0) * 4 + ch], e = d[(cy1 * W + cx1) * 4 + ch];
    return (a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy;
  }
  function atmoSampleTransmittanceRGB(lut, r, mu, Rb, Rt) {
    const h = Math.max(r - Rb, 0);
    const P0 = { h0: ATMO_H0, hScale: Math.log1p(Math.max(Rt - Rb, 1) / ATMO_H0) };
    const v = Math.min(Math.max(atmoVFromH(h, P0), 0), 1);
    const u = atmoUFromMu(mu, r, Rb);
    return [
      atmoSampleLutChannel(lut, u, v, 0),
      atmoSampleLutChannel(lut, u, v, 1),
      atmoSampleLutChannel(lut, u, v, 2),
    ];
  }

  // ---- Transmittance LUT：从 (r, mu) 走到大气顶的光学厚度 ----
  function buildTransmittanceLUT(P) {
    atmoHeightMapping(P);
    const W = P.transmittanceLutWidth, H = P.transmittanceLutHeight;
    const Rb = P.bottomRadius, Rt = P.topRadius;
    const invHr = 1 / P.rayleighScaleHeight;
    const invHm = 1 / P.mieScaleHeight;
    // 128 步：地平线附近的掠射光线程最长（Chapman 可达 20 倍），
    // 段内高度线性化的误差 ~ O(dt²)，步数翻倍可把最差相对误差压到 <0.3%。
    const STEPS = 128;
    const data = new Float32Array(W * H * 4);
    for (let j = 0; j < H; j++) {
      const r = atmoRadiusFromV((j + 0.5) / H, P);
      for (let i = 0; i < W; i++) {
        const mu = atmoMuFromU((i + 0.5) / W, r, Rb);
        const b = r * mu;
        const tTop = -b + Math.sqrt(Math.max(b * b - (r * r - Rt * Rt), 0));
        const dt = tTop / STEPS;
        let odR = 0, odM = 0, odO = 0;
        let r1 = r;
        for (let s = 0; s < STEPS; s++) {
          const t2 = (s + 1) * dt;
          const r2 = Math.sqrt(r * r + t2 * t2 + 2 * r * mu * t2);
          const h1 = Math.max(r1 - Rb, 0);
          const h2 = Math.max(r2 - Rb, 0);
          odR += atmoSegExp(h1, h2, invHr, dt);
          odM += atmoSegExp(h1, h2, invHm, dt);
          odO += 0.5 * dt * (atmoTentOzone(h1, P) + atmoTentOzone(h2, P));
          r1 = r2;
        }
        const k = (j * W + i) * 4;
        for (let c = 0; c < 3; c++) {
          const ext = P.rayleighScattering[c] * odR
                    + (P.mieScattering + P.mieAbsorption) * odM
                    + P.ozoneAbsorption[c] * odO;
          data[k + c] = Math.exp(-ext);
        }
        data[k + 3] = 1;
      }
    }
    return { data, width: W, height: H };
  }

  // 一阶（单次）散射：沿 nu 方向从 (r0) 出发，积分到达该点的太阳散射辐亮度
  //   —— multi-scattering LUT 的被积函数。局部标架：up=(0,1,0)，太阳方位角 0。
  function atmoIntegrateFirstOrder(r0, nu, sun, P, lut) {
    const Rb = P.bottomRadius, Rt = P.topRadius;
    const STEPS = 32;
    const mu0 = nu[1];
    const b = r0 * mu0;
    const c = r0 * r0 - Rb * Rb;
    const disc = b * b - c;
    let tGnd = -1;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      if (-b - sq > 0) tGnd = -b - sq;
      else if (-b + sq > 0) tGnd = -b + sq;
    }
    const tTop = -b + Math.sqrt(Math.max(b * b - (r0 * r0 - Rt * Rt), 0));
    const tMax = (tGnd > 0 && tGnd < tTop) ? tGnd : tTop;
    const dt = tMax / STEPS;
    const Ta = atmoSampleTransmittanceRGB(lut, r0, mu0, Rb, Rt);   // 常量，提出循环
    const cosSun = nu[0] * sun[0] + nu[1] * sun[1] + nu[2] * sun[2];
    const pr = 0.05968310365946075 * (1 + cosSun * cosSun);
    const g = P.miePhaseG, g2 = g * g;
    const pm = (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * cosSun, 1e-4), 1.5));
    let out = [0, 0, 0];
    for (let s = 0; s < STEPS; s++) {
      const t = (s + 0.5) * dt;
      const px = t * nu[0], py = r0 + t * nu[1], pz = t * nu[2];
      const ri = Math.sqrt(px * px + py * py + pz * pz);
      const h = Math.max(ri - Rb, 0);
      const muSun = (px * sun[0] + py * sun[1] + pz * sun[2]) / ri;
      const muView = (r0 * mu0 + t) / ri;
      const Tsun = atmoSampleTransmittanceRGB(lut, ri, muSun, Rb, Rt);
      // T(相机/起点 → 该点) = T(起点→顶) / T(该点→顶)  —— 同一条直线上的除法技巧
      const Tb = atmoSampleTransmittanceRGB(lut, ri, muView, Rb, Rt);
      const dR = Math.exp(-h / P.rayleighScaleHeight);
      const dM = Math.exp(-h / P.mieScaleHeight);
      for (let ch = 0; ch < 3; ch++) {
        const beta = P.rayleighScattering[ch] * dR * pr + P.mieScattering * dM * pm;
        const Tview = Ta[ch] / Math.max(Tb[ch], 1e-6);
        out[ch] += Tview * Tsun[ch] * beta * dt;
      }
    }
    return out;
  }

  // ---- Multi-scattering LUT：多次散射的辐亮度（各向同性近似 + 几何级数）----
  function buildMultiScatteringLUT(P, transLUT) {
    atmoHeightMapping(P);
    const N = P.multiLutSize;
    const Rb = P.bottomRadius;
    const DIRS = 64;       // 球面上的方向数（Fibonacci 均匀分布）
    const dirs = [];
    const golden = 2.399963229728653;
    for (let i = 0; i < DIRS; i++) {
      const y = 1 - 2 * (i + 0.5) / DIRS;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * golden;
      dirs.push([rr * Math.cos(phi), y, rr * Math.sin(phi)]);
    }
    const f = Math.min(Math.max(P.multiScatteringFactor, 0), 0.95);
    const geom = 1 / (1 - f);                       // 1 + f + f² + … ：无限次散射
    const data = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      const r = atmoRadiusFromV((j + 0.5) / N, P);
      for (let i = 0; i < N; i++) {
        const mu = ((i + 0.5) / N) * 2 - 1;         // 太阳天顶角余弦（u 轴线性）
        const s = Math.sqrt(Math.max(0, 1 - mu * mu));
        const sun = [s, mu, 0];
        let sr = 0, sg = 0, sb = 0;
        for (let d = 0; d < DIRS; d++) {
          const c = atmoIntegrateFirstOrder(r, dirs[d], sun, P, transLUT);
          sr += c[0]; sg += c[1]; sb += c[2];
        }
        // 均匀方向求平均 = (1/4π)∫L₁dω；再乘几何级数得到多次散射总量
        const k = (j * N + i) * 4;
        data[k]     = sr / DIRS * geom;
        data[k + 1] = sg / DIRS * geom;
        data[k + 2] = sb / DIRS * geom;
        data[k + 3] = 1;
      }
    }
    return { data, width: N, height: N };
  }

  // Float32 → Float16（LUT 用半浮点：占 8 KB 且 WebGL2 原生支持线性过滤，
  // 8 位定点在天空的平滑渐变上会出现明显色带）
  const _f32 = new Float32Array(1);
  const _i32 = new Int32Array(_f32.buffer);
  function floatToHalf(v) {
    _f32[0] = v;
    const x = _i32[0];
    const sign = (x >> 16) & 0x8000;
    const e = (x >> 23) & 0xff;
    let m = x & 0x7fffff;
    if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
    const exp = e - 127 + 15;
    if (exp >= 0x1f) return sign | 0x7c00;
    if (exp <= 0) {
      if (exp < -10) return sign;
      m |= 0x800000;
      return sign | (m >> (14 - exp));
    }
    return sign | (exp << 10) | (m >> 13);
  }
  function atmoLutTextureUniform(lut) {
    const half = new Uint16Array(lut.data.length);
    for (let i = 0; i < lut.data.length; i++) half[i] = floatToHalf(lut.data[i]);
    return new Cesium.TextureUniform({
      typedArray: half,
      width: lut.width,
      height: lut.height,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.HALF_FLOAT,
      repeat: false,                                                 // CLAMP_TO_EDGE
      minificationFilter: Cesium.TextureMinificationFilter.LINEAR,   // LUT 不加 mipmap
      magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
    });
  }

  // 1×1 中性 LUT：createWater 未接大气时占位，保证 sampler uniform 始终有效
  function atmoDummyLutUniform() {
    return new Cesium.TextureUniform({
      typedArray: new Uint16Array([0x3c00, 0x3c00, 0x3c00, 0x3c00]),   // half(1.0)
      width: 1, height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.HALF_FLOAT,
      repeat: false,
    });
  }

  // 天穹顶点着色器：几何体只负责"覆盖全屏"，位置不动
  const SKY_VERTEX_SHADER = `
void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
  // 天空盒的顶点位置不做任何修改：片元端用 positionEC 反推视线方向
}
`;
  const SKY_FRAGMENT_SHADER = ATMOSPHERE_GLSL + `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  // 相机在眼空间原点 ⇒ 视线方向就是片元位置的方向
  vec3 rd = normalize(fsInput.attributes.positionEC);
  vec3 sunDir = normalize(czm_sunDirectionEC);
  float rCam = length(uAtmoCenterEC);
  vec3  up0 = -uAtmoCenterEC / max(rCam, 1.0);
  vec3 col = atmoSkyRadiance(rd, sunDir, rCam, dot(rd, up0),
                             uAtmoSkySteps, uAtmoSunDiscScale);
  material.diffuse = col;
  material.alpha = 1.0;
}
`;

  // 以地心为中心、包住整层大气的立方体（内表面朝向相机，故三角形绕序翻转）
  function buildSkyBoxGlb(halfExtent) {
    const h = halfExtent;
    // 6 个面，每面 4 个顶点（POSITION + NORMAL + TEXCOORD_0）
    const faces = [
      [[+1, 0, 0], [[+h, -h, -h], [+h, -h, +h], [+h, +h, +h], [+h, +h, -h]]],
      [[-1, 0, 0], [[-h, -h, +h], [-h, -h, -h], [-h, +h, -h], [-h, +h, +h]]],
      [[0, +1, 0], [[-h, +h, -h], [+h, +h, -h], [+h, +h, +h], [-h, +h, +h]]],
      [[0, -1, 0], [[-h, -h, +h], [+h, -h, +h], [+h, -h, -h], [-h, -h, -h]]],
      [[0, 0, +1], [[-h, -h, +h], [-h, +h, +h], [+h, +h, +h], [+h, -h, +h]]],
      [[0, 0, -1], [[+h, -h, -h], [+h, +h, -h], [-h, +h, -h], [-h, -h, -h]]],
    ];
    const positions = new Float32Array(24 * 3);
    const normals = new Float32Array(24 * 3);
    const uvs = new Float32Array(24 * 2);
    const indices = new Uint16Array(36);
    let vi = 0, ii = 0;
    for (let f = 0; f < 6; f++) {
      const n = faces[f][0], v = faces[f][1];
      for (let k = 0; k < 4; k++) {
        positions[vi * 3] = v[k][0]; positions[vi * 3 + 1] = v[k][1]; positions[vi * 3 + 2] = v[k][2];
        normals[vi * 3] = n[0]; normals[vi * 3 + 1] = n[1]; normals[vi * 3 + 2] = n[2];
        uvs[vi * 2] = (k === 1 || k === 2) ? 1 : 0;
        uvs[vi * 2 + 1] = (k >= 2) ? 1 : 0;
        vi++;
      }
      const b = f * 4;
      // 绕序翻转：我们是从立方体【内部】看它的内表面
      indices[ii++] = b;     indices[ii++] = b + 2; indices[ii++] = b + 1;
      indices[ii++] = b;     indices[ii++] = b + 3; indices[ii++] = b + 2;
    }

    const posLen = positions.byteLength, nrmLen = normals.byteLength;
    const uvLen = uvs.byteLength, idxLen = indices.byteLength;
    const binLen = posLen + nrmLen + uvLen + idxLen;
    const bin = new Uint8Array(binLen);
    let o = 0;
    bin.set(new Uint8Array(positions.buffer), o); o += posLen;
    bin.set(new Uint8Array(normals.buffer), o); o += nrmLen;
    bin.set(new Uint8Array(uvs.buffer), o); o += uvLen;
    bin.set(new Uint8Array(indices.buffer), o); o += idxLen;

    const json = {
      asset: { version: '2.0', generator: 'ue5-water-material.js (sky)' },
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
      materials: [{ name: 'SkyDome', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: false }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-h, -h, -h], max: [h, h, h] },
        { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: 24, type: 'VEC2' },
        { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posLen, target: 34962 },
        { buffer: 0, byteOffset: posLen, byteLength: nrmLen, target: 34962 },
        { buffer: 0, byteOffset: posLen + nrmLen, byteLength: uvLen, target: 34962 },
        { buffer: 0, byteOffset: posLen + nrmLen + uvLen, byteLength: idxLen, target: 34963 },
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
    dv.setUint32(p, 0x46546c67, true); p += 4;
    dv.setUint32(p, 2, true); p += 4;
    dv.setUint32(p, total, true); p += 4;
    dv.setUint32(p, jsonChunkLen, true); p += 4;
    dv.setUint32(p, 0x4e4f534a, true); p += 4;
    u8.set(jsonBytes, p); p += jsonBytes.length;
    for (let i = 0; i < jsonPad; i++) u8[p++] = 0x20;
    dv.setUint32(p, binChunkLen, true); p += 4;
    dv.setUint32(p, 0x004e4942, true); p += 4;
    u8.set(bin, p); p += binLen;
    for (let i = 0; i < binPad; i++) u8[p++] = 0;
    return glb;
  }

  // 把大气参数摊成 CustomShader 的 uniform 描述符（天穹与水面共享同一份对象，
  // 于是 setUniform 一次两边一起变）
  function atmoUniformSet(P, transLUT, multiLUT) {
    const cart = function (a) { return new Cesium.Cartesian3(a[0], a[1], a[2]); };
    return {
      // LUT 传 null 时用 1×1 中性纹理占位 —— 水面未接大气时保证 sampler 有效
      uAtmoTransLUT: { type: Cesium.UniformType.SAMPLER_2D, value: transLUT ? atmoLutTextureUniform(transLUT) : atmoDummyLutUniform() },
      uAtmoMultiLUT: { type: Cesium.UniformType.SAMPLER_2D, value: multiLUT ? atmoLutTextureUniform(multiLUT) : atmoDummyLutUniform() },
      uAtmoCenterEC: { type: Cesium.UniformType.VEC3, value: new Cesium.Cartesian3(0, 0, 0) },
      uAtmoRayleigh: { type: Cesium.UniformType.VEC3, value: cart(P.rayleighScattering) },
      uAtmoRayleighH: { type: Cesium.UniformType.FLOAT, value: P.rayleighScaleHeight },
      uAtmoMieScatter: { type: Cesium.UniformType.FLOAT, value: P.mieScattering },
      uAtmoMieAbsorb: { type: Cesium.UniformType.FLOAT, value: P.mieAbsorption },
      uAtmoMieH: { type: Cesium.UniformType.FLOAT, value: P.mieScaleHeight },
      uAtmoMieG: { type: Cesium.UniformType.FLOAT, value: P.miePhaseG },
      uAtmoOzone: { type: Cesium.UniformType.VEC3, value: cart(P.ozoneAbsorption) },
      uAtmoOzoneCenter: { type: Cesium.UniformType.FLOAT, value: P.ozoneCenterHeight },
      uAtmoOzoneWidth: { type: Cesium.UniformType.FLOAT, value: P.ozoneWidth },
      uAtmoBottomR: { type: Cesium.UniformType.FLOAT, value: P.bottomRadius },
      uAtmoTopR: { type: Cesium.UniformType.FLOAT, value: P.topRadius },
      uAtmoH0: { type: Cesium.UniformType.FLOAT, value: P.h0 },
      uAtmoHScale: { type: Cesium.UniformType.FLOAT, value: P.hScale },
      uAtmoMultiScale: { type: Cesium.UniformType.FLOAT, value: 1.0 },
      uAtmoSunIrradiance: { type: Cesium.UniformType.FLOAT, value: P.sunIrradiance },
      uAtmoExposure: { type: Cesium.UniformType.FLOAT, value: P.exposure },
      uAtmoSunDiscCos: { type: Cesium.UniformType.FLOAT, value: Math.cos(P.sunAngularRadius) },
      uAtmoSunDiscScale: { type: Cesium.UniformType.FLOAT, value: 12.0 },
      uAtmoSkySteps: { type: Cesium.UniformType.FLOAT, value: P.skySteps },
      uAtmoAPSteps: { type: Cesium.UniformType.FLOAT, value: P.apSteps },
      uAtmoEnabled: { type: Cesium.UniformType.FLOAT, value: 1.0 },
      // ---- 云层（v21）---- uCloudTime 每帧由水面 tick 写入（共享描述符 ⇒ 天穹同步动画）
      uCloudCover: { type: Cesium.UniformType.FLOAT, value: P.cloudCover !== undefined ? P.cloudCover : 0.42 },
      uCloudSharp: { type: Cesium.UniformType.FLOAT, value: P.cloudSharp !== undefined ? P.cloudSharp : 0.30 },
      uCloudSpeed: { type: Cesium.UniformType.FLOAT, value: P.cloudSpeed !== undefined ? P.cloudSpeed : 0.008 },
      // ---- 云层视差（v22）---- 高度/特征尺寸进投影，锚点定地理原点（世界系）
      uCloudHeight: { type: Cesium.UniformType.FLOAT, value: P.cloudHeight !== undefined ? P.cloudHeight : 2200 },
      uCloudScale:  { type: Cesium.UniformType.FLOAT, value: P.cloudScale !== undefined ? P.cloudScale : 650 },
      uCloudAnchorWC: { type: Cesium.UniformType.VEC3, value: P.cloudAnchorWC ? P.cloudAnchorWC.clone() : new Cesium.Cartesian3(0, 0, 0) },
      uCloudTime: { type: Cesium.UniformType.FLOAT, value: 0.0 },
    };
  }

  // ==========================================================================
  // createAtmosphere：生成 LUT + 天穹，并把 Cesium 自带大气/雾让位
  //   options: { site:{lon,lat,height}, params:{...}, exposure, onStep }
  // ==========================================================================
  async function createAtmosphere(viewer, options) {
    options = options || {};
    const report = (typeof options.onStep === 'function') ? options.onStep : function () {};
    const scene = viewer.scene;
    const P = Object.assign({}, ATMOSPHERE_PRESET, options.params || {});

    // 地面半径取 site 的【地心半径】：这样大气的地平线和场景里真实地平线贴合，
    // 不会出现"大气地平线"与"地球剪影"错开一条缝的廉价感
    const site = options.site || null;
    if (site) {
      const c = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, site.height || 0);
      P.bottomRadius = Cesium.Cartesian3.magnitude(c);
    }
    P.topRadius = P.bottomRadius + (options.atmosphereHeight || 100000);
    if (options.exposure !== undefined) P.exposure = options.exposure;
    // 云层视差的地理锚点（v22）：优先 site，否则用当前相机位置 —— 必须非零，
    // 着色器靠它把"云的世界位置"固定住，平移相机时云才会真实滑动而不是跟着镜头走
    P.cloudAnchorWC = site
      ? Cesium.Cartesian3.fromDegrees(site.lon, site.lat, site.height || 0)
      : viewer.camera.positionWC.clone();

    report('生成大气 LUT（transmittance / multi-scattering）');
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const transLUT = buildTransmittanceLUT(P);
    const multiLUT = buildMultiScatteringLUT(P, transLUT);
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const lutMs = Math.round(t1 - t0);

    const uniforms = atmoUniformSet(P, transLUT, multiLUT);
    const customShader = new Cesium.CustomShader({
      lightingModel: Cesium.LightingModel.UNLIT,
      uniforms: uniforms,
      vertexShaderText: SKY_VERTEX_SHADER,
      fragmentShaderText: SKY_FRAGMENT_SHADER,
    });

    report('生成天穹（glTF 立方体）');
    const glb = buildSkyBoxGlb(P.topRadius);
    const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
    const model = await Cesium.Model.fromGltfAsync({
      url: url,
      customShader: customShader,
      backFaceCulling: false,     // 从立方体【内部】看内表面
      allowPicking: false,
      show: true,
    });
    scene.primitives.add(model);

    // Cesium 自带天穹与物理大气是两套东西 —— 但【不能】简单关掉 skyAtmosphere：
    // 动态雾（scene.fog）的雾色与天空大气联动，skyAtmosphere 一关雾色变黑，
    // 远处的天穹会被"黑雾"整片吃掉（实测）。好在物理天穹是不透明几何，会把
    // Cesium 的天空盖在下面，两者共存不冲突：它只负责给 globe 的雾供色。
    const saved = {
      skyAtmosphere: scene.skyAtmosphere ? scene.skyAtmosphere.show : false,
      skyBox: scene.skyBox ? scene.skyBox.show : false,
      fogEnabled: scene.fog ? scene.fog.enabled : false,
    };
    if (scene.skyBox) scene.skyBox.show = false;

    const camera = viewer.camera;
    const origin = new Cesium.Cartesian3(0, 0, 0);
    const domeModelMatrix = new Cesium.Matrix4();
    const removeTick = scene.preUpdate.addEventListener(function () {
      if (!camera.viewMatrix) return;
      // 地心在眼空间的位置 = 视图矩阵把世界原点变换过去（即视图矩阵的平移列）
      Cesium.Matrix4.multiplyByPoint(camera.viewMatrix, origin, uniforms.uAtmoCenterEC.value);
      // 【天穹跟随相机平移】两个目的：
      //   1. 天空在光学上是"无穷远"，几何上跟着相机走才是正确语义（radiance 只由
      //      视线方向 rd 决定，与天穹片元的绝对位置无关）；
      //   2. 让天穹的包围球中心始终贴着相机 → Cesium 模型雾的判据
      //      fog(distance(相机, 包围球中心)) = 0 → u_isInFog=false → 天穹不被
      //      模型雾覆盖。若天穹定在地心（包围球中心恒距相机 6.37M），雾永远命中，
      //      而雾色取"天穹顶点处的地面大气色"（在大气顶≈0）→ 整个天空被涂黑（实测）。
      //      片元距离那一路也不用担心：u_isInFog=false 时 applyFog 整个跳过。
      Cesium.Matrix4.setTranslation(Cesium.Matrix4.IDENTITY, camera.positionWC, domeModelMatrix);
      model.modelMatrix = domeModelMatrix;
    });

    const subscribers = [];
    const handle = {
      uniforms: uniforms,          // 交给 createWater 复用（共享同一批描述符）
      params: P,
      model: model,
      customShader: customShader,
      lutMs: lutMs,
      transLUT: transLUT,
      multiLUT: multiLUT,
      enabled: true,

      /** 更新参数：写法与 createWater 一致（数值传 number，向量传数组） */
      setUniform: function (key, value) {
        const u = uniforms[key];
        if (!u) return;
        if (u.type === Cesium.UniformType.VEC3 && Array.isArray(value)) {
          u.value = new Cesium.Cartesian3(value[0], value[1], value[2]);
        } else {
          u.value = value;
        }
        for (let i = 0; i < subscribers.length; i++) subscribers[i](key, u.value);
      },

      /** 让另一个 CustomShader（水面）跟随大气的 uniform 变化 */
      subscribe: function (fn) { subscribers.push(fn); },

      /** 整体开关：关掉天穹并让水面退回解析天空，便于 A/B */
      setEnabled: function (on) {
        handle.enabled = !!on;
        model.show = handle.enabled;
        uniforms.uAtmoEnabled.value = handle.enabled ? 1 : 0;
        if (scene.skyBox) scene.skyBox.show = handle.enabled ? false : saved.skyBox;
        for (let i = 0; i < subscribers.length; i++) subscribers[i]('uAtmoEnabled', uniforms.uAtmoEnabled.value);
      },

      destroy: function () {
        if (removeTick) removeTick();
        scene.primitives.remove(model);
        URL.revokeObjectURL(url);
        if (scene.skyBox) scene.skyBox.show = saved.skyBox;
      },
    };
    return handle;
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
      uSpecularIntensity: 1.1,
      uFoamThreshold:     0.40,      // 调低（0.55→0.40）→ 泡沫覆盖更广，强化浪尖涌白与近岸翻涌
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
      // 【v18 灰斑修复】远处高光瓣 90 → 260：90 太宽，远场光路被抹成一片平滑乳白
      // （远处法线被 mipmap 平均后 NdH 无起伏，宽瓣 = 整片同时命中 ⇒ 蓝色被白稀释成灰带）。
      // 260 仍比近场的 1200 宽 4.6 倍，保住"远处高光能打中波面"的本意，但光路收成闪鳞柱。
      uSpecularPowerFar:  260,       // 远处高光瓣展宽（高光 LOD）
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
      // 【v17 用户选定配色 A"亮蓝"】四套候选（亮蓝/深宝蓝/晴日青蓝/暗深蓝）渲染对比后用户挑的这套。
      uSkyColor:          '#4a86b8', // 天顶色（只影响水里的反射）
      // 【地平线色决定掠射角的"灰/黑"】远场 fresnel 0.6~0.9 ⇒ 远场水色 ≈ 反射的地平线色本身。
      //   v15：#8fb6d0（HSV 饱和 31）→ 远场淡灰蓝（用户："大片灰色"）；
      //   v16：#5590c2（sat 56 但偏暗）→ 又踩了 pow 的坑，远场 lum 只有 110（用户："灰黑色"）；
      //   v17：#6db2e0（sat 46、亮度 68）+ pow 0.85 → 远场 rgb(93,143,178) lum 132，亮而蓝。
      // 【uSkyGradientPow 的方向千万别搞反】skyT∈[0,1]，指数越小 pow 值越大 ⇒
      //   越快混向暗天顶色 ⇒ 越暗。0.55→0.45（v15）实际是在"加速变暗"。
      uHorizonColor:      '#6db2e0',
      // 雾带同理：暖白会把掠射反射染成"脏灰"，转冷并降强度。
      // 【雾带恰好叠在远场】strength 大了会把刚调好的地平线色冲淡回灰。
      uHorizonHaze:       '#cfe2f0',
      uHorizonHazeStrength: 0.12,
      uSkyGradientPow:    0.85,
      uSkyForwardScatter: 0.45,      // 太阳附近的宽角前向散射（让反光有方向）
      // 【v19 用户实测发现并采纳】0.70 → 0.35：低机位掠射时大量波面的反射方向落到
      // 地平线以下，会被 mix 进"远海色"；0.70 时这些面片接近黑色 → 成片暗斑驳（"灰斑"）。
      // 配合 farSea 提亮（见着色器 §5），0.35 既消斑又保留部分远场明暗波带。
      // 面板上可继续微调：再小更干净但波带变平，再大波带明显但暗斑回来。
      uBelowHorizonDark:  0.35,      // 反射落到地平线以下时混入"远海色"的比例（远场明暗波带的来源）
      // ---- 云层（v21：物理天空反射的水面终于"有东西可反"）----
      // 云在共享大气 GLSL 里，天穹/水面反射/水下斯涅尔窗三处同一朵云。
      // 面板可调；uAtmoEnabled=0（解析天空退回）时云不出现。
      uCloudCover:        0.42,      // 云量 0..1
      uCloudSharp:        0.30,      // 云边缘软硬
      uCloudSpeed:        0.008,     // 漂移速度
      uCloudHeight:       2200,      // 云层高度 m（缩放升降时云场视差强度）
      uCloudScale:        650,       // 云团特征尺寸 m
      // ---- 物理大气下的水面合成控制（详见着色器 §5 / §9.5 注释）----
      // 低太阳高度角时物理天空的地平线本身就是暖白（B-R≈-0.05），全强度反射 +
      // 全强度气透视会让中远景水面变成灰白板（用户实测反馈）。
      // 【v21 用户实测定稿】"蓝的亮度太高、不真实" —— 上一版为了消灰白把反射拉回浅蓝，
      // 结果中远景成了偏亮的青蓝（实测 y[0.50,0.63] (0.490,0.608,0.679) L0.588）。
      // 真实深海在低太阳下应该【明显比天空暗】且偏深蓝：gain 0.75→0.45、tint 0.75→0.60。
      // 实测整片水面 y[0.38,1] 平均 L 0.531→0.454，蓝度(B-R) 0.112→0.084（更沉、不发青白）。
      // 往回调大即更接近物理/更亮；面板「物理大气·水面合成」组可实时调。
      uAtmoReflGain:      0.45,      // 物理天空反射强度（1 = 完全按物理，<1 压暗并露回水色）
      uAtmoReflTint:      0.60,      // 地平线附近反射色相校正（向 uHorizonColor 靠，1 = 全用 uHorizonColor）
      uAtmoApScale:       0.45,      // 气透视强度（1 = 标准 color·T+S，0 = 关闭）
      uSunColor:          '#fff2d8',
      uSunDiscCos:        0.99960,
      uSunDiscIntensity:  3.0,
      // 【v18 灰斑修复】0.45 → 0.22：辉光是太阳光路白色冲刷的第二大来源
      // （A/B 实测：关掉它光路列灰比 8.8%→6.1%）。减半后光路仍是金色亮带，但不再把
      // 周围一大片水冲成灰白。
      uSunGlowIntensity:  0.22,
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
      // 【v20】与海洋同步：0.55 → 0.35。湖泊同样会在掠射时把大量波面反射到地平线下，
      // 0.55 配合（已提亮的）farSea 仍偏暗；降到 0.35 消暗斑驳，湖面更均匀。
      uBelowHorizonDark:  0.35,
      // ---- 物理大气下的水面合成控制（海洋同步；湖面体色更亮，反射压得稍轻）----
      uAtmoReflGain:      0.50,
      uAtmoReflTint:      0.55,
      uAtmoApScale:       0.45,
      // ---- 云层（v21）：湖面天更晴一些 ----
      uCloudCover:        0.30,
      uCloudSharp:        0.32,
      uCloudSpeed:        0.005,
      uCloudHeight:       1800,      // 湖面云层低一些
      uCloudScale:        520,
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
    // uniforms 先建成独立对象：大气接入必须在 CustomShader 构造【之前】完成 ——
    // Cesium 的 uniformMap 在构造时按 key 闭包绑定，事后加 key 不会生效。
    const waterUniforms = {
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
        // 物理大气下的水面合成控制（水面专属，天穹不读）
        uAtmoReflGain:        { type: Cesium.UniformType.FLOAT, value: (state.uAtmoReflGain === undefined) ? 1.0 : state.uAtmoReflGain },
        uAtmoReflTint:        { type: Cesium.UniformType.FLOAT, value: (state.uAtmoReflTint === undefined) ? 0.0 : state.uAtmoReflTint },
        uAtmoApScale:         { type: Cesium.UniformType.FLOAT, value: (state.uAtmoApScale === undefined) ? 1.0 : state.uAtmoApScale },
        uSunColor:            { type: Cesium.UniformType.VEC3,  value: hexToLinear(state.uSunColor) },
        uSunDiscCos:          { type: Cesium.UniformType.FLOAT, value: state.uSunDiscCos },
        uSunDiscIntensity:    { type: Cesium.UniformType.FLOAT, value: state.uSunDiscIntensity },
        uSunGlowIntensity:    { type: Cesium.UniformType.FLOAT, value: state.uSunGlowIntensity },
        uSunGlowPow:          { type: Cesium.UniformType.FLOAT, value: state.uSunGlowPow },
    };

    // ---- Frostbite 大气 uniforms ----
    // 水面 shader 已包含 ATMOSPHERE_GLSL（uAtmo* 声明），这批 uniform 必须存在：
    //   · options.atmosphere 缺省：1×1 中性 LUT + uAtmoEnabled=0 → 走解析天空分支；
    //   · 接入 createAtmosphere 的句柄：与天穹【共享同一批描述符对象】——
    //     createAtmosphere 每帧只更新一次 uAtmoCenterEC，天穹与水面同时生效，
    //     水天色调严格一致（反射/气透视/水下斯涅尔窗三处共用）。
    const atmoDefaults = Object.assign({}, ATMOSPHERE_PRESET, { bottomRadius: 6368000, topRadius: 6468000 });
    atmoHeightMapping(atmoDefaults);
    const atmoFallback = atmoUniformSet(atmoDefaults, null, null);
    atmoFallback.uAtmoEnabled.value = 0;
    const sharedAtmo = (options.atmosphere && options.atmosphere.uniforms) ? options.atmosphere.uniforms : null;
    Object.assign(waterUniforms, sharedAtmo || atmoFallback);
    // 云参数以【水面预设】为准回写：描述符可能被天穹共享（sharedAtmo），
    // 回写到描述符对象上，天穹与水面同时生效 —— 湖泊少云/海洋多云各自成立
    ['uCloudCover', 'uCloudSharp', 'uCloudSpeed', 'uCloudHeight', 'uCloudScale'].forEach(function (k) {
      if (state[k] !== undefined && waterUniforms[k]) waterUniforms[k].value = state[k];
    });

    const customShader = new Cesium.CustomShader({
      lightingModel: Cesium.LightingModel.UNLIT,   // 光照全部自算，走 UNLIT 最省
      varyings: {
        v_nTbn:  Cesium.VaryingType.VEC3,          // 波面法线（TBN 坐标系）
        v_crest: Cesium.VaryingType.FLOAT,         // 归一化波峰高度（泡沫用）
      },
      uniforms: waterUniforms,
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
      // 云的漂移时间：写在本 tick 里，描述符与天穹共享 ⇒ 两处云同步动画
      customShader.setUniform('uCloudTime', seconds);
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
      atmosphere: options.atmosphere || null,   // 接入的大气句柄（调试/A-B 用）
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
    ATMOSPHERE_GLSL: ATMOSPHERE_GLSL,
    ATMOSPHERE_PRESET: ATMOSPHERE_PRESET,
    PRESETS: PRESETS,
    NORMAL_LAYERS: NORMAL_LAYERS,
    buildPlaneGlb: buildPlaneGlb,
    buildSkyBoxGlb: buildSkyBoxGlb,
    makeTileableHeightField: makeTileableHeightField,
    heightFieldToNormalData: heightFieldToNormalData,
    makeWaterNormalUniform: makeWaterNormalUniform,
    hexToLinear: hexToLinear,
    buildTransmittanceLUT: buildTransmittanceLUT,
    buildMultiScatteringLUT: buildMultiScatteringLUT,
    atmoSampleTransmittanceRGB: atmoSampleTransmittanceRGB,
    createWater: createWater,
    createAtmosphere: createAtmosphere,
    createUnderwater: createUnderwater,
  };
})(typeof window !== 'undefined' ? window : globalThis);
