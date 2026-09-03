/**
 * SBS — Header overlay (project-level).
 * ─────────────────────────────────────
 * A second Konva stage stacked above the per-step overlay. Header items
 * are stored ONCE in `state.headerItems[]` (project-level) and rendered
 * on every step's view via this dedicated layer. No per-step duplication.
 *
 * Header item shape (HeaderItem):
 *   {
 *     id:        string,           // generated, stable
 *     kind:      'custom' | 'stepName' | 'stepNumber' | 'chapterName' | 'chapterNumber' | 'image' | 'chapterProgress',
 *     visible:   boolean,          // hide toggle (order preserved)
 *     x:         number,           // px (relative to render canvas, top-left origin)
 *     y:         number,
 *     w:         number,
 *     h:         number,
 *     // — text-only —
 *     text?:     string,           // for 'custom'; the dynamic kinds compute text live
 *     fontSize?: number,
 *     fontWeight?: 'normal' | 'bold',
 *     fontStyle?:  'normal' | 'italic',
 *     color?:    string,           // hex
 *     align?:    'left' | 'center' | 'right',
 *     textHtml?: string,           // P3: rich-text override produced by the canvas
 *                                  //  editor on dblclick. When set (custom kind only),
 *                                  //  render uses it verbatim and the field-driven
 *                                  //  styling above becomes inactive — the user has
 *                                  //  taken the styling control onto the canvas.
 *     // — image-only —
 *     dataUrl?:  string,           // inline base64 (kept inside .sbsproj for now)
 *     naturalW?: number,
 *     naturalH?: number,
 *   }
 *
 * Dynamic kinds resolve their text against the *active* step (and its
 * chapter) at render time, not at edit time. So a stepName header on
 * step 1 says "Intro", switches to "Detail A" on step 2, etc., without
 * any per-step copy.
 *
 * Rendering: the layer is rasterised to a canvas via rasterizeHeader(w,h)
 * for export and thumbnails. Live in-app rendering is handled by the
 * Konva stage attached to a dedicated DOM container (initHeaderLayer).
 *
 * Updates ripple via state events:
 *   • change:headerItems       → re-render
 *   • change:activeStepId      → re-render dynamic kinds
 *   • step:rename / chapter:rename → re-render dynamic kinds
 */

import { state }            from '../core/state.js';
import { generateId }       from '../core/schema.js';
import { htmlToCanvas, enterTextEditor } from './overlay.js';   // P2/P3: shared rasteriser + editor
import * as subtitles       from './subtitles.js';              // 🌐 per-step subtitle overrides + translation (V0.3.2.63)
import { setStatus }        from '../ui/status.js';             // chip-refresh feedback
import { registerLayer, getLayerSelection, scheduleOverlaySave } from './cross-layer.js';
import { getStyleTemplate } from './style-templates.js';        // P4b: per-item style binding
import { textEffectsCss }   from './text-effects.js';           // V0.3.2.149: shadow/outline from the bound style
import { undoManager }      from './undo.js';                   // P7-C: drag / resize undo entries
import { chapterProgressSpan } from './narration-timeline.js';  // chapter progress bar (#15)
import { sceneCore }        from '../core/scene.js';             // tick hook drives the continuous fill
import * as clock           from '../core/clock.js';             // synthetic during export, wall live

// ─── Pure data helpers (no DOM / Konva — usable from export, tests) ─────────

/**
 * Default values for a freshly-created header item of the given kind.
 *
 * P4b: per-item styling fields (fontSize / color / fontWeight / fontStyle)
 * are GONE. Styling now resolves through item.styleId:
 *   - '' or undefined          → project-level headerDefault
 *   - 'custom' (kind='custom')  → item.textHtml from canvas editor
 *   - <template-id>             → bound style template
 * Only `align` survives as a per-item field — driven by L/C/R buttons
 * in the row, defaults to 'left'.
 */
export function makeHeaderItem(kind = 'custom', opts = {}) {
  const base = {
    id:         generateId('hdr'),
    kind:       kind,
    visible:    true,
    x:          opts.x ?? 100,
    y:          opts.y ?? 40,
    w:          opts.w ?? 480,
    h:          opts.h ?? 64,
    styleId:    opts.styleId ?? '',          // '' = use headerDefault
    align:      opts.align   ?? 'left',      // per-item L/C/R
  };
  if (kind === 'image') {
    return {
      ...base,
      dataUrl:  opts.dataUrl  || null,
      naturalW: opts.naturalW || null,
      naturalH: opts.naturalH || null,
    };
  }
  if (kind === 'custom') {
    return { ...base, text: opts.text ?? 'Header' };
  }
  // Chapter progress bar (backlog #15) — a track that fills left→right as the
  // active chapter advances (time-weighted, empty at chapter start, full at its
  // last step, resets on the next chapter). Colors per-item so future UI can
  // restyle; defaults = the user's spec (white track, blue fill).
  if (kind === 'chapterProgress') {
    return {
      ...base,
      w: opts.w ?? 420,
      h: opts.h ?? 12,
      text: '',
      trackColor: opts.trackColor ?? 'rgba(255,255,255,0.4)',
      fillColor:  opts.fillColor  ?? '#3b82f6',
    };
  }
  // 🎬 Subtitle (V0.3.2.57) — caption of the step's narration. Defaults to a
  // wide, bottom-centred band (canonical 1920×1080 frame) with a readable
  // semi-transparent backing (see _buildHeaderTextHtml); text WRAPS in the box.
  if (kind === 'subtitle') {
    return {
      ...base,
      x: opts.x ?? 260,
      y: opts.y ?? 930,
      w: opts.w ?? 1400,
      h: opts.h ?? 110,
      align: opts.align ?? 'center',
      text: '',
      subLang: opts.subLang ?? '',   // '' = original (voiceover); 'he' = Hebrew translation slot
      subDir:  opts.subDir  ?? 'auto', // 'auto' = per-line first-strong-char detection; 'rtl'/'ltr' = forced
    };
  }
  // Dynamic kinds — text computed live; we still keep a `text` slot as a
  // fallback for migrations / "no active step" edge cases.
  return { ...base, text: '' };
}

/**
 * Resolve the live text for a header item against an active step.
 * Pure function — no state reads; pass everything in. This is what
 * the export pipeline uses (it walks every step explicitly) and what
 * the live renderer uses (it passes the active step).
 */
export function resolveHeaderText(item, ctx) {
  if (!item) return '';
  switch (item.kind) {
    case 'custom':         return String(item.text ?? '');
    case 'stepName':       return String(ctx?.step?.name ?? '');
    case 'stepNumber':     return String(ctx?.stepIndex != null ? ctx.stepIndex + 1 : '');
    case 'chapterName':    return String(ctx?.chapter?.name ?? '');
    case 'chapterNumber':  return String(ctx?.chapterIndex != null ? ctx.chapterIndex + 1 : '');
    // 🎬 Subtitle (V0.3.2.57) — the step's spoken narration, VERBATIM. Resolves
    // against ctx.step (the group-effective step, like every other dynamic
    // header): a group plays ONE voiceover (the head's, overflowing across its
    // sub-steps), so the caption follows the head throughout — and live
    // playback and export stay identical.
    // V0.3.2.63: routed through the per-step OVERRIDE slot (hand-edits /
    // translations, keyed by item.subLang). No entry → falls back to the
    // live narration text, exactly the old behaviour.
    // V0.3.2.64: resolves against ctx.subtitleStep — inside a group, the
    // latest sub-step that SPEAKS owns the caption (head carries until then).
    case 'subtitle':       return subtitles.resolveSubtitleText(
                                    ctx?.subtitleStep || ctx?.step, item.subLang || '');
    case 'image':          return '';   // image kind has no text
    default:               return '';
  }
}

/**
 * Build the render context (active step + chapter ordinals) from current
 * state. Pure read; doesn't mutate. Useful both for the live renderer
 * and ad-hoc callers (status text, thumbnails-with-headers, etc.).
 *
 * stepIndex is computed against the USER-VISIBLE step list (no base
 * step, no hidden steps) to match the standard filter used everywhere
 * else in steps.js. Without this filter, the hidden __base__ step at
 * index 0 made every header "Step Number" off by one — the first
 * user step rendered as "Step 2".
 */
export function buildRenderContext(activeIdOverride) {
  const allSteps = state.get('steps') || [];
  const chapters = state.get('chapters') || [];
  // B4/M5 (V0.3.2.108): also exclude steps of HIDDEN CHAPTERS — this is
  // steps.js's _isPlayable rule, inlined (importing steps.js here would
  // close the steps → overlay → header cycle). Without it the numbers
  // burned into exported headers counted hidden chapters' steps ("Step 7"
  // for the 5th step the viewer sees).
  const chHidden = new Set(chapters.filter(c => c.hidden).map(c => c.id));
  const visible  = allSteps.filter(s => !s.hidden && !s.isBaseStep && !chHidden.has(s.chapterId));
  const activeId = activeIdOverride ?? state.get('activeStepId');   // override: assembly rasters per-step headers without activating (V0.3.2.8)
  // V0.3.2.114: an off-sequence active step (hidden, or inside a hidden
  // chapter) keeps its IDENTITY — name, chapter, subtitle — but gets NO
  // sequence number (handled below). Resolving it only against `visible`
  // left activeStep null while live-editing inside a hidden chapter, which
  // blanked the name and burned "Step 0" into the live header.
  const activeStep = visible.find(s => s.id === activeId)
                  || allSteps.find(s => s.id === activeId && !s.isBaseStep)
                  || null;

  // Step-groups: the header treats a group as ONE step. When a sub-
  // step is active, every dynamic header (stepName / stepNumber /
  // chapterName / chapterNumber) resolves against the head, not the
  // sub-step. So if Step 5 is a group with 4 sub-steps, the header
  // reads "Step 5 — first group" the entire time the group plays
  // (head + every sub-step), and the very next step shows "Step 6"
  // (NOT "Step 10" as the flat-array index would give).
  const effectiveStep = activeStep?.groupId
    ? (visible.find(s => s.id === activeStep.groupId)
       || allSteps.find(s => s.id === activeStep.groupId)   // off-sequence group head
       || activeStep)
    : activeStep;

  // TOP-LEVEL step index — sub-steps don't count toward stepNumber.
  // Walk visible[] once, increment only on non-sub-steps, snapshot the
  // counter when we reach the effective step.
  let topLevelIdx = -1;
  let topLevelCounter = 0;
  for (const s of visible) {
    if (!s.groupId) topLevelCounter++;
    if (effectiveStep && s.id === effectiveStep.id) {
      topLevelIdx = topLevelCounter - 1;
      break;
    }
  }

  // Per-chapter step index (Step Number restarts at 1 each chapter)
  // when the user has opted in via state.headerStepNumberPerChapter.
  // Default false → global top-level numbering.
  // V0.3.2.114: null (not -1) when the effective step isn't in the playable
  // sequence — resolveHeaderText renders '' for null but "0" for -1
  // (`stepIndex != null ? stepIndex + 1 : ''`), which is how a hidden
  // chapter's steps showed "Step 0" in the live header.
  const inSequence = !!effectiveStep && visible.some(s => s.id === effectiveStep.id);
  let stepIndex = inSequence ? topLevelIdx : null;
  if (inSequence && state.get('headerStepNumberPerChapter') && effectiveStep?.chapterId) {
    const chapterTopLevel = visible.filter(
      s => !s.groupId && s.chapterId === effectiveStep.chapterId,
    );
    const perCh = chapterTopLevel.findIndex(s => s.id === effectiveStep.id);
    stepIndex = perCh >= 0 ? perCh : null;
  }
  const chapterIndex = effectiveStep?.chapterId
    ? chapters.findIndex(c => c.id === effectiveStep.chapterId)
    : -1;
  const chapter  = chapterIndex >= 0 ? chapters[chapterIndex] : null;

  // 🌐 Subtitle-effective step (V0.3.2.64): the caption follows the LATEST
  // SPOKEN narration. The head's voiceover carries across its sub-steps
  // (one VO overflowing — the V0.3.2.57 rule), BUT a sub-step that speaks
  // its OWN narration takes the caption over from that sub-step onward,
  // matching what the viewer actually hears. Walk back from the active
  // sub-step to the head; first step with narration text wins; none → head.
  let subtitleStep = effectiveStep;
  if (activeStep && effectiveStep && activeStep.id !== effectiveStep.id) {
    const headIdx = visible.findIndex(s => s.id === effectiveStep.id);
    const actIdx  = visible.findIndex(s => s.id === activeStep.id);
    for (let i = actIdx; i > headIdx && i >= 0; i--) {
      const s = visible[i];
      if (s.groupId !== effectiveStep.id) break;   // safety: left the group
      if (String(s.narration?.text ?? s.voiceText ?? '').trim()) { subtitleStep = s; break; }
    }
  }
  return { step: effectiveStep, stepIndex, chapter, chapterIndex, subtitleStep };
}

// ── Chapter progress bar: CONTINUOUS fill (V0.3.1.80) ───────────────────────
// The bar animates linearly across the chapter's REAL duration instead of
// jumping per step. Each active step contributes its measured share of the
// chapter (startFrac→endFrac over durMs from chapterProgressSpan), so the rate
// is constant across step boundaries — one steady linear fill for the whole
// chapter. clock.now() is the SYNTHETIC clock during export (deterministic,
// keeps filling through narration holds — where most chapter time lives) and
// the wall clock live. Computed against the ACTIVE step id (not the group-
// effective one) so the fill advances through group sub-steps.
let _progressBars   = [];     // [{ canvas, item }] — live chapterProgress nodes this refresh
let _progressSpan   = null;   // { startFrac, endFrac, durMs } for the active step
let _progressStepId = null;
let _progressT0     = 0;
let _progressLastF  = -1;
let _progressTickOn = false;

function _syncProgressSpan() {
  const activeId = state.get('activeStepId');
  if (activeId === _progressStepId) return;   // mid-step refreshes keep the clock running
  _progressStepId = activeId;
  _progressT0     = clock.now();
  try { _progressSpan = chapterProgressSpan(activeId); } catch { _progressSpan = null; }
}
function _currentProgressFrac() {
  if (!_progressSpan) return 0;
  const { startFrac, endFrac, durMs } = _progressSpan;
  if (!(durMs > 0)) return endFrac;
  const a = Math.max(0, Math.min(1, (clock.now() - _progressT0) / durMs));
  return startFrac + a * (endFrac - startFrac);
}
function _drawProgressBar(cnv, item, frac) {
  const g = cnv.getContext('2d');
  const cw = cnv.width, chh = cnv.height;
  const r = Math.min(chh / 2, 12);            // canvas is 2× supersampled → 12 = 6px radius
  g.clearRect(0, 0, cw, chh);
  const rr = (w) => { g.beginPath(); g.roundRect(0, 0, w, chh, r); g.fill(); };
  g.fillStyle = item.trackColor || 'rgba(255,255,255,0.4)';
  rr(cw);
  const f = Math.max(0, Math.min(1, frac));
  if (f > 0) { g.fillStyle = item.fillColor || '#3b82f6'; rr(Math.max(r * 2, Math.round(cw * f))); }
}

// ─── State mutations (centralised so undo/redo and events stay in sync) ─────

/**
 * Add a header item at the end of the list. Returns the new item.
 * Caller is responsible for opening any editor / setting selection.
 */
export function addHeaderItem(kind = 'custom', opts = {}) {
  const item = makeHeaderItem(kind, opts);
  const items = (state.get('headerItems') || []).slice();
  items.push(item);
  state.setState({ headerItems: items });
  state.markDirty();
  return item;
}

/** Patch a header item by id. Pass partial fields. */
export function updateHeaderItem(id, patch) {
  const items = (state.get('headerItems') || []).map(it =>
    it.id === id ? { ...it, ...patch } : it,
  );
  state.setState({ headerItems: items });
  state.markDirty();
}

/** Remove a header item by id. */
export function removeHeaderItem(id) {
  const items = (state.get('headerItems') || []).filter(it => it.id !== id);
  state.setState({ headerItems: items });
  state.markDirty();
}

/** Move a header item by index delta (e.g. -1 = up, +1 = down). */
export function reorderHeaderItem(id, delta) {
  const items = (state.get('headerItems') || []).slice();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return;
  const target = Math.max(0, Math.min(items.length - 1, idx + delta));
  if (target === idx) return;
  const [moved] = items.splice(idx, 1);
  items.splice(target, 0, moved);
  state.setState({ headerItems: items });
  state.markDirty();
}

/** Toggle the 'visible' flag on a header item. Order is preserved. */
export function toggleHeaderItemVisible(id) {
  const items = (state.get('headerItems') || []).map(it =>
    it.id === id ? { ...it, visible: !it.visible } : it,
  );
  state.setState({ headerItems: items });
  state.markDirty();
}

/** Show / hide the entire header layer (export + live). Order preserved. */
export function setHeadersHidden(hidden) {
  state.setState({ headersHidden: !!hidden });
  state.markDirty();
}

/** Lock toggle — when locked, canvas-level interaction (drag/resize) is off. */
export function setHeadersLocked(locked) {
  state.setState({ headersLocked: !!locked });
  state.markDirty();
}

/**
 * Toggle per-chapter step numbering. When true, "Step Number" headers
 * restart at 1 in each chapter; when false they count globally across
 * all visible steps. Render listens via change:headerStepNumberPerChapter.
 */
export function setHeaderStepNumberPerChapter(on) {
  state.setState({ headerStepNumberPerChapter: !!on });
  state.markDirty();
}

/**
 * Patch the project-level header default styling. Used by the sidebar's
 * Default Style panel. Render listens via change:headerDefault and
 * re-rasterises every text-flavoured item.
 *
 * Pass any subset — only the keys present in `patch` are updated.
 */
export function setHeaderDefault(patch) {
  if (!patch || typeof patch !== 'object') return;
  const cur = state.get('headerDefault') || {};
  state.setState({ headerDefault: { ...cur, ...patch } });
  state.markDirty();
}

/**
 * Set the styleId binding on a header item. Convenience wrapper around
 * updateHeaderItem so the Style dropdown in the sidebar row has a
 * single, well-named entry point. Accepts:
 *   - ''         → use project headerDefault
 *   - 'custom'   → use item.textHtml (custom kind only; ignored otherwise)
 *   - <id>       → bind to a style template
 */
export function setHeaderItemStyleId(id, styleId) {
  updateHeaderItem(id, { styleId: styleId || '' });
}

/** Set the per-item alignment (L/C/R buttons). */
export function setHeaderItemAlign(id, align) {
  if (align !== 'left' && align !== 'center' && align !== 'right') return;
  updateHeaderItem(id, { align });
}

// ─── Live render layer (Konva) ──────────────────────────────────────────────

let _layer       = null;   // Konva.Layer
let _transformer = null;   // multi-select transformer for header items
let _stage       = null;   // borrowed from overlay.js
let _selection   = new Set();   // selected node ids (multi-select)
let _imageCache  = new Map();   // dataUrl → HTMLImageElement (so re-renders are cheap)
let _prevHdrCanonical    = null;   // last seen { width, height } for the rescale ratio
let _suppressRefreshOnce = false;  // set when rescale modifies live nodes directly

function _getHdrCanonical() {
  const exp = state.get('export') || {};
  const width  = (Number.isFinite(exp.width)  && exp.width  > 0) ? exp.width  : 1920;
  const height = (Number.isFinite(exp.height) && exp.height > 0) ? exp.height : 1080;
  return { width, height };
}

function _rescaleHeadersOnCanonicalChange() {
  const c = _getHdrCanonical();
  if (!_prevHdrCanonical) { _prevHdrCanonical = c; return; }
  const xR = c.width  / _prevHdrCanonical.width;
  const yR = c.height / _prevHdrCanonical.height;
  if (xR !== 1 || yR !== 1) {
    const aspectChanged = Math.abs(xR - yR) > 1e-4;
    const items = (state.get('headerItems') || []).map(it => {
      const isImage = it.kind === 'image';
      const wR = xR;
      const hR = isImage ? xR : yR;
      return {
        ...it,
        x: typeof it.x === 'number' ? it.x * xR : it.x,
        y: typeof it.y === 'number' ? it.y * yR : it.y,
        w: typeof it.w === 'number' ? it.w * wR : it.w,
        h: typeof it.h === 'number' ? it.h * hR : it.h,
      };
    });
    if (aspectChanged) {
      // Aspect change → let refreshHeaderLayer rebuild so text rasters
      // reflow into the new aspect.
      state.setState({ headerItems: items });
    } else {
      // Same-aspect resolution change → modify the live Konva nodes
      // directly and SUPPRESS the destroy-rebuild handler. Without
      // this, every header text gets re-rasterised on every same-
      // aspect resolution change, and auto-fit drift accumulates
      // each step. By skipping the rebuild, the source canvas stays
      // intact and Konva downsamples it through the inverse stage-
      // scale change — visual stays IDENTICAL, matching textboxes.
      _suppressRefreshOnce = true;
      state.setState({ headerItems: items });
      if (_layer) {
        for (const node of _layer.getChildren()) {
          if (node === _transformer) continue;
          const id = node.getAttr?.('headerId');
          if (!id) continue;
          const it = items.find(x => x.id === id);
          if (!it) continue;
          if (typeof node.x      === 'function') node.x(it.x);
          if (typeof node.y      === 'function') node.y(it.y);
          if (typeof node.width  === 'function') node.width(it.w);
          if (typeof node.height === 'function') node.height(it.h);
        }
        _layer.batchDraw();
      }
    }
  }
  _prevHdrCanonical = c;
}

/**
 * Attach a Konva.Layer to the overlay stage and start mirroring
 * state.headerItems[] onto it. Idempotent — second call is a no-op.
 *
 * Caller passes the live overlay stage (overlay.getStage()). The layer
 * sits ABOVE the per-step content + step-transformer layers, so headers
 * are always on top.
 */
export function initHeaderLayer(stage) {
  if (_layer || !stage || typeof Konva === 'undefined') return;
  _stage = stage;
  _layer = new Konva.Layer({ name: 'sbs-header' });
  stage.add(_layer);

  // Stage 3a: rescale every header item's x / y / w / h whenever the
  // canonical export size changes. Width changes drive the x + w
  // factor, height changes drive y + h, so aspect-ratio changes
  // stretch correctly per axis. Mirrors overlay.js' rescale.
  //
  // Coalesce via rAF — setExportOption emits change:export per key
  // and a preset switch fires three events back-to-back; without
  // batching, the middle event has width-changed-but-height-stale
  // and rescales as if it were an aspect change.
  _prevHdrCanonical = _getHdrCanonical();
  let _hdrRaf = 0;
  state.on('change:export', () => {
    if (_hdrRaf) return;
    _hdrRaf = requestAnimationFrame(() => {
      _hdrRaf = 0;
      _rescaleHeadersOnCanonicalChange();
    });
  });

  _transformer = new Konva.Transformer({
    rotateEnabled:    true,
    keepRatio:        true,
    enabledAnchors:   ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    anchorSize:       8,
    borderStroke:     '#22d3ee',   // cyan — distinguishes from step-overlay's amber
    anchorStroke:     '#22d3ee',
    anchorFill:       '#fff',
  });
  _layer.add(_transformer);

  // Click on empty stage → clear header selection too. Overlay already
  // wires its own stage-pointerdown to clear its selection; without
  // this, header items stayed selected (cyan transformer lingering)
  // after the user clicked away to deselect overlay nodes.
  stage.on('pointerdown', (e) => {
    if (e.target !== stage) return;
    if (_selection.size === 0) return;
    _selection.clear();
    _transformer.nodes([]);
    _layer.batchDraw();
  });

  // State subscriptions — anything that changes the rendered output triggers
  // a refresh. Cheap re-render: we destroy and recreate nodes each time.
  // Header lists are small (typically < 10 items); no need for diff-based
  // reconciliation.
  state.on('change:headerItems',    () => {
    // Same-aspect rescale already updated live Konva nodes — skip
    // the destroy-rebuild path once so the source rasters survive.
    if (_suppressRefreshOnce) { _suppressRefreshOnce = false; return; }
    refreshHeaderLayer();
  });
  state.on('change:headersHidden',  refreshHeaderLayer);
  state.on('change:headersLocked',  refreshHeaderLayer);
  state.on('change:headerDefault',  refreshHeaderLayer);   // P4a: items in default mode pick up new styling
  state.on('change:headerStepNumberPerChapter', refreshHeaderLayer);   // restart-per-chapter toggle
  state.on('change:styleTemplates', refreshHeaderLayer);   // P4b: items bound to a template re-render on template list change
  state.on('styleTemplate:updated', refreshHeaderLayer);   // P4b: header items bound to that template update too
  state.on('styleTemplate:removed', refreshHeaderLayer);   // P4b: items bound to a removed template fall back to default
  state.on('change:overlayEditing', refreshHeaderLayer);   // P1: header items become inert when overlay editing is off
  state.on('change:activeStepId',   refreshHeaderLayer);
  state.on('change:steps',          refreshHeaderLayer);
  state.on('change:chapters',       refreshHeaderLayer);
  state.on('header:refresh',        refreshHeaderLayer);   // explicit kick from step/chapter rename

  // Register with the cross-layer registry — overlay reads this to
  // include header siblings in combined multi-drag, and to persist
  // header positions after a cross-layer drag commits.
  // Continuous chapter-progress fill — tick-driven redraw of the bar canvases
  // (per synthetic frame during export, per rAF live). Redraws only on a
  // visible change (~0.2% of the bar) so idle cost is nil.
  if (!_progressTickOn) {
    _progressTickOn = true;
    sceneCore.addTickHook(() => {
      if (!_progressBars.length || !_progressSpan || !_layer) return;
      const f = _currentProgressFrac();
      if (Math.abs(f - _progressLastF) < 0.002) return;
      _progressLastF = f;
      for (const b of _progressBars) _drawProgressBar(b.canvas, b.item, f);
      _layer.batchDraw();
    });
  }

  registerLayer('header', {
    getSelection: () => {
      if (!_layer) return [];
      // Return only currently-selected real header items (filter out
      // the transformer node itself + any item not in _selection).
      return _layer.getChildren().filter(c =>
        c !== _transformer && _selection.has(c.getAttr?.('headerId'))
      );
    },
    persistFromNode: (n) => {
      const id = n?.getAttr?.('headerId');
      if (id) updateHeaderItem(id, { x: n.x(), y: n.y(), w: n.width(), h: n.height() });
    },
  });

  refreshHeaderLayer();
}

/**
 * DATA-DRIVEN header raster (V0.3.2.8 — render-cache assembly, slice 3c).
 * Draws every visible header item EXCEPT the progress bar (ffmpeg animates
 * that at assembly) onto a transparent canvas at the given size, resolving
 * dynamic text against the PASSED context — no live layer, no step
 * activation, no scene. Mirrors the live pipeline's sizing (htmlToCanvas at
 * item.w×item.h, drawn at item.x/item.y in canonical coordinates).
 * Returns the canvas, or null when headers are hidden / nothing to draw.
 */
export async function rasterizeHeaderDataToCanvas(ctx, { width = 1920, height = 1080 } = {}) {
  if (state.get('headersHidden')) return null;
  const items = (state.get('headerItems') || [])
    .filter(it => it.visible !== false && it.kind !== 'chapterProgress');
  if (!items.length) return null;
  const cnv = document.createElement('canvas');
  cnv.width = width; cnv.height = height;
  const g = cnv.getContext('2d');
  for (const item of items) {
    try {
      if (item.kind === 'image') {
        if (!item.dataUrl) continue;
        const img = await new Promise((res, rej) => {
          const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img load'));
          i.src = item.dataUrl;
        });
        g.drawImage(img, item.x, item.y, item.w, item.h);
      } else {
        const html = _buildHeaderTextHtml(item, ctx);
        const c = await htmlToCanvas(html, { width: Math.max(1, item.w | 0), height: Math.max(1, item.h | 0), padding: _headerFxExtent(item) });
        if (c?.width && c?.height) g.drawImage(c, item.x, item.y, item.w, item.h);
      }
    } catch (e) { console.warn('[header] data-raster item failed:', item.kind, e?.message); }
  }
  return cnv;
}

/**
 * Wipe + redraw every header item against the current state. Called on
 * every state change that could affect output. Selection is preserved
 * by id when the same nodes still exist after rebuild.
 */
export function refreshHeaderLayer() {
  if (!_layer) return;
  // Progress bars are rebuilt below; re-anchor the fill clock if the active
  // step changed (mid-step refreshes keep it running — no restart on restyle).
  _progressBars = [];
  _progressLastF = -1;
  _syncProgressSpan();

  // Track every async hydrate (text raster, image load) kicked off
  // by _buildNode during this refresh. waitForHeaderStable() returns
  // a promise that resolves once they all settle — video export
  // waits on it after each step transition so frames don't capture a
  // half-rendered header layer.
  _refreshPending = [];

  const prevSelection = new Set(_selection);
  // Remove all children except the transformer
  for (const child of _layer.getChildren().slice()) {
    if (child !== _transformer) child.destroy();
  }

  if (state.get('headersHidden')) {
    _transformer.nodes([]);
    _layer.batchDraw();
    _currentRefreshPromise = Promise.resolve();
    return;
  }

  const items   = state.get('headerItems') || [];
  const ctx     = buildRenderContext();
  const lock    = !!state.get('headersLocked');
  const editing = !!state.get('overlayEditing');
  // P1: header items are INERT (no drag, no select, no pointer events
  // at all) unless the overlay is in editing mode AND headers aren't
  // locked. Lock wins over edit mode — even with edit on, locked
  // headers stay frozen (the safety feature). When inert, Konva
  // listening:false makes clicks pass through to the stage.
  const inert   = lock || !editing;
  const newNodesById = new Map();

  for (const item of items) {
    if (!item?.visible) continue;
    const node = _buildNode(item, ctx, inert);
    if (!node) continue;
    _layer.add(node);
    newNodesById.set(item.id, node);
    // 🌐 Subtitle status chip (V0.3.2.63) — EDIT-MODE ONLY UI (inert mode
    // never builds it), and rasterizeHeaderLayer hides chips during export
    // snapshots, so it can never reach a rendered frame.
    if (item.kind === 'subtitle' && !inert) {
      const chip = _buildSubtitleChip(item, ctx);
      if (chip) _layer.add(chip);
    }
  }

  // Restore selection where the underlying item still exists — but
  // only when interaction is allowed; otherwise drop the selection so
  // the cyan transformer doesn't linger over an inert header.
  const restored = [];
  if (!inert) {
    for (const id of prevSelection) {
      const n = newNodesById.get(id);
      if (n) restored.push(n);
    }
  }
  _selection = new Set(restored.map(n => n.getAttr('headerId')));
  _transformer.nodes(restored);
  _layer.batchDraw();

  // Settle the tracked refresh promise once all hydrate promises
  // queued during _buildNode iterations complete.
  _currentRefreshPromise = Promise.all(_refreshPending.slice()).then(() => {});
  _refreshPending = [];
}

/** Resolves when the header layer has finished its latest async hydrates. */
export function waitForHeaderStable() {
  return _currentRefreshPromise;
}

let _currentRefreshPromise = Promise.resolve();
let _refreshPending        = [];

// Cache of the last rasterised text canvas per header item id. On a step-change
// rebuild we seed the new node with it as a PLACEHOLDER so the header keeps showing
// the previous text (right position) until the new async raster lands — instead of a
// one-frame blank ("header blink") that the offline export captured per frame.
const _headerImgCache = new Map();

/**
 * Build a single Konva node for a header item. Text → Konva.Text;
 * image → Konva.Image (with async dataUrl load). Returns null on bad
 * input.
 */
function _buildNode(item, ctx, inert) {
  if (item.kind === 'image') {
    const node = new Konva.Image({
      x: item.x,
      y: item.y,
      width:  item.w,
      height: item.h,
      draggable: !inert,
      listening: !inert,
      name: 'sbs-header-item',
    });
    node.setAttr('headerId',   item.id);
    node.setAttr('headerKind', item.kind);
    node.setAttr('naturalW',   item.naturalW || null);
    node.setAttr('naturalH',   item.naturalH || null);
    if (!inert) _attachItemHandlers(node, item);
    if (item.dataUrl) _refreshPending.push(_hydrateImage(node, item.dataUrl));
    return node;
  }

  // Chapter progress bar — drawn synchronously onto a canvas (no async raster,
  // no blink). Built at the CURRENT animated fraction; the tick hook then
  // redraws the same canvas continuously (see the continuous-fill block above),
  // and the export's per-frame _layer.toCanvas raster picks it up as it fills.
  if (item.kind === 'chapterProgress') {
    const node = new Konva.Image({
      x: item.x, y: item.y, width: item.w, height: item.h,
      draggable: !inert, listening: !inert, name: 'sbs-header-item',
    });
    node.setAttr('headerId',   item.id);
    node.setAttr('headerKind', item.kind);
    const S = 2;                                   // supersample for crisp rounded edges
    const cnv = document.createElement('canvas');
    cnv.width  = Math.max(2, Math.round(item.w * S));
    cnv.height = Math.max(2, Math.round(item.h * S));
    _drawProgressBar(cnv, item, _currentProgressFrac());
    node.image(cnv);
    _progressBars.push({ canvas: cnv, item });     // tick hook keeps it filling
    if (!inert) _attachItemHandlers(node, item);
    return node;
  }

  // Text-flavoured kinds — render via the SAME SVG-foreignObject pipeline
  // overlay textboxes use, so headers inherit rich-text capabilities for
  // free in P3 (canvas editor, mixed inline styles, style template binding).
  // For now (P2), the styling still comes from item fields driven by the
  // sidebar; we just build the textHtml inline at render time.
  const node = new Konva.Image({
    x: item.x,
    y: item.y,
    width:  item.w,
    height: item.h,
    draggable: !inert,
    listening: !inert,
    name: 'sbs-header-item',
  });
  node.setAttr('headerId',   item.id);
  node.setAttr('headerKind', item.kind);
  // textHtml lives on the node so P3's canvas editor can read/write it
  // the same way overlay textboxes do. P2 derives it from item fields
  // every render — once P3 lands, the editor will write it directly
  // and the item fields become a fallback / migration source.
  const textHtml = _buildHeaderTextHtml(item, ctx);
  node.setAttr('textHtml', textHtml);
  // Placeholder: show the previous raster (if any) immediately so a step-change
  // rebuild doesn't flash blank for the frames before the new async raster lands.
  const _cachedImg = _headerImgCache.get(item.id);
  if (_cachedImg) node.image(_cachedImg);
  if (!inert) _attachItemHandlers(node, item);
  // Async raster — Konva.Image draws nothing until the canvas lands,
  // which is fine: empty image = no drawImage call (per Konva sceneFunc
  // `if (image)` guard). _hydrateHeaderText is a no-op if the node was
  // destroyed mid-await (e.g. another refresh fired).
  // Push the hydrate promise into _refreshPending so waitForHeaderStable
  // can wait for it.
  _refreshPending.push(_hydrateHeaderText(node, textHtml, item));
  return node;
}

/**
 * Build the inline textHtml for a text-flavoured header item.
 *
 * P4b resolution chain — driven by `item.styleId`:
 *
 *   styleId === 'custom'   (custom kind only, item.textHtml set):
 *     → render the rich HTML the canvas editor saved, wrapped in the
 *       flex-centring shell. The user's HTML carries inline styles;
 *       only `align` is layered on top via the inner wrapper.
 *
 *   styleId === <template-id> (template still exists):
 *     → render plain text content with the template's font / colour
 *       / weight / style / decoration. Per-item align still applies.
 *
 *   styleId === '' or '' (or template missing, or not-yet-set):
 *     → render plain text content with state.headerDefault's styling.
 *       Per-item align still applies.
 *
 * Dynamic kinds (stepNumber / stepName / chapter*) NEVER take the
 * 'custom' branch — their content auto-resolves per step. Even if a
 * user accidentally has styleId='custom' on one (legacy data), we
 * fall through to the default branch.
 *
 * `text-shadow` keeps the readability boost the old Konva.Text node
 * had — applied at the outer shell so it's consistent across all
 * three render branches.
 */
/** Default readability shadow for header text over arbitrary 3D content. */
const HEADER_READABILITY_SHADOW = '0 1px 2px rgba(0,0,0,0.45)';

/**
 * The text-shadow for a header item: the bound style's compiled drop
 * shadow + outline when it defines any, else the readability default.
 * `src` is the style template, or headerDefault when the item is unbound.
 */
function _headerTextShadow(src) {
  const fx = textEffectsCss(src?.shadow, src?.outline);
  return fx.css || HEADER_READABILITY_SHADOW;
}

/**
 * How far this item's effects reach past its glyphs, in px — 0 when it has
 * none. Header items rasterise at padding:0 into a fixed rect with
 * overflow:hidden, so an outline on left-aligned text would be sliced off
 * at the edge. The raster needs that much padding to hold it.
 *
 * Returning 0 for the no-effects case is deliberate: every existing header
 * keeps its exact current pixel layout, and only an item that actually asks
 * for an effect pays the inset.
 */
function _headerFxExtent(item) {
  if (!item) return 0;
  if (item.kind === 'custom' && item.styleId === 'custom') return 0;   // raw HTML branch
  const tpl = (item.styleId && item.styleId !== 'custom') ? getStyleTemplate(item.styleId) : null;
  const src = tpl || state.get('headerDefault') || {};
  return textEffectsCss(src.shadow, src.outline).extent;
}

function _buildHeaderTextHtml(item, ctx) {
  const align = _safeAlign(item.align);

  // Branch 1: rich custom HTML (custom kind, opted in via styleId).
  if (item.kind === 'custom' && item.styleId === 'custom' && item.textHtml) {
    return `<div style="height:100%;display:flex;align-items:center;text-shadow:0 1px 2px rgba(0,0,0,0.45)"><div style="width:100%;text-align:${align}">${item.textHtml}</div></div>`;
  }

  // Branch 2 + 3: plain text with template OR default styling.
  const tpl = (item.styleId && item.styleId !== 'custom') ? getStyleTemplate(item.styleId) : null;
  const def = state.get('headerDefault') || {};
  const src = tpl || def;

  const resolved   = resolveHeaderText(item, ctx);
  // A subtitle on a step with no voiceover renders NOTHING — no empty band.
  if (item.kind === 'subtitle' && !resolved.trim()) return '';
  const text       = resolved || ' ';
  const escaped    = _escHtml(text);
  const fontFamily = src.fontFamily     || 'Arial';
  const fontSize   = src.fontSize       || 32;
  const color      = src.color          || '#ffffff';
  const fontWeight = src.fontWeight === 'bold'   ? 'bold'   : 'normal';
  const fontStyle  = src.fontStyle  === 'italic' ? 'italic' : 'normal';
  const decoration = src.textDecoration || '';
  const innerStyle = [
    `width:100%`,
    `text-align:${align}`,
    `font-family:${fontFamily}`,
    `font-size:${fontSize}px`,
    `font-weight:${fontWeight}`,
    `font-style:${fontStyle}`,
    `text-decoration:${decoration || 'none'}`,
    `color:${color}`,
    // V0.3.2.149 — a bound style's drop shadow / outline now reaches header
    // items too. This line used to be an unconditional readability shadow,
    // which is why a chapter-name header bound to a style with effects
    // showed none of them: the hardcoded value simply won.
    //
    // The readability shadow stays the DEFAULT, because header text sits
    // over arbitrary 3D content and needs it. A style that defines its own
    // effects replaces it outright rather than stacking — two shadows at
    // different offsets read as a printing error, not a design.
    `text-shadow:${_headerTextShadow(src)}`,
  ].join(';');
  // V0.3.2.16 — the template's fillColor (textbox background) was silently
  // dropped for headers: this builder cherry-picked font fields only, so a
  // style with a solid/semi-transparent background applied everywhere EXCEPT
  // header items. Fill the whole item rect (outer shell), matching textboxes.
  // Subtitles get a readable semi-transparent backing band by default (unless
  // a style template already supplies a fill) — standard caption legibility.
  const fillColor = src.fillColor || (item.kind === 'subtitle' ? 'rgba(0,0,0,0.55)' : '');
  const fill = fillColor ? `;background:${fillColor}` : '';
  const pad  = item.kind === 'subtitle' ? ';padding:0 18px;box-sizing:border-box' : '';
  // Subtitles are bidi-aware (V0.3.2.63): dir="auto" lets the browser pick
  // RTL for Hebrew/Arabic lines from the first strong character, so
  // punctuation and mixed Latin terms order correctly. Alignment still
  // follows the item's L/C/R buttons.
  // V0.3.2.65: item.subDir can FORCE rtl/ltr — auto's first-strong rule
  // guesses wrong when a Hebrew line OPENS with a number or English term
  // (period jumps to the wrong end, mixed runs scramble). Forced rtl keeps
  // the Hebrew reading order while numbers/Latin runs stay internally LTR.
  const subDir = (item.subDir === 'rtl' || item.subDir === 'ltr') ? item.subDir : 'auto';
  const dir  = item.kind === 'subtitle' ? ` dir="${subDir}"` : '';
  return `<div style="height:100%;display:flex;align-items:center${fill}${pad}"><div${dir} style="${innerStyle}">${escaped}</div></div>`;
}

function _safeAlign(a) {
  return (a === 'left' || a === 'center' || a === 'right') ? a : 'left';
}

function _escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

/**
 * Rasterise the textHtml to a canvas and assign it to the Konva.Image
 * node. Bails if the node was destroyed (e.g. a refresh fired mid-
 * await) — Konva would otherwise throw on an orphan node.
 */
async function _hydrateHeaderText(node, textHtml, item) {
  try {
    const canvas = await htmlToCanvas(textHtml, {
      width:   Math.max(1, item.w | 0),
      height:  Math.max(1, item.h | 0),
      // 0 unless the item's style carries a drop shadow / outline, which
      // needs room inside the raster or it clips at the item's edge.
      // Konva.Text had no padding; the no-effects case preserves that parity.
      padding: _headerFxExtent(item),
    });
    if (!canvas) return;
    if (node.isDestroyed?.()) return;
    if (!canvas.width || !canvas.height) return;   // defensive — _htmlToCanvas already clamps
    node.image(canvas);
    if (item?.id) _headerImgCache.set(item.id, canvas);   // seed placeholder for the next rebuild
    _layer?.batchDraw();
  } catch (e) {
    console.warn('[header] text rasterise failed', e);
  }
}

function _attachItemHandlers(node, item) {
  // Caller (refreshHeaderLayer) only attaches handlers when the header
  // is interactive (overlay editing on AND not locked). No lock-check
  // needed here — by the time we're called, the node is interactive.
  node.on('pointerdown', (e) => {
    const additive = !!(e.evt && (e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey));
    // Plain click on an already-selected node should preserve the
    // group — that click is the user grabbing the multi-selection
    // to drag, not asking to demote the selection to just this one.
    // Without this guard, every multi-drag start collapses the
    // selection to length-1 and only one node moves. Same fix
    // overlay needed back in P0.
    const currentIds = _selection;
    if (!additive && currentIds.has(node.getAttr('headerId')) && currentIds.size > 1) return;
    _selectHeaderNode(node, additive);
  });
  // Multi-node drag — CROSS-LAYER. Combines this layer's selection with
  // the overlay layer's so a single grabbed header carries any selected
  // overlay textboxes / images along, and vice versa.
  //
  // P7-C-2 (header side): dragstart ALWAYS snapshots positions for undo,
  // even single-node. dragmove keeps its multi-only delta logic.
  // dragend pushes a "Move" entry that restores positions on both
  // sides via _restoreCrossLayerPositions.
  let _multiDragStarts = null;
  let _dragSnapBefore  = null;
  let _xformSnapBefore = null;
  node.on('dragstart', () => {
    const own  = _transformer?.nodes() || [];
    const peer = getLayerSelection('overlay');
    const sel  = [...own, ...peer];
    const set  = sel.length ? sel : [node];
    // Always snapshot for undo. Split into header / overlay so undo can
    // restore each side via its own mechanism (state.setState batching
    // for headers, direct Konva attr writes + scheduleOverlaySave for
    // overlay peers).
    _dragSnapBefore = { headers: [], overlays: [] };
    for (const n of set) {
      const id = n.getAttr?.('headerId');
      if (id) _dragSnapBefore.headers .push({ id, n, x: n.x(), y: n.y() });
      else    _dragSnapBefore.overlays.push({     n, x: n.x(), y: n.y() });
    }
    // Multi-drag delta only kicks in when we actually have peers to
    // carry along — Konva drags the grabbed node natively for sel=1.
    if (set.length > 1) {
      _multiDragStarts = new Map();
      for (const n of set) _multiDragStarts.set(n, { x: n.x(), y: n.y() });
    }
  });
  node.on('dragmove', () => {
    if (!_multiDragStarts) return;
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
    // Redraw both layers — overlay peers live on a different Konva.Layer.
    _layer.batchDraw();
    _multiDragStarts.peerLayer ??= [..._multiDragStarts.keys()].find(n => n !== node && n.getLayer && n.getLayer() !== _layer)?.getLayer();
    _multiDragStarts.peerLayer?.batchDraw?.();
  });

  // Persist drag back to data stores + push undo entry. In multi-drag,
  // ONLY the grabbed node fires dragend; siblings moved via x()/y() in
  // dragmove don't emit. We walk the captured drag set (header AND
  // overlay peers) and persist each appropriately.
  node.on('dragend', () => {
    const before = _dragSnapBefore;
    _dragSnapBefore  = null;
    _multiDragStarts = null;
    if (!before) return;

    // Persist header peers via batched updateHeaderItem; one call per
    // header node, but they all hit the same change:headerItems event
    // and the layer rebuild handles the lot.
    for (const s of before.headers) {
      if (s.n && !s.n.isDestroyed?.()) {
        updateHeaderItem(s.id, {
          x: s.n.x(), y: s.n.y(), w: s.n.width(), h: s.n.height(),
        });
      }
    }
    // Persist overlay peers in one shot — overlay's _stage.toJSON
    // captures every node's position.
    if (before.overlays.length) scheduleOverlaySave();

    // Push "Move" undo entry covering both sides.
    const afterHeaders  = before.headers .map(s => ({ id: s.id, n: s.n, x: s.n.x(), y: s.n.y() }));
    const afterOverlays = before.overlays.map(s => ({         n: s.n, x: s.n.x(), y: s.n.y() }));
    const moved =
      before.headers .some((b, i) => b.x !== afterHeaders [i].x || b.y !== afterHeaders [i].y) ||
      before.overlays.some((b, i) => b.x !== afterOverlays[i].x || b.y !== afterOverlays[i].y);
    if (moved) {
      const total = before.headers.length + before.overlays.length;
      const label = total > 1 ? `Move ${total} items` : 'Move';
      undoManager.push(label,
        () => _restoreCrossLayerPositions(before.headers, before.overlays),
        () => _restoreCrossLayerPositions(afterHeaders, afterOverlays),
      );
    }
  });

  // Resize / rotate — header transformer only operates on header items
  // (each layer has its own transformer), so this is single-layer.
  // transformstart snapshots full geometry; transformend persists +
  // pushes a "Resize" undo entry.
  node.on('transformstart', () => {
    const tracked = _transformer?.nodes() || [node];
    _xformSnapBefore = tracked.map(n => _snapHeaderGeom(n));
  });
  node.on('transformend', () => {
    // Flatten any scaleX/scaleY into width/height so the saved data stays
    // a clean rect (mirrors the overlay.js commit pattern).
    const sx = node.scaleX();
    const sy = node.scaleY();
    if (sx !== 1 || sy !== 1) {
      node.width(node.width() * sx);
      node.height(node.height() * sy);
      node.scaleX(1);
      node.scaleY(1);
    }
    // Persist all transformer-tracked header items.
    const tracked = _transformer?.nodes() || [node];
    for (const n of tracked) {
      const id = n.getAttr?.('headerId');
      if (id) updateHeaderItem(id, {
        x: n.x(), y: n.y(), w: n.width(), h: n.height(),
      });
    }
    // Push "Resize" undo entry.
    if (_xformSnapBefore) {
      const before = _xformSnapBefore;
      _xformSnapBefore = null;
      const after = before.map(b => _snapHeaderGeom(b.n));
      const changed = before.some((b, i) =>
        b.x !== after[i].x || b.y !== after[i].y ||
        b.width !== after[i].width || b.height !== after[i].height ||
        b.rotation !== after[i].rotation,
      );
      if (changed) {
        const label = before.length > 1 ? `Resize ${before.length} items` : 'Resize';
        undoManager.push(label,
          () => _restoreHeaderGeom(before),
          () => _restoreHeaderGeom(after),
        );
      }
    }
  });

  // P3: double-click custom-kind headers to enter the in-place text editor.
  // Dynamic kinds (stepNumber etc.) skip this — their content is auto-
  // resolved per step, so freezing user-typed text on them would be
  // a footgun. Image kind also skips.
  // V0.3.2.63: subtitle joins in — but its editor commits to the STEP's
  // per-language override slot (never the voiceover, never the item).
  if (item.kind === 'custom' || item.kind === 'subtitle') {
    node.on('dblclick', () => {
      const sel = _transformer?.nodes() || [];
      if (sel.length > 1) return;          // mirror overlay: no edit while multi-selected
      if (item.kind === 'subtitle') _openSubtitleEditor(node, item);
      else                          _openHeaderTextEditor(node, item);
    });
  }
}

// ─── P7-C-2 (header side): drag / resize undo helpers ──────────────────────

function _snapHeaderGeom(n) {
  return {
    n,
    x:        n.x(),
    y:        n.y(),
    width:    n.width(),
    height:   n.height(),
    scaleX:   n.scaleX(),
    scaleY:   n.scaleY(),
    rotation: n.rotation(),
  };
}

/**
 * Restore positions across both layers in ONE pass. Headers go through
 * a single state.setState (so refreshHeaderLayer fires only once, not
 * once per header). Overlay peers get direct Konva attr writes plus a
 * single scheduleOverlaySave to commit the lot.
 */
function _restoreCrossLayerPositions(headerSnaps, overlaySnaps) {
  let any = false;

  // Header side — batched setState avoids N refreshes for N headers.
  if (headerSnaps.length) {
    const items = state.get('headerItems') || [];
    const map   = new Map(headerSnaps.map(s => [s.id, s]));
    const newItems = items.map(it => {
      const s = map.get(it.id);
      return s ? { ...it, x: s.x, y: s.y } : it;
    });
    state.setState({ headerItems: newItems });
    state.markDirty();
    any = true;
  }

  // Overlay side — direct attr write on the live Konva nodes; layer
  // batchDraw + scheduleOverlaySave commits visual + persistence.
  let overlayAlive = false;
  for (const s of overlaySnaps) {
    if (s.n && !s.n.isDestroyed?.()) {
      s.n.x(s.x);
      s.n.y(s.y);
      overlayAlive = true;
    }
  }
  if (overlayAlive) {
    overlaySnaps[0].n?.getLayer?.()?.batchDraw?.();
    scheduleOverlaySave();
    any = true;
  }

  return any ? undefined : false;
}

/**
 * Restore full geometry for header items (used by resize/rotate undo).
 * Header transformer only tracks header items, so this is single-layer
 * — one batched state.setState handles them all.
 */
function _restoreHeaderGeom(snaps) {
  if (!snaps.length) return false;
  const items = state.get('headerItems') || [];
  const map   = new Map(snaps.map(s => [s.n?.getAttr?.('headerId'), s]).filter(([id]) => id));
  if (!map.size) return false;
  const newItems = items.map(it => {
    const s = map.get(it.id);
    return s ? { ...it, x: s.x, y: s.y, w: s.width, h: s.height } : it;
  });
  state.setState({ headerItems: newItems });
  state.markDirty();
  return undefined;
}

/**
 * Open the in-place text editor on a custom-kind header item.
 *
 * P4b: editor entry no longer pre-flips styleId. The user is allowed
 * to peek inside the editor without committing to "custom" mode.
 * Only an actual EDIT (innerHTML diverged from the seed) flips
 * styleId to 'custom' on save. textHtml is preserved on save
 * regardless, so a later "Custom" pick from the row dropdown
 * restores the user's previous canvas-edit content.
 */
function _openHeaderTextEditor(node, item) {
  // Snapshot so commit/save read stable values even if state churns
  // under us (e.g. another refreshHeaderLayer).
  const itemSnapshot   = { ...item };
  const seedHtml       = node.getAttr('textHtml') || '';
  let   committedHtml  = null;   // set by onCommit if user edited
  const ctx = {
    transformer: _transformer,
    configureTransformer: () => _configTransformerForNodes(_transformer.nodes()),
    onCommit: async (html) => {
      // No-edit short-circuit — opening + closing the editor without
      // touching anything must NOT silently flip the item to 'custom'
      // mode. Compare to the seed HTML; only treat as a real commit
      // when the content diverged.
      if (html === seedHtml) return;

      committedHtml = html;
      // Live update: store the raw editor HTML on the node + re-raster
      // in place so _exitTextEdit's reveal lands on the new content
      // seamlessly (no nothing-then-raster flicker).
      node.setAttr('textHtml', html);
      const wrapped = _buildHeaderTextHtml(
        { ...itemSnapshot, kind: 'custom', styleId: 'custom', textHtml: html },
        buildRenderContext(),
      );
      await _hydrateHeaderText(node, wrapped, itemSnapshot);
    },
    onSave: () => {
      // Editor cleanup is done by the time we land here — safe for
      // updateHeaderItem to fire refreshHeaderLayer underneath us.
      // Only persist if an actual edit happened; flip styleId so the
      // row dropdown reflects the new "Custom" mode.
      if (committedHtml == null) return;
      updateHeaderItem(itemSnapshot.id, {
        textHtml: committedHtml,
        styleId:  'custom',
      });
    },
    // styleId binding via the toolbar's Style dropdown stays disabled
    // for headers — bindings happen through the row dropdown in the
    // sidebar. Wiring the toolbar dropdown for headers is a possible
    // future polish, not required by P4b.
  };
  enterTextEditor(node, ctx);
}

/**
 * 🌐 In-place SUBTITLE editor (V0.3.2.63). Same editor UI as custom
 * headers, but the commit target is the STEP's per-language override slot
 * (subtitles.setSubtitleOverride) — the voiceover text and the header item
 * are never touched. Editing marks the line EDITED with the current source
 * fingerprint, so later voiceover changes flag it STALE instead of
 * silently overwriting it.
 */
function _openSubtitleEditor(node, item) {
  const rctx = buildRenderContext();
  // V0.3.2.64: edit the step whose narration OWNS the caption right now
  // (inside a group that's the latest speaking sub-step, not always the head).
  const step = rctx?.subtitleStep || rctx?.step;
  if (!step) return;                       // no active step → nothing to edit
  const lang       = item.subLang || '';
  const seedText   = subtitles.resolveSubtitleText(step, lang);
  let   committedText = null;              // set by onCommit when text really changed

  // Shim ctx that resolves the subtitle to a given text — reuses the real
  // styling pipeline (band, template, dir="auto") for the live re-raster.
  // Overrides BOTH step and subtitleStep: resolution reads subtitleStep first.
  const withText = (text) => {
    const shim = {
      ...step,
      subtitles: { ...(step.subtitles || {}), [subtitles.langKeyOf(lang)]: { text } },
    };
    return { ...rctx, step: shim, subtitleStep: shim };
  };

  const ctx = {
    transformer: _transformer,
    configureTransformer: () => _configTransformerForNodes(_transformer.nodes()),
    onCommit: async (html) => {
      const plain = _htmlToPlainText(html);
      if (plain === seedText) return;      // no-edit → no override, no undo entry
      committedText = plain;
      // Live re-raster so the reveal lands on the new text seamlessly.
      const wrapped = _buildHeaderTextHtml(item, withText(plain));
      node.setAttr('textHtml', wrapped);
      await _hydrateHeaderText(node, wrapped, item);
    },
    onSave: () => {
      if (committedText == null) return;
      // Undoable write to the step slot; change:steps re-renders the layer
      // (and the AUTO→EDITED chip) from data.
      subtitles.setSubtitleOverride(step.id, lang, committedText);
    },
  };
  enterTextEditor(node, ctx);
}

/**
 * Editor HTML → plain subtitle text. <br> and block boundaries become
 * newlines first so multi-line edits don't glue words together; all other
 * markup is dropped (subtitles store PLAIN text — styling comes from the
 * item's style binding, not from inline spans).
 */
function _htmlToPlainText(html) {
  const norm = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>\s*<(div|p)[^>]*>/gi, '\n');
  const d = document.createElement('div');
  d.innerHTML = norm;
  // NOTE: the replace targets a LITERAL U+00A0 (nbsp from &nbsp; in
  // contenteditable HTML) — invisible in source, real in the file bytes.
  return (d.textContent || '').replace(/ /g, ' ').trim();
}

// ─── 🌐 Subtitle status chip (V0.3.2.63) ────────────────────────────────────
// Small tag at the subtitle box's top-left, EDIT-MODE ONLY (refreshHeaderLayer
// builds it only when the layer is interactive; rasterizeHeaderLayer hides
// chips during export snapshots; the data-raster path never builds them).
//   AUTO   — showing the live voiceover copy / a fresh translation
//   EDITED — hand-edited, source unchanged since
//   STALE  — the voiceover changed AFTER this line was edited/translated
//   NOT TRANSLATED — translated language with no translation yet
// Clicking ↺ refreshes the line: Original → back to the voiceover copy;
// translated language → re-translate the current voiceover now.

const _CHIP_COLORS = {
  auto:    '#475569',   // slate — informational
  edited:  '#b45309',   // amber — user content lives here
  stale:   '#b91c1c',   // red — needs attention
  missing: '#7c3aed',   // violet — not translated yet
};

function _buildSubtitleChip(item, ctx) {
  // V0.3.2.64: the chip reports/refreshes the caption's OWNER step (inside
  // a group: the latest speaking sub-step; otherwise the effective step).
  const step = ctx?.subtitleStep || ctx?.step;
  if (!step) return null;
  const lang   = item.subLang || '';
  const status = subtitles.subtitleStatus(step, lang);
  // Refresh is a no-op for an Original line already in auto mode — show
  // nothing at all there (zero chrome until the user actually edits).
  if (!lang && status === 'auto') return null;
  const label = {
    auto:    'AUTO',
    edited:  'EDITED',
    stale:   'STALE',
    missing: 'NOT TRANSLATED',
  }[status] || 'AUTO';
  const text = `${lang ? lang.toUpperCase() + ' · ' : ''}${label}  ↺`;

  const g = new Konva.Group({
    x: item.x,
    y: Math.max(0, item.y - 28),
    name: 'sbs-subtitle-chip',
    listening: true,
  });
  const t = new Konva.Text({
    text, fontSize: 13, fontFamily: 'Arial', fontStyle: 'bold',
    fill: '#ffffff', padding: 5,
  });
  const bg = new Konva.Rect({
    width: t.width(), height: t.height(),
    fill: _CHIP_COLORS[status] || _CHIP_COLORS.auto,
    cornerRadius: 4, opacity: 0.92,
  });
  g.add(bg);
  g.add(t);
  g.on('click tap', (e) => {
    e.cancelBubble = true;
    _onChipRefresh(step.id, lang, status);
  });
  g.on('mouseenter', () => { if (_stage) _stage.container().style.cursor = 'pointer'; });
  g.on('mouseleave', () => { if (_stage) _stage.container().style.cursor = ''; });
  return g;
}

function _onChipRefresh(stepId, lang, status) {
  if (!lang) {
    // Original language: ↺ = drop the hand-edit, back to the live copy.
    if (status === 'edited' || status === 'stale') {
      subtitles.clearSubtitleOverride(stepId, lang);
      setStatus('Subtitle reset to the voiceover text.', 'info');
    }
    return;
  }
  // Translated language: ↺ = re-translate the CURRENT voiceover.
  setStatus('Translating subtitle…', 'info');
  subtitles.refreshSubtitle(stepId, lang).then(res => {
    if (res?.ok) setStatus('Subtitle re-translated.', 'info');
    else         setStatus(res?.error || 'Translation failed.', 'error', 8000);
  });
}

function _selectHeaderNode(node, additive) {
  if (additive) {
    if (_selection.has(node.getAttr('headerId'))) {
      _selection.delete(node.getAttr('headerId'));
    } else {
      _selection.add(node.getAttr('headerId'));
    }
  } else {
    _selection = new Set([node.getAttr('headerId')]);
  }
  const nodes = _layer.getChildren()
    .filter(c => c !== _transformer && _selection.has(c.getAttr('headerId')));
  _transformer.nodes(nodes);
  _configTransformerForNodes(nodes);
  _layer.batchDraw();
}

/**
 * Flip transformer behaviour based on the selected nodes' types.
 * Mirrors overlay._configTransformerForNode but works for the multi-
 * select case: if every selected node is a text item, free resize on
 * all 8 anchors. If any selected node is an image, fall back to
 * aspect-locked corners (mixing free + locked in one transformer
 * isn't a thing in Konva).
 *
 * P2: text-flavoured kinds are now Konva.Image (rendered from textHtml)
 * not Konva.Text — so we distinguish by `headerKind`, not className.
 * Anything that isn't kind 'image' resizes freely.
 */
function _configTransformerForNodes(nodes) {
  if (!_transformer) return;
  if (nodes.length === 0) return;
  const allText = nodes.every(n => n.getAttr?.('headerKind') !== 'image');
  if (allText) {
    _transformer.keepRatio(false);
    _transformer.enabledAnchors([
      'top-left', 'top-center', 'top-right',
      'middle-left',           'middle-right',
      'bottom-left', 'bottom-center', 'bottom-right',
    ]);
  } else {
    _transformer.keepRatio(true);
    _transformer.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
  }
}

async function _hydrateImage(node, dataUrl) {
  let img = _imageCache.get(dataUrl);
  if (!img) {
    img = await _loadImage(dataUrl).catch(() => null);
    if (img) _imageCache.set(dataUrl, img);
  }
  if (!img || node.isDestroyed?.()) return;
  node.image(img);
  _layer?.batchDraw();
}

function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Currently-selected header item ids. Read-only snapshot. */
export function getHeaderSelection() {
  return Array.from(_selection);
}

// ─── .sbsheader file format (unified preset bundle) ───────────────────────
//
// v2 of the file format carries BOTH header items and text-style
// templates so a single sidecar file is enough to import a project's
// branding across projects. v1 (header items only) still loads —
// styles section is just optional.
//
// v3 adds the project-level header default styling:
//
//   {
//     "_sbsheader": { "version": 3, "saved": "..." },
//     "default": { fontFamily, fontSize, ... },   // P4: header default
//     "items":  [ HeaderItem, ... ],
//     "styles": [ StyleTemplate, ... ]
//   }

/** Build the JSON payload for a .sbsheader file from current state. */
export function exportHeaderSetup() {
  return {
    _sbsheader: {
      version: 3,
      saved:   new Date().toISOString(),
    },
    default: JSON.parse(JSON.stringify(state.get('headerDefault')  || {})),
    items:   JSON.parse(JSON.stringify(state.get('headerItems')    || [])),
    styles:  JSON.parse(JSON.stringify(state.get('styleTemplates') || [])),
  };
}

/**
 * Load a .sbsheader payload. Behaviour per section is selectable via
 * `opts` so callers can decide whether to replace existing data or
 * append to it:
 *
 *   opts.itemsMode   — 'replace' | 'add' | 'skip'   (default 'replace')
 *   opts.stylesMode  — 'replace' | 'add' | 'skip'   (default 'replace')
 *   opts.defaultMode — 'replace' | 'skip'           (default 'replace')
 *
 * In 'add' mode, names are de-duplicated against existing entries by
 * appending " (2)", " (3)", etc. — so the import never silently
 * overwrites existing items / templates.
 *
 * v1 (items only) / v2 (items + styles) / v3 (+ default) files all
 * load — missing sections in the file just aren't touched regardless
 * of mode.
 *
 * Returns { headers, styles, defaultLoaded } — counts + a boolean for
 * whether the default block was applied.
 */
export function importHeaderSetup(payload, opts = {}) {
  const result = { headers: 0, styles: 0, defaultLoaded: false };
  if (!payload || typeof payload !== 'object') return result;

  const itemsMode   = opts.itemsMode   || 'replace';
  const stylesMode  = opts.stylesMode  || 'replace';
  const defaultMode = opts.defaultMode || 'replace';

  if (payload.default && typeof payload.default === 'object' && defaultMode !== 'skip') {
    state.setState({ headerDefault: { ...state.get('headerDefault'), ...payload.default } });
    result.defaultLoaded = true;
  }

  if (Array.isArray(payload.styles) && stylesMode !== 'skip') {
    // Always re-stamp ids so loading the same file twice doesn't
    // collide — applies to both replace and add modes.
    const fresh = payload.styles.map(t => ({ ...t, id: generateId('style') }));
    if (stylesMode === 'replace') {
      state.setState({ styleTemplates: fresh });
    } else {
      // 'add' — append, dedupe names against existing list.
      const existing = state.get('styleTemplates') || [];
      const existingNames = new Set(existing.map(t => t.name));
      const renamed = fresh.map(t => ({ ...t, name: _uniqueName(t.name || 'Untitled', existingNames) }));
      state.setState({ styleTemplates: [...existing, ...renamed] });
    }
    result.styles = fresh.length;
  }

  if (Array.isArray(payload.items) && itemsMode !== 'skip') {
    const fresh = payload.items.map(it => ({ ...it, id: generateId('hdr') }));
    if (itemsMode === 'replace') {
      state.setState({ headerItems: fresh });
    } else {
      // 'add' — append. Header items don't have unique-name semantics,
      // so we skip the rename pass; duplicates are fine (the user
      // explicitly accepted that for header import).
      const existing = state.get('headerItems') || [];
      state.setState({ headerItems: [...existing, ...fresh] });
    }
    result.headers = fresh.length;
  }

  if (result.headers || result.styles || result.defaultLoaded) state.markDirty();
  return result;
}

/**
 * Append " (2)", " (3)", ... to `name` until it doesn't collide with
 * any name in `taken`. Mutates `taken` to include the chosen name.
 */
function _uniqueName(name, taken) {
  if (!taken.has(name)) { taken.add(name); return name; }
  let n = 2;
  let candidate = `${name} (${n})`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${name} (${n})`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Rasterize the live header layer to a canvas sized to fit the given
 * width (or height) while preserving aspect. Returns null when:
 *   • there's no layer mounted (initHeaderLayer hasn't run), OR
 *   • headersHidden is true, OR
 *   • the layer has no visible items.
 *
 * Mirrors overlay.rasterizeOverlay() so the export pipeline composites
 * both with the same code path. The transformer is excluded from the
 * rasterised output (it's a UI affordance, not content).
 *
 * @param {{width?:number, height?:number}} [opts]
 */
export function rasterizeHeaderLayer(opts = {}) {
  if (!_layer || !_stage) return null;
  if (state.get('headersHidden')) return null;
  // visible-children = real items (transformer + invisible items + subtitle
  // status chips skipped — chips are edit-mode UI, never content)
  const real = _layer.getChildren().filter(c =>
    c !== _transformer && c.name?.() !== 'sbs-subtitle-chip');
  if (real.length === 0) return null;

  // Hide the transformer for the export snapshot so its handles/border
  // don't bleed into the rendered frame. Restore after. Subtitle chips
  // (AUTO/EDITED/STALE tags, V0.3.2.63) get the same treatment — they are
  // NEVER part of rendered output, even when exporting from edit mode.
  const wasVisible = _transformer.visible();
  _transformer.visible(false);
  const chips = _layer.getChildren().filter(c => c.name?.() === 'sbs-subtitle-chip');
  const chipVis = chips.map(c => c.visible());
  chips.forEach(c => c.visible(false));

  // Render at canonical size (matches the overlay rasteriser). Header
  // items live in canonical coordinates. Same as overlay: zero the
  // stage transform during raster so the live stage.scale doesn't
  // shrink items into the safe-frame sub-rect of the output.
  const exp = state.get('export') || {};
  const cw = (Number.isFinite(exp.width)  && exp.width  > 0) ? exp.width  : 1920;
  const ch = (Number.isFinite(exp.height) && exp.height > 0) ? exp.height : 1080;
  const targetW = opts.width  || cw;
  const targetH = opts.height || ch;
  const pixelRatio = targetW / cw;

  const savedScale = _stage.scale();
  const savedPos   = _stage.position();
  _stage.scale({ x: 1, y: 1 });
  _stage.position({ x: 0, y: 0 });
  let canvas;
  try {
    canvas = _layer.toCanvas({
      x: 0, y: 0,
      width: cw,
      height: ch,
      pixelRatio,
    });
  } finally {
    _stage.scale(savedScale);
    _stage.position(savedPos);
  }

  _transformer.visible(wasVisible);
  chips.forEach((c, i) => c.visible(chipVis[i]));
  return canvas;
}

/** Imperatively select a header item by id (or null to clear). */
export function selectHeader(id) {
  if (!_layer) return;
  if (!id) {
    _selection.clear();
    _transformer.nodes([]);
    _layer.batchDraw();
    return;
  }
  // P1 gate: canvas selection only makes sense when the user can
  // actually move / edit the header. In non-edit mode (or when locked)
  // the header layer is inert — drawing a cyan transformer box around
  // a non-interactive node would be misleading. The sidebar's per-item
  // editor (font size, color, x/y, etc.) keeps working regardless.
  if (!state.get('overlayEditing') || state.get('headersLocked')) return;
  const node = _layer.getChildren().find(c => c.getAttr?.('headerId') === id);
  if (node) _selectHeaderNode(node, false);
}
