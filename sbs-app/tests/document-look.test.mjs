// The document's LOOK travelling in a brand, offline:  node tests/document-look.test.mjs   (part of npm run test:brand)
// Pure modules only — no app, no DOM.
import { documentLookOf, sanitizeLook, applyLook } from '../src/systems/document-look-core.js';
import { emptyDocument } from '../src/systems/document-core.js';
import { buildBrand, BRAND_VERSION } from '../src/systems/brand-core.js';

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? '  ok   ' : ' FAIL  ') + name.padEnd(82) + (ok ? '' : `\n         got    ${JSON.stringify(got)}\n         wanted ${JSON.stringify(want)}`)); };
const clone = (v) => JSON.parse(JSON.stringify(v));
let seq = 0;
const newId = (p) => `${p}_n${++seq}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const changed = (r) => r.rows.filter(x => x.action !== 'same').map(x => `${x.name}:${x.action}`);

// ── the company's document: two own layouts, a designed header with a picture and the logo, a watermark ──
const acme = emptyDocument();
acme.templates = [
  { id: 'utpl_a', name: 'ACME wide', text: { x: 12, y: 32, w: 186, h: 60 }, images: [{ x: 12, y: 100, w: 186, h: 100 }] },
  { id: 'utpl_b', name: 'ACME pair', text: { x: 12, y: 32, w: 186, h: 60 }, images: [{ x: 12, y: 100, w: 90, h: 100 }, { x: 108, y: 100, w: 90, h: 100 }] },
];
acme.templateId = 'utpl_a';
acme.fields = { title: 'Pump service', docNo: 'D-100', rev: 'C', company: 'ACME Ltd' };
acme.assets = { asset_badge: { dataUrl: PNG, w: 1, h: 1, name: 'badge.png' }, asset_photo: { dataUrl: PNG + '', w: 1, h: 1, name: 'used on a page only' } };
acme.bands = { header: { rule: true, items: [
  { id: 'h_logo', type: 'image', logo: true, x: 12, y: 10, w: 30, h: 14 },
  { id: 'b1', type: 'image', assetId: 'asset_badge', x: 160, y: 10, w: 20, h: 14 },
  { id: 'b2', type: 'image', stepId: 'step_77', x: 100, y: 10, w: 20, h: 14 },              // shows a step of THIS animation
  { id: 'b3', type: 'text', text: '{company} — {title}', x: 50, y: 12, w: 100, h: 10 },
] }, footer: null };
acme.watermark = { ...acme.watermark, enabled: true, text: 'ACME INTERNAL', opacity: 0.3 };
acme.options = { ...acme.options, numbering: 'page', tocSteps: false, direction: 'rtl', ifaceAdjust: { s1: 1.4 }, includeHidden: true };
acme.pages = [{ id: 'page_1', stepIds: ['s1'], templateId: 'utpl_a', images: [] }];
acme.texts = { s1: { text: 'secret sentence', srcHash: 'h' } };

console.log('── what travels, and what never does ──');
const look = documentLookOf(acme);
t('both layouts, by name', look.templates.map(x => x.name), ['ACME wide', 'ACME pair']);
t('the default layout is named, not id-ed (ids never match across projects)', look.defaultTemplate, { name: 'ACME wide' });
t('a header picture that shows a STEP stays behind', look.bands.header.items.map(i => i.id), ['h_logo', 'b1', 'b3']);
t('ONLY the pictures the header uses come along', Object.keys(look.assets), ['asset_badge']);
t('content never travels', ['pages', 'texts', 'labels', 'hiddenSteps', 'extras', 'fields', 'order'].filter(k => k in look), []);
t('…nor options that are derived from one project\'s content', Object.keys(look.options).sort(), ['dropSilent', 'numbering', 'pictureNumbers', 'toc', 'tocSteps']);
t('a project with no document has no look to give', documentLookOf(null), null);

console.log('\n── into the brand file ──');
const { payload } = buildBrand({ meta: { id: 'b', name: 'ACME', revision: 1 }, canonical: { width: 1920, height: 1080 }, sections: {}, document: look });
t('format 2 carries the block', [payload._sbsbrand.version, BRAND_VERSION, payload.document.company], [2, 2, 'ACME Ltd']);
t('a brand without a document says so', buildBrand({ meta: { id: 'b', name: 'x', revision: 1 }, canonical: null, sections: {} }).payload.document, null);

console.log('\n── another project takes the look ──');
const rogue = emptyDocument();
rogue.templates = [{ id: 'utpl_mine', name: 'acme WIDE ', text: { x: 12, y: 32, w: 186, h: 30 }, images: [{ x: 12, y: 70, w: 100, h: 60 }] },
                   { id: 'utpl_own', name: 'Rogue special', text: { x: 12, y: 32, w: 186, h: 30 }, images: [] }];
rogue.pages = [{ id: 'p1', stepIds: ['r1'], templateId: 'utpl_mine', templateAuto: false, images: [] }];
rogue.texts = { r1: { text: 'rogue text', srcHash: 'x' } };
rogue.fields = { title: 'Conveyor', docNo: 'R-1', rev: 'A', company: 'Rogue Inc' };
const fromFile = sanitizeLook(clone(payload.document));
const r = applyLook(rogue, fromFile, { newId });
t('the same-named layout is replaced IN PLACE — the page keeps wearing it', [r.doc.templates.find(x => x.id === 'utpl_mine').images.length, r.doc.pages[0].templateId], [1, 'utpl_mine']);
t('…its geometry is the brand\'s now', r.doc.templates.find(x => x.id === 'utpl_mine').text.h, 60);
t('a layout the project lacked is added under a NEW id', r.doc.templates.map(x => x.name), ['ACME wide', 'Rogue special', 'ACME pair']);
t('the project\'s own layout is untouched', r.doc.templates.find(x => x.id === 'utpl_own'), rogue.templates[1]);
t('the default layout points at THIS project\'s id for that name', r.doc.templateId, 'utpl_mine');
const pic = r.doc.bands.header.items.find(i => i.id === 'b1');
t('the header picture arrives WITH its asset, under a local id', [pic.assetId !== 'asset_badge', r.doc.assets[pic.assetId]?.dataUrl === PNG], [true, true]);
t('the watermark and the company name are the brand\'s', [r.doc.watermark.text, r.doc.fields.company], ['ACME INTERNAL', 'ACME Ltd']);
t('this project\'s content is untouched', [r.doc.pages.length, r.doc.texts.r1.text, r.doc.fields.title, r.doc.fields.docNo], [1, 'rogue text', 'Conveyor', 'R-1']);
t('options: the look\'s, and only those', [r.doc.options.numbering, r.doc.options.tocSteps, r.doc.options.direction, r.doc.options.includeHidden], ['page', false, 'auto', false]);
t('the preview names every part that changes', changed(r).sort(), ['ACME pair:add', 'ACME wide:update', 'Company name:update', 'Default page layout:update', 'Header and footer:update', 'Numbering and contents options:update', 'Watermark:update']);

console.log('\n── updating from the same brand again changes NOTHING ──');
const again = applyLook(r.doc, fromFile, { newId });
t('every row is "same"', [changed(again), again.changed], [[], false]);
t('no second copy of the header picture', Object.keys(again.doc.assets).length, Object.keys(r.doc.assets).length);

console.log('\n── a project with no document yet ──');
const fresh = applyLook(null, fromFile, { newId });
t('it gets an empty document wearing the look — no pages invented', [fresh.doc.pages.length, fresh.doc.fields.company, fresh.doc.templates.length], [0, 'ACME Ltd', 2]);

console.log('\n── a brand with the STANDARD header puts the standard header back ──');
const plain = sanitizeLook(clone(documentLookOf(emptyDocument())));
const back = applyLook(r.doc, plain, { newId });
t('bands → null, and the preview says so', [back.doc.bands, changed(back).includes('Header and footer:update')], [null, true]);
t('an empty company name in the brand does not blank the project\'s', back.doc.fields.company, 'ACME Ltd');

console.log('\n── a hostile / hand-edited file ──');
const evil = sanitizeLook({
  templates: [{ name: 'X', text: { x: '0;background:url(javascript:1)', y: 32, w: 186, h: 60 }, images: [{ x: 12, y: 40, w: 100, h: 100 }] },     // overlaps its own text box
              { name: '<img onerror=1>', text: { x: 12, y: 32, w: 186, h: 30 }, images: [] }, { name: '<IMG onerror=1>', text: {}, images: [] }],
  defaultTemplate: { name: 'nope' },
  assets: { 'bad id!': { dataUrl: PNG, w: 1, h: 1 }, ok_1: { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=', w: 1, h: 1 }, ok_2: { dataUrl: PNG, w: 1, h: 1, name: 7 } },
  bands: { header: { items: [{ id: 'a', type: 'image', assetId: 'ok_1', x: 12, y: 10, w: 20, h: 10 }, { id: 'b', type: 'image', assetId: 'ok_2', x: 40, y: 10, w: 20, h: 10 }, { id: 'c', type: 'image', stepId: 's9', x: 70, y: 10, w: 20, h: 10 }] } },
  watermark: { enabled: true, kind: 'image', image: { dataUrl: 'javascript:alert(1)', w: 10, h: 10 }, color: 'red;}body{display:none' },
  options: { numbering: 'evil', toc: 'yes', ifaceAdjust: { a: 9 }, direction: 'rtl', tocSteps: true },
  company: { toString() { return 'x'.repeat(999); } },
});
t('an overlapping layout is refused; a duplicate name is refused', evil.templates.map(x => x.name), ['<img onerror=1>']);
t('geometry is numbers, whatever the file said', typeof evil.templates[0].text.x, 'number');
t('a default that names nothing falls back to a built-in', evil.defaultTemplate, { builtin: 'tpl_standard' });
t('only real image data, under sane ids', Object.keys(evil.assets), ['ok_2']);
t('a picture without its asset, and a step picture, are dropped', evil.bands.header.items.map(i => i.id), ['b']);
t('the watermark picture and colour are validated', [evil.watermark.image, evil.watermark.color], [null, '#808080']);
t('options: only known keys with valid values', evil.options, { tocSteps: true });
t('the company name is a bounded string', evil.company.length, 200);
t('not an object at all → no look', [sanitizeLook(null), sanitizeLook('x')], [null, null]);

console.log(`\n${fail ? fail + ' FAILED' : 'all passed'}`);
process.exit(fail ? 1 : 0);
