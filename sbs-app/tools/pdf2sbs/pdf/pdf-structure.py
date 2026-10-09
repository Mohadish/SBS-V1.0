import fitz, json, re, os
P = r'D:\Nadav-Avi\project\Elbit\doc-demo\DEMO.pdf'
OUT = r'E:\claude-temp\demo-pdf'
os.makedirs(OUT, exist_ok=True)
doc = fitz.open(P)

def clusters(rects, gap=6):
    """merge vertically/horizontally adjacent image tiles into figure regions"""
    rects = sorted(rects, key=lambda r: (r.y0, r.x0))
    out = []
    for r in rects:
        for c in out:
            # overlap in x and touching in y (or overlapping)
            if r.x0 < c.x1 + gap and r.x1 > c.x0 - gap and r.y0 < c.y1 + gap and r.y1 > c.y0 - gap:
                c.include_rect(r); break
        else:
            out.append(fitz.Rect(r))
    # second pass merge
    merged = True
    while merged:
        merged = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                a, b = out[i], out[j]
                if a.x0 < b.x1 + gap and a.x1 > b.x0 - gap and a.y0 < b.y1 + gap and a.y1 > b.y0 - gap:
                    a.include_rect(b); out.pop(j); merged = True; break
            if merged: break
    return out

report = []
txtdump = []
for pno in range(len(doc)):
    page = doc[pno]
    d = page.get_text('dict')
    lines = []
    for b in d['blocks']:
        for l in b.get('lines', []):
            t = ''.join(s['text'] for s in l['spans'])
            if t.strip():
                sz = max(s['size'] for s in l['spans'])
                bold = any(s['flags'] & 16 for s in l['spans'])
                lines.append({'y': round(l['bbox'][1], 1), 'x': round(l['bbox'][0], 1), 'size': round(sz, 1), 'bold': bold, 'text': t})
    lines.sort(key=lambda L: (L['y'], L['x']))
    caps = [L for L in lines if re.match(r'^\s*Figure \d+\s*:', L['text'])]
    imgs = [fitz.Rect(i['bbox']) for i in page.get_image_info()]
    img_cl = clusters(imgs)
    draws = [fitz.Rect(dr['rect']) for dr in page.get_drawings() if dr['rect'].width > 2 and dr['rect'].height > 2]
    report.append({'page': pno + 1, 'captions': [{'y': c['y'], 'text': c['text']} for c in caps],
                   'img_clusters': [[round(v) for v in (c.x0, c.y0, c.x1, c.y1)] for c in img_cl],
                   'n_tiles': len(imgs), 'n_draw': len(draws)})
    txtdump.append(f'=== PAGE {pno+1} ===')
    for L in lines:
        txtdump.append(f"{L['y']:6.1f} {L['x']:5.1f} {L['size']:4.1f}{'B' if L['bold'] else ' '} {L['text']}")
json.dump(report, open(os.path.join(OUT, 'structure.json'), 'w'), indent=1)
open(os.path.join(OUT, 'text-lines.txt'), 'w', encoding='utf-8').write('\n'.join(txtdump))
# sample page renders at 100 dpi for a look
for pno in (8, 12, 14, 19):
    pix = doc[pno].get_pixmap(matrix=fitz.Matrix(100 / 72, 100 / 72))
    pix.save(os.path.join(OUT, f'p{pno+1}-100dpi.png'))
# rawdict probe for the garbled words on p20
raw = doc[19].get_text('rawdict')
probe = []
for b in raw['blocks']:
    for l in b.get('lines', []):
        for s in l['spans']:
            t = ''.join(ch['c'] for ch in s['chars'])
            if 'etails' in t or 'rotocol' in t or 'IP is' in t:
                probe.append({'font': s['font'], 'size': round(s['size'], 1), 'text': t, 'codes': [hex(ord(ch['c'])) for ch in s['chars']][:40]})
print(json.dumps(probe, indent=1)[:3000])
print('captions total', sum(len(r['captions']) for r in report), '| pages with clusters', sum(1 for r in report if r['img_clusters']))
for r in report[12:36]:
    print(r['page'], 'caps', [c['text'][:28] for c in r['captions']], 'clusters', r['img_clusters'])
