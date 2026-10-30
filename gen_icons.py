"""Generate ReadBack PWA icons: a warm dark badge with a speech mark.
Run: uv run --with pillow gen_icons.py
"""
from PIL import Image, ImageDraw
import os

PAPER = (20, 18, 15, 255)
ACCENT = (217, 138, 43, 255)
INK = (237, 230, 218, 255)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)


def font(size):
    for p in (r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\seguisb.ttf",
              r"C:\Windows\Fonts\segoeuib.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            from PIL import ImageFont
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    from PIL import ImageFont
    return ImageFont.load_default()


def make(size, pad_ratio=0.0, maskable=False):
    img = Image.new("RGBA", (size, size), PAPER)
    d = ImageDraw.Draw(img)
    s = size
    pad = s * pad_ratio

    # three stacked "lines of text" on the left, one of them lit up
    bx = pad + s * 0.20
    bw = s * 0.46
    gap = s * 0.115
    top = pad + s * 0.315
    lh = s * 0.075
    widths = [1.0, 0.72, 1.0]
    for i, w in enumerate(widths):
        y = top + i * gap
        col = ACCENT if i == 1 else (110, 103, 92, 255)
        d.rounded_rectangle([bx, y, bx + bw * w, y + lh], radius=lh / 2, fill=col)

    # a speaker triangle with two sound arcs, bottom right
    cx = pad + s * 0.735
    cy = pad + s * 0.640
    u = s * 0.052
    d.polygon([(cx - u * 1.7, cy - u), (cx - u * 0.5, cy - u),
               (cx + u * 0.5, cy - u * 1.9), (cx + u * 0.5, cy + u * 1.9),
               (cx - u * 0.5, cy + u), (cx - u * 1.7, cy + u)], fill=INK)
    for i, r in enumerate((u * 2.1, u * 3.0)):
        bb = [cx + u * 0.9 - r, cy - r, cx + u * 0.9 + r, cy + r]
        d.arc(bb, start=-52, end=52, fill=ACCENT if i == 1 else INK, width=max(2, int(s * 0.026)))

    if maskable:
        # keep the art inside the safe circle
        inner = make(size, pad_ratio=0.10)
        img = Image.new("RGBA", (size, size), PAPER)
        img.paste(inner, (0, 0), inner)
    return img


for name, size in (("icon-512.png", 512), ("icon-192.png", 192),
                   ("apple-touch-icon.png", 180), ("icon-maskable-512.png", 512)):
    maskable = "maskable" in name
    im = make(size, 0.10 if maskable else 0.0, maskable=maskable)
    im.convert("RGB").save(os.path.join(OUT, name), "PNG", optimize=True)
    print("wrote", name, size)

# favicon
make(64).convert("RGB").save(os.path.join(OUT, "favicon.ico"), sizes=[(64, 64)])
print("wrote favicon.ico 64")
