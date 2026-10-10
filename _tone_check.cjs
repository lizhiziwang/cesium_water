// _tone_check.cjs —— 量测场景视角截图里「水面 patch」与「周围影像海面」的平均色差
// 用法: node _tone_check.cjs <png1> <png2> ...
// 依赖: PNG 解码用 zlib 原生 inflate + 自写 PNG 行过滤（24bit truecolor / RGBA8）
const fs = require('fs');
const zlib = require('zlib');

function decodePng(file) {
  const buf = fs.readFileSync(file);
  let p = 8; const out = {};
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      out.w = data.readUInt32BE(0); out.h = data.readUInt32BE(4);
      out.bitDepth = data[8]; out.colorType = data[9];
    } else if (type === 'IDAT') {
      out.idat = out.idat ? Buffer.concat([out.idat, data]) : data;
    } else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (out.colorType !== 6 && out.colorType !== 2) throw new Error('只支持 RGBA8/RGB8: ' + file);
  const bpp = out.colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(out.idat);
  const stride = out.w * bpp;
  const img = Buffer.alloc(out.h * stride);
  let pos = 0;
  for (let y = 0; y < out.h; y++) {
    const filter = raw[pos++];
    const row = raw.slice(pos, pos + stride); pos += stride;
    const prev = y > 0 ? img.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = img.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  out.data = img; out.bpp = bpp;
  return out;
}

// 采样矩形区域的平均 RGB
function avg(img, x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.w + x) * img.bpp;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  }
  return [r / n, g / n, b / n].map((v) => Math.round(v));
}

const files = process.argv.slice(2);
if (!files.length) { console.log('用法: node _tone_check.cjs <png>...'); process.exit(0); }
// 1080x480 截图（probe 输出）；patch 大致在中间菱形区，四周是影像
for (const f of files) {
  const img = decodePng(f);
  const W = img.w, H = img.h;
  const patch = avg(img, Math.round(W * 0.36), Math.round(H * 0.52), Math.round(W * 0.52), Math.round(H * 0.72));
  const sea = avg(img, Math.round(W * 0.04), Math.round(H * 0.55), Math.round(W * 0.16), Math.round(H * 0.80));
  const fmt = (c) => 'rgb(' + c.join(',') + ')';
  const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toFixed(0);
  console.log(f);
  console.log('  patch(水面): ' + fmt(patch) + ' 亮度 ' + lum(patch));
  console.log('  sea  (影像): ' + fmt(sea) + ' 亮度 ' + lum(sea));
  console.log('  亮度差 patch-sea: ' + (lum(patch) - lum(sea)));
}
