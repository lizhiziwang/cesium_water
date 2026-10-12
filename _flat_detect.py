# 局部平坦度检测：找渲染图里"波纹对比度塌陷"的灰板区域
from PIL import Image
import statistics

def flat_mask(src, dst):
    img = Image.open(src).convert("RGB")
    W, H = img.size
    px = img.load()
    # 灰度
    lum = [[0.2126*px[x,y][0] + 0.7152*px[x,y][1] + 0.0722*px[x,y][2]
            for x in range(W)] for y in range(H)]
    out = img.copy()
    opx = out.load()
    R = 10          # 局部窗口半径（波纹尺度）
    flat_cnt = 0
    for y in range(R, H-R, 2):
        for x in range(R, W-R, 2):
            win = []
            for yy in range(y-R, y+R+1, 2):
                row = lum[yy]
                win.extend(row[x-R:x+R+1:2])
            s = statistics.pstdev(win)
            # 水面区域（排除天空：亮度<200 且 y 在地平线下）且局部 σ 很低 → 灰板
            if s < 3.0 and lum[y][x] < 205 and y > H*0.35:
                opx[x, y] = (255, 0, 0)
                flat_cnt += 1
    out.save(dst)
    print(f"{src}: 灰板像素标记 {flat_cnt}")

flat_mask(r"D:\code\ue5-water-customshader\_fix5.png",
          r"D:\code\ue5-water-customshader\_mask_5.png")
