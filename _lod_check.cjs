// 正确指标：一个像素里塞了几个纹素（>1 = 被 mipmap 平均 → 糊）
const PLANE = 8000, TEX = 256, FOV = 90, PX = 1600;
const pxDeg = FOV / PX;
const texelsPerPx = (tileM, d) => ((tileM / d) * (180 / Math.PI) / pxDeg) / TEX;

console.log('每像素覆盖的纹素数（>1 就开始被 mipmap 平均，>>1 等于一片平色）\n');
console.log('层 / tile'.padEnd(22) + [500, 1000, 2000, 4000, 8000].map((d) => (d + 'm').padStart(9)).join(''));
for (const [name, tiling, gridMax] of [['粗 129m', 62, 4], ['中 40m', 200, 5], ['细 13m', 640, 6]]) {
  const tile = PLANE / tiling;
  let row = name.padEnd(22);
  for (const d of [500, 1000, 2000, 4000, 8000]) row += texelsPerPx(tile, d).toFixed(2).padStart(9);
  console.log(row);
}
console.log('\n关键不是纹素，是【最大特征尺寸】= tile/gridMax 在屏幕上还有几像素：\n');
console.log('层 / 最大特征'.padEnd(22) + [500, 1000, 2000, 4000, 8000].map((d) => (d + 'm').padStart(9)).join(''));
for (const [name, tiling, gridMax] of [['粗 129m / 32m', 62, 4], ['中 40m / 8m', 200, 5], ['细 13m / 2m', 640, 6]]) {
  const feat = (PLANE / tiling) / gridMax;
  let row = name.padEnd(22);
  for (const d of [500, 1000, 2000, 4000, 8000]) row += ((feat / d) * (180 / Math.PI) / pxDeg).toFixed(1).padStart(9);
  console.log(row);
}
console.log('\n-> 粗层 32m 特征在 2km 还有 16px、8km 还有 4px，结构其实"在"，');
console.log('   但它只有 uStrengthLow=0.40 的权重，且掠射时 fresnel≈1 让画面几乎全被');
console.log('   平滑的天空渐变占满。所以远场"没有结构"= 法线权重不足 + 天空反射太主导。');
