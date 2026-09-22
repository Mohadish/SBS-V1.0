// Brand core, offline:  node tests/brand-core.test.mjs   (npm run test:brand)
//
// brand-core.js rewrites a customer's styles, header, constant titles, pinned positions and crop
// masks IN PLACE, across every project linked to a brand — and had no test in the repo. This is
// the round trip every change to it must survive: save → load elsewhere → new revision → update.
// Pure: brand-core imports nothing, so this needs no app, no DOM, no shims.
import { SECTIONS, BRAND_VERSION, brandFormatOf, buildBrand, mergeBrand, summarizeMerge, brandDrift, driftSince, unlinkedCount, defHash } from '../src/systems/brand-core.js';

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? '  ok   ' : ' FAIL  ') + name.padEnd(78) + (ok ? '' : `\n         got    ${JSON.stringify(got)}\n         wanted ${JSON.stringify(want)}`)); };
const clone = (v) => JSON.parse(JSON.stringify(v));
let seq = 0;
const newId = (p) => `${p}_new${++seq}`;
const empty = () => Object.fromEntries(SECTIONS.map(s => [s.key, []]));
const view = (sections, links = {}, canonical = { width: 1920, height: 1080 }) => ({ sections: { ...empty(), ...sections }, links, headerDefault: null, canonical });
const actions = (plan) => plan.rows.filter(r => r.action !== 'same').map(r => `${r.section || r.label}:${r.name}:${r.action}`).sort();

// ── the company's project: where the brand is saved from ──
const acme = view({
  textStyles:  [{ id: 'st_title', name: 'Title', fontSize: 48, fill: '#003366' }, { id: 'st_body', name: 'Body', fontSize: 22, fill: '#111111' }],
  shapeStyles: [{ id: 'sh_hi', name: 'Highlight', stroke: '#ff0000', strokeWidth: 4 }],
  constTexts:  [{ id: 'ct_step', name: 'Step title', styleId: 'st_title', x: 960, y: 100 }],
  cropMasks:   [{ id: 'cm_detail', name: 'Detail window', kind: 'rect', x: 0.6, y: 0.1, w: 0.3, h: 0.3, rot: 0 }],
});
const saved = buildBrand({ meta: { id: 'brand_acme', name: 'ACME', revision: 1 }, canonical: acme.canonical, sections: acme.sections, headerDefault: null, links: {} });
const brand1 = clone(saved.payload);

console.log('── saving ──');
t('the file carries the format number', brand1._sbsbrand.version, BRAND_VERSION);
t('every section the core knows is written, as a list', SECTIONS.every(s => Array.isArray(brand1.sections[s.key])), true);
t('a reference between sections is re-pointed to the BRAND id', brand1.sections.constTexts[0].styleId, brand1.sections.textStyles[0].id);
t('the saving project comes out linked, hash = its own definition', saved.links.textStyles.st_title, { brandId: brand1.sections.textStyles[0].id, hash: defHash(acme.sections.textStyles[0]) });

console.log('\n── the saving project loads its own brand: nothing to do ──');
{
  const plan = mergeBrand({ ...acme, links: saved.links }, brand1, { newId });
  t('every row is "same"', actions(plan), []);
  t('no definition id changed', plan.sections.textStyles.map(d => d.id), ['st_title', 'st_body']);
}

console.log('\n── another project, never linked, same names, its own look and ids ──');
const rogue = view({
  textStyles: [{ id: 'x1', name: 'Title', fontSize: 30, fill: '#00ff00' }, { id: 'x2', name: 'Rogue special', fontSize: 12, fill: '#ff00ff' }],
  constTexts: [{ id: 'x3', name: 'Step title', styleId: 'x1', x: 640, y: 60 }],
}, {}, { width: 1280, height: 720 });
t('it has definitions the brand must be matched against', unlinkedCount(rogue, brand1) > 0, true);
const first = mergeBrand(rogue, brand1, { newId });                 // no wizard: exact names are taken over
t('same NAME is taken over and KEEPS the project id (every binding survives)', (({ id, name, fontSize, fill }) => [id, name, fontSize, fill])(first.sections.textStyles.find(d => d.name === 'Title')), ['x1', 'Title', 48, '#003366']);
t("the project's own definition is not touched", first.sections.textStyles.find(d => d.name === 'Rogue special'), rogue.sections.textStyles[1]);
t('what the project lacked is added', first.sections.textStyles.some(d => d.name === 'Body') && first.sections.shapeStyles.length === 1 && first.sections.cropMasks.length === 1, true);
t('a reference lands on the PROJECT id of its target', first.sections.constTexts[0].styleId, 'x1');
t('a position is scaled to this project\'s frame (1920 → 1280), to 2 decimals', [first.sections.constTexts[0].x, first.sections.constTexts[0].y], [640, 66.67]);
t('a crop mask is NOT scaled (it is in fractions of the frame)', first.sections.cropMasks[0].w, 0.3);
t('the summary counts what happened', (({ link, add }) => [link, add])(summarizeMerge(first.rows)), [2, 3]);

console.log('\n── the company changes its standard: revision 2 ──');
const acme2 = clone(acme);
acme2.sections.textStyles[0].fill = '#aa0000';                      // Title goes red
acme2.sections.textStyles.pop();                                    // Body is dropped from the standard
const saved2 = buildBrand({ meta: { id: 'brand_acme', name: 'ACME', revision: 2 }, canonical: acme2.canonical, sections: acme2.sections, headerDefault: null, links: saved.links });
const brand2 = clone(saved2.payload);
t('brand ids are STABLE across revisions', brand2.sections.textStyles[0].id, brand1.sections.textStyles[0].id);
{
  const linked = { ...rogue, sections: first.sections, links: first.links };
  const plan = mergeBrand(linked, brand2, { newId });
  t('the linked definition updates in place', plan.sections.textStyles.find(d => d.id === 'x1').fill, '#aa0000');
  t('what the brand dropped is KEPT, and reported', [plan.sections.textStyles.some(d => d.name === 'Body'), plan.rows.some(r => r.name === 'Body' && r.action === 'orphan')], [true, true]);
  t('only what changed is named for a repaint', plan.changed.styleTemplates, ['x1']);

  // the user edits a brand definition in this project, then the brand updates
  const edited = clone(linked); edited.sections.textStyles[0].fontSize = 99;
  t('an edit to a linked definition is DRIFT', brandDrift(edited.sections, edited.links).map(r => r.id), ['x1']);
  t('…and nothing else is', brandDrift(linked.sections, linked.links), []);
  t('only THIS session\'s drift is reported', driftSince(brandDrift(edited.sections, edited.links), new Map(brandDrift(edited.sections, edited.links).map(r => [`${r.section}/${r.id}`, r.hash]))), []);
  const keep = mergeBrand(edited, brand2, { newId, skipLocalChanged: true });
  t('"keep what I edited here" leaves that one alone', keep.sections.textStyles.find(d => d.id === 'x1').fontSize, 99);
}

console.log('\n── 🏷 the brand\'s logo matches the project\'s logo (V0.3.4.79) ──');
{
  const items = (p) => [{ id: `${p}_a`, kind: 'image', dataUrl: 'data:image/png;base64,AAAA', x: 10, y: 10, w: 100, h: 50 }, { id: `${p}_logo`, kind: 'image', isLogo: true, dataUrl: 'data:image/png;base64,BBBB', x: 900, y: 10, w: 100, h: 50 }];
  const src = view({ headerItems: items('src') });
  const b = clone(buildBrand({ meta: { id: 'bl', name: 'L', revision: 1 }, canonical: src.canonical, sections: src.sections, headerDefault: null, links: {} }).payload);
  const dst = view({ headerItems: items('dst').reverse() });                       // the other project lists them the other way round
  const plan = mergeBrand(dst, b, { newId });
  const took = plan.sections.headerItems.find(d => d.id === 'dst_logo');
  t('the logo takes over the LOGO, not the first image', [took.isLogo, took.dataUrl], [true, 'data:image/png;base64,BBBB']);
  t('…and the plain image the plain image', plan.sections.headerItems.find(d => d.id === 'dst_a').dataUrl, 'data:image/png;base64,AAAA');
}

console.log('\n── the file format ──');
t('a file with no version is format 1', brandFormatOf({ _sbsbrand: {} }), { version: 1, newer: false });
t('this build\'s own files are not "newer"', brandFormatOf(brand1).newer, false);
t('a file from a later SBS IS', brandFormatOf({ _sbsbrand: { version: BRAND_VERSION + 1 } }), { version: BRAND_VERSION + 1, newer: true });
t('garbage in the field reads as format 1, never throws', [brandFormatOf({ _sbsbrand: { version: 'x' } }).version, brandFormatOf(null).version], [1, 1]);
{
  const future = clone(brand1); future.sections.somethingNew = [{ id: 'q', name: 'Q' }]; delete future.sections.cropMasks;
  const plan = mergeBrand(rogue, future, { newId });
  t('an unknown section is ignored, a missing one reads as empty — no throw', [plan.sections.cropMasks.length, 'somethingNew' in plan.sections], [0, false]);
}

console.log(`\n${fail ? fail + ' FAILED' : 'all passed'}`);
process.exit(fail ? 1 : 0);
