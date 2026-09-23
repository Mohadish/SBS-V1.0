// ★ Altered-step stars — the WIRING half (V0.3.2.253, reasons + undo in .254).
//
// The star ("changed since the last render", cleared by a render) used to be
// set only by the writers that edit the ACTIVE step by hand. Everything that
// changes a step's pixels from OUTSIDE it stayed unstarred: definition edits
// (a colour preset, a camera template, an overlay style, an animation preset,
// a primitive's size), multi-step tools (Global Mode carry, follow, group fix,
// hardware inject, clean-up, language switch), reorder / delete / hide (the
// NEXT step's transition-in changes), and global settings. With "trust the
// stars" those all shipped stale segments in silence.
//
// How it decides, without touching any of those writers:
//   • Everything is compared against the RENDERED baseline — what the world
//     looked like when the stars were last cleared (a render, a manual
//     "treat as rendered", or the project load). Not against "a moment ago":
//     that is what makes UNDO work — undo puts the old objects / old
//     definition back, the comparison against the rendered baseline finds
//     nothing different any more, and the star this module added goes away.
//   • change:steps — a step whose snapshot / transition / camera binding /
//     overlay / narration is a DIFFERENT object than the rendered one was
//     rebuilt by some tool → reason "ref". Reference identity, never content
//     hashing: every multi-step tool builds fresh objects for the steps it
//     touches and keeps the others by reference, so this is exact and costs
//     nothing on the 700 MB project. A changed predecessor in the playable
//     order (reorder / delete / hide / chapter hide) → reason "order".
//   • definition lists — diffed by id + signature (names ignored) against
//     the rendered signatures, then mapped to the steps that actually SHOW
//     something built from them, with the same effective-visibility rule the
//     renderer uses (own flag AND every ancestor, archive wins).
//   • global settings that move every pixel (export size/fps, background,
//     render options, AL1/AL2) → every playable step.
// A step is starred while it has at least one reason. Stars set by the
// hand-edit writers (in-place, e.g. the C key) are "manual": this module
// never removes those — only the stars it added itself.
//
// V0.3.4.95 — three more definition-like things are covered: hardware
// templates (steps showing an instance built from one), note templates (steps
// where a linked note's anchor part is visible), and a model's source
// transform + a note's own text / size (their writers call
// starStepsWhereNodesVisible). The render cache keys on the same things now
// (render-cache _scopedDefs), so an incremental export is correct even with
// no star. Still NOT covered: hardware insert tags, geometry relink to a
// changed file (stable mesh ids move with the geometry, so the key catches it).
//
// Console: window.sbsDiag.stars(stepId?) explains why a step is starred.

import state                     from '../core/state.js';
import { steps }                 from './steps.js';
import { materials }             from './materials.js';
import { resolveAnimationString } from './animation.js';
import * as C                    from './altered-stars-core.js';
import * as frameVis             from './frame-visibility.js';

const DEBOUNCE_MS = 250;   // slider drags fire change:colorPresets per tick — evaluate once, after

let _suspended = false;
let _refreshQueued = false;
const _timers = new Map();

// The RENDERED baseline (see header).
const _rendered = {
  steps:    new Map(),   // stepId → { snapshot, transition, cameraBinding, overlay, narr }
  pred:     new Map(),   // stepId → predecessor id in the playable order (null = first)
  defs:     new Map(),   // state key → sigMap
  anim:     [],          // animationPresets array
  settings: '',          // signature of the pixel-affecting global settings
};
const _reasons  = new Map();   // stepId → Set<reason>
const _mine     = new Set();   // steps whose star THIS module added (the only ones it may remove)
const _lastSnap = new Map();   // stepId → snapshot object last seen (stale-record detection)

// ── helpers ─────────────────────────────────────────────────────────────────
function _playable() { return steps.getVisibleSteps(); }
function _refsOf(s) {
  return { snapshot: s.snapshot, transition: s.transition, cameraBinding: s.cameraBinding,
           overlay: s.overlay, narr: C.narrationSig(s.narration) };
}
function _sameRefs(a, b) {
  return !!a && !!b && a.snapshot === b.snapshot && a.transition === b.transition
      && a.cameraBinding === b.cameraBinding && a.overlay === b.overlay && a.narr === b.narr;
}
function _predMap(order) {
  const m = new Map();
  order.forEach((id, i) => m.set(id, i > 0 ? order[i - 1] : null));
  return m;
}
function _settingsSig() {
  const exp = state.get('export') || {};
  return JSON.stringify({
    w: exp.width, h: exp.height, fps: exp.fps, bitrate: exp.videoBitrate, stepHold: exp.stepHoldMs,
    bboxes: !!exp.exportBoundaryBoxes,
    bg: state.get('backgroundColor'), bgGrad: state.get('backgroundGradient'),
    render: state.get('render'),
    camMs: state.get('cameraAnimDurationMs'), objMs: state.get('objectAnimDurationMs'),
  });
}

// Effective visibility per step, memoised on the snapshot object. When the
// step has an in-frame record (frame-visibility.js) the answer narrows to the
// parts that really occupy pixels — still intersected with the scene rule, so
// a record older than a hide never resurrects a hidden part.
const _visMemo = new WeakMap();
function _sceneVisibleOf(step) {
  const snap = step?.snapshot;
  if (!snap || !snap.tree) return new Set();
  let v = _visMemo.get(snap);
  if (!v) { v = C.visibleIds(snap.tree, snap.visibility); _visMemo.set(snap, v); }
  return v;
}
const _frameMemo = new WeakMap();   // snapshot → { frame, set }
function _visibleOf(step) {
  const scene = _sceneVisibleOf(step);
  const frame = frameVis.visibleIn(step?.id);
  if (!frame) return scene;
  const memo = _frameMemo.get(step.snapshot);
  if (memo && memo.frame === frame) return memo.set;
  const set = new Set();
  for (const id of frame) if (scene.has(id)) set.add(id);
  if (step.snapshot) _frameMemo.set(step.snapshot, { frame, set });
  return set;
}

function _reason(id, r, on) {
  let set = _reasons.get(id);
  if (on) { if (!set) { set = new Set(); _reasons.set(id, set); } set.add(r); }
  else if (set) { set.delete(r); if (!set.size) _reasons.delete(id); }
}
function _dropReasonEverywhere(r) { for (const id of [..._reasons.keys()]) _reason(id, r, false); }
function _dropReasonsWhere(pred) {
  for (const [id, set] of _reasons) { for (const r of [...set]) if (pred(r)) set.delete(r); if (!set.size) _reasons.delete(id); }
}

// Turn the reason sets into stars: add where reasons exist, remove where this
// module's star lost every reason. Manual stars are never touched.
function _applyReasons(why) {
  const list = state.get('steps') || [];
  const ids = new Set(list.map(s => s.id));
  for (const id of [..._reasons.keys()]) if (!ids.has(id)) _reasons.delete(id);
  for (const id of [..._mine]) if (!ids.has(id)) _mine.delete(id);
  let added = 0, removed = 0;
  for (const s of list) {
    if (s.isBaseStep) continue;
    const has = _reasons.has(s.id);
    if (has && s.altered !== true) { s.altered = true; _mine.add(s.id); added++; }
    else if (!has && _mine.has(s.id)) { if (s.altered === true) { delete s.altered; removed++; } _mine.delete(s.id); }
  }
  if (added || removed) {
    state.markDirty();
    _scheduleRefresh();
    console.log(`[stars] ${added ? `★ +${added}` : ''}${added && removed ? ', ' : ''}${removed ? `☆ −${removed}` : ''} — ${why}`);
  }
  return added + removed;
}

// The steps panel draws the badge on change:steps; when a star lands inside a
// change:steps handler the panel may already have rendered. One extra emit,
// coalesced per tick — the listener sees identical references and does
// nothing, so this cannot loop.
function _scheduleRefresh() {
  if (_refreshQueued) return;
  _refreshQueued = true;
  queueMicrotask(() => {
    _refreshQueued = false;
    state.setState({ steps: [...(state.get('steps') || [])] });
  });
}

function _debounce(key, fn) {
  clearTimeout(_timers.get(key));
  _timers.set(key, setTimeout(() => { _timers.delete(key); try { fn(); } catch (e) { console.warn('[stars] listener failed:', e?.message); } }, DEBOUNCE_MS));
}

// ── baselines ───────────────────────────────────────────────────────────────
const DEF_LISTS = {
  colorPresets:   ['name'],
  cameraViews:    ['name'],
  shapeStyles:    ['name'],
  constShapes:    ['name'],
  shapeLinks:     ['name'],
  styleTemplates: ['name'],
  constTextBoxes: ['name'],
  cropMasks:      ['name'],
  shapeTemplates: ['name'],
  // A cable record carries its LIVE state too (nodes, visible, highlight —
  // rewritten on every step activation, per-step truth lives in
  // snapshot.cables). Only the style is a definition — the same projection the
  // render cache keys on. Comparing the whole record starred every step that
  // showed the cable after every render (press project, "always starred").
  cables:         (c) => ({ id: c.id, style: c.style ?? null, flexible: c.flexible ?? null }),
  hardwareTemplates: ['name'],   // 🔩 V0.3.4.95 — kind + params (+ washer names) draw the screw
  noteTemplates:     ['name'],   // 📝 V0.3.4.95 — text + size of every linked note
};

/** 📝 The live notes, projected for the note-template rule (notes are tree nodes, never in a snapshot). */
function _liveNotes() {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'note') out.push({ id: n.id, templateId: n.templateId || null, anchorMeshId: n.anchorMeshId || null, localVisible: n.localVisible !== false });
    for (const c of (n.children || [])) walk(c);
  })(state.get('treeData'));
  return out;
}
const OVERLAY_DEF_KEYS = ['shapeStyles', 'constShapes', 'shapeLinks', 'styleTemplates', 'constTextBoxes', 'cropMasks'];

function _rebaseSteps(list) {
  _rendered.steps = new Map();
  for (const s of (list || [])) if (s && !s.isBaseStep) _rendered.steps.set(s.id, _refsOf(s));
  _rendered.pred = _predMap(C.playableOrder(list, state.get('chapters') || []));
}
function _rebaseDefs() {
  for (const key of Object.keys(DEF_LISTS)) _rendered.defs.set(key, C.sigMap(state.get(key), DEF_LISTS[key]));
  _rendered.anim     = state.get('animationPresets') || [];
  _rendered.settings = _settingsSig();
}
// "Everything is as rendered": after a render, after a load, after New Project.
function _rebaseAll() {
  _rebaseSteps(state.get('steps') || []);
  _rebaseDefs();
  _reasons.clear();
  _mine.clear();
}

// ── step list: content identity, order, and clears ─────────────────────────
function _onSteps(list) {
  const cur = list || [];
  if (_suspended) return;                                   // baselines are taken at modelsSettled
  const ids = cur.filter(s => s && !s.isBaseStep).map(s => s.id);
  // Wholesale replacement (New Project, a load that never announced itself):
  // nothing in common with the baseline → take the new world as rendered.
  if (_rendered.steps.size && ids.length && !ids.some(id => _rendered.steps.has(id))) { _rebaseAll(); return; }

  // Stars CLEARED under us (a render, or "treat as rendered" on the badge):
  // those steps are now rendered as they stand. When every star this module
  // owned is gone, the definitions and settings count as rendered too.
  let cleared = 0;
  for (const s of cur) {
    if (!s || !_mine.has(s.id) || s.altered === true) continue;
    _mine.delete(s.id); _reasons.delete(s.id);
    _rendered.steps.set(s.id, _refsOf(s));
    cleared++;
  }
  const order = C.playableOrder(cur, state.get('chapters') || []);
  const pred  = _predMap(order);
  if (cleared) {
    for (const id of order) if (!_mine.has(id) && !_reasons.has(id)) _rendered.pred.set(id, pred.get(id));
    if (!_mine.size) _rebaseDefs();
  }

  // Content identity + order against the rendered baseline.
  for (const s of cur) {
    if (!s || s.isBaseStep) continue;
    const base = _rendered.steps.get(s.id);
    if (!base) { _rendered.steps.set(s.id, _refsOf(s)); continue; }   // new step — its creator stars it
    _reason(s.id, 'ref', !_sameRefs(base, _refsOf(s)));
    // A snapshot rebuilt by a tool (not by leaving the step) makes its
    // in-frame record stale → back to the scene rule until it is re-taken.
    const seen = _lastSnap.get(s.id);
    if (seen && seen !== s.snapshot) frameVis.invalidate(s.id);
    _lastSnap.set(s.id, s.snapshot);
  }
  for (const id of order) {
    if (!_rendered.pred.has(id)) { _rendered.pred.set(id, pred.get(id)); continue; }
    _reason(id, 'order', _rendered.pred.get(id) !== pred.get(id));
  }
  for (const id of [..._reasons.keys()]) if (!pred.has(id)) _reason(id, 'order', false);   // left the order (hidden)
  _applyReasons('step content / order vs last render');
}

function _onChapters() {
  if (_suspended) return;
  const pred = _predMap(C.playableOrder(state.get('steps') || [], state.get('chapters') || []));
  for (const [id, p] of pred) {
    if (!_rendered.pred.has(id)) { _rendered.pred.set(id, p); continue; }
    _reason(id, 'order', _rendered.pred.get(id) !== p);
  }
  _applyReasons('chapter visibility vs last render');
}

// ── definition lists ───────────────────────────────────────────────────────
// mapFn(idSet) → step ids that show something built from those definitions.
function _watchDefs(key, mapFn, { removedMeansAll = false } = {}) {
  state.on(`change:${key}`, () => _debounce(key, () => {
    if (_suspended) return;
    const now  = C.sigMap(state.get(key), DEF_LISTS[key]);
    const base = _rendered.defs.get(key) || new Map();
    const all  = _playable();
    const tag  = (id) => `def:${key}:${id}`;
    for (const id of new Set([...now.keys(), ...base.keys()])) {
      const r = tag(id);
      const same = now.has(id) && base.has(id) && now.get(id) === base.get(id);
      const isNew = now.has(id) && !base.has(id);              // nothing rendered used it yet
      _dropReasonEverywhere(r);
      if (same || isNew) continue;
      const hit = (!now.has(id) && removedMeansAll) ? all.map(s => s.id) : mapFn(new Set([id]), all);
      for (const sid of hit) _reason(sid, r, true);
    }
    _applyReasons(`${key} vs last render`);
  }));
}

function _initDefListeners() {
  _watchDefs('colorPresets', (ids, all) => C.stepsUsingPresets(all, materials.meshDefaultColors, ids, _visibleOf), { removedMeansAll: true });
  _watchDefs('cameraViews',  (ids, all) => C.stepsBoundToCameras(all, ids));
  for (const key of OVERLAY_DEF_KEYS) _watchDefs(key, (ids, all) => C.stepsReferencing(all, ids));
  _watchDefs('shapeTemplates', (ids, all) => C.stepsWithVisibleShapeTemplates(all, ids, _visibleOf));
  _watchDefs('cables',         (ids, all) => C.stepsWithCables(all, ids));
  _watchDefs('hardwareTemplates', (ids, all) => C.stepsWithVisibleHardwareTemplates(all, ids, _visibleOf));   // 🔩 V0.3.4.95
  _watchDefs('noteTemplates',     (ids, all) => C.stepsWithNoteTemplates(all, ids, _liveNotes(), _visibleOf));   // 📝 V0.3.4.95

  // Animation presets: a step stores only the preset id — compare what each
  // step RESOLVES to under the rendered presets and under the current ones.
  state.on('change:animationPresets', () => _debounce('animationPresets', () => {
    if (_suspended) return;
    const now = state.get('animationPresets') || [];
    for (const s of _playable()) {
      let a = '', b = '';
      try { a = resolveAnimationString(s.transition || {}, _rendered.anim) || ''; } catch { a = '?'; }
      try { b = resolveAnimationString(s.transition || {}, now) || ''; } catch { b = '!'; }
      _reason(s.id, 'anim', a !== b);
    }
    _applyReasons('animation presets vs last render');
  }));

  // Global settings that move every rendered pixel → every playable step.
  const onSettings = () => _debounce('settings', () => {
    if (_suspended) return;
    const on = _settingsSig() !== _rendered.settings;
    for (const s of _playable()) _reason(s.id, 'settings', on);
    if (!on) _dropReasonEverywhere('settings');
    _applyReasons('render/export settings vs last render');
  });
  for (const key of ['export', 'backgroundColor', 'backgroundGradient', 'render', 'cameraAnimDurationMs', 'objectAnimDurationMs']) {
    state.on(`change:${key}`, onSettings);
  }
}

// ── public helpers for writers that know exactly what they touched ─────────
/** Star every playable step in which one of these nodes is visible (primitive resize, …). */
export function starStepsWhereNodesVisible(nodeIds, why = 'object definition changed') {
  if (_suspended) return 0;
  const ids = new Set(nodeIds || []);
  if (!ids.size) return 0;
  for (const sid of C.stepsWithVisibleNodes(_playable(), ids, _visibleOf)) _reason(sid, `node:${why}`, true);
  return _applyReasons(why);
}

/** Star specific steps (a tool that already holds the list it touched). */
export function markStepsAltered(stepIds, why = 'edited by a tool') {
  if (_suspended) return 0;
  for (const sid of (stepIds || [])) _reason(sid, `tool:${why}`, true);
  return _applyReasons(why);
}

// ── console diagnostic: why is this step starred? ──────────────────────────
function _explain(stepId) {
  const all = state.get('steps') || [];
  const targets = stepId ? all.filter(s => s.id === stepId) : all.filter(s => s.altered === true);
  const nodeById = state.get('nodeById');
  const nameOf = (id) => nodeById?.get(id)?.name || id;
  const lines = [];
  for (const s of targets) {
    const rs = [..._reasons.get(s.id) || []];
    const who = s.altered !== true ? 'not starred' : _mine.has(s.id) ? 'starred by a rule' : 'starred by a hand edit on this step';
    const rec = frameVis.hasRecord(s.id) ? `in-frame record: ${frameVis.visibleIn(s.id).size} part(s)` : 'no in-frame record (scene rule)';
    lines.push(`"${s.name}" (${s.id}): ${who}${rs.length ? ' — ' + rs.join(', ') : ''} [${rec}]`);
    for (const r of rs) {
      const m = /^def:colorPresets:(.+)$/.exec(r);
      if (!m) continue;
      const pid = m[1], mats = s.snapshot?.materials || {}, D = materials.meshDefaultColors || {};
      const wearers = [..._visibleOf(s)].filter(id => (mats[id] ?? D[id]) === pid).map(nameOf);
      lines.push(`     colour ${pid} is worn by ${wearers.length} visible part(s): ${wearers.slice(0, 12).join(', ')}${wearers.length > 12 ? ', …' : ''}`);
    }
  }
  const out = lines.join('\n') || 'no starred steps';
  console.log(out);
  return out;
}

// ── init ────────────────────────────────────────────────────────────────────
let _inited = false;
export function initAlteredStars() {
  if (_inited) return;
  _inited = true;
  _rebaseAll();

  state.on('project:loaded', () => {
    _suspended = true;
    // Safety net: a load that dies before modelsSettled must not mute the
    // stars for the rest of the session.
    setTimeout(() => { if (_suspended && state.get('treeData')) { _rebaseAll(); _suspended = false; } }, 180000);
  });
  state.on('project:modelsSettled', () => { _rebaseAll(); _suspended = false; });

  state.on('change:steps',    _onSteps);
  state.on('change:chapters', _onChapters);
  _initDefListeners();
  frameVis.initFrameVisibility();

  if (typeof window !== 'undefined') {
    window.sbsDiag = window.sbsDiag || {};
    window.sbsDiag.stars = _explain;
  }
}
