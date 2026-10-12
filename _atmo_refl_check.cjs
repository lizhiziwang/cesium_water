// _atmo_refl_check.cjs —— 水面反射方向的天空亮度对比：物理大气 vs 解析天空
//
// 用途：用户反馈"加了物理大气后，背光波面变黑"。反射到眼睛里的是 R = reflect(-V,N)
// 方向的天空色 —— 把物理大气（atmoSkyRadiance 的 JS 复刻，逐字对齐 GLSL）在
// 各反射仰角/方位上的输出与旧解析渐变并排，看差在哪里、差多少。
// 顺便验证反射用的 20 步 vs 天穹 32 步是否欠采样。
//
// 用法：node _atmo_refl_check.cjs
const W = require('./ue5-water-material.js');
const Ue5 = (typeof globalThis !== 'undefined' && globalThis.Ue5Water) || W;

// ---- 参数：与 demo 场景一致（ocean 预设 + 太阳 10.25 UTC） ----
const P = Object.assign({}, Ue5.ATMOSPHERE_PRESET);
P.bottomRadius = 6368000;
P.topRadius = P.bottomRadius + 100000;

const CAM_H = 103;                       // 默认机位海拔 (m)
const rCam = P.bottomRadius + CAM_H;

// hexToLinear 复刻（sRGB → linear）
function hex(hexStr) {
  const n = parseInt(hexStr.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return c;
}
const ocean = {
  uSkyColor: hex('#4a86b8'), uHorizonColor: hex('#6db2e0'),
  uHorizonHaze: hex('#cfe2f0'), uHorizonHazeStrength: 0.12,
  uSkyGradientPow: 0.85, uSkyForwardScatter: 0.45,
  uSunColor: hex('#fff2d8'),
  uAbsorptionColor: hex('#07222e'), uScatteringColor: hex('#2a8fa3'),
  uBelowHorizonDark: 0.35,
};
function smoothstep(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }

// ---- 解析天空（逐字对齐 FRAGMENT_SHADER §5 的 else 分支） ----
function analyticRefl(elev, sunDot) {
  const skyT = Math.min(Math.max(elev, 0), 1);
  let sky = ocean.uSkyColor.map((v, i) =>
    ocean.uHorizonColor[i] + (v - ocean.uHorizonColor[i]) * Math.pow(skyT, ocean.uSkyGradientPow));
  const hazeT = (1 - smoothstep(0, 0.12, skyT)) * ocean.uHorizonHazeStrength;
  sky = sky.map((v, i) => v + (ocean.uHorizonHaze[i] - v) * hazeT);
  const belowT = 1 - smoothstep(-0.06, 0, elev);
  const farSea = ocean.uAbsorptionColor.map((v, i) => v * 0.45 + ocean.uScatteringColor[i] * 0.30);
  sky = sky.map((v, i) => v + Math.pow(Math.max(sunDot, 0), 20) * ocean.uSkyForwardScatter * ocean.uSunColor[i]);
  return sky.map((v, i) => v + (farSea[i] - v) * belowT * ocean.uBelowHorizonDark);
}

// ---- LUT ----
console.log('生成 LUT …');
const trans = Ue5.buildTransmittanceLUT(P);
const multi = Ue5.buildMultiScatteringLUT(P, trans);

// ---- 物理天空（逐字对齐 GLSL atmoSkyRadiance） ----
function transmittance(r, mu) { return Ue5.atmoSampleTransmittanceRGB(trans, r, mu, P.bottomRadius, P.topRadius); }
function muHorizon(r) { const k = Math.min(1, P.bottomRadius / r); return -Math.sqrt(Math.max(0, 1 - k * k)); }
const H0 = 500, HSCALE = Math.log1p((P.topRadius - P.bottomRadius) / H0);   // 与模块一致
function multiScatter(r, mu) {
  const v = Math.min(Math.max(Math.log1p(Math.max(r - P.bottomRadius, 0) / H0) / HSCALE, 0), 1);
  const u = Math.min(Math.max(mu * 0.5 + 0.5, 0), 1);
  return [0, 1, 2].map((c) => sampleLut(multi, u, v, c));
}
function sampleLut(lut, u, v, ch) {
  const W = lut.width, H = lut.height, d = lut.data;
  const x = u * W - 0.5, y = v * H - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cx0 = Math.min(Math.max(x0, 0), W - 1), cx1 = Math.min(Math.max(x0 + 1, 0), W - 1);
  const cy0 = Math.min(Math.max(y0, 0), H - 1), cy1 = Math.min(Math.max(y0 + 1, 0), H - 1);
  const a = d[(cy0 * W + cx0) * 4 + ch], b = d[(cy0 * W + cx1) * 4 + ch];
  const c2 = d[(cy1 * W + cx0) * 4 + ch], e = d[(cy1 * W + cx1) * 4 + ch];
  return (a + (b - a) * fx) * (1 - fy) + (c2 + (e - c2) * fx) * fy;
}
function phaseR(c) { return 0.05968310365946075 * (1 + c * c); }
function phaseM(c) {
  const g = P.miePhaseG, g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5));
}
function sunOcclusion(r, muSun) {
  const mh = muHorizon(r);
  return smoothstep(mh - 0.015, mh + 0.015, muSun);
}
// rd/sunDir 单位向量；局部坐标：up=(0,1,0)。返回 tone map 后的 RGB
function skyRadiance(rd, sunDir, steps) {
  const mu = rd[1];
  const b = rCam * mu;
  const tTop = -b + Math.sqrt(Math.max(b * b - (rCam * rCam - P.topRadius * P.topRadius), 0));
  let tGnd = -1;
  {
    const c = rCam * rCam - P.bottomRadius * P.bottomRadius;
    const d = b * b - c;
    if (d >= 0) {
      const sq = Math.sqrt(d);
      if (-b - sq > 0) tGnd = -b - sq;
      else if (-b + sq > 0) tGnd = -b + sq;
    }
  }
  const tMax = (tGnd > 0 && tGnd < tTop) ? tGnd : tTop;
  const dt = tMax / steps;
  const L = [0, 0, 0];
  let T = [1, 1, 1];
  const cosSun = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const px = rd[0] * t, py = rCam + rd[1] * t, pz = rd[2] * t;
    const ri = Math.sqrt(px * px + py * py + pz * pz);
    const h = Math.max(ri - P.bottomRadius, 0);
    const muSun = (px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / ri;
    const dR = Math.exp(-h / P.rayleighScaleHeight);
    const dM = Math.exp(-h / P.mieScaleHeight);
    const dO = Math.max(0, 1 - Math.abs(h - P.ozoneCenterHeight) / P.ozoneWidth);
    const ext = [0, 1, 2].map((c) =>
      dR * P.rayleighScattering[c] + dM * (P.mieScattering + P.mieAbsorption) + dO * P.ozoneAbsorption[c]);
    const Tsun = transmittance(ri, muSun).map((v) => v * sunOcclusion(ri, muSun));
    const msc = multiScatter(ri, muSun);
    const src = [0, 1, 2].map((c) => {
      const scat = dR * P.rayleighScattering[c] * phaseR(cosSun) + dM * P.mieScattering * phaseM(cosSun);
      const iso = (dR * P.rayleighScattering[c] + dM * P.mieScattering) * msc[c];
      return (scat * Tsun[c] + iso) * P.sunIrradiance;
    });
    for (let c = 0; c < 3; c++) {
      const Tstep = Math.exp(-ext[c] * dt);
      const segT = (1 - Tstep) / Math.max(ext[c], 1e-9);
      L[c] += src[c] * T[c] * segT;
      T[c] *= Tstep;
    }
  }
  return L.map((v) => { const c = v * P.exposure; return c / (1 + c); });
}

// ---- 场景太阳：10.25 UTC，6/21，31.4N → 仰角≈11°，方位取 0（看向太阳时反射方位差决定明暗）----
const sunEl = 11 * Math.PI / 180;
const sunDir = [Math.cos(sunEl), Math.sin(sunEl), 0];     // 太阳在 +X 方向的地平线附近

function lum(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function fmt(c) { return c.map((v) => v.toFixed(3)).join(' '); }

console.log('太阳仰角 11°（18:15 当地）· 相机 103m · 曝光 ' + P.exposure);
console.log('');
console.log('反射仰角el | 方位 | 物理32步(天穹同级)      | 物理20步(水面当前)      | 物理64步(精度参照)      | 解析天空(旧)            | 物理修复(钳地平线+远海)');
for (const elDeg of [-4, -1, 0, 2, 5, 8, 12, 20, 30, 45, 60]) {
  const el = elDeg * Math.PI / 180;
  for (const azDeg of [0, 180]) {
    const az = azDeg * Math.PI / 180;
    const rd = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const sunDot = rd[0] * sunDir[0] + rd[1] * sunDir[1];
    const p32 = skyRadiance(rd, sunDir, 32);
    const p20 = skyRadiance(rd, sunDir, 20);
    const p64 = skyRadiance(rd, sunDir, 64);
    const ana = analyticRefl(elDeg / 90, sunDot);   // elev 用 [-1,1] 归一：el/90
    // ---- 修复后：仰角钳到地平线采样（同方位），belowT·0.35 混远海色 ----
    const rdC = [Math.cos(el) * Math.cos(az), Math.max(Math.sin(el), 0), Math.cos(el) * Math.sin(az)];
    let fix = skyRadiance(rdC, sunDir, 20);
    const belowT = 1 - smoothstep(-0.06, 0, elDeg / 90);
    const farSea = ocean.uAbsorptionColor.map((v, i) => v * 0.45 + ocean.uScatteringColor[i] * 0.30);
    fix = fix.map((v, i) => v + (farSea[i] - v) * belowT * ocean.uBelowHorizonDark);
    console.log(
      'el=' + String(elDeg).padStart(3) + ' az=' + String(azDeg).padStart(3)
      + ' | ' + fmt(p32) + ' L' + lum(p32).toFixed(3)
      + ' | ' + fmt(p20) + ' L' + lum(p20).toFixed(3)
      + ' | ' + fmt(p64) + ' L' + lum(p64).toFixed(3)
      + ' | ' + fmt(ana) + ' L' + lum(ana).toFixed(3)
      + ' | ' + fmt(fix) + ' L' + lum(fix).toFixed(3));
  }
}
