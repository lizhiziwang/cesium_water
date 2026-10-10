// _sync_inline.cjs —— 把 ue5-water-material.js 同步进 index.html 的标记块
//
// 为什么要这个脚本：index.html 是"单文件版"（双击即可打开），需要内联模块源码。
// 手抄两份必然漂移（本项目已经踩过一次），所以改用标记块 + 脚本注入。
//   node _sync_inline.cjs          # 写入
//   node _sync_inline.cjs --check  # 只检查是否一致（不写）
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const modPath = path.join(dir, 'ue5-water-material.js');
const htmlPath = path.join(dir, 'index.html');

const BEGIN = '/* ==BEGIN ue5-water-material.js== */';
const END = '/* ==END ue5-water-material.js== */';

const mod = fs.readFileSync(modPath, 'utf8').replace(/\s+$/, '') + '\n';
const html = fs.readFileSync(htmlPath, 'utf8');

const b = html.indexOf(BEGIN);
const e = html.indexOf(END);
if (b < 0 || e < 0 || e < b) {
  console.error('[sync] index.html 缺少内联标记块:', BEGIN, '/', END);
  process.exit(1);
}

const current = html.slice(b + BEGIN.length, e).replace(/^\n/, '').replace(/\n$/, '') + '\n';

if (process.argv.includes('--check')) {
  const same = current === mod;
  console.log('[sync] 内联副本与模块文件', same ? '一致 OK' : '不一致 BAD（跑 node _sync_inline.cjs 修复）');
  process.exitCode = same ? 0 : 1;
} else {
  const next = html.slice(0, b + BEGIN.length) + '\n' + mod + html.slice(e);
  fs.writeFileSync(htmlPath, next);
  console.log('[sync] 已把', mod.length, '字符的模块源码同步进 index.html');
}
