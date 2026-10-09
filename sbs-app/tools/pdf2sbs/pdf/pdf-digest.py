import fitz, json, sys, collections
P = r'D:\Nadav-Avi\project\Elbit\doc-demo\DEMO.pdf'
doc = fitz.open(P)
print('pages', len(doc), 'meta', {k: v for k, v in doc.metadata.items() if v})
print('toc', doc.get_toc()[:40])
imgs = []
seen = set()
for pno in range(len(doc)):
    page = doc[pno]
    pw, ph = page.rect.width, page.rect.height
    for info in page.get_image_info(xrefs=True):
        x = info.get('xref')
        bbox = info['bbox']
        w_pt, h_pt = bbox[2] - bbox[0], bbox[3] - bbox[1]
        dpi_x = info['width'] / (w_pt / 72) if w_pt else 0
        imgs.append({'page': pno + 1, 'xref': x, 'px': [info['width'], info['height']], 'placed_pt': [round(w_pt), round(h_pt)], 'dpi': round(dpi_x), 'bpc': info.get('bpc'), 'cs': info.get('colorspace'), 'frac_of_page': round(w_pt * h_pt / (pw * ph), 2)})
    draws = page.get_drawings()
    txt = page.get_text('text')
    print(f'--- p{pno+1} {round(pw)}x{round(ph)}pt  images={len(page.get_image_info())}  vector_paths={len(draws)}  chars={len(txt)}')
    # first lines of text, structure hints
    lines = [l.strip() for l in txt.splitlines() if l.strip()]
    for l in lines[:14]:
        print('   |', l[:110])
    if len(lines) > 14: print('   | ...', len(lines) - 14, 'more lines')
print()
print('IMAGES', len(imgs), 'unique xrefs', len({i["xref"] for i in imgs}))
for i in imgs: print(i)
# fonts / sizes → heading detection
sizes = collections.Counter()
for pno in range(len(doc)):
    for b in doc[pno].get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                if s['text'].strip(): sizes[(round(s['size'], 1), s['font'], bool(s['flags'] & 16))] += len(s['text'])
print('FONT SIZES (size, font, bold) → chars:')
for k, v in sizes.most_common(14): print('  ', k, v)
