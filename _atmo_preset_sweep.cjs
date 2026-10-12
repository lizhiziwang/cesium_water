// _atmo_preset_sweep.cjs —— 大气预设扫描：地平线天空的"中性/蓝"由谁决定
//
// 物理天空在低太阳高度角下，地平线附近接近无彩色（米氏雾霾 + 多次散射的贡献），
// 掠射水面反射的就是它 ⇒ 整片水发灰。注意：对无彩色输入做"饱和度提升"没有任何用
// （R≈G≈B 时围绕亮度缩放仍是同一个值），只能【减少中性成分】或【乘色相】。
// 本脚本扫描气溶胶（mieScatter/mieAbsorb）、多次散射倍率、瑞利缩放，
// 看哪一项能把地平线天空推回蓝色，同时给出曝光后的亮度，避免顺手把天穹弄暗。
//
// 用法：node _atmo_preset_sweep.cjs
const W = require('./ue5-water-material.js');
const Ue5 = (typeof globalThis !== 'undefined' && globalThis.Ue5Water) || W;

const BASE = Object.assign({}, Ue5.ATMOSPHERE_PRESET);
BASE.bottomRadius = 6368000;
BASE.topRadius = BASE.bottomRadius + 100000;
const rCam = BASE.bottomRadius + 103;

function smoothstep(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }
function lum(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
// "蓝度"：蓝-红 之差（无彩色≈0，蓝为正）
function blueness(c) { return c[2] - c[0]; }
function fmt(c) { return c.map((v) => v.toFixed(3)).join(' '); }

// 每个候选预设都要重建 LUT；multiScale 对应 GLSL 的 uAtmoMultiScale（LUT 之外的实时倍率）
function makeSampler(Pin) {
  const P = Object.assign({}, Pin);
  if (P.rayleighMul !== undefined) {
    P.rayleighScattering = P.rayleighScattering.map((v) => v * P.rayleighMul);
  }
  const multiScale = P.multiScale === undefined ? 1.0 : P.multiScale;
  const trans = Ue5.buildTransmittanceLUT(P);
  const multi = Ue5.buildMultiScatteringLUT(P, trans);
  const muHorizon = (r) => { const k = Math.min(1, P.bottomRadius / r); return -Math.sqrt(Math.max(0, 1 - k * k)); };
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
  const ntr = (r, mu) => Ue5.atmoSampleTransmittanceRGB(trans, r, mu, P.bottomRadius, P.topRadius);
  const msc = (r, mu) => {
    const v = Math.min(Math.max(Math.log1p(Math.max(r - P.bottomRadius, 0) / H0) / HSCALE, 0), 1);
    const u = Math.min(Math.max(mu * 0.5 + 0.5, 0), 1);
    return [0, 1, 2].map((c) => sampleLut(multi, u, v, c));
  };
  const phaseR = (c) => 0.05968310365946075 * (1 + c * c);
  const phaseM = (c) => { const g = P.miePhaseG, g2 = g * g; return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5)); };

  // 与 GLSL 逐字对齐；tonemap=false 时返回线性 L（用来判断"是色调问题还是曝光问题"）
  function march(rd, sunDir, tPoint, steps, tonemap) {
    const mu = rd[1];
    const b = rCam * mu;
    const tTop = -b + Math.sqrt(Math.max(b * b - (rCam * rCam - P.topRadius * P.topRadius), 0));
    let tGnd = -1;
    {
      const c = rCam * rCam - P.bottomRadius * P.bottomRadius;
      const d = b * b - c;
      if (d >= 0) { const sq = Math.sqrt(d); if (-b - sq > 0) tGnd = -b - sq; else if (-b + sq > 0) tGnd = -b + sq; }
    }
    const tLim = (tGnd > 0 && tGnd < tTop) ? tGnd : tTop;
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
      const dM = Math.exp(-h / P.mieScaleHeight);
      const dO = Math.max(0, 1 - Math.abs(h - P.ozoneCenterHeight) / P.ozoneWidth);
      const ext = [0, 1, 2].map((c) => dR * P.rayleighScattering[c] + dM * (P.mieScattering + P.mieAbsorption) + dO * P.ozoneAbsorption[c]);
      const Tsun = ntr(ri, muSun).map((v) => v * smoothstep(muHorizon(ri) - 0.015, muHorizon(ri) + 0.015, muSun));
      const m = msc(ri, muSun).map((v) => v * multiScale);
      const src = [0, 1, 2].map((c) => {
        const scat = dR * P.rayleighScattering[c] * phaseR(cosSun) + dM * P.mieScattering * phaseM(cosSun);
        const iso = (dR * P.rayleighScattering[c] + dM * P.mieScattering) * m[c];
        return (scat * Tsun[c] + iso) * P.sunIrradiance;
      });
      for (let c = 0; c < 3; c++) {
        const Tstep = Math.exp(-ext[c] * dt);
        const segT = (1 - Tstep) / Math.max(ext[c], 1e-9);
        L[c] += src[c] * T[c] * segT;
        T[c] *= Tstep;
      }
    }
    return L;
  }
  return march;
}

const sunEl = 11 * Math.PI / 180;
const sunDir = [Math.cos(sunEl), Math.sin(sunEl), 0];
const dir = (elDeg, azDeg) => {
  const el = elDeg * Math.PI / 180, az = azDeg * Math.PI / 180;
  return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
};

// 候选：只改一个变量，看地平线天空（el=0.5°）在背太阳方位的颜色
const variants = [];
variants.push({ name: '当前默认', P: {} });
for (const s of [3.0e-6, 2.4e-6, 1.5e-6, 0.8e-6]) {
  variants.push({ name: `mie散射=${s.toExponential(1)} (吸收=1.1x)`, P: { mieScattering: s, mieAbsorption: s * 1.1 } });
}
variants.push({ name: 'mie=2.4e-6 + 多次散射×0.7', P: { mieScattering: 2.4e-6, mieAbsorption: 2.64e-6, multiScale: 0.7 } });
variants.push({ name: 'mie=2.4e-6 + 瑞利×1.15', P: { mieScattering: 2.4e-6, mieAbsorption: 2.64e-6, rayleighMul: 1.15, multiScale: 0.7 } });

console.log('太阳仰角 11° · 相机 103 m');
console.log('判据：地平线天空的"蓝度 = B-R"。当前默认下掠射水面反射≈地平线天空 ⇒ 蓝度≈0 就是"发灰"。');
console.log('');
console.log('变体'.padEnd(30) + ' | 地平线天空(az180) 曝光后  | 蓝度 | 天顶(az180) 曝光后     | 蓝度 | 曝光后亮度Δ(地平线)');
const ref = {};
for (const v of variants) {
  const P = Object.assign({}, BASE, v.P);
  P.bottomRadius = BASE.bottomRadius;
  P.topRadius = BASE.topRadius;
  const march = makeSampler(P);
  const hz = march(dir(0.5, 180), sunDir, 1e12, 32, true).map((x) => { const c = x * P.exposure; return c / (1 + c); });
  const hzSun = march(dir(0.5, 0), sunDir, 1e12, 32, true).map((x) => { const c = x * P.exposure; return c / (1 + c); });
  const zen = march(dir(60, 180), sunDir, 1e12, 32, true).map((x) => { const c = x * P.exposure; return c / (1 + c); });
  // 线性（未曝光）也看一眼：区分"色调本身"和"曝光压缩"
  const hzLin = march(dir(0.5, 180), sunDir, 1e12, 32, false);
  if (!ref.hz) { ref.hz = lum(hz); ref.sun = lum(hzSun); }
  console.log(
    v.name.padEnd(30) + ' | ' + fmt(hz) + ' L' + lum(hz).toFixed(3)
    + ' | ' + blueness(hz).toFixed(3).padStart(5) + ' | ' + fmt(zen) + ' L' + lum(zen).toFixed(3)
    + ' | ' + blueness(zen).toFixed(3).padStart(5)
    + ' | ΔL=' + (lum(hz) - ref.hz).toFixed(3)
    + '  (朝太阳' + fmt(hzSun) + ')'
    + '  线性蓝度=' + blueness(hzLin).toExponential(2));
}
