// _atmosphere_check.cjs —— Frostbite 大气 LUT 的数值自检（零依赖）
//
// 为什么需要它：大气 LUT 是"一步算错、处处难看"的东西 —— 参数化写反、积分步长不够、
// 地平线钳位漏掉，最终都表现为"天空偏色 / 地平线发黑"这类说不清的现象，
// 靠肉眼看渲染图很难定位到底错在哪一步。所以这里把 LUT 单独拿出来，用【解析解】对齐：
//
//   · 垂直光学厚度：瑞利层是 exp(-h/H) 的球壳，垂直积分就是 β·H（闭式）
//   · 斜程：Chapman 函数 Ch(X,μ) = sqrt(πX/2)·exp(Xμ²/2)·erfc(μ·sqrt(X/2))，
//          X = R/H，μ = 天顶角余弦 —— 与我们的数值积分完全独立，正好当裁判
//   · 整体：再用 4096 步中点法做收敛对照
// 另外导出两张 LUT 的 PNG（gamma 提亮），形状对不对一眼就能看出来。
//
// 用法：node _atmosphere_check.cjs [--out <目录>]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = require('./ue5-water-material.js');
const Ue5 = (typeof globalThis !== 'undefined' && globalThis.Ue5Water) || W;

const DIR = __dirname;
const outArg = process.argv.indexOf('--out');
const OUTDIR = outArg >= 0 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : DIR;

// ---------------------------------------------------------------- 解析参考解
// 互补误差函数（Numerical Recipes 的 Chebyshev 展开），用于 Chapman 闭式解
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10,
    -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
    -6.886027e-12, 8.94487e-13, 3.13092e-13,
    -1.12708e-13, 3.81e-16, 7.106e-15, -1.523e-15, -9.4e-17,
    1.21e-16, -2.8e-17,
  ];
  let d = 0, dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}
// 球壳指数大气从地面出发的斜程/垂直光学厚度比（Chapman 函数）
function chapman(X, mu) {
  return Math.sqrt(Math.PI * X / 2) * Math.exp(X * mu * mu / 2)
       * erfc(mu * Math.sqrt(X / 2));
}
// 参考积分：可分别只算瑞利 / 米氏 / 臭氧，便于逐项对照解析解
function refMarchRTO(P, r, mu, steps, which) {
  const Rb = P.bottomRadius, Rt = P.topRadius;
  const b = r * mu;
  const tTop = -b + Math.sqrt(Math.max(b * b - (r * r - Rt * Rt), 0));
  const dt = tTop / steps;
  const od = [0, 0, 0], om = [0, 0, 0], oo = [0, 0, 0];
  for (let s = 0; s < steps; s++) {
    const t = (s + 0.5) * dt;
    const ri = Math.sqrt(r * r + t * t + 2 * r * mu * t);
    const h = Math.max(ri - Rb, 0);
    const dR = Math.exp(-h / P.rayleighScaleHeight);
    const dM = Math.exp(-h / P.mieScaleHeight);
    const dO = Math.max(0, 1 - Math.abs(h - P.ozoneCenterHeight) / P.ozoneWidth);
    for (let c = 0; c < 3; c++) {
      od[c] += P.rayleighScattering[c] * dR * dt;
      om[c] += (P.mieScattering + P.mieAbsorption) * dM * dt;
      oo[c] += P.ozoneAbsorption[c] * dO * dt;
    }
  }
  return [0, 1, 2].map((c) => {
    let tau = 0;
    if (which === 'rayleigh') tau = od[c];
    else if (which === 'mie') tau = om[c];
    else if (which === 'ozone') tau = oo[c];
    else tau = od[c] + om[c] + oo[c];
    return Math.exp(-tau);
  });
}

// ---------------------------------------------------------------- PNG 导出
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function writePng(file, w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const c = pixel(x, y);
      raw[o++] = Math.max(0, Math.min(255, Math.round(c[0])));
      raw[o++] = Math.max(0, Math.min(255, Math.round(c[1])));
      raw[o++] = Math.max(0, Math.min(255, Math.round(c[2])));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ---------------------------------------------------------------- 主流程
const P = Object.assign({}, Ue5.ATMOSPHERE_PRESET);
P.bottomRadius = 6368000;
P.topRadius = P.bottomRadius + 100000;

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '   ' + detail : ''));
  if (!ok) failed++;
}

console.log('大气参数: Rb=' + P.bottomRadius + ' Rt=' + P.topRadius
  + ' 瑞利标高=' + P.rayleighScaleHeight + ' 米氏标高=' + P.mieScaleHeight);

console.log('\n[1] 生成 LUT');
const t0 = Date.now();
const trans = Ue5.buildTransmittanceLUT(P);
const tTrans = Date.now() - t0;
const t1 = Date.now();
const multi = Ue5.buildMultiScatteringLUT(P, trans);
const tMulti = Date.now() - t1;
console.log('  transmittance ' + trans.width + '×' + trans.height + ' 用时 ' + tTrans + ' ms'
  + '  高度映射 h0=' + P.h0 + ' K=' + P.hScale.toFixed(4));
console.log('  multi-scattering ' + multi.width + '×' + multi.height + ' 用时 ' + tMulti + ' ms');

console.log('\n[2] 数值健全性');
let bad = 0;
for (let i = 0; i < trans.data.length; i++) {
  const v = trans.data[i];
  if (!Number.isFinite(v) || v < 0 || v > 1) bad++;
}
check('transmittance 全部落在 [0,1] 且有限', bad === 0, bad ? '异常 ' + bad + ' 个' : '');
bad = 0;
let mMin = Infinity, mMax = 0;
for (let i = 0; i < multi.data.length; i += 4) {
  for (let c = 0; c < 3; c++) {
    const v = multi.data[i + c];
    if (!Number.isFinite(v) || v < 0) bad++;
    mMin = Math.min(mMin, v); mMax = Math.max(mMax, v);
  }
}
check('multi-scattering 非负且有限', bad === 0, bad ? '异常 ' + bad + ' 个' : '');

console.log('\n[3] 瑞利垂直光学厚度：数值积分 vs 闭式解 β·H');
{
  const r = P.bottomRadius + 1;
  const got = refMarchRTO(P, r, 1.0, 4096, 'rayleigh');
  const want = [0, 1, 2].map((c) => Math.exp(-P.rayleighScattering[c] * P.rayleighScaleHeight));
  const err = [0, 1, 2].map((c) => Math.abs(got[c] - want[c]) / want[c] * 100);
  console.log('  数值=(' + got.map((v) => v.toFixed(5)).join(', ') + ')'
    + '  闭式=(' + want.map((v) => v.toFixed(5)).join(', ') + ')'
    + '  误差=' + err.map((v) => v.toFixed(3) + '%').join('/'));
  check('瑞利垂直积分与 β·H 一致（<0.2%）', Math.max(...err) < 0.2);
}

console.log('\n[4] 瑞利斜程：数值积分 vs Chapman 解析解');
for (const mu of [0.9, 0.6, 0.3, 0.1, 0.02]) {
  const r = P.bottomRadius + 1;
  const got = refMarchRTO(P, r, mu, 4096, 'rayleigh');
  const X = r / P.rayleighScaleHeight;
  const Ch = chapman(X, mu);
  const want = [0, 1, 2].map((c) => Math.exp(-P.rayleighScattering[c] * P.rayleighScaleHeight * Ch));
  const err = [0, 1, 2].map((c) => Math.abs(got[c] - want[c]) / want[c] * 100);
  console.log('  μ=' + mu.toFixed(2) + '  Chapman=' + Ch.toFixed(4) + ' 倍'
    + '  数值=(' + got.map((v) => v.toFixed(5)).join(', ') + ')'
    + '  误差=' + err.map((v) => v.toFixed(2) + '%').join('/'));
  check('μ=' + mu.toFixed(2) + ' 斜程与 Chapman 一致（<1%）', Math.max(...err) < 1.0);
}

console.log('\n[5] LUT 纹素中心 vs 4096 步参考（同 r 同 μ，隔离积分误差）');
{
  const Hs = trans.height, Ws = trans.width;
  let worst = 0, worstAt = '';
  for (const [ii, jj] of [[255, 0], [200, 0], [128, 0], [64, 0], [16, 0], [2, 0],
                          [255, 8], [128, 20], [64, 40], [32, 63]]) {
    // 与生成端一致：h = h0·(e^(v·K) − 1)，取纹素中心 v=(j+0.5)/H
    const v = (jj + 0.5) / Hs;
    const rr = P.bottomRadius + P.h0 * Math.expm1(v * P.hScale);
    const mh = -Math.sqrt(Math.max(0, 1 - (P.bottomRadius / rr) ** 2));
    const u = (ii + 0.5) / Ws;
    const mu = mh + (1 - mh) * u * u;
    const got = Ue5.atmoSampleTransmittanceRGB(trans, rr, mu, P.bottomRadius, P.topRadius);
    const want = refMarchRTO(P, rr, mu, 4096, 'all');
    const err = [0, 1, 2].map((c) => Math.abs(got[c] - want[c]) / Math.max(want[c], 1e-9) * 100);
    const e = Math.max(...err);
    if (e > worst) { worst = e; worstAt = 'i=' + ii + ' j=' + jj; }
    console.log('  i=' + String(ii).padStart(3) + ' j=' + String(jj).padStart(2)
      + '  h=' + (rr - P.bottomRadius).toFixed(0).padStart(6) + 'm'
      + '  μ=' + mu.toFixed(4)
      + '  LUT=(' + got.map((v) => v.toFixed(5)).join(', ') + ')'
      + '  误差=' + err.map((v) => v.toFixed(2) + '%').join('/'));
  }
  check('纹素中心误差 < 0.5%（最差 ' + worst.toFixed(2) + '% @ ' + worstAt + '）', worst < 0.5);
}

console.log('\n[6] 地平线连续性（μ 扫过地平线不应跳变）');
{
  const r = P.bottomRadius + 1;
  const muH = -Math.sqrt(1 - (P.bottomRadius / r) ** 2);
  let maxJump = 0, prev = null;
  for (let k = 0; k <= 400; k++) {
    const mu = muH - 0.05 + (0.1 * k) / 400;
    const v = Ue5.atmoSampleTransmittanceRGB(trans, r, mu, P.bottomRadius, P.topRadius);
    if (prev) for (let c = 0; c < 3; c++) maxJump = Math.max(maxJump, Math.abs(v[c] - prev[c]));
    prev = v;
  }
  check('地平线附近无跳变（单步变化 < 0.01）', maxJump < 0.01, '最大 ' + maxJump.toFixed(5));
}

console.log('\n[7] multi-scattering 量级');
{
  let sum = 0, n = 0;
  for (let i = 0; i < multi.data.length; i += 4) {
    for (let c = 0; c < 3; c++) { sum += multi.data[i + c]; n++; }
  }
  console.log('  min=' + mMin.toExponential(3) + '  max=' + mMax.toExponential(3)
    + '  mean=' + (sum / n).toExponential(3));
  // 单次散射量级 ≈ β·H ≈ 1e-5 × 8e3 = 8e-2；多次散射应比它小一到两个数量级
  check('多次散射量级合理（1e-5 ~ 1e-1）', mMax > 1e-5 && mMax < 1e-1);
  check('多次散射非零', mMax > 0);
  check('低高度处多次散射更大（密度大 ⇒ 散射强）',
    multi.data[0] + multi.data[1] + multi.data[2]
    > multi.data[(multi.height - 1) * multi.width * 4] + multi.data[(multi.height - 1) * multi.width * 4 + 1] + multi.data[(multi.height - 1) * multi.width * 4 + 2]);
}

console.log('\n[8] LUT 形状导出（gamma 提亮便于肉眼检查）');
writePng(path.join(OUTDIR, '_lut_transmittance.png'), trans.width, trans.height, (x, y) => {
  const i = ((trans.height - 1 - y) * trans.width + x) * 4;
  return [0, 1, 2].map((c) => Math.pow(Math.max(trans.data[i + c], 0), 0.45) * 255);
});
writePng(path.join(OUTDIR, '_lut_multiscatter.png'), multi.width, multi.height, (x, y) => {
  const i = ((multi.height - 1 - y) * multi.width + x) * 4;
  const mx = 4e-3;
  return [0, 1, 2].map((c) => Math.min(Math.max(multi.data[i + c], 0) / mx, 1) * 255);
});
console.log('  → _lut_transmittance.png  （横轴=天顶角 左地平线→右天顶；纵轴=高度 下海平面→上大气顶）');
console.log('  → _lut_multiscatter.png    （横轴=太阳天顶角 −1→+1；纵轴=高度）');

console.log('\n[9] 性能');
check('LUT 生成总耗时 < 3000 ms（启动一次性）', (tTrans + tMulti) < 3000, (tTrans + tMulti) + ' ms');

console.log('\n' + (failed === 0 ? '全部通过 ✅' : failed + ' 项未通过 ❌'));
process.exit(failed === 0 ? 0 : 1);
