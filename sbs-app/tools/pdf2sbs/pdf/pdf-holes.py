"""Find the words that Print-To-PDF turned into vector outlines (missing from the text layer) and
render each affected text row into a per-page contact sheet for visual transcription."""
import fitz, json, os, collections
P = r'D:\Nadav-Avi\project\Elbit\doc-demo\DEMO.pdf'
OUT = r'E:\claude-temp\demo-pdf\holes'
os.makedirs(OUT, exist_ok=True)
doc = fitz.open(P)
struct = {r['page']: r for r in json.load(open(r'E:\claude-temp\demo-pdf\structure.json'))}
holes = {}   # page → [ {y0,y1,x0,x1} ]
for pno in range(6, 40):
    page = doc[pno]
    imgcl = [fitz.Rect(*c) for c in struct[pno + 1]['img_clusters']]
    # text rows
    rows = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            if ''.join(s['text'] for s in l['spans']).strip():
                rows.append(fitz.Rect(l['bbox']))
    # glyph-sized filled paths outside images/tables: height 4..14pt, width < 60pt, inside the text column
    glyph = []
    for d in page.get_drawings():
        r = d['rect']
        if not (3 <= r.height <= 14 and 0.5 <= r.width <= 60): continue
        if any(r.intersects(c) for c in imgcl): continue
        if r.y0 < 45 or r.y1 > 790: continue                      # header / footer bands
        if d.get('fill') is None and d.get('color') is None: continue
        # must sit on a text row (same baseline band) — table rules / borders are long or tall
        if not any(abs((r.y0 + r.y1) / 2 - (tr.y0 + tr.y1) / 2) < 6 for tr in rows): continue
        glyph.append(r)
    # cluster glyph rects into word boxes (same row, close in x)
    glyph.sort(key=lambda r: (round(r.y0 / 4), r.x0))
    boxes = []
    for r in glyph:
        for bx in boxes:
            if abs(bx.y0 - r.y0) < 5 and r.x0 < bx.x1 + 6 and r.x1 > bx.x0 - 6:
                bx.include_rect(r); break
        else:
            boxes.append(fitz.Rect(r))
    boxes = [b for b in boxes if b.width > 2.5]   # keep single-letter holes (quote + capital became paths)
    if boxes:
        holes[pno + 1] = [[round(v, 1) for v in (b.x0, b.y0, b.x1, b.y1)] for b in boxes]
json.dump(holes, open(os.path.join(OUT, 'holes.json'), 'w'), indent=1)
print('pages with holes:', len(holes), '| boxes:', sum(len(v) for v in holes.values()))
for pg, bs in holes.items(): print(' p%d: %d boxes at y=%s' % (pg, len(bs), sorted({round(b[1]) for b in bs})))

# contact sheets: every text row that holds a hole, full column width, at 220 dpi, stacked with a label
Z = 220 / 72
for pg, bs in holes.items():
    page = doc[pg - 1]
    ys = sorted({(round(b[1]) // 6) * 6 for b in bs})
    strips = []
    for y in ys:
        band = [b for b in bs if (round(b[1]) // 6) * 6 == y]
        y0 = min(b[1] for b in band) - 4; y1 = max(b[3] for b in band) + 4
        clip = fitz.Rect(35, y0, 560, y1)
        pix = page.get_pixmap(matrix=fitz.Matrix(Z, Z), clip=clip, alpha=False)
        strips.append((y, pix))
    H = sum(p.height + 34 for _, p in strips) + 10
    W = max(p.width for _, p in strips) + 20
    sheet = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, W, H), False); sheet.clear_with(255)
    # compose via a temporary PDF page (pixmap has no blit) — simpler: build a PDF page and render it
    tmp = fitz.open(); tp = tmp.new_page(width=W / Z, height=H / Z)
    yy = 5 / Z
    for y, pix in strips:
        tp.insert_text((8 / Z, yy + 10 / Z), f'p{pg} y{y}', fontsize=9 / Z * 1.0, color=(0.8, 0, 0))
        yy += 14 / Z
        tp.insert_image(fitz.Rect(10 / Z, yy, 10 / Z + pix.width / Z, yy + pix.height / Z), pixmap=pix)
        yy += (pix.height + 20) / Z
    out = tp.get_pixmap(matrix=fitz.Matrix(Z, Z), alpha=False)
    out.save(os.path.join(OUT, f'holes-p{pg}.png'))
print('sheets written to', OUT)
