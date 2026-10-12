// _img_diff.cjs —— 两张 PNG 的差异 / 区域均值（零依赖）
//
// 用途：A/B 渲染对比时，肉眼看"差不多"不算数 —— 这里给逐像素均差、超阈值像素占比、
// 以及指定区域的平均色，把"改这一项到底有没有效果、变了多少"变成数字。
//
// 用法：
//   node _img_diff.cjs a.png b.png                 # 全图 + 下半部（水面）区域
//   node _img_diff.cjs a.png b.png --roi 0.35 1.0  # 自定义 ROI（上/下边界占高比例）
//   node _img_diff.cjs a.png --stats               # 只看单张图的区域均值
const fs = require('fs');
const zlib = require('zlib');

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;                       // 跳过签名
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8) throw new Error('只支持 8bit PNG，收到 ' + bitDepth);
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error('不支持的 colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {                      // Paeth
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

function roiStats(img, y0f, y1f) {
  const { w, h, ch, data } = img;
  const y0 = Math.floor(h * y0f), y1 = Math.floor(h * y1f);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
    }
  }
  return { r: sr / n / 255, g: sg / n / 255, b: sb / n / 255, lum: (0.2126 * sr + 0.7152 * sg + 0.0722 * sb) / n / 255 };
}

// 局部对比度：ROI 内相邻像素的灰度平均绝对差（只算水平/垂直一阶差分）
function contrast(img, y0f, y1f) {
  const { w, h, ch, data } = img;
  const y0 = Math.floor(h * y0f), y1 = Math.floor(h * y1f);
  const gray = (i) => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * ch;
      sum += Math.abs(gray(i) - gray(i + ch));
      n++;
      if (y + 1 < y1) sum += Math.abs(gray(i) - gray(i + w * ch));
      n++;
    }
  }
  return sum / n / 255;
}

function diff(a, b, y0f, y1f) {  if (a.w !== b.w || a.h !== b.h) throw new Error('尺寸不同');
  const { w, h, ch } = a;
  const y0 = Math.floor(h * y0f), y1 = Math.floor(h * y1f);
  let sum = 0, n = 0, over8 = 0, over24 = 0, max = 0;
  const hist = new Array(16).fill(0);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1])
        + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
      sum += d; n++;
      if (d > 8) over8++;
      if (d > 24) over24++;
      if (d > max) max = d;
      hist[Math.min(15, Math.floor(d / 8))]++;
    }
  }
  return { mean: sum / n / 255, over8: over8 / n, over24: over24 / n, max: max / 255, hist, n };
}

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--') && /\.png$/i.test(a));
const roiI = args.indexOf('--roi');
const y0f = roiI >= 0 ? parseFloat(args[roiI + 1]) : 0.38;
const y1f = roiI >= 0 ? parseFloat(args[roiI + 2]) : 1.0;

if (files.length === 1) {
  const img = decodePng(files[0]);
  console.log(`${files[0]}  ${img.w}x${img.h} ch=${img.ch}`);
  const s = roiStats(img, y0f, y1f);
  console.log(`  ROI y∈[${y0f},${y1f}] 平均色 (${s.r.toFixed(3)} ${s.g.toFixed(3)} ${s.b.toFixed(3)}) L=${s.lum.toFixed(3)}`);
  // 局部对比度：相邻像素平均绝对差（灰度）。判"大片无细节"用 —— 数值高 = 波纹结构明显。
  const c = contrast(img, y0f, y1f);
  console.log(`  局部对比度(相邻像素均差) ${(c * 255).toFixed(2)}/255  ≈ ${(c * 100).toFixed(2)}%`);
} else {
  const a = decodePng(files[0]), b = decodePng(files[1]);
  console.log(`${files[0]}  vs  ${files[1]}   (${a.w}x${a.h})`);
  for (const [name, y0, y1] of [['全图', 0, 1], ['水面 ROI', y0f, y1f]]) {
    const d = diff(a, b, y0, y1);
    const sa = roiStats(a, y0, y1), sb = roiStats(b, y0, y1);
    console.log(`  [${name}] 平均差 ${(d.mean * 255).toFixed(2)}/255 · >8 占 ${(d.over8 * 100).toFixed(1)}% · >24 占 ${(d.over24 * 100).toFixed(1)}% · 最大 ${(d.max * 255).toFixed(0)}`);
    console.log(`            A 平均色 (${sa.r.toFixed(3)} ${sa.g.toFixed(3)} ${sa.b.toFixed(3)}) L=${sa.lum.toFixed(3)}`);
    console.log(`            B 平均色 (${sb.r.toFixed(3)} ${sb.g.toFixed(3)} ${sb.b.toFixed(3)}) L=${sb.lum.toFixed(3)}   ΔL=${(sa.lum - sb.lum).toFixed(3)}`);
  }
}
