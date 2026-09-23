// The clipboard pool's definition rules, offline:  node tests/clip-pool.test.mjs
// state.js reads window.sbsNative once at start-up; schema.js and brand-core.js are pure.
globalThis.window = globalThis.window || {};
const { state } = await import('../src/core/state.js');
const pool = await import('../src/systems/clip-pool.js');

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? '  ok   ' : ' FAIL  ') + name.padEnd(80) + (ok ? '' : `\n         got    ${JSON.stringify(got)}\n         wanted ${JSON.stringify(want)}`)); };

// ── the SOURCE project: two text styles, one linked to a brand ──
state.setState({
  styleTemplates: [{ id: 'st_a', name: 'Title', fontSize: 40 }, { id: 'st_b', name: 'Caption', fontSize: 12 }],
  shapeStyles: [{ id: 'sh_1', name: 'Highlight', stroke: '#f00' }],
  brand: { id: 'brand_acme', name: 'ACME', revision: 3, links: { textStyles: { st_a: { brandId: 'B_TITLE', hash: 'x' } } } },
});
const specs = [
  { className: 'Image', attrs: { textHtml: '<p>Hello <b>world</b></p><p>Line two</p>', styleId: 'st_a' } },
  { className: 'Image', attrs: { textHtml: 'Small print', styleId: 'st_b' } },
  { className: 'Rect',  attrs: { shapeStyleId: 'sh_1' } },
  { className: 'Rect',  attrs: {} },
];
const carried = pool.collectDefs(specs);
t('the copy carries exactly the definitions the items point at', [carried.defs.textStyles.map(d => d.id), carried.defs.shapeStyles.map(d => d.id)], [['st_a', 'st_b'], ['sh_1']]);
t('…and their brand links', carried.links, { textStyles: { st_a: 'B_TITLE' } });
t('the plain text a stranger gets', pool.overlayPlainText(specs), 'Hello world\nLine two\n\nSmall print');

const env = { sbs: 1, kind: 'overlay', at: 1, origin: { brand: { id: 'brand_acme', name: 'ACME', revision: 3 } }, payload: { items: [], ...carried } };

console.log('\n── paste into the SAME project (same window, or the same file in another window) ──');
{
  const r = pool.remapDefs(env, specs);
  t('every id exists here → untouched, nothing added', [r.specs.map(s => s.attrs.styleId ?? s.attrs.shapeStyleId ?? null), r.added.length], [['st_a', 'st_b', 'sh_1', null], 0]);
}

console.log('\n── paste into a project wearing the SAME brand ──');
{
  state.setState({
    styleTemplates: [{ id: 'x_title', name: 'Heading', fontSize: 44 }, { id: 'x_cap', name: 'caption', fontSize: 11 }],
    shapeStyles: [],
    brand: { id: 'brand_acme', name: 'ACME', revision: 3, links: { textStyles: { x_title: { brandId: 'B_TITLE', hash: 'y' } } } },
  });
  const r = pool.remapDefs(env, specs);
  t('the brand-linked style → THIS project\'s copy of that brand definition (by brand id, not name)', r.specs[0].attrs.styleId, 'x_title');
  t('an unlinked style with the same name here (case-blind) → this project\'s', r.specs[1].attrs.styleId, 'x_cap');
  t('a shape style with no match → brought along under a NEW id', [r.specs[2].attrs.shapeStyleId !== 'sh_1', r.added.map(a => a.name)], [true, ['Highlight']]);
  t('…and it is in the state now', state.get('shapeStyles').map(d => d.name), ['Highlight']);
  t('the undo takes it out again', (r.undo(), state.get('shapeStyles').length), 0);
  t('…and the redo puts it back', (r.redo(), state.get('shapeStyles').map(d => d.name)), ['Highlight']);
}

console.log('\n── paste into a project with ANOTHER brand (or none) ──');
{
  state.setState({ styleTemplates: [{ id: 'q1', name: 'Title', fontSize: 20 }], shapeStyles: [], brand: { id: 'brand_other', name: 'Other', revision: 1, links: {} } });
  const r = pool.remapDefs(env, specs);
  t('brand ids mean nothing here: "Title" is matched by NAME to this project\'s (its look wins)', r.specs[0].attrs.styleId, 'q1');
  t('"Caption" and "Highlight" come along', r.added.map(a => a.name), ['Caption', 'Highlight']);
  t('the two items that pointed at the same copied id point at the same new id', (() => { const r2 = pool.remapDefs(env, [specs[1], specs[1]]); return r2.specs[0].attrs.styleId === r2.specs[1].attrs.styleId; })(), true);
}

console.log('\n── an old envelope with no definitions ──');
{
  state.setState({ styleTemplates: [], shapeStyles: [], brand: null });
  const r = pool.remapDefs({ sbs: 1, kind: 'overlay', payload: { items: [] } }, specs);
  t('nothing to resolve with → ids left as they are, nothing added', [r.specs[0].attrs.styleId, r.added.length, r.undo], ['st_a', 0, null]);
}

console.log(`\n${fail ? fail + ' FAILED' : 'all passed'}`);
process.exit(fail ? 1 : 0);
