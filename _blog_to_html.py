# -*- coding: utf-8 -*-
"""把 docs/BLOG.md 转成单文件 HTML：内嵌压缩图片（宽 1200 / JPEG q82），零外部依赖。
用法：python _blog_to_html.py   → 输出 blog.html
"""
import base64, io, os, re, sys
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))  # 项目根（本脚本就放在根目录）
MD = os.path.join(ROOT, 'docs', 'BLOG.md')
OUT = os.path.join(ROOT, 'blog.html')

def img_data(path):
    fp = os.path.normpath(os.path.join(ROOT, 'docs', path))
    im = Image.open(fp).convert('RGB')
    if im.width > 1200:
        im = im.resize((1200, int(im.height * 1200 / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=82, optimize=True)
    return base64.b64encode(buf.getvalue()).decode()

def img_embed(m):
    alt, path = m.group(1), m.group(2)
    return (f'<figure><img src="data:image/jpeg;base64,{img_data(path)}" alt="{alt}">'
            f'<figcaption>{alt}</figcaption></figure>')

def inline(t):
    t = t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)',
               lambda m: f'<img src="data:image/jpeg;base64,{img_data(m.group(2))}" alt="{m.group(1)}" '
                         f'style="width:100%;border-radius:6px">', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<!\*)\*([^*\n]+)\*(?!\*)', r'<em>\1</em>', t)
    return t

def render(md):
    out, i, lines = [], 0, md.split('\n')
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s:
            i += 1; continue
        if s.startswith('![') :                                        # 图片
            out.append(re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', img_embed, s)); i += 1; continue
        if s.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s\-|]+\|$', lines[i+1].strip()):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            head, body = rows[0], rows[2:]
            o = ['<table><thead><tr>'] + [f'<th>{inline(c)}</th>' for c in head] + ['</tr></thead><tbody>']
            for r in body:
                o.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>')
            o.append('</tbody></table>')
            out.append(''.join(o)); continue
        if s.startswith('###'):
            out.append(f'<h3>{inline(s.lstrip("#"))}</h3>'); i += 1; continue
        if s.startswith('##'):
            out.append(f'<h2>{inline(s.lstrip("#"))}</h2>'); i += 1; continue
        if s.startswith('#'):
            out.append(f'<h1>{inline(s.lstrip("#"))}</h1>'); i += 1; continue
        if s == '---':
            out.append('<hr>'); i += 1; continue
        if s.startswith('>'):
            out.append(f'<blockquote>{inline(s.lstrip("> ").strip())}</blockquote>'); i += 1; continue
        if s.startswith('- '):
            items = []
            while i < len(lines) and lines[i].strip().startswith('- '):
                items.append(f'<li>{inline(lines[i].strip()[2:])}</li>'); i += 1
            out.append('<ul>' + ''.join(items) + '</ul>'); continue
        # 普通段落（连续非空行合并）
        para = [s]; i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(#|\||\- |>|!\[|---$)', lines[i].strip()):
            para.append(lines[i].strip()); i += 1
        out.append(f'<p>{inline(" ".join(para))}</p>')
    return '\n'.join(out)

md = io.open(MD, encoding='utf-8').read()
body = render(md)

html = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>我在浏览器里复刻了 UE5 的水面 —— 以及把它修"蓝"的那些坑</title>
<style>
  :root { --ink:#1d2733; --sub:#5a6b7d; --accent:#0f6ea8; --line:#e3eaf1; --bg:#fbfdff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.9 -apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
  main { max-width:860px; margin:0 auto; padding:56px 24px 80px; }
  h1 { font-size:30px; line-height:1.4; margin:0 0 8px; letter-spacing:.5px; }
  h2 { font-size:23px; margin:56px 0 14px; padding-left:14px; border-left:4px solid var(--accent); }
  h3 { font-size:19px; margin:40px 0 10px; color:var(--accent); }
  p  { margin:14px 0; color:#28394a; }
  blockquote { margin:22px 0; padding:12px 18px; background:#eef6fc; border-left:4px solid var(--accent);
               color:#3c5a74; border-radius:0 8px 8px 0; }
  blockquote p { margin:0; color:inherit; }
  figure { margin:26px 0; }
  figure img { width:100%; display:block; border-radius:10px; box-shadow:0 2px 14px rgba(15,60,100,.12); }
  figcaption { text-align:center; font-size:13px; color:var(--sub); margin-top:8px; }
  table { width:100%; border-collapse:collapse; margin:22px 0; font-size:14.5px; }
  th,td { border:1px solid var(--line); padding:9px 12px; text-align:left; vertical-align:top; }
  th { background:#f0f7fc; }
  td img { width:100%; display:block; border-radius:6px; }
  code { background:#eef2f6; padding:2px 7px; border-radius:5px;
         font:13.5px/1.6 Consolas,"JetBrains Mono",monospace; color:#0b4f7a; }
  hr { border:0; border-top:1px solid var(--line); margin:44px 0; }
  em { color:var(--sub); font-style:normal; font-size:14.5px; }
  .meta { color:var(--sub); font-size:13.5px; margin-bottom:34px; }
</style>
</head>
<body><main>
__BODY__
</main></body></html>'''

html = html.replace('__BODY__', body)
io.open(OUT, 'w', encoding='utf-8').write(html)
print(f'written {OUT}  ({os.path.getsize(OUT)/1e6:.1f} MB)')
