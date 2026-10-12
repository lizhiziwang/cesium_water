// _img_measure.cjs —— 任意图片（含 JPEG）的分带取色 / 局部对比度（零依赖）
//
// 为什么需要它：_img_diff.cjs 只能读 PNG（自己实现的无依赖解码器），但用户反馈的
// 截图是系统剪贴板的 JPEG。本机又没有 PIL / ImageMagick / ffmpeg。于是借
// Playwright 缓存的 Chromium 开一次 headless，把图片画进 canvas 用浏览器解码 ——
// 又准又不用装任何东西。图片必须放在本项目目录内（同源，否则 canvas 被污染）。
//
// 用法：
//   node _img_measure.cjs _user_shot.jpg                  # 默认把画面纵向切 10 带逐带报色
//   node _img_measure.cjs a.jpg --bands 6                 # 自定义带数
//   node _img_measure.cjs a.jpg --roi 0.37 0.60           # 只测某一纵向区间
//   node _img_measure.cjs a.jpg --cols 3                  # 再横向切 3 列（看左右差异/太阳侧）
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = __dirname;
const PORT = 8713;
const CDP_PORT = 9334;

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FILES = argv.filter((a) => /\.(png|jpe?g)$/i.test(a));
const roiI = argv.indexOf('--roi');
const ROI = roiI >= 0 ? [parseFloat(argv[roiI + 1]), parseFloat(argv[roiI + 2])] : null;
const BANDS = parseInt(argOf('--bands', ROI ? '1' : '10'), 10);
const COLS = parseInt(argOf('--cols', '1'), 10);

if (!FILES.length) { console.error('用法: node _img_measure.cjs <图片> [--bands N] [--roi a b] [--cols K]'); process.exit(2); }

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter((p) => p && fs.existsSync(p));
  for (const root of roots) {
    for (const d of fs.readdirSync(root)) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const MEASURE_HTML = `<!doctype html><html><body style="margin:0">
<script>
window.__ready = false;
window.__result = null;
window.__measure = function (src, roi, bands, cols) {
  var img = new Image();
  img.onload = function () {
    var c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    var W = c.width, H = c.height;
    var px = g.getImageData(0, 0, W, H).data;
    var y0 = Math.max(0, Math.floor((roi ? roi[0] : 0) * H));
    var y1 = Math.min(H, Math.ceil((roi ? roi[1] : 1) * H));
    function bandMean(bx0, bx1, by0, by1) {
      var sr = 0, sg = 0, sb = 0, n = 0;
      for (var y = by0; y < by1; y++) for (var x = bx0; x < bx1; x++) {
        var i = (y * W + x) * 4; sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n++;
      }
      sr /= n; sg /= n; sb /= n;
      return [sr / 255, sg / 255, sb / 255, (0.2126 * sr + 0.7152 * sg + 0.0722 * sb) / 255];
    }
    function bandContrast(bx0, bx1, by0, by1) {
      var s = 0, n = 0;
      for (var y = by0; y < by1; y++) for (var x = bx0; x + 1 < bx1; x++) {
        var i = (y * W + x) * 4, j = i + 4;
        s += Math.abs(0.2126 * (px[i] - px[j]) + 0.7152 * (px[i + 1] - px[j + 1]) + 0.0722 * (px[i + 2] - px[j + 2]));
        n++;
      }
      return s / n / 255;
    }
    var out = { w: W, h: H, rows: [] };
    for (var b = 0; b < bands; b++) {
      var by0 = y0 + Math.round((y1 - y0) * b / bands);
      var by1 = y0 + Math.round((y1 - y0) * (b + 1) / bands);
      var row = { frac: [(by0 / H), (by1 / H)], cells: [] };
      for (var k = 0; k < cols; k++) {
        var bx0 = Math.round(W * k / cols), bx1 = Math.round(W * (k + 1) / cols);
        row.cells.push({ mean: bandMean(bx0, bx1, by0, by1), contrast: bandContrast(bx0, bx1, by0, by1) });
      }
      out.rows.push(row);
    }
    window.__result = out;
    window.__ready = true;
  };
  img.onerror = function () { window.__result = { error: 'load-failed' }; window.__ready = true; };
  img.src = src;
};
<\/script></body></html>`;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/_measure') {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(MEASURE_HTML); return;
  }
  const fp = path.resolve(DIR, '.' + p);
  if (!fp.startsWith(DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error))); else res(msg.result);
      }
    });
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const CHROME = findChrome();
  if (!CHROME) { console.error('[measure] 找不到 Chromium（可设 CHROME_PATH）'); process.exit(2); }
  const userDataDir = path.join(DIR, '..', '.probe', 'udd-measure');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  let child = null;
  try {
    await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
    child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-extensions',
      '--disable-background-networking', '--mute-audio', '--hide-scrollbars',
      `http://127.0.0.1:${PORT}/_measure`], { stdio: ['ignore', 'ignore', 'ignore'] });

    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        targets = v.filter((t) => t.type === 'page');
        if (targets.length) break;
      } catch (_) {}
      await sleep(500);
    }
    if (!targets || !targets.length) throw new Error('DevTools 端点未就绪');
    const cdp = await connectCdp(targets[0].webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    for (const f of FILES) {
      const abs = path.resolve(f);
      const rel = path.relative(DIR, abs).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) { console.log(`[skip] ${f} 不在项目目录内（canvas 同源要求）`); continue; }
      const base = rel;
      const expr = `(function(){ window.__ready=false; window.__measure(${JSON.stringify('/' + base)}, ${JSON.stringify(ROI)}, ${BANDS}, ${COLS}); return 'go'; })()`;
      await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      let res = null;
      for (let i = 0; i < 40; i++) {
        const r = await cdp.send('Runtime.evaluate', { expression: 'window.__result', returnByValue: true });
        if (r.result && r.result.value) { res = r.result.value; break; }
        await sleep(300);
      }
      console.log(`\n=== ${base} ===`);
      if (!res || res.error) { console.log('  读取失败', res && res.error); continue; }
      console.log(`  尺寸 ${res.w}x${res.h}   纵向带数 ${BANDS}   横向列数 ${COLS}`);
      console.log('  纵向区间     ' + Array.from({ length: COLS }, (_, k) => `列${k + 1}(R G B  L   对比度)`).join('   '));
      res.rows.forEach((row, bi) => {
        const tag = `y[${row.frac[0].toFixed(2)},${row.frac[1].toFixed(2)}]`;
        const cells = row.cells.map((c) => `${c.mean[0].toFixed(3)} ${c.mean[1].toFixed(3)} ${c.mean[2].toFixed(3)} L${c.mean[3].toFixed(3)} ${(c.contrast * 100).toFixed(2)}%`);
        console.log(`  ${tag.padEnd(12)} ` + cells.join('   '));
      });
      const all = res.rows.flatMap((r) => r.cells);
      const avg = [0, 1, 2, 3].map((k) => all.reduce((s, c) => s + c.mean[k], 0) / all.length);
      console.log(`  合计平均     R${avg[0].toFixed(3)} G${avg[1].toFixed(3)} B${avg[2].toFixed(3)} L${avg[3].toFixed(3)}  蓝度(B-R)=${(avg[2] - avg[0]).toFixed(3)}`);
    }
    cdp.close();
  } catch (e) {
    console.error('[measure] 失败：', e.message);
    process.exitCode = 2;
  } finally {
    try { if (child) child.kill(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }
  process.exit();
})();
