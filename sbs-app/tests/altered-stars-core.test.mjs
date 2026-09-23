// ★ The star rules for hardware / note templates (V0.3.4.95), offline:  node tests/altered-stars-core.test.mjs
// altered-stars-core.js is pure — no state, no DOM.
import * as C from '../src/systems/altered-stars-core.js';

let fail = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log((ok ? '  ok   ' : ' FAIL  ') + name.padEnd(84) + (ok ? '' : `\n         got    ${JSON.stringify(got)}\n         wanted ${JSON.stringify(want)}`)); };

// A tree: a model with two parts; a screw (hardware instance) under part A, another under part B.
const tree = { id: 'root', type: 'folder', children: [
  { id: 'model', type: 'model', children: [
    { id: 'A', type: 'mesh', children: [{ id: 'screwA', type: 'hardwareInstance', templateId: 'hw1', children: [] }] },
    { id: 'B', type: 'mesh', children: [{ id: 'screwB', type: 'hardwareInstance', templateId: 'hw2', children: [] }] },
  ] },
] };
const step = (id, vis) => ({ id, snapshot: { tree, visibility: vis } });
const steps = [
  step('s1', {}),                                   // everything shown
  step('s2', { screwA: false }),                    // screw A hidden by its own flag
  step('s3', { A: false }),                         // part A hidden → screw A hidden by inheritance
  step('s4', { model: false }),                     // nothing shown
];
const visibleOf = (s) => C.visibleIds(s.snapshot.tree, s.snapshot.visibility);

console.log('── 🔩 hardware templates ──');
t('template hw1 → the steps where screw A is effectively visible', C.stepsWithVisibleHardwareTemplates(steps, new Set(['hw1']), visibleOf), ['s1']);
t('template hw2 → screw B shows wherever the model does', C.stepsWithVisibleHardwareTemplates(steps, new Set(['hw2']), visibleOf), ['s1', 's2', 's3']);
t('an unused template touches nothing', C.stepsWithVisibleHardwareTemplates(steps, new Set(['hw9']), visibleOf), []);

console.log('\n── 📝 note templates ──');
const notes = [
  { id: 'n1', templateId: 'nt1', anchorMeshId: 'A', localVisible: true },
  { id: 'n2', templateId: 'nt2', anchorMeshId: 'B', localVisible: false },   // hidden note — never drawn
  { id: 'n3', templateId: null,  anchorMeshId: 'B', localVisible: true },    // standalone — no template
];
t('a linked note follows its anchor part', C.stepsWithNoteTemplates(steps, new Set(['nt1']), notes, visibleOf), ['s1', 's2']);
t('a hidden note counts for nothing', C.stepsWithNoteTemplates(steps, new Set(['nt2']), notes, visibleOf), []);
t('a template no note links to touches nothing', C.stepsWithNoteTemplates(steps, new Set(['nt7']), notes, visibleOf), []);

console.log('\n── the signatures the watchers diff ──');
t('a hardware template: name ignored, params count', [C.defSig({ id: 'hw1', name: 'M4', kind: 'screw', params: { diameter: 4 } }, ['name']) === C.defSig({ id: 'hw1', name: 'renamed', kind: 'screw', params: { diameter: 4 } }, ['name']),
  C.defSig({ id: 'hw1', name: 'M4', kind: 'screw', params: { diameter: 4 } }, ['name']) === C.defSig({ id: 'hw1', name: 'M4', kind: 'screw', params: { diameter: 5 } }, ['name'])], [true, false]);
t('a note template: text and size count', C.defSig({ id: 'nt1', name: 'x', text: 'Tighten', sizePresetId: 'medium', customFontSize: null }, ['name']) === C.defSig({ id: 'nt1', name: 'x', text: 'Loosen', sizePresetId: 'medium', customFontSize: null }, ['name']), false);

console.log(`\n${fail ? fail + ' FAILED' : 'all passed'}`);
process.exit(fail ? 1 : 0);
