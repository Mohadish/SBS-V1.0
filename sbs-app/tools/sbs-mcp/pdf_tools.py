# -*- coding: utf-8 -*-
"""sbs-mcp — the PDF side, one script with subcommands; JSON on stdout, everything else in <work>/.
Needs PyMuPDF (fitz) + Pillow.

  inspect  <pdf> <work>                       → summary; writes structure.json + text-lines.txt
  text     <pdf> <work> [pages]               → text lines of the pages (e.g. "13-20,33")
  page     <pdf> <work> <page> [dpi] [x0 y0 x1 y1]  → renders a page / region → png path
  figures  <pdf> <work> [overrides.json]      → "Figure N:" regions rendered at 300 dpi → figures/<key>.png, figures.json
  holes    <pdf> <work>                       → text rows whose words became vector outlines → holes/*.png contact sheets
  media    <work> <steps.json>                → web-sized copies of the figures a steps.json uses → media/, images map
  preview  <work> <layout.json> <steps> <out> → PNG of each step's layout (steps = "2,11,17")
"""
import sys, os, re, json, io, collections

def jout(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False)); sys.stdout.flush()

def fail(msg, code=2):
    jout({'error': msg}); sys.exit(code)

try:
    import fitz
except Exception as e:  # pragma: no cover
    fail('PyMuPDF (fitz) is not installed: ' + str(e))

# ───────────────────────── helpers ─────────────────────────
def clusters(rects, gap=6):
    """merge vertically / horizontally adjacent image tiles (Print-To-PDF strips) into figure regions"""
    rects = sorted(rects, key=lambda r: (r.y0, r.x0))
    out = []
    for r in rects:
        for c in out:
            if r.x0 < c.x1 + gap and r.x1 > c.x0 - gap and r.y0 < c.y1 + gap and r.y1 > c.y0 - gap:
                c.include_rect(r); break
        else:
            out.append(fitz.Rect(r))
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

def pages_arg(s, n):
    if not s: return list(range(1, n + 1))
    out = []
    for part in str(s).split(','):
        part = part.strip()
        if not part: continue
        if '-' in part:
            a, b = part.split('-', 1); out.extend(range(int(a), int(b) + 1))
        else: out.append(int(part))
    return [p for p in out if 1 <= p <= n]

def structure(doc, work):
    """captions + image clusters + text lines per page → structure.json, text-lines.txt (cached)"""
    sp = os.path.join(work, 'structure.json')
    if os.path.exists(sp):
        return json.load(open(sp, encoding='utf-8'))
    report, dump = [], []
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
                    lines.append({'y': round(l['bbox'][1], 1), 'x': round(l['bbox'][0], 1), 'y1': round(l['bbox'][3], 1), 'size': round(sz, 1), 'bold': bold, 'text': t})
        lines.sort(key=lambda L: (L['y'], L['x']))
        caps = [L for L in lines if re.match(r'^\s*(Figure|Fig\.|Table)\s*\d+\s*[:.\-–]', L['text'])]
        imgs = [fitz.Rect(i['bbox']) for i in page.get_image_info()]
        img_cl = clusters(imgs)
        draws = [fitz.Rect(dr['rect']) for dr in page.get_drawings() if dr['rect'].width > 2 and dr['rect'].height > 2]
        report.append({'page': pno + 1, 'width': round(page.rect.width), 'height': round(page.rect.height),
                       'captions': [{'y': c['y'], 'text': c['text'].strip()} for c in caps],
                       'img_clusters': [[round(v) for v in (c.x0, c.y0, c.x1, c.y1)] for c in img_cl],
                       'n_tiles': len(imgs), 'n_draw': len(draws), 'chars': sum(len(L['text']) for L in lines),
                       'lines': lines})
        dump.append('=== PAGE %d ===' % (pno + 1))
        for L in lines:
            dump.append('%6.1f %5.1f %4.1f%s %s' % (L['y'], L['x'], L['size'], 'B' if L['bold'] else ' ', L['text']))
    os.makedirs(work, exist_ok=True)
    json.dump(report, open(sp, 'w', encoding='utf-8'), ensure_ascii=False)
    open(os.path.join(work, 'text-lines.txt'), 'w', encoding='utf-8').write('\n'.join(dump))
    return report

# ───────────────────────── commands ─────────────────────────
def cmd_inspect(pdf, work):
    doc = fitz.open(pdf)
    st = structure(doc, work)
    fonts = collections.Counter()
    for pno in range(min(len(doc), 60)):
        for b in doc[pno].get_text('dict')['blocks']:
            for l in b.get('lines', []):
                for s in l['spans']:
                    if s['text'].strip(): fonts[(round(s['size']), s['font'], bool(s['flags'] & 16))] += len(s['text'])
    tiles = sum(p['n_tiles'] for p in st)
    caps = [c['text'] for p in st for c in p['captions']]
    fig_nums = sorted({int(m.group(1)) for c in caps for m in [re.match(r'^\s*(?:Figure|Fig\.)\s*(\d+)', c)] if m})
    big_tiles = sum(1 for p in st if p['n_tiles'] > 12)
    summary = {
        'file': pdf, 'pages': len(doc), 'meta': {k: v for k, v in doc.metadata.items() if v},
        'work': work,
        'image_tiles': tiles, 'pages_with_many_tiles': big_tiles,
        'strip_sliced': big_tiles >= 3,            # Print-To-PDF style: screenshots sliced into strips → render regions, never extract
        'figure_captions': len([c for c in caps if c.lower().startswith('fig')]), 'figure_numbers': fig_nums[:200],
        'table_captions': len([c for c in caps if c.lower().startswith('table')]),
        'text_chars': sum(p['chars'] for p in st),
        'fonts_top': [{'size': k[0], 'font': k[1], 'bold': k[2], 'chars': v} for k, v in fonts.most_common(8)],
        'pages_outline': [{'page': p['page'], 'first_line': (p['lines'][1]['text'] if len(p['lines']) > 1 else (p['lines'][0]['text'] if p['lines'] else '')), 'captions': len(p['captions']), 'clusters': len(p['img_clusters']), 'chars': p['chars']} for p in st],
        'files': {'structure': os.path.join(work, 'structure.json'), 'text_lines': os.path.join(work, 'text-lines.txt')},
    }
    jout(summary)

def cmd_text(pdf, work, pages=None):
    doc = fitz.open(pdf)
    st = structure(doc, work)
    out = []
    for p in pages_arg(pages, len(doc)):
        pg = st[p - 1]
        out.append('=== PAGE %d ===' % p)
        for L in pg['lines']:
            out.append('%6.1f %5.1f %4.1f%s %s' % (L['y'], L['x'], L['size'], 'B' if L['bold'] else ' ', L['text']))
    jout({'text': '\n'.join(out)})

def cmd_page(pdf, work, page, dpi=110, clip=None):
    doc = fitz.open(pdf)
    pg = doc[int(page) - 1]
    z = float(dpi) / 72
    kw = {'matrix': fitz.Matrix(z, z), 'alpha': False}
    if clip: kw['clip'] = fitz.Rect(*[float(v) for v in clip])
    pix = pg.get_pixmap(**kw)
    os.makedirs(os.path.join(work, 'pages'), exist_ok=True)
    path = os.path.join(work, 'pages', 'p%s%s-%sdpi.png' % (page, ('-%s' % '_'.join(str(round(float(v))) for v in clip)) if clip else '', dpi))
    pix.save(path)
    jout({'path': path, 'w': pix.width, 'h': pix.height})

def figure_regions(doc, st, overrides=None):
    """each image cluster → the first "Figure N:" caption below it on its page; tables/vector figures via overrides"""
    regions, captions = {}, {}
    for pg in st:
        caps = sorted(pg['captions'], key=lambda c: c['y'])
        prev_y = 40
        for c in caps:
            m = re.match(r'^\s*(?:Figure|Fig\.)\s*(\d+)\s*[:.\-–]\s*(.*)$', c['text'])
            if not m: prev_y = c['y']; continue
            key = 'F' + m.group(1)
            if key in captions: prev_y = c['y']; continue      # a TOC lists every figure too — the first with pictures wins
            cl = [fitz.Rect(*b) for b in pg['img_clusters'] if b[3] <= c['y'] + 1 and b[1] >= prev_y - 1]
            if cl:
                big = [b for b in cl if b.height >= 25] or cl
                u = fitz.Rect(big[0])
                for b in big: u.include_rect(b)
                regions[key] = (pg['page'] - 1, u)
                captions[key] = c['text'].strip()
            prev_y = c['y']
    for key, spec in (overrides or {}).items():
        # {"T1": {"page": 10, "rect": [55,143,554,283], "caption": "Table 1"}}
        regions[key] = (int(spec['page']) - 1, fitz.Rect(*spec['rect']))
        if spec.get('caption'): captions[key] = spec['caption']
    return regions, captions

def cmd_figures(pdf, work, overrides_path=None, dpi=300):
    doc = fitz.open(pdf)
    st = structure(doc, work)
    overrides = json.load(open(overrides_path, encoding='utf-8')) if overrides_path and os.path.exists(overrides_path) else None
    regions, captions = figure_regions(doc, st, overrides)
    fdir = os.path.join(work, 'figures'); os.makedirs(fdir, exist_ok=True)
    z = fitz.Matrix(dpi / 72, dpi / 72)
    out = {}
    for key, (pi, rect) in sorted(regions.items(), key=lambda kv: (kv[1][0], kv[1][1].y0)):
        page = doc[pi]
        clip = (rect + (-3, -3, 3, 3)) & page.rect
        pix = page.get_pixmap(matrix=z, clip=clip, alpha=False)
        path = os.path.join(fdir, '%s.png' % key)
        pix.save(path)
        out[key] = {'path': path, 'w': pix.width, 'h': pix.height, 'page': pi + 1, 'rect': [round(v) for v in rect], 'caption': captions.get(key, '')}
    nums = sorted({int(m.group(1)) for c in st for cc in c['captions'] for m in [re.match(r'^\s*(?:Figure|Fig\.)\s*(\d+)', cc['text'])] if m})
    missing = ['F%d' % n for n in nums if 'F%d' % n not in out]
    json.dump(out, open(os.path.join(work, 'figures.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    jout({'figures': out, 'count': len(out), 'missing_captions_without_pictures': missing,
          'hint': 'a caption with no picture cluster = a vector figure / table: add it to overrides.json as {"KEY": {"page": N, "rect": [x0,y0,x1,y1]}} (points; use `page` to look)'})

def cmd_holes(pdf, work):
    doc = fitz.open(pdf)
    st = structure(doc, work)
    hdir = os.path.join(work, 'holes'); os.makedirs(hdir, exist_ok=True)
    holes = {}
    for pno in range(len(doc)):
        page = doc[pno]
        imgcl = [fitz.Rect(*c) for c in st[pno]['img_clusters']]
        rows = [fitz.Rect(L['x'], L['y'], L['x'] + 10, L['y1']) for L in st[pno]['lines']]
        glyph = []
        for d in page.get_drawings():
            r = d['rect']
            if not (3 <= r.height <= 14 and 0.5 <= r.width <= 60): continue
            if any(r.intersects(c) for c in imgcl): continue
            if r.y0 < 45 or r.y1 > page.rect.height - 50: continue
            if d.get('fill') is None and d.get('color') is None: continue
            if not any(abs((r.y0 + r.y1) / 2 - (tr.y0 + tr.y1) / 2) < 6 for tr in rows): continue
            glyph.append(r)
        glyph.sort(key=lambda r: (round(r.y0 / 4), r.x0))
        boxes = []
        for r in glyph:
            for bx in boxes:
                if abs(bx.y0 - r.y0) < 5 and r.x0 < bx.x1 + 6 and r.x1 > bx.x0 - 6:
                    bx.include_rect(r); break
            else:
                boxes.append(fitz.Rect(r))
        boxes = [b for b in boxes if b.width > 2.5]
        if boxes: holes[pno + 1] = [[round(v, 1) for v in (b.x0, b.y0, b.x1, b.y1)] for b in boxes]
    Z = 220 / 72
    sheets = []
    for pg, bs in holes.items():
        page = doc[pg - 1]
        ys = sorted({(round(b[1]) // 6) * 6 for b in bs})
        strips = []
        for y in ys:
            band = [b for b in bs if (round(b[1]) // 6) * 6 == y]
            y0 = min(b[1] for b in band) - 4; y1 = max(b[3] for b in band) + 4
            pix = page.get_pixmap(matrix=fitz.Matrix(Z, Z), clip=fitz.Rect(35, y0, page.rect.width - 35, y1), alpha=False)
            strips.append((y, pix))
        H = sum(p.height + 34 for _, p in strips) + 10
        W = max(p.width for _, p in strips) + 20
        tmp = fitz.open(); tp = tmp.new_page(width=W / Z, height=H / Z)
        yy = 5 / Z
        for y, pix in strips:
            tp.insert_text((8 / Z, yy + 10 / Z), 'p%d y%d' % (pg, y), fontsize=9 / Z, color=(0.8, 0, 0))
            yy += 14 / Z
            tp.insert_image(fitz.Rect(10 / Z, yy, 10 / Z + pix.width / Z, yy + pix.height / Z), pixmap=pix)
            yy += (pix.height + 20) / Z
        path = os.path.join(hdir, 'holes-p%d.png' % pg)
        tp.get_pixmap(matrix=fitz.Matrix(Z, Z), alpha=False).save(path)
        sheets.append({'page': pg, 'rows_y': ys, 'path': path})
    json.dump(holes, open(os.path.join(hdir, 'holes.json'), 'w'), indent=1)
    jout({'pages': len(holes), 'boxes': sum(len(v) for v in holes.values()), 'sheets': sheets,
          'hint': 'words that became vector outlines are missing from the text layer (often curly-quoted names, IPs, passwords) — read each sheet and put the real text into the steps'})

def cmd_media(work, steps_path):
    from PIL import Image
    data = json.load(open(steps_path, encoding='utf-8'))
    figs = json.load(open(os.path.join(work, 'figures.json'), encoding='utf-8')) if os.path.exists(os.path.join(work, 'figures.json')) else {}
    used = sorted({k for r in data.get('rows', []) for k in (r.get('figs') or [])})
    mdir = os.path.join(work, 'media'); os.makedirs(mdir, exist_ok=True)
    images, missing = {}, []
    for key in used:
        src = (data.get('images') or {}).get(key, {}).get('path') or figs.get(key, {}).get('path')
        if not src or not os.path.exists(src): missing.append(key); continue
        im = Image.open(src); W, H = im.size
        alpha = im.mode in ('RGBA', 'LA') and im.getextrema()[-1][0] < 255
        s = min(1.0, 1920 / max(W, H))
        if s < 1: im = im.resize((round(W * s), round(H * s)), Image.LANCZOS)
        if alpha or max(im.size) < 400:
            path = os.path.join(mdir, key + '.png'); im.save(path, optimize=True)
        else:
            path = os.path.join(mdir, key + '.jpg'); im.convert('RGB').save(path, quality=90, optimize=True)
        images[key] = {'path': path, 'w': im.size[0], 'h': im.size[1], 'caption': figs.get(key, {}).get('caption', '')}
    data['images'] = images
    json.dump(data, open(steps_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    jout({'images': len(images), 'missing': missing, 'media_mb': round(sum(os.path.getsize(v['path']) for v in images.values()) / 1e6, 1)})

def cmd_preview(work, layout_path, steps, outdir):
    """layout.json (from project.build) → one PNG per chosen step: pictures placed, text drawn plainly"""
    layout = json.load(open(layout_path, encoding='utf-8'))
    data = json.load(open(os.path.join(work, 'steps.json'), encoding='utf-8'))
    os.makedirs(outdir, exist_ok=True)
    want = [int(s) for s in str(steps).split(',') if s.strip()]
    out = []
    for n in want:
        r = next((x for x in layout if x['n'] == n), None)
        if not r: continue
        doc = fitz.open(); pg = doc.new_page(width=1920, height=1080)
        pg.draw_rect(pg.rect, color=None, fill=(0.07, 0.09, 0.16))
        for node in r['nodes']:
            x, y, w, h = node['x'], node['y'], node['w'], node['h']
            if node.get('src'):
                img = data['images'].get(node['src'])
                if img: pg.insert_image(fitz.Rect(x, y, x + w, y + h), filename=img['path'])
                pg.draw_rect(fitz.Rect(x, y, x + w, y + h), color=(1, 1, 1), width=0.5)
            elif node.get('html'):
                html = node['html']
                fs = int((re.search(r'font-size:(\d+)px', html) or [None, '32'])[1])
                align = (re.search(r'text-align:(\w+)', html) or [None, 'left'])[1]
                bold = 'font-weight:bold' in html or node.get('bold')
                text = re.sub(r'</div>', '\n', re.sub(r'<div[^>]*>', '', html)); text = re.sub(r'<[^>]+>', '', text).strip()
                text = text.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&')
                rect = fitz.Rect(x + 8, y + 8, x + w - 8, y + max(h, fs * 1.3) + 400)
                pg.insert_textbox(rect, text, fontsize=fs, fontname='hebo' if bold else 'helv', color=(1, 1, 1), align={'left': 0, 'center': 1, 'right': 2}.get(align, 0), lineheight=1.2)
                pg.draw_rect(fitz.Rect(x, y, x + w, y + h), color=(1, 1, 0.3), width=0.5, dashes='[4 4] 0')
        pg.insert_text((24, 1060), '%d. %s  —  %s' % (n, r['name'], r['template']), fontsize=18, color=(0.6, 0.7, 0.9))
        path = os.path.join(outdir, 'step-%03d.png' % n)
        pg.get_pixmap(matrix=fitz.Matrix(0.5, 0.5), alpha=False).save(path)
        out.append({'n': n, 'name': r['name'], 'template': r['template'], 'path': path})
    jout({'previews': out})

if __name__ == '__main__':
    a = sys.argv[1:]
    if not a: fail(__doc__)
    cmd = a[0]
    try:
        if cmd == 'inspect': cmd_inspect(a[1], a[2])
        elif cmd == 'text': cmd_text(a[1], a[2], a[3] if len(a) > 3 else None)
        elif cmd == 'page': cmd_page(a[1], a[2], a[3], a[4] if len(a) > 4 else 110, a[5:9] if len(a) > 8 else None)
        elif cmd == 'figures': cmd_figures(a[1], a[2], a[3] if len(a) > 3 else None)
        elif cmd == 'holes': cmd_holes(a[1], a[2])
        elif cmd == 'media': cmd_media(a[1], a[2])
        elif cmd == 'preview': cmd_preview(a[1], a[2], a[3], a[4])
        else: fail('unknown command ' + cmd)
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        fail('%s: %s\n%s' % (type(e).__name__, e, traceback.format_exc()[-1500:]))
