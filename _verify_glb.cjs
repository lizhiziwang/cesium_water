// 校验：1) 模块与 index.html 内联脚本的 JS 语法；2) 两份着色器源码一致性；
//       3) Cesium CustomShader 顶点输入的类型陷阱回归检查；4) 运行时生成的 glb 结构；
//       5) 程序化法线贴图（mipmap/各向异性、可平铺、非均匀性）
// 用法：node _verify_glb.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = __dirname;

// ---------- 1. 语法检查 ----------
const moduleSrc = fs.readFileSync(path.join(dir, 'ue5-water-material.js'), 'utf8');
new vm.Script(moduleSrc, { filename: 'ue5-water-material.js' });
console.log('[语法] ue5-water-material.js: OK');

const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
scripts.forEach((s, i) => {
  if (!s.trim()) return;
  new vm.Script(s, { filename: `index.html#inline${i}` });
});
console.log('[语法] index.html 内联脚本 (' + scripts.filter(s => s.trim()).length + ' 段): OK');

// ---------- 2. 加载模块（模块内仅声明，未触碰 Cesium）----------
require(path.join(dir, 'ue5-water-material.js'));
const U = globalThis.Ue5Water;
if (!U) throw new Error('模块未正确挂载 Ue5Water');
console.log('[模块] 导出:', Object.keys(U).join(', '));

// ---------- 2.5 着色器源码一致性 + Cesium 属性扫描复现 ----------
let fail = 0;

// 2.5.1 index.html 内联副本必须与 ue5-water-material.js 完全一致
const inlineIdx = scripts.findIndex((s) => s.includes('global.Ue5Water ='));
if (inlineIdx < 0) {
  console.log('[同步] 未在 index.html 中找到内联模块: BAD');
  fail++;
} else {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(scripts[inlineIdx], sandbox);
  const U2 = sandbox.Ue5Water;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const checks = [
    ['VERTEX_SHADER', same(U.VERTEX_SHADER, U2.VERTEX_SHADER)],
    ['FRAGMENT_SHADER', same(U.FRAGMENT_SHADER, U2.FRAGMENT_SHADER)],
    ['PRESETS', same(U.PRESETS, U2.PRESETS)],
  ];
  checks.forEach(([n, p]) => {
    if (!p) fail++;
    console.log(`[同步] ${n} 内联副本 vs 模块文件: ${p ? 'OK' : 'BAD（两份不一致！）'}`);
  });
}

// 2.5.2 复现 Cesium 的属性扫描（关键：它连注释一起扫）
// Cesium 源码 CustomShader 内部：
//   const re = /[vf]sInput\.attributes\.(\w+)/g;
//   DS(shaderText, re, usedVariables.attributeSet)   // DS 只是 while(re.exec()) 循环，不剥注释
// 扫到的名字会被写进本着色器的 Attributes 结构体，字段类型 = glTF 访问器类型。
// 于是「注释里提一句」也真的会改变编译结果 —— 本项目就踩过这个坑。
const CESIUM_ATTR_RE = /[vf]sInput\.attributes\.(\w+)/g;
function scanCesiumAttrs(text) {
  const set = new Set();
  const re = new RegExp(CESIUM_ATTR_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  return [...set];
}

// 白名单：值是 Cesium 实际会声明出的 GLSL 类型
const VS_ALLOWED = { positionMC: 'vec3', normalMC: 'vec3', texCoord_0: 'vec2' };
const FS_ALLOWED = {
  texCoord_0: 'vec2', normalEC: 'vec3', tangentEC: 'vec3',
  positionEC: 'vec3', positionWC: 'vec3', color_0: 'vec4',
};

const vsAttrs = scanCesiumAttrs(U.VERTEX_SHADER);
const fsAttrs = scanCesiumAttrs(U.FRAGMENT_SHADER);
console.log('\n[Cesium扫描] 顶点着色器登记到的属性:', vsAttrs.join(', ') || '(无)');
console.log('[Cesium扫描] 片元着色器登记到的属性:', fsAttrs.join(', ') || '(无)');

[[vsAttrs, VS_ALLOWED, '顶点'], [fsAttrs, FS_ALLOWED, '片元']].forEach(([list, allow, which]) => {
  list.forEach((a) => {
    if (allow[a]) {
      console.log(`[Cesium扫描]   ${which} ${a} -> ${allow[a]}: OK`);
    } else {
      fail++;
      console.log(`[Cesium扫描]   ${which} ${a}: BAD —— 不在白名单（注释里出现也会被登记！）`);
    }
  });
});

if (vsAttrs.includes('tangentMC')) {
  fail++;
  console.log('[Cesium扫描] 顶点登记了 tangentMC: BAD（glTF TANGENT=VEC4 → 被声明成 vec4，必然编译失败）');
}

// Cesium 对片元使用 MC/WC 结尾的属性会直接抛异常
['positionMC', 'normalMC', 'tangentMC', 'bitangentMC'].forEach((a) => {
  if (fsAttrs.includes(a)) {
    fail++;
    console.log(`[Cesium扫描] 片元登记了 ${a}: BAD（Cesium 会抛 "not available in the fragment shader"）`);
  }
});

// 注释里不得出现会被扫到的属性引用（这就是上次漏掉的那一类）
const commentHits = [];
[['VERTEX', U.VERTEX_SHADER], ['FRAGMENT', U.FRAGMENT_SHADER]].forEach(([which, src]) => {
  src.split('\n').forEach((line, i) => {
    const c = line.indexOf('//');
    if (c < 0) return;
    const re = new RegExp(CESIUM_ATTR_RE.source, 'g');
    let m;
    while ((m = re.exec(line.slice(c))) !== null) commentHits.push(`${which} L${i + 1} "${m[0]}"`);
  });
});
if (commentHits.length) {
  fail += commentHits.length;
  console.log('[Cesium扫描] 注释里出现了会被登记的属性引用:', commentHits.join(' | '), 'BAD');
} else {
  console.log('[Cesium扫描] 注释中无属性引用: OK');
}

if (fail > 0) {
  console.log(`\n[结论] 着色器静态检查失败 ${fail} 项`);
  process.exitCode = 1;
} else {
  console.log('\n[结论] 着色器静态检查全部通过');
}

// ---------- 3. glb 结构校验 ----------
const SEG = 320, SIZE = 6000;
const buf = U.buildPlaneGlb(SEG, SIZE);
const dv = new DataView(buf);
const u8 = new Uint8Array(buf);

const magic = dv.getUint32(0, true);
const version = dv.getUint32(4, true);
const total = dv.getUint32(8, true);
console.log('\n[glb] magic=0x' + magic.toString(16), magic === 0x46546c67 ? 'OK' : 'BAD');
console.log('[glb] version=', version, version === 2 ? 'OK' : 'BAD');
console.log('[glb] total=', total, buf.byteLength === total ? 'OK' : 'BAD');

const jsonLen = dv.getUint32(12, true);
console.log('[glb] JSON chunk type=0x' + dv.getUint32(16, true).toString(16), 'OK');
const gltf = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + jsonLen)));
console.log('[glb] glTF JSON 解析: OK');

const binLenPos = 20 + jsonLen;
const binLen = dv.getUint32(binLenPos, true);
console.log('[glb] BIN chunk type=0x' + dv.getUint32(binLenPos + 4, true).toString(16), 'OK');
console.log('[glb] BIN chunk len=', binLen, '与余量一致:', binLen === total - binLenPos - 8 ? 'OK' : 'BAD');

const N = SEG + 1;
const vCount = N * N;
const iCount = SEG * SEG * 6;
console.log('[glb] 顶点数', gltf.accessors[0].count, '= 期望', vCount, gltf.accessors[0].count === vCount ? 'OK' : 'BAD');
console.log('[glb] 索引数', gltf.accessors[4].count, '= 期望', iCount, gltf.accessors[4].count === iCount ? 'OK' : 'BAD');

const SIZE_OF = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM_COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
let ok = true;
gltf.accessors.forEach((a, i) => {
  const bv = gltf.bufferViews[a.bufferView];
  const need = a.count * NUM_COMP[a.type] * SIZE_OF[a.componentType];
  const pass = bv.byteLength === need && bv.byteOffset % 4 === 0 && (bv.byteOffset + bv.byteLength) <= gltf.buffers[0].byteLength;
  if (!pass) ok = false;
  console.log(`[glb]   accessor[${i}] ${a.type}/${a.componentType} count=${a.count} bv.len=${bv.byteLength} (需 ${need}) ${pass ? 'OK' : 'BAD'}`);
});
console.log('[glb] accessor/bufferView 一致性:', ok ? 'OK' : 'FAIL');

const binStart = binLenPos + 8;
const pos = new Float32Array(buf, binStart + gltf.bufferViews[0].byteOffset, vCount * 3);
const tan = new Float32Array(buf, binStart + gltf.bufferViews[2].byteOffset, vCount * 4);
const nrm = new Float32Array(buf, binStart + gltf.bufferViews[1].byteOffset, vCount * 3);
console.log('[glb] POSITION[0] =', pos[0], pos[1], pos[2], ' POSITION[last] =', pos[vCount * 3 - 3], pos[vCount * 3 - 2], pos[vCount * 3 - 1]);
console.log('[glb] NORMAL[0] =', nrm[0], nrm[1], nrm[2]);
console.log('[glb] TANGENT[0] =', tan[0], tan[1], tan[2], tan[3]);
console.log('[glb] 材质 alphaMode =', gltf.materials[0].alphaMode, '/ doubleSided =', gltf.materials[0].doubleSided);
console.log('[glb] 文件大小 =', (total / 1024 / 1024).toFixed(2), 'MB');

// ---------- 4. 程序化法线贴图自检（用桩替代 Cesium.TextureUniform）----------
// 这一节是「水面反光/波浪看起来是均匀的」那个 bug 的回归护栏：
//   a) 采样器必须开 mipmap + 各向异性 —— 否则掠射角下细节必然糊掉，
//      只能靠把 tile 放大来回避，结果就是一层光滑光泽面（= 均匀）。
//   b) 高度场必须真的可平铺 —— 接缝处的差分要和内部同分布。
//   c) 坡度要有足够的非均匀性 —— CV 太低等于又退回「正弦叠加」那种规则网格。
globalThis.Cesium = {
  PixelFormat: { RGBA: 1 },
  PixelDatatype: { UNSIGNED_BYTE: 1 },
  TextureMinificationFilter: { NEAREST: 1, LINEAR: 2, LINEAR_MIPMAP_LINEAR: 6 },
  TextureMagnificationFilter: { NEAREST: 1, LINEAR: 2 },
  TextureUniform: class { constructor(o) { this.options = o; } },
};

let texFail = 0;
const NTS = 256;

function meanAbs(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += Math.abs(arr[i]);
  return s / arr.length;
}
function decodeSlope(data, size) {
  const n = size * size;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const nx = (data[i * 4] / 255) * 2 - 1;
    const ny = (data[i * 4 + 1] / 255) * 2 - 1;
    const nz = Math.max((data[i * 4 + 2] / 255) * 2 - 1, 1e-3);
    s[i] = Math.hypot(nx / nz, ny / nz);
  }
  return s;
}

const layerData = U.NORMAL_LAYERS.map((cfg, i) => {
  const tex = U.makeWaterNormalUniform(NTS, cfg);
  const o = tex.options;
  const data = o.typedArray;

  console.log(`\n[tex:layer${i}] 尺寸 ${o.width}x${o.height} 字节 ${data.length}`,
    data.length === NTS * NTS * 4 ? 'OK' : 'BAD');
  if (data.length !== NTS * NTS * 4) texFail++;

  // 4.1 采样器参数（"均匀"的首要成因）
  const mipOK = o.minificationFilter === globalThis.Cesium.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR;
  const anisoOK = (o.maximumAnisotropy || 1) > 1;
  const repOK = o.repeat === true;
  console.log(`[tex:layer${i}] minFilter=LINEAR_MIPMAP_LINEAR:${mipOK ? 'OK' : 'BAD'}`,
    `| anisotropy=${o.maximumAnisotropy}:${anisoOK ? 'OK' : 'BAD'}`,
    `| repeat:${repOK ? 'OK' : 'BAD'}`);
  if (!mipOK || !anisoOK || !repOK) texFail++;

  // 4.2 alpha 完整 / 法线朝外
  let badA = 0, sumB = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) badA++;
    sumB += data[i + 2];
  }
  const avgB = sumB / (data.length / 4);
  console.log(`[tex:layer${i}] alpha 异常像素=${badA}:${badA === 0 ? 'OK' : 'BAD'}`,
    `| 平均 B=${avgB.toFixed(1)}:${avgB > 128 ? 'OK(朝外)' : 'BAD'}`);
  if (badA !== 0 || avgB <= 128) texFail++;

  // 4.3 坡度非均匀性
  const slope = decodeSlope(data, NTS);
  const sMean = meanAbs(slope);
  let vSum = 0;
  for (let i = 0; i < slope.length; i++) vSum += (slope[i] - sMean) * (slope[i] - sMean);
  const cv = Math.sqrt(vSum / slope.length) / Math.max(sMean, 1e-6);
  const cvOK = cv > 0.25;
  console.log(`[tex:layer${i}] 坡度 CV=${cv.toFixed(3)}:${cvOK ? 'OK(有变化)' : 'BAD(过于均匀)'}`);
  if (!cvOK) texFail++;

  return data;
});

// 4.4 高度场可平铺：接缝跨列差分 与 内部相邻差分 应当同分布
const HT = 128;
U.NORMAL_LAYERS.forEach((cfg, i) => {
  const h = U.makeTileableHeightField(HT, cfg);
  const interior = new Float32Array(HT * (HT - 1));
  const seam = new Float32Array(HT);
  let k = 0;
  for (let y = 0; y < HT; y++) {
    const row = y * HT;
    for (let x = 0; x < HT - 1; x++) interior[k++] = h[row + x + 1] - h[row + x];
    seam[y] = h[row] - h[row + HT - 1];
  }
  const mi = meanAbs(interior), ms = meanAbs(seam);
  const ratio = ms / Math.max(mi, 1e-9);
  const okT = ratio < 2.2;
  console.log(`[tile:layer${i}] 接缝/内部 差分比=${ratio.toFixed(2)}:${okT ? 'OK(可平铺)' : 'BAD(接缝不连续)'}`);
  if (!okT) texFail++;
});

// 4.5 各层必须互不相同（同种子会让两层法线完全重合 → 等于少了一层）
let dupFail = 0;
for (let a = 0; a < layerData.length; a++) {
  for (let b = a + 1; b < layerData.length; b++) {
    const same = layerData[a].every((v, i) => v === layerData[b][i]);
    if (same) { dupFail++; console.log(`[tex] layer${a} 与 layer${b} 完全相同: BAD`); }
  }
}
console.log(`\n[tex] ${layerData.length} 层法线互不相同:${dupFail === 0 ? 'OK' : 'BAD'}`);
texFail += dupFail;

console.log('\n[结论] 法线贴图检查', texFail === 0 ? '全部通过' : `失败 ${texFail} 项`);
if (texFail > 0) process.exitCode = 1;
