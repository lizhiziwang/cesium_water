// _render_probe.cjs —— 无头渲染探针（零依赖）
//
// 为什么需要它：静态检查（_verify_glb.cjs）只能保证 JS 语法和 GLSL 的"文本形态"没问题，
// 但 Cesium 会在运行时把 CustomShader 拼进它自己的 shader 模板里，真正的编译结果只有 GPU 知道。
// 这个脚本用 Playwright 缓存的 Chromium（SwiftShader 软件渲染）真的把页面跑起来，
// 把页面里的启动进度（window.__diagItems，原诊断面板的数据）抓回来，并截一张图 ——
// 于是「着色器到底能不能编译」和「看起来什么样」都能在没有人工介入的情况下验证。
//
// 依赖：Node >= 22（用内置 fetch / WebSocket 直连 CDP，不装任何 npm 包）。
//
// 用法：
//   node _render_probe.cjs                     # 默认 ocean 预设、掠射视角
//   node _render_probe.cjs --top               # 切到俯视视角再截图
//   node _render_probe.cjs --preset lake       # 换预设
//   node _render_probe.cjs --out shot.png      # 指定输出图
//   node _render_probe.cjs --keep-ui           # 保留参数面板一起截图
//   node _render_probe.cjs --timescale 2        # 设 uTimeScale（0 = 静止）
//   node _render_probe.cjs --motion-check       # 间隔 2.5 s 截两张，判断有没有在动
//   node _render_probe.cjs --timeout 120000    # 自定义等待上限(ms)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const DIR = __dirname;
const PORT = 8712;
const CDP_PORT = 9333;

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const WANT_TOP = hasFlag('--top');
const WANT_SCENE = hasFlag('--scene');   // 场景视角：拉远看面片与真实影像海面的衔接
const WANT_UNDERWATER = hasFlag('--underwater');   // 潜到水面以下（验证水下效果）
const PRESET = argOf('--preset', 'ocean');
const OUT = path.resolve(DIR, argOf('--out', 'shot.png'));
const KEEP_UI = hasFlag('--keep-ui');
const TIMEOUT = parseInt(argOf('--timeout', '120000'), 10);
const TIMESCALE = argOf('--timescale', null);
// 间隔两张截图比对：同一张 PNG 只要有一个像素变了，压缩后的字节流就会不同。
// 所以「字节完全一致」= 真的没动，足以判定 uTimeScale=0 的暂停是否生效。
const MOTION_CHECK = hasFlag('--motion-check');
const GAP = parseInt(argOf('--motion-gap', '2500'), 10);
const MOTION_EPS = parseFloat(argOf('--motion-eps', '0.5'));
// --uniform k=v（可重复）：调参扫描用
const UNIFORMS = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--uniform' && argv[i + 1]) UNIFORMS.push(argv[i + 1]);
}

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

const CHROME = findChrome();
if (!CHROME) {
  console.error('[probe] 找不到 Chromium。可设 CHROME_PATH 环境变量指向 chrome.exe');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.resolve(DIR, '.' + p);
  if (!fp.startsWith(DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    // no-store：本服务纯为调试预览，绝不能让浏览器缓存 —— 否则改完代码刷新还是旧版
    // （"改了没生效"的三大来源之一：缓存 / 看错文件 / 真没修好，先把第一种钉死）。
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

// ---- 极简 CDP 客户端（Node 22 内置 WebSocket）----
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const bus = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        bus.forEach((f) => f(msg));
      }
    });
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      on(f) { bus.push(f); },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败：' + wsUrl)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url);
  return r.json();
}

(async () => {
  let child = null;
  let cdp = null;
  let exitCode = 0;
  // 注意：Chromium 的 profile 目录必须放在工作区里。放到系统 %TEMP% 会被沙箱拦掉，
  // 表现是 chrome.exe 秒退且 DevTools 端口永远不监听。
  const userDataDir = path.join(DIR, '..', '.probe', 'udd');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  try {
    await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
    const pageUrl = `http://127.0.0.1:${PORT}/index.html`;
    console.log('[probe] 静态服务:', pageUrl);
    console.log('[probe] Chromium :', CHROME);

    const args = [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check',
      // 沙箱环境里必须关掉 chrome 自己的沙箱，否则进程起不来
      '--no-sandbox', '--disable-gpu-sandbox',
      '--disable-extensions', '--disable-background-networking',
      '--mute-audio', '--hide-scrollbars',
      // 软件渲染 + 允许 SwiftShader 提供 WebGL2
      '--enable-unsafe-swiftshader',
      '--use-gl=angle', '--use-angle=swiftshader',
      '--window-size=1600,900',
      pageUrl,
    ];
    child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (b) => {
      const s = String(b);
      if (/error|fail/i.test(s) && !/DevTools listening|Fontconfig|GPU stall|SwiftShader/i.test(s)) {
        process.stderr.write('[chrome] ' + s);
      }
    });

    // 等 DevTools 端点
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        const v = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        targets = v.filter((t) => t.type === 'page');
        if (targets.length) break;
      } catch (_) { /* 还没起来 */ }
      await sleep(500);
    }
    if (!targets || !targets.length) throw new Error('Chromium 的 DevTools 端点未就绪');

    const target = targets.find((t) => t.url.includes('index.html')) || targets[0];
    cdp = await connectCdp(target.webSocketDebuggerUrl);

    const logs = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push('[console.' + msg.params.type + '] ' +
          msg.params.args.map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        logs.push('[uncaught] ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        // 带上 URL —— 否则「404 (Not Found)」这种日志根本看不出是哪个资源
        logs.push('[log.' + e.level + '] ' + e.text + (e.url ? '  <' + e.url + '>' : ''));
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    const probe = `(function(){
      var items = (window.__diagItems || []).slice();
      var st = document.getElementById('status');
      return JSON.stringify({
        diagState: window.__diagState || '',
        status: st && st.style.display !== 'none' ? st.textContent : '',
        step: window.__currentStep || '',
        items: items,
        hasWater: !!document.querySelector('#cesiumContainer canvas')
      });
    })()`;

    const t0 = Date.now();
    let last = null;
    let settled = false;
    while (Date.now() - t0 < TIMEOUT) {
      const r = await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true });
      last = JSON.parse(r.result.value);
      const joined = last.items.join(' | ');
      if (/渲染错误|启动失败|启动失败|已中断/.test(joined) && !/^$/.test(joined)) { settled = true; break; }
      if (last.items.some((s) => s.indexOf('ok: 首帧渲染') === 0)) { settled = true; break; }
      await sleep(700);
    }
    const waited = ((Date.now() - t0) / 1000).toFixed(1);

    console.log('\n================ 诊断面板 ================');
    console.log('diagState :', last.diagState);
    if (last.status) console.log('status    :', last.status);
    console.log('当前步骤  :', last.step);
    last.items.forEach((s) => console.log('  ' + s));
    console.log('等待耗时  :', waited, 's');

    const errs = last.items.filter((s) => /^err:/.test(s));
    const hasFirstFrame = last.items.some((s) => /^ok: 首帧渲染/.test(s));
    if (errs.length) {
      console.log('\n[probe] 存在失败步骤 —— 着色器/启动有问题');
      exitCode = 1;
    } else if (!hasFirstFrame) {
      console.log('\n[probe] 未观察到「首帧渲染」成功标记（可能仍在加载，或渲染被静默阻断）');
      exitCode = 3;
    } else {
      console.log('\n[probe] 渲染链路正常（着色器编译通过）');
    }

    if (logs.length) {
      console.log('\n================ 浏览器控制台 ================');
      logs.slice(-40).forEach((l) => console.log('  ' + l));
    }

    // ---- 可选：切视角 / 换预设 / 调太阳与朝向，然后再等几帧 ----
    async function setSlider(id, v) {
      await cdp.send('Runtime.evaluate', {
        expression: `(function(){var e=document.getElementById('${id}');` +
          `if(!e) return; e.value=String(${v}); e.dispatchEvent(new Event('input'));})()`,
      });
    }
    if (WANT_TOP) {
      await cdp.send('Runtime.evaluate', { expression: `document.getElementById('btnTopView').click()` });
    }
    if (WANT_SCENE) {
      await cdp.send('Runtime.evaluate', { expression: `document.getElementById('btnSceneView').click()` });
    }
    if (WANT_UNDERWATER) {
      await cdp.send('Runtime.evaluate', { expression: `document.getElementById('btnDive').click()` });
    }
    if (PRESET && PRESET !== 'ocean') {
      await cdp.send('Runtime.evaluate', {
        expression: `document.querySelector('button[data-preset="${PRESET}"]').click()`,
      });
    }
    if (argOf('--hour', null) !== null) await setSlider('sunHour', argOf('--hour', '10.25'));
    if (argOf('--heading', null) !== null) await setSlider('camHeading', argOf('--heading', '295'));
    await sleep(2500);   // 让 uTime 前进若干帧，波纹/光路动起来

    // ---- 运动速度控制：设 uTimeScale ----
    if (TIMESCALE !== null) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){`
          + ` if (!window.__water) return 'no-water';`
          + ` window.__water.setTimeScale(${TIMESCALE});`
          + ` var e=document.getElementById('ctl_uTimeScale');`
          + ` if(e){ e.value=String(${TIMESCALE}); e.dispatchEvent(new Event('input')); }`
          + ` return 'ok'; })()`,
        returnByValue: true,
      });
      if (r.result.value !== 'ok') {
        console.log('[probe] 设置 uTimeScale 失败：', r.result.value);
        exitCode = 2;
      } else {
        console.log(`[probe] 已设 uTimeScale = ${TIMESCALE}`);
      }
      await sleep(1200);
    }

    // ---- 通用 uniform 覆盖：--uniform uHazeDensity=3.5e-5（可重复传）----
    // 调参扫描用：不用改源码就能试一组值。
    for (const kv of UNIFORMS) {
      const m = String(kv).match(/^([A-Za-z_]\w*)=(.+)$/);
      if (!m) { console.log('[probe] --uniform 格式应为 k=v，收到:', kv); exitCode = 2; continue; }
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){`
          // 水下后处理的参数（uGodRay* / uVignette / uShallowColor ...）在 __underwater 上，
          // 其余在 __water 上 —— 按 state 里有没有这个键来路由
          + ` var uw = window.__underwater;`
          + ` if (uw && uw.state && uw.state['${m[1]}'] !== undefined) {`
          + `   uw.setUniform('${m[1]}', Number('${m[2]}')); return 'ok-underwater'; }`
          + ` if (!window.__water) return 'no-water';`
          + ` window.__water.setUniform('${m[1]}', Number('${m[2]}'));`
          + ` var e=document.getElementById('ctl_${m[1]}');`
          + ` if(e){ e.value=String(${m[2]}); e.dispatchEvent(new Event('input')); }`
          + ` return 'ok'; })()`,
        returnByValue: true,
      });
      if (String(r.result.value).indexOf('ok') !== 0) {
        console.log('[probe] 设置 uniform 失败:', kv, '→', r.result.value);
        exitCode = 2;
      } else {
        console.log(`[probe] 已设 ${m[1]} = ${m[2]} (${r.result.value})`);
      }
    }
    if (UNIFORMS.length) await sleep(1200);

    // ---- 可选：切换底图（--basemap esri-ocean / osm / esri-imagery / none）----
    const BASEMAP = argOf('--basemap', null);
    if (BASEMAP) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){ if(!window.__setBaseMap) return 'no-fn'; window.__setBaseMap('${BASEMAP}');`
          + ` var s=document.getElementById('baseMapSel'); if(s) s.value='${BASEMAP}'; return 'ok'; })()`,
        returnByValue: true,
      });
      console.log('[probe] 切换底图 →', BASEMAP, ':', r.result.value);
    }

    // ---- 等影像瓦片加载完成 ----
    // 底图是异步瓦片流，不同次运行抓到的加载进度不同 —— 不等它，截图和色差测量都不可比。
    const tTiles = Date.now();
    let tilesLoaded = false;
    while (Date.now() - tTiles < 12000) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(window.__viewer && window.__viewer.scene && window.__viewer.scene.globe) ? window.__viewer.scene.globe.tilesLoaded : 'no-globe'`,
        returnByValue: true,
      });
      if (r.result.value === true) { tilesLoaded = true; break; }
      await sleep(500);
    }
    console.log('[probe] 影像瓦片:', tilesLoaded ? '加载完成' : '12s 超时（底图可能被墙/限流）',
      '(' + ((Date.now() - tTiles) / 1000).toFixed(1) + ' s)');
    await sleep(500);   // 让最后一帧把刚到的瓦片真正画出来

    // ---- 通用诊断：--eval "js 表达式"（在页面里求值并打印，排状态问题用）----
    // 支持 async：表达式返回 Promise 时等它 resolve（awaitPromise）——
    // 某些状态（如相机移动后的水下模式切换）要等 preUpdate 跑过才成立，同步读是旧值。
    if (argOf('--eval', null)) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){ try { return Promise.resolve(eval(${JSON.stringify(argOf('--eval', ''))})).then(function(v){ return JSON.stringify(String(v)); }); } catch (e) { return Promise.resolve('EVAL_ERROR: ' + e.message); } })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      console.log('[eval]', r.result.value);
    }

    // ---- 运动检测 ----
    // 不能用"PNG 字节是否相同"判断：任何亚像素级变化（连太阳的缓慢移动）
    // 都会改变压缩流。改成把截图丢回页面里降到 32×18 取平均亮度，比较平均绝对差，
    // 这样只有"肉眼可感"的运动才会被记为动。
    async function frameSignature(b64) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(async function(){
          var img = new Image();
          img.src = 'data:image/png;base64,${b64}';
          await img.decode();
          var W = 32, H = 18;
          var c = document.createElement('canvas'); c.width = W; c.height = H;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, W, H);
          var d = ctx.getImageData(0, 0, W, H).data;
          var out = new Array(W * H);
          for (var i = 0; i < W * H; i++) out[i] = (d[i*4] + d[i*4+1] + d[i*4+2]) / 3;
          return JSON.stringify(out);
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (!r.result || r.result.value === undefined) throw new Error('帧签名失败');
      return JSON.parse(r.result.value);
    }

    if (MOTION_CHECK) {
      const a = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
      await sleep(GAP);
      const b = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
      const sa = await frameSignature(a);
      const sb = await frameSignature(b);
      let sum = 0;
      for (let i = 0; i < sa.length; i++) sum += Math.abs(sa[i] - sb[i]);
      const mad = sum / sa.length;                       // 平均绝对亮度差 (0~255)
      const moved = mad > MOTION_EPS;
      console.log(`\n[probe] 运动检测：间隔 ${GAP} ms 两张截图，`
        + `平均亮度差 = ${mad.toFixed(3)} → ${moved ? '水在动' : '水是静止的'}`
        + `（阈值 ${MOTION_EPS}）`);
      if (TIMESCALE !== null && Number(TIMESCALE) === 0 && moved) {
        console.log('[probe] 警告：uTimeScale=0 但画面仍在变化，暂停未生效');
        exitCode = 1;
      }
      if (TIMESCALE !== null && Number(TIMESCALE) > 0 && !moved) {
        console.log('[probe] 警告：uTimeScale>0 但画面几乎没变，动画未生效');
        exitCode = 1;
      }
      fs.writeFileSync(OUT.replace(/\.png$/, '.motionA.png'), Buffer.from(a, 'base64'));
      fs.writeFileSync(OUT.replace(/\.png$/, '.motionB.png'), Buffer.from(b, 'base64'));
      console.log('[probe] 运动对比图:', path.basename(OUT.replace(/\.png$/, '.motionA.png')),
        '/', path.basename(OUT.replace(/\.png$/, '.motionB.png')));
    }

    // ---- UI 冒烟测试：折叠按钮是否真的把浮层收起来了 ----
    // 必须放在隐藏浮层之前；并先强制回"展开"态，否则会被上次持久化的折叠状态影响判读。
    if (hasFlag('--ui-check')) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){
          var out = [];
          [['hudToggle','hud']].forEach(function(p){
            var btn = document.getElementById(p[0]), el = document.getElementById(p[1]);
            if (!btn || !el) { out.push(p[1] + ': 按钮或目标缺失 BAD'); return; }
            el.style.display = '';
            el.classList.remove('collapsed');             // 强制回到展开
            var h0 = el.offsetHeight, w0 = el.offsetWidth;
            btn.click();
            var h1 = el.offsetHeight, w1 = el.offsetWidth, txt = btn.textContent, aria = btn.getAttribute('aria-expanded');
            btn.click();                                  // 复原，别影响后面的截图
            var h2 = el.offsetHeight, txt2 = btn.textContent;
            var ok = (h1 < h0) && (h2 === h0) && (h1 > 0);
            out.push(p[1] + ': ' + w0 + 'x' + h0 + ' -> ' + w1 + 'x' + h1 + ' -> ' + h2 +
                     ' | 文案 "' + txt + '"->"' + txt2 + '" | aria-expanded=' + aria + ' ' + (ok ? 'OK' : 'BAD'));
          });
          return out.join('\\n');
        })()`,
        returnByValue: true,
      });
      console.log('\n================ 折叠按钮检查 ================');
      const lines = String(r.result.value).split('\n');
      lines.forEach((l) => console.log('  ' + l));
      if (lines.some((l) => l.includes('BAD'))) exitCode = 1;
    }

    if (!KEEP_UI) {
      await cdp.send('Runtime.evaluate', {
        expression: `(function(){['panel','status','hud','hint','bootErrors'].forEach(function(id){var e=document.getElementById(id); if(e) e.style.display='none';});})()`,
      });
      await sleep(600);
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('\n[probe] 截图已保存:', OUT, '(' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB)');

  } catch (err) {
    console.error('[probe] 失败:', err && err.message || err);
    exitCode = 2;
  } finally {
    if (cdp) cdp.close();
    if (child) { try { child.kill(); } catch (_) {} }
    server.close();
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(exitCode);
  }
})();
