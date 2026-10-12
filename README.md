# UE5 SingleLayerWater 近似 · Cesium CustomShader 高性能水面

用 Cesium `CustomShader` + `Model`（glTF 面片）复刻 UE5 `SingleLayerWater` 的单层水视觉：
菲涅尔、水体吸收/散射、四层法线滚动（涌浪 + 粗/中/细）、Gerstner 顶点波、太阳高光闪鳞、
浪峰泡沫，以及带光柱/斯涅尔窗的水下效果。另内置 **Frostbite 物理大气**
（Hillaire 2020：transmittance / multi-scattering 双 LUT 天空 + 物理气透视，
水面反射与天穹共享同一套物理）。
纯 Web 端实现，**零第三方依赖**，双击即用。

![掠射视角：菲涅尔 + 太阳光路 + 物理大气](screenshots/01-sun-glare.png)

## 效果预览

以下均为 `_render_probe.cjs` 无头渲染实拍，无后期处理。

| 掠射 · 太阳光路 | 俯视 · 波场与闪鳞 |
| --- | --- |
| ![](screenshots/01-sun-glare.png) | ![](screenshots/02-wave-field.png) |

| 水下 · 光柱与距离雾 | 湖泊预设 |
| --- | --- |
| ![](screenshots/04-underwater.png) | ![](screenshots/05-lake.png) |

| Frostbite 大气 · 晨昏天光 | Frostbite 大气 · 水下 |
| --- | --- |
| ![](screenshots/08-frostbite-sky.png) | ![](screenshots/09-frostbite-under.png) |

## 快速开始

**看效果** —— 直接双击 `index.html`（全部代码内联，仅需联网加载 Cesium CDN）。
默认机位是「低空掠射 + 迎着太阳」，最能看出菲涅尔和太阳光路。

**接入项目** —— 引入 `ue5-water-material.js` 后调统一入口：

```js
// 可选但推荐：先建物理大气，再建水面 —— 水面要共享大气的 uniform，
// 反射 / 气透视 / 水下斯涅尔窗才能与天穹色调严格一致
const atmosphere = await Ue5Water.createAtmosphere(viewer, {
  site: { lon: 125.0, lat: 28.0, height: 1.0 },   // 地面半径取该点地心半径
  exposure: 40,                                   // 天空整体亮度总控
});

const water = await Ue5Water.createWater(viewer, {
  preset: 'ocean',        // 'ocean' | 'lake'
  planeSize: 8000,        // 面片边长（米）
  segments: 400,          // 细分
  normalTexSize: 256,
  site: { lon: 125.0, lat: 28.0, height: 1.0 },   // 经纬度 + 海平面高度
  atmosphere,             // 传入后水面走物理天空反射 + 物理气透视；不传 = 解析天空
});

water.setUniform('uGerstnerHeight', 3);   // 单个参数
water.applyPreset('lake');                // 整套预置
water.setTimeScale(2);                    // 整体快慢（0 = 静止）
water.pause();  water.resume();           // 暂停 / 继续

atmosphere.setEnabled(false);             // A/B：一键退回解析天空 + Cesium 天穹
atmosphere.setUniform('uAtmoExposure', 60);

// 可选：水下效果（相机入水会自动触发，也可手动切）
const underwater = Ue5Water.createUnderwater(viewer, { water });
underwater.setUnderwater(true);           // 入水（setUnderwater(false) 出水）
```

大气失败会自动降级：天穹退回 Cesium 自带，水面退回解析天空，启动链不中断。

## Demo 页面操作

- **参数面板（HUD）**：预设切换、太阳时刻、相机机位、全部 uniform 滑杆，右上角可折叠。
- **物理大气**：面板「Frostbite 物理大气」勾选框 = `setEnabled` 开关（A/B 对比），
  「大气曝光」滑杆 = `uAtmoExposure`。太阳时刻滑杆同时驱动物理大气的太阳方向。
- **底图**：公开影像服务（Esri 卫星 / OSM），**无需 Cesium ion token**；底图加载失败不影响水面。
- **波浪速度**：面板「运动速度」滑杆就是 `uTimeScale`，另有「暂停波浪」按钮。

## 常用参数速查

完整参数表与推导见 [docs/DEVNOTES.md](docs/DEVNOTES.md)。

| Uniform | 作用 |
| --- | --- |
| `uAbsorptionCoeff` / `uAbsorptionColor` | 每米吸收系数 + 深水基色 → "水色随深度变化"的关键 |
| `uScatteringColor` | 浅水散射色（正视水面时看到的颜色） |
| `uGerstnerHeight` | 浪高（Gerstner 总振幅，米） |
| `uTimeScale` | 动画整体快慢总控（0 = 静止） |
| `uSpecularIntensity` / `uSpecularAniso` | 太阳高光强度 / 各向异性拉伸（闪鳞感） |
| `uFoamThreshold` | 浪峰泡沫阈值（越高泡沫越少） |
| `uAlpha` | 整体通透度 |
| `uEdgeFade` | 面片边缘羽化，让水面溶进下方真实影像 |
| `uAtmoExposure` | 物理大气曝光（天穹 + 水面反射 + 气透视同步生效） |

**波浪速度分两层**：`uGerstnerSpeed` 控制顶点浪的相速度，`uWaveSpeedLow/Mid/High`
控制法线纹理滚动；"整体快慢"只用动 `uTimeScale` 一个旋钮。

## 自检与调试

```bash
node _sync_inline.cjs --check    # index.html 内联副本是否与模块一致
node _verify_glb.cjs             # 静态自检：语法 / Cesium 属性 / glb 结构 / 法线贴图
node _atmosphere_check.cjs       # 大气 LUT 数值自检：Chapman 解析解对齐 + PNG 导出
node _render_probe.cjs           # 无头渲染：真跑页面 + 编译日志 + 截图（需本机 Chromium）
```

探针常用机位 / 参数：

```bash
node _render_probe.cjs                    # ocean 预设 / 掠射视角 → shot.png
node _render_probe.cjs --top              # 俯视视角
node _render_probe.cjs --preset lake      # 湖泊预设
node _render_probe.cjs --underwater       # 水下 6 m 仰视
node _render_probe.cjs --hour 10.25 --heading 295   # 太阳时刻 / 相机朝向
node _render_probe.cjs --basemap none     # 底图（esri-imagery / esri-ocean / osm / none）
node _render_probe.cjs --uniform uHazeDensity=3e-5  # 覆盖任意 uniform（可重复传）
```

> ⚠️ `index.html` 里 `/* ==BEGIN ue5-water-material.js== */ … /* ==END …== */` 之间是模块的
> 内联副本，**不要手改** —— 改完模块跑 `node _sync_inline.cjs` 重新注入。

## 目录结构

```
ue5-water-customshader/
├── index.html              ← 单文件完整 Demo（双击即开）
├── ue5-water-material.js   ← 模块版：可直接接入现有项目
├── screenshots/            ← 效果截图（本 README 引用）
├── docs/
│   └── DEVNOTES.md         ← 实现细节 / 参数推导 / 踩坑记录（开发向）
├── _sync_inline.cjs        ← 模块 → index.html 内联块同步
├── _verify_glb.cjs         ← 静态自检
├── _atmosphere_check.cjs   ← 大气 LUT 数值自检（Chapman 对齐 / 地平线连续性 / PNG）
├── _render_probe.cjs       ← 无头渲染探针（截图 / 编译日志 / 运动检测）
├── _tone_check.cjs         ← 截图色差量测（零依赖）
└── _lod_check.cjs          ← LOD 量测：每像素纹素数
```

## 已知局限

Cesium（WebGL / 前向渲染 / 单 Pass 模型）拿不到屏幕深度与场景颜色，因此
折射、真实水体厚度、SSR / 平面反射、岸边深度泡沫等 UE5 能力**无法直接实现**，
本实现用视角光程近似吸收/散射；反射默认走 Frostbite 物理天空（可 A/B 退回解析梯度）。
逐条受限点分析与绕法见 [docs/DEVNOTES.md](docs/DEVNOTES.md) §一。

## 排障速查

启动链内置进度上报 + 看门狗（每 5 秒报告当前步骤），失败会显式报错而非无声卡住：

| 现象 | 处理 |
| --- | --- |
| 卡在「加载 CesiumJS」 | CDN 不可达：换网络，或把 `Build/Cesium/` 下载到本地部署（见 DEVNOTES §六） |
| 卡在「检查运行环境」 | 浏览器不支持 WebGL2：换新版 Chrome / Edge，检查 `chrome://gpu` |
| 着色器编译报错（顶部红条） | 看控制台 `[step ✘]` 行；先跑 `node _verify_glb.cjs` 静态排查 |
| 天空全黑 / 天穹被雾盖住 | 确认未手动改 `scene.fog`；天穹依赖"包围球跟随相机"避开模型雾（createAtmosphere 内部处理） |
| 底图不显示 | 不影响水面；Esri/OSM 瓦片服务偶尔限流，稍后重试或切底图 |
