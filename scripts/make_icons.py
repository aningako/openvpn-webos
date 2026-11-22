#!/usr/bin/env python3
"""Draw the OpenVPN for webOS icons (original artwork, not the OpenVPN logo): icon.png 80x80, largeIcon.png 130x130,
plus a 512px preview in docs/."""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'app', 'com.homebrew.openvpn')


def draw(size):
    S = size * 4
    im = Image.new('RGB', (S, S))
    px = im.load()
    for y in range(S):                      # deep navy gradient
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = (int(22 * (1 - t) + 9 * t), int(44 * (1 - t) + 20 * t), int(86 * (1 - t) + 42 * t))
    d = ImageDraw.Draw(im)
    # shield
    cx, top, w, h = S / 2, S * 0.14, S * 0.56, S * 0.72
    pts = [(cx, top), (cx + w / 2, top + h * 0.13), (cx + w / 2, top + h * 0.48), (cx, top + h), (cx - w / 2, top + h * 0.48), (cx - w / 2, top + h * 0.13)]
    d.polygon(pts, fill=(240, 138, 36))
    inner = [(cx, top + S * 0.05), (cx + w / 2 - S * 0.05, top + h * 0.13 + S * 0.03), (cx + w / 2 - S * 0.05, top + h * 0.47),
             (cx, top + h - S * 0.07), (cx - w / 2 + S * 0.05, top + h * 0.47), (cx - w / 2 + S * 0.05, top + h * 0.13 + S * 0.03)]
    d.polygon(inner, fill=(14, 28, 54))
    # keyhole
    r = S * 0.075
    ky = top + h * 0.42
    d.ellipse([cx - r, ky - r, cx + r, ky + r], fill=(240, 138, 36))
    d.polygon([(cx - r * 0.55, ky), (cx + r * 0.55, ky), (cx + r * 0.9, ky + S * 0.17), (cx - r * 0.9, ky + S * 0.17)], fill=(240, 138, 36))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.2, fill=255)
    bg = Image.new('RGB', (S, S), (11, 20, 36))
    bg.paste(im, (0, 0), mask)
    return bg.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    draw(80).save(os.path.join(OUT, 'icon.png'))
    draw(130).save(os.path.join(OUT, 'largeIcon.png'))
    os.makedirs(os.path.join(ROOT, 'docs'), exist_ok=True)
    draw(512).save(os.path.join(ROOT, 'docs', 'icon-512.png'))
    print('icons written')
