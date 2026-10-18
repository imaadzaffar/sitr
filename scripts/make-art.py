"""Draws the extension icons and the test feed's mock images. Run: python3 scripts/make-art.py"""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def font(size):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def icon(size):
    s = 512
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=112, fill=(15, 20, 25, 255))
    # a soft blurred blob behind a crisp eye-with-slash
    blob = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(blob).ellipse([110, 150, 402, 362], fill=(29, 155, 240, 200))
    img.alpha_composite(blob.filter(ImageFilter.GaussianBlur(38)))
    w = 30
    d.ellipse([196, 196, 316, 316], outline="white", width=w)
    d.arc([86, 130, 426, 470], 200, 340, fill="white", width=w)
    d.arc([86, 42, 426, 382], 20, 160, fill="white", width=w)
    d.line([132, 392, 380, 120], fill=(15, 20, 25, 255), width=w + 34)
    d.line([132, 392, 380, 120], fill="white", width=w)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=112, fill=255)
    img.putalpha(Image.composite(img.getchannel("A"), mask, mask))
    return img.resize((size, size), Image.LANCZOS)

for n in (16, 32, 48, 128):
    icon(n).save(os.path.join(ROOT, "extension", "icons", f"icon-{n}.png"))

def card(path, size, top, bottom, title, sub="", circle=False):
    w, h = size
    img = Image.new("RGB", size)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    f = font(max(22, w // 12))
    tw = d.textlength(title, font=f)
    d.text(((w - tw) / 2, h / 2 - (40 if sub else 20)), title, font=f, fill="white")
    if sub:
        f2 = font(max(14, w // 26))
        sw = d.textlength(sub, font=f2)
        d.text(((w - sw) / 2, h / 2 + 18), sub, font=f2, fill=(255, 255, 255))
    img.save(path, "JPEG", quality=85)  # baseline JPEG

F = os.path.join(ROOT, "test", "fixtures")
os.makedirs(F, exist_ok=True)
card(f"{F}/sunset.jpg", (680, 440), (255, 154, 98), (120, 70, 160), "Sunset at the pier", "clean photo")
card(f"{F}/cat.jpg", (680, 500), (90, 170, 120), (30, 90, 70), "My cat, Biscuit", "clean photo")
card(f"{F}/gore.jpg", (680, 440), (150, 10, 10), (60, 0, 0), "MOCK: GRAPHIC INJURY", "stand-in for a gory photo")
card(f"{F}/explicit.jpg", (680, 440), (230, 90, 160), (120, 20, 80), "MOCK: EXPLICIT", "stand-in for a nude photo")
card(f"{F}/poster-clean.jpg", (680, 383), (40, 60, 120), (10, 20, 50), "Video: product demo", "clean poster frame")
card(f"{F}/poster-violent.jpg", (680, 383), (90, 0, 0), (20, 0, 0), "MOCK: VIDEO OF A FIGHT", "stand-in for a violent clip")
card(f"{F}/panorama.jpg", (680, 200), (70, 130, 200), (30, 60, 120), "Wide panorama (under 280px tall)")
for name, top, bottom, letter in [
    ("avatar-a", (29, 155, 240), (10, 80, 160), "A"),
    ("avatar-b", (0, 186, 124), (0, 110, 70), "B"),
    ("avatar-c", (255, 173, 31), (200, 100, 0), "C"),
    ("avatar-d", (120, 86, 255), (60, 30, 160), "D"),
    ("avatar-e", (249, 24, 128), (150, 0, 70), "E"),
]:
    card(f"{F}/{name}.jpg", (400, 400), top, bottom, letter)
card(f"{F}/avatar-bad.jpg", (400, 400), (20, 20, 20), (60, 0, 0), "MOCK", "hate-symbol avatar")
print("ok")
