# -*- coding: utf-8 -*-
"""灰斑检测：找水面里"饱和度明显低于周围"的连通区域（用户所说的"灰色斑块"）。

用法：
    python _patch_detect.py <渲染图.png> [--out <标注图.png>] [--drop 12] [--minarea 300]

原理：
  1. 只在水面区域统计（排除天空/陆地：亮度门限 + 只统计地平线以下的像素）。
  2. 取水面饱和度的中位数作为基准，标记 sat < median - drop 的像素。
  3. 形态学去噪后取连通域，面积 > minarea 的即"灰斑"，输出包围盒与均值。
  4. 同时输出整幅水面的饱和度分布（分位数），便于判断是"整体偏低"还是"局部塌陷"。
"""
import sys
from PIL import Image, ImageDraw

args = sys.argv[1:]
if not args:
    print(__doc__)
    sys.exit(1)
src = args[0]
def opt(name, d):
    return args[args.index(name) + 1] if name in args else d
out = opt('--out', src.rsplit('.', 1)[0] + '_patchmask.png')
DROP = float(opt('--drop', 12))
MINAREA = int(opt('--minarea', 300))

img = Image.open(src).convert('RGB')
W, H = img.size
px = img.load()

def sat_lum(p):
    r, g, b = p
    mx, mn = max(r, g, b), min(r, g, b)
    s = (mx - mn) / mx * 100 if mx else 0
    return s, 0.299 * r + 0.587 * g + 0.114 * b

# ---- 1. 水面掩膜：地平线以下 + 亮度在水范围内 ----
# 地平线：从上往下找第一行出现"大片较亮"的位置；简化为取 H*0.30 以下，再按亮度过滤
sats = []
for y in range(int(H * 0.30), H, 2):
    for x in range(0, W, 2):
        s, l = sat_lum(px[x, y])
        if 20 < l < 215:
            sats.append(s)
sats.sort()
if not sats:
    print('no water pixels'); sys.exit(0)
med = sats[len(sats) // 2]
q = lambda p: sats[min(len(sats) - 1, int(len(sats) * p))]
print(f'{src}  {W}x{H}')
print(f'  水面饱和度分位: p5={q(.05):.0f} p25={q(.25):.0f} p50={med:.0f} p75={q(.75):.0f} p95={q(.95):.0f}')

TH = med - DROP
mask = [[False] * W for _ in range(H)]
for y in range(int(H * 0.30), H):
    for x in range(W):
        s, l = sat_lum(px[x, y])
        if 20 < l < 215 and s < TH:
            mask[y][x] = True

# ---- 2. 连通域（4 邻域，迭代栈实现）----
seen = [[False] * W for _ in range(H)]
patches = []
for y in range(int(H * 0.30), H, 2):
    for x in range(0, W, 2):
        if mask[y][x] and not seen[y][x]:
            stack = [(x, y)]; seen[y][x] = True
            cnt = 0; sx = sy = ss = sl = 0
            minx = maxx = x; miny = maxy = y
            while stack:
                cx, cy = stack.pop()
                cnt += 1
                s, l = sat_lum(px[cx, cy]); sx += cx; sy += cy; ss += s; sl += l
                if cx < minx: minx = cx
                if cx > maxx: maxx = cx
                if cy < miny: miny = cy
                if cy > maxy: maxy = cy
                for dx, dy in ((2, 0), (-2, 0), (0, 2), (0, -2)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < W and 0 <= ny < H and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True; stack.append((nx, ny))
            if cnt >= MINAREA / 4:
                patches.append((cnt * 4, minx, miny, maxx, maxy, ss / cnt, sl / cnt))

patches.sort(reverse=True)
print(f'  基准 sat={med:.0f} 阈值 sat<{TH:.0f}  连通域(面积>=~{MINAREA}px): {len(patches)} 个')
for i, (area, x0, y0, x1, y1, s, l) in enumerate(patches[:8]):
    print(f'    #{i+1} 面积~{area}px  bbox=({x0},{y0})-({x1},{y1})  '
          f'{100*(x1-x0)/W:.0f}%x{100*(y1-y0)/H:.0f}%  均值 sat={s:.0f} lum={l:.0f}')

# ---- 3. 标注图 ----
ann = img.copy(); d = ImageDraw.Draw(ann)
for area, x0, y0, x1, y1, s, l in patches:
    d.rectangle([x0, y0, x1, y1], outline=(255, 40, 40), width=3)
ann.save(out)
print(f'  标注图 → {out}')
