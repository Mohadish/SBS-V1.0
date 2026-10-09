# -*- coding: utf-8 -*-
"""Curated steps → steps.json; figure PNGs → web-sized JPEG/PNG (longest side ≤ 1920, like the app's own import)."""
import os, json, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from steps_data import ROWS, CH
OUT = r'D:\Nadav-Avi\project\Elbit\doc-demo\DEMO-sbs'
MEDIA = os.path.join(OUT, 'media')
os.makedirs(MEDIA, exist_ok=True)
images = json.load(open(os.path.join(os.path.dirname(__file__), 'images.json')))
web = {}
for key, info in images.items():
    im = Image.open(info['path'])
    W, H = im.size
    alpha = im.mode in ('RGBA', 'LA') and im.getextrema()[-1][0] < 255
    s = min(1.0, 1920 / max(W, H))
    if s < 1: im = im.resize((round(W * s), round(H * s)), Image.LANCZOS)
    name = key.replace('F', 'fig').replace('T', 'table')
    if alpha or max(im.size) < 400:
        path = os.path.join(MEDIA, name + '.png'); im.save(path, optimize=True)
    else:
        path = os.path.join(MEDIA, name + '.jpg'); im.convert('RGB').save(path, quality=90, optimize=True)
    web[key] = {'path': path, 'w': im.size[0], 'h': im.size[1], 'caption': info.get('caption', '')}
json.dump({'chapters': CH, 'rows': ROWS, 'images': web, 'source': 'DEMO.pdf (020389D-06 Rev A-)'},
          open(os.path.join(OUT, 'steps.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
tot = sum(os.path.getsize(v['path']) for v in web.values())
print('steps', len(ROWS), 'chapters', len(CH), 'images', len(web), 'media MB', round(tot / 1e6, 1), '→', OUT)
