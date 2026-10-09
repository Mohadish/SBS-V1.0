#!/usr/bin/env node
/**
 * pdf2sbs — a curated step list (steps.json: chapters, rows, images) → a ready .sbsproj
 * the app opens directly, plus a preview.html that shows every step's layout.
 *
 *   node tools/pdf2sbs/build-project.mjs <steps.json> <out.sbsproj> [--name "Project name"]
 *
 * steps.json: { chapters: {code: name}, rows: [{ch, name, voice, notes, figs:[key], title, page, docstep}],
 *               images: {key: {path, w, h, caption}} }
 *
 * LAYOUT (1920×1080, 5 % margins). Pictures are never cropped — each one is FITTED whole; the
 * template is chosen by what the step holds and by the picture's shape:
 *   none      — the step name centred, the voiceover (or the notes) as a body line under it
 *   tall      — picture in a left column, title + notes in a right column
 *   icon      — a small picture enlarged (≤ 3×) and centred, title above, notes below
 *   wide / landscape / square — title above, picture fitted into the area below, notes under it
 *   pair      — two pictures side by side under the title
 * Text is bound to shared text styles and pinned title positions (constTextBoxes), so the look
 * can be restyled for every step at once in the app; nothing overlaps.
 *
 * ▣ V0.3.6.12 — the pictures live in CELLS (pinned positions with a size, src/systems/cell-fit.js):
 * one cell per template — main / main with notes below / left column / icon / pair left / pair
 * right. Each picture is bound to its cell (constShapeId) and written at the geometry the app's own
 * fit gives it; move or resize a cell in the app and every picture of that template, on every step,
 * refits. The notes box sits under the picture's fitted rect (a free box: it does not follow the cell).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, basename, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SI = await import('file:///' + APP.replace(/\\/g, '/') + '/src/systems/sheet-import.js');
const SC = await import('file:///' + APP.replace(/\\/g, '/') + '/src/core/schema.js');
const ST = await import('file:///' + APP.replace(/\\/g, '/') + '/src/systems/style-templates.js');
const CF = await import('file:///' + APP.replace(/\\/g, '/') + '/src/systems/cell-fit.js');

/** steps.json → .sbsproj (+ .layout.json, .preview.html). Returns a summary. */
export async function buildProject({ stepsPath, out, name = null }) {
const IN = stepsPath, OUT = out;
const NAME = name || basename(OUT, extname(OUT));
const data = JSON.parse(readFileSync(IN, 'utf8'));

// ── frame + text metrics ─────────────────────────────────────────────────────
const CW = 1920, CH = 1080, MX = 96, MY = 54, GAP = 24;
const TITLE = { fontSize: 56, weight: 'bold' }, BODY = { fontSize: 34 }, CENTRE = { fontSize: 64, weight: 'bold' }, CBODY = { fontSize: 40 };
const textH = (text, width, fs) => SI.estimateBoxHeight(text, width, fs);

// ── shared definitions (restyle everything at once in the app) ──────────────
const styles = {
  title:  ST.makeStyleTemplate({ name: 'pdf2sbs Title', fontSize: TITLE.fontSize, fontWeight: 'bold', color: '#ffffff' }),
  body:   ST.makeStyleTemplate({ name: 'pdf2sbs Notes', fontSize: BODY.fontSize, color: '#e2e8f0' }),
  centre: ST.makeStyleTemplate({ name: 'pdf2sbs Title (centred)', fontSize: CENTRE.fontSize, fontWeight: 'bold', color: '#ffffff' }),
  cbody:  ST.makeStyleTemplate({ name: 'pdf2sbs Body (centred)', fontSize: CBODY.fontSize, color: '#e2e8f0' }),
};
const defs = {
  titleTop:    { id: SC.generateId('ctb'), name: 'pdf2sbs Title — top',    anchor: 'tl', x: MX, y: MY, styleId: styles.title.id },
  titleSide:   { id: SC.generateId('ctb'), name: 'pdf2sbs Title — right column', anchor: 'tl', x: 920, y: MY, styleId: styles.title.id },
  titleCentre: { id: SC.generateId('ctb'), name: 'pdf2sbs Title — centred', anchor: 'tl', x: 260, y: 300, styleId: styles.centre.id },
  bodyCentre:  { id: SC.generateId('ctb'), name: 'pdf2sbs Body — centred',  anchor: 'tl', x: 260, y: 460, styleId: styles.cbody.id },
};
// ▣ the cells — one per template; a title line (56 px + padding) and a gap sit above the picture area
const TITLE_BAND = MY + Math.ceil(TITLE.fontSize * 1.2 + 16) + GAP;   // 162
const NOTES_BAND = 264;                                                 // room under the picture for up to ~5 note lines
const cell = (name, x, y, w, h, align = 'c') => ({ id: SC.generateId('csp'), name: `pdf2sbs ${name}`, anchor: 'tl', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), align });
const halfW = (CW - 2 * MX - 48) / 2;
const cells = {
  main:      cell('Picture — main',               MX, TITLE_BAND, CW - 2 * MX, CH - MY - TITLE_BAND, 'c'),
  mainNotes: cell('Picture — main, notes below',  MX, TITLE_BAND, CW - 2 * MX, CH - MY - TITLE_BAND - NOTES_BAND, 't'),
  left:      cell('Picture — left column',        MX, MY, 760, CH - 2 * MY, 'c'),
  icon:      cell('Picture — icon',               MX, TITLE_BAND, CW - 2 * MX, 480, 'c'),
  pairL:     cell('Picture — pair, left',         MX, TITLE_BAND, halfW, CH - MY - TITLE_BAND - NOTES_BAND, 'c'),
  pairR:     cell('Picture — pair, right',        MX + halfW + 48, TITLE_BAND, halfW, CH - MY - TITLE_BAND - NOTES_BAND, 'c'),
};

// ── picture helpers ──────────────────────────────────────────────────────────
const dataUrl = (p) => `data:image/${extname(p).slice(1) === 'jpg' ? 'jpeg' : extname(p).slice(1)};base64,${readFileSync(p).toString('base64')}`;
const urlCache = new Map();
const picNode = (img, x, y, w, h, extra = {}) => {
  if (!urlCache.has(img.path)) urlCache.set(img.path, dataUrl(img.path));
  return { className: 'Image', attrs: { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h), draggable: true, name: 'userImage', src: urlCache.get(img.path), naturalW: img.w, naturalH: img.h, ...extra } };
};
/** a picture in its cell: the geometry the app's fit gives it, bound to the cell */
function picCell(img, def) {
  const r = CF.cellRectFor(img.w, img.h, def);
  return picNode(img, r.x, r.y, r.width, r.height, { constShapeId: def.id });
}
const bottomOfNode = (n) => n.attrs.y + n.attrs.height;
const classOf = (img) => {
  if (!img) return 'none';
  const r = img.w / img.h;
  if (Math.max(img.w, img.h) < 400) return 'icon';
  if (r < 0.85) return 'tall';
  if (r >= 2.2) return 'wide';
  return r >= 1.15 ? 'landscape' : 'square';
};
const textNode = (text, def, width, align, fs, styleId) => SI.textBoxSpec({ text, def, width, align, fontSize: fs, styleId });
/** a free text box (not pinned): same shape, own x/y */
const freeText = (text, x, y, width, align, fs, styleId) => {
  const n = SI.textBoxSpec({ text, def: { id: null, anchor: 'tl', x, y }, width, align, fontSize: fs, styleId });
  delete n.attrs.constId;
  return n;
};

// ── the layout ───────────────────────────────────────────────────────────────
function layoutStep(row) {
  const imgs = (row.figs || []).map(k => data.images[k]).filter(Boolean);
  const notes = String(row.notes || '').trim();
  const nodes = [], note = { template: '', boxes: [] };
  const rightOf = (n) => n.attrs.x + n.attrs.width, bottomOf = (n) => n.attrs.y + n.attrs.height;
  if (!imgs.length) {
    // text card: name centred, the voiceover (or notes) under it
    const body = notes || String(row.voice || '');
    const tw = 1400;
    const t = textNode(row.name, defs.titleCentre, tw, 'center', CENTRE.fontSize, styles.centre.id);
    const bh = textH(body, tw, CBODY.fontSize);
    const b = freeText(body, 260, bottomOf(t) + 40, tw, 'center', CBODY.fontSize, styles.cbody.id);
    // keep the pair vertically centred as a block
    const block = bottomOf(b) - t.attrs.y, shift = Math.round((CH - block) / 2) - t.attrs.y;
    t.attrs.y += shift; b.attrs.y += shift;
    t.attrs.constId = defs.titleCentre.id;   // (the def's y is a nominal place; the box sits where the block centres)
    nodes.push(t, b); note.template = 'text card'; note.boxes.push(t.attrs, b.attrs, { x: 260, y: t.attrs.y, width: tw, height: bh, _body: true });
    return { nodes, note };
  }
  const cls = imgs.length > 1 ? 'pair' : classOf(imgs[0]);
  if (cls === 'tall') {
    // left column picture (its cell), right column text
    nodes.push(picCell(imgs[0], cells.left));
    const tx = 920, tw = CW - MX - tx;
    const t = textNode(row.name, defs.titleSide, tw, 'left', TITLE.fontSize, styles.title.id);
    const b = notes ? freeText(notes, tx, bottomOf(t) + GAP, tw, 'left', BODY.fontSize, styles.body.id) : null;
    // the text block sits at the column's vertical centre (a lone title at the top-right looked abandoned)
    const blockH = (b ? bottomOf(b) : bottomOf(t)) - t.attrs.y, shift = Math.round((CH - blockH) / 2) - t.attrs.y;
    t.attrs.y += shift; if (b) b.attrs.y += shift;
    nodes.push(t); if (b) nodes.push(b);
    note.template = 'tall: picture left (cell), text right';
    return { nodes, note };
  }
  // title row at the top (all remaining templates); the picture in its cell; the notes under the fitted rect
  const tw = CW - 2 * MX;
  const t = textNode(row.name, defs.titleTop, tw, 'left', TITLE.fontSize, styles.title.id);
  nodes.push(t);
  let pics = [];
  if (cls === 'pair') {
    pics = [picCell(imgs[0], cells.pairL), picCell(imgs[1], cells.pairR)];
    note.template = 'pair: two pictures side by side (cells)';
  } else if (cls === 'icon') {
    pics = [picCell(imgs[0], cells.icon)];
    note.template = 'icon: enlarged in its cell';
  } else {
    pics = [picCell(imgs[0], notes ? cells.mainNotes : cells.main)];
    note.template = `${cls}: title above, picture in the ${notes ? 'main-with-notes' : 'main'} cell`;
  }
  nodes.push(...pics);
  if (notes) {
    const under = Math.max(...pics.map(bottomOfNode)) + GAP;
    nodes.push(freeText(notes, MX, Math.min(under, CH - MY - textH(notes, tw, BODY.fontSize)), tw, 'left', BODY.fontSize, styles.body.id));
  }
  return { nodes, note };
}

// ── the project ──────────────────────────────────────────────────────────────
const camera = { position: [220, 180, 260], quaternion: [-0.2260189296908542, 0.3338446612545174, 0.08279250852160053, 0.91137730172852], pivot: [0, 0, 0], up: [0, 1, 0], fov: 45 };
const emptyTree = () => ({ id: 'scene_root', name: 'Scene', type: 'scene', localVisible: true, archived: false, children: [] });
const snapshot = (tree) => ({ visibility: {}, transforms: {}, tree, materials: {}, camera: { ...camera }, notes: [], notePanelOffsets: {}, screenItems: [], headerItems: [], cables: {} });
const base = { ...SC.createStep({ name: '__base__', hidden: true, isBaseStep: true, transition: { durationMs: 0 } }), snapshot: snapshot(null) };
const chapters = Object.entries(data.chapters).map(([code, name]) => ({ code, chap: SC.createChapter({ name }) }));
const chapterByCode = new Map(chapters.map(c => [c.code, c.chap.id]));
const report = [];
const steps = data.rows.map((row, i) => {
  const { nodes, note } = layoutStep(row);
  const step = SC.createStep({ name: row.name, chapterId: chapterByCode.get(row.ch) || null });
  step.snapshot = snapshot(emptyTree());
  const voice = String(row.voice || '').trim();
  if (voice) step.narration = { text: voice };
  step.voiceText = voice; step.voiceEnabled = true; step.altered = true;
  const ov = SI.overlayJson(nodes, CW, CH);
  if (ov) step.overlay = ov;
  report.push({ n: i + 1, name: row.name, template: note.template, figs: row.figs || [], nodes: nodes.map(n => ({ kind: n.attrs.name, x: n.attrs.x, y: n.attrs.y, w: n.attrs.width, h: n.attrs.height, src: n.attrs.src ? (row.figs || [])[nodes.filter(m => m.attrs.src).indexOf(n)] : undefined, html: n.attrs.textHtml })) });
  return step;
});
const now = new Date().toISOString();
const section = (items, extra = {}) => ({ schema_version: 1, items, ...extra });
const project = {
  _sbs: { app_version: SC.APP_VERSION, format_version: 1, created: now, saved: now, min_compatible_version: '1.0.0', generator: 'pdf2sbs' },
  assets: section([]), tree: { schema_version: 1, root: null },
  steps: section([base, ...steps]),
  chapters: section(chapters.map(c => c.chap)),
  cameras: section([]),
  colors: { schema_version: 3, items: [], assignments: {}, defaults: {} },
  notes: { schema_version: 1, templates: [], presets: { small: 18, medium: 36, large: 48 } },
  selections: { schema_version: 1, groups: [], outlineColor: '#00ffff' },
  animationPresets: section([]),
  headers: { schema_version: 1, items: [], locked: false, hidden: false, default: { fontFamily: 'Arial', fontSize: 32, fontWeight: 'normal', fontStyle: 'normal', textDecoration: '', color: '#ffffff', fillColor: null }, stepNumberPerChapter: false },
  styles: { schema_version: 1, items: Object.values(styles), shapeItems: [] },
  shapes: { schema_version: 1, items: [], groups: [] },
  constTexts: section(Object.values(defs)),
  constShapes: section(Object.values(cells)),   // ▣ the cells
  shapeLinks: section([]), cropMasks: section([]), reviewNotes: section([]), brand: null, document: null,
  hardware: { schema_version: 1, templates: [] },
  cables: { schema_version: 2, items: [], globalScale: 1, globalRadius: 1, defaultDiameter: 2, filletReach: 40, highlightColor: '#22d3ee' },
  settings: {
    schema_version: 1, backgroundColor: '#0f172a', backgroundGradient: { enabled: true, color1: '#0f172a', color2: '#1e293b', angleDeg: 180 },
    render: {}, solidOverride: false, gridVisible: false, cameraAnimDurationMs: 1500, objectAnimDurationMs: 400,
    cameraFillLight: { enabled: false, color: '#ffffff', intensity: 1.1, distance: 0, decay: 2, offsetX: -120, offsetY: 70, offsetZ: 140 },
    geometryOutline: { enabled: false, color: '#000000', opacity: 0.9, creaseAngle: 35 },
    export: { fileName: NAME, outputFormat: 'mp4', formatPreset: 'hdtv_1080', width: CW, height: CH, fps: 50, stepHoldMs: 100, videoBitrate: 4000000, startFromActive: true, showSafeFrame: true, offlineRender: true, narrationEnabled: true, narrationSpeed: 1, exportFolderPath: null, exportBoundaryBoxes: false },
    audioCacheFolder: null, narrationVoices: {}, replaceRules: {}, sourceLang: 'en', activeLang: 'en',
    interfaceDefaultPose: null, interfaceLibraryFolder: null, interfaceLibraryFolderRel: '', hardwareDefaults: null, spotlightDefaults: null,
  },
};
mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(project);
writeFileSync(OUT, gzipSync(Buffer.from(json, 'utf8'), { level: 6 }));
writeFileSync(OUT.replace(/\.sbsproj$/i, '') + '.layout.json', JSON.stringify(report, null, 1));

// ── preview.html — every step as the app will lay it out (scaled), to look at before opening ──
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sc = 0.3;
const cards = steps.map((s, i) => {
  const ov = s.overlay ? JSON.parse(s.overlay).children[0].children : [];
  const picKeys = report[i].nodes.filter(n => n.src).map(n => n.src);
  let pk = 0;
  const items = ov.map(n => {
    const a = n.attrs;
    if (a.src) { const key = picKeys[pk++]; const file = data.images[key] ? 'media/' + basename(data.images[key].path) : a.src; return `<img src="${file}" style="position:absolute;left:${a.x * sc}px;top:${a.y * sc}px;width:${a.width * sc}px;height:${a.height * sc}px;outline:1px solid rgba(255,255,255,.15);">`; }
    const fs = Number((a.textHtml.match(/font-size:(\d+)px/) || [])[1]) || 32;
    const align = (a.textHtml.match(/text-align:(\w+)/) || [])[1] || 'left';
    const text = a.textHtml.replace(/<div[^>]*>/g, '').replace(/<\/div>/g, '\n').replace(/<[^>]+>/g, '').trim();
    return `<div style="position:absolute;left:${a.x * sc}px;top:${a.y * sc}px;width:${a.width * sc}px;min-height:${a.height * sc}px;padding:${8 * sc}px;box-sizing:border-box;font:${fs * sc}px/1.2 Arial;${a.styleId === styles.title.id || a.styleId === styles.centre.id ? 'font-weight:bold;' : ''}color:#fff;text-align:${align};white-space:pre-wrap;outline:1px dashed rgba(255,255,0,.35);">${esc(text)}</div>`;
  }).join('');
  const r = report[i];
  return `<div class="card" data-n="${i + 1}" data-t="${esc(r.template.split(':')[0].split(' ')[0])}"><div class="hd">${i + 1}. ${esc(s.name)} <span class="t">${esc(r.template)}${r.figs.length ? ' · ' + r.figs.join('+') : ''}</span></div><div class="frame">${items}</div></div>`;
}).join('\n');
const html = `<!doctype html><meta charset="utf-8"><title>${esc(NAME)} — pdf2sbs preview</title>
<style>body{background:#111;color:#ddd;font:14px Arial;margin:16px}.card{display:inline-block;margin:8px;vertical-align:top}.hd{margin:0 0 4px;max-width:${CW * sc}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.t{color:#9ca3af;font-size:12px}
.frame{position:relative;width:${CW * sc}px;height:${CH * sc}px;background:linear-gradient(180deg,#0f172a,#1e293b);overflow:hidden;border:1px solid #333}</style>
<h2>${esc(NAME)} — ${steps.length} steps, ${chapters.length} chapters</h2>${cards}
<script>const P=new URLSearchParams(location.search),q=P.get('t'),st=P.get('step'),z=P.get('z');if(q){const keep=new Set(q.split(','));document.querySelectorAll('.card').forEach(c=>{if(!keep.has(c.dataset.t))c.remove();});}
if(st){const keep=new Set(st.split(',').map(Number));document.querySelectorAll('.card').forEach((c,i)=>{if(!keep.has(Number(c.dataset.n)))c.remove();});}if(z)document.body.style.zoom=z;</script>`;
writeFileSync(OUT.replace(/\.sbsproj$/i, '') + '.preview.html', html);
const byT = {}; for (const r of report) byT[r.template] = (byT[r.template] || 0) + 1;
return { out: OUT, layout: OUT.replace(/\.sbsproj$/i, '') + '.layout.json', preview: OUT.replace(/\.sbsproj$/i, '') + '.preview.html',
         steps: steps.length, chapters: chapters.length, pictures: urlCache.size, jsonMB: +(json.length / 1e6).toFixed(1), fileMB: +(statSync(OUT).size / 1e6).toFixed(1), templates: byT,
         perStep: report.map(r => ({ n: r.n, name: r.name, template: r.template, figs: r.figs })) };
}

// ── CLI ──
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.error('usage: build-project.mjs <steps.json> <out.sbsproj> [--name N]'); process.exit(2); }
  const name = args.indexOf('--name') >= 0 ? args[args.indexOf('--name') + 1] : null;
  const r = await buildProject({ stepsPath: args[0], out: args[1], name });
  console.log(`wrote ${r.out} (${r.jsonMB} MB json → ${r.fileMB} MB gz), ${r.steps} steps, ${r.chapters} chapters, ${r.pictures} pictures`);
  console.log('templates:', JSON.stringify(r.templates));
}
