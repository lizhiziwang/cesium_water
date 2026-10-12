// _atmo_white_check.cjs —— 水面"大片灰白"来源量化
//
// 背景：用户反馈加物理大气后，太阳光路一带水面成片灰白（无细节、发灰）。
// 候选来源（按怀疑度）：
//   A) 气透视入散射 apS：水色 = color·apT + apS，远处水被拉向"大气色"。旧解析雾在
//      3 km 只有 0.56%（1-exp(-(d·2.5e-5)²)），物理 AP 若不只这个量级，就会整片提白。
//   B) 天空反射里的米氏前向散射：g=0.8，太阳周围几十度内亮度极高，tone map 后压成白，
//      再乘掠射 fresnel(0.5~0.9) ⇒ 大片白。旧解析版只有 pow(sunDot,20) 的窄辉光。
//   C) 高光/辉光/泡沫：数值上只能看它们对最终色的占比，本脚本给 A/B 的定量参照。
//
// 用法：node _atmo_white_check.cjs
const W = require('./ue5-water-material.js');
const Ue5 = (typeof globalThis !== 'undefined' && globalThis.Ue5Water) || W;

const P = Object.assign({}, Ue5.ATMOSPHERE_PRESET);
P.bottomRadius = 6368000;
P.topRadius = P.bottomRadius + 100000;

const CAM_H = 103;
const rCam = P.bottomRadius + CAM_H;

function hex(hexStr) {
  const n = parseInt(hexStr.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
}
const OCEAN = {
  uAbsorptionColor: hex('#07222e'), uScatteringColor: hex('#2a8fa3'),
  uHorizonColor: hex('#6db2e0'), uSkyColor: hex('#4a86b8'),
};
function smoothstep(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }
function lum(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function fmt(c) { return c.map((v) => v.toFixed(3)).join(' '); }

console.log('生成 LUT …');
const trans = Ue5.buildTransmittanceLUT(P);
const multi = Ue5.buildMultiScatteringLUT(P, trans);

function transmittance(r, mu) { return Ue5.atmoSampleTransmittanceRGB(trans, r, mu, P.bottomRadius, P.topRadius); }
function muHorizon(r) { const k = Math.min(1, P.bottomRadius / r); return -Math.sqrt(Math.max(0, 1 - k * k)); }
const H0 = 500, HSCALE = Math.log1p((P.topRadius - P.bottomRadius) / H0);
function sampleLut(lut, u, v, ch) {
  const Wd = lut.width, Hd = lut.height, d = lut.data;
  const x = u * Wd - 0.5, y = v * Hd - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cx0 = Math.min(Math.max(x0, 0), Wd - 1), cx1 = Math.min(Math.max(x0 + 1, 0), Wd - 1);
  const cy0 = Math.min(Math.max(y0, 0), Hd - 1), cy1 = Math.min(Math.max(y0 + 1, 0), Hd - 1);
  const a = d[(cy0 * Wd + cx0) * 4 + ch], b = d[(cy0 * Wd + cx1) * 4 + ch];
  const c2 = d[(cy1 * Wd + cx0) * 4 + ch], e = d[(cy1 * Wd + cx1) * 4 + ch];
  return (a + (b - a) * fx) * (1 - fy) + (c2 + (e - c2) * fx) * fy;
}
function multiScatter(r, mu) {
  const v = Math.min(Math.max(Math.log1p(Math.max(r - P.bottomRadius, 0) / H0) / HSCALE, 0), 1);
  const u = Math.min(Math.max(mu * 0.5 + 0.5, 0), 1);
  return [0, 1, 2].map((c) => sampleLut(multi, u, v, c));
}
function phaseR(c) { return 0.05968310365946075 * (1 + c * c); }
function phaseM(c) { const g = P.miePhaseG, g2 = g * g; return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5)); }
function sunOcclusion(r, muSun) { const mh = muHorizon(r); return smoothstep(mh - 0.015, mh + 0.015, muSun); }

// ---- 与 GLSL 逐字对齐的积分内核：mieScale 用来试"反射里压掉米氏前向散射" ----
function march(rd, sunDir, tPoint, steps, mieScale, tonemap) {
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
  let tLim = (tGnd > 0 && tGnd < tTop) ? tGnd : tTop;
  const t = Math.min(tPoint, tLim);
  const dt = t / Math.max(steps, 1);
  const L = [0, 0, 0];
  let T = [1, 1, 1];
  const cosSun = rd[0] * sunDir[0] + rd[1] * sunDir[1] + rd[2] * sunDir[2];
  for (let i = 0; i < steps; i++) {
    const ti = (i + 0.5) * dt;
    const px = rd[0] * ti, py = rCam + rd[1] * ti, pz = rd[2] * ti;
    const ri = Math.sqrt(px * px + py * py + pz * pz);
    const h = Math.max(ri - P.bottomRadius, 0);
    const muSun = (px * sunDir[0] + py * sunDir[1] + pz * sunDir[2]) / ri;
    const dR = Math.exp(-h / P.rayleighScaleHeight);
    const dM = Math.exp(-h / P.mieScaleHeight) * mieScale;
    const dO = Math.max(0, 1 - Math.abs(h - P.ozoneCenterHeight) / P.ozoneWidth);
    const ext = [0, 1, 2].map((c) => dR * P.rayleighScattering[c] + dM * (P.mieScattering + P.mieAbsorption) + dO * P.ozoneAbsorption[c]);
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
  if (!tonemap) return { T, L };
  return { T, L: L.map((v) => { const c = v * P.exposure; return c / (1 + c); }) };
}

const sunEl = 11 * Math.PI / 180;
const sunDir = [Math.cos(sunEl), Math.sin(sunEl), 0];

// ============ A) 气透视入散射 vs 旧解析雾 ============
console.log('\n================ A) 气透视：水色 = color·apT + apS ================');
console.log('旧解析雾参照：hazeT = 1-exp(-(d·2.5e-5)²)  →  1 km 0.06% / 3 km 0.56% / 8 km 4%');
console.log('');
console.log('距离(m) | 视线仰角 | 方位 | apT(透过率)        | apS(入散射,已曝光)      | 旧解析雾％ | 水体色(teal)         | 合成后               | 提白量Δ');
const body = OCEAN.uScatteringColor.map((v) => v * 0.42);   // 中景水体的近似色（偏散射）
for (const dist of [500, 1000, 3000, 5000, 8000]) {
  // 相机 103 m，注视水面距离 d 处的片元 ⇒ 视线仰角 ≈ -atan(103/d)
  const el = -Math.atan(CAM_H / Math.max(dist - 200, 1));
  for (const azDeg of [0, 180]) {
    const az = azDeg * Math.PI / 180;
    const rd = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const { T, L } = march(rd, sunDir, dist, 16, 1.0, true);
    const oldFog = 1 - Math.exp(-Math.pow(dist * 2.5e-5, 2));
    const comp = body.map((v, i) => v * T[i] + L[i]);
    console.log(
      String(dist).padStart(7) + ' | ' + (el * 180 / Math.PI).toFixed(2).padStart(6) + '° | '
      + String(azDeg).padStart(4) + ' | ' + fmt(T) + ' | ' + fmt(L) + ' L' + lum(L).toFixed(3)
      + ' | ' + (oldFog * 100).toFixed(2).padStart(5) + '% | ' + fmt(body) + ' | ' + fmt(comp)
      + ' | ' + (lum(comp) - lum(body)).toFixed(3));
  }
}

// ============ B) 天空反射：米氏前向散射在全方位的贡献 ============
console.log('\n================ B) 天空反射亮度 vs 反射方位角（仰角=地平线）================');
console.log('方位 0° = 朝太阳；180° = 背太阳。mieScale 用来试"反射里只保留 25% 米氏"。');
console.log('');
console.log('方位 | 物理反射(mie=1.0)      | 物理反射(mie=0.25)     | 差值');
for (const azDeg of [0, 15, 30, 60, 90, 120, 150, 180]) {
  const az = azDeg * Math.PI / 180;
  const rd = [Math.cos(az), 0.0, Math.sin(az)];
  const a = march(rd, sunDir, 1e12, 20, 1.0, true).L;
  const b = march(rd, sunDir, 1e12, 20, 0.25, true).L;
  console.log(String(azDeg).padStart(4) + ' | ' + fmt(a) + ' L' + lum(a).toFixed(3)
    + ' | ' + fmt(b) + ' L' + lum(b).toFixed(3)
    + ' | L' + (lum(a) - lum(b)).toFixed(3));
}

// ============ C) 合成：掠射水面最终色（不含高光/泡沫）============
console.log('\n================ C) 掠射水面最终色（反射×fresnel + 水体×(1-fresnel)，无高光/泡沫）================');
console.log('取 NdV = 0.2（8 m 机位看中景），F0=0.0201, uFresnelPower=5 → fresnel≈?');
const NdV = 0.2, F0 = 0.0201, fres = F0 + (1 - F0) * Math.pow(1 - NdV, 5.0);
console.log('fresnel = ' + fres.toFixed(3));
console.log('');
console.log('方位 | 反射色(mie=1.0)        | 反射色(mie=0.25)       | 合成(mie=1.0)          | 合成(mie=0.25)         ; 提白量Δ');
const bodyDeep = OCEAN.uAbsorptionColor.map((v, i) => v * 0.55 + OCEAN.uScatteringColor[i] * 0.45);
for (const azDeg of [0, 30, 90, 150, 180]) {
  const az = azDeg * Math.PI / 180;
  const rd = [Math.cos(az), Math.max(Math.sin(-1.5 * Math.PI / 180), 0), Math.sin(az)];
  const a = march(rd, sunDir, 1e12, 20, 1.0, true).L;
  const b = march(rd, sunDir, 1e12, 20, 0.25, true).L;
  const ca = bodyDeep.map((v, i) => v * (1 - fres) + a[i] * fres);
  const cb = bodyDeep.map((v, i) => v * (1 - fres) + b[i] * fres);
  console.log(String(azDeg).padStart(4) + ' | ' + fmt(a) + ' | ' + fmt(b)
    + ' | ' + fmt(ca) + ' | ' + fmt(cb) + ' ; ΔL' + (lum(ca) - lum(cb)).toFixed(3));
}
