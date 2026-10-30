"""Make a shareable QR card for ReadBack, then decode it to prove it scans.

Run: uv run --with qrcode --with pillow --with opencv-python-headless python gen_qr.py
"""
import os
from PIL import Image, ImageDraw, ImageFont
import qrcode

URL = "https://kosigbesan.github.io/readback/"
INK = (18, 16, 13)
PAPER = (244, 240, 231)
ACCENT = (201, 130, 31)
MUTE = (122, 114, 100)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "share")
os.makedirs(OUT, exist_ok=True)


def font(candidates, size):
    for p in candidates:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


SERIF = [r"C:\Windows\Fonts\georgia.ttf", r"C:\Windows\Fonts\times.ttf"]
SANS = [r"C:\Windows\Fonts\arialbd.ttf", r"C:\Windows\Fonts\segoeuib.ttf"]
MONO = [r"C:\Windows\Fonts\consola.ttf", r"C:\Windows\Fonts\cour.ttf"]

# --- the code itself, dark on light so any camera reads it ---
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=14, border=2)
qr.add_data(URL)
qr.make(fit=True)
code = qr.make_image(fill_color=INK, back_color=PAPER).convert("RGB")
cw, ch = code.size

# --- the card around it ---
W = cw + 120
H = ch + 300
card = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(card)

# a thin double rule at the top, printed page style
d.line([(60, 52), (W - 60, 52)], fill=INK, width=2)
d.line([(60, 58), (W - 60, 58)], fill=MUTE, width=1)

title = font(SERIF, 52)
d.text((60, 84), "ReadBack", font=title, fill=INK)
# the lit word, same trick as the app
tw = d.textlength("Read", font=title)
d.text((60 + tw, 84), "Back", font=title, fill=ACCENT)

sub = font(SANS, 19)
d.text((60, 156), "POINT YOUR CAMERA HERE", font=sub, fill=MUTE)

card.paste(code, (60, 200))

urlf = font(MONO, 17)
d.text((60, H - 78), URL.replace("https://", ""), font=urlf, fill=INK)
tail = font(SANS, 16)
d.text((60, H - 46), "Add to Home Screen, then it works with no signal.", font=tail, fill=MUTE)

path = os.path.join(OUT, "readback-qr.png")
card.save(path, "PNG", optimize=True)
print("wrote", path, card.size)

# --- prove it scans ---
try:
    import cv2
    img = cv2.imread(path)
    detector = cv2.QRCodeDetector()
    data, points, _ = detector.detectAndDecode(img)
    print("decoded:", repr(data))
    if data == URL:
        print("QR VERIFIED: it resolves to the app")
    else:
        print("QR MISMATCH, wanted", URL)
except Exception as e:
    print("could not decode to verify:", e)
