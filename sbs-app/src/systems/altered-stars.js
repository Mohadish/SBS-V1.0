// ★ Altered-step stars — the WIRING half (V0.3.2.253).
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
// This module closes that gap without touching any of those writers:
//   • change:steps — a step whose snapshot / transition / camera binding /
//     overlay / narration is a DIFFERENT object than last time was rebuilt by
//     some tool → star it. Reference identity, never content hashing: every
//     multi-step tool builds fresh objects for the steps it touches and keeps
//     the others by reference, so this is exact and costs nothing on the
//     700 MB project. Order changes star the step whose predecessor moved.
//   • definition lists — diffed by id + signature (names ignored), then
//     mapped to the steps that actually SHOW something built from them, with
//     the same effective-visibility rule the renderer uses.
//   • global settings that move every pixel (export size/fps, background,
//     render options, AL1/AL2) → every playable step.
// Loading is silent: baselines are (re)taken at project:modelsSettled.
//
// Deliberately NOT covered (no reliable signal in the data yet): hardware
// templates / insert tags, note templates, model geometry (relink / source
// transform). Those are the "trust" holes — see project memory.

import state                     from '../core/state.js';
import { steps }                 from './steps.js';
import { materials }             from './materials.js';
import { resolveAnimationString } from './animation.js';
import * as C                    from './altered-stars-core.js';

const DEBOUNCE_MS = 250;   // slider drags fire change:colorPresets per tick — star once, after

let _suspended = false;
let _refreshQueued = false;
const _timers = new Map();

// Baselines: what the world looked like the last time we checked.
const _base = {
  steps:  new Map(),   // stepId → { snapshot, transition, cameraBinding, overlay, narr }
  order:  [],          // playable order (ids)
  defs:   new Map(),   // state key → sigMap
  anim:   [],          // animationPresets array (for resolve-and-compare)
  settings: '',        // signature of the pixel-affecting global settings
};

// ── star writer ─────────────────────────────────────────────────────────────
function _playable() { return steps.getVisibleSteps(); }

function _star(ids, why) {
  if (!ids || !ids.length) return 0;
  const want = new Set(ids);
  let n = 0;
  for (const s of (state.get('steps') || [])) {
    if (!want.has(s.id) || s.isBaseStep || s.altered === true) continue;
    s.altered = true;
    n++;
  }
  if (n) {
    state.markDirty();
    _scheduleRefresh();
    console.log(`[stars] ★ ${n} step(s) — ${why}`);
  }
  return n;
}

// The steps panel draws the badge on change:steps; when a star lands inside a
// change:steps handler the panel may already have rendered. One extra emit,
// coalesced per tick — the listener below sees identical references and does
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

// ── effective visibility per step (memoised on the snapshot object) ────────
const _visMemo = new WeakMap();
function _visibleOf(step) {
  const snap = step?.snapshot;
  if (!snap || !snap.tree) return new Set();
  let v = _visMemo.get(snap);
  if (!v) { v = C.visibleIds(snap.tree, snap.visibility); _visMemo.set(snap, v); }
  return v;
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
  cables:         ['name'],
};
const OVERLAY_DEF_KEYS = ['shapeStyles', 'constShapes', 'shapeLinks', 'styleTemplates', 'constTextBoxes', 'cropMasks'];

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

function _rebaseSteps(list) {
  const m = new Map();
  for (const s of (list || [])) {
    if (!s || s.isBaseStep) continue;
    m.set(s.id, { snapshot: s.snapshot, transition: s.transition, cameraBinding: s.cameraBinding,
                  overlay: s.overlay, narr: C.narrationSig(s.narration) });
  }
  _base.steps = m;
  _base.order = C.playableOrder(list, state.get('chapters') || []);
}
function _rebaseDef(key) { _base.defs.set(key, C.sigMap(state.get(key), DEF_LISTS[key])); }
function _rebaseAll() {
  _rebaseSteps(state.get('steps') || []);
  for (const key of Object.keys(DEF_LISTS)) _rebaseDef(key);
  _base.anim = state.get('animationPresets') || [];
  _base.settings = _settingsSig();
}

// ── step list: content identity + order ────────────────────────────────────
function _onSteps(list) {
  const cur = list || [];
  if (_suspended) { _rebaseSteps(cur); return; }
  const base = _base.steps;
  const ids  = cur.filter(s => s && !s.isBaseStep).map(s => s.id);
  // Wholesale replacement (New Project, a load that never announced itself):
  // nothing in common with the baseline → take the new world as-is.
  if (base.size && ids.length && !ids.some(id => base.has(id))) { _rebaseSteps(cur); return; }

  const hit = [];
  for (const s of cur) {
    if (!s || s.isBaseStep) continue;
    const b = base.get(s.id);
    if (!b) continue;                                   // new step — its creator stars it
    if (b.snapshot !== s.snapshot || b.transition !== s.transition || b.cameraBinding !== s.cameraBinding
        || b.overlay !== s.overlay || b.narr !== C.narrationSig(s.narration)) hit.push(s.id);
  }
  const order = C.playableOrder(cur, state.get('chapters') || []);
  const moved = C.predecessorChanges(_base.order, order);
  _rebaseSteps(cur);
  if (hit.length)   _star(hit,   'step content changed');
  if (moved.length) _star(moved, 'the step before it changed (reorder / delete / hide)');
}

function _onChapters() {
  if (_suspended) return;
  const order = C.playableOrder(state.get('steps') || [], state.get('chapters') || []);
  const moved = C.predecessorChanges(_base.order, order);
  _base.order = order;
  if (moved.length) _star(moved, 'chapter visibility changed the step before it');
}

// ── definition lists ───────────────────────────────────────────────────────
function _watchDefs(key, onChanged) {
  state.on(`change:${key}`, () => _debounce(key, () => {
    if (_suspended) { _rebaseDef(key); return; }
    const next = C.sigMap(state.get(key), DEF_LISTS[key]);
    const { changed, removed } = C.changedIds(_base.defs.get(key), next);
    _base.defs.set(key, next);
    if (changed.size || removed.size) onChanged(changed, removed);
  }));
}

function _initDefListeners() {
  _watchDefs('colorPresets', (changed, removed) => {
    const ids = new Set([...changed, ...removed]);
    _star(C.stepsUsingPresets(_playable(), materials.meshDefaultColors, ids, _visibleOf), `colour preset edited (${ids.size})`);
  });
  // A deleted preset is re-pointed on every mesh that wore it BEFORE we see
  // the list change — the trail is gone, so every playable step wears the star.
  state.on('materials:presetDeleted', () => { if (!_suspended) _star(_playable().map(s => s.id), 'colour preset deleted'); });

  _watchDefs('cameraViews', (changed, removed) => {
    const ids = new Set([...changed, ...removed]);
    _star(C.stepsBoundToCameras(_playable(), ids), `camera template edited (${ids.size})`);
  });

  for (const key of OVERLAY_DEF_KEYS) {
    _watchDefs(key, (changed, removed) => {
      const ids = new Set([...changed, ...removed]);
      _star(C.stepsReferencing(_playable(), ids), `${key} edited (${ids.size})`);
    });
  }

  _watchDefs('shapeTemplates', (changed, removed) => {
    const ids = new Set([...changed, ...removed]);
    _star(C.stepsWithVisibleShapeTemplates(_playable(), ids, _visibleOf), `shape template edited (${ids.size})`);
  });

  _watchDefs('cables', (changed, removed) => {
    const ids = new Set([...changed, ...removed]);
    _star(C.stepsWithCables(_playable(), ids), `cable definition edited (${ids.size})`);
  });

  // Animation presets: a step stores only the preset id — compare what each
  // step RESOLVES to before and after, so only the steps that use the edited
  // (or default) preset are starred.
  state.on('change:animationPresets', () => _debounce('animationPresets', () => {
    const next = state.get('animationPresets') || [];
    if (_suspended) { _base.anim = next; return; }
    const prev = _base.anim;
    _base.anim = next;
    const hit = [];
    for (const s of _playable()) {
      let a = '', b = '';
      try { a = resolveAnimationString(s.transition || {}, prev) || ''; } catch { a = '?'; }
      try { b = resolveAnimationString(s.transition || {}, next) || ''; } catch { b = '?'; }
      if (a !== b) hit.push(s.id);
    }
    _star(hit, 'animation preset edited');
  }));

  // Global settings that move every rendered pixel → every playable step.
  const onSettings = () => _debounce('settings', () => {
    const sig = _settingsSig();
    if (_suspended) { _base.settings = sig; return; }
    if (sig === _base.settings) return;
    _base.settings = sig;
    _star(_playable().map(s => s.id), 'global render/export setting changed');
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
  return _star(C.stepsWithVisibleNodes(_playable(), ids, _visibleOf), why);
}

/** Star specific steps (a tool that already holds the list it touched). */
export function markStepsAltered(stepIds, why = 'edited by a tool') {
  if (_suspended) return 0;
  return _star(stepIds || [], why);
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
}
