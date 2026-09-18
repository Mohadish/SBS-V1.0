// Generates two geometry-free test projects for the Brand kit:
//   E:/SBS-brand-test/ACME Pump Service/ACME Pump Service.sbsproj      (the brand source, 1920×1080)
//   E:/SBS-brand-test/Rogue Conveyor Setup/Rogue Conveyor Setup.sbsproj (the rogue one, 1280×720)
// Plain JSON (the loader detects gzip by magic and reads plain JSON as-is).
import fs from 'node:fs';
import path from 'node:path';
import { buildBrand, mergeBrand, summarizeMerge } from 'file:///E:/SBS-dev-V0.3.1/sbs-app/src/systems/brand-core.js';

const OUT = 'E:/SBS-brand-test';
let n = 0;
const id = (p) => `${p}_bt${(++n).toString(36).padStart(3, '0')}`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const svgUrl = (svg) => `data:image/svg+xml;base64,${b64(svg)}`;

const logo = (text, bg, fg, accent) => svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120"><rect width="320" height="120" rx="18" fill="${bg}"/>`
  + `<circle cx="60" cy="60" r="34" fill="${accent}"/><path d="M42 60 L58 76 L82 44" stroke="${bg}" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
  + `<text x="110" y="74" font-family="Arial Black, Arial" font-size="40" font-weight="900" fill="${fg}">${text}</text></svg>`);
const diagram = (label, c1, c2) => svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>`
  + `<rect width="800" height="600" fill="url(#g)"/><g stroke="#ffffff" stroke-width="6" fill="none" opacity="0.85"><circle cx="400" cy="300" r="170"/><circle cx="400" cy="300" r="60"/><path d="M400 40 V560 M140 300 H660"/></g>`
  + `<text x="400" y="560" text-anchor="middle" font-family="Arial" font-size="44" fill="#ffffff">${label}</text></svg>`);

const CAMERA = { position: [0, 0, 100], quaternion: [0, 0, 0, 1], pivot: [0, 0, 0], up: [0, 1, 0], fov: 45 };
const ROOT = () => ({
  id: 'scene_root', name: 'Scene', type: 'scene', assetId: null, localVisible: true, archived: false, locked: false, children: [],
  localOffset: [0, 0, 0], localQuaternion: [0, 0, 0, 1], baseLocalPosition: [0, 0, 0], baseLocalQuaternion: [0, 0, 0, 1], baseLocalScale: [1, 1, 1],
  pivotLocalOffset: [0, 0, 0], pivotLocalQuaternion: [0, 0, 0, 1], pivotEnabled: true, moveEnabled: true, rotateEnabled: true,
  sourceLocalPosition: [0, 0, 0], sourceLocalQuaternion: [0, 0, 0, 1], sourceLocalScale: [1, 1, 1], meshIndex: null, colorPresetId: null,
});

const textBox = ({ x, y, w, h = 60, html, styleId = null, constId = null }) => ({
  className: 'Image',
  attrs: { x, y, width: w, height: h, draggable: true, name: 'userTextBox', textHtml: html, textWidth: w, naturalW: w, naturalH: h,
           ...(styleId ? { styleId } : {}), ...(constId ? { constId } : {}), tid: id('t') },
  children: [],
});
const rect = ({ x, y, w, h, fill, stroke, strokeWidth = 3, shapeStyleId = null, constShapeId = null, cornerRadius = 0 }) => ({
  className: 'Rect',
  attrs: { x, y, width: w, height: h, fill, stroke, strokeWidth, opacity: 1, cornerRadius, draggable: true, name: 'userShape', kind: 'rect',
           ...(shapeStyleId ? { shapeStyleId } : {}), ...(constShapeId ? { constShapeId } : {}) },
  children: [],
});
const image = ({ x, y, w, h, src, nw, nh, cropMaskId = null, constShapeId = null }) => ({
  className: 'Image',
  attrs: { x, y, width: w, height: h, draggable: true, name: 'userImage', src, naturalW: nw, naturalH: nh,
           ...(cropMaskId ? { cropMaskId } : {}), ...(constShapeId ? { constShapeId } : {}) },
  children: [],
});
const overlay = (cw, ch, children) => JSON.stringify({
  className: 'Stage', attrs: { width: cw, height: ch },
  children: [
    { className: 'Layer', attrs: { name: 'sbs-overlay-ghost', listening: false, opacity: 0 }, children: [] },
    { className: 'Layer', attrs: { name: 'sbs-overlay-content' }, children },
    { className: 'Layer', attrs: { name: 'sbs-overlay-ui' }, children: [] },
  ],
});
const step = ({ name, chapterId, voice, ov }) => ({
  id: id('step'), name, chapterId, hidden: false, groupHead: false, groupId: null, groupLocked: false,
  voiceText: voice, voiceEnabled: !!voice, narration: voice ? { text: voice } : undefined,
  transition: { durationMs: 1500, cameraEasing: 'smooth', objectEasing: 'smooth', visibilityFade: true, animPresetId: null },
  cameraBinding: { mode: 'free', templateId: null },
  snapshot: { visibility: {}, transforms: {}, materials: {}, camera: CAMERA, notes: [], notePanelOffsets: {}, screenItems: [], headerItems: [], cables: [] },
  overlay: ov,
});
const project = ({ width, height, headers, styles, shapeStyles, constTexts, constShapes, cropMasks, chapters, steps }) => ({
  _sbs: { app_version: 'V0.3.3.13', format_version: 1, created: new Date().toISOString(), saved: new Date().toISOString(), min_compatible_version: '1.0.0' },
  assets: { schema_version: 1, items: [] },
  tree: { schema_version: 1, root: ROOT() },
  steps: { schema_version: 1, items: steps },
  chapters: { schema_version: 1, items: chapters },
  cameras: { schema_version: 1, items: [] },
  colors: { schema_version: 3, items: [] },
  notes: { schema_version: 1, templates: [], presets: { small: 18, medium: 36, large: 48 } },
  selections: { schema_version: 1, groups: [], outlineColor: '#00ffff' },
  animationPresets: { schema_version: 1, items: [] },
  headers: { schema_version: 1, items: headers.items, locked: false, hidden: false, default: headers.default, stepNumberPerChapter: !!headers.perChapter },
  styles: { schema_version: 1, items: styles, shapeItems: shapeStyles },
  shapes: { schema_version: 1, items: [] },
  constTexts: { schema_version: 1, items: constTexts },
  constShapes: { schema_version: 1, items: constShapes },
  shapeLinks: { schema_version: 1, items: [] },
  cropMasks: { schema_version: 1, items: cropMasks },
  settings: {
    schema_version: 1, backgroundColor: '#0f172a', solidOverride: false, gridVisible: false, cameraAnimDurationMs: 1500, objectAnimDurationMs: 1500,
    export: { fileName: 'sbs_export', outputFormat: 'mp4', formatPreset: width === 1920 ? 'hdtv_1080' : 'hdtv_720', width, height, fps: 30, stepHoldMs: 800, narrationEnabled: true, narrationVoice: '', narrationSpeed: 1, showSafeFrame: true },
  },
});
const style = (name, o) => ({ id: id('style'), name, color: '#ffffff', fontFamily: 'Arial', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal', textDecoration: '', fillColor: null, shadow: null, outline: null, ...o });
const hdr = (kind, o) => ({ id: id('hdr'), kind, visible: true, x: 100, y: 40, w: 480, h: 64, styleId: '', align: 'left', text: '', ...o });

// ═══ 1. ACME Pump Service — the brand source (1920 × 1080) ═══════════════════
{
  const sTitle   = style('Title',   { fontFamily: 'Impact', fontSize: 64, color: '#ffcc00', outline: { color: '#000000', opacity: 1, thickness: 3 } });
  const sBody    = style('Body',    { fontFamily: 'Georgia', fontSize: 30, color: '#e2e8f0' });
  const sWarning = style('Warning', { fontFamily: 'Arial Black', fontSize: 36, color: '#ffffff', fontWeight: 'bold', fillColor: 'rgba(220,38,38,0.85)' });
  const sNote    = style('Note',    { fontFamily: 'Courier New', fontSize: 24, color: '#67e8f9', fontStyle: 'italic', fillColor: 'rgba(15,23,42,0.7)', shadow: { color: '#000000', opacity: 0.75, distance: 3, angle: 45, blur: 4, spread: 0 } });
  const shHi   = { id: id('shapestyle'), name: 'Highlight',   fill: 'rgba(250,204,21,0.35)', stroke: '#facc15', strokeWidth: 4 };
  const shDang = { id: id('shapestyle'), name: 'Danger zone', fill: 'rgba(239,68,68,0.25)',  stroke: '#ef4444', strokeWidth: 6 };
  const cTitle = { id: id('const'), name: 'Step title',  anchor: 'tl', x: 120,  y: 150, styleId: sTitle.id };
  const cFoot  = { id: id('const'), name: 'Footer note', anchor: 'tl', x: 120,  y: 960, styleId: sNote.id };
  const cPart  = { id: id('const'), name: 'Part number', anchor: 'tr', x: 1800, y: 150, styleId: sBody.id };
  const pLogo  = { id: id('pin'), name: 'Logo corner',  anchor: 'tr', x: 1860, y: 880 };
  const pCall  = { id: id('pin'), name: 'Callout spot', anchor: 'tl', x: 1250, y: 300 };
  const mWin   = { id: id('mask'), name: 'Detail window', kind: 'rect', x: 0.55, y: 0.25, w: 0.35, h: 0.45 };
  const ch1 = { id: id('chapter'), name: 'Preparation', hidden: false, locked: false };
  const ch2 = { id: id('chapter'), name: 'Seal replacement', hidden: false, locked: false };
  const acmeLogo = logo('ACME', '#0f172a', '#ffcc00', '#ffcc00');
  const stamp = logo('OK', '#14532d', '#bbf7d0', '#22c55e');
  const common = (title, part, foot) => [
    textBox({ x: 120,  y: 150, w: 900, h: 90, html: `<div>${title}</div>`, styleId: sTitle.id, constId: cTitle.id }),
    textBox({ x: 1400, y: 150, w: 400, h: 50, html: `<div>${part}</div>`,  styleId: sBody.id,  constId: cPart.id }),
    textBox({ x: 120,  y: 960, w: 1100, h: 44, html: `<div>${foot}</div>`, styleId: sNote.id,  constId: cFoot.id }),
  ];
  const W = 1920, H = 1080;
  const steps = [
    step({ name: 'Isolate the pump', chapterId: ch1.id, voice: 'Close both valves and isolate the pump from the mains.',
      ov: overlay(W, H, [...common('Isolate the pump', 'P/N 4471-A', 'Lock-out / tag-out applies.'),
        textBox({ x: 120, y: 300, w: 760, h: 120, html: '<div>Close valve V1, then V2.</div><div>Confirm zero pressure on gauge G3.</div>', styleId: sBody.id }),
        rect({ x: 1250, y: 300, w: 420, h: 260, fill: shHi.fill, stroke: shHi.stroke, strokeWidth: shHi.strokeWidth, shapeStyleId: shHi.id, constShapeId: pCall.id }),
        image({ x: 1540, y: 880, w: 320, h: 120, src: acmeLogo, nw: 320, nh: 120, constShapeId: pLogo.id }) ]) }),
    step({ name: 'Drain the housing', chapterId: ch1.id, voice: 'Open the drain plug and let the housing empty completely.',
      ov: overlay(W, H, [...common('Drain the housing', 'P/N 4471-A', 'Collect the oil for disposal.'),
        textBox({ x: 120, y: 300, w: 760, h: 60, html: '<div>HOT OIL — wear gloves</div>', styleId: sWarning.id }),
        rect({ x: 1250, y: 300, w: 420, h: 260, fill: shDang.fill, stroke: shDang.stroke, strokeWidth: shDang.strokeWidth, shapeStyleId: shDang.id, constShapeId: pCall.id }),
        image({ x: 1540, y: 880, w: 320, h: 120, src: acmeLogo, nw: 320, nh: 120, constShapeId: pLogo.id }) ]) }),
    step({ name: 'Remove the cover', chapterId: ch2.id, voice: 'Remove the six cover bolts in a star pattern and lift the cover.',
      ov: overlay(W, H, [...common('Remove the cover', 'P/N 4471-C', 'Torque on reassembly: 25 Nm.'),
        image({ x: 960, y: 200, w: 800, h: 600, src: diagram('Cover — bolt pattern', '#1e3a8a', '#0ea5e9'), nw: 800, nh: 600, cropMaskId: mWin.id }),
        textBox({ x: 120, y: 300, w: 700, h: 120, html: '<div>Six M8 bolts, star pattern.</div><div>Keep the washers.</div>', styleId: sBody.id }) ]) }),
    step({ name: 'Replace the seal', chapterId: ch2.id, voice: 'Pull the old seal, clean the seat and press the new seal in evenly.',
      ov: overlay(W, H, [...common('Replace the seal', 'P/N 9920-S', 'Never reuse a seal.'),
        image({ x: 960, y: 200, w: 800, h: 600, src: diagram('Seal seat', '#7c2d12', '#f59e0b'), nw: 800, nh: 600, cropMaskId: mWin.id }),
        textBox({ x: 120, y: 300, w: 760, h: 60, html: '<div>Do NOT use a screwdriver on the seat</div>', styleId: sWarning.id }),
        image({ x: 1540, y: 880, w: 320, h: 120, src: stamp, nw: 320, nh: 120, constShapeId: pLogo.id }) ]) }),
    step({ name: 'Close and test', chapterId: ch2.id, voice: 'Refit the cover, open the valves and run the pump for two minutes.',
      ov: overlay(W, H, [...common('Close and test', 'P/N 4471-A', 'Check for leaks after 2 minutes.'),
        textBox({ x: 120, y: 300, w: 760, h: 120, html: '<div>Refit the cover — 25 Nm.</div><div>Open V2, then V1.</div>', styleId: sBody.id }),
        rect({ x: 1250, y: 300, w: 420, h: 260, fill: shHi.fill, stroke: shHi.stroke, strokeWidth: shHi.strokeWidth, shapeStyleId: shHi.id, constShapeId: pCall.id }) ]) }),
  ];
  const headers = {
    default: { fontFamily: 'Arial', fontSize: 32, fontWeight: 'normal', fontStyle: 'normal', textDecoration: '', color: '#ffffff', fillColor: null },
    perChapter: true,
    items: [
      hdr('image',         { x: 40,   y: 24, w: 214, h: 80, dataUrl: acmeLogo, naturalW: 320, naturalH: 120 }),
      hdr('projectName',   { x: 280,  y: 30, w: 700, h: 64, styleId: sBody.id }),
      hdr('custom',        { x: 1000, y: 30, w: 520, h: 64, text: 'Service manual · rev A', styleId: sNote.id, align: 'center' }),
      hdr('chapterName',   { x: 1540, y: 20, w: 340, h: 44, styleId: sBody.id, align: 'right' }),
      hdr('stepNumber',    { x: 1740, y: 64, w: 140, h: 44, styleId: sTitle.id, align: 'right' }),
      hdr('stepName',      { x: 280,  y: 1010, w: 1000, h: 50, styleId: sBody.id }),
      hdr('chapterProgress', { x: 40, y: 112, w: 1840, h: 8, trackColor: 'rgba(255,255,255,0.25)', fillColor: '#ffcc00' }),
    ],
  };
  const p = project({ width: W, height: H, headers, styles: [sTitle, sBody, sWarning, sNote], shapeStyles: [shHi, shDang], constTexts: [cTitle, cFoot, cPart], constShapes: [pLogo, pCall], cropMasks: [mWin], chapters: [ch1, ch2], steps });
  const dir = path.join(OUT, 'ACME Pump Service');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ACME Pump Service.sbsproj'), JSON.stringify(p));
  globalThis.ACME = p;
}

// ═══ 2. Rogue Conveyor Setup — the project to be brought to the standard (1280 × 720) ═══
{
  const sTitle = style('Title',         { fontFamily: 'Comic Sans MS', fontSize: 40, color: '#ff00ff' });                       // same NAME as the brand → taken over
  const sHead2 = style('Heading 2',     { fontFamily: 'Verdana', fontSize: 28, color: '#00ff00', fontWeight: 'bold' });          // no brand equivalent by name
  const sBody  = style('body text',     { fontFamily: 'Times New Roman', fontSize: 20, color: '#ffffff' });                      // "Body" vs "body text" → NOT an exact match
  const sRogue = style('Rogue special', { fontFamily: 'Impact', fontSize: 50, color: '#ff6600', fillColor: 'rgba(0,0,0,0.6)' }); // project-only ("utility")
  const shHi  = { id: id('shapestyle'), name: 'Highlight', fill: 'rgba(34,197,94,0.35)', stroke: '#22c55e', strokeWidth: 2 };   // same name, different look
  const shBox = { id: id('shapestyle'), name: 'Box',       fill: 'rgba(59,130,246,0.3)', stroke: '#3b82f6', strokeWidth: 3 };
  const cTitle = { id: id('const'), name: 'Step title', anchor: 'tl', x: 40,  y: 40,  styleId: sTitle.id };   // same name, other place
  const cCap   = { id: id('const'), name: 'Caption',    anchor: 'tl', x: 40,  y: 640, styleId: sBody.id };    // own
  const pLogo  = { id: id('pin'), name: 'Logo corner', anchor: 'tl', x: 40,  y: 560 };                          // same name, other corner + anchor
  const pRand  = { id: id('pin'), name: 'Random pin',  anchor: 'tl', x: 700, y: 200 };                          // own
  const mWin   = { id: id('mask'), name: 'Detail window', kind: 'rect', x: 0.1, y: 0.3, w: 0.3, h: 0.5 };       // same name, other rect
  const ch1 = { id: id('chapter'), name: 'Setup', hidden: false, locked: false };
  const oldLogo = logo('CONV', '#3f3f46', '#fafafa', '#a1a1aa');
  const W = 1280, H = 720;
  const common = (title, cap) => [
    textBox({ x: 40, y: 40,  w: 700, h: 60, html: `<div>${title}</div>`, styleId: sTitle.id, constId: cTitle.id }),
    textBox({ x: 40, y: 640, w: 900, h: 36, html: `<div>${cap}</div>`,   styleId: sBody.id,  constId: cCap.id }),
  ];
  const steps = [
    step({ name: 'Level the frame', chapterId: ch1.id, voice: 'Level the conveyor frame using the four adjustable feet.',
      ov: overlay(W, H, [...common('Level the frame', 'Use a 600 mm spirit level.'),
        textBox({ x: 40, y: 140, w: 560, h: 50, html: '<div>Adjust all four feet</div>', styleId: sHead2.id }),
        rect({ x: 700, y: 200, w: 300, h: 180, fill: shHi.fill, stroke: shHi.stroke, strokeWidth: shHi.strokeWidth, shapeStyleId: shHi.id, constShapeId: pRand.id }),
        image({ x: 40, y: 560, w: 213, h: 80, src: oldLogo, nw: 320, nh: 120, constShapeId: pLogo.id }) ]) }),
    step({ name: 'Tension the belt', chapterId: ch1.id, voice: 'Tension the belt until it deflects ten millimetres at mid span.',
      ov: overlay(W, H, [...common('Tension the belt', '10 mm deflection at mid span.'),
        textBox({ x: 40, y: 140, w: 600, h: 70, html: '<div>PINCH POINT</div>', styleId: sRogue.id }),
        image({ x: 500, y: 120, w: 640, h: 480, src: diagram('Belt path', '#14532d', '#84cc16'), nw: 800, nh: 600, cropMaskId: mWin.id }),
        rect({ x: 700, y: 200, w: 300, h: 180, fill: shBox.fill, stroke: shBox.stroke, strokeWidth: shBox.strokeWidth, shapeStyleId: shBox.id }) ]) }),
    step({ name: 'Set the speed', chapterId: ch1.id, voice: 'Set the drive to twenty five hertz and check the belt tracks straight.',
      ov: overlay(W, H, [...common('Set the speed', 'Tracking must stay within 5 mm.'),
        textBox({ x: 40, y: 140, w: 560, h: 80, html: '<div>25 Hz on the drive.</div><div>Watch the tracking.</div>', styleId: sBody.id }),
        image({ x: 40, y: 560, w: 213, h: 80, src: oldLogo, nw: 320, nh: 120, constShapeId: pLogo.id }) ]) }),
  ];
  const headers = {
    default: { fontFamily: 'Verdana', fontSize: 22, fontWeight: 'normal', fontStyle: 'normal', textDecoration: '', color: '#d4d4d8', fillColor: null },
    items: [
      hdr('image',    { x: 20,  y: 14, w: 133, h: 50, dataUrl: oldLogo, naturalW: 320, naturalH: 120 }),
      hdr('custom',   { x: 170, y: 18, w: 420, h: 40, text: 'Conveyor Ltd. — internal', styleId: sBody.id }),
      hdr('stepName', { x: 700, y: 18, w: 560, h: 40, styleId: sHead2.id, align: 'right' }),
    ],
  };
  const p = project({ width: W, height: H, headers, styles: [sTitle, sHead2, sBody, sRogue], shapeStyles: [shHi, shBox], constTexts: [cTitle, cCap], constShapes: [pLogo, pRand], cropMasks: [mWin], chapters: [ch1], steps });
  const dir = path.join(OUT, 'Rogue Conveyor Setup');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Rogue Conveyor Setup.sbsproj'), JSON.stringify(p));
  globalThis.ROGUE = p;
}

// ═══ dry run: what loading ACME's brand into the rogue project will propose ═══
const sec = (p) => ({ textStyles: p.styles.items, shapeStyles: p.styles.shapeItems, constTexts: p.constTexts.items, constShapes: p.constShapes.items, cropMasks: p.cropMasks.items, headerItems: p.headers.items });
const A = globalThis.ACME, R = globalThis.ROGUE;
const { payload } = buildBrand({ meta: { id: 'brand_dryrun', name: 'ACME', revision: 1 }, canonical: { width: 1920, height: 1080 }, sections: sec(A), headerDefault: A.headers.default, links: {} });
const plan = mergeBrand({ sections: sec(R), links: {}, headerDefault: R.headers.default, canonical: { width: 1280, height: 720 } }, payload, { newId: (p) => id(p) });
console.log('files written under', OUT);
for (const f of ['ACME Pump Service/ACME Pump Service.sbsproj', 'Rogue Conveyor Setup/Rogue Conveyor Setup.sbsproj']) console.log(' ', f, fs.statSync(path.join(OUT, f)).size, 'bytes');
console.log('\nDRY RUN — ACME brand → Rogue project:', JSON.stringify(summarizeMerge(plan.rows)));
for (const r of plan.rows) console.log(`  ${r.label.padEnd(16)} ${r.action.padEnd(7)} ${String(r.name).padEnd(24)} ${r.before || '—'}  →  ${r.after || '—'}`);
