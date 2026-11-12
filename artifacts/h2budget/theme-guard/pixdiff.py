"""Pixel-compare two folders of PNGs (the light before/after proof).
   python3 theme-guard/pixdiff.py <before> <after> [--mask 1440:1200,0,1440,48]
   → one line per file, exit 1 on any difference. `--mask WIDTH:x0,y0,x1,y1` blacks out one box in every
   still of that width before comparing (the top bar's right end, where the new Appearance button sits)."""
import sys, os
from PIL import Image, ImageChops
from PIL import ImageDraw
a, b = sys.argv[1], sys.argv[2]
masks = {}
for i, arg in enumerate(sys.argv):
    if arg == "--mask":
        w, box = sys.argv[i + 1].split(":")
        masks[int(w)] = tuple(int(v) for v in box.split(","))
def masked(im):
    m = masks.get(im.size[0])
    if m: ImageDraw.Draw(im).rectangle(m, fill=(0, 0, 0))
    return im
bad = 0
for f in sorted(os.listdir(a)):
    if not f.endswith(".png"): continue
    pb = os.path.join(b, f)
    if not os.path.exists(pb): print(f"MISSING {f}"); bad += 1; continue
    x, y = masked(Image.open(os.path.join(a, f)).convert("RGB")), masked(Image.open(pb).convert("RGB"))
    if x.size != y.size: print(f"SIZE    {f}: {x.size} vs {y.size}"); bad += 1; continue
    box = ImageChops.difference(x, y).getbbox()
    if box is None: print(f"same    {f}")
    else:
        d = ImageChops.difference(x, y).convert("L").point(lambda v: 255 if v else 0)
        n = sum(1 for v in d.getdata() if v)
        print(f"DIFF    {f}: {n} px in box {box}"); bad += 1
print(f"{bad} differing" if bad else "all identical")
sys.exit(1 if bad else 0)
