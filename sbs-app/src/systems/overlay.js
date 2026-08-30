/**
 * SBS — Per-step 2D overlay (Phase 2a)
 * =====================================
 * A Konva stage pinned on top of the 3D viewport. Each step stores its own
 * overlay state on `step.overlay`, a Konva JSON string, so editing on one
 * step doesn't affect others.
 *
 * Features (MVP):
 *   • Add text box (single style per box — font, size, color via toolbar)
 *   • Add image (local file → base64 data URL, stored inline in the project)
 *   • Click to select; drag to move; corner handles to resize; rotate handle
 *   • Delete key removes the selected node
 *   • Double-click a text box to edit its content via a floating <textarea>
 *
 * Phase 2b will add: compositing overlay canvas over 3D during video export.
 */

import { state }     from '../core/state.js';
import { sceneCore } from '../core/scene.js';   // H2: tick hook for overlay fade
import * as videoOverlay from './video-overlay.js';   // 🎬 V0.3.2.75 — disk-referenced video clips
import * as clock    from '../core/clock.js';
import { getCanonicalSize, computeSafeFrameRect } from '../core/safe-frame.js';
import { showContextMenu } from '../ui/context-menu.js';
import { setStatus } from '../ui/status.js';
import { promptString } from '../ui/prompt.js';
import { openSequenceEditor } from '../ui/sequence-editor.js';
import { narrationContextForStep } from './narration-timeline.js';
import * as interfaces from './interfaces.js';   // interface overlay (used lazily in the right-click menu)
import { mountTextToolbar, unmountTextToolbar, execCommandApplier, setToolbarValues, wasColorPickedRecently, setStyleDropdown, setStyleLocked, setConstDropdown } from '../ui/text-toolbar.js';
import { mountShapeToolbar, unmountShapeToolbar } from '../ui/shape-toolbar.js';
import { getTextToolbarSlot }  from '../ui/overlay-toolbar.js';
import * as textEngine from './text-engine.js';
import { getStyleTemplate, listStyleTemplates } from './style-templates.js';
import { registerLayer, getLayerSelection, persistNodeIfHeader } from './cross-layer.js';
import * as editSession from './edit-session.js';   // P7-A: in-session local undo + commit-time main-undo entry
import { undoManager } from './undo.js';            // P7-B: mass-mode + structural ops push undo entries directly

let _stage       = null;   // Konva.Stage
let _layer       = null;   // Konva.Layer — holds all user content
let _ghostLayer  = null;   // H2: holds outgoing content during a step crossfade
let _uiLayer     = null;   // Konva.Layer — transformer, editing aids
let _transformer = null;
let _container   = null;
let _editing     = false;
let _resizeObs   = null;
let _saveTimer   = null;
let _activeStepUnwatch = null;
let _loadToken   = 0;     // bumped on every step-change load; older loads abort if outdated
let _suppressNextStepAppliedLoad = false;   // H2: skip redundant load when fade pre-loaded

// H2 — overlay phase animation. The fade-in/out lifecycle mirrors the
// cable phase: steps.js calls begin*, the per-frame advance lerps the
// content layer's opacity, and onDone fires when the slot's duration
// elapses. Headers live on a separate Konva layer and are unaffected.
let _activeFade = null;   // { fromOpacity, toOpacity, startMs, durationMs, easeFn, onDone }

// ─── Init ──────────────────────────────────────────────────────────────────

export function initOverlay() {
  if (!window.Konva) {
    console.warn('[overlay] Konva not loaded — overlay disabled.');
    return;
  }
  _container = document.getElementById('overlay-stage');
  if (!_container) return;

  _stage = new Konva.Stage({
    container: _container,
    width:     _container.clientWidth  || 1,
    height:    _container.clientHeight || 1,
  });
  // Name the overlay content layer explicitly so _loadFromActiveStep can
  // pick the right layer back out of step.overlay JSON (which serialises
  // ALL layers — content + UI + header — and a naive "first layer with
  // children" search can mistakenly pick the UI or header layer).
  _layer      = new Konva.Layer({ name: 'sbs-overlay-content' });
  _ghostLayer = new Konva.Layer({ name: 'sbs-overlay-ghost', listening: false, opacity: 0 });
  _uiLayer    = new Konva.Layer({ name: 'sbs-overlay-ui' });
  _stage.add(_ghostLayer);   // below _layer so new content draws on top
  _stage.add(_layer);
  _stage.add(_uiLayer);

  _transformer = new Konva.Transformer({
    rotateEnabled: true,
    anchorSize:    8,
    borderStroke:  '#f59e0b',
    anchorStroke:  '#f59e0b',
    anchorFill:    '#fff',
    // Default: aspect-locked corner-only (matches image behaviour). When a
    // text box is selected we flip these to free-resize via _configTransformer
    // — text boxes reflow into the new dimensions instead of stretching.
    keepRatio:        true,
    enabledAnchors:   ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
  });
  _uiLayer.add(_transformer);

  // Click an empty area → deselect.
  _stage.on('pointerdown', (e) => {
    // Edit-preview sequences: the FIRST interaction (this fires for clicks on
    // nodes too — Konva events bubble to the stage) pops every playing sequence
    // back to its base frame so editing resumes from the first-entry state.
    if (_editing && _seqPlaybacks.length) _stopSequences();
    // Zoom-region draw mode: the next press-drag-release defines the region.
    if (_zoomDraw) { e.evt?.preventDefault?.(); _zoomDrawStart(); return; }
    if (e.target === _stage) {
      _setSelection(null);
      // Empty-area click while editing = the user (likely) tried to click a 3D
      // object but overlay edit is swallowing it. Nudge them (blink + prompt).
      if (_editing) state.emit('overlay:misclick');
    }
  });
  // Zoom-region draw: live preview + finalize. Inert unless _zoomDraw is active.
  _stage.on('pointermove', () => { if (_zoomDraw?.active) _zoomDrawMove(); });
  _stage.on('pointerup',   () => { if (_zoomDraw?.active) _zoomDrawEnd();  });

  // Right-click on empty viewport → paste-only context menu (Paste / Paste
  // in place / Delete-disabled). Lets the user paste a copied textbox or
  // image without needing an existing node to right-click on. Selection
  // and "Duplicate" only make sense on a node, so they're omitted here.
  _stage.on('contextmenu', (e) => {
    if (e.target !== _stage) return;          // node-level handler runs instead
    if (!_editing) return;                     // overlay editing must be on
    e.evt?.preventDefault?.();
    const ev = e.evt;
    _showEmptyViewportContextMenu(ev?.clientX ?? 0, ev?.clientY ?? 0);
  });

  // Keyboard: Delete removes the selected node (only when editing).
  window.addEventListener('keydown', _onKeyDown);

  // H2: per-frame advance for overlay fade transitions.
  sceneCore.addTickHook(_advanceOverlayFade);
  // S2: per-frame advance for image-sequence playback (inert when none active).
  sceneCore.addTickHook(_advanceSequences);

  // Resize stage to match viewport surface.
  _syncSize();
  _resizeObs = new ResizeObserver(_syncSize);
  _resizeObs.observe(_container);
  // Stage 2/3a: re-sync when the canonical export size changes — the
  // Konva stage's internal width/height + visual scale must follow
  // state.export.width × state.export.height. Also rescale every
  // node's x/y/w/h by the axis ratios so items keep their relative
  // position + size when the user changes resolution or aspect.
  //
  // Coalesce via rAF: setExportOption fires change:export per key,
  // so a preset switch (formatPreset, width, height) emits THREE
  // events back-to-back. Without coalescing, my rescale would run
  // mid-burst with width-changed-but-height-stale, mistaking the
  // intermediate state as an aspect change and re-rastering text
  // each step. By the time the burst ends, _prevCanonical has been
  // mutated for the (wrong) intermediate canonicals and reversal
  // never lines up. rAF deferral runs once with the final values.
  _prevCanonical = getCanonicalSize();
  let _pendingRescaleRaf = 0;
  state.on('change:export', () => {
    if (_pendingRescaleRaf) return;
    _pendingRescaleRaf = requestAnimationFrame(() => {
      _pendingRescaleRaf = 0;
      _rescaleOnCanonicalChange();
    });
  });

  // Restore the currently-active step's overlay on load / step change.
  // CRITICAL ORDER: flush any pending save against the OUTGOING step
  // FIRST (synchronous), then load the new step. Without the flush, a
  // 120-ms-debounced edit can race past activeStepId — the timer fires
  // reading the NEW id and either loses the edit or writes the wrong
  // step. We capture _pendingSaveStepId at schedule time precisely so
  // this flush can target the correct (outgoing) step regardless of
  // when it actually fires.
  state.on('change:activeStepId', _flushPendingSave);
  // H2: change:activeStepId previously triggered an early _scheduleLoad
  // — but that ran BEFORE the animation phases, so by the time the
  // overlay-slot crossfade fired, the new content was already in the
  // layer and the animation just faded the same content over itself.
  // step:applied (fired AFTER animation completes) is the canonical
  // load trigger now; the crossfade flag suppresses it when needed.
  state.on('step:applied', _onStepApplied);
  // Undo/redo may restore an interface's pose/size without touching its bonded
  // shapes — re-fit them from their % so undo sticks (no navigate-to-refresh).
  state.on('undo:applied', () => {
    for (const iface of getInterfaceNodes()) syncBondedShapes(iface);
    // Geometry-undo restores w/h but not `crop` — re-derive each zoom's crop
    // from the restored frame so an undone resize isn't left stretched.
    for (const z of _zoomNodes()) _recomputeZoomCrop(z);
  });

  // Live style-template propagation. When a template changes, every
  // text box on the ACTIVE step that's bound to it re-rasterises.
  // Inactive steps pick up the change next time they load (every
  // text-box reload routes through _reflowTextBox, which reads the
  // current template values).
  state.on('styleTemplate:updated', _onStyleTemplateUpdated);
  state.on('styleTemplate:removed', _onStyleTemplateUpdated);   // also re-rasterise when a template is deleted

  // Register with the cross-layer registry so header.js can ask for
  // the current overlay selection (for combined multi-drag) and ask
  // us to persist after a cross-layer drag commits — see systems/
  // cross-layer.js. No-op when called before init.
  registerLayer('overlay', {
    getSelection: () => _transformer?.nodes() || [],
    scheduleSave: () => _scheduleSave(),
  });
}

function _onStyleTemplateUpdated(payload) {
  if (!_layer) return;
  const id = payload?.id;
  // Re-rasterise every text box on the active layer whose styleId
  // matches (or, on remove, whose styleId is now stale).
  for (const child of _layer.getChildren()) {
    if (child.getClassName?.() !== 'Image') continue;
    if (!child.getAttr('textHtml')) continue;
    const childStyleId = child.getAttr('styleId');
    if (id && childStyleId !== id) continue;
    if (!id && !childStyleId) continue;
    _reflowTextBox(child).catch(() => {});
  }
}

/**
 * Stage 2 — canonical-coords overlay.
 *
 * Node positions are stored in canonical pixels (state.export.width
 * × state.export.height) so a project renders identically on any
 * machine. The Konva stage's CANVAS stays sized to the viewport
 * container (Konva sets the canvas DOM width to stage.width — using
 * the canonical 1920 here would overflow a smaller viewport and
 * clip content), but the stage's scale + position transform draws
 * canonical (0..W, 0..H) into the safe-frame rect inside the
 * viewport. Pointer coords come back through that inverse transform,
 * so drag handlers receive canonical pixels with no extra work.
 */
function _syncSize() {
  if (!_stage || !_container) return;
  const r = _container.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const sf = computeSafeFrameRect({ width: r.width, height: r.height });
  if (sf.scale <= 0) return;
  // Canvas size = viewport (no overflow / clipping).
  _stage.width(r.width);
  _stage.height(r.height);
  // Scale + position map canonical coords into the safe-frame rect.
  _stage.scale({ x: sf.scale, y: sf.scale });
  _stage.position({ x: sf.x, y: sf.y });
  _stage.batchDraw();
}

// Stage 3a: rescale all overlay nodes when the canonical export size
// changes so items keep their RELATIVE position + size. Width changes
// scale x + width by the width ratio; height changes scale y + height
// by the height ratio. Independent per axis so aspect-ratio changes
// stretch correctly. Font size / padding stay (typography rarely
// scales with canvas).
let _prevCanonical = null;   // remembered to compute the next ratio
function _rescaleOnCanonicalChange() {
  const c = getCanonicalSize();
  if (!_prevCanonical || !_layer) {
    _prevCanonical = c;
    _syncSize();
    return;
  }
  const xR = c.width  / _prevCanonical.width;
  const yR = c.height / _prevCanonical.height;
  // Rescale on EVERY canonical change (resolution or aspect).
  //
  //   Same-aspect resolution change (xR == yR): every node attr
  //     scales by the same factor; stage.scale changes inversely
  //     in _syncSize below, so visual = canonical_PX × scale stays
  //     IDENTICAL — nothing visibly changes.
  //
  //   Aspect change (xR ≠ yR): per-axis scale for text boxes
  //     (so the box reflows into the new aspect); uniform xR for
  //     image nodes (locked aspect — image just shrinks/grows
  //     proportionally instead of stretching).
  //
  //   Reversal: every forward scale is matched by its inverse on
  //     the way back, so the canonical PX returns exactly. Text
  //     re-raster on each step keeps glyphs crisp at the new
  //     effective scale.
  // Same-aspect resolution change (xR == yR): rescale node attrs but
  // DON'T re-rasterise text. Konva down/up-samples the existing
  // source canvas through the stage's inverse scale change, exactly
  // like a window resize — visual stays constant, layout reverts on
  // resolution flip-flop.
  //
  // Aspect change (xR ≠ yR): rescale per-axis (text) or uniform xR
  // (image), AND re-rasterise text so the SVG-foreignObject reflows
  // into the new aspect's wrap.
  const aspectChanged = Math.abs(xR - yR) > 1e-4;
  if (xR !== 1 || yR !== 1) {
    for (const node of _layer.getChildren()) {
      const isText = !!node.getAttr?.('textHtml');
      if (typeof node.x === 'function') node.x(node.x() * xR);
      if (typeof node.y === 'function') node.y(node.y() * yR);
      const wR = xR;                           // both kinds: width by xR
      const hR = isText ? yR : xR;             // text: per-axis; image: locked
      if (typeof node.width  === 'function' && typeof node.width()  === 'number') node.width(node.width()   * wR);
      if (typeof node.height === 'function' && typeof node.height() === 'number') node.height(node.height() * hR);
      if (isText && aspectChanged) _reflowTextBox(node).catch(() => {});
    }
    _layer.batchDraw();
    _scheduleSave();
  }
  _prevCanonical = c;
  _syncSize();
}

// ─── Editing mode ──────────────────────────────────────────────────────────

export function isEditing() { return _editing; }

/**
 * Borrow the overlay's Konva.Stage for sibling layers (header.js).
 * Returns null until initOverlay() has run.
 */
export function getStage() { return _stage; }

export function setEditingMode(on) {
  // GHOST-EDITOR FIX (V0.3.1.81): commit + tear down any live in-place text
  // editor on EVERY mode flip. The click-outside detector whitelists the
  // toolbar, so clicking "✏ Edit overlay" never committed the editor —
  // setEditingMode(false) then left the contenteditable DOM orphaned above the
  // canvas: permanently visible across ALL steps, editable, unselectable,
  // undeletable (it's not a Konva node). Commit (not discard) so no text is lost.
  if (_activeTextEditor) _exitTextEdit().catch(() => {});
  _editing = !!on;
  if (_container) _container.classList.toggle('editing', _editing);
  if (!_editing) _setSelection(null);
  // Mirror to state so non-overlay systems (header.js) can subscribe
  // and turn their own interaction on/off in lockstep — see P1 of the
  // header workstream. _editing remains the source of truth for code
  // inside this module; state.overlayEditing is purely a broadcast.
  state.setState({ overlayEditing: _editing });
  // Sequences now play a ONE-SHOT PREVIEW in edit mode too (V0.3.1.60), not just
  // view mode. Same playback; the only edit-mode difference is it returns to the
  // base frame (frame 0) at the end OR on the first interaction (see
  // _advanceSequences' end-revert + the stage pointerdown revert), so editing
  // always resumes from the first-entry state. Start playback whichever mode we
  // entered — leaving edit mode plays it in view mode as before.
  _startSequences();
}

// ─── Creating nodes ────────────────────────────────────────────────────────

/**
 * Drop a fresh text box onto the stage and immediately enter in-place
 * edit mode. No modal — Phase 2 onwards we edit on the canvas.
 *
 * The initial raster is just placeholder text so the Konva.Image has
 * something to host while the editable <div> is mounted on top. As
 * soon as the user clicks outside (or presses Escape), the node
 * re-rasterises from the contenteditable's HTML.
 */
// ─── 📌 Constant text boxes (V0.3.2.98) ─────────────────────────────────────
// Project-level PINNED definitions ({id, name, anchor:'tl'|'tr', x, y,
// styleId}); instances are ordinary text boxes with a constId + per-step
// text. The definition owns the anchor-corner position and the style —
// WIDTH is per-instance (resized from the free edge; a right-anchored box
// grows leftward). Enforcement = the load-time sync pass: move an instance,
// leave, come back → it has snapped home, unless "Set as new position"
// wrote the move into the definition (which every step then follows).

function _constDefs()          { return state.get('constTextBoxes') || []; }
function _constDefOf(node)     { const id = node?.getAttr?.('constId'); return id ? _constDefs().find(d => d.id === id) : null; }
function _saveConstDefs(items) { state.setState({ constTextBoxes: items }); state.markDirty(); }

/** The node's current anchor-corner x under a definition's anchor mode. */
function _constAnchorX(node, anchor) {
  return anchor === 'tr' ? node.x() + node.width() * node.scaleX() : node.x();
}

/** Pin a node to its definition: anchor position + style. Width untouched. */
function _applyConstToNode(node, def) {
  node.y(def.y);
  node.x(def.anchor === 'tr' ? def.x - node.width() * node.scaleX() : def.x);
  if ((node.getAttr('styleId') || null) !== (def.styleId || null)) {
    node.setAttr('styleId', def.styleId || null);
    _reflowTextBox(node).catch(() => {});
  }
}

/** Write a style change through to the definition + every sibling instance
 *  on the CURRENT step (other steps re-sync at their next load). */
function _propagateConstStyle(node, styleId) {
  const def = _constDefOf(node);
  if (!def || (def.styleId || null) === (styleId || null)) return;
  def.styleId = styleId || null;
  _saveConstDefs([..._constDefs()]);
  for (const n of _layer?.getChildren() || []) {
    if (n === node || n.getAttr?.('constId') !== def.id) continue;
    if ((n.getAttr('styleId') || null) !== (styleId || null)) {
      n.setAttr('styleId', styleId || null);
      _reflowTextBox(n).catch(() => {});
    }
  }
}

/**
 * 🧹 UNIFY CONSTANT TITLES (V0.3.2.101) — the post-processing sweep.
 * Walks EVERY step's overlay, clusters plain text boxes by (position
 * within a ~14px tolerance + EXACT style binding), and turns every
 * cluster that appears on ≥2 distinct steps into a new constant type
 * with all members stamped. Definition position = the cluster's most
 * common exact spot, so hand-placed strays snap to the majority on
 * their next load. Style must match exactly — a false merge would
 * restyle boxes, a miss costs nothing (per the user: misses accepted).
 * One undo entry restores every touched overlay + the definitions.
 */
export async function unifyConstantTitles() {
  flushSave();   // live edits on the active step participate
  const stepsArr = state.get('steps') || [];
  // V0.3.2.102: 25px chaining distance. The first version used a grid
  // bucket — boxes 2px apart could straddle a bucket line and land in
  // different clusters ("1 pixel off fails"), splintering one real title
  // into 21 types. Distance-chaining has no boundaries: near boxes link.
  const TOL = 25;

  // Pass 1 — parse + cluster.
  const parsed = [];
  for (const s of stepsArr) {
    if (typeof s.overlay !== 'string' || !s.overlay) continue;
    let spec; try { spec = JSON.parse(s.overlay); } catch { continue; }
    const boxes = [];
    for (const layer of (spec.children || [])) {
      for (const n of (layer.children || [])) {
        const a = n.attrs || {};
        // Plain user text boxes only. Headers (`sbs-header-item`) also carry
        // textHtml and ARE same-position/same-style on every step by design —
        // without this exclusion the sweep would swallow every header.
        if (!a.textHtml || a.isToc || a.constId || a.isVideo) continue;
        if (a.name === 'sbs-header-item') continue;
        // Interface-bonded boxes (attachedTo = ifaceId) belong to their
        // interface, not to a project-wide pin — a constId would fight the
        // bond's follow-the-interface geometry. Deliberate manual "Make
        // constant" on one stays allowed; the AUTO sweep must ignore them.
        if (a.attachedTo) continue;
        boxes.push(n);
      }
    }
    if (boxes.length) parsed.push({ step: s, spec, boxes });
  }
  // Group by exact style first (a false style merge would restyle boxes),
  // then union-find within each style group: two boxes link when both
  // |dx| and |dy| ≤ TOL, links chain, no grid boundaries.
  const byStyle = new Map();
  for (const e of parsed) {
    for (const n of e.boxes) {
      const a = n.attrs;
      const k = a.styleId || '';
      let list = byStyle.get(k);
      if (!list) byStyle.set(k, list = []);
      list.push({ entry: e, node: n, x: a.x || 0, y: a.y || 0 });
    }
  }
  const clusters = [];
  for (const [styleKey, items] of byStyle) {
    const parent = items.map((_, i) => i);
    // STEP-DISJOINT GUARD: a cluster may hold at most ONE box per step.
    // Two boxes on the same step are distinct roles by definition (title +
    // subtitle 24px apart, same style) — without this guard chaining would
    // merge them and the load-time sync would collapse both onto one pinned
    // position on every step. Each root tracks its step set; a union that
    // would put two same-step boxes in one cluster is refused.
    const rootSteps = items.map(it => new Set([it.entry.step.id]));
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (Math.abs(items[i].x - items[j].x) <= TOL && Math.abs(items[i].y - items[j].y) <= TOL) {
          const a = find(i), b = find(j);
          if (a === b) continue;
          const [small, large] = rootSteps[a].size <= rootSteps[b].size ? [a, b] : [b, a];
          let clash = false;
          for (const sid of rootSteps[small]) { if (rootSteps[large].has(sid)) { clash = true; break; } }
          if (clash) continue;
          parent[small] = large;
          for (const sid of rootSteps[small]) rootSteps[large].add(sid);
        }
      }
    }
    const groups = new Map();
    for (let i = 0; i < items.length; i++) {
      const r = find(i);
      let g = groups.get(r);
      if (!g) groups.set(r, g = []);
      g.push(items[i]);
    }
    for (const members of groups.values()) {
      const c = { styleId: styleKey || null, members: [], stepIds: new Set(), posCount: new Map() };
      for (const m of members) {
        c.members.push({ entry: m.entry, node: m.node });
        c.stepIds.add(m.entry.step.id);
        const pk = `${Math.round(m.x)},${Math.round(m.y)}`;
        c.posCount.set(pk, (c.posCount.get(pk) || 0) + 1);
      }
      clusters.push(c);
    }
  }

  // Pass 2 — mint definitions for clusters spanning ≥2 steps, stamp members.
  const prevDefs = _constDefs();
  const newDefs = [];
  const touched = new Map();   // stepId -> entry
  let unified = 0;
  const baseCounts = new Map();
  for (const c of clusters) {
    if (c.stepIds.size < 2) continue;
    let bestPk = null, bestN = -1;
    for (const [pk, n] of c.posCount) if (n > bestN) { bestN = n; bestPk = pk; }
    const [mx, my] = bestPk.split(',').map(Number);
    const base = c.styleId ? (getStyleTemplate(c.styleId)?.name || 'Styled') : 'Title';
    const nth = (baseCounts.get(base) || 0) + 1;
    baseCounts.set(base, nth);
    const def = {
      id: `ctb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_${newDefs.length}`,
      name: nth > 1 ? `${base} (auto ${nth})` : `${base} (auto)`,
      anchor: 'tl', x: mx, y: my, styleId: c.styleId,
    };
    newDefs.push(def);
    for (const m of c.members) {
      m.node.attrs.constId = def.id;
      unified++;
      touched.set(m.entry.step.id, m.entry);
    }
  }
  if (!newDefs.length) {
    setStatus('Unify found no repeating title patterns (needs the same position + style on at least 2 steps).', 'info', 8000);
    return { created: 0, unified: 0 };
  }

  // Apply + ONE targeted undo entry (overlay STRINGS are shared refs — cheap).
  const prevOverlays = [...touched.values()].map(e => ({ id: e.step.id, overlay: e.step.overlay }));
  const nextOverlays = [...touched.values()].map(e => ({ id: e.step.id, overlay: JSON.stringify(e.spec) }));
  const swap = (overlays, defs) => {
    const arr = state.get('steps') || [];
    for (const p of overlays) { const s = arr.find(x => x.id === p.id); if (s) s.overlay = p.overlay; }
    state.setState({ steps: [...arr], constTextBoxes: defs });
    state.markDirty();
    _markOverlayStringsAuthoritative();   // patched strings win over the stale stage until reload
  };
  const newIds = new Set(newDefs.map(d => d.id));
  swap(nextOverlays, [...prevDefs, ...newDefs]);
  // Defs splice against the CURRENT array at undo time (stale-snapshot rule).
  undoManager.push('Unify constant titles',
    () => swap(prevOverlays, _constDefs().filter(d => !newIds.has(d.id))),
    () => swap(nextOverlays, [..._constDefs().filter(d => !newIds.has(d.id)), ...newDefs]),
  );

  console.table(newDefs.map(d => ({ name: d.name, x: d.x, y: d.y, style: d.styleId || '(none)' })));
  setStatus(`Unified ${unified} title(s) into ${newDefs.length} constant type(s) across ${touched.size} step(s) — rename via the 📌 dropdown's ✏️.`, 'success', 10000);
  return { created: newDefs.length, unified, steps: touched.size };
}

// ─── 🌍 Language packs: overlay text units (V0.3.2.116) ─────────────────────
//
// The translator needs to read and write every on-screen text box across the
// WHOLE project, keyed by an identity that survives saving, reordering and
// editing. Overlay-internal knowledge (compact JSON strings, the content-layer
// vs baked-header-layer split, the authoritative-strings guard, interning)
// stays in this module; language-packs.js only ever sees {key, html} pairs.
//
// Identity = a `tid` attr stamped lazily on first scan, exactly like
// ifaceId/videoId. Konva serialises unknown attrs verbatim and _recreateNode
// spreads them back, so it round-trips through save/load for free.

let _tidSeq = 0;
function _newTid() { return `tx_${Date.now().toString(36)}_${(_tidSeq++).toString(36)}_${Math.random().toString(36).slice(2, 5)}`; }

/** Is this content-layer node a translatable, user-authored text box? */
function _isTranslatableTextSpec(a) {
  if (!a || !a.textHtml) return false;
  if (a.isToc) return false;              // regenerated from chapters — never authored here
  if (a.isVideo) return false;
  if (a.name === 'sbs-header-item') return false;   // baked header copy, dead weight
  return true;
}

/**
 * Scan every step for translatable text boxes, stamping a `tid` where absent.
 * Returns [{ key:'text:<tid>', html, stepId, constId }]. Stamping mutates the
 * overlay strings of steps that had unstamped boxes — that is a one-time
 * re-key of those steps' render-cache segments, which the caller discloses.
 */
export function scanTextUnits() {
  flushSave();
  const out = [];
  const arr = state.get('steps') || [];
  const patched = [];
  // Duplicating a STEP copies its overlay string verbatim, tids included, so
  // the same tid can legitimately appear on two independent boxes. First
  // sighting keeps the id; later ones are re-stamped, otherwise two boxes
  // would share one pack entry and diverge the moment either is edited.
  const seen = new Set();
  for (const s of arr) {
    if (typeof s.overlay !== 'string' || !s.overlay) continue;
    let spec; try { spec = JSON.parse(s.overlay); } catch { continue; }
    const layer = _findContentLayerSpec(spec);
    if (!layer) continue;
    let dirty = false;
    for (const n of (layer.children || [])) {
      const a = n.attrs || {};
      if (!_isTranslatableTextSpec(a)) continue;
      if (!a.tid || seen.has(a.tid)) { a.tid = _newTid(); dirty = true; }
      seen.add(a.tid);
      out.push({ key: `text:${a.tid}`, html: a.textHtml, stepId: s.id, constId: a.constId || null });
    }
    if (dirty) patched.push({ id: s.id, overlay: JSON.stringify(spec) });
  }
  if (patched.length) {
    for (const p of patched) { const st = arr.find(x => x.id === p.id); if (st) st.overlay = p.overlay; }
    state.setState({ steps: [...arr] });
    state.markDirty();
    _markOverlayStringsAuthoritative();
  }
  return out;
}

/**
 * Write translated HTML back into every matching text box.
 * @param {Map<string,string>} byKey  'text:<tid>' → new textHtml
 * @returns {{steps:number, boxes:number}}
 */
export function applyTextUnits(byKey) {
  if (!byKey || !byKey.size) return { steps: 0, boxes: 0 };
  flushSave();
  const arr = state.get('steps') || [];
  const patched = [];
  let boxes = 0;
  for (const s of arr) {
    if (typeof s.overlay !== 'string' || !s.overlay) continue;
    let spec; try { spec = JSON.parse(s.overlay); } catch { continue; }
    const layer = _findContentLayerSpec(spec);
    if (!layer) continue;
    let dirty = false;
    for (const n of (layer.children || [])) {
      const a = n.attrs || {};
      if (!_isTranslatableTextSpec(a) || !a.tid) continue;
      const next = byKey.get(`text:${a.tid}`);
      if (typeof next !== 'string' || next === a.textHtml) continue;
      a.textHtml = next;
      dirty = true; boxes++;
    }
    if (dirty) patched.push({ id: s.id, overlay: JSON.stringify(spec) });
  }
  if (!patched.length) return { steps: 0, boxes: 0 };
  for (const p of patched) { const st = arr.find(x => x.id === p.id); if (st) st.overlay = p.overlay; }
  state.setState({ steps: [...arr] });
  state.markDirty();
  _markOverlayStringsAuthoritative();   // live stage is stale until the reload
  return { steps: patched.length, boxes };
}

/**
 * Public form of the stale-stage guard (V0.3.2.116). ANY caller that writes
 * step.overlay strings directly — including an undo closure restoring a whole
 * steps array — must call this, or the next debounced _writeOverlayToStep
 * serialises the still-stale live stage over the patch.
 */
export function markOverlayStringsAuthoritative() { _markOverlayStringsAuthoritative(); }

/**
 * Per-box geometry overrides (language packs store these sparsely: only
 * boxes the user actually moved while that language was active).
 * read → Map('text:<tid>' → {x,y,textWidth}); write applies them back.
 */
export function readTextBoxGeometry() {
  const out = new Map();
  for (const s of (state.get('steps') || [])) {
    if (typeof s.overlay !== 'string' || !s.overlay) continue;
    let spec; try { spec = JSON.parse(s.overlay); } catch { continue; }
    const layer = _findContentLayerSpec(spec);
    if (!layer) continue;
    for (const n of (layer.children || [])) {
      const a = n.attrs || {};
      if (!_isTranslatableTextSpec(a) || !a.tid) continue;
      out.set(`text:${a.tid}`, { x: a.x ?? 0, y: a.y ?? 0, textWidth: a.textWidth ?? null });
    }
  }
  return out;
}

export function applyTextBoxGeometry(byKey) {
  if (!byKey || !byKey.size) return 0;
  flushSave();
  const arr = state.get('steps') || [];
  const patched = [];
  let n = 0;
  for (const s of arr) {
    if (typeof s.overlay !== 'string' || !s.overlay) continue;
    let spec; try { spec = JSON.parse(s.overlay); } catch { continue; }
    const layer = _findContentLayerSpec(spec);
    if (!layer) continue;
    let dirty = false;
    for (const node of (layer.children || [])) {
      const a = node.attrs || {};
      if (!_isTranslatableTextSpec(a) || !a.tid) continue;
      const g = byKey.get(`text:${a.tid}`);
      if (!g) continue;
      if (typeof g.x === 'number' && g.x !== a.x) { a.x = g.x; dirty = true; }
      if (typeof g.y === 'number' && g.y !== a.y) { a.y = g.y; dirty = true; }
      if (typeof g.textWidth === 'number' && g.textWidth !== a.textWidth) { a.textWidth = g.textWidth; dirty = true; }
      if (dirty) n++;
    }
    if (dirty) patched.push({ id: s.id, overlay: JSON.stringify(spec) });
  }
  if (!patched.length) return 0;
  for (const p of patched) { const st = arr.find(x => x.id === p.id); if (st) st.overlay = p.overlay; }
  state.setState({ steps: [...arr] });
  state.markDirty();
  _markOverlayStringsAuthoritative();
  return n;
}

/**
 * Project-wide usage census for constant defs (V0.3.2.102). Scans overlay
 * STRINGS for `"constId":"<id>"` — no JSON.parse, so it stays cheap on huge
 * projects (Konva/stage JSON is always compact JSON.stringify output, and
 * _serialiseStageJson re-stringifies, so the needle shape is guaranteed).
 * flushSave() first so the active step's live boxes are counted too.
 * Returns Map(defId → { count, stepIds }).
 */
export function countConstUsage() {
  flushSave();
  const out = new Map();
  for (const d of _constDefs()) out.set(d.id, { count: 0, stepIds: [] });
  for (const s of (state.get('steps') || [])) {
    const str = typeof s.overlay === 'string' ? s.overlay : '';
    if (!str) continue;
    for (const [id, u] of out) {
      const needle = `"constId":"${id}"`;
      let i = str.indexOf(needle), n = 0;
      while (i !== -1) { n++; i = str.indexOf(needle, i + needle.length); }
      if (n) { u.count += n; u.stepIds.push(s.id); }
    }
  }
  return out;
}

/** Delete a constant def — refuses unless it has ZERO instances project-wide. */
export function deleteConstDef(defId) {
  const defs = _constDefs();
  const def = defs.find(d => d.id === defId);
  if (!def) return { ok: false, reason: 'missing' };
  const u = countConstUsage().get(defId);
  if (u && u.count > 0) {
    setStatus(`"${def.name}" is in use ${u.count}× on ${u.stepIds.length} step(s) — detach those boxes first.`, 'warn', 7000);
    return { ok: false, reason: 'in-use', count: u.count, steps: u.stepIds.length };
  }
  _saveConstDefs(defs.filter(d => d.id !== defId));
  // Undo/redo splice against the CURRENT array, never a captured snapshot —
  // a snapshot restore would silently destroy defs created after the delete.
  undoManager.push(`Delete constant "${def.name}"`,
    () => { if (!_constDefs().some(d => d.id === def.id)) _saveConstDefs([..._constDefs(), def]); },
    () => _saveConstDefs(_constDefs().filter(d => d.id !== def.id)),
  );
  setStatus(`Deleted constant "${def.name}".`, 'info', 4000);
  return { ok: true };
}

/** Edit-menu cleanup: remove ALL constant defs with zero instances. */
export function cleanupUnusedConstDefs() {
  const defs = _constDefs();
  if (!defs.length) { setStatus('No constant titles defined.', 'info', 4000); return { removed: 0, kept: 0 }; }
  const usage = countConstUsage();
  const kept = [], removed = [];
  for (const d of defs) ((usage.get(d.id)?.count || 0) > 0 ? kept : removed).push(d);
  if (!removed.length) {
    setStatus(`All ${defs.length} constant title(s) are in use — nothing to clean.`, 'info', 5000);
    return { removed: 0, kept: defs.length };
  }
  const removedIds = new Set(removed.map(d => d.id));
  _saveConstDefs(kept);
  // Splice-style undo (see deleteConstDef) — never restore a stale snapshot.
  undoManager.push('Clean up unused constant titles',
    () => _saveConstDefs([..._constDefs().filter(d => !removedIds.has(d.id)), ...removed]),
    () => _saveConstDefs(_constDefs().filter(d => !removedIds.has(d.id))),
  );
  setStatus(`Removed ${removed.length} unused constant title(s); kept ${kept.length} in use.`, 'success', 7000);
  console.table(removed.map(d => ({ removed: d.name })));
  return { removed: removed.length, kept: kept.length };
}

/**
 * Select the active step's instance of a constant def (V0.3.2.104) — the
 * Constant Titles panel calls this after a ▲▼ jump so the box is instantly
 * ready to work with. Enters overlay edit mode if needed (selection only
 * exists there; setEditingMode broadcasts so the toolbar follows).
 */
export function selectConstInstance(defId) {
  if (!_stage || !_layer || !defId) return false;
  const node = (_layer.getChildren() || []).find(n => n.getAttr?.('constId') === defId);
  if (!node) return false;
  if (!_editing) setEditingMode(true);
  _setSelection(node);
  return true;
}

/**
 * Merge constant type `fromId` INTO `intoId` (V0.3.2.104): every box
 * stamped with `from` is re-stamped to `into` (raw string swap — the
 * `"constId":"…"` needle is structurally unique in compact stage JSON,
 * see countConstUsage), the `from` def is deleted, and each re-stamped
 * box snaps to `into`'s pin on its next load. One undo entry; def
 * closures splice against the CURRENT array (stale-snapshot rule).
 */
export function mergeConstDefs(fromId, intoId) {
  if (!fromId || !intoId || fromId === intoId) return { ok: false };
  const from = _constDefs().find(d => d.id === fromId);
  const into = _constDefs().find(d => d.id === intoId);
  if (!from || !into) return { ok: false };
  flushSave();
  const needleFrom = `"constId":"${fromId}"`;
  const needleInto = `"constId":"${intoId}"`;
  const prev = [], next = [];
  let boxes = 0;
  for (const s of (state.get('steps') || [])) {
    const str = typeof s.overlay === 'string' ? s.overlay : '';
    if (!str || !str.includes(needleFrom)) continue;
    const parts = str.split(needleFrom);
    boxes += parts.length - 1;
    prev.push({ id: s.id, overlay: str });
    next.push({ id: s.id, overlay: parts.join(needleInto) });
  }
  const applySteps = (overlays) => {
    if (!overlays.length) return;
    const arr = state.get('steps') || [];
    for (const p of overlays) { const st = arr.find(x => x.id === p.id); if (st) st.overlay = p.overlay; }
    state.setState({ steps: [...arr] });
    state.markDirty();
    _markOverlayStringsAuthoritative();   // patched strings win over the stale stage until reload
  };
  applySteps(next);
  // Belt + suspenders: re-stamp the LIVE stage's nodes too, so even a
  // serialisation that slips past the authoritative-strings guard writes
  // the merged id, and the visible canvas is consistent immediately.
  for (const n of (_layer?.getChildren?.() || [])) {
    if (n.getAttr?.('constId') === fromId) n.setAttr('constId', into.id);
  }
  _saveConstDefs(_constDefs().filter(d => d.id !== from.id));
  undoManager.push(`Merge constant "${from.name}" into "${into.name}"`,
    () => {
      applySteps(prev);
      if (!_constDefs().some(d => d.id === from.id)) _saveConstDefs([..._constDefs(), from]);
    },
    () => {
      applySteps(next);
      _saveConstDefs(_constDefs().filter(d => d.id !== from.id));
    },
  );
  setStatus(`Merged "${from.name}" into "${into.name}" — ${boxes} box(es) on ${next.length} step(s) re-pinned.`, 'success', 8000);
  return { ok: true, boxes, steps: next.length };
}

/** Insert an instance of a constant text box on the active step. */
export async function insertConstTextBox(defId) {
  const def = _constDefs().find(d => d.id === defId);
  if (!def || !_stage) return null;
  const node = await addTextBox();           // auto-enters the editor — type straight away
  if (!node) return null;
  node.setAttr('constId', def.id);
  if (def.styleId) { node.setAttr('styleId', def.styleId); await _reflowTextBox(node); }
  _applyConstToNode(node, def);
  _layer.batchDraw();
  _scheduleSave();
  return node;
}

export async function addTextBox() {
  if (!_stage) return null;
  const html = '<div>Text</div>';

  const canvas = await _htmlToCanvas(html, { width: 400 });
  if (!canvas) return null;
  if (!canvas.width || !canvas.height) {
    console.warn('[overlay] addTextBox: 0-sized canvas — aborting', canvas.width, canvas.height);
    return null;
  }

  const node = new Konva.Image({
    x: (_stage.width()  - canvas.width)  / 2,
    y: (_stage.height() - canvas.height) / 2,
    image: canvas,
    width:  canvas.width,
    height: canvas.height,
    draggable: true,
    name: 'userTextBox',
  });
  node.setAttr('textHtml',  html);
  node.setAttr('textWidth', canvas.width);
  // Stash the natural (un-scaled) dimensions so right-click → Reset can
  // restore the original raster size without recomputing the editor pass.
  node.setAttr('naturalW',  canvas.width);
  node.setAttr('naturalH',  canvas.height);
  _layer.add(node);
  _attachNode(node);
  _setSelection(node);
  // P7-C-1: capture spec for undo / redo, push entry. Do this BEFORE
  // entering edit mode — the editor opens its own edit-session that
  // pushes a SEPARATE "Edit text" entry on commit, so the user gets
  // two clean undo steps: Edit text → Add textbox.
  _pushAddNodeUndo(node, 'Add text box');
  // Auto-enter edit mode so the user doesn't have to dbl-click first.
  _enterTextEdit(node);
  _scheduleSave();
  return node;
}

/** Pull the user's styling out of an existing TOC box's HTML so a refresh can
 *  KEEP it (the #1 complaint: restyling was lost on every refresh). Model per
 *  the user's rule: the chosen size/color drive the BODY; the title is derived
 *  (≈1.3× body, bold, same color). Body size = the smallest font-size present
 *  (the title is always the bigger one); color/family/align = first found. */
function _extractTocStyle(html) {
  const s = typeof html === 'string' ? html : '';
  const sizes = [...s.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => parseFloat(m[1])).filter(v => v > 4);
  const colorM = s.match(/color:\s*(rgb\([^)]+\)|#[0-9a-fA-F]{3,8})/);
  const famM   = s.match(/font-family:\s*([^;"'<>]+)/);
  const alignM = s.match(/text-align:\s*(left|center|right)/);
  return {
    size:   sizes.length ? Math.min(...sizes) : 34,
    color:  colorM ? colorM[1] : '#ffffff',
    family: famM ? famM[1].trim() : 'Arial',
    align:  alignM ? alignM[1] : 'left',
  };
}

/** Build the Table-of-Contents list HTML (chapter name + timecode per line) from
 *  the current timeline, in the given (or default) style. Title = body×1.3 bold. */
async function _generateTocHtml(style = null, chaptersOverride = null) {
  const st = style || { size: 34, color: '#ffffff', family: 'Arial', align: 'left' };
  const titlePx = Math.round(st.size * 1.3);
  let chapters = chaptersOverride;
  if (!chapters) {
    const { computeChapterTimecodes } = await import('./narration-timeline.js');
    chapters = computeChapterTimecodes().chapters;
  }
  const fmt = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = chapters.filter(c => c.chapterId).map(c =>
    `<div style="display:flex;justify-content:space-between;gap:40px;padding:3px 0"><span>${esc(c.name)}</span><span style="opacity:0.85">${fmt(c.startMs)}</span></div>`
  ).join('') || '<div style="opacity:0.7">(no chapters yet)</div>';
  return `<div style="font-family:${st.family};font-size:${st.size}px;color:${st.color};text-align:${st.align};line-height:1.35"><div style="font-size:${titlePx}px;font-weight:bold;margin-bottom:10px">Table of Contents</div>${rows}</div>`;
}

/** Insert an auto-generated Table of Contents on the current step. It's a normal
 *  editable text box (edit/rename/remove lines directly in the text editor) tagged
 *  isToc so right-click → "Refresh timecodes" regenerates it from the chapters.
 *  Per-step + multiple independent instances by nature (it's overlay content). */
export async function addTocBox() {
  if (!_stage) return null;
  const html = await _generateTocHtml();
  const canvas = await _htmlToCanvas(html, { width: 620 });
  if (!canvas?.width || !canvas?.height) { console.warn('[overlay] addTocBox: bad canvas'); return null; }
  const node = new Konva.Image({
    x: Math.max(20, _stage.width() * 0.12),
    y: Math.max(20, _stage.height() * 0.18),
    image: canvas, width: canvas.width, height: canvas.height, draggable: true, name: 'userTextBox',
  });
  node.setAttr('textHtml',  html);
  node.setAttr('textWidth', canvas.width);
  node.setAttr('naturalW',  canvas.width);
  node.setAttr('naturalH',  canvas.height);
  node.setAttr('isToc',     true);
  _layer.add(node); _attachNode(node); _setSelection(node);
  _pushAddNodeUndo(node, 'Add table of contents');
  _scheduleSave();
  return node;
}

/** Regenerate a TOC box's lines from the current chapters/timecodes (right-click)
 *  — PRESERVING the user's styling (extracted from the current HTML). */
async function _refreshTocBox(node) {
  if (!node || !node.getAttr('isToc')) return;
  node.setAttr('textHtml', await _generateTocHtml(_extractTocStyle(node.getAttr('textHtml'))));
  await _reflowTextBox(node);
  _scheduleSave();
}

/** Refresh every TOC box on the ACTIVE step (used by sbsTocSync after a
 *  timing measurement). Returns how many were refreshed. */
export async function refreshTocBoxes() {
  if (!_layer) return 0;
  const boxes = _layer.getChildren(n => n.getAttr && n.getAttr('isToc'));
  for (const b of boxes) await _refreshTocBox(b);
  if (boxes.length) _layer.batchDraw();
  return boxes.length;
}

/** DATA-LEVEL refresh of every TOC box in EVERY step's stored overlay (style-
 *  preserving). The live-layer refresh only reaches the active step; TOC boxes
 *  on other steps live as baked overlay JSON, which the export loads directly —
 *  so a pre-render auto-sync must rewrite them all. The raster regenerates from
 *  textHtml at load time, so updating the JSON is sufficient. Returns steps touched. */
export async function refreshAllTocBoxesData(opts = {}) {
  const allSteps = state.get('steps') || [];
  let touched = 0;
  for (const st of allSteps) {
    if (typeof st.overlay !== 'string' || !st.overlay.includes('"isToc":true')) continue;
    let spec; try { spec = JSON.parse(st.overlay); } catch { continue; }
    const tocNodes = [];
    (function walk(o) { if (!o || typeof o !== 'object') return; if (o.attrs?.isToc && o.attrs.textHtml !== undefined) tocNodes.push(o); (o.children || []).forEach(walk); })(spec);
    if (!tocNodes.length) continue;
    // opts.chapters: EXACT times injected by the assembly (read off the real
    // stitched timeline) — bypasses the estimate entirely.
    for (const tn of tocNodes) tn.attrs.textHtml = await _generateTocHtml(_extractTocStyle(tn.attrs.textHtml), opts.chapters || null);
    const json = JSON.stringify(spec);
    if (json !== st.overlay) { st.overlay = json; touched++; }
  }
  if (touched) { state.markDirty(); _markOverlayStringsAuthoritative(); }   // strings authoritative until reload
  return touched;
}

// ─── Live in-place text editing (Phase 2) ───────────────────────────────────
//
// Replaces the modal popup. Double-click a text box → a contenteditable
// <div> mounts over the canvas at the node's position, the rasterised
// Konva.Image is hidden, the user types/edits/selects natively. On click
// outside, we re-rasterise the HTML and bring the Konva.Image back.
//
// Phase 3 will add a floating style toolbar above this editable; the
// toolbar will use mousedown.preventDefault() so clicking it doesn't
// blur the selection.

let _activeTextEditor = null;   // { node, div, onDocMouseDown, transformerWasVisible, ctx }

/**
 * Default editor controller for OVERLAY textboxes — re-raster via
 * _reflowTextBox, persist via _scheduleSave, style via setAttr('styleId').
 * header.js builds its own controller (different layer, different
 * persistence path, no per-step save). The controller is the only
 * surface that varies between contexts; the editor itself is layer-
 * agnostic — see enterTextEditor below.
 */
function _overlayEditorCtx(node) {
  return {
    transformer: _transformer,
    configureTransformer: () => _configTransformerForNode(node),
    reflow:        () => _reflowTextBox(node),
    onCommit:      async (html) => {
      const prev = node.getAttr('textHtml');
      node.setAttr('textHtml', html);
      const ok = await _reflowTextBox(node);
      if (!ok) {
        console.warn('[overlay] rasterise failed on click-out — reverting to previous text.');
        node.setAttr('textHtml', prev);
      }
    },
    onSave:        _scheduleSave,
    getStyleId:    () => node.getAttr('styleId') || '',
    setStyleId:    (id) => {
      // P7-A: snapshot before style binding changes so the toolbar
      // dropdown is undoable inside the same session as B/I/U/etc.
      editSession.record();
      node.setAttr('styleId', id || null);
      _reflowTextBox(node).catch(() => {});
      // 📌 V0.3.2.98 — a constant instance's binding writes through to its
      // definition: every sibling (this step now, other steps at load)
      // adopts the same style. "Change one to style 3 → they all change."
      _propagateConstStyle(node, id || null);
      _scheduleSave();
    },
  };
}

/**
 * Public entry point for opening the in-place text editor on any
 * Konva.Image-with-textHtml node (overlay textbox OR header textbox).
 * Caller passes a `ctx` controller object that abstracts the
 * layer-specific bits (transformer, persistence, re-raster, style
 * binding); when omitted, the overlay default is used.
 *
 * The editor ITSELF is identical in both contexts — same div, same
 * toolbar, same paste sanitiser, same style engine. Only the side-
 * effects vary, which is what the controller captures.
 */
export function enterTextEditor(node, ctx) {
  _enterTextEdit(node, ctx);
}

/** Force-close any live in-place text editor (rescue for a ghost editor —
 *  window.sbsFix.textEditor). Commits by default; { discard:true } to drop. */
export function closeTextEditor(opts = {}) {
  return _exitTextEdit(opts);
}

/** Open the in-place editor on a text-box node. */
function _enterTextEdit(node, ctxOverride) {
  if (_activeTextEditor) _exitTextEdit();
  const ctx = ctxOverride || _overlayEditorCtx(node);
  // Derive DOM container from the node's stage rather than overlay's
  // module-local _container — this lets header.js reuse the editor
  // without us hard-coding the overlay stage's div.
  const stage = node.getLayer()?.getStage();
  const containerEl = stage?.container() || _container;
  const containerRect = containerEl.getBoundingClientRect();
  const pos = node.getAbsolutePosition();

  const div = document.createElement('div');
  div.contentEditable = 'true';
  // Spellcheck ON (V0.3.1.84): Chromium's native checker — on Windows it uses
  // the OS spellchecker (offline, all installed Windows languages incl. Hebrew).
  // Squiggles are editor chrome only — they never reach the rasterised textHtml
  // (the raster is drawn from the HTML, not the live contenteditable). R-click
  // suggestions come from the main process ('context-menu' → replaceMisspelling).
  div.spellcheck      = true;
  div.innerHTML       = node.getAttr('textHtml') || '<div>Text</div>';
  div.dataset.sbsTextEditor = '1';
  // CSS MUST match _htmlToCanvas exactly — padding, font-family, font-size,
  // line-height. Otherwise the rasterised result lands somewhere different
  // from where the user typed and the click-out feels like a "jump".
  // Live editor mounts with auto-height. Setting min-height was making
  // the editable taller than the content (and hiding caret position
  // strangeness on short content). With min-height:0 the box's height
  // tracks whatever the user types — exactly matching the rasterised
  // result on click-out.
  // overflow stays visible during edit so the caret never gets clipped
  // mid-line; the rasteriser still uses overflow:hidden internally
  // (no-op when there's no fixed height anyway).
  // Editor needs to display at the SAME on-screen size as the rastered
  // image. The Konva node lives in canonical pixel space; the canvas
  // displays scaled by sf.scale (always-canonical-camera letterboxes the
  // canvas inside the viewer). So we lay the editor out in CANONICAL
  // pixels (width = node.width(), font 16px, padding 8px — same as
  // _htmlToCanvas) and apply transform: scale(sfScale) with origin 0,0
  // to render it down to viewport pixels. Without this the editor was
  // visibly bigger than the raster — the user typed in one size and the
  // box snapped smaller on click-out.
  const _sf = computeSafeFrameRect({ width: containerRect.width, height: containerRect.height });
  const _editorScale = _sf.scale > 0 ? _sf.scale : 1;
  div.style.cssText = [
    'position:fixed',
    `left:${Math.round(containerRect.left + pos.x)}px`,
    `top:${Math.round(containerRect.top + pos.y)}px`,
    `width:${Math.round(node.width())}px`,
    'min-height:0',
    'padding:8px',                     // matches _htmlToCanvas default (canonical)
    'margin:0',
    'border:0',
    'outline:2px dashed #f59e0b',
    'outline-offset:0',
    'background:rgba(15,23,42,0.55)',
    'color:#ffffff',                   // matches _htmlToCanvas default
    'font-family:Arial',               // matches _htmlToCanvas default
    'font-size:16px',                  // matches _htmlToCanvas default (canonical)
    'line-height:1.2',                 // matches _htmlToCanvas default
    'white-space:pre-wrap',
    'word-wrap:break-word',
    'box-sizing:border-box',           // matches _htmlToCanvas default
    'z-index:10000',
    'cursor:text',
    'user-select:text',
    `transform:scale(${_editorScale})`,
    'transform-origin:0 0',
  ].join(';');
  document.body.appendChild(div);

  // Hide the rasterised image but KEEP the node addressable so the
  // transformer stays attached — that way the user can resize the box
  // mid-edit and the contenteditable follows live (see node.on('transform')
  // in _attachNode).  We use opacity:0 (not visible:false) for this; the
  // transformer's bounding box still tracks the node's geometry.
  const prevOpacity = node.opacity();
  node.opacity(0);
  // Re-config the transformer for the editing node so 8 anchors show up
  // (selection-only state has no anchors). The controller knows which
  // transformer to reach for — overlay's, header's, etc.
  ctx.configureTransformer?.();
  // Redraw the layers the transformer + node live in. node.getLayer() is
  // the content layer; transformer might be on a different one (overlay
  // has _uiLayer, header keeps both on _layer). Drawing both is cheap
  // and avoids a stale frame on whichever the transformer sits in.
  const nodeLayer  = node.getLayer();
  const trLayer    = ctx.transformer?.getLayer?.();
  nodeLayer?.batchDraw();
  if (trLayer && trLayer !== nodeLayer) trLayer.batchDraw();

  // Tell Chromium to wrap new lines in <div> rather than <br>. With
  // <br> at position 0 the browser treats it inconsistently — typing
  // before the first character can swallow content. <div> gives every
  // line a stable block container and Enter / Backspace at position 0
  // behave predictably.
  try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch {}
  // Force execCommand to write inline-style spans (e.g.
  //   <span style="color:red">...</span>)
  // instead of legacy <font color="..."> markup. Without this Chromium
  // defaults to <font> for foreColor/fontName/fontSize, which our
  // sanitiser strips (not in the allowlist) — so copy/paste between
  // textboxes was losing colour and font on every round trip.
  try { document.execCommand('styleWithCSS', false, true); } catch {}

  // Focus + put the caret at the end of the existing content.
  div.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Click-outside detection. Listen at the document on the capture phase
  // so we beat anything else that might consume the click. Skip if the
  // event landed inside the editor (or, later, the toolbar).
  const onDocMouseDown = (e) => {
    // ZOMBIE GUARD (V0.3.2.59): a listener whose session/div is gone must be
    // INERT. The old deferred-add race could leave this bound to a detached
    // div; a detached div's .contains() is always false, so EVERY click
    // anywhere then tore down whatever editor was open — the persistent
    // "can't edit any text box, drag-select exits" bug.
    if (!div.isConnected || _activeTextEditor?.div !== div) {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      return;
    }
    if (div.contains(e.target)) return;
    if (e.target?.closest?.('[data-sbs-text-toolbar]')) return;   // Phase 3
    // Swallow the click that fires when the OS colour-picker dialog
    // closes — without this, every "pick colour" gesture also exits
    // the editor and discards subsequent style edits.
    if (wasColorPickedRecently()) return;
    _exitTextEdit();
  };
  // Register SYNCHRONOUSLY (V0.3.2.59) — the old setTimeout(0) deferral was
  // the sole source of the leak: an _exitTextEdit that ran before the timer
  // fired left removeEventListener a no-op, then the timer bound a zombie for
  // the life of the page. The deferral was also pointless: a mousedown-capture
  // listener added inside the dblclick handler cannot catch that double-click's
  // already-fired mousedowns.
  document.addEventListener('mousedown', onDocMouseDown, true);

  // Esc cancels (no save); Enter inserts a newline (browser default).
  // Ctrl+Z / Ctrl+Y route to the local edit-session stack first — if a
  // toolbar / engine op was the last thing, undoLocal() pops it and
  // we preventDefault. If the local stack is empty (only typing has
  // happened since the last toolbar op), we DON'T preventDefault so
  // the browser's native contenteditable undo handles the keystrokes.
  // This gives the user fine-grained Ctrl-Z inside the editor without
  // duplicating the browser's typing-undo machinery.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      _exitTextEdit({ discard: true });
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    // Physical-key match so undo/redo survive non-Latin layouts (V0.3.0.81).
    const kc  = (e.key || '').toLowerCase();
    const isZ = e.code === 'KeyZ' || kc === 'z';
    const isY = e.code === 'KeyY' || kc === 'y';
    if (mod && !e.shiftKey && isZ) {
      if (editSession.canUndoLocal()) {
        e.preventDefault();
        e.stopPropagation();
        editSession.undoLocal();
        // Toolbar mirrors the post-undo caret styling.
        setToolbarValues(_readStyleAtCaret(div));
      }
      return;
    }
    if (mod && (isY || (e.shiftKey && isZ))) {
      if (editSession.canRedoLocal()) {
        e.preventDefault();
        e.stopPropagation();
        editSession.redoLocal();
        setToolbarValues(_readStyleAtCaret(div));
      }
      return;
    }
  };
  div.addEventListener('keydown', onKeyDown);

  // No custom COPY handler. The browser's native copy from a
  // contenteditable serialises the selection with COMPUTED styles
  // resolved onto the cloned spans — exactly what we want for paste
  // round-trips between our textboxes. A custom onCopy that used
  // cloneContents() lost those computed styles (cloneContents only
  // captures literal inline styles on the selected nodes, not
  // ancestor-inherited ones), which is why styled paste between
  // textboxes was always coming through plain.

  // Sanitise on PASTE only. Catches:
  //   • clipboard wrapper artefacts (<meta>, <!--StartFragment-->,
  //     <!doctype>, <html><body>) that break SVG-foreignObject
  //   • disallowed tags / attrs / inline images / scripts
  //   • legacy <font> tags promoted to inline <span style>
  //   • leading / trailing block padding that would force extra empty
  //     lines around the inserted content
  // Insertion goes through the Selection API, not execCommand —
  // execCommand('insertHTML') in some Chromium versions silently strips
  // inline styles on the inserted fragment. Manual insertNode preserves
  // them verbatim.
  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    if (html) {
      e.preventDefault();
      const clean = _trimPasteBlocks(_sanitiseTextboxHtml(html));
      _insertHtmlAtCaret(div, clean);
    } else if (text) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
    }
  };
  div.addEventListener('paste', onPaste);

  // Mount the in-row toolbar (B/I/U/S, font, size, color, align). It
  // takes over the slot inside the existing overlay edit toolbar so all
  // controls live on the same row. Operates on the live Selection inside
  // the contenteditable. The click-outside detector already whitelists
  // [data-sbs-text-toolbar] so toolbar clicks won't dismiss the editor.
  const toolbarHost = getTextToolbarSlot();
  if (toolbarHost) {
    mountTextToolbar(toolbarHost, _singleEditorApplier, div);
    // Style dropdown — only mount when the controller actually supports
    // style-template binding for this context. Headers don't (yet — P4),
    // so we pass null to remove the dropdown rather than show a no-op
    // control. Overlay textboxes always provide getStyleId/setStyleId.
    if (ctx.setStyleId) {
      const initialStyleId = ctx.getStyleId?.() || '';
      setStyleDropdown(listStyleTemplates(), initialStyleId, (newId) => {
        ctx.setStyleId(newId);
        setStyleLocked(!!newId);
      });
      setStyleLocked(!!initialStyleId);
    } else {
      setStyleDropdown(null);    // explicitly hide
      setConstDropdown(null);    // 📌 hidden while typing — attach/detach from selection mode
      setStyleLocked(false);
    }
  }
  // Sync the dropdowns to whatever style is at the caret. Re-fires on
  // every selection change so moving the caret across mixed-style runs
  // updates the toolbar live.
  const onSelectionChange = () => {
    if (!_activeTextEditor || !div.contains(window.getSelection()?.anchorNode || null)) return;
    setToolbarValues(_readStyleAtCaret(div));
  };
  document.addEventListener('selectionchange', onSelectionChange);
  onSelectionChange();   // initial sync

  _activeTextEditor = { node, div, onDocMouseDown, onKeyDown, onPaste, prevOpacity, onSelectionChange, ctx };

  // P7-A: open an edit session so toolbar / engine ops can be undone
  // locally (Ctrl-Z inside the editor) and the WHOLE session collapses
  // into a SINGLE main-undo entry on commit. Snapshot captures editor
  // HTML + node attrs we care about (fillColor for textbox bg, styleId
  // for template binding). restoreLocal works on the LIVE editor div;
  // restoreCommitted works on the BAKED Konva.Image after click-out.
  editSession.begin({
    label: 'Edit text',
    snapshot: () => ({
      html:      div.innerHTML,
      fillColor: node.getAttr('fillColor') ?? null,
      styleId:   node.getAttr('styleId')   ?? null,
    }),
    restoreLocal: (snap) => {
      // Editor still mounted — write to the contenteditable + node attrs.
      // The visible textbox stays opacity:0 so the editor is what the
      // user sees; restoring node attrs is for the on-commit raster.
      div.innerHTML = snap.html;
      node.setAttr('fillColor', snap.fillColor);
      node.setAttr('styleId',   snap.styleId);
      div.style.backgroundColor = snap.fillColor || 'rgba(15,23,42,0.55)';
    },
    restoreCommitted: async (snap) => {
      // Editor already torn down — operate on the Konva.Image directly.
      // Skip if the node was destroyed (step change, deletion). Returning
      // false from undoManager's command tells it to drop this entry from
      // the redo path rather than spin on a dead reference.
      if (!node || node.isDestroyed?.()) return false;
      node.setAttr('textHtml',  snap.html);
      node.setAttr('fillColor', snap.fillColor);
      node.setAttr('styleId',   snap.styleId);
      await _reflowTextBox(node);
      _scheduleSave();
    },
  });
}

/** Close the in-place editor, re-rasterise on the way out (unless discard).
 *
 *  HARDENED (V0.3.1.82) after the user's alt-tab repro: the old body removed
 *  the listeners FIRST, then awaited the commit raster, and removed the DOM
 *  LAST. A wedged raster (seen after leaving/re-entering the app window —
 *  Chromium occlusion quirks) killed the teardown mid-flight: listeners gone
 *  (click-outside dead forever) but the editor DOM never removed → the
 *  immortal ghost editor. Now: (1) the session is CLAIMED immediately
 *  (re-entrancy safe — a second call can't re-await the same hang), (2) the
 *  commit is TIME-BOUNDED (fast path unchanged/flicker-free; a hung raster
 *  can't hold the DOM hostage), (3) div.remove() lives in a finally that
 *  ALWAYS runs. */
async function _exitTextEdit(opts = {}) {
  if (!_activeTextEditor) return;
  const sess = _activeTextEditor;
  _activeTextEditor = null;                        // claim NOW — no re-entry on the same session
  const { node, div, onDocMouseDown, onKeyDown, onPaste, prevOpacity, onSelectionChange, ctx } = sess;
  try {
    document.removeEventListener('mousedown', onDocMouseDown, true);
    if (onSelectionChange) document.removeEventListener('selectionchange', onSelectionChange);
    div.removeEventListener('keydown', onKeyDown);
    if (onPaste) div.removeEventListener('paste', onPaste);
    unmountTextToolbar();

    const html = div.innerHTML;

    if (!opts.discard && html) {
      // Commit goes through the controller (overlay: textHtml + reflow;
      // header: updateHeaderItem). Awaited so the new raster is in place
      // BEFORE the editor is removed (no flicker) — but RACED against a
      // timeout so a wedged raster can only delay the ghost-free teardown,
      // never prevent it. The commit itself keeps running in the background
      // if it eventually resolves.
      try {
        await Promise.race([
          Promise.resolve(ctx.onCommit?.(html)),
          new Promise(res => setTimeout(res, 2000)),
        ]);
      } catch (e) { console.warn('[text-editor] commit failed', e); }
    }

    // P7-A: close the edit session (discard → restoreLocal while the div is
    // still mounted; commit → one main-undo entry for the whole edit).
    try { editSession.end({ commit: !opts.discard }); }
    catch (e) { console.warn('[text-editor] session end failed', e); }
  } finally {
    try { node.opacity(typeof prevOpacity === 'number' ? prevOpacity : 1); } catch {}
    div.remove();                                  // ALWAYS — the ghost dies here
    try { ctx.configureTransformer?.(); } catch {}
    try {
      const nodeLayer = node.getLayer();
      const trLayer   = ctx.transformer?.getLayer?.();
      nodeLayer?.batchDraw();
      if (trLayer && trLayer !== nodeLayer) trLayer.batchDraw();
    } catch {}
    try { ctx.onSave?.(); } catch {}
  }
}

/**
 * Re-rasterize a text-box node at its CURRENT width AND height. The
 * raster reflows the stored HTML into the user-dragged box: text wraps
 * at the new width, and content that overflows the dragged height is
 * clipped (true text-frame behaviour). Font size is unchanged.
 *
 * Position and dragged dimensions are preserved — this fixes the Phase 1
 * bug where the node snapped back to the content's natural height,
 * making the user's height drag look ignored.
 */
async function _reflowTextBox(node) {
  const html = node.getAttr('textHtml');
  if (!html) return false;
  // Defensive width: node.width() can return undefined / NaN if the node
  // was just constructed without explicit width (e.g. legacy save). NaN
  // through Math.round → NaN → canvas.width = NaN → canvas coerces to
  // 0, which Konva later tries to drawImage and throws "0 width or
  // height". Guard with a 400px fallback.
  const rawW = Math.round(node.width());
  const w = Number.isFinite(rawW) && rawW > 0 ? Math.max(20, rawW) : 400;
  const styleId = node.getAttr('styleId') || null;
  const tpl = styleId ? getStyleTemplate(styleId) : null;

  // Style-template-bound boxes ignore their inline styling and inherit
  // EVERYTHING from the template (per spec: assigning a style overrides
  // any per-character formatting). Alignment is the only thing that
  // survives — strip alignment from the inline styles (we keep the
  // <div text-align:...> wrappers because alignment IS the box-level
  // override).
  let renderHtml = html;
  let opts = { width: w, bgColor: node.getAttr('fillColor') || 'transparent' };
  if (tpl) {
    renderHtml = _stripInlineStylingExceptAlign(html);
    opts = {
      ...opts,
      fontFamily:     tpl.fontFamily     || 'Arial',
      fontSize:       tpl.fontSize       || 16,
      color:          tpl.color          || '#ffffff',
      fontWeight:     tpl.fontWeight     || 'normal',
      fontStyle:      tpl.fontStyle      || 'normal',
      textDecoration: tpl.textDecoration || '',
      bgColor:        tpl.fillColor || opts.bgColor,
    };
  }

  // Auto-height: do NOT pass `height` to the rasteriser. The canvas
  // ends up exactly as tall as the wrapped text needs at this width.
  // Box grows/shrinks vertically as the content does — true text-frame
  // behaviour without a manual height handle for the user to fight.
  const canvas = await _htmlToCanvas(renderHtml, opts);
  if (!canvas) return false;
  // Reject canvases with zero dim — drawImage on a 0×0 source throws
  // synchronously inside Konva's _sceneFunc and corrupts subsequent
  // draws on the layer. Better to skip than to poison the layer.
  if (!canvas.width || !canvas.height) {
    console.warn('[overlay] _reflowTextBox: 0-sized canvas, skipping image swap', { w, opts, html: html.slice(0, 80) });
    return false;
  }
  node.image(canvas);
  node.width(canvas.width);
  node.height(canvas.height);
  node.setAttr('textWidth', canvas.width);
  node.setAttr('naturalW',  canvas.width);
  node.setAttr('naturalH',  canvas.height);
  _layer.batchDraw();
  return true;
}

// (Old modal-based _editTextBox + openTextEditor import removed in Phase 2.
// In-place editing via _enterTextEdit / _exitTextEdit is now the only path.)

/**
 * @param {string|File} src  data URL or File object (e.g. from <input type="file">)
 */
export async function addImage(src) {
  if (!_stage) return null;
  const dataUrl = typeof src === 'string' ? src : await _fileToDataURL(src);
  const img = await _loadImage(dataUrl);
  // Fit to 50% of stage on the larger axis, keep aspect.
  const maxW = _stage.width()  * 0.5;
  const maxH = _stage.height() * 0.5;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  const node = new Konva.Image({
    x: (_stage.width() - w) / 2,
    y: (_stage.height() - h) / 2,
    image: img,
    width:  w,
    height: h,
    draggable: true,
    name: 'userImage',
  });
  // Store the data URL so toJSON round-trips (Konva doesn't serialize HTMLImageElement).
  node.setAttr('src', dataUrl);
  // Native pixel dimensions — used by right-click → Reset to restore the
  // image to its raw size (1:1 with the source file). The fitted w/h above
  // is just the on-create placement, not the "original" the user sees as canonical.
  node.setAttr('naturalW', img.width);
  node.setAttr('naturalH', img.height);
  _layer.add(node);
  _attachNode(node);
  _setSelection(node);
  _pushAddNodeUndo(node, 'Add image');   // P7-C-1
  _scheduleSave();
  return node;
}

// ── Layer ordering helpers ────────────────────────────────────────────────

/**
 * Reorder the multi-selection without disturbing relative order. The naive
 * approach — calling `node.moveUp()` on each selected node in selection
 * order — collapses the selection to a single contiguous block at top/bottom
 * (each moveUp swaps with the next sibling, so all selected nodes pile up).
 *
 * Right approach: sort by current zIndex, then walk OUTSIDE-IN. For
 * "moveUp" / "moveToTop" we walk top-down (highest first). For "moveDown" /
 * "moveToBottom" we walk bottom-up (lowest first). That preserves the
 * relative spacing between selected nodes when they're not contiguous.
 *
 * Returns true on any successful move (caller redraws + saves).
 */
function _reorderSelection(key, sel) {
  if (!sel?.length) return false;
  // Snapshot current zIndices for undo. zIndex is dense (0..N-1) and
  // assigned by Konva based on the children array order in the layer.
  const allNodes = _layer.children?.slice() || [];
  const beforeIds = allNodes.map(n => n._id);

  // sorted = ascending zIndex (bottom-most first, top-most last).
  const sorted = [...sel].sort((a, b) => a.zIndex() - b.zIndex());
  let changed = false;
  if (key === 'Home') {
    // Walk LOWEST-z first. moveToTop puts the current node above all
    // others — so processing low → high makes the originally-highest
    // node land highest at the end (relative order preserved).
    for (const n of sorted) { n.moveToTop(); changed = true; }
  } else if (key === 'End') {
    // Walk HIGHEST-z first. moveToBottom drops below all others — so
    // processing high → low keeps the originally-lowest at the bottom.
    for (let i = sorted.length - 1; i >= 0; i--) { sorted[i].moveToBottom(); changed = true; }
  } else if (key === 'PageUp') {
    // Walk HIGHEST-z first so a moveUp swap doesn't shove an unmoved peer.
    for (let i = sorted.length - 1; i >= 0; i--) {
      const n = sorted[i];
      if (n.zIndex() < allNodes.length - 1) { n.moveUp(); changed = true; }
    }
  } else if (key === 'PageDown') {
    // Walk LOWEST-z first.
    for (const n of sorted) {
      if (n.zIndex() > 0) { n.moveDown(); changed = true; }
    }
  }

  if (!changed) return false;

  // Push a single undo entry covering the full reorder.
  const afterIds = (_layer.children?.slice() || []).map(n => n._id);
  if (JSON.stringify(beforeIds) === JSON.stringify(afterIds)) return false;
  undoManager.push(
    'Reorder layers',
    () => { _restoreLayerOrder(beforeIds); _layer.batchDraw(); _scheduleSave(); },
    () => { _restoreLayerOrder(afterIds);  _layer.batchDraw(); _scheduleSave(); },
  );
  return true;
}

/** Apply a saved id-sequence as the layer's child order. */
function _restoreLayerOrder(ids) {
  if (!ids || !_layer) return;
  const byId = new Map(_layer.children.map(n => [n._id, n]));
  for (const id of ids) {
    const n = byId.get(id);
    if (n) n.moveToTop();
  }
}

// ── Shape primitives ──────────────────────────────────────────────────────
//
// Lightweight Konva shapes (Rect for now; Circle/Ellipse/Line/Arrow/etc.
// next). Each shape carries `name: 'userShape'` + `kind: <type>` so the
// selection toolbar can detect it and surface fill/stroke/opacity controls.
//
// All visual attributes round-trip via Konva.toJSON, so per-step persistence
// works without extra serialisation hooks.

const SHAPE_DEFAULTS = {
  fill:         'rgba(74,144,217,0.45)',  // alpha 0.45 = "Fill α" slider value
  stroke:       '#4A90D9',                // solid — alpha lives in fill only
  strokeWidth:  3,
  opacity:      1,                         // node-level opacity stays 1 always
  cornerRadius: 0,
};

/**
 * Wire transformend handler for a freshly-added shape. Bakes the
 * transformer's scale into the shape's geometry attrs so the stroke
 * stays at the user-set thickness across resize and the serialised
 * spec matches the rendered size. Different shape types need different
 * geometry rebakes; the kind tag picks the right path.
 */
function _wireShapeTransformend(node, kind) {
  node.on('transformend', () => {
    const sx = node.scaleX(), sy = node.scaleY();
    if (kind === 'rect') {
      node.width(node.width() * sx);
      node.height(node.height() * sy);
    } else if (kind === 'circle') {
      // Circle uses radius; pick the larger axis.
      node.radius(node.radius() * Math.max(Math.abs(sx), Math.abs(sy)));
    } else if (kind === 'ellipse') {
      node.radiusX(node.radiusX() * Math.abs(sx));
      node.radiusY(node.radiusY() * Math.abs(sy));
    } else if (kind === 'triangle') {
      node.radius(node.radius() * Math.max(Math.abs(sx), Math.abs(sy)));
    } else if (kind === 'line' || kind === 'arrow') {
      // Bake scale into points + position resets so future drags are
      // local to the new pose.
      const pts = node.points();
      const baked = pts.map((v, i) => v * (i % 2 === 0 ? sx : sy));
      node.points(baked);
    }
    node.scaleX(1);
    node.scaleY(1);
    _scheduleSave();
  });
}

/**
 * Add a Rectangle to the active overlay step. Centred on the stage,
 * default size 30% × 18% of the stage. Selectable, draggable, resizable
 * through the same transformer + drag pipeline as text / image nodes.
 */
/**
 * 🎬 Add a video clip to this step's overlay (V0.3.2.75).
 *
 * `absPath` is a real path on disk — the file is referenced, never copied
 * into the project (see systems/video-overlay.js for why). Returns the
 * Konva node, or throws with a readable message when the file can't be
 * decoded (wrong codec is the common case).
 */
export async function addVideo(absPath) {
  if (!_stage) return null;
  const { abs, rel } = videoOverlay.describeVideoPath(absPath);
  if (!abs) throw new Error('No file path — pick the video from disk.');

  const node = new Konva.Image({
    x: 0, y: 0, width: 640, height: 360,
    draggable: true,
    name: 'userVideo',
  });
  node.setAttr('isVideo', true);
  node.setAttr('videoId', `vid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
  node.setAttr('videoPath', abs);
  node.setAttr('videoRel',  rel);     // '' when the clip lives outside the project folder
  node.setAttr('muted', true);        // voice-over wins until the user says otherwise
  node.setAttr('volume', 1);
  node.setAttr('trimInMs', 0);
  node.setAttr('trimOutMs', 0);       // 0 = "to the end", resolved once duration is known

  // Load the element first so we know the real size + duration before placing.
  const video = await videoOverlay.attachVideoElement(node);
  if (!video) throw new Error('Video could not be opened.');

  const vw = video.videoWidth  || 640;
  const vh = video.videoHeight || 360;
  const scale = Math.min((_stage.width() * 0.5) / vw, (_stage.height() * 0.5) / vh, 1);
  node.width(vw * scale);
  node.height(vh * scale);
  node.x((_stage.width()  - node.width())  / 2);
  node.y((_stage.height() - node.height()) / 2);
  node.setAttr('trimOutMs', Number(node.getAttr('videoDurationMs') ?? 0));

  // Poster: one small JPEG of the first frame, inlined so the node draws
  // instantly on reload and still shows something if the file goes missing.
  try { node.setAttr('posterSrc', await _captureVideoPoster(video)); }
  catch { /* poster is optional */ }

  _layer.add(node);
  _attachNode(node);
  _setSelection(node);
  _pushAddNodeUndo(node, 'Add video');
  _scheduleSave();
  // Park on the first frame; playback starts when the step is active.
  try { video.pause(); video.currentTime = 0; } catch { /* ignore */ }
  _layer.batchDraw();
  return node;
}

/**
 * Open the trim/audio dialog for a video node and apply the result as ONE
 * undoable change (V0.3.2.75). Loaded on demand so the dialog module never
 * costs anything for projects with no video.
 */
async function _openVideoTrim(node) {
  const { openVideoTrimDialog } = await import('../ui/video-trim-dialog.js');
  const before = {
    trimInMs:  Number(node.getAttr('trimInMs')  ?? 0),
    trimOutMs: Number(node.getAttr('trimOutMs') ?? 0),
    muted:     node.getAttr('muted') !== false,
    volume:    Number(node.getAttr('volume') ?? 1),
  };
  const res = await openVideoTrimDialog(node);
  if (!res) return;
  videoOverlay.setVideoOptions(node, res);
  // V0.3.2.85 — trim moved → the poster must show the NEW first frame
  // (fades seed from it). Async and cosmetic; save again once it lands.
  videoOverlay.refreshPoster(node).then(ok => { if (ok) _scheduleSave(); });
  _scheduleSave();
  undoManager.push(
    'Trim video',
    () => { videoOverlay.setVideoOptions(node, before); _scheduleSave(); },
    () => { videoOverlay.setVideoOptions(node, res);    _scheduleSave(); },
  );
  const win = ((res.trimOutMs - res.trimInMs) / 1000).toFixed(2);
  setStatus(`Clip set to ${win}s${res.muted ? ' (muted)' : ' (audio on)'}.`, 'success', 5000);
}

/** Small first-frame JPEG (max 480px wide) — cheap enough to inline. */
async function _captureVideoPoster(video) {
  const vw = video.videoWidth || 0, vh = video.videoHeight || 0;
  if (!vw || !vh) return '';
  const scale = Math.min(1, 480 / vw);
  const c = document.createElement('canvas');
  c.width  = Math.max(1, Math.round(vw * scale));
  c.height = Math.max(1, Math.round(vh * scale));
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

export function addRect() {
  if (!_stage) return null;
  const sw = _stage.width(), sh = _stage.height();
  const w = Math.max(60, sw * 0.30);
  const h = Math.max(40, sh * 0.18);
  const node = new Konva.Rect({
    x: (sw - w) / 2,
    y: (sh - h) / 2,
    width:        w,
    height:       h,
    fill:         SHAPE_DEFAULTS.fill,
    stroke:       SHAPE_DEFAULTS.stroke,
    strokeWidth:  SHAPE_DEFAULTS.strokeWidth,
    opacity:      SHAPE_DEFAULTS.opacity,
    cornerRadius: SHAPE_DEFAULTS.cornerRadius,
    draggable:    true,
    name:         'userShape',
  });
  node.setAttr('kind', 'rect');
  _wireShapeTransformend(node, 'rect');
  _layer.add(node);
  _attachNode(node);
  _setSelection(node);
  _pushAddNodeUndo(node, 'Add rectangle');
  _scheduleSave();
  return node;
}

/** Add a Circle. */
export function addCircle() {
  if (!_stage) return null;
  const sw = _stage.width(), sh = _stage.height();
  const r  = Math.max(40, Math.min(sw, sh) * 0.10);
  const node = new Konva.Circle({
    x: sw / 2, y: sh / 2, radius: r,
    fill:        SHAPE_DEFAULTS.fill,
    stroke:      SHAPE_DEFAULTS.stroke,
    strokeWidth: SHAPE_DEFAULTS.strokeWidth,
    opacity:     SHAPE_DEFAULTS.opacity,
    draggable:   true,
    name:        'userShape',
  });
  node.setAttr('kind', 'circle');
  _wireShapeTransformend(node, 'circle');
  _layer.add(node); _attachNode(node); _setSelection(node);
  _pushAddNodeUndo(node, 'Add circle'); _scheduleSave();
  return node;
}

/** Add an Ellipse. */
export function addEllipse() {
  if (!_stage) return null;
  const sw = _stage.width(), sh = _stage.height();
  const rx = Math.max(60, sw * 0.15), ry = Math.max(40, sh * 0.10);
  const node = new Konva.Ellipse({
    x: sw / 2, y: sh / 2, radiusX: rx, radiusY: ry,
    fill:        SHAPE_DEFAULTS.fill,
    stroke:      SHAPE_DEFAULTS.stroke,
    strokeWidth: SHAPE_DEFAULTS.strokeWidth,
    opacity:     SHAPE_DEFAULTS.opacity,
    draggable:   true,
    name:        'userShape',
  });
  node.setAttr('kind', 'ellipse');
  _wireShapeTransformend(node, 'ellipse');
  _layer.add(node); _attachNode(node); _setSelection(node);
  _pushAddNodeUndo(node, 'Add ellipse'); _scheduleSave();
  return node;
}

/** Add a Triangle (RegularPolygon, sides=3). */
export function addTriangle() {
  if (!_stage) return null;
  const sw = _stage.width(), sh = _stage.height();
  const r  = Math.max(50, Math.min(sw, sh) * 0.10);
  const node = new Konva.RegularPolygon({
    x: sw / 2, y: sh / 2, sides: 3, radius: r,
    fill:        SHAPE_DEFAULTS.fill,
    stroke:      SHAPE_DEFAULTS.stroke,
    strokeWidth: SHAPE_DEFAULTS.strokeWidth,
    opacity:     SHAPE_DEFAULTS.opacity,
    draggable:   true,
    name:        'userShape',
  });
  node.setAttr('kind', 'triangle');
  _wireShapeTransformend(node, 'triangle');
  _layer.add(node); _attachNode(node); _setSelection(node);
  _pushAddNodeUndo(node, 'Add triangle'); _scheduleSave();
  return node;
}

/** Add a Line. Two endpoints baked into `points`. */
export function addLine() {
  if (!_stage) return null;
  const sw = _stage.width(), sh = _stage.height();
  const dx = Math.max(80, sw * 0.20);
  const node = new Konva.Line({
    x: sw / 2, y: sh / 2,
    points:      [-dx / 2, 0, dx / 2, 0],
    stroke:      SHAPE_DEFAULTS.stroke,
    strokeWidth: SHAPE_DEFAULTS.strokeWidth,
    opacity:     SHAPE_DEFAULTS.opacity,
    draggable:   true,
    name:        'userShape',
  });
  node.setAttr('kind', 'line');
  _wireShapeTransformend(node, 'line');
  _layer.add(node); _attachNode(node); _setSelection(node);
  _pushAddNodeUndo(node, 'Add line'); _scheduleSave();
  return node;
}

/** Add an Arrow. Head sized off stroke width. */
export function addArrow() {
  if (!_stage) return null;
  const sw = _stage.width(), sh = _stage.height();
  const dx = Math.max(80, sw * 0.20);
  const node = new Konva.Arrow({
    x: sw / 2, y: sh / 2,
    points:        [-dx / 2, 0, dx / 2, 0],
    pointerLength: 14,
    pointerWidth:  14,
    fill:          SHAPE_DEFAULTS.stroke,    // arrow head reads stroke colour
    stroke:        SHAPE_DEFAULTS.stroke,
    strokeWidth:   SHAPE_DEFAULTS.strokeWidth,
    opacity:       SHAPE_DEFAULTS.opacity,
    draggable:     true,
    name:          'userShape',
  });
  node.setAttr('kind', 'arrow');
  _wireShapeTransformend(node, 'arrow');
  _layer.add(node); _attachNode(node); _setSelection(node);
  _pushAddNodeUndo(node, 'Add arrow'); _scheduleSave();
  return node;
}

/**
 * Patch attributes on every currently-selected shape. Fed by the
 * shape-toolbar's onChange callbacks (fill/stroke/strokeWidth/opacity/
 * cornerRadius). Pushes a coalesced undo entry: rapid slider drags fold
 * into a single Ctrl-Z step (one entry per ~burst) but the BEFORE state
 * snapshotted at the start of the burst is preserved.
 *
 * Burst lifecycle:
 *   • First apply with no live snapshot → capture each selected node's
 *     pre-edit attrs into _shapeEditBefore.
 *   • Each subsequent apply within 600 ms reuses that snapshot — its
 *     coalesced push to undoManager replaces the redo (latest after)
 *     while keeping the original undo (still pointing at first BEFORE).
 *   • 600 ms idle → _shapeEditBefore is cleared so the NEXT apply starts
 *     a fresh burst. The 600 ms window sits below undoManager's 800 ms
 *     coalesce window so a new burst is guaranteed to push a brand-new
 *     entry rather than coalesce into the previous one.
 */
const _SNAP_KEYS = ['fill', 'stroke', 'strokeWidth', 'opacity', 'cornerRadius'];

let _shapeEditBefore = null;   // Map<KonvaNode, attrs>
let _shapeEditTimer  = null;

function _snapshotShapeAttrs(node) {
  const out = {};
  for (const k of _SNAP_KEYS) {
    if (typeof node[k] === 'function') out[k] = node[k]();
    else                                out[k] = node.getAttr?.(k);
  }
  return out;
}

function _restoreShapeAttrsMap(map) {
  if (!map) return;
  for (const [n, attrs] of map) {
    if (!n || typeof n.getStage !== 'function' || !n.getStage()) continue;   // node was destroyed
    n.setAttrs(attrs);
  }
  _layer?.batchDraw();
  _scheduleSave();
}

export function applyShapeAttrs(patch) {
  if (!_transformer) return;
  const sel = _transformer.nodes().filter(n => n.name() === 'userShape');
  if (!sel.length) return;

  // Capture BEFORE-state once per burst.
  if (!_shapeEditBefore) {
    _shapeEditBefore = new Map();
    for (const n of sel) _shapeEditBefore.set(n, _snapshotShapeAttrs(n));
  }

  // Apply the patch. Konva treats null fill / stroke as "no paint" —
  // the toolbar checkbox uses that semantic.
  for (const n of sel) {
    for (const [k, v] of Object.entries(patch)) n.setAttr(k, v);
  }
  _layer.batchDraw();

  // Capture AFTER-state for the redo closure.
  const after = new Map();
  for (const n of sel) after.set(n, _snapshotShapeAttrs(n));

  // Coalesced push. The key includes node identities so editing a
  // DIFFERENT shape selection within the window starts a fresh entry.
  const beforeMap   = _shapeEditBefore;
  const ids         = [...beforeMap.keys()].map(n => n._id ?? '').sort().join(',');
  const coalesceKey = 'overlay-shape-attrs-' + ids;
  undoManager.push(
    'Edit shape',
    () => _restoreShapeAttrsMap(beforeMap),
    () => _restoreShapeAttrsMap(after),
    { coalesceKey },
  );

  // Restart the burst timer. 600 ms < undoManager's 800 ms window.
  clearTimeout(_shapeEditTimer);
  _shapeEditTimer = setTimeout(() => { _shapeEditBefore = null; }, 600);

  _scheduleSave();
}

/** Returns a representative attr snapshot across selected shapes. */
function _summariseShapeAttrs(nodes) {
  if (!nodes?.length) return {};
  const first = nodes[0];
  return {
    fill:         first.fill?.(),
    stroke:       first.stroke?.(),
    strokeWidth:  first.strokeWidth?.(),
    opacity:      first.opacity?.(),
    cornerRadius: first.cornerRadius?.(),
  };
}

function _attachNode(node) {
  // Single click selects (or toggles when held with Shift/Ctrl/Meta for
  // multi-select).
  //
  // Subtle but important: a plain click on a node that's ALREADY part of
  // a multi-selection should preserve the group — that click is the user
  // grabbing the group to drag, not asking to demote the selection to
  // just this one node. Without this guard, every drag start collapses
  // the selection to length-1 and the multi-drag handler bails.
  node.on('pointerdown', (e) => {
    const additive = !!(e.evt && (e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey));
    const current  = _transformer?.nodes() || [];
    if (!additive && current.includes(node)) return;
    _setSelection(node, additive);
  });

  // Interface "at default" tracking: a real move or resize takes an interface
  // OUT of the default condition, so a later "Update default position" leaves it
  // alone. Clicking/selecting (no drag) does NOT clear it.
  node.on('dragstart transformend', () => {
    if (node.getAttr('isInterface') && node.getAttr('atDefault')) node.setAttr('atDefault', false);
  });

  // Multi-node drag — now CROSS-LAYER. Konva's per-node draggable only
  // moves the grabbed node; siblings (in the same OR the header layer)
  // stay put. We stash starting positions across both layers' selections
  // on dragstart, apply the grabbed-node's delta to every sibling on
  // dragmove, and persist any header siblings on dragend (the grabbed
  // node + overlay siblings are in step.overlay JSON, captured by the
  // dragend handler below; header siblings need updateHeaderItem each).
  let _multiDragStarts = null;
  node.on('dragstart', () => {
    const own  = _transformer?.nodes() || [];
    const peer = getLayerSelection('header');
    let sel  = [...own, ...peer];
    // Interface drag → carry its bonded shapes along (move as ONE). They ride
    // the same multi-drag delta below.
    if (node.getAttr('isInterface')) {
      const bonded = _attachedShapesOf(node);
      if (bonded.length) sel = [...new Set([...sel, node, ...bonded])];
    }
    // P7-C-2: ALWAYS snapshot drag-start positions, even for single-node
    // drags — that snapshot is what dragend uses to push a "Move N
    // item(s)" undo entry. Multi-drag delta logic (in dragmove) still
    // gates on sel.length > 1.
    const draggedSet = sel.length ? sel : [node];
    _multiDragStarts = new Map();
    for (const n of draggedSet) _multiDragStarts.set(n, { x: n.x(), y: n.y() });
  });
  node.on('dragmove', () => {
    if (!_multiDragStarts || _multiDragStarts.size <= 1) return;   // single-node = let Konva drag normally
    const start = _multiDragStarts.get(node);
    if (!start) return;
    const dx = node.x() - start.x;
    const dy = node.y() - start.y;
    for (const n of _multiDragStarts.keys()) {
      if (n === node) continue;
      const s = _multiDragStarts.get(n);
      n.x(s.x + dx);
      n.y(s.y + dy);
    }
    // Both layers may need a redraw — header peer nodes live on a
    // different Konva.Layer and won't auto-redraw from _layer.batchDraw().
    _layer.batchDraw();
    _multiDragStarts.peerLayer ??= [..._multiDragStarts.keys()].find(n => n !== node && n.getLayer && n.getLayer() !== _layer)?.getLayer();
    _multiDragStarts.peerLayer?.batchDraw?.();
  });
  node.on('dragend', () => {
    const beforeMap = _multiDragStarts;
    _multiDragStarts = null;
    if (!beforeMap) return;
    // Cross-layer header persistence (header peers don't fire their
    // own dragend since we moved them via x()/y() in dragmove).
    for (const n of beforeMap.keys()) {
      if (n !== node) persistNodeIfHeader(n);
    }
    // P7-C-2: push a "Move" undo entry for ALL nodes that ended up
    // somewhere different from where they started. Single-node and
    // multi-node drags both go through this path.
    const before = [...beforeMap.entries()].map(([n, p]) => ({ n, x: p.x, y: p.y }));
    const after  = before.map(b => ({ n: b.n, x: b.n.x(), y: b.n.y() }));
    const moved  = before.some((b, i) => b.x !== after[i].x || b.y !== after[i].y);
    if (moved) {
      const label = before.length > 1 ? `Move ${before.length} items` : 'Move';
      undoManager.push(label,
        () => _restoreNodePositions(before),
        () => _restoreNodePositions(after),
      );
    }
  });

  // Interface attachment: while dragging a SHAPE (not an interface), blink the
  // interface under the pointer; on release, bond to it if released OVER one,
  // else unbond. The mouse-release position is what decides (per spec).
  node.on('dragmove', () => {
    if (node.getAttr('isInterface')) return;           // moving an interface, not a shape
    _blinkInterface(_ifaceUnderPoint(_stage.getPointerPosition()));
  });
  node.on('dragend', () => {
    if (node.getAttr('isInterface')) return;           // interface move handled above
    const pt = _stage.getPointerPosition() || _rectCenter(node);
    const iface = _ifaceUnderPoint(pt);
    _clearInterfaceBlink();
    if (iface) {
      node.setAttr('attachedTo', _ensureIfaceId(iface));
      _captureBondPct(node, iface);          // remember bbox as % of the interface
    } else {
      node.setAttr('attachedTo', null);
      node.setAttr('bondPct', null);
    }
    _scheduleSave();
  });

  // Interface scale → re-place/re-size its bonded shapes from their % (live and
  // on release). When a BONDED SHAPE is itself resized/moved, re-capture its %.
  node.on('transform', () => {
    if (node.getAttr('isInterface')) { syncBondedShapes(node); return; }
    if (node.getAttr('isZoom')) {
      // Live viewport: bake the transformer's scale into width/height EACH frame
      // and re-crop, so dragging a handle shows MORE/LESS of the source in real
      // time (constant density) instead of stretching until release. Same
      // resize-not-scale trick Konva's text-resize example uses.
      const sx = node.scaleX(), sy = node.scaleY();
      if (sx !== 1 || sy !== 1) {
        node.width(node.width() * sx);
        node.height(node.height() * sy);
        node.scaleX(1); node.scaleY(1);
      }
      _recomputeZoomCrop(node);
    }
  });
  node.on('transformend', () => {
    if (node.getAttr('isInterface')) { syncBondedShapes(node); return; }
    const iface = _interfaceOf(node);
    if (iface) { _captureBondPct(node, iface); _scheduleSave(); }
  });

  // P7-C-2: snapshot ALL transformer-tracked nodes' geometry on
  // transformstart so transformend can push an undo entry covering
  // the whole resize/rotate gesture (multi-node transforms move
  // everything in the transformer). Like dragstart, only the grabbed
  // node fires transformstart — but the transformer drives all its
  // tracked nodes' attrs, so capturing the lot here is correct.
  let _xformSnapBefore = null;
  node.on('transformstart', () => {
    const tracked = _transformer?.nodes() || [node];
    _xformSnapBefore = tracked.map(n => _snapNodeGeom(n));
    // Zoom: pin the source image in space for the whole gesture. The anchor is
    // the SCREEN position of image-pixel (0,0); holding it constant means any
    // handle reveals/hides image on its side instead of sliding it. Transient
    // (plain prop, not a Konva attr) so it never serialises.
    for (const n of tracked) {
      if (n.getAttr('isZoom')) {
        const c  = n.crop() || { x: 0, y: 0 };
        const Dx = n.getAttr('zoomDensityX') || 1, Dy = n.getAttr('zoomDensityY') || 1;
        n._zoomAnchor = { x: n.x() - c.x * Dx, y: n.y() - c.y * Dy };
      }
    }
  });

  // LIVE resize during edit — when the user drags a transform anchor on a
  // text box that's currently being edited, the contenteditable resizes
  // in real time so the user sees text reflow instead of a stretched
  // raster (the editor is HTML, the raster only comes back on click-out).
  node.on('transform', () => {
    const editing = _activeTextEditor && _activeTextEditor.node === node;
    if (!editing) return;
    const div = _activeTextEditor.div;
    // Width-only resize for text boxes — height is content-driven, the
    // editable's natural height grows / shrinks as the wrap reflows.
    // We deliberately don't set a min-height here so the user sees real
    // height feedback while dragging.
    //
    // Editor lives in canonical-pixel space and is rendered down via
    // transform: scale(sfScale). node.width() * node.scaleX() during a
    // resize gesture gives the effective canonical width (Konva sets
    // scaleX != 1 mid-drag, flattens to width on transformend).
    const w = node.width() * node.scaleX();
    div.style.width = `${Math.max(20, Math.round(w))}px`;
    div.style.minHeight = '0px';
    // Editor follows the node's anchored corner during left-side drags.
    // getAbsolutePosition is already in viewport coords (stage scale +
    // position applied), so it pairs cleanly with the editor's
    // transform-origin: 0 0.
    const containerRect = _container.getBoundingClientRect();
    const pos = node.getAbsolutePosition();
    div.style.left = `${Math.round(containerRect.left + pos.x)}px`;
    div.style.top  = `${Math.round(containerRect.top  + pos.y)}px`;
  });

  // Flatten Konva's scaleX/scaleY into width/height on transformend so
  // toJSON round-trips a clean rect (and so future Resets compare against
  // a single source of truth instead of "width × scale").
  node.on('transformend', () => {
    const sx = node.scaleX();
    const sy = node.scaleY();
    if (sx !== 1 || sy !== 1) {
      node.width(node.width() * sx);
      node.height(node.height() * sy);
      node.scaleX(1);
      node.scaleY(1);
    }
    // Zoom: resize is a viewport — re-crop at constant density (never stretch).
    // Then release the pin so non-resize recomputes keep the source origin.
    if (node.getAttr('isZoom')) { _recomputeZoomCrop(node); node._zoomAnchor = null; }
    const editing = _activeTextEditor && _activeTextEditor.node === node;
    if (editing) {
      // In edit mode the editor IS the source of truth — sync its width
      // (height is content-driven, so we leave min-height at 0).
      const div = _activeTextEditor.div;
      div.style.width     = `${Math.max(20, Math.round(node.width()))}px`;
      div.style.minHeight = '0px';
    } else if (node.getClassName() === 'Image' && node.getAttr('textHtml')) {
      // Selection-only state: not currently expected (we removed text-box
      // anchors outside of edit mode), but if anything ever reaches here
      // we still want the raster to reflow rather than stay stretched.
      _reflowTextBox(node);
    }

    // P7-C-2: push a "Resize" undo entry covering every transformer
    // node, captured before the gesture started. Restore writes back
    // x/y/width/height + scale + rotation; for textboxes we also call
    // _reflowTextBox so the raster matches the restored geometry.
    if (_xformSnapBefore) {
      const before = _xformSnapBefore;
      _xformSnapBefore = null;
      const after = before.map(b => _snapNodeGeom(b.n));
      const changed = before.some((b, i) =>
        b.x !== after[i].x || b.y !== after[i].y ||
        b.width !== after[i].width || b.height !== after[i].height ||
        b.scaleX !== after[i].scaleX || b.scaleY !== after[i].scaleY ||
        b.rotation !== after[i].rotation,
      );
      if (changed) {
        const label = before.length > 1 ? `Resize ${before.length} items` : 'Resize';
        undoManager.push(label,
          () => _restoreNodeGeom(before),
          () => _restoreNodeGeom(after),
        );
      }
    }

    _scheduleSave();
  });
  node.on('dragend', _scheduleSave);
  // Right-click → context menu with Reset Size + Delete.
  node.on('contextmenu', (e) => {
    e.evt?.preventDefault();
    e.cancelBubble = true;
    _setSelection(node);
    const ev = e.evt;
    _showOverlayContextMenu(node, ev?.clientX ?? 0, ev?.clientY ?? 0);
  });
  if (node.getClassName() === 'Text') node.on('dblclick', () => _editText(node));
  // Any Konva.Image tagged as a user text box opens the in-place editor —
  // BUT only when this node is the sole selection. Editing one item of a
  // multi-selection produced flickery height changes (the editable mounts
  // at the node's geometry, but other selected nodes were getting their
  // bbox refreshed too). Cleanest fix: dblclick while multi-selected does
  // nothing; user has to click out of the group first, then dblclick.
  if (node.getClassName() === 'Image' && node.getAttr('textHtml')) {
    node.on('dblclick', () => {
      const sel = _transformer?.nodes() || [];
      if (sel.length > 1) return;
      _enterTextEdit(node);
    });
  }
}

// ─── Overlay clipboard (in-memory, persists across step changes) ───────────
//
// A simple module-scoped buffer. Holds an array of node specs (one per
// copied node) plus the position they were copied FROM, so paste-in-place
// can drop them at the original coordinates regardless of which step is
// active when the paste happens.
//
// Format mirrors the spec shape used by _recreateNode:
//   { className, attrs }
// ATTR LIST: x, y, width, height, src, textHtml, textWidth, naturalW,
//            naturalH, fillColor, styleId, scaleX, scaleY, rotation
// (image is intentionally NOT serialised — Konva can't round-trip an
//  HTMLImageElement; we re-load from `src` or re-rasterise from textHtml.)
let _overlayClipboard = null;

function _serializeNode(node) {
  if (!node) return null;
  const a = node.attrs || {};
  const out = {
    className: node.getClassName(),
    attrs: {
      x:        a.x ?? 0,
      y:        a.y ?? 0,
      width:    a.width,
      height:   a.height,
      scaleX:   a.scaleX ?? 1,
      scaleY:   a.scaleY ?? 1,
      rotation: a.rotation ?? 0,
    },
  };
  // Inline payload — only the fields _recreateNode looks at.
  for (const k of [
    'src', 'textHtml', 'textWidth', 'naturalW', 'naturalH', 'fillColor', 'styleId',
    'constId',   // 📌 V0.3.2.98 — membership in a constant-text-box definition
    // Shape primitives — Konva.Rect / Circle / Ellipse / Path / etc.
    'name', 'kind',
    'fill', 'stroke', 'strokeWidth', 'opacity', 'cornerRadius',
    'radius', 'radiusX', 'radiusY', 'sides', 'data',
    // Line/Arrow geometry (V0.3.2.30) — omitting these was why a pasted
    // arrow lost its tail (points defaulted to [] and could never grow back).
    'points', 'pointerLength', 'pointerWidth',
    // Zoom-crop geometry (V0.3.2.58) — omitting these made a pasted zoom lose
    // its crop, so Konva scaled the WHOLE interface image into the small frame
    // instead of showing the cropped region. cropX/Y/W/H are Konva's crop;
    // isZoom + density + bond fields keep it a functioning interface zoom.
    'cropX', 'cropY', 'cropWidth', 'cropHeight',
    'isZoom', 'zoomDensityX', 'zoomDensityY', 'zoomMult', 'zoomIfaceId',
    'attachedTo', 'bondPct',
    // 🎬 Video (V0.3.2.75) — the file itself is NEVER inlined: only a path
    // (project-relative when the clip lives inside the project folder), the
    // trim window, the mute state, and a small poster frame so the node has
    // something to draw before the file loads (or if it's gone missing).
    'isVideo', 'videoId', 'videoPath', 'videoRel', 'videoDurationMs',
    'trimInMs', 'trimOutMs', 'muted', 'volume', 'posterSrc', 'posterAtMs',
  ]) {
    if (a[k] != null) out.attrs[k] = Array.isArray(a[k]) ? a[k].slice()
                                    : (a[k] && typeof a[k] === 'object' ? { ...a[k] } : a[k]);
  }
  return out;
}

// ─── P7-C-2: drag / resize geometry snapshots ──────────────────────────────

function _snapNodeGeom(node) {
  const snap = {
    n:        node,
    x:        node.x(),
    y:        node.y(),
    width:    node.width(),
    height:   node.height(),
    scaleX:   node.scaleX(),
    scaleY:   node.scaleY(),
    rotation: node.rotation(),
  };
  // Zoom: crop + density aren't derivable from geometry — snapshot them so an
  // undone resize restores the exact viewport (bondPct is re-derived instead).
  if (node.getAttr('isZoom')) {
    const c = node.crop();
    if (c) snap.crop = { x: c.x, y: c.y, width: c.width, height: c.height };
    snap.zoomDensityX = node.getAttr('zoomDensityX');
    snap.zoomDensityY = node.getAttr('zoomDensityY');
    snap.zoomMult     = node.getAttr('zoomMult');
  }
  return snap;
}

/** After an undo/redo restores node geometry, re-derive each bonded shape's
 *  bondPct from its restored geometry. bondPct is a cache of (shape vs interface)
 *  bbox — restoring geometry without it would leave the undo:applied re-fit
 *  pulling the shape from a stale %. */
function _reconcileBondAfterRestore(nodes) {
  for (const n of nodes) {
    if (!n || n.isDestroyed?.()) continue;
    const iface = _interfaceOf(n);
    if (iface) _captureBondPct(n, iface);
  }
}

/**
 * Restore positions only — used by drag undo. We don't touch w/h/scale/
 * rotation here because pure drag never changed those. Returns false
 * if every tracked node has been destroyed (step nav etc.) so
 * undoManager can drop the dead entry.
 */
function _restoreNodePositions(snaps) {
  let any = false;
  let peerLayer = null;
  for (const s of snaps) {
    if (!s.n || s.n.isDestroyed?.()) continue;
    any = true;
    s.n.x(s.x);
    s.n.y(s.y);
    if (s.n.getLayer && s.n.getLayer() !== _layer) peerLayer = s.n.getLayer();
  }
  _reconcileBondAfterRestore(snaps.map(s => s.n));
  _layer.batchDraw();
  peerLayer?.batchDraw?.();
  // Header peers also need their state.headerItems entry resynced.
  for (const s of snaps) {
    if (s.n && !s.n.isDestroyed?.()) persistNodeIfHeader(s.n);
  }
  _scheduleSave();
  return any ? undefined : false;
}

/**
 * Restore full geometry — used by resize/rotate undo. Reflows text
 * boxes after restore so the raster matches the restored size.
 */
async function _restoreNodeGeom(snaps) {
  let any = false;
  for (const s of snaps) {
    if (!s.n || s.n.isDestroyed?.()) continue;
    any = true;
    s.n.x(s.x);
    s.n.y(s.y);
    s.n.width(s.width);
    s.n.height(s.height);
    s.n.scaleX(s.scaleX);
    s.n.scaleY(s.scaleY);
    s.n.rotation(s.rotation);
    if (s.n.getAttr('isZoom')) {
      if (s.crop) s.n.crop({ ...s.crop });
      if (s.zoomDensityX != null) s.n.setAttr('zoomDensityX', s.zoomDensityX);
      if (s.zoomDensityY != null) s.n.setAttr('zoomDensityY', s.zoomDensityY);
      if (s.zoomMult     != null) s.n.setAttr('zoomMult',     s.zoomMult);
    }
    if (s.n.getClassName() === 'Image' && s.n.getAttr('textHtml')) {
      await _reflowTextBox(s.n);
    }
  }
  _reconcileBondAfterRestore(snaps.map(s => s.n));
  _layer.batchDraw();
  _scheduleSave();
  return any ? undefined : false;
}

// ─── P7-C-1: structural undo helpers ───────────────────────────────────────
//
// Add / paste / duplicate / delete each push ONE undoManager entry that
// (un-)does its action without leaning on the now-destroyed node
// reference. Konva nodes can't be revived after destroy(), so undo
// re-creates from the serialised spec; the closure tracks the live
// node ref to point at the freshly-created one for chained undo / redo.
//
// All three helpers share one principle: when a node we expect to
// destroy is already gone (step navigation, project reload, etc.),
// return false so undoManager skips the dead entry instead of
// stalling.

function _pushAddNodeUndo(node, label) {
  const spec = _serializeNode(node);
  if (!spec) return;
  let nodeRef = node;
  undoManager.push(label,
    () => {
      if (!nodeRef || nodeRef.isDestroyed?.()) return false;
      nodeRef.destroy();
      _setSelection(null);
      _layer.batchDraw();
      _scheduleSave();
    },
    async () => {
      const fresh = await _recreateNode(spec);
      if (!fresh) return;
      _layer.add(fresh);
      _attachNode(fresh);
      _setSelection(fresh);
      nodeRef = fresh;
      _layer.batchDraw();
      _scheduleSave();
    },
  );
}

function _pushAddNodesUndo(nodes, specs, label) {
  if (!nodes?.length || !specs?.length) return;
  let nodeRefs = [...nodes];
  undoManager.push(label,
    () => {
      let any = false;
      for (const n of nodeRefs) {
        if (n && !n.isDestroyed?.()) { n.destroy(); any = true; }
      }
      _setSelection(null);
      _layer.batchDraw();
      _scheduleSave();
      return any ? undefined : false;
    },
    async () => {
      const fresh = [];
      for (const spec of specs) {
        const n = await _recreateNode(spec);
        if (!n) continue;
        _layer.add(n);
        _attachNode(n);
        fresh.push(n);
      }
      nodeRefs = fresh;
      _transformer.nodes(fresh);
      _configTransformerForNodes(fresh);
      _layer.batchDraw();
      _scheduleSave();
    },
  );
}

/**
 * Push an undo entry for a destructive delete. Each entry carries
 *   { spec, zIndex }
 * so the undo (re-add) restores the layer order the user had at the
 * moment of deletion. zIndex is clamped against the layer's current
 * size in case other nodes were added/removed between delete and undo.
 */
function _pushDeleteNodesUndo(entries, label) {
  if (!entries?.length) return;
  let nodeRefs = [];
  undoManager.push(label,
    async () => {
      // Undo the delete = re-create the nodes from spec, then restore
      // each one's z-index so the relative layer order returns to what
      // the user had at delete time.
      const fresh = [];
      // Re-add all first — setting zIndex during the loop can collide
      // because Konva renumbers the parent's children when a child's
      // zIndex changes.
      for (const e of entries) {
        const n = await _recreateNode(e.spec);
        if (!n) continue;
        _layer.add(n);
        _attachNode(n);
        fresh.push({ node: n, zIndex: e.zIndex });
      }
      // Restore z-indices in ascending order so each node lands at the
      // intended slot without disturbing the rest. Clamp against the
      // current layer size — the original index may be out of range
      // (other nodes added/removed in the meantime).
      fresh.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
      const total = _layer.getChildren().length;
      for (const f of fresh) {
        if (Number.isFinite(f.zIndex)) {
          const clamped = Math.max(0, Math.min(total - 1, f.zIndex));
          f.node.zIndex(clamped);
        }
      }
      nodeRefs = fresh.map(f => f.node);
      _layer.batchDraw();
      _scheduleSave();
    },
    () => {
      // Redo the delete = destroy the (re-created) nodes again.
      for (const n of nodeRefs) {
        if (n && !n.isDestroyed?.()) n.destroy();
      }
      _setSelection(null);
      _layer.batchDraw();
      _scheduleSave();
    },
  );
}

/**
 * Right-click → Copy. Snapshots every selected overlay node into the
 * module clipboard along with their captured x/y for paste-in-place.
 */
function _copyToOverlayClipboard() {
  const sel = _transformer?.nodes() || [];
  if (!sel.length) return false;
  // Sort by zIndex (ascending — bottom first) so paste re-creates in the
  // SAME relative order. Otherwise a multi-select clipboard captures in
  // selection order (newest-clicked last), and paste shuffles z-order.
  const sorted = [...sel].sort((a, b) => (a.zIndex?.() ?? 0) - (b.zIndex?.() ?? 0));
  _overlayClipboard = sorted.map(n => ({
    spec:        _serializeNode(n),
    capturedAt:  { x: n.x() ?? 0, y: n.y() ?? 0 },
  })).filter(e => e.spec);
  return _overlayClipboard.length > 0;
}

/**
 * Paste from clipboard. With `inPlace:false` the new nodes drop near
 * their original position offset slightly so duplicates don't perfectly
 * overlap; with `inPlace:true` they land exactly where the original
 * was when copied — even across steps, since we stored the captured
 * x/y per-node.
 *
 * Async because _recreateNode now awaits the textbox raster (the load
 * path needed it to avoid a 0×0 race). Paste / Duplicate callers can
 * fire-and-forget — we return a Promise<boolean> for completeness.
 */
async function _pasteFromOverlayClipboard(opts = {}) {
  if (!_overlayClipboard?.length) return false;
  const { inPlace = false, offset = 20 } = opts;
  const newNodes = [];
  // P7-C-1: capture each fresh node's POST-positioning spec so undo
  // can both destroy them AND redo can recreate at the same spot.
  // _serializeNode after we've set x/y picks up the offset / inPlace
  // positioning the user actually saw.
  const newSpecs = [];
  for (const entry of _overlayClipboard) {
    const node = await _recreateNode(entry.spec);
    if (!node) continue;
    if (inPlace) {
      node.x(entry.capturedAt.x);
      node.y(entry.capturedAt.y);
    } else {
      node.x((entry.capturedAt.x ?? 0) + offset);
      node.y((entry.capturedAt.y ?? 0) + offset);
    }
    _layer.add(node);
    _attachNode(node);
    newNodes.push(node);
    newSpecs.push(_serializeNode(node));
  }
  if (!newNodes.length) return false;

  // Replace selection with the freshly-pasted nodes.
  _transformer.nodes(newNodes);
  _configTransformerForNodes(newNodes);
  _layer.batchDraw();
  _uiLayer.batchDraw();
  const label = opts.label || `Paste ${newSpecs.length} item${newSpecs.length > 1 ? 's' : ''}`;
  _pushAddNodesUndo(newNodes, newSpecs, label);
  _scheduleSave();
  return true;
}

/** Duplicate = copy current selection then immediately paste with a small offset. */
async function _duplicateSelected() {
  if (!_copyToOverlayClipboard()) return false;
  return _pasteFromOverlayClipboard({ inPlace: false, offset: 20, label: 'Duplicate' });
}

/**
 * Right-click on the empty viewport — only paste actions make sense
 * here (no selection to copy, no node to duplicate). Disabled when
 * the clipboard is empty so the menu still shows the user what's
 * available, just greyed out.
 */
function _showEmptyViewportContextMenu(x, y) {
  const hasClipboard = !!_overlayClipboard?.length;
  showContextMenu([
    { label: '📥 Paste',           disabled: !hasClipboard, action: () => _pasteFromOverlayClipboard({ inPlace: false }) },
    { label: '📥 Paste in place',  disabled: !hasClipboard, action: () => _pasteFromOverlayClipboard({ inPlace: true })  },
  ], x, y);
}

/** Live interface overlay nodes in the current step (Konva name 'interface'). */
export function getInterfaceNodes() {
  return _layer ? _layer.find('.interface') : [];
}

// ── Interface attachment (bonded shapes) ────────────────────────────────────
// A shape "bonds" to an interface when the mouse releases OVER it. The bond is a
// stable id pair (ifaceId on the interface, attachedTo on the shape) — NO
// reparenting (so no scale refactor) — and moving the interface carries its
// bonded shapes along via the existing multi-drag delta.
let _ifaceIdSeq = 0;
function _ensureIfaceId(node) {
  let id = node.getAttr('ifaceId');
  if (!id) { id = 'iface_' + Date.now().toString(36) + '_' + (_ifaceIdSeq++); node.setAttr('ifaceId', id); }
  return id;
}
/** Interface whose bounding box contains stage point pt, or null. */
function _ifaceUnderPoint(pt) {
  if (!pt) return null;
  for (const n of getInterfaceNodes()) {
    const r = n.getClientRect();
    if (pt.x >= r.x && pt.x <= r.x + r.width && pt.y >= r.y && pt.y <= r.y + r.height) return n;
  }
  return null;
}
/** Shapes bonded to this interface (attachedTo === its ifaceId). */
function _attachedShapesOf(ifaceNode) {
  const id = ifaceNode?.getAttr('ifaceId');
  if (!id || !_layer) return [];
  return _layer.getChildren(n => n.getAttr && n.getAttr('attachedTo') === id);
}
function _rectCenter(node) {
  const r = node.getClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** The interface a bonded shape belongs to (attachedTo === ifaceId), or null. */
function _interfaceOf(shape) {
  const id = shape?.getAttr?.('attachedTo');
  if (!id) return null;
  return getInterfaceNodes().find(n => n.getAttr('ifaceId') === id) || null;
}

/** Record a bonded shape's bbox as PERCENTAGES of its interface's bbox (the
 *  source of truth used to re-place + re-size it whenever the interface scales).
 *  Interface = 100% × 100%; we store the shape's top-left + bottom-right as
 *  fractions {l,t,r,b}. */
function _captureBondPct(shape, ifaceNode) {
  if (!shape || !ifaceNode) return;
  const IB = ifaceNode.getClientRect({ relativeTo: _layer });
  const SB = shape.getClientRect({ relativeTo: _layer });
  if (!IB.width || !IB.height) return;
  shape.setAttr('bondPct', {
    l: (SB.x - IB.x) / IB.width,
    t: (SB.y - IB.y) / IB.height,
    r: (SB.x + SB.width  - IB.x) / IB.width,
    b: (SB.y + SB.height - IB.y) / IB.height,
  });
}

/** Fit a shape's bounding box to `box` (layer coords) via scale + reposition.
 *  Generic across shape types. (Stroke scales proportionally too — fine for now,
 *  per spec.) */
function _fitShapeToBox(shape, box) {
  if (shape.getAttr('isZoom')) {
    // Interface-driven scaling of a ZOOM: scale the FRAME to the box and let the
    // magnified content grow with it — the source region (crop) is unchanged, so
    // magnification stays constant RELATIVE to the interface. Then re-derive the
    // density so a later MANUAL resize (the viewport/crop path) measures from the
    // current size. (Manual resize keeps density + re-crops; this keeps crop +
    // re-densities — the two paths are duals.)
    if (box.width > 0 && box.height > 0) {
      shape.scaleX(1); shape.scaleY(1);
      shape.width(box.width);
      shape.height(box.height);
      shape.position({ x: box.x, y: box.y });
      const crop = shape.crop();
      if (crop?.width)  shape.setAttr('zoomDensityX', box.width  / crop.width);
      if (crop?.height) shape.setAttr('zoomDensityY', box.height / crop.height);
    }
    return;
  }
  const cur = shape.getClientRect({ relativeTo: _layer });
  if (cur.width > 0 && cur.height > 0 && box.width > 0 && box.height > 0) {
    shape.scaleX(shape.scaleX() * (box.width  / cur.width));
    shape.scaleY(shape.scaleY() * (box.height / cur.height));
  }
  const after = shape.getClientRect({ relativeTo: _layer });
  shape.x(shape.x() + (box.x - after.x));
  shape.y(shape.y() + (box.y - after.y));
}

/** Re-place + re-size every bonded shape from its stored % against the
 *  interface's CURRENT bbox. Called on interface scale + default/reset. */
export function syncBondedShapes(ifaceNode) {
  if (!ifaceNode) return;
  const IB = ifaceNode.getClientRect({ relativeTo: _layer });
  if (!IB.width || !IB.height) return;
  for (const s of _attachedShapesOf(ifaceNode)) {
    const p = s.getAttr('bondPct');
    if (!p) continue;
    _fitShapeToBox(s, {
      x: IB.x + p.l * IB.width,
      y: IB.y + p.t * IB.height,
      width:  (p.r - p.l) * IB.width,
      height: (p.b - p.t) * IB.height,
    });
  }
  _layer.batchDraw();
}

// ─── Interface ZOOM (Z1) ────────────────────────────────────────────────────
// A zoom is a magnified CROP of an interface's image, living as its own free
// element. Created by drawing a rectangle over an interface: that region becomes
// a 2× clip you can move/delete like any node. KEY: resizing a zoom is a
// VIEWPORT, not a stretch — the pixel density (zoomDensityX/Y = display-px per
// natural-px) is held constant, so a bigger frame shows MORE of the source
// (re-crops), never blows up the pixels. The zoom carries its own `src`+`crop`
// so it round-trips on save and never auto-updates with the interface's image.
let _zoomDraw = null;   // { iface, active, start:{x,y}, rect } while drawing

/** Live zoom clips on the active layer. */
function _zoomNodes() { return _layer ? _layer.getChildren(n => n.getAttr('isZoom')) : []; }

/** Right-click interface → Add zoom: arm the next press-drag-release to define
 *  the zoom region over this interface. */
export function startZoomDraw(ifaceNode) {
  if (!ifaceNode || !_layer) return;
  _setSelection(null);
  _cancelZoomDraw();
  // Freeze dragging on existing nodes so pressing on the interface DRAWS the box
  // instead of moving the interface. Restored in _cancelZoomDraw.
  const dragState = _layer.getChildren().map(n => [n, n.draggable()]);
  for (const [n] of dragState) n.draggable(false);
  _zoomDraw = { iface: ifaceNode, active: false, start: null, rect: null, dragState };
  if (_container) _container.style.cursor = 'crosshair';
  setStatus('Draw a box over the interface to zoom that region.', 'info', 4000);
}

function _cancelZoomDraw() {
  if (_zoomDraw?.rect) { _zoomDraw.rect.destroy(); _uiLayer?.batchDraw(); }
  if (_zoomDraw?.dragState) {
    for (const [n, d] of _zoomDraw.dragState) { if (!n.isDestroyed?.()) n.draggable(d); }
  }
  _zoomDraw = null;
  if (_container) _container.style.cursor = '';
}

function _zoomDrawStart() {
  const p = _layer.getRelativePointerPosition();
  if (!p) return;
  _zoomDraw.active = true;
  _zoomDraw.start  = { x: p.x, y: p.y };
  _zoomDraw.rect   = new Konva.Rect({
    x: p.x, y: p.y, width: 0, height: 0,
    stroke: '#22d3ee', strokeWidth: 1.5, dash: [6, 4],
    fill: 'rgba(34,211,238,0.12)', listening: false,
  });
  _uiLayer.add(_zoomDraw.rect);
  _uiLayer.batchDraw();
}

function _zoomDrawMove() {
  const p = _layer.getRelativePointerPosition();
  if (!p || !_zoomDraw?.rect) return;
  const s = _zoomDraw.start;
  _zoomDraw.rect.setAttrs({
    x: Math.min(s.x, p.x), y: Math.min(s.y, p.y),
    width:  Math.abs(p.x - s.x), height: Math.abs(p.y - s.y),
  });
  _uiLayer.batchDraw();
}

function _zoomDrawEnd() {
  const iface = _zoomDraw?.iface;
  const r = _zoomDraw?.rect;
  const R = r ? { x: r.x(), y: r.y(), width: r.width(), height: r.height() } : null;
  _cancelZoomDraw();
  if (!iface || !R || R.width < 6 || R.height < 6) {
    setStatus?.('Zoom cancelled — draw a larger box.', 'warn', 2500);
    return;
  }
  _createZoomFromRegion(iface, R);
}

/** Build a zoom element from a drawn region R (layer coords) over `iface`. */
function _createZoomFromRegion(iface, R) {
  const img = iface.image?.();
  if (!img) return;
  const IB = iface.getClientRect({ relativeTo: _layer });
  if (!IB.width || !IB.height) return;
  const natW = iface.getAttr('naturalW') || img.naturalWidth  || img.width  || IB.width;
  const natH = iface.getAttr('naturalH') || img.naturalHeight || img.height || IB.height;
  // Clamp the drawn region to the interface bounds — can't zoom outside the image.
  const x0 = Math.max(R.x, IB.x), y0 = Math.max(R.y, IB.y);
  const x1 = Math.min(R.x + R.width,  IB.x + IB.width);
  const y1 = Math.min(R.y + R.height, IB.y + IB.height);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw < 4 || rh < 4) return;
  const M = 2;   // default magnification (multiplier slice comes next)
  const crop = {
    x: (x0 - IB.x) / IB.width  * natW,
    y: (y0 - IB.y) / IB.height * natH,
    width:  rw / IB.width  * natW,
    height: rh / IB.height * natH,
  };
  const frameW = rw * M, frameH = rh * M;
  const zoom = new Konva.Image({
    image: img,
    crop,
    x: x0 + rw / 2 - frameW / 2,    // expand from the drawn region's centre
    y: y0 + rh / 2 - frameH / 2,
    width: frameW, height: frameH,
    draggable: true,
    name: 'userImage',
  });
  zoom.setAttr('isZoom', true);
  zoom.setAttr('zoomMult', M);
  zoom.setAttr('zoomDensityX', frameW / crop.width);   // display-px per natural-px, held on resize
  zoom.setAttr('zoomDensityY', frameH / crop.height);
  zoom.setAttr('zoomIfaceId', _ensureIfaceId(iface));  // for a future "Update image"
  zoom.setAttr('src', iface.getAttr('src'));           // self-contained on reload
  // Bonded to its source interface by DEFAULT — follows + scales with it like
  // any bonded shape (same mechanic: drag it out to unbond, back in to re-bond).
  zoom.setAttr('attachedTo', _ensureIfaceId(iface));
  _layer.add(zoom);
  _attachNode(zoom);
  _captureBondPct(zoom, iface);                        // needs the node on the layer (bbox)
  _setSelection(zoom);
  _layer.batchDraw();
  _scheduleSave();
}

/** Resize = viewport, not stretch. Recompute the crop from frame ÷ density at
 *  constant pixel density.
 *  - During a MANUAL resize (anchor set): the image is pinned in space, so each
 *    handle reveals/hides image on its side rather than sliding it. The frame is
 *    clamped to the image's on-screen rect so we never crop past an edge.
 *  - Otherwise (programmatic / undo): keep the source origin, just resize the
 *    window from the top-left. */
function _recomputeZoomCrop(node) {
  const Dx = node.getAttr('zoomDensityX'), Dy = node.getAttr('zoomDensityY');
  if (!Dx || !Dy) return;
  const img  = node.image?.();
  const natW = img?.naturalWidth  || img?.width  || Infinity;
  const natH = img?.naturalHeight || img?.height || Infinity;
  const IA = node._zoomAnchor;
  if (IA) {
    // Image pinned: IA = screen pos of image-pixel (0,0). Clamp the frame to the
    // image's screen rect [IA, IA + nat·D]; crop = (frame − IA) ÷ D.
    let fx = node.x(), fy = node.y(), fw = node.width(), fh = node.height();
    const imgRight  = IA.x + (Number.isFinite(natW) ? natW * Dx : Infinity);
    const imgBottom = IA.y + (Number.isFinite(natH) ? natH * Dy : Infinity);
    if (fx < IA.x) { fw -= (IA.x - fx); fx = IA.x; }
    if (fy < IA.y) { fh -= (IA.y - fy); fy = IA.y; }
    if (fx + fw > imgRight)  fw = imgRight  - fx;
    if (fy + fh > imgBottom) fh = imgBottom - fy;
    fw = Math.max(1, fw); fh = Math.max(1, fh);
    node.x(fx); node.y(fy); node.width(fw); node.height(fh);
    node.crop({ x: (fx - IA.x) / Dx, y: (fy - IA.y) / Dy, width: fw / Dx, height: fh / Dy });
  } else {
    const crop = node.crop() || { x: 0, y: 0, width: 0, height: 0 };
    let cw = node.width()  / Dx;
    let ch = node.height() / Dy;
    const cwMax = natW - crop.x, chMax = natH - crop.y;
    if (cw > cwMax) { cw = cwMax; node.width(cw * Dx); }
    if (ch > chMax) { ch = chMax; node.height(ch * Dy); }
    node.crop({ x: crop.x, y: crop.y, width: cw, height: ch });
  }
  node.getLayer()?.batchDraw();
}

/** Set a zoom's magnification. The FRAME stays put (manual resize already owns
 *  window size); the multiplier tightens/widens the source region about its
 *  centre — higher × = tighter crop = more magnified. Self-contained (no
 *  interface needed), and the magnification is preserved under interface scaling
 *  because density is re-derived from frame ÷ crop. Undoable. */
export function setZoomMultiplier(node, newM) {
  if (!node?.getAttr('isZoom') || !(newM > 0)) return;
  const before = [_snapNodeGeom(node)];
  _applyZoomMultiplier(node, newM);
  const after = [_snapNodeGeom(node)];
  undoManager.push('Zoom level',
    () => _restoreNodeGeom(before),
    () => _restoreNodeGeom(after),
  );
  _scheduleSave();
}

function _applyZoomMultiplier(node, newM) {
  const oldM = node.getAttr('zoomMult') || 2;
  const k = newM / oldM;
  if (!(k > 0)) return;
  const c = node.crop();
  if (!c?.width || !c?.height) return;
  const img  = node.image?.();
  const natW = img?.naturalWidth  || img?.width  || Infinity;
  const natH = img?.naturalHeight || img?.height || Infinity;
  // Magnification lives in the CROP (the frame is the interface box). Smaller
  // crop in the same frame = bigger. Desired crop = current / k; de-magnifying
  // (k<1) GROWS the crop. Clamp UNIFORMLY — preserve aspect, scale both axes by
  // the same factor (V0.3.2.58). The old per-axis Math.min(…,natW)/Math.min(…,
  // natH) froze the wider axis first, so de-magnifying "only shrank on Y" and
  // 1× was unreachable once one axis hit the image edge.
  let cw = c.width / k, ch = c.height / k;
  const fit = Math.min(1, natW / cw, natH / ch);   // grown crop bigger than the image → scale both down equally
  cw *= fit; ch *= fit;
  const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
  const nx = Math.max(0, Math.min(cx - cw / 2, natW - cw));
  const ny = Math.max(0, Math.min(cy - ch / 2, natH - ch));
  node.crop({ x: nx, y: ny, width: cw, height: ch });
  node.setAttr('zoomMult', newM);
  node.setAttr('zoomDensityX', node.width()  / cw);
  node.setAttr('zoomDensityY', node.height() / ch);
  node.getLayer()?.batchDraw();
}

/** Reset a zoom to 1× — de-magnify (crop grows to 1× the interface scale) and
 *  recentre the region in the image. The missing "just crop a region and move
 *  it around" state (V0.3.2.58). Own undo entry. */
function _resetZoomToNatural(node) {
  const c0 = node.crop();
  if (!c0?.width || !c0?.height) { setStatus('No crop to reset.', 'warn', 2000); return; }
  const before = [_snapNodeGeom(node)];
  _applyZoomMultiplier(node, 1);                    // → 1×, uniform-clamped
  const c = node.crop();
  const img = node.image?.();
  const natW = img?.naturalWidth || img?.width || 0, natH = img?.naturalHeight || img?.height || 0;
  if (natW && natH && c?.width) {                   // recentre the (grown) crop in the image
    node.crop({ x: Math.max(0, (natW - c.width) / 2), y: Math.max(0, (natH - c.height) / 2), width: c.width, height: c.height });
    node.getLayer()?.batchDraw();
  }
  const after = [_snapNodeGeom(node)];
  undoManager.push('Reset zoom to 1×', () => _restoreNodeGeom(before), () => _restoreNodeGeom(after));
  _scheduleSave();
}

async function _promptZoomMultiplier(node) {
  const cur = node.getAttr('zoomMult') || 2;
  const s = await promptString('Zoom multiplier (e.g. 2.5)', String(cur));
  if (s == null) return;
  const m = parseFloat(String(s).replace(/[×x]/i, '').trim());
  if (!(m > 0)) { setStatus('Enter a number greater than 0.', 'warn', 2500); return; }
  setZoomMultiplier(node, m);
}

// ─── Image-sequence playback (S2) ───────────────────────────────────────────
// During VIEW (not edit), an image with a `sequence` swaps through its frames at
// their % points across the step window, crossfading each. The window = the
// step's narration duration (or the sequence's fixed override), starting once
// the overlay is loaded (we start at _loadFromActiveStep's end = after the step
// transition). Crossfade = a clone of the node showing the next frame, faded in
// on the NON-serialized _uiLayer (so transient frames never hit the project
// file), then committed to the base node's image. The base node's `src` attr is
// never touched → the saved/reloaded overlay always shows frame 0.
let _seqPlaybacks = [];          // [{ node, frames:[{pct,img}], windowMs, startMs, currentIdx, baseOpacity, xfade, done, dead }]
let _seqToken     = 0;           // guards against a stale async start overwriting a newer one
const SEQ_CROSSFADE_MS = 220;

function _stopSequences() {
  for (const pb of _seqPlaybacks) {
    if (pb.xfade?.clone && !pb.xfade.clone.isDestroyed?.()) pb.xfade.clone.destroy();
    if (pb.node && !pb.node.isDestroyed?.() && pb.frames?.[0]?.img) {
      pb.node.image(pb.frames[0].img);                 // restore the base frame
      pb.node.opacity(pb.baseOpacity ?? 1);
    }
  }
  if (_uiLayer) for (const n of _uiLayer.getChildren(c => c.getAttr && c.getAttr('_seqClone'))) n.destroy();
  _seqPlaybacks = [];
  _layer?.batchDraw(); _uiLayer?.batchDraw();
}

/** Pop ONE playback's node back to its base (frame 0) + kill any in-flight
 *  crossfade clone. Used by the edit-preview end-revert; leaves the playback in
 *  _seqPlaybacks (marked done) so it won't replay until re-started. */
function _revertPlaybackToBase(pb) {
  if (pb.xfade?.clone && !pb.xfade.clone.isDestroyed?.()) { pb.xfade.clone.destroy(); pb.xfade = null; }
  if (pb.node && !pb.node.isDestroyed?.() && pb.frames?.[0]?.img) {
    pb.node.image(pb.frames[0].img);
    pb.node.opacity(pb.baseOpacity ?? 1);
    pb.currentIdx = 0;
  }
}

/** Diagnostic: report the active step's image-sequence state (window.sbsDiag.seq()).
 *  Shows every node carrying a sequence — whether it's an interface, its frame
 *  count/src status, and whether it's currently PLAYING. Helps tell "not working"
 *  apart: no sequence stored / <2 frames / edit-mode / not playing / frames w/o src. */
export function diagSequences() {
  if (!_layer) return { error: 'overlay layer not ready' };
  const nodes = _layer.getChildren(n => n.getAttr && n.getAttr('sequence'));
  let stepWindowMs = null;
  try { stepWindowMs = narrationContextForStep(state.get('activeStepId'))?.windowMs ?? null; } catch {}
  return {
    editing: _editing,   // sequences only animate in VIEW mode
    activePlaybacks: _seqPlaybacks.length,
    stepWindowMs,        // frame @X% swaps at X% of THIS (or overrideMs) — huge window = late swaps
    seqNodes: nodes.map(n => {
      const s = n.getAttr('sequence') || {};
      return {
        type: n.getClassName?.(),
        isInterface: !!n.getAttr('isInterface') || !!n.hasName?.('interface'),
        frames: s.frames?.length || 0,
        framesWithSrc: (s.frames || []).filter(f => f && f.src).length,
        pcts: (s.frames || []).map(f => f?.pct),   // swap-points; all 0/100 or missing = degenerate
        overrideMs: s.overrideMs ?? null,
        playing: _seqPlaybacks.some(pb => pb.node === n),
      };
    }),
  };
}

async function _startSequences() {
  const myToken = ++_seqToken;
  _stopSequences();
  if (!_layer) return;                                 // plays in VIEW and edit-preview mode
  const candidates = _layer.getChildren(n => {
    const s = n.getAttr && n.getAttr('sequence');
    return s && Array.isArray(s.frames) && s.frames.length >= 2;
  });
  if (!candidates.length) return;
  // Window = narration audible during this step (own OR group overflow), or the
  // step's display duration when there's none — same source as the editor.
  const ctx = narrationContextForStep(state.get('activeStepId'));
  const playbacks = [];
  for (const node of candidates) {
    const seq = node.getAttr('sequence');
    const windowMs = (seq.overrideMs != null ? seq.overrideMs : ctx.windowMs) || 3000;
    const frames = [];
    for (const f of seq.frames) {
      let img = null;
      if (f.src) { try { img = await _loadImage(f.src); } catch {} }
      frames.push({ pct: Number(f.pct) || 0, img });
    }
    if (myToken !== _seqToken) return;                 // superseded while preloading
    frames.sort((a, b) => a.pct - b.pct);
    if (!frames[0].img) frames[0].img = node.image();  // base fallback = node's own image
    node.image(frames[0].img);
    // startMs anchors on the FIRST tick (null now) so it shares the tick's clock —
    // wall-clock live, the synthetic export clock during render. Capturing
    // clock.now() here would desync against the export's fireSyntheticTick time.
    playbacks.push({ node, frames, windowMs, startMs: null, currentIdx: 0, baseOpacity: node.opacity(), xfade: null, done: false });
  }
  if (myToken !== _seqToken) return;
  _seqPlaybacks = playbacks;
  _layer.batchDraw();
}

function _advanceSequences(nowMs) {
  if (!_seqPlaybacks.length) return;
  let drawLayer = false, drawUi = false;
  for (const pb of _seqPlaybacks) {
    if (pb.node?.isDestroyed?.()) { pb.dead = true; continue; }
    if (pb.startMs == null) pb.startMs = nowMs;         // anchor to this tick's clock (live OR export)
    if (pb.xfade) {                                     // fade the OLD frame out over the (already-committed) new one
      const t = Math.min(1, (nowMs - pb.xfade.startMs) / SEQ_CROSSFADE_MS);
      const e = t * t * (3 - 2 * t);                   // smoothstep
      if (!pb.xfade.clone.isDestroyed?.()) pb.xfade.clone.opacity(pb.baseOpacity * (1 - e));
      drawUi = true;
      if (t >= 1) {
        if (!pb.xfade.clone.isDestroyed?.()) pb.xfade.clone.destroy();
        pb.xfade = null;
      }
      continue;                                         // one transition at a time
    }
    if (pb.done) continue;
    const frac = pb.windowMs > 0 ? (nowMs - pb.startMs) / pb.windowMs : 1;
    if (frac >= 1) {                                     // window over
      pb.done = true;
      // Edit-preview: pop back to the first-entry (base) frame at the end so
      // editing resumes from frame 0. VIEW mode holds the last frame (unchanged
      // — needed for export/display continuity).
      if (_editing) { _revertPlaybackToBase(pb); drawLayer = true; }
      continue;
    }
    let target = pb.currentIdx;
    for (let i = pb.currentIdx + 1; i < pb.frames.length; i++) {
      if (pb.frames[i].pct <= frac * 100) target = i; else break;
    }
    if (target > pb.currentIdx && pb.frames[target]?.img) {
      // Commit the base to the NEW frame at the % point — this is what bakes into
      // the exported video (the crossfade clone on _uiLayer is NOT captured by
      // rasterizeOverlay, so export sees a clean cut at the right time). Live, we
      // ALSO fade the OLD frame out on top for a smooth dissolve.
      const oldImg = pb.frames[pb.currentIdx].img;
      pb.node.image(pb.frames[target].img);
      pb.currentIdx = target;
      drawLayer = true;
      if (oldImg && _uiLayer) {
        const clone = pb.node.clone({ listening: false, draggable: false });
        clone.image(oldImg);
        clone.opacity(pb.baseOpacity);
        clone.setAttr('_seqClone', true);               // transient (swept, never serialized/exported)
        _uiLayer.add(clone);
        pb.xfade = { clone, startMs: nowMs };
        drawUi = true;
      }
    }
  }
  if (_seqPlaybacks.some(pb => pb.dead)) _seqPlaybacks = _seqPlaybacks.filter(pb => !pb.dead);
  if (drawLayer) _layer?.batchDraw();
  if (drawUi)    _uiLayer?.batchDraw();
}

// Blink highlight over an interface while a shape hovers it.
let _ifaceBlink = null;   // { node, rect, timer }
function _blinkInterface(node) {
  if (_ifaceBlink?.node === node) return;
  _clearInterfaceBlink();
  if (!node) return;
  // The stage carries the safe-frame scale/position; the layers are identity.
  // Use the box RELATIVE TO THE LAYER so the highlight (also on a layer) lines
  // up — getClientRect() (absolute) would double-apply the stage transform.
  const r = node.getClientRect({ relativeTo: _layer });
  const rect = new Konva.Rect({
    x: r.x, y: r.y, width: r.width, height: r.height,
    stroke: '#38bdf8', strokeWidth: 3, dash: [8, 4], cornerRadius: 4, listening: false,
  });
  _uiLayer.add(rect);
  let on = true;
  const timer = setInterval(() => { on = !on; rect.opacity(on ? 1 : 0.2); _uiLayer.batchDraw(); }, 220);
  _ifaceBlink = { node, rect, timer };
  _uiLayer.batchDraw();
}
function _clearInterfaceBlink() {
  if (!_ifaceBlink) return;
  clearInterval(_ifaceBlink.timer);
  _ifaceBlink.rect.destroy();
  _uiLayer.batchDraw();
  _ifaceBlink = null;
}

/** Shapes bonded to the given interface node (public wrapper). */
export function getAttachedShapes(ifaceNode) { return _attachedShapesOf(ifaceNode); }

/** Trigger the overlay's debounced save after a programmatic node change. */
export function scheduleSave() { _scheduleSave(); }

/** Force the ACTIVE step's overlay JSON current NOW (serialises the live stage).
 *  Used before a cross-step edit so the active step isn't left stale. */
export function flushSave() { _writeOverlayToStep(state.get('activeStepId')); }

function _showOverlayContextMenu(node, x, y) {
  const sel = _transformer?.nodes() || [node];
  const hasClipboard = !!_overlayClipboard?.length;
  // Interface overlays get a "Change image" entry (pick from the library folder).
  // Reset/Update-default land in the next slice.
  const ifaceItems = interfaces.isInterfaceNode(node)
    ? [
        { label: '🖼 Change image…', action: () => interfaces.changeInterfaceImage(node) },
        { label: '🔍 Add zoom',       action: () => startZoomDraw(node) },
        // State-aware: at default → just an indicator; moved → the two actions.
        ...(node.getAttr('atDefault')
          ? [{ label: '✓ In default position', disabled: true }]
          : [
              { label: '↩ Reset to default position', action: () => interfaces.resetToDefault(node) },
              { label: '⊹ Set as default position',   action: () => interfaces.updateDefaultFromNode(node) },
            ]),
        { separator: true },
      ]
    : [];
  // Zoom clips: a "Zoom level" submenu (presets + custom multiplier).
  const zoomItems = node.getAttr('isZoom')
    ? (() => {
        const cur = node.getAttr('zoomMult') || 2;
        const preset = (m) => ({ label: `${cur === m ? '✓ ' : ''}${m}×`, action: () => setZoomMultiplier(node, m) });
        return [
          { label: '🔎 Zoom level', submenu: [
            preset(1), preset(1.5), preset(2), preset(3), preset(4),
            { separator: true },
            { label: 'Custom…', action: () => _promptZoomMultiplier(node) },
            { label: '↺ Reset to 1× (natural crop)', action: () => _resetZoomToNatural(node) },
          ] },
          { separator: true },
        ];
      })()
    : [];
  // Image sequence (S1): any plain image / interface (not text boxes or zooms)
  // can carry a swap-through frame sequence. Opens the authoring editor.
  const isSeqTarget = node.getClassName?.() === 'Image'
    && node.getAttr('src') && !node.getAttr('textHtml') && !node.getAttr('isZoom');
  const seqItems = isSeqTarget
    ? [
        { label: node.getAttr('sequence') ? '🎞 Edit image sequence…' : '🎞 Add image sequence…',
          action: () => openSequenceEditor(node, () => _scheduleSave()) },
        { separator: true },
      ]
    : [];
  const tocItems = node.getAttr('isToc')
    ? [{ label: '🔄 Refresh timecodes', action: () => _refreshTocBox(node) }, { separator: true }]
    : [];
  // 🎬 Video clips (V0.3.2.75): trim window + audio, and a quick mute toggle
  // so the common case (this clip must not talk over my voice-over) is one
  // click rather than a trip through the dialog.
  const videoItems = videoOverlay.isVideoNode(node)
    ? [
        { label: '🎬 Trim & audio…', action: () => _openVideoTrim(node) },
        { label: node.getAttr('muted') !== false ? '🔊 Unmute clip' : '🔇 Mute clip (use voice-over)',
          action: () => {
            videoOverlay.setVideoOptions(node, { muted: node.getAttr('muted') === false });
            _scheduleSave();
            setStatus(node.getAttr('muted') !== false ? 'Clip muted — voice-over plays.' : 'Clip audio on.');
          } },
        { label: '↩ Reset to natural size',
          action: () => {
            const nw = Number(node.getAttr('naturalW') || 0), nh = Number(node.getAttr('naturalH') || 0);
            if (nw && nh) { node.width(nw); node.height(nh); node.scaleX(1); node.scaleY(1); _layer.batchDraw(); _scheduleSave(); }
          } },
        { separator: true },
      ]
    : [];
  // V0.3.2.86 — layer order, in the menu at last. The machinery (multi-
  // select-safe, undoable, persisted) has existed for a long time but only
  // on PageUp/PageDown/Home/End — undiscoverable. Videos being ordinary
  // overlay citizens (the user's explicit architecture decision: no special
  // backdrop layer), this is how a clip goes ON TOP of an interface image
  // to play inside its window — or under anything else.
  const arrange = (key) => {
    const nodes = _transformer?.nodes()?.length ? _transformer.nodes() : [node];
    if (_reorderSelection(key, nodes)) { _layer.batchDraw(); _scheduleSave(); }
  };
  // 📌 Constant text boxes (V0.3.2.98) — creation on any plain text box;
  // management verbs on an instance, mirroring the interface default-pose menu.
  const isTextBox = !!node.getAttr('textHtml') && !node.getAttr('isToc');
  const constDef  = isTextBox ? _constDefOf(node) : null;
  const constItems = !isTextBox ? [] : (constDef
    ? [{ label: `📌 Constant "${constDef.name}"`, submenu: [
          { label: '⊹ Set as new position (all steps)',
            action: () => {
              constDef.x = _constAnchorX(node, constDef.anchor);
              constDef.y = node.y();
              _saveConstDefs([..._constDefs()]);
              setStatus(`Constant "${constDef.name}" repositioned — every step follows.`, 'success', 4000);
            } },
          { label: '↺ Snap back to constant position',
            action: () => { _applyConstToNode(node, constDef); _layer.batchDraw(); } },
          { separator: true },
          { label: `${constDef.anchor !== 'tr' ? '✓ ' : ''}Anchor: ⌜ top-left`,
            action: () => {
              // Re-derive x under the new mode from where the box sits NOW,
              // so switching anchors never makes anything jump.
              constDef.anchor = 'tl'; constDef.x = _constAnchorX(node, 'tl');
              _saveConstDefs([..._constDefs()]);
            } },
          { label: `${constDef.anchor === 'tr' ? '✓ ' : ''}Anchor: ⌝ top-right`,
            action: () => {
              constDef.anchor = 'tr'; constDef.x = _constAnchorX(node, 'tr');
              _saveConstDefs([..._constDefs()]);
            } },
          { separator: true },
          { label: '✂ Detach from constant (this box only)',
            action: () => { node.setAttr('constId', null); _scheduleSave(); setStatus('Detached — now a normal text box.', 'info', 3000); } },
        ] },
        { separator: true }]
    : node.getAttr('constId')
      ? [{ label: '📌 Constant definition missing — detach',
           action: () => { node.setAttr('constId', null); _scheduleSave(); } },
         { separator: true }]
      : [
         // V0.3.2.99 — adopt an EXISTING definition: the box keeps its text
         // (and its width — per-instance by design) but snaps to the chosen
         // constant's position and style, and follows it from now on.
         ...(_constDefs().length ? [{
           label: '📌 Attach to constant',
           submenu: _constDefs().map(d => ({
             label: `📌 ${d.name}`,
             action: () => {
               node.setAttr('constId', d.id);
               _applyConstToNode(node, d);
               _layer.batchDraw();
               _scheduleSave();
               setStatus(`Attached to "${d.name}" — snapped to its position and style; text kept.`, 'success', 4500);
             },
           })),
         }] : []),
         { label: '📌 Make constant text box…',
           action: async () => {
             const name = await promptString('Name this constant text box', `Constant ${_constDefs().length + 1}`);
             if (!name) return;
             const def = {
               id: `ctb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
               name: name.trim(), anchor: 'tl',
               x: node.x(), y: node.y(),
               styleId: node.getAttr('styleId') || null,
             };
             _saveConstDefs([..._constDefs(), def]);
             node.setAttr('constId', def.id);
             _scheduleSave();
             setStatus(`Constant "${def.name}" created — insert it on any step via the 📌 toolbar button.`, 'success', 6000);
           } },
         { separator: true }]);

  const arrangeItems = [
    { label: '🔼 Arrange', submenu: [
      { label: 'Bring forward',  action: () => arrange('PageUp') },
      { label: 'Send backward',  action: () => arrange('PageDown') },
      { label: 'Bring to front', action: () => arrange('Home') },
      { label: 'Send to back',   action: () => arrange('End') },
    ] },
    { separator: true },
  ];
  showContextMenu([
    ...videoItems,
    ...ifaceItems,
    ...zoomItems,
    ...seqItems,
    ...tocItems,
    ...constItems,
    ...arrangeItems,
    { label: '⎘ Duplicate',        action: _duplicateSelected },
    { label: '📋 Copy',            action: _copyToOverlayClipboard },
    { label: '📥 Paste',           disabled: !hasClipboard, action: () => _pasteFromOverlayClipboard({ inPlace: false }) },
    { label: '📥 Paste in place',  disabled: !hasClipboard, action: () => _pasteFromOverlayClipboard({ inPlace: true })  },
    { separator: true },
    { label:  '🗑 Delete',
      action: () => {
        for (const n of sel) n.destroy();
        _setSelection(null);
        _layer.batchDraw();
        _scheduleSave();
      },
    },
  ], x, y);
}

/**
 * Set or extend the overlay's node selection.
 *   _setSelection(null)            — clear all
 *   _setSelection(node)            — replace selection with [node]
 *   _setSelection(node, additive)  — toggle node in/out of the existing
 *                                    set (shift/ctrl/meta-click)
 *
 * Multi-select is honoured by Konva.Transformer natively: passing an
 * array of nodes draws one bounding box around all of them and a drag
 * moves the whole group together.
 */
function _setSelection(node, additive = false) {
  let nodes;
  if (!node) {
    nodes = [];
  } else if (additive) {
    const current = _transformer.nodes() || [];
    nodes = current.includes(node)
      ? current.filter(n => n !== node)
      : [...current, node];
  } else {
    nodes = [node];
  }
  _transformer.nodes(nodes);
  _configTransformerForNodes(nodes);
  _uiLayer.batchDraw();

  // Multi-textbox toolbar: when ≥1 text box is selected and we're not
  // already inside the in-place editor, surface the style toolbar in
  // "multi-mode". Each style click then routes through _multiTextApplier
  // — which walks each selected box's HTML and changes only the touched
  // property, leaving other inline styles intact.
  _refreshMultiToolbar();
}

/**
 * Decide whether the multi-textbox toolbar should be mounted/unmounted
 * based on the current selection. Single-editor mode wins (it has its
 * own mount + unmount calls in _enterTextEdit / _exitTextEdit).
 */
function _refreshMultiToolbar() {
  if (_activeTextEditor) return;     // single-editor mode owns the slot
  const host = getTextToolbarSlot();
  if (!host) return;
  const sel = _transformer?.nodes() || [];
  const textBoxes = sel.filter(n => n.getAttr?.('textHtml'));
  const shapes    = sel.filter(n => n.name?.() === 'userShape');

  // Shape-toolbar wins when ANY shape is selected and no text box is in
  // the selection. Mixed selections fall back to text toolbar (text-edit
  // is the more specific UX). When neither: unmount both.
  if (textBoxes.length === 0 && shapes.length >= 1) {
    unmountTextToolbar();
    mountShapeToolbar(host, () => _summariseShapeAttrs(shapes), (patch) => applyShapeAttrs(patch));
    return;
  }
  unmountShapeToolbar();

  if (textBoxes.length >= 1) {
    mountTextToolbar(host, _multiTextApplier);
    setToolbarValues(_summariseStyleAcrossBoxes(textBoxes));
    // Style dropdown — multi-mode assignment writes the same styleId
    // to every selected text box. Show "(no style)" when the selection
    // mixes bound + unbound, or different bound IDs.
    const ids = new Set(textBoxes.map(n => n.getAttr('styleId') || ''));
    const uniformId = ids.size === 1 ? [...ids][0] : '';
    setStyleDropdown(listStyleTemplates(), uniformId, (newId) => {
      for (const n of textBoxes) {
        n.setAttr('styleId', newId || null);
        _reflowTextBox(n).catch(() => {});
        _propagateConstStyle(n, newId || null);   // 📌 V0.3.2.98 — write through to the definition
      }
      setStyleLocked(!!newId);
      _scheduleSave();
    });
    setStyleLocked(uniformId ? true : false);
    // 📌 Constant picker (V0.3.2.100) — single plain text box only (multi
    // would be ambiguous; TOC boxes are machine-managed). The ✏️ pencil
    // renames the chosen definition everywhere it appears.
    const solo = textBoxes.length === 1 ? textBoxes[0] : null;
    if (solo && !solo.getAttr('isToc')) {
      setConstDropdown(_constDefs(), solo.getAttr('constId') || '', (defId) => {
        if (!defId) {
          solo.setAttr('constId', null);
          setStatus('Detached — now a normal text box.', 'info', 3000);
        } else {
          const def = _constDefs().find(d => d.id === defId);
          if (def) {
            solo.setAttr('constId', def.id);
            _applyConstToNode(solo, def);
            _layer.batchDraw();
            setStatus(`Attached to "${def.name}".`, 'success', 3000);
          }
        }
        _scheduleSave();
      }, async (defId) => {
        const def = _constDefs().find(d => d.id === defId);
        if (!def) return;
        const name = await promptString('Rename constant', def.name || '');
        if (!name || !name.trim() || name.trim() === def.name) return;
        def.name = name.trim();
        _saveConstDefs([..._constDefs()]);
        _refreshMultiToolbar();   // rebuilds this dropdown with live handlers + the new name
        setStatus(`Constant renamed to "${def.name}".`, 'success', 3000);
      }, (defId) => {
        // 🗑 — deleteConstDef refuses in-use defs with an explanatory status.
        const res = deleteConstDef(defId);
        if (res.ok) _refreshMultiToolbar();   // dropdown loses the deleted entry
      });
    } else {
      setConstDropdown(null);
    }
  } else {
    unmountTextToolbar();
    setConstDropdown(null);
  }
}

/**
 * Walk every text box's HTML, collect inline font-size / font-family /
 * colour declarations, and return a representative value per the user
 * spec: unified value when consistent, LARGEST when sizes differ. For
 * font / colour with mixed values we just pick the first one we see —
 * better than nothing for a hint, and the user can always override.
 */
function _summariseStyleAcrossBoxes(nodes) {
  const sizes = new Set();
  const fonts = new Set();
  const colors = new Set();
  const tmp = document.createElement('div');
  for (const n of nodes) {
    tmp.innerHTML = n.getAttr('textHtml') || '';
    tmp.querySelectorAll('[style]').forEach(el => {
      if (el.style.fontSize)   sizes.add(_parsePxSize(el.style.fontSize));
      if (el.style.fontFamily) fonts.add(_stripQuotes(el.style.fontFamily));
      if (el.style.color)      colors.add(_normaliseColor(el.style.color));
    });
  }
  sizes.delete(null);   // discard unparseable

  // Mixed-font fallback: pick the font of the FIRST text run inside the
  // LAST selected box. Per user spec — "first letter of the last box
  // selected" — gives the user a meaningful representative instead of
  // a stale Arial default.
  let fontName;
  if (fonts.size === 1) {
    fontName = [...fonts][0];
  } else if (fonts.size > 1) {
    const last = nodes[nodes.length - 1];
    fontName = _firstFontInHtml(last?.getAttr?.('textHtml') || '');
  }

  // Fill is a node-level attr. Take the LAST selected box's value (or
  // the only one if uniform). Decompose the rgba string into hex + alpha
  // so the colour input + slider can show meaningful initial values.
  const fills = nodes.map(n => n.getAttr('fillColor')).filter(Boolean);
  const lastFill = fills[fills.length - 1] || null;
  const fillBits = lastFill ? _decomposeRgba(lastFill) : null;

  return {
    fontSize: sizes.size === 0 ? undefined
            : sizes.size === 1 ? [...sizes][0]
            : Math.max(...sizes),     // mixed → largest, per spec
    fontName,
    color:    colors.size === 1 ? [...colors][0] : undefined,
    fillColor: fillBits?.hex,
    fillAlpha: fillBits?.alpha,
  };
}

/**
 * Split an rgba()/rgb()/#hex string into { hex:'#rrggbb', alpha:0..100 }.
 * Returns null on unparseable input.
 */
function _decomposeRgba(s) {
  if (!s) return null;
  const str = String(s).trim();
  // rgba(r, g, b, a) — alpha as 0..1
  let m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(str);
  if (m) {
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return {
      hex:   `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`,
      alpha: m[4] != null ? Math.round(parseFloat(m[4]) * 100) : 100,
    };
  }
  // #rrggbb
  m = /^#?([0-9a-f]{6})$/i.exec(str);
  if (m) return { hex: `#${m[1]}`, alpha: 100 };
  return null;
}

/**
 * Pre-order DFS through a stored HTML fragment for the first element
 * with an explicit inline fontFamily. Returns the family stripped of
 * quotes / fallback list. Null when no element declares one.
 */
function _firstFontInHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const visit = (el) => {
    if (el.style?.fontFamily) return _stripQuotes(el.style.fontFamily);
    for (const c of el.children || []) {
      const f = visit(c);
      if (f) return f;
    }
    return null;
  };
  return visit(tmp);
}

function _parsePxSize(s) {
  const m = /^([\d.]+)\s*px/i.exec(String(s).trim());
  return m ? Math.round(parseFloat(m[1])) : null;
}

/**
 * Read the computed font-size / family / colour at the current caret /
 * selection inside the contenteditable. Used in single-editor mode to
 * keep the toolbar dropdowns in sync as the caret moves across text
 * runs with different inline styles.
 */
function _readStyleAtCaret(editor) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return {};
  let n = sel.getRangeAt(0).startContainer;
  if (n && n.nodeType === 3) n = n.parentNode;            // text node → element
  if (!n || !(n instanceof Element)) return {};
  if (!editor.contains(n)) return {};
  const cs = window.getComputedStyle(n);
  // Fill is a node-level attr (textbox background) — read it from the
  // active editor's owning node so the toolbar's fill controls also seed.
  let fillBits = null;
  if (_activeTextEditor?.node) {
    fillBits = _decomposeRgba(_activeTextEditor.node.getAttr('fillColor'));
  }
  return {
    fontSize: Math.round(parseFloat(cs.fontSize)) || undefined,
    fontName: _stripQuotes(cs.fontFamily) || undefined,
    color:    _normaliseColor(cs.color)   || undefined,
    fillColor: fillBits?.hex,
    fillAlpha: fillBits?.alpha,
  };
}

function _stripQuotes(s) {
  return String(s).replace(/^["']|["']$/g, '').split(',')[0].trim();
}

function _normaliseColor(s) {
  // Convert "rgb(r,g,b)" → "#rrggbb" so the colour input accepts it.
  const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(String(s).trim());
  if (m) {
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return String(s);
}

/**
 * Single-editor applier — intercepts the node-level `fillColor` action
 * (textbox background, not text styling), routes everything else to
 * execCommandApplier (which now drives the unified text-engine over
 * the live selection inside the contenteditable).
 *
 * fillColor is intercepted here because it modifies the Konva node's
 * own attribute and the live editor's CSS background — the engine
 * doesn't touch either.
 */
function _singleEditorApplier(action, value) {
  // P7-A: snapshot the pre-op state so Ctrl-Z inside the editor can
  // step back through toolbar / engine ops one at a time. record() is
  // a no-op when no session is active, so it's safe to call
  // unconditionally here.
  editSession.record();
  if (action === 'fillColor') {
    if (!_activeTextEditor || !value) return;
    _activeTextEditor.node.setAttr('fillColor', value);
    _activeTextEditor.div.style.backgroundColor = value;
    return;
  }
  execCommandApplier(action, value);
}

/**
 * Mass-mode applier: iterate selected text boxes, run the unified
 * text-engine over each box's stored HTML with no Range (so it
 * touches every text run). Then re-rasterise. fillColor is a
 * node-level attr (not inline style) so it short-circuits ahead
 * of the engine call.
 */
function _multiTextApplier(action, value) {
  const sel = _transformer?.nodes() || [];
  const targets = sel.filter(n => n.getAttr?.('textHtml'));
  if (!targets.length) return;

  // P7-B-1: snapshot every selected box's full styling state BEFORE
  // we mutate, so a single mass-mode toolbar press maps to ONE
  // main-undo entry — not N entries (one per box). The snapshot
  // captures textHtml + fillColor + styleId; restore re-rasterises
  // each touched node.
  const before = targets.map(node => _snapTextBox(node));

  if (action === 'fillColor') {
    if (!value) return;
    for (const node of targets) {
      node.setAttr('fillColor', value);
      _reflowTextBox(node).catch(() => {});
    }
  } else {
    for (const node of targets) {
      const beforeHtml = node.getAttr('textHtml') || '';
      const root   = document.createElement('div');
      root.innerHTML = beforeHtml;
      textEngine.apply(root, null, action, value);
      const after = root.innerHTML;
      if (after === beforeHtml) continue;
      node.setAttr('textHtml', after);
      _reflowTextBox(node).catch(() => {});
    }
  }

  const after = targets.map(node => _snapTextBox(node));
  const changed = before.some((b, i) =>
    b.textHtml !== after[i].textHtml ||
    b.fillColor !== after[i].fillColor ||
    b.styleId !== after[i].styleId,
  );
  if (changed) {
    const label = `Style ${targets.length} text box${targets.length > 1 ? 'es' : ''}`;
    undoManager.push(label,
      () => _restoreTextBoxes(before),
      () => _restoreTextBoxes(after),
    );
  }
  _scheduleSave();
}

/** Snapshot a single textbox node's user-visible styling state. */
function _snapTextBox(node) {
  return {
    node,
    textHtml:  node.getAttr('textHtml') || '',
    fillColor: node.getAttr('fillColor') ?? null,
    styleId:   node.getAttr('styleId')   ?? null,
  };
}

/**
 * Restore an array of textbox snapshots. Skips destroyed nodes
 * gracefully (returns false from a single-snap restore so undoManager
 * can drop entries that reference a node that's no longer there —
 * e.g. step navigation invalidated the layer).
 */
async function _restoreTextBoxes(snaps) {
  let anyAlive = false;
  for (const s of snaps) {
    if (!s.node || s.node.isDestroyed?.()) continue;
    anyAlive = true;
    s.node.setAttr('textHtml',  s.textHtml);
    s.node.setAttr('fillColor', s.fillColor);
    s.node.setAttr('styleId',   s.styleId);
    await _reflowTextBox(s.node);
  }
  _scheduleSave();
  return anyAlive ? undefined : false;
}

/**
 * Flip the transformer's resize behaviour based on what's selected AND
 * whether we're in the in-place text editor.
 *
 *   • Text box, NOT editing — full 8 anchors, free resize. Raster reflows
 *     at transformend (snap behaviour: brief stretch during drag, clean
 *     reflow on release).
 *   • Text box, EDITING       — full 8 anchors, free resize. The editor's
 *     contenteditable resizes LIVE during drag (see node.on('transform')),
 *     so the user sees the actual final layout while dragging — no
 *     stretched-then-snap flash.
 *   • Plain image             — aspect-locked uniform scale on the four
 *     corners. Skewing bitmaps looks bad.
 *
 * Rotation is disabled on text boxes (rotating rasterised text + then
 * editing a contenteditable inside a rotated bbox is tricky — defer
 * unless asked).
 */
function _configTransformerForNode(node) {
  _configTransformerForNodes(node ? [node] : []);
}

/**
 * Multi-node-aware transformer config. If every selected node is a text
 * box, free-resize 8 anchors. If anything else is in the set, downgrade
 * to aspect-locked corners (no way to mix per-node configs in one
 * transformer). Selection-only state with no nodes has no effect.
 */
function _configTransformerForNodes(nodes) {
  if (!_transformer || !nodes?.length) return;
  const allTextBoxes = nodes.every(n => n.getClassName?.() === 'Image' && n.getAttr('textHtml'));
  if (allTextBoxes) {
    // Text boxes: WIDTH ONLY. Height is computed from content — taller
    // text = taller box, automatically. Top/bottom/corner anchors are
    // off because they'd let the user fight the auto-height; the user
    // adjusts width and the box snaps to the right vertical extent.
    _transformer.keepRatio(false);
    _transformer.rotateEnabled(false);
    _transformer.enabledAnchors(['middle-left', 'middle-right']);
    return;
  }
  // Shapes: free aspect resize, all 8 anchors, rotate enabled. Mirrors
  // typical 2D-editor behaviour for primitive shapes (Figma / Illustrator).
  const allShapes = nodes.every(n => n.name?.() === 'userShape');
  if (allShapes) {
    _transformer.keepRatio(false);
    _transformer.rotateEnabled(true);
    _transformer.enabledAnchors([
      'top-left', 'top-center', 'top-right',
      'middle-left', 'middle-right',
      'bottom-left', 'bottom-center', 'bottom-right',
    ]);
    return;
  }
  // Zoom clips: free resize (each axis re-crops independently), no rotation,
  // no aspect-lock — the frame is a viewport into the magnified image.
  if (nodes.every(n => n.getAttr?.('isZoom'))) {
    _transformer.keepRatio(false);
    _transformer.rotateEnabled(false);
    _transformer.enabledAnchors([
      'top-left', 'top-center', 'top-right',
      'middle-left', 'middle-right',
      'bottom-left', 'bottom-center', 'bottom-right',
    ]);
    return;
  }
  // Anything with an image (or mixed) — lock aspect, corners only.
  // Interfaces: no rotation handle (per spec — interfaces don't rotate).
  const hasInterface = nodes.some(n => n.getAttr?.('isInterface'));
  _transformer.keepRatio(true);
  _transformer.rotateEnabled(!hasInterface);
  _transformer.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
}

// ─── Selected-node mutators (called from toolbar) ──────────────────────────

export function getSelected() {
  const n = _transformer?.nodes()?.[0];
  return n || null;
}

export function deleteSelected() {
  const nodes = _transformer?.nodes() || [];
  if (!nodes.length) return false;
  // P7-C-1: snapshot specs BEFORE destroying so undo can re-create the
  // nodes from a stable serialised form (Konva nodes can't be revived
  // after destroy(); the spec is what survives). Also capture each
  // node's zIndex so undo can restore the layer order — without this,
  // _layer.add(n) appends to the top of the stack and a deleted "back
  // layer" rect comes back as the topmost element after Ctrl-Z.
  const entries = nodes.map(n => ({
    spec:   _serializeNode(n),
    zIndex: n.zIndex?.() ?? 0,
  })).filter(e => e.spec);
  for (const n of nodes) n.destroy();
  _setSelection(null);
  _layer.batchDraw();
  _pushDeleteNodesUndo(entries, `Delete ${entries.length} item${entries.length > 1 ? 's' : ''}`);
  _scheduleSave();
  return true;
}

export function updateSelectedText(patch) {
  const n = getSelected();
  if (!n || n.getClassName() !== 'Text') return;
  n.setAttrs(patch);
  _layer.batchDraw();
  _scheduleSave();
}

// ─── Per-step persistence ──────────────────────────────────────────────────
//
// Edits debounce through _scheduleSave (120 ms) so rapid changes coalesce.
// We capture the step id AT SCHEDULE TIME (`_pendingSaveStepId`) — the
// timer fire might happen after the user has already switched to a
// different step, and writing to `state.get('activeStepId')` at that
// point would land the edit on the wrong step (or on a step whose
// overlay has just been cleared by the load path).
//
// _flushPendingSave runs synchronously on `change:activeStepId` BEFORE
// the load handler, so the OUTGOING step's pending edits are committed
// against the still-loaded _stage content. After flush, the load can
// safely destroy the layer and reinstate the new step.

let _pendingSaveStepId = null;

function _scheduleSave() {
  if (!_pendingSaveStepId) _pendingSaveStepId = state.get('activeStepId');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushPendingSave, 120);
}

function _flushPendingSave() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  const stepId = _pendingSaveStepId;
  _pendingSaveStepId = null;
  if (stepId) _writeOverlayToStep(stepId);
}

function _writeOverlayToStep(stepId) {
  if (!_stage || !stepId) return;
  // STALE-STAGE GUARD (V0.3.2.104): after a data-level op patches step
  // overlay STRINGS behind the live stage's back (unify / merge / their
  // undo closures), the strings are authoritative and the stage is stale
  // until _scheduleLoad's RAF rebuilds it. Serialising the stale stage
  // here would clobber the patch — the exact bug: merge → panel refresh →
  // countConstUsage → flushSave rewrote the active step's just-merged
  // overlay and orphaned its boxes. No user edit can exist in this
  // window (the stage is about to be rebuilt from the strings anyway).
  if (_overlayStringsAuthoritative) return;
  const steps = state.get('steps') || [];
  const step  = steps.find(s => s.id === stepId);
  if (!step) return;
  const json = _serialiseStageJson();
  if (step.overlay === json) return;
  step.overlay = json;
  state.markDirty();
}

// ── Copy / Paste a whole overlay preset across steps (V0.3.1.63, backlog #19) ──
// Copies a step's overlay USER content (all content-layer children EXCEPT baked
// `sbs-header-item` header nodes) and pastes it onto another step — Replace (swap
// user content, keep target's headers) or Add-on-top (stack above existing, keep
// headers). Data-level (works on any step, active or not); undo via undoManager.
// No id remapping: two interfaces coexisting is fine, default interfaces carry
// their `atDefault`+geometry in the spec, and Replace is the common case.
let _overlayClip = null;   // array of content-layer child specs (headers excluded)

function _findContentLayerSpec(spec) {
  const layers = spec?.children || [];
  return layers.find(l => l.className === 'Layer' && l.attrs?.name === 'sbs-overlay-content')
      || layers.find(l => l.className === 'Layer' && !l.attrs?.name && (l.children || []).length > 0)
      || layers.find(l => l.className === 'Layer' && (l.children || []).length > 0)
      || null;
}
const _isHeaderChild = (c) => c?.attrs?.name === 'sbs-header-item';
const _stepById = (id) => (state.get('steps') || []).find(s => s.id === id);

/** Non-header content-node specs of a step's overlay. [] if none, null if unparseable. */
function _extractOverlayContent(stepId) {
  const step = _stepById(stepId);
  if (!step?.overlay) return [];
  let spec; try { spec = JSON.parse(step.overlay); } catch { return null; }
  const layer = _findContentLayerSpec(spec);
  return layer ? (layer.children || []).filter(c => !_isHeaderChild(c)) : [];
}

/** Copy a step's overlay content into the clipboard. Returns { ok, count }. */
export function copyStepOverlay(stepId) {
  const c = _extractOverlayContent(stepId);
  if (c === null) return { ok: false, error: 'overlay unreadable' };
  _overlayClip = c;
  return { ok: true, count: c.length };
}

export function overlayClipCount() { return _overlayClip ? _overlayClip.length : 0; }
export function stepOverlayUserCount(stepId) { const c = _extractOverlayContent(stepId); return Array.isArray(c) ? c.length : 0; }

/** Paste the clipboard onto a step. mode 'replace' | 'add'. Undo-able. { ok, count, mode }. */
export function pasteStepOverlay(stepId, mode = 'replace') {
  if (!_overlayClip || !_overlayClip.length) return { ok: false, error: 'clipboard empty' };
  const step = _stepById(stepId);
  if (!step) return { ok: false, error: 'step not found' };
  const before = step.overlay ?? null;
  let spec; try { spec = step.overlay ? JSON.parse(step.overlay) : null; } catch { spec = null; }
  if (!spec) spec = { attrs: {}, className: 'Stage', children: [] };
  let layer = _findContentLayerSpec(spec);
  if (!layer) { layer = { attrs: { name: 'sbs-overlay-content' }, className: 'Layer', children: [] }; (spec.children || (spec.children = [])).push(layer); }
  const kids = layer.children || [];
  const headers = kids.filter(_isHeaderChild);
  const existingUser = kids.filter(c => !_isHeaderChild(c));
  layer.children = (mode === 'add') ? [...existingUser, ..._overlayClip, ...headers]
                                    : [..._overlayClip, ...headers];
  step.overlay = JSON.stringify(spec);
  const after = step.overlay;
  state.markDirty();
  const restore = (str) => { const s = _stepById(stepId); if (!s) return; s.overlay = str; state.markDirty(); if (stepId === state.get('activeStepId')) _markOverlayStringsAuthoritative(); };
  if (stepId === state.get('activeStepId')) _markOverlayStringsAuthoritative();
  undoManager.push(`Paste overlay (${mode})`, () => restore(before), () => restore(after));
  return { ok: true, count: _overlayClip.length, mode };
}

/**
 * Konva.Stage.toJSON serialises every node attr — including
 * Konva.Image's `image`, which is an HTMLCanvasElement we built via
 * _htmlToCanvas. JSON.stringify(canvas) returns "{}" (canvases have no
 * enumerable own properties), so the saved spec carries `image: {}`.
 *
 * On restore, `new Konva.Image({ image: {} })` accepts the empty object
 * and the next batchDraw passes it to ctx.drawImage — which throws
 * "image argument is a canvas with width or height of 0" and corrupts
 * subsequent draws on the layer ("works once then stops").
 *
 * The image is recoverable from `textHtml` (rasterise via _reflowTextBox)
 * or `src` (re-load via _loadImage), so the serialised image attr is
 * pure dead weight. Scrub it on the way out.
 */
function _serialiseStageJson() {
  if (!_stage) return null;
  let parsed;
  try { parsed = JSON.parse(_stage.toJSON()); }
  catch { return _stage.toJSON(); }
  const stripImage = (children) => {
    for (const c of children || []) {
      if (c?.attrs && 'image' in c.attrs) delete c.attrs.image;
      if (c?.children) stripImage(c.children);
    }
  };
  stripImage(parsed?.children);
  return JSON.stringify(parsed);
}

let _loadRaf = 0;
let _currentLoadPromise = Promise.resolve();
// True from "a data-level op patched overlay strings" until the next load
// rebuilds the live stage from them — see the guard in _writeOverlayToStep.
let _overlayStringsAuthoritative = false;
function _markOverlayStringsAuthoritative() { _overlayStringsAuthoritative = true; _scheduleLoad(); }
function _scheduleLoad() {
  // Defer by a frame so step.snapshot application completes before restore.
  // Cancel any prior RAF so rapid step changes don't queue multiple loads.
  if (_loadRaf) cancelAnimationFrame(_loadRaf);
  // Track the load's promise so video export (and future deterministic
  // callers) can await it via waitForOverlayStable() — without this,
  // the first few frames after a step transition can capture a partial
  // / empty layer because async raster is still in flight.
  _currentLoadPromise = new Promise(resolve => {
    _loadRaf = requestAnimationFrame(async () => {
      _loadRaf = 0;
      try { await _loadFromActiveStep(); }
      finally { _overlayStringsAuthoritative = false; resolve(); }
    });
  });
}

function _onStepApplied() {
  // H2: when the overlay phase pre-loaded this step's content for
  // fade-in, skip the post-anim reload — it would tear down + rebuild
  // the just-faded-in nodes, flashing the layer.
  if (_suppressNextStepAppliedLoad) {
    _suppressNextStepAppliedLoad = false;
    return;
  }
  // Wrap with a tracked promise so external callers can await this
  // path too. _loadFromActiveStep already async + token-guarded, so
  // overlapping calls are safe.
  // After load: if no fade-in was queued (animation string has no
  // 'overlay' slot), the layer's opacity was driven to 0 by the
  // pre-roll fade-out — restore it to 1 so the new content shows.
  // If a fade-in DID run, _activeFade is non-null and will manage
  // opacity itself; don't override.
  _currentLoadPromise = (async () => {
    await _loadFromActiveStep();
    if (!_activeFade) {
      _layer?.opacity(1);
      _layer?.batchDraw();
    }
  })();
}

// ─── H2: overlay phase fade-out / fade-in ────────────────────────────────

/**
 * Crossfade the overlay between the outgoing and incoming step's
 * content. Old children move to the ghost layer (still on screen at
 * full opacity), new step's content loads into _layer at opacity 0,
 * then both lerp in opposite directions over `durationMs` so the
 * user sees a smooth swap. Called by steps.js on the 'overlay' slot;
 * if the animation string has no overlay slot the swap snaps via the
 * post-anim _onStepApplied path instead.
 */
export function beginOverlayCrossfade(durationMs, easeFn, onDone) {
  _beginOverlayFade(durationMs, easeFn, onDone, 'crossfade');
}

/**
 * Sustained-overlap variant. The new step's content fades up FIRST
 * while the outgoing layer holds at full opacity, then the outgoing
 * fades down once incoming is fully visible. Items present in BOTH
 * steps stay at 100% visible alpha through the entire transition —
 * no flicker on shared shapes/text/images.
 *
 * Mathematically: visible alpha = B + (1−B)·A. With phase 1 holding
 * A=1 while B ramps 0→1, then phase 2 holding B=1 while A ramps 1→0,
 * visible alpha is always 1.
 */
export function beginOverlaySustainedFade(durationMs, easeFn, onDone) {
  _beginOverlayFade(durationMs, easeFn, onDone, 'sustained');
}

function _beginOverlayFade(durationMs, easeFn, onDone, mode) {
  if (!_layer || !_ghostLayer) { if (onDone) onDone(); return; }
  // Cancel any in-flight crossfade so the new one isn't fighting it.
  if (_activeFade?.onDone) {
    const prev = _activeFade.onDone;
    _activeFade = null;
    prev();
  }
  // Park the transformer — its target nodes are about to migrate to
  // the ghost layer and it would otherwise paint stale handles.
  if (_transformer) _transformer.nodes([]);
  // Move outgoing children to the ghost layer at full opacity.
  _ghostLayer.destroyChildren();
  for (const c of [..._layer.getChildren()]) c.moveTo(_ghostLayer);
  _ghostLayer.opacity(1);
  _ghostLayer.batchDraw();
  if (typeof window !== 'undefined' && window.sbsDiag?.videoExportTrace) {
    const kinds = _ghostLayer.getChildren().map(c => {
      const img = c.image?.();
      return `${c.getClassName()}${c.getAttr?.('isVideo') ? '[VIDEO img=' + (img?.constructor?.name || 'none') + ' rs=' + (img?.readyState ?? '-') + ' t=' + (img?.currentTime?.toFixed?.(2) ?? '-') + ']' : ''}`;
    });
    console.log(`[vtrace] GHOST HANDOFF: ${kinds.length} node(s) → ghost: ${kinds.join(', ')}`);
  }
  // Reset _layer + load new step's content into it at opacity 0.
  _layer.opacity(0);
  _layer.batchDraw();
  _suppressNextStepAppliedLoad = true;
  _currentLoadPromise = (async () => { await _loadFromActiveStep(); })();
  const arm = () => {
    _activeFade = {
      startMs: clock.now(),
      durationMs, easeFn, onDone,
      crossfade: mode === 'crossfade',
      sustained: mode === 'sustained',
    };
  };
  // 🎬 V0.3.2.95 — EXPORT ONLY: don't start the fade until the incoming
  // content has actually loaded. Export frames encode WHILE the load runs;
  // arming immediately let early fade frames capture the incoming layer
  // half-built — for a video step that meant the stale poster slate (source
  // second 0) fading in before the real element reached its trim-in frame:
  // the reported "something irrelevant, faded over". The ghost holds the
  // previous step at full opacity for the extra beat, which is exactly the
  // still-frame behaviour the spec wants. Live keeps arming instantly —
  // humans prefer responsiveness over frame-exactness; the export needs the
  // opposite. finally() (not then) so a failed load can never leave the
  // fade unarmed and hang the phase promise.
  if (state.get('_exporting')) _currentLoadPromise.finally(arm);
  else arm();
}

/**
 * Snap any in-flight overlay crossfade to its target state and fire
 * its onDone. Called from steps.snapCurrentToFinal so an interrupted
 * step transition leaves the layer at a clean state.
 */
export function snapOverlayFadeToFinal() {
  if (!_activeFade) return;
  const { onDone } = _activeFade;
  _layer?.opacity(1);
  _layer?.batchDraw();
  _ghostLayer?.opacity(0);
  _ghostLayer?.destroyChildren();
  _ghostLayer?.batchDraw();
  _activeFade = null;
  if (onDone) onDone();
}

function _advanceOverlayFade(nowMs) {
  if (!_activeFade || !_layer || !_ghostLayer) return;
  const { startMs, durationMs, easeFn, onDone } = _activeFade;
  const raw = Math.min(1, Math.max(0, (nowMs - startMs) / durationMs));
  // Overlap crossfade — both `overlay(N)` and `overlayS(N)` use this.
  // Each ramp spans X = 70% of the transition with a 40% overlap window
  // in the middle:
  //   incoming  fades 0→1 over [0,    0.7T]
  //   outgoing  fades 1→0 over [0.3T, T   ]
  // Layer-opacity sum A + B = 1 at endpoints and ~1.43 at the midpoint
  // (always ≥ 1). Visible alpha bottoms ~0.92 — flicker-light without
  // the hard handoff of a two-phase split.
  const X = 0.70;
  let layerA, ghostA;
  if (raw <= X) layerA = easeFn ? easeFn(raw / X) : (raw / X);
  else          layerA = 1;
  if (raw >= 1 - X) {
    const u = (raw - (1 - X)) / X;
    ghostA = 1 - (easeFn ? easeFn(u) : u);
  } else {
    ghostA = 1;
  }
  _layer.opacity(layerA);
  _ghostLayer.opacity(ghostA);
  _layer.batchDraw();
  _ghostLayer.batchDraw();
  if (typeof window !== 'undefined' && window.sbsDiag?.videoExportTrace) {
    _vtraceN = (_vtraceN || 0) + 1;
    if (_vtraceN % 8 === 1 || raw >= 1) {
      const g = _ghostLayer.getChildren().map(c => {
        const img = c.image?.();
        return c.getAttr?.('isVideo') ? `VIDEO(img=${img?.constructor?.name || 'none'})` : c.getClassName();
      });
      console.log(`[vtrace] fade raw=${raw.toFixed(2)} layerA=${layerA.toFixed(2)} ghostA=${ghostA.toFixed(2)} ghost=[${g.join(',')}]`);
    }
  }
  if (raw >= 1) {
    _ghostLayer.destroyChildren();
    _ghostLayer.batchDraw();
    _activeFade = null;
    if (onDone) onDone();
  }
}
let _vtraceN = 0;
let _vtraceRastN = 0;
let _vtracePxN = 0;

// null = not probed yet; probed lazily on the first rasterizeOverlay call.
let _konvaBakesLayerOpacity = null;

/** Render a 50%-opacity layer to canvas and read back one pixel. ~128 alpha
 *  means Konva baked the layer opacity; ~255 means it ignored it. */
function _probeLayerOpacityBaking() {
  try {
    const div = document.createElement('div');
    const stage = new Konva.Stage({ container: div, width: 2, height: 2 });
    const layer = new Konva.Layer({ opacity: 0.5 });
    layer.add(new Konva.Rect({ x: 0, y: 0, width: 2, height: 2, fill: '#ffffff' }));
    stage.add(layer);
    const c = layer.toCanvas({ x: 0, y: 0, width: 2, height: 2, pixelRatio: 1 });
    const alpha = c.getContext('2d').getImageData(0, 0, 1, 1).data[3];
    stage.destroy();
    return alpha < 200;
  } catch (e) {
    console.warn('[overlay] opacity-baking probe failed — assuming baked (legacy behaviour):', e?.message);
    return true;
  }
}

// Drive the fade from sceneCore's tick so the lerp runs in-step with
// the rest of the per-frame work (cable transitions, gizmo, etc.).
// (sceneCore import is at the top of the file; addTickHook is wired
// up inside initOverlay below alongside the existing init-side hooks.)

/**
 * Resolves once the overlay layer has finished applying the latest
 * step transition (RAF + async raster). Video export awaits this
 * after every activateStep so frames captured during the hold are
 * always against the FINAL overlay state, not a partially-loaded one.
 */
export function waitForOverlayStable() {
  return _currentLoadPromise;
}

async function _loadFromActiveStep() {
  if (!_stage) return;
  const activeId = state.get('activeStepId');
  // Tag this load so a later step-change invalidates a still-running one.
  // Without this, two rapid step switches can interleave: load #1's awaits
  // resolve AFTER load #2 has already populated the layer, dumping load #1's
  // (now-stale) nodes into the wrong step's layer.
  const myToken = ++_loadToken;
  const steps = state.get('steps') || [];
  const step  = steps.find(s => s.id === activeId);

  // GHOST-EDITOR FIX (V0.3.1.81): a step change that arrives WITHOUT a mouse
  // click (keyboard nav, programmatic activate) never triggers the editor's
  // click-outside commit — destroyChildren below would then orphan the live
  // contenteditable DOM above the canvas forever. Commit + tear it down first.
  if (_activeTextEditor) { try { await _exitTextEdit(); } catch { /* teardown is best-effort */ } }

  // Clear current content + selection.
  // 🎬 Release video elements FIRST (V0.3.2.75) — destroyChildren would drop
  // the Konva nodes while their <video> elements kept decoding in the
  // background, which is both a memory leak and audible (a muted-by-default
  // clip is silent, but an unmuted one would keep playing into the next step).
  videoOverlay.detachAll();
  _transformer.nodes([]);
  _layer.destroyChildren();

  if (!step?.overlay) { _layer.batchDraw(); return; }

  let spec;
  try {
    spec = JSON.parse(step.overlay);
  } catch { console.warn('[overlay] failed to parse step.overlay'); _layer.batchDraw(); return; }

  // Find the content layer in the parsed spec. CRITICAL: prefer the
  // overlay layer by NAME ('userContent' or unnamed first layer) — the
  // stage also contains _uiLayer (transformer) and the header layer,
  // and a naive "first layer with children" scan can pick the wrong
  // one when the overlay is empty but UI / header have nodes.
  const savedLayers = spec.children || [];
  const saved = savedLayers.find(l => l.className === 'Layer' && l.attrs?.name === 'sbs-overlay-content')
             || savedLayers.find(l => l.className === 'Layer' && !l.attrs?.name && (l.children || []).length > 0)
             || savedLayers.find(l => l.className === 'Layer' && (l.children || []).length > 0)
             || savedLayers[0];
  if (!saved) { _layer.batchDraw(); return; }

  // Build every node FULLY (await async raster) before adding it to the
  // layer. Adding a Konva.Image to the layer before its image is set
  // means Konva tries to draw a node with no image — usually fine, but
  // when paired with a stale 0-dim attrs.image it throws "0 width or
  // height" inside Konva's draw loop. Awaiting eliminates that race
  // entirely and is what addTextBox / addImage already do for new nodes.
  for (const childSpec of (saved.children || [])) {
    const node = await _recreateNode(childSpec);
    if (myToken !== _loadToken) return;   // a newer load superseded us
    if (node) {
      _layer.add(node);
      _attachNode(node);
    }
  }
  // Heal the isInterface attr + re-derive bonded shapes from their % BEFORE the
  // first draw, so they appear at their correct positions immediately — no
  // load-at-old-position-then-snap. (Shapes are ALWAYS derived on load, so the
  // stored position is just a cache; fresh projects behave identically.)
  // getInterfaceNodes() finds interfaces by NAME; the attr heal lets the live
  // handlers (move-together, atDefault-clear, scale-sync) agree.
  for (const iface of getInterfaceNodes()) {
    if (!iface.getAttr('isInterface')) iface.setAttr('isInterface', true);
    syncBondedShapes(iface);
  }
  // 📌 V0.3.2.98 — constant text boxes snap home on every step load: the
  // definition's anchor position + style are re-asserted (width stays this
  // instance's own). A missing definition leaves the box as a normal one.
  for (const n of _layer.getChildren()) {
    if (!n.getAttr?.('constId')) continue;
    const def = _constDefOf(n);
    if (def) _applyConstToNode(n, def);
  }
  _layer.batchDraw();
  // S2: start image-sequence playback now that the step's overlay is loaded +
  // visible (this runs after the step transition). No-op in edit mode / no seqs.
  _startSequences();
  // 🎬 V0.3.2.75 — same moment for video: play each clip from its trim-in
  // point. Clips on steps that aren't on screen stay parked (never decoding),
  // because the previous step's elements were released just above.
  // AWAITED since V0.3.2.82: the load promise (waitForOverlayStable) must
  // cover video-element readiness, or the export's first frames capture the
  // node before its decoder has a frame — the "blinks in" half of the bug.
  const _videoNodes = _layer.getChildren().filter(n => videoOverlay.isVideoNode(n));
  await videoOverlay.startVideos(_videoNodes);
  // 🩹 LAZY POSTER HEAL (V0.3.2.95 — the .94 attempt did this INSIDE the
  // attach path and destabilised live playback; reverted). Out-of-band and
  // fire-and-forget instead: a poster whose recorded frame (posterAtMs)
  // doesn't match the current trim-in is re-captured via refreshPoster
  // (which seeks, snapshots, and RESTORES the position) after the step has
  // fully loaded. Heals the stale "source second 0" fade-in slates without
  // touching element lifecycle or timing.
  for (const vn of _videoNodes) {
    const inMs = Math.max(0, Number(vn.getAttr('trimInMs') ?? 0));
    if (Number(vn.getAttr('posterAtMs') ?? -1) !== inMs) {
      videoOverlay.refreshPoster(vn).then(ok => {
        if (ok) { vn.setAttr('posterAtMs', inMs); _scheduleSave(); }
      }).catch(() => { /* cosmetic */ });
    }
  }
  // V0.3.2.84 — clips park until triggered. With an overlay fade in flight,
  // the phase engine triggers playback when the fade COMPLETES (fade lands
  // on the frozen first frame). Without one (anim string has no overlay
  // slot → this load runs post-animation), start immediately: the clip
  // plays during the hold, which the duration model sizes to fit.
  if (!_activeFade) videoOverlay.beginPlayback();
}

async function _recreateNode(spec) {
  if (!spec) return null;
  if (spec.className === 'Text')  return new Konva.Text({ ...spec.attrs, draggable: true });

  // Primitive shapes — reconstruct with the same draggable + transformend
  // hook the add* factories install, so dragging + resizing behave
  // identically to a fresh add after step re-entry.
  const SHAPE_CLASSES = { Rect: 'rect', Circle: 'circle', Ellipse: 'ellipse', RegularPolygon: 'triangle', Line: 'line', Arrow: 'arrow' };
  if (SHAPE_CLASSES[spec.className]) {
    const Cls = Konva[spec.className];
    const node = new Cls({ ...spec.attrs, draggable: true });
    _wireShapeTransformend(node, SHAPE_CLASSES[spec.className]);
    return node;
  }

  if (spec.className === 'Image') {
    // `image` is stripped defensively. Konva 9 toObject filters non-plain
    // objects out of attrs (so HTMLCanvasElement / HTMLImageElement do not
    // round-trip through toJSON in current builds), but older saves or
    // future Konva versions might leak one through — and even an empty `{}`
    // here fails the next draw with a 0×0 error.
    const { src, textHtml, textWidth, naturalW, naturalH, fillColor, styleId, image, ...rest } = spec.attrs || {};
    void image;   // intentionally discarded

    // 🎬 VIDEO (V0.3.2.75). The clip is a file on disk, so recreation is:
    // build the node, show the poster frame immediately (so the step never
    // renders an empty box), then attach the <video> element in the
    // background. A missing/undecodable file leaves the poster in place and
    // reports once — the step stays usable and the link is repairable.
    if (spec.attrs?.isVideo) {
      const vnode = new Konva.Image({ ...rest, draggable: true });
      if (Number.isFinite(naturalW)) vnode.setAttr('naturalW', naturalW);
      if (Number.isFinite(naturalH)) vnode.setAttr('naturalH', naturalH);
      const poster = spec.attrs.posterSrc;
      if (poster) {
        _loadImage(poster).then(img => {
          if (vnode.isDestroyed?.()) return;
          // V0.3.2.85 — the poster is a PLACEHOLDER only. It loads async and
          // could land AFTER the video element bound, replacing live footage
          // with a still — one source of the export's "wrong image in the
          // fade". Never clobber a bound element.
          if (vnode.image() instanceof HTMLVideoElement) return;
          vnode.image(img);
          vnode.getLayer()?.batchDraw();
        }).catch(() => { /* poster is a nicety, not a requirement */ });
      }
      videoOverlay.attachVideoElement(vnode)
        .then(() => vnode.getLayer()?.batchDraw())
        .catch(e => console.warn('[overlay] video not loaded:', e?.message));
      return vnode;
    }

    const node = new Konva.Image({ ...rest, draggable: true });
    if (Number.isFinite(naturalW)) node.setAttr('naturalW', naturalW);
    if (Number.isFinite(naturalH)) node.setAttr('naturalH', naturalH);
    if (fillColor)                 node.setAttr('fillColor', fillColor);
    if (styleId)                   node.setAttr('styleId', styleId);
    if (textHtml) {
      node.setAttr('textHtml',  textHtml);
      node.setAttr('textWidth', textWidth);
      // textWidth is the user-dragged width persisted as a CUSTOM attr —
      // Konva's toJSON treats custom attrs as load-bearing and preserves
      // them, while the built-in `width` is sometimes dropped on
      // serialization (default-attr elision). Reading it back into
      // node.width() before _reflowTextBox runs guarantees the raster
      // re-wraps at the right width on step revisit; otherwise the
      // 400px fallback inside _reflowTextBox kicks in and the box
      // visibly snaps back to default width every time the user
      // navigates away and back.
      if (Number.isFinite(textWidth) && textWidth > 0) {
        node.width(textWidth);
      }
      // AWAIT the raster — see _loadFromActiveStep comment. _reflowTextBox
      // sets node.image(canvas) once the SVG-foreignObject paints. If we
      // don't await, the layer can render the node before the image lands.
      try { await _reflowTextBox(node); }
      catch (e) { console.warn('[overlay] text rasterize failed', e); }
    } else if (src) {
      node.setAttr('src', src);
      try {
        const img = await _loadImage(src);
        node.image(img);
        if (!Number.isFinite(node.getAttr('naturalW'))) node.setAttr('naturalW', img.width);
        if (!Number.isFinite(node.getAttr('naturalH'))) node.setAttr('naturalH', img.height);
      } catch (e) { console.warn('[overlay] image load failed', e); }
    }
    return node;
  }
  return null;
}

// ─── Video-export compositing (used by Phase 2b) ───────────────────────────

/**
 * Rasterize the current overlay to a canvas sized to fit the given width
 * (or height) while preserving aspect. Returns null if there's nothing on
 * the overlay. Does not mutate the live stage.
 *
 * @param {{width?:number, height?:number}} [opts]
 */
export function rasterizeOverlay(opts = {}) {
  if (!_stage) return null;
  // Composite the GHOST layer (outgoing content, fading OUT during a step
  // crossfade) UNDER the main layer (incoming, fading IN) — matching the live
  // stage z-order (added ghost-then-layer). Previously only _layer was rasterised,
  // so on EXPORT the outgoing overlay vanished the instant it moved to the ghost
  // layer (the one-frame fade-out cut), while fade-in still worked. The _uiLayer
  // (transformer/selection) is intentionally excluded. layer.toCanvas bakes each
  // layer's own opacity — that's what drives the fade — so no extra alpha needed.
  // In steady state the ghost layer is empty, so this is a no-op vs. before.
  const layers = [_ghostLayer, _layer].filter(l => l && l.getChildren().length > 0);
  if (!layers.length) return null;
  if (typeof window !== 'undefined' && window.sbsDiag?.videoExportTrace && _ghostLayer?.getChildren().length) {
    _vtraceRastN = (_vtraceRastN || 0) + 1;
    if (_vtraceRastN % 8 === 1) {
      console.log(`[vtrace] rasterizeOverlay: layers=[${layers.map(l => l === _ghostLayer ? `ghost(op=${l.opacity().toFixed(2)},n=${l.getChildren().length})` : `main(op=${l.opacity().toFixed(2)},n=${l.getChildren().length})`).join(', ')}]`);
    }
  }

  // Render at the project's CANONICAL size (state.export.width × height).
  // Konva's layer.toCanvas inherits the stage transform, so the live stage.scale
  // (safeFrame / canonical) would offset node positions — zero it for the raster,
  // then restore.
  const c = getCanonicalSize();
  const targetW = opts.width  || c.width;
  const pixelRatio = targetW / c.width;

  // V0.3.2.90 — DOES layer.toCanvas bake the layer's own opacity? The old
  // comment above asserted yes; the exported fade-out (ghost layer alone,
  // full opacity for the whole window, then a cut) says otherwise. Instead
  // of trusting either claim, PROBE Konva once at runtime: render a
  // half-opacity test layer, read the pixel back. If baking is real,
  // nothing changes; if it isn't, we apply each layer's opacity ourselves
  // via globalAlpha. Either way the compensation can't double-apply.
  if (_konvaBakesLayerOpacity === null) {
    _konvaBakesLayerOpacity = _probeLayerOpacityBaking();
    console.log(`[overlay] probe: layer.toCanvas ${_konvaBakesLayerOpacity ? 'BAKES layer opacity — no compensation' : 'does NOT bake layer opacity — compensating with globalAlpha'}`);
  }

  const savedScale = _stage.scale();
  const savedPos   = _stage.position();
  _stage.scale({ x: 1, y: 1 });
  _stage.position({ x: 0, y: 0 });
  let out = null;
  try {
    // Always composite through one output canvas (the old single-layer
    // shortcut returned layer.toCanvas() RAW, which skipped any chance of
    // applying the layer's opacity when Konva doesn't bake it).
    out = document.createElement('canvas');
    out.width  = Math.round(c.width  * pixelRatio);
    out.height = Math.round(c.height * pixelRatio);
    const octx = out.getContext('2d');
    for (const lyr of layers) {
      const lc = lyr.toCanvas({ x: 0, y: 0, width: c.width, height: c.height, pixelRatio });
      octx.globalAlpha = _konvaBakesLayerOpacity ? 1 : Math.max(0, Math.min(1, lyr.opacity()));
      octx.drawImage(lc, 0, 0);
    }
    octx.globalAlpha = 1;
    // 🔬 V0.3.2.92 — sample what actually LEFT this function: the alpha of
    // the composited output at the frame centre while a ghost fade is live.
    // If this alpha never ramps, the fade dies HERE; if it ramps and the
    // final video still cuts, the bug is downstream in the frame composite.
    if (typeof window !== 'undefined' && window.sbsDiag?.videoExportTrace && _ghostLayer?.getChildren().length) {
      _vtracePxN = (_vtracePxN || 0) + 1;
      if (_vtracePxN % 8 === 1) {
        try {
          const px = octx.getImageData(Math.floor(out.width / 2), Math.floor(out.height / 2), 1, 1).data;
          console.log(`[vtrace] OUT-PIXEL centre rgba=(${px[0]},${px[1]},${px[2]},${px[3]}) ghostOp=${_ghostLayer.opacity().toFixed(2)} mainOp=${_layer.opacity().toFixed(2)} bakes=${_konvaBakesLayerOpacity}`);
        } catch (e) { console.log('[vtrace] OUT-PIXEL read failed:', e?.message); }
      }
    }
  } finally {
    _stage.scale(savedScale);
    _stage.position(savedPos);
  }
  return out;
}

// ─── Internals ─────────────────────────────────────────────────────────────

function _onKeyDown(e) {
  if (!_editing) return;
  // Escape cancels an armed zoom-region draw (un-freezes dragging).
  if (e.key === 'Escape' && _zoomDraw) { _cancelZoomDraw(); e.preventDefault(); return; }
  // Don't intercept anything while typing in any editable. Browsers'
  // native Ctrl+C / Ctrl+V handle text selection inside contenteditable.
  const ae = document.activeElement;
  if (ae && (['INPUT','TEXTAREA'].includes(ae.tagName) || ae.isContentEditable)) return;
  if (_activeTextEditor) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (deleteSelected()) e.preventDefault();
    return;
  }

  // Layer ordering — only when an overlay node is selected. Headers
  // live on a separate Konva.Layer so they're always above content;
  // these shortcuts shuffle within the content layer only.
  //   PageUp   → up one
  //   PageDown → down one
  //   Home     → to front (within content layer)
  //   End      → to back  (within content layer)
  if (['PageUp','PageDown','Home','End'].includes(e.key)) {
    const sel = _transformer?.nodes() || [];
    if (!sel.length) return;
    e.preventDefault();
    if (_reorderSelection(e.key, sel)) {
      _layer.batchDraw();
      _scheduleSave();
    }
    return;
  }

  // Clipboard shortcuts for overlay NODES (textboxes, images). Only fire
  // when nothing is being typed — guard above bails on contenteditable.
  // Paste / Duplicate are async (recreating a textbox awaits its raster),
  // so we check clipboard / selection sync to decide whether to swallow
  // the key, then fire-and-forget the async work.
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'c') { if (_copyToOverlayClipboard()) e.preventDefault(); return; }
  if (k === 'v') {
    const inPlace = !!e.altKey;            // Ctrl+Alt+V → paste in place
    if (_overlayClipboard?.length) {
      e.preventDefault();
      _pasteFromOverlayClipboard({ inPlace });
    }
    return;
  }
  if (k === 'd') {
    if (_transformer?.nodes()?.length) {
      e.preventDefault();
      _duplicateSelected();
    }
    return;
  }
}

function _editText(node) {
  // Minimal inline text editor — a floating <textarea> over the node.
  const pos  = node.getAbsolutePosition();
  const area = document.createElement('textarea');
  area.value = node.text();
  area.style.cssText = [
    'position:absolute',
    `left:${pos.x}px`, `top:${pos.y}px`,
    `width:${Math.max(node.width(), 120)}px`,
    `font-size:${node.fontSize()}px`,
    `font-family:${node.fontFamily()}`,
    `color:${node.fill()}`,
    'background:rgba(0,0,0,0.6)',
    'border:1px solid #f59e0b',
    'padding:4px',
    'z-index:9999',
    'resize:both',
  ].join(';');
  _container.appendChild(area);
  area.focus();
  area.select();

  const commit = () => {
    node.text(area.value);
    area.remove();
    _layer.batchDraw();
    _scheduleSave();
  };
  area.addEventListener('blur', commit);
  area.addEventListener('keydown', e => {
    if (e.key === 'Escape') { area.remove(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { commit(); }
  });
}

function _fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Rasterize a chunk of HTML to an HTMLCanvasElement via an inline SVG
 * `<foreignObject>`. Inline styles only — nothing from the host page leaks
 * in, so the rendering is deterministic and safe to export.
 *
 * @param {string} html  — HTML markup for the text box body
 * @param {{width?:number, height?:number, padding?:number, fontFamily?:string, fontSize?:number, color?:string}} [opts]
 *   - height: when supplied, the canvas is exactly this tall and content
 *     that overflows is clipped (overflow:hidden). Without it, the
 *     canvas auto-fits to whatever height the content needs at `width`.
 * @returns {Promise<HTMLCanvasElement|null>}
 */
/**
 * Whitelist sanitiser for HTML produced by the in-place text editor —
 * runs at COPY time, so anything pasted between SBS textboxes is
 * guaranteed to be safe for the SVG-foreignObject rasteriser.
 *
 * Allowed tags  : div, p, br, span, b, i, u, s, strong, em
 * Allowed styles: color, background-color, font-size, font-family,
 *                 font-weight, font-style, text-decoration, text-align
 *
 * Everything else is unwrapped (children promoted) or stripped.
 * Class / id / data-* attributes are dropped. Original visual look is
 * preserved for the formatting we actually support; cosmetic loss is
 * acceptable for things we can't render anyway.
 */
function _sanitiseTextboxHtml(html) {
  const ALLOWED_TAGS = new Set(['DIV', 'P', 'BR', 'SPAN', 'B', 'I', 'U', 'S', 'STRONG', 'EM']);
  // background-color is INTENTIONALLY excluded. Web sources love to put
  // a highlight colour on copied spans (search-result highlight, syntax
  // highlighting, banner backgrounds). Pasting that into a textbox left
  // visible coloured rectangles around the imported text that the user
  // had no way to remove. Textbox fill (the user-facing "background"
  // feature) is a node-level attr, not inline CSS, so dropping
  // background-color here doesn't affect it.
  const ALLOWED_STYLES = [
    'color',
    'font-size', 'font-family', 'font-weight', 'font-style',
    'text-decoration', 'text-align',
  ];

  // Strip clipboard wrapper artefacts before parsing. Chrome and Word
  // routinely wrap clipboard payloads in <!--StartFragment-->,
  // <meta charset='utf-8'>, <html><body>, doctypes, etc. The SVG-
  // foreignObject rasteriser falls over on those — leaving them in
  // was a major cause of "paste shows up live but doesn't apply".
  const cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g,         '')   // HTML comments
    .replace(/<\?[\s\S]*?\?>/g,           '')   // <?xml ...?> processing instructions
    .replace(/<!doctype[^>]*>/gi,         '')   // doctype
    .replace(/<meta\b[^>]*>/gi,           '')   // <meta charset=...>
    .replace(/<\/?(html|body|head)\b[^>]*>/gi, '');

  const tmp = document.createElement('div');
  tmp.innerHTML = cleaned;

  // Promote legacy <font color="..." face="..." size="..."> to
  // <span style="color:...;font-family:...;font-size:...">. Chromium's
  // execCommand still produces <font> in some configurations, and old
  // clipboard payloads carry it. Without this, the allowlist below
  // would unwrap <font> entirely and lose the styling.
  const SIZE_PX = { 1: 10, 2: 12, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
  tmp.querySelectorAll('font').forEach(f => {
    const span = document.createElement('span');
    const styles = [];
    const c = f.getAttribute('color');
    const fc = f.getAttribute('face');
    const sz = f.getAttribute('size');
    if (c)  styles.push(`color:${c}`);
    if (fc) styles.push(`font-family:${fc}`);
    if (sz && SIZE_PX[sz]) styles.push(`font-size:${SIZE_PX[sz]}px`);
    if (styles.length) span.setAttribute('style', styles.join(';'));
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
  });

  function clean(node) {
    if (node.nodeType === 3) return;       // text node — keep as-is
    if (node.nodeType !== 1) { node.remove(); return; }

    if (!ALLOWED_TAGS.has(node.tagName)) {
      // Unwrap: promote children, drop the wrapper.
      const parent = node.parentNode;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
      return;
    }

    // Stash allowed inline styles, then strip every attribute and
    // re-apply just the kept styles. Removes class, id, data-*, and
    // any unsafe inline declarations in one pass.
    const keep = {};
    for (const prop of ALLOWED_STYLES) {
      const v = node.style?.getPropertyValue(prop);
      if (v) keep[prop] = v;
    }
    for (let i = node.attributes.length - 1; i >= 0; i--) {
      node.removeAttribute(node.attributes[i].name);
    }
    if (Object.keys(keep).length) {
      const styleStr = Object.entries(keep).map(([k, v]) => `${k}:${v}`).join(';');
      node.setAttribute('style', styleStr);
    }

    // Recurse into children (snapshot first — clean() may remove nodes).
    Array.from(node.childNodes).forEach(clean);
  }
  Array.from(tmp.childNodes).forEach(clean);
  return tmp.innerHTML;
}

/**
 * Trim block-level padding that browsers stuff around clipboard payloads.
 *
 * When the user copies "hello" from inside another textbox, the browser's
 * cloneContents() often returns:
 *   <div>hello</div>
 * (the line's wrapper div, plus possibly empty <div><br></div> on either
 * side). insertHTML drops that block-level structure where the caret is,
 * which forces line breaks before AND after — the user sees an extra
 * empty line above and below the pasted text.
 *
 * This helper:
 *   • drops leading / trailing empty blocks (<div><br></div>, <p><br></p>)
 *   • unwraps a single outer <div> / <p> wrapper, so a one-line paste
 *     stays inline with the caret's current line.
 *
 * Multi-line pastes (multiple top-level blocks) are left as-is — the
 * line-break behaviour is intentional in that case.
 */
/**
 * Insert sanitised HTML at the contenteditable's current caret /
 * selection via the Selection API. Replacement for execCommand(
 * 'insertHTML', ...) which silently drops inline styles in some
 * Chromium builds.
 *
 * Caret is left immediately after the inserted content so the user
 * can continue typing where the paste ended.
 */
function _insertHtmlAtCaret(editor, html) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;

  // Replace the selection with the new content.
  range.deleteContents();

  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  const frag = document.createDocumentFragment();
  let last = null;
  while (tmp.firstChild) last = frag.appendChild(tmp.firstChild);
  range.insertNode(frag);

  // Move the caret to just after the inserted content.
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function _trimPasteBlocks(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';

  const isEmpty = (el) => {
    if (!el) return false;
    // Whitespace-only text nodes
    if (el.nodeType === 3) return !el.textContent.trim();
    if (el.nodeType !== 1) return false;
    // Bare <br> at the boundary
    if (el.tagName === 'BR') return true;
    // <div>/<p> with nothing visible inside (just whitespace or <br>s)
    if (/^(DIV|P)$/.test(el.tagName) &&
        !el.textContent.trim() &&
        !el.querySelector('img,svg,input,canvas')) {
      return true;
    }
    return false;
  };

  const stripBoundaries = () => {
    while (tmp.firstChild && isEmpty(tmp.firstChild)) tmp.removeChild(tmp.firstChild);
    while (tmp.lastChild  && isEmpty(tmp.lastChild))  tmp.removeChild(tmp.lastChild);
  };

  // Iterative unwrap. Each pass strips boundary padding and, if there's
  // still exactly one outer block wrapper containing only inline content
  // (no nested div/p), promotes its children up. Repeat — sometimes
  // clipboard payloads nest several wrappers (e.g. <div><div><div>text)
  // and we want the innermost text to land flat.
  let safety = 5;
  while (safety-- > 0) {
    stripBoundaries();
    if (tmp.children.length === 1 &&
        /^(DIV|P)$/.test(tmp.firstElementChild.tagName) &&
        !tmp.firstElementChild.querySelector('div,p')) {
      const only = tmp.firstElementChild;
      while (only.firstChild) tmp.insertBefore(only.firstChild, only);
      only.remove();
      continue;   // strip again, look for the next layer
    }
    break;
  }
  return tmp.innerHTML;
}

/**
 * Strip every inline style EXCEPT text-align from a HTML fragment.
 * Used when rendering style-template-bound text boxes — the template
 * dictates colour / font / size / weight / etc., but per-line alignment
 * is the user's per-box choice and survives.
 */
function _stripInlineStylingExceptAlign(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = String(html || '');
  tmp.querySelectorAll('[style]').forEach(el => {
    const align = el.style.textAlign;
    el.removeAttribute('style');
    if (align) el.style.textAlign = align;
  });
  // Drop legacy <font>/<u>/<s> entirely — template handles these.
  tmp.querySelectorAll('font,u,s,strike').forEach(el => {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
  return tmp.innerHTML;
}

/**
 * Public re-export so other systems (header.js) can rasterise their
 * own HTML through the same SVG-foreignObject path the overlay uses.
 * Same options + same XHTML normalisation, no duplication.
 */
export function htmlToCanvas(html, opts = {}) {
  return _htmlToCanvas(html, opts);
}

async function _htmlToCanvas(html, opts = {}) {
  const {
    width      = 400,
    height,                          // explicit height → fixed canvas, content clips
    padding    = 8,
    fontFamily = 'Arial',
    fontSize   = 16,
    color      = '#ffffff',
    bgColor    = 'transparent',      // textbox fill — rgba string preferred
    fontWeight = 'normal',           // style-template overrides
    fontStyle  = 'normal',
    textDecoration = '',
  } = opts;

  // XHTML normalisation. SVG foreignObject parses its inner content as
  // XHTML, which is strict about void elements:
  //   • Chromium's contenteditable emits <br> (HTML5 form). In XHTML,
  //     an unclosed <br> is treated as an opening tag and CONSUMES every
  //     sibling after it until the parent closes — so an empty line
  //     followed by more text would visually drop the second part.
  //   • An empty <div></div> renders zero-height in SVG, swallowing what
  //     the user intended as a blank line.
  // Also strip zero-width spaces — the toolbar uses them as caret-style
  // placeholders when a font-size / colour is picked with no selection
  // (so the next typed character lands inside the styled span). Once
  // the user has typed the actual character, the ZWSP has done its
  // job and can be removed; if they didn't type anything, the empty
  // wrapper is removed by the cleanup pass and the ZWSP goes with it.
  // Either way, the rasterised output should never contain ZWSPs —
  // they're invisible in the editor but can confuse downstream
  // shaping / line-break logic in the SVG renderer.
  html = String(html || '')
    .replace(/[​﻿]/g,             '')
    .replace(/<br(\s[^>]*)?>/gi,            '<br$1/>')
    .replace(/<hr(\s[^>]*)?>/gi,            '<hr$1/>')
    .replace(/<img(\s[^>]*)?>/gi,           '<img$1/>')
    .replace(/<div(\s[^>]*)?><\/div>/gi,    '<div$1><br/></div>')
    .replace(/<p(\s[^>]*)?><\/p>/gi,        '<p$1><br/></p>');

  let h;
  if (typeof height === 'number' && Number.isFinite(height)) {
    h = Math.max(1, Math.round(height));
  } else {
    // Auto-fit height by measuring an off-screen div at the same width.
    const host = document.createElement('div');
    host.style.cssText = [
      'position:absolute', 'left:-99999px', 'top:0',
      `width:${width}px`,
      `padding:${padding}px`,
      `color:${color}`,
      `font-family:${fontFamily}`,
      `font-size:${fontSize}px`,
      'box-sizing:border-box',
      'white-space:pre-wrap',
      'word-wrap:break-word',
      'line-height:1.2',
    ].join(';');
    host.innerHTML = html;
    document.body.appendChild(host);
    h = Math.max(1, Math.ceil(host.getBoundingClientRect().height));
    document.body.removeChild(host);
  }

  // 2. Wrap the same markup inside an SVG foreignObject at the measured /
  //    requested size. overflow:hidden lets the box clip content when the
  //    user drags height shorter than what the text would need — true
  //    text-frame behaviour rather than always growing to fit.
  const bodyStyle = [
    `width:${width}px`,
    `height:${h}px`,
    `padding:${padding}px`,
    `color:${color}`,
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    `font-weight:${fontWeight}`,
    `font-style:${fontStyle}`,
    `text-decoration:${textDecoration || 'none'}`,
    `background-color:${bgColor}`,
    'box-sizing:border-box',
    'white-space:pre-wrap',
    'word-wrap:break-word',
    'line-height:1.2',
    'overflow:hidden',
  ].join(';');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">` +
      `<foreignObject width="${width}" height="${h}">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="${bodyStyle}">${html}</div>` +
      `</foreignObject>` +
    `</svg>`;
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  let img;
  try { img = await _loadImage(dataUrl); }
  catch (e) { console.warn('[overlay] html rasterize load failed', e); return null; }

  const canvas = document.createElement('canvas');
  // Browser coerces canvas.width/height = NaN → 0. Force-clamp to sane
  // minimums here, so callers downstream never see a 0-sized canvas
  // even if `width` / `h` came in mangled.
  canvas.width  = (Number.isFinite(width) && width > 0) ? width : 20;
  canvas.height = (Number.isFinite(h)     && h     > 0) ? h     : 1;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}
