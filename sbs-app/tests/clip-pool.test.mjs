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

console.log('\n── the FRAME (V0.3.4.91): a copy from a 1280×720 project pasted into a 1920×1080 one ──');
{
  state.setState({ export: { width: 1920, height: 1080 }, styleTemplates: [], shapeStyles: [], constTextBoxes: [], constShapes: [], brand: null });
  const from = { sbs: 1, kind: 'overlay', at: 1, origin: { brand: null, canonical: { width: 1280, height: 720 } }, payload: { items: [] } };
  const sc = pool.canonicalScale(from);
  t('the ratio of the two frames', [sc.sx, sc.sy, sc.same], [1.5, 1.5, false]);
  t('an older envelope with no frame is taken as it is', pool.canonicalScale({ sbs: 1, kind: 'overlay', payload: {} }).same, true);
  t('the same frame on both sides is 1:1', pool.canonicalScale({ origin: { canonical: { width: 1920, height: 1080 } } }).same, true);
  const items = [
    { spec: { className: 'Image', attrs: { x: 100, y: 50, width: 400, height: 80, textHtml: 'Title', textWidth: 400 } }, capturedAt: { x: 100, y: 50 } },
    { spec: { className: 'Image', attrs: { x: 10, y: 10, width: 200, height: 100, src: 'data:,', cropX: 5, cropY: 5, cropWidth: 50, cropHeight: 50, cropMask: { kind: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.5 } } }, capturedAt: { x: 10, y: 10 } },
    { spec: { className: 'Circle', attrs: { x: 40, y: 40, radius: 10, name: 'userShape' } }, capturedAt: { x: 40, y: 40 } },
    { spec: { className: 'Arrow', attrs: { x: 0, y: 0, points: [0, 0, 100, 50], name: 'userShape', strokeWidth: 3 } }, capturedAt: { x: 0, y: 0 } },
    { spec: { className: 'Ellipse', attrs: { x: 40, y: 40, radiusX: 10, radiusY: 20, name: 'userShape' } }, capturedAt: { x: 40, y: 40 } },
    { spec: { className: 'Rect', attrs: { x: 40, y: 40, width: 30, height: 20, name: 'userShape' } }, capturedAt: { x: 40, y: 40 } },
    { spec: { className: 'Arrow', attrs: { x: 40, y: 40, points: [0, 0, 100, 50], name: 'userShape', kind: 'anchor3d', anchorA: [1, 2, 3], anchorB: [4, 5, 6] } }, capturedAt: { x: 40, y: 40 } },
    { spec: { className: 'Image', attrs: { x: 40, y: 40, width: 300, height: 100, isTable: true, tableWidth: 300, tableHeight: 100, tableData: { rows: 2, cols: 2, size: 15, rowH: [40, 0] } } }, capturedAt: { x: 40, y: 40 } },
  ];
  const out = pool.scaleOverlayItems(items, sc);
  const A = out.map(e => e.spec.attrs);
  t('a text box: position, width and height follow the frame; its text is the style\'s size still', [A[0].x, A[0].y, A[0].width, A[0].height, A[0].textWidth], [150, 75, 600, 120, 600]);
  t('a picture keeps its proportions; its own crop and its 0..1 mask are untouched', [A[1].width, A[1].height, A[1].cropX, A[1].cropWidth, A[1].cropMask], [300, 150, 5, 50, { kind: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.5 }]);
  t('a circle: one radius; an arrow: its points; an ellipse: both radii, uniformly; a rect: width and height, uniformly', [A[2].radius, A[3].points, [A[4].radiusX, A[4].radiusY], [A[5].width, A[5].height]], [15, [0, 0, 150, 75], [15, 30], [45, 30]]);
  t('a 3D-anchored arrow: only its origin (its points are derived every frame)', [A[6].x, A[6].points], [60, [0, 0, 100, 50]]);
  t('a table: frame, row heights (auto rows stay auto); its text size stays', [A[7].tableWidth, A[7].tableHeight, A[7].tableData.rowH, A[7].tableData.size], [450, 150, [60, 0], 15]);
  t('paste-in-place lands at the same share of the frame', out.map(e => [e.capturedAt.x, e.capturedAt.y])[0], [150, 75]);
  t('the input was not touched', [items[0].spec.attrs.x, items[0].capturedAt.x, items[7].spec.attrs.tableData.rowH], [100, 100, [40, 0]]);
  t('1:1 hands the same array back', pool.scaleOverlayItems(items, { sx: 1, sy: 1 }) === items, true);

  // a constant title brought along (rule 4) is pinned at the same share of the frame
  const env2 = { ...from, payload: { items: [], defs: { constTexts: [{ id: 'c1', name: 'Doc title', anchor: 'tr', x: 1240, y: 20, styleId: null }], constShapes: [{ id: 'p1', name: 'Stamp', anchor: 'tl', x: 100, y: 660 }] }, links: {} } };
  const r = pool.remapDefs(env2, [{ className: 'Image', attrs: { textHtml: 'x', constId: 'c1' } }, { className: 'Rect', attrs: { constShapeId: 'p1' } }]);
  t('the constant title and the pinned position came along, fitted', [state.get('constTextBoxes').map(d => [d.name, d.x, d.y, d.anchor]), state.get('constShapes').map(d => [d.x, d.y])], [[['Doc title', 1860, 30, 'tr']], [[150, 990]]]);
  t('…and the items point at them', [r.specs[0].attrs.constId === state.get('constTextBoxes')[0].id, r.specs[1].attrs.constShapeId === state.get('constShapes')[0].id], [true, true]);
  r.undo();
  t('undo takes both out', [state.get('constTextBoxes').length, state.get('constShapes').length], [0, 0]);

  // a change of ASPECT: a text box follows per axis, a picture keeps its proportions by the width ratio
  state.setState({ export: { width: 1080, height: 1080 } });
  const sq = pool.canonicalScale(from);
  const o2 = pool.scaleOverlayItems(items.slice(0, 2), sq).map(e => e.spec.attrs);
  t('square frame: text per axis, picture uniform', [[o2[0].width, o2[0].height], [o2[1].width, o2[1].height]], [[337.5, 120], [168.75, 84.375]]);
}

console.log(`\n${fail ? fail + ' FAILED' : 'all passed'}`);
process.exit(fail ? 1 : 0);
