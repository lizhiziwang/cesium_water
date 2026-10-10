# UE5 SingleLayerWater 近似 · Cesium CustomShader 高性能水面

用 **Cesium `CustomShader` + `Model`（glTF 面片）** 复刻 UE5 `SingleLayerWater` 的单层水视觉要素：
菲涅尔、水体吸收/散射、**三层**法线滚动、Gerstner 顶点波、太阳高光闪鳞、
解析天空反射（天顶渐变 + 地平线雾带 + 太阳盘 + 太阳光路）、浪峰泡沫。
全部 Web 端高性能实现，**不引入任何第三方库**。

```
ue5-water-customshader/
├── index.html              ← 单文件完整 Demo（内联了模块代码，双击即可打开）
├── ue5-water-material.js   ← 模块版：可直接接入你现有项目（shader + glb 生成 + 参数预置）
├── _sync_inline.cjs        ← 把模块同步进 index.html 的标记块（改完模块必须跑一次）
├── _verify_glb.cjs         ← 静态自检：JS 语法 / 内联一致性 / Cesium 属性扫描复现 / glb 结构 / 法线贴图
├── _render_probe.cjs       ← 无头渲染探针：真跑一遍页面，抓编译日志 + 截图（Chromium 软渲染）
├── _tone_check.cjs         ← 截图色差量测：水面 patch vs 周围影像海面（原生 zlib 解 PNG，零依赖）
├── _lod_check.cjs          ← LOD 量测：每像素覆盖的纹素数（判断三层法线滚动多远开始被 mipmap 抹平）
├── shot.png                ← 探针截图：默认 ocean 预设 / 低空掠射（菲涅尔 + 太阳光路）
└── under.png               ← 探针截图：水下 6 m 仰视 40°（触发水下效果）
```

打开方式：

* **看效果** —— 直接双击 `index.html` 即可（全部代码内联，仅需联网加载 Cesium CDN）。
  默认机位是「低空掠射 + 迎着太阳」，这是最能看出菲涅尔和太阳光路的角度。
* **接项目** —— `require` 或 `<script src="ue5-water-material.js">` 引入模块，调
  `Ue5Water.createWater(viewer, {...})`。
* 自检 —— `node _sync_inline.cjs --check`（内联副本是否与模块一致）→ `node _verify_glb.cjs`
  （静态检查）→ `node _render_probe.cjs`（真实渲染 + 截图，需要本机有 Chromium）。

> `index.html` 里 `/* ==BEGIN ue5-water-material.js== */ … /* ==END …== */` 之间是模块的内联副本，
> **不要手改**——改模块后跑 `node _sync_inline.cjs` 重新注入即可。

---

## 一、实现说明：Cesium 对比 UE5 SingleLayerWater 的局限点

UE5 的 SingleLayerWater 运行在**延迟渲染管线**里，它最大的底气来自 **SceneDepth + 场景颜色**：
拿到水面到水底/背景的深度差，就能算出真实水体厚度，于是折射、Beer–Lambert 吸收、
水体散射、岸边深度泡沫、SSR 反射全都是"有据可依"的物理量。

Cesium（WebGL / 前向渲染 / 单 Pass 模型）没有这些前提，所以下面这些**必须做近似或直接放弃**：

| UE5 SingleLayerWater 能力 | Cesium 可行性 | 本实现的处理 |
| --- | --- | --- |
| 屏幕深度采样 → 真实水体厚度 | ❌ 模型着色阶段拿不到 `SceneDepth` | 用**视角光程**近似：`opticalPath = uDepthScale / max(NdV, 0.12)`，掠射角看穿的水体更厚 |
| 折射（用深度重建水底并偏移采样） | ❌ 无法采样场景颜色 | 完全不做，靠 `uAbsorptionColor / uScatteringColor` 的颜色关系表达"通透感" |
| Beer–Lambert 吸收 | ⚠️ 只能近似 | `transmit = exp(-uAbsorptionColor * opticalPath)`，吸收色兼作吸收系数（见局限 3） |
| 体散射 Scattering | ⚠️ 只能近似 | `bodyColor = mix(uAbsorptionColor, uScatteringColor, luminance(transmit))` |
| SSR / 平面反射 / Reflection Capture | ❌ | 用**天空色梯度**近似反射：`mix(uHorizonColor, uSkyColor, ...)`，法线扰动的方向感仍能体现 |
| 岸边深度泡沫 / 漂浮物 | ❌ 无深度 | **不实现**，只在 README 说明；改为"浪峰斜率泡沫" |
| 水面下场景可见（水下透视） | ❌ 无场景颜色 | 不做，`material.alpha` 只控制整体通透度 |
| 阴影 / 接触阴影 | ❌ | 不做 |
| 屏幕空间焦散 | ❌ | 不做 |

### 具体受限点清单（写代码时会踩到的）

1. **不能采样屏幕深度**。因此整套"厚度"是几何假设出来的，不是量出来的 —— 摄像机贴近水面、
   或俯视浅水时，色调不会像 UE 那样真实变化。要真实厚度只能在 Cesium 里做**后处理**
   (`PostProcessStage`)，那时才有 `czm_globeDepthTexture` 可用，但那会脱离 `Model` 载体。

2. **没有反射来源**。UE 有 SkyLight / Reflection Capture / SSR 三层反射。这里只用天空色插值，
   所以水面不会反射岸上的物体 —— 这是视觉上最明显的差距。

3. **`AbsorptionColor` 语义被复用**。UE 里 Absorption 是一个"吸收系数"（单位 1/m），
   而需求里把它定义为"深水颜色"。本实现沿用了后者的语义：它既当颜色用，
   又通过 `exp(-color * pathLength)` 的指数衰减充当吸收强度。好处是所见即所得（调色即调色），
   代价是"物理正确性"打了折扣 —— 想更物理一点，可以把 `uAbsorptionColor` 调成
   `vec3(0.3, 0.06, 0.04)` 这类小数值（纯系数），再用 `uScatteringColor` 定调。

4. **模型阶段没有 `czm_normal` 的强保证**。所以片元端用
   `tangentEC / normalEC` 现场构造 TBN（等价于模型→眼空间旋转矩阵 `R`），
   并要求面片 glTF **必须带 `TANGENT`**。顶点端则在 `(T, N, B)` 正交局部基里解 Gerstner，
   彻底规避 Cesium 对 glTF Y-up 的转换细节（无论 `positionMC` 是 Y-up 还是 Z-up 都正确）。

   > ⚠️ **顶点端不要读 `vsInput.attributes.tangentMC`**。这是一个真实的 Cesium 陷阱，详见第六节。

5. **透明度必须走混合**。需求说"不要 Translucent，模拟 Opaque"，但 `alpha` 要控制通透度就必须混合。
   折中：glTF 材质设 `alphaMode: "BLEND"`，shader 内 `material.alpha = mix(uAlpha, 1.0, foam)`，
   默认 `uAlpha ≈ 0.97`（接近全不透明）。代价是水面不写深度缓冲，与其它半透明物排序时会露馅。

6. **`czm_frameNumber` 是帧计数不是时间**。动画严格按需求由它驱动：

   ```glsl
   float t = czm_frameNumber / 60.0;   // 按 60fps 折算成秒
   ```

   在 120Hz 屏幕上水面运动会比 60Hz 快一倍。若要严格锁定时长，改为传一个 JS 侧
   累加时间的 `uniform float uTime`（但那就不是"只靠 czm_frameNumber"了）。

7. **无 mipmap 的法线贴图会走样**。`Cesium.TextureUniform` 从 `typedArray` 创建纹理时
   默认 `LINEAR` 且不生成 mipmap。本实现用 `uFadeNear/uFadeFar` 在远处**淡出高频层**来压制走样，
   这是性能与质量的折中。

---

## 二、代码结构

### 1. 载体：`Model` 加载运行时生成的 glTF 面片

没有依赖任何外部模型文件：`buildPlaneGlb(segments, size)` 直接拼出一份合法的 **GLB**（glTF 2.0 binary）：

* 平面位于 glTF 的 **XZ 平面、法线 +Y**（glTF 标准 Y-up 的水平地面）；
* 属性：`POSITION / NORMAL / TANGENT(w=1) / TEXCOORD_0`，索引 `UNSIGNED_INT`；
* 材质：`alphaMode: "BLEND"`、`doubleSided: true`；
* Demo 默认 8000 m / 400 段（20 m 一格），最短顶点波 82 m，够 4 格不会欠采样。

```js
const glb = Ue5Water.buildPlaneGlb(400, 8000);          // 8 km × 8 km，约 7 MB
const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
const model = await Cesium.Model.fromGltfAsync({
  url,
  modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(center),
  customShader,
});
```

> Cesium 用**文件幻数 `glTF`**（`GltfJsonLoader.getMagic`）判断二进制 GLB，
> 而不是看 URL 后缀，所以 `blob:` URL 完全可用。

### 2. 顶点着色器：4 层 Gerstner（无循环）

```
位移      P += T·dT + N·dN + B·dB
水平位移  dT += Q·A·dx·cosθ ,  dB += Q·A·dz·cosθ      ← 让波峰变尖
垂直位移  dN += A·sinθ
解析法线  cross(∂P/∂b, ∂P/∂t)                        ← 不重复采样高度场
色散      ω = sqrt(g·k) · uGerstnerSpeed
```

4 层波的**方向 / 波长倍率 / 振幅权重**是硬编码常数（方向 4 个互不相同；
波长比 1 : 1/1.613 : 1/2.597 : 1/4.167，振幅权重 0.40/0.28/0.20/0.12），
只暴露 4 个总控 uniform —— 避免 uniform 爆炸。

切向量**从 `normalMC` 正交化推导**而不用 glTF 自带的 TANGENT——因为 Cesium 会把
顶点端的 `tangentMC` 声明成 `vec4`（glTF TANGENT 是 VEC4）而内部又是 `vec3`，
一旦引用就 `dimension mismatch` 编译失败。完整坑点见第七节。

### 3. 片元着色器：UE5 单层水近似

```
① 三层法线贴图滚动：粗/中/细 各自旋转(+36.9°/−26.6°)、各自铺贴与流速；
   粗层 UV 扰动中、细两层（domain warp），打散平铺重复图案
② 合成法线 = 顶点 Gerstner 波面法线 + 片元涟漪（细层随距离淡出）
③ V = -positionEC,  L = czm_sunDirectionEC
④ 菲涅尔  F = 0.0201 + 0.9799 · (1-NdV)^uFresnelPower     (IOR 1.33 → F0 = 0.0201)
⑤ 解析天空 sky = 天顶→地平线渐变 + 地平线雾带
              + 太阳盘 smoothstep(uSunDiscCos, +0.0004, dot(R,L))
              + 太阳辉光 pow(max(dot(R,L),0), uSunGlowPow)     ← 太阳光路
⑥ 吸收散射 bodyColor = mix(uAbsorptionColor, uScatteringColor, luminance(exp(-uAbsorptionColor·path)))
⑦ 高光 spec = I · (N·H)^specPow · mix(1, sqrt(1-(T·H)²), aniso)
   【高光 LOD】specPow = mix(uSpecularPowerFar, uSpecularPower, 细层淡出系数)
   —— 远处纹素被 mipmap 平均，高频法线没了，若仍用近处的锐利高光瓣就打不中任何
   波面斜率，太阳光路会糊成一片平滑白斑；随距离展宽高光瓣才出"随波闪动的宽带"。
⑧ 泡沫 foam = smoothstep(th, th+sharp, slope·(0.85+0.5·breakupNoise) + 0.30·crest)
   —— 以【法线坡度】为主（逐纹素、细碎），顶点波峰只做低频调制；20 m 顶点网格
   单靠 crest 出来的是一颗颗大圆包，不是白浪花。
⑨ out = mix(bodyColor, sky, F) + spec·uSunColor  →  mix(·, uFoamColor, foam)
```

### 4. 法线贴图：可平铺 value-noise FBM（不是正弦叠加）

第一版用整数频率正弦叠加高度场，结果是一张**规则网格**——这就是"水面反光均匀"的
直接原因之一。现在改为：

```
makeTileableHeightField(size, {seed, octaves, gridX, gridY, gain, ridge})
    lattice 用取模环绕 → 天生无缝可平铺
    gridX≠gridY 可做出各向异性的"风纹"
    ridge>0 把谷底折成尖脊，才有碎浪感
heightFieldToNormalData(h, size, targetSlope)
    环绕有限差分 → 归一化到最大倾角 → RGB 编码
makeWaterNormalUniform(size, opts)
    包成 Cesium.TextureUniform，并强制：
      minificationFilter = LINEAR_MIPMAP_LINEAR   ← Cesium 默认是 LINEAR（无 mipmap！）
      maximumAnisotropy  = 8                       ← Cesium 默认是 1（无各向异性！）
      repeat = true
```

> **采样器这一步是"均匀感"的另一主因**：水面几乎全程掠射观察，mipmap + 各向异性
> 缺任何一个，掠射角下的法线细节都会糊掉/闪掉，只能靠把 tile 放大到几百米来回避，
> 结果就是一层光滑光泽面。Cesium 的 WebGL2 纹理路径会在 `minificationFilter` 属于
> mipmap 家族时自动 `generateMipmap()`，`maximumAnisotropy` 也会在扩展可用时透传，
> 所以这两项可以放心开。

### 5. JS 侧统一入口

```js
const water = await Ue5Water.createWater(viewer, {
  preset: 'ocean',       // 'ocean' | 'lake'
  planeSize: 8000,       // 面片边长（米）
  segments: 400,         // 细分
  normalTexSize: 256,
  site: { lon: 125.0, lat: 28.0, height: 1.0 },   // 真实经纬度 + 海平面高度
});

water.setUniform('uGerstnerHeight', 3);    // 单参数
water.applyPreset('lake');                 // 整套预置

const underwater = Ue5Water.createUnderwater(viewer, { water });
underwater.setUnderwater(true);            // 入水（带 0.6 s 渐变）；相机入水也可自动触发
```

### 5.5 水下效果（对齐 UE5 的三段式分工）

水下被拆成三块各管一段，**职责划错就会翻车**（详见各条内的实测教训）：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 水面着色器（§10 水下块） | 斯涅尔窗/全反射、**太阳透光**、水下距离雾 | 画面级调色 |
| 后处理 `UNDERWATER_FRAGMENT_SHADER` | **太阳光柱**、色彩分级、暗角、折射扰动 | 距离雾（会翻车，见下） |
| `createUnderwater()` 场景态 | 背景/雾色、影像渐隐、隐藏天空 | —— |

**斯涅尔窗 + 太阳透光（水面着色器）**
- 窗：入射角 < 48.75°（sin=0.7519）折射看到天空，之外全反射看到暗水体，
  过渡带 `smoothstep(SIN_CRIT−0.14, SIN_CRIT+0.09)`；窗沿另有临界角"亮环"。
- **太阳透光**：把"眼→水面"视线按 `refract(水→空气, 1.333)` 折出去与太阳方向比对，
  对齐即太阳本体 + 贴盘辉光。波面法线抖动让它变成随波闪动的亮斑（真实水下就是这样）。
  曝光别给大：窗心一旦顶到纯白，后处理光柱会把整个窗区连带糊白（第一版 4.0/1.30 过曝实测）。

**太阳光柱 / god rays（后处理）**
- 光柱是沿**折射后的太阳方向**下行的平行光束，屏幕上汇聚到"水中的太阳视位置"。
- **太阳屏幕位置要做折射修正**：`sin(θ水)=sin(θ空气)/1.333`、方位角不变。低角度太阳时
  两者差得极远 —— 11° 仰角的真太阳，水中视位置在 42.6°。直接投影真太阳，光柱原点会
  跑到画面外甚至相机背后（实测 y=−0.57，光束全歪）。
- **原点钳在"扩展画面框"内（±0.6）**：太阳方位与视线夹角大时汇聚点会跑出画面，
  配合径向衰减 `exp(-len·uGodRayLength)`，衰减一陡（2.2）整片光束就被压没
  （实测太阳方位偏 50° 时光柱几乎不可见）。默认 0.8，够缓。
- 画法：以汇聚点为心取 `atan` 方位角 → **整数倍**正弦条纹（整数倍保证跨 ±π 接缝连续）
  → 低次幂（1.8，高了像镭射）收束成束 → 每根束乘一组整数倍谐波亮度（等距等亮像百叶窗）
  → 再乘 `surfBias`（画面上沿更强：抬头时上沿更贴近水面，光束像挂在水面下）
  + 低频摆动 + 空间噪声。
  第一版用"径向累加采样"（GPU Gems 3 式），光源一大就把半屏糊成奶雾，光束立不起来，已弃。
- 强度乘 `uGodRayUp`（视线·天顶）：越抬头窗越亮光柱越强，水平看时自动收敛。
- **demo 里入水会自动把太阳切到午后 45°（`SUN_UNDER`），上浮还原**：默认的傍晚低角度
  太阳折射后视位置正好在画面中央，光柱呈放射星芒；45° 太阳折射后在画面上部，
  光束才是自上而下垂下来的经典透光。

**入水切换是硬切（`fadeSeconds` 默认 0）**：入水是"穿过界面"的瞬时事件，做渐变
会被感知为"水面切换慢半拍"（用户实测反馈即延迟）。要柔和过渡再显式传 0.3~0.6。

**模式判定与观察侧要分开管（波峰波谷 ±uGerstnerHeight 的含糊区）**
- CPU 的"在不在水下"不能拿平均水面判：相机在波谷之上时若已切成水下模式，
  后处理把整幅画面压成水色、影像渐隐，而眼睛明明在水面上（实测：黑天 + 太阳光晕
  发绿 + 水面变无波平板）。所以模式只在**低于最深波谷**（`surface − uGerstnerHeight − 0.4`）
  时切入、回到波谷深度之上 0.6 m 才退出（迟滞防抖动）。
- 水面本身的观察侧由**着色器逐片元判定**：`dot(Ne, V)` 的符号（V 是"片元→眼睛"）。
  `underHere = max(uUnderwater, 侧测试)`——模式已水下时全部按水下模型；模式水上时，
  眼前比眼睛高的浪头背面（underside）也按水下模型画（全反射暗青色），否则近海面
  视角是一片平黑。这样水上/水下的过渡正好发生在视线掠过水面的那圈像素上。
- **天空不再隐藏**：深水下抬头视线几乎全被面片挡住，真实天空本来就看不见；
  而波谷/面片边缘这些"漏出天空"的角度，藏天空只会得到一整块黑，露出蓝天反而是
  自然的水天线。只渐隐影像 + 压 `globe.baseColor`。

**水下距离雾必须在水面着色器里做，不能进后处理**：水面是 `BLEND` 半透明材质不写深度，
后处理在水面上读到的深度是背后几百米外的天空/海底，雾会直接吃满、全屏糊成一色。

**后处理颜色是 sRGB 显示空间**（`scene.highDynamicRange` 默认 false），
水色一律 `hexToRgb01`；用 `hexToLinear` 会整幅暗一个数量级（实测全黑）。

**坑：Cesium 1.119 的 `scene.fog` 没有 `color` 属性**（只有 enabled/density/...），
`scene.fog.color.clone()` 直接抛错导致启动失败 —— 背景压暗用
`globe.baseColor` 渐变 + 影像层 alpha 渐隐 + 隐藏 skyAtmosphere/skyBox 实现，全部判空。

### 6. 融入真实场景（公开影像底图）

Demo 默认加载 **公开影像服务**（全部免 token，不再需要 Cesium ion）：

| key | 服务 | 说明 |
| --- | --- | --- |
| `esri-imagery` | Esri World Imagery | **默认**。全球卫星影像，`maximumLevel 19` |
| `esri-imagery-ref` | Esri 影像 + 地名 | 叠加 `World_Boundaries_and_Places` 标注层 |
| `esri-ocean` | Esri World Ocean Base | 海洋专题底图，`maximumLevel 13` |
| `osm` | OpenStreetMap | 街道图 |
| `none` | 关闭 | 纯色地球 |

全部走 `UrlTemplateImageryProvider`（一套 API 覆盖，注意 Esri 瓦片序号是 `{z}/{y}/{x}`，OSM 是 `{z}/{x}/{y}`）。

**把水面"贴进"真实场景的两个机制：**

1. **`uEdgeFade` · 边缘羽化** —— 面片四边最外圈（占边长比例，默认 0.06）alpha 渐隐到 0，
   8 km 面片溶解进下方的真实影像海面，而不是浮着一块生硬的方片。
   材质本来就是 `alphaMode: "BLEND"`，直接改 `material.alpha` 即可。
2. **`uHazeDensity` · 大气透视** —— Cesium 会给 globe 上的影像瓦片加 `scene.fog`（远处压向天色），
   而模型的 UNLIT CustomShader **不会**自动得到这层雾。不补上的话，拉远看时水面比周围
   影像更深更饱和，一眼就是"贴上去的方片"。用与 `czm_fog` 相同的二次型
   `1 - exp(-(d·ρ)²)` 补齐，默认 `2.5e-5`（3 km ≈1%、10 km ≈6%、15 km ≈13%）。

**Esri 占位片坑**：Esri 在没有影像数据的区域（远海、极地）不返回 404，而是返回一张固定的
"Map data not yet available" 灰色占位片，Cesium 会把它当真实影像铺上去 —— 近看全是文字。
已用 `tileDiscardPolicy` 按内容特征识别（浅灰 + 饱和度极低 + 有深色文字像素）并丢弃，
Cesium 自动改用上级瓦片放大插值。
注意别用"先取一张 z=22 的占位片当指纹"的方案：那个层级的响应**不带 CORS 头**，画布读像素会被拦。
误伤面：同时满足"亮 + 几乎无彩色 + 有暗像素"的真实影像基本只有云，丢弃后回退到上级瓦片（同一朵云），无感。

**局限**：远海在 Esri 只有低层级数据，高倍放大时海面底图是上级瓦片插值出来的平滑色块
（比真实卫星海图糊）；想看高分辨率海岸/岛屿请把 `site` 挪到近岸。

---

## 三、参数调优说明

### A. 对标 UE5 的核心参数

| Uniform | 类型 | 含义 | 调参直觉 |
| --- | --- | --- | --- |
| `uAbsorptionColor` | vec3 | **深水基色**（无限深时看到的水色） | 别给纯黑（会成死黑）。偏暗的蓝绿 `#07222e` 最像深海 |
| `uAbsorptionCoeff` | vec3 | **每米吸收系数**，对应 UE `AbsorptionCoefficients`，preset 里用数组 `[红,绿,蓝]` | **这是"水色随深度变化"的关键**。真实海水红光被吃得最快（~0.4/m）、蓝绿最慢（~0.04/m）→ 水呈青蓝。单位是 1/m，不是 0~1 的颜色 |
| `uAbsorptionStrength` | float | 吸收系数的总控倍率 | 面板上调这个就行。↑ 水更快变深变暗 |
| `uScatteringColor` | vec3 | **浅水散射色**，对应 UE `Scattering Color` | 明度高一点的天蓝/青绿。正视水面（浅）时看到的就是它 |
| `uFresnelPower` | float | 菲涅尔幂，Schlick 的指数 | ↑ 越大 → 只有极掠射才强反射，水面"更透"；↓ 越小 → 大面积泛白反光 |
| `uWaveSpeedLow/Mid/High` | float | 三层贴图滚动速度（**tile/秒**） | 换算米/秒 = speed × tileSize。三层方向、速度都要不同 |
| `uSpecularIntensity` | float | 太阳高光强度 | 1.0~2.0；配合 `uSpecularPower` 出"闪鳞" |
| `uFoamThreshold` | float | 泡沫阈值 | ↑ 越高泡沫越少；现配方以坡度为主，0.5~0.7 比较像真实白浪 |
| `uFoamColor` | vec3 | 泡沫颜色 | 略偏冷的白 `#eef7f5`，纯白会显得塑料 |

### B. 扩展参数

| Uniform | 默认(海洋) | 含义 |
| --- | --- | --- |
| `uDepthScale` | 6.0 | **参考光程（米）**。`光程 = uDepthScale / NdV`，掠射看穿的水更厚。ocean 4~8，湖泊 2~4 |
| `uCrestTranslucency` | 0.30 | **背光波峰透光**（UE 水面的标志性特征）：视线朝太阳时波峰透出亮青绿。0 = 关 |
| `uSkyForwardScatter` | 0.45 | 天空在太阳附近的**宽角前向散射**（shader 内 pow=20）。让反光有方向感；给大了整个反射面会冲成灰白 |
| `uNormalStrength` | 1.00 | 法线扰动总强度。↑ 波纹更"立体"，过大会出现油污感 |
| `uTilingLow/Mid/High` | 62/200/640 | 三层贴图在 8000 m 面片上的重复次数 → tile 129/40/12.5 m，texel 0.50/0.16/0.05 m |
| `uStrengthLow/Mid/High` | 0.42/0.60/0.38 | 三层各自权重。**粗层别给太高**，否则平铺图案暴露 |
| `uTilingSwell` | 10 | 涌浪层铺贴（tile = 8000/此值）。决定"大范围看"有没有波带 |
| `uStrengthSwellNear/Far` | 0.18/0.78 | 涌浪层近/远权重。远处给大才能撑住大范围明暗 |
| `uWaveSpeedSwell` | 0.030 | 涌浪层流速（tile/s） |
| `uBelowHorizonDark` | 0.70 | **反射落到地平线以下时混入"远海色"的比例**。远场明暗波带的最大来源（只压暗会得到死灰斑块，见 C3） |
| `uDomainWarp` | 0.35 | 用粗层 UV 扰动中/细层，消除平铺重复感。0.2~0.5 |
| `uFadeNear/Far` | 300/2000 | 细层随距离淡出的起止（米）。texel 世界尺寸越小，这个距离要越近 |
| `uSpecularPower` | 1200 | 近处高光锐度（Blinn-Phong 指数） |
| `uSpecularPowerFar` | 90 | **远处高光锐度（高光 LOD）**。太小会糊，太大会在远处变白斑，90~150 |
| `uSpecularAniso` | 0.60 | 各向异性拉伸量（沿切线拉长高光 → 闪鳞/鳞片感）。0 = 各向同性 |
| `uFoamSharpness` | 0.22 | 泡沫过渡带宽度。小 = 边界硬朗，大 = 朦胧 |
| `uAlpha` | 0.98 | 整体通透度（写进 `material.alpha`）。1.0 = 完全不透明 |
| `uEdgeFade` | 0.06 | **面片边缘羽化**（占边长比例）。最外圈 alpha 渐隐到 0，让面片溶解进下方真实影像。0 = 关（会出现生硬的方片边） |
| `uHazeDensity` | 2.5e-5 | **大气透视密度**，匹配 Cesium 给影像加的 `scene.fog`。二次型 `1-exp(-(d·ρ)²)`。调大了整片发白，0 = 关 |
| `uGerstnerHeight` | 1.8 | **Gerstner 总振幅（米）**，4 层按 0.40/0.28/0.20/0.12 分配 |
| `uGerstnerWavelength` | 340 | 基准波长（米），其余 3 层按等比缩短 |
| `uGerstnerSteepness` | 0.85 | 陡度 Q。0.7~0.9 波峰尖锐；>1.0 且振幅大时会出现自交穿模 |
| `uGerstnerSpeed` | 1.0 | 相速度倍率（乘在深水色散关系 ω=√(gk) 上） |
| `uSkyColor` / `uHorizonColor` | — | 反射近似用的天顶/地平色 |
| `uHorizonHaze` / `uHorizonHazeStrength` | 0.45 | 地平线那条亮雾带（没有它天空反射就是"两色插值"，很假） |
| `uSkyGradientPow` | 0.55 | 渐变幂。<1 时地平线更亮更宽 |
| `uSunColor` | — | 太阳/高光染色，偏暖的 `#fff2d8` 更像低角度阳光 |
| `uSunDiscCos` | 0.9996 | 太阳盘角半径（越接近 1 盘越小） |
| `uSunDiscIntensity` | 3.0 | 太阳盘亮度（镜面里的太阳像） |
| `uSunGlowIntensity` / `uSunGlowPow` | 0.45 / 260 | 太阳光路的宽度与亮度。**别给太大**，否则地平线附近整片泛白 |

### B2. 水下参数（两套命名空间，别调错对象）

**水面着色器（`water.setUniform`）—— "从下方看水面"的模型：**

| Uniform | 默认 | 含义 |
| --- | --- | --- |
| `uUnderwater` | 0 | 0/1 渐变量。相机入水时由 `createUnderwater` 自动写入，一般不用手动调 |
| `uUnderFogDensity` | 0.045 | 水下光程衰减（1/m），能见度约 40~60 m。**必须在水面着色器里做**（水面不写深度，进后处理会全屏糊死） |
| `uUnderMaxFog` | 0.96 | 水下雾上限，保留一点窗区可见度 |
| `uUnderDeepColor` | `#0d3b4d` | 远处水体收敛色（线性空间） |

**后处理（`underwater.setUniform`）—— 画面级：**

| Uniform | 默认 | 含义 |
| --- | --- | --- |
| `uShallowColor` | `#2f7f96` | 水下画面基调（sRGB，**不要**用线性色，会整幅暗一个数量级） |
| `uVignette` | 0.40 | 暗角（水下视野收窄的暗示） |
| `uDistortion` | 0.0016 | 水体晃动的折射扰动幅度 |
| `uGodRayIntensity` | 1.20 | **太阳光柱总强度**。0 = 关 |
| `uGodRayCount` | 14 | 光束数量（着色器内取整；非整数会有 ±π 接缝） |
| `uGodRayLength` | 0.8 | 光柱径向衰减。**给大了光柱只聚在太阳附近**，太阳偏出画面光束就整片消失 |

`uSunScreen`（折射修正后的太阳屏幕 UV）与 `uGodRayUp`（抬头程度）由
`createUnderwater` 每帧自动计算写入，不用手动调。

### C. 铺贴尺度怎么定（最容易调错的地方）

`uTiling*` 是"整块 8000 m 面片上铺几遍"，于是

```
texel 世界尺寸 = 8000 / (uTiling × 256)
```

掠射角下 mipmap + 各向异性(8×) 大约能扛 **8:1** 的压缩，再细就会摩尔纹/闪。
所以 texel 应压在 **0.05 ~ 0.5 m** 这一档，而不是一味调大 `uTiling`：

| 层 | uTiling | tile | texel | 作用 |
| --- | --- | --- | --- | --- |
| 涌浪 | 10 | 800 m | 3.1 m | 大尺度波带（远处淡出后由它接手） |
| 粗 | 62 | 129 m | 0.50 m | 涌浪明暗 |
| 中 | 200 | 40 m | 0.16 m | 主波纹 |
| 细 | 640 | 12.5 m | 0.05 m | 近处碎波（远处淡出） |

涌浪层的权重是**随距离增大**的（近 0.18 → 远 0.78）：细层淡出时必须把权重交给粗层，
否则远处总法线方差越来越小，整片海就"越远越平"——这是"大范围看不行"的第二个原因。
近处靠高频碎波、远处靠低频波带，法线总能量大致守恒，不会出现"细节悬崖"。

第一版把 `uTilingHigh` 开到 4000（texel 8 mm），结果远场全是规则菱形网格纹 —— 那是
过度 minification 的摩尔纹，不是波。

### C2. 水色为什么曾是一片平色（第二大的坑，也是"像不像 UE"的分水岭）

第一版把 `uAbsorptionColor`（深水基色，近似黑）**直接当吸收系数**用：

```
transmit = exp(-uAbsorptionColor × opticalPath)
```

问题在于深水基色的线性值只有 ~0.0015~0.026，作为"每米系数"它约等于 0，于是
`exp(-0.002 × 光程) ≈ 1` —— 实测整段视角范围内 `thinness` 只在 **0.96 ~ 0.90** 之间摆动，
`bodyColor` 基本恒等于散射色。**水色和深度/视角完全无关，整片水就是一块平色**，
这就是"跟 UE 差很多"的主要来源。

修正：把吸收系数独立出来，用真实量级（UE 的 `AbsorptionCoefficients` 就是 1/m）：

```
transmit = exp(-uAbsorptionCoeff × uAbsorptionStrength × opticalPath)
```

ocean 取 `[0.42, 0.085, 0.045]`（红光每米被吃掉 42%，蓝绿只吃 4.5% → 水自然呈青蓝）。
同样视角范围下 `thinness` 变成 **0.47 → 0.018**，25 倍动态范围：

| NdV | 光程 | thinness | 水色 |
| --- | --- | --- | --- |
| 0.90 | 6.7 m | 0.472 | 偏散射色（青，近/正视） |
| 0.50 | 12.0 m | 0.301 | 过渡 |
| 0.30 | 20.0 m | 0.160 | 明显偏深 |
| 0.12 | 50.0 m | 0.018 | 深水基色（暗蓝绿，掠射） |

近处偏青、远处沉暗 —— 这层梯度就是 UE 水面"有厚度"的原因。

### C3. 大范围为什么曾经"一片平"（第三个坑）

两个原因叠加：

1. **反射落到地平线以下被当成天空**。掠射时 `fresnel≈1`，画面几乎全是"反射的天空"。
   波面倾斜会让反射方向在"地平线以上/以下"之间大幅摆动 —— 朝上是亮天空，朝下是
   **远处的海面（暗的）**。旧代码用 `clamp(elev, 0, 1)` 把后者也算成地平线亮带，
   于是远场只剩一条平滑亮渐变，波面的明暗对比全丢。补 `uBelowHorizonDark`
   之后，远场立刻出现大片明暗波带。
   **但注意"压暗"是个坑（v13 教训）**：只是把亮色天空 `× 0.30` 得到的是**中灰**，
   不是暗海 —— 这类背坡面片 NdV 小、菲涅尔权重高，灰色被放大成大片平灰斑块
   （实测用户截图）。正确做法是往"远海色"（`uAbsorptionColor` 方向的暗青蓝）
   **混合**：`reflCol = mix(sky, farSea, belowT * uBelowHorizonDark)`。
   明暗对比不变，色调从死灰变回暗海。

2. **跨尺度能量不守恒**。细层在 2 km 处淡出，但没有把权重交给粗层，
   远处总法线方差趋近 0 → 越远越平。加涌浪层并让它的权重随距离**增大**
   （近 0.18 → 远 0.78）即可补上。

判据（可用 `node _lod_check.cjs` 复算）："一个最大特征在屏幕上还有几个像素"：
粗层 32 m 特征在 2 km 还有 16 px、8 km 还有 4 px —— 结构本来就在，
只是被上面两条压住了。

### D. 调参顺序建议

1. **先定吸收**：`uAbsorptionCoeff`（每米系数，决定水色随深度怎么变）→ `uAbsorptionStrength`（总强度）→ `uDepthScale`（参考光程）。
2. **再定颜色**：`uAbsorptionColor`（无限深的水色，别给纯黑）→ `uScatteringColor`（浅水色）。
3. **再定法线**：按 C 节定 `uTilingLow/Mid/High` → `uStrengthLow/Mid/High` → `uDomainWarp` 消平铺。
4. **然后 Gerstner**：`uGerstnerHeight` 定浪高 → `uGerstnerWavelength` 定波长 → `uGerstnerSteepness` 定波峰尖锐度。
5. **最后高光与泡沫**：`uSpecularPower` + `uSpecularPowerFar`（近/远锐度）→ `uSpecularIntensity` → `uSpecularAniso` → `uSkyForwardScatter` → `uSunGlow*` → `uFoamThreshold`。
6. **看太阳光路请把相机对着太阳**：Demo 默认 `太阳时刻 10.25 UTC`（当地 18:15，低角度）+
   `相机朝向 295°`。背对太阳时菲涅尔反射的只是天空渐变，看不出光路——那不是 bug。

> 完整预置参数见 `ue5-water-material.js` 里的 `PRESETS`（Demo 面板可实时调）。

### E. 波浪运动速度怎么控制（两层系统 + 一个总控）

水面上有两套**互相独立**的运动，控制它们的参数也不同：

**① 顶点 Gerstner 波 —— 真实的几何位移（浪本身在动）**

```
相位   θ = k·(dir·p) − ω·t ,   ω = sqrt(g·k) · uGerstnerSpeed
相速度 c = ω / k = sqrt(g·λ / 2π) · uGerstnerSpeed
```

* `uGerstnerSpeed` —— 相速度倍率，直接缩放所有 4 层波的速度（ocean 默认 1.0）。
* `uGerstnerWavelength` —— 基准波长。注意深水色散下**波长越长波跑得越快**（c ∝ √λ），
  所以改波长会同时改变速度，这是物理正确的行为。

ocean 预置（`uGerstnerWavelength=340`，`uGerstnerSpeed=1.0`）各层的实际数值：

| 层 | λ | 周期 T | 相速度 c | 振幅 |
| --- | --- | --- | --- | --- |
| A | 340.0 m | 14.76 s | 23.04 m/s | 0.72 m |
| B | 210.8 m | 11.62 s | 18.14 m/s | 0.50 m |
| C | 130.9 m | 9.16 s | 14.30 m/s | 0.36 m |
| D | 81.6 m | 7.23 s | 11.29 m/s | 0.22 m |

**② 片元法线贴图滚动 —— 细节纹理的平移（波纹细节在动）**

```
世界速度 = uWaveSpeed× × tileSize ,   tileSize = planeSize / uTiling×
```

ocean 预置（planeSize 8000）：

| 层 | uTiling | tileSize | uWaveSpeed | 世界速度 |
| --- | --- | --- | --- | --- |
| 粗 | 62 | 129.0 m | 0.003 tile/s | 0.39 m/s |
| 中 | 200 | 40.0 m | 0.018 tile/s | 0.72 m/s |
| 细 | 640 | 12.5 m | 0.088 tile/s | 1.10 m/s |

**③ `uTimeScale` —— 整体快慢的总控（推荐先动这个）**

```
t = uTime × uTimeScale
```

它**同时**缩放顶点 Gerstner 相位和三层法线贴图的滚动，所以"整体快慢"只需要动一个旋钮；
分层比例仍由上面的参数决定。`0` = 完全静止（对比调参/截图最好用），`2` = 两倍速。
Demo 面板第一组「运动速度」里就有这个滑杆，另有「暂停波浪」按钮。
代码里对应 `water.setTimeScale(0)` / `.pause()` / `.resume()`。

**④ 帧率耦合（重要）**

动画时间**不是** `czm_frameNumber / 60`。那样写速度会和真实帧率耦合——
30 fps 的水波只有一半快，144 fps 是 2.4 倍，换台机器速度就变了。
本实现由 `createWater` 在 `scene.preUpdate` 里**每帧写入墙钟秒数** `uTime`
（UE5 用的也是 `uTime`），所以速度与帧率无关。只有在需要与 Cesium 帧序列严格同步时才传
`timeSource: 'frame'` 退回旧行为。

**⑤ 方向**

波的方向目前是 shader 里的硬编码常数（顶点 `dirA..dirD` 4 个互不相同的方向；
片元 `d0/d1/d2` 3 个滚动方向）。想让所有波"顺着风向"需要把这些常数改成由
`uWindDir`（vec2，角度）旋转得到——目前没做，因为一旦引入"统一风向"，4 层同向反而
会显得假；真实海面是不同波长成分朝不同方向传播的。

---

## 四、性能说明

* shader 内**零循环**（4 层 Gerstner 手动展开）；
* 每个片元 4 次纹理采样（3 层法线 + 1 次泡沫破碎）+ 若干 `pow/sqrt`，无 `for`、无噪声函数、无屏幕空间采样；
* 顶点端 4 层波 × 2 个切向量 = 固定开销，160 k 顶点；
* `lightingModel: UNLIT` 跳过 Cesium 的 PBR 与 IBL，光照全部自算；
* 细层按距离淡出，远端几乎只付粗/中两层的代价。

---

## 五、已知问题 / 后续可做

* 水面不写深度缓冲（`alphaMode: BLEND`），与其他半透明物混合顺序可能出错；
  若能接受完全不透明，把 glTF 材质改成 `alphaMode: "OPAQUE"` 并令 `uAlpha = 1.0`。
* 无法反射岸上物体 —— 需要真实反射的话，可在 Cesium 里另加一个
  `Camera` + `RenderTexture`（平面反射）或后处理 SSR，两者都超出 `Model + CustomShader` 的范围。
* 动画时间已与帧率解耦：`uTime` 由 `createWater` 每帧写入墙钟秒数，`uTimeScale` 控制
  全局倍率（见第三节 E）。若要手动接管，传 `timeSource: 'frame'` 或自己写 `uTime`。
* 泡沫仍是"斜率阈值"近似，没有 UE 那种沿波峰拉长的条状白浪（那需要逐像素的波形相位，
  或者把 Gerstner 位移再在片元端算一遍）。
* 垂直正下方看水面会"没有波纹"——这是物理正确的：正下方菲涅尔只剩 ~2%，太阳镜面几何
  也对不上。想检查波纹请用 -35° 左右的高斜视角（Demo 的「俯视视角」按钮就是这个角度）。

---

## 六、排障：卡在"正在生成水面几何体与法线贴图…"

`index.html` 已内置**启动进度上报**（写入 `window.__diagItems` + 浏览器控制台）+ **看门狗**
（每 5 秒把当前步骤写到屏幕中央），任何一步失败都会显式报错，不再无声卡住。
失败出口有三个：顶部红色横幅（`#bootErrors`）、屏幕中央状态（`#status`）、浏览器控制台
（`console.log` 的 `[step]` / `[step ✘]` 行）。启动进度会依次记录：

```
① 加载 CesiumJS (1/3 · cdn.jsdelivr.net)   ← 多 CDN 自动回退：jsdelivr → unpkg → 1.120
② 检查运行环境                              ← 必须是 WebGL2
③ 创建 Cesium 场景
④ 水面：生成四层法线贴图（可平铺 FBM + mipmap）/ 构建 CustomShader /
        生成 glTF 面片 / 加载 Model（glTF 解析 / GPU 上传）/ 加入场景
⑤ 首帧渲染
```

### 常见卡住位置与原因

| 卡在哪一步 | 可能原因 | 处理 |
| --- | --- | --- |
| ① 加载 CesiumJS | CDN 被墙 / 断网 | 三个源都失败会弹出顶部红色横幅；可把 `Cesium.js` 下载到本地，改成本地路径 |
| ② 检查运行环境 | 浏览器不支持 WebGL2 | 换新版 Chrome / Edge；检查 `chrome://gpu` |
| ④ 加载 Model | `CESIUM_BASE_URL` 指向的 Worker 目录取不到 | 确认该 CDN 可用；或改用本地部署 |
| ④ 之后黑屏 | 着色器编译失败 | 会经 `scene.renderError` 弹顶部红条 + 打印到控制台 |
| 加载底图(ion) | token 失效 / ion 不通 | **不影响水面**；已加 15 秒超时，失败仅提示 |

### 关键修复

旧版 `index.html` 在**创建水面之前**就 `await Cesium.IonImageryProvider.fromAssetId(2)`，
一旦 ion 请求悬挂（网络不通、token 失效），整个启动链就停在这里 —— 这正是"一直卡住"的根因。
新版把底图改成**按钮按需加载**，水面创建不再依赖任何 ion 网络请求。

### 完全离线运行

把 CDN 的 `Build/Cesium/` 整个目录放到本地（例如 `./Cesium/`），然后：

```html
<script>window.CESIUM_BASE_URL = './Cesium/';</script>
<script src="./Cesium/Cesium.js"></script>
```

并删除/跳过 `loadCesium()` 的多 CDN 逻辑即可（注意 Worker、Assets 也要一并拷贝）。

### 无头渲染探针 `_render_probe.cjs`

静态检查只能保证 JS 语法和 GLSL 的"文本形态"没问题；Cesium 会在运行时把 CustomShader
拼进它自己的模板，真正的编译结果只有 GPU 知道。这个脚本用本机 Chromium（SwiftShader
软件渲染）真的把页面跑起来：

```bash
node _render_probe.cjs                       # 默认 ocean / 掠射视角 → shot.png
node _render_probe.cjs --top                 # 俯视视角
node _render_probe.cjs --scene               # 场景视角（拉远看面片与真实影像的衔接）
node _render_probe.cjs --preset lake         # 换预设
node _render_probe.cjs --hour 10.25 --heading 295   # 调太阳时刻 / 相机朝向
node _render_probe.cjs --basemap esri-ocean  # 切底图（esri-imagery/esri-imagery-ref/esri-ocean/osm/none）
node _render_probe.cjs --underwater --out under.png   # 潜水视角（水下 6 m 仰视 40°，自动触发水下效果）
node _render_probe.cjs --uniform uHazeDensity=3e-5  # 覆盖任意 uniform（可重复传，调参扫描用）
node _render_probe.cjs --timescale 0 --motion-check # 验证暂停是否生效（0=静止，1/2=倍速）
node _render_probe.cjs --keep-ui --ui-check  # 保留面板并做 HUD 折叠按钮冒烟测试
```

截图前会先等 `scene.globe.tilesLoaded`（至多 12 s）——底图是异步瓦片流，不等它的话
每次运行抓到的加载进度不同，截图和色差测量都不可比。
配套的 `_tone_check.cjs <png>...` 量测截图里「水面 patch」与「周围影像海面」的平均色差，
是判断"融入效果"的量化依据（24 bit PNG 解码用原生 zlib + 自写行过滤，零依赖）。
`--motion-check` 会间隔 2.5 s 截两张，把图丢回页面里降到 32×18 求平均亮度差——
**不能用"PNG 字节是否相同"判断**：任何亚像素变化（连 Cesium 太阳的缓慢移动）
都会改变压缩流，必须用像素级签名才能区分"真的没动"和"动得看不出来"。
调参时反复跑它比肉眼看浏览器快得多，而且可以把两版截图并排对比。

**坑：探针里用 `--eval` 里的 `camera.setView` 瞬移后，水面可能空白/只剩 globe 几秒** ——
软渲染（SwiftShader）在瞬移后要重建管线/等瓦片，是探针伪影不是产品 bug（用户真 GPU 上
交互路径正常）。要挪相机请用 `camera.lookAt(center, HeadingPitchRange)` + `lookAtTransform(IDENTITY)`，
或模拟滚轮 `camera.zoomIn(n)`；`--eval` 已支持 `awaitPromise`，表达式里可 `await new Promise(r=>setTimeout(r,500))`
等状态（如入水切换）生效后再读，同步读是旧值。

---

## 七、踩坑记录：CustomShader 顶点输入里的 `tangentMC` 是 `vec4`

**症状**（由 `scene.renderError` 捕获，会弹顶部红条并打印到控制台）：

```
Vertex shader failed to compile. Compile log:
ERROR: 0:118: '=' : dimension mismatch
ERROR: 0:118: 'assign' : cannot convert from 'highp 3-component vector of float' to 'highp 4-component vector of float'
ERROR: 0:35: '=' : dimension mismatch
ERROR: 0:35: '=' : cannot convert from 'highp 4-component vector of float' to 'highp 3-component vector of float'
```

**原因**（读 Cesium 1.119 构建产物定位）：

1. `ModelUtility.getAttributeInfo()` 里 `glslType = getGlslType(attribute.type)` —— **取自 glTF 访问器类型**。
   glTF `TANGENT` 访问器是 `VEC4`，所以 `tangentMC` 的 glslType 是 `vec4`。
   （`color_N` 会被特判成 vec4，`tangent` 没有这个特判。）
2. `CustomShaderPipelineStage.$Ue()` 把这个 glslType 直接写进自定义着色器的顶点输入结构体：

   ```glsl
   struct Attributes {
     vec3 positionMC;
     vec3 normalMC;
     vec4 tangentMC;   // ← 陷阱在这里
     vec2 texCoord_0;
   };
   ```

3. 但 Cesium 内部 `ProcessedAttributes.tangentMC` 是**硬编码的 `vec3`**
   （见 `_ke()` / `Ske()`：`attributes.tangentMC = a_tangentMC.xyz;`，`w` 分量另存为 `tangentSignMC`）。
4. 于是自动生成的初始化语句自相矛盾：`vsInput.attributes.tangentMC = attributes.tangentMC;` → `vec4 = vec3`。
5. 同时自己的代码 `vec3 Tm = normalize(vsInput.attributes.tangentMC);` → `vec3 = vec4`。

两个错误，同一个根因。**片元端不受影响**，因为 `dse()` 在片元路径里显式把 `tangentEC` 强制成 `vec3`：

```js
n && o === "tangentMC" && (s = "tangentEC", r.glslType = "vec3")
```

**结论 / 正确写法**：顶点端**只读 `positionMC` / `normalMC` / `texCoord_N`**（三者都是 vec3/vec2），
切向量改用已知约定或由 `normalMC` 正交化推导：

```glsl
vec3 Nm = normalize(vsInput.attributes.normalMC);
vec3 Tm = normalize(vec3(1.0, 0.0, 0.0) - Nm * Nm.x);   // 面片为 XZ 平面，切向 +X
vec3 Bm = normalize(cross(Tm, Nm));
```

**glTF 里仍然要保留 `TANGENT` 属性** —— 片元端的 `tangentEC` 依赖它，删掉会让 `dse()` 走进
"缺失属性"分支，退化成常量 `vec3(1.0, 0.0, 0.0)`（眼空间常量，是错的）。

**回归护栏**：`_verify_glb.cjs` 每次都会复现 Cesium 的扫描逻辑，
检查两份着色器真正"登记"到的属性是否都在白名单内，并校验 `index.html` 内联副本与
`ue5-water-material.js` 完全一致。

### 7.1 续集：注释里的属性名也会被算进去（最容易漏的一环）

按上面的结论把顶点端改成不读 `tangentMC` 之后，**只剩一个错误**了：

```
0:118: cannot convert from highp 3-component vector of float to highp 4-component vector of float
```

也就是 Cesium 自动生成的那句 `vec4 tangentMC = vec3 tangentMC` 还在 —— 说明**还是扫到了 `tangentMC`**。

原因在 Cesium 的属性扫描实现里（`CustomShader` 内部）：

```js
const re = /[vf]sInput\.attributes\.(\w+)/g;
function DS(text, re, set) {           // 就是对原始文本跑正则
  let m;
  while ((m = re.exec(text)) !== null) set[m[1]] = true;
}
// vertexShaderText / fragmentShaderText 原样丢进去，不剥注释、不做词法分析
```

**它连注释一起扫。** 而我为了解释这个坑，在着色器注释里原样写了一句
`vsInput.attributes.tangentMC = attributes.tangentMC;` —— 于是 `tangentMC` 又被登记了一次，
Cesium 照样生成 `vec4 tangentMC`，错误原封不动。

> **教训**：在 Cesium `CustomShader` 的 GLSL 文本里，**注释不是"安全区"**。
> 只要出现 `vsInput.attributes.X` / `fsInput.attributes.X` 这个形状的字符串，
> 就会真的改变编译结果。写文档式注释时，把前缀省掉（只写 `tangentMC`），
> 或者改写成 `attributes` + 空格 + 名字的形式。

**护栏也相应升级**：`_verify_glb.cjs` 现在不"剥注释后再检查"（那样正是漏检的原因），
而是用 Cesium 的同一条正则对原始文本扫描，并且额外检查注释行里是否出现了会被登记的形状：

```
[Cesium扫描] 顶点着色器登记到的属性: positionMC, normalMC
[Cesium扫描] 片元着色器登记到的属性: texCoord_0, tangentEC, normalEC, positionEC
[Cesium扫描] 注释中无属性引用: OK
```



