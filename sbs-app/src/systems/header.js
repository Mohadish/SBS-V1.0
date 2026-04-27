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
 *     kind:      'custom' | 'stepName' | 'stepNumber' | 'chapterName' | 'chapterNumber' | 'image',
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
import { registerLayer, getLayerSelection, scheduleOverlaySave } from './cross-layer.js';
import { getStyleTemplate } from './style-templates.js';        // P4b: per-item style binding

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
    case 'image':          return '';   // image kind has no text
    default:               return '';
  }
}

/**
 * Build the render context (active step + chapter ordinals) from current
 * state. Pure read; doesn't mutate. Useful both for the live renderer
 * and ad-hoc callers (status text, thumbnails-with-headers, etc.).
 */
export function buildRenderContext() {
  const steps    = state.get('steps') || [];
  const chapters = state.get('chapters') || [];
  const activeId = state.get('activeStepId');
  const stepIndex = steps.findIndex(s => s.id === activeId);
  const step     = stepIndex >= 0 ? steps[stepIndex] : null;
  const chapterIndex = step?.chapterId
    ? chapters.findIndex(c => c.id === step.chapterId)
    : -1;
  const chapter  = chapterIndex >= 0 ? chapters[chapterIndex] : null;
  return { step, stepIndex, chapter, chapterIndex };
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
  state.on('change:headerItems',    refreshHeaderLayer);
  state.on('change:headersHidden',  refreshHeaderLayer);
  state.on('change:headersLocked',  refreshHeaderLayer);
  state.on('change:headerDefault',  refreshHeaderLayer);   // P4a: items in default mode pick up new styling
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
 * Wipe + redraw every header item against the current state. Called on
 * every state change that could affect output. Selection is preserved
 * by id when the same nodes still exist after rebuild.
 */
export function refreshHeaderLayer() {
  if (!_layer) return;

  const prevSelection = new Set(_selection);
  // Remove all children except the transformer
  for (const child of _layer.getChildren().slice()) {
    if (child !== _transformer) child.destroy();
  }

  if (state.get('headersHidden')) {
    _transformer.nodes([]);
    _layer.batchDraw();
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
}

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
    if (item.dataUrl) _hydrateImage(node, item.dataUrl);
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
  if (!inert) _attachItemHandlers(node, item);
  // Async raster — Konva.Image draws nothing until the canvas lands,
  // which is fine: empty image = no drawImage call (per Konva sceneFunc
  // `if (image)` guard). _hydrateHeaderText is a no-op if the node was
  // destroyed mid-await (e.g. another refresh fired).
  _hydrateHeaderText(node, textHtml, item);
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

  const text       = resolveHeaderText(item, ctx) || ' ';
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
    `text-shadow:0 1px 2px rgba(0,0,0,0.45)`,
  ].join(';');
  return `<div style="height:100%;display:flex;align-items:center"><div style="${innerStyle}">${escaped}</div></div>`;
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
      padding: 0,           // Konva.Text had no padding; preserve visual parity
    });
    if (!canvas) return;
    if (node.isDestroyed?.()) return;
    if (!canvas.width || !canvas.height) return;   // defensive — _htmlToCanvas already clamps
    node.image(canvas);
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
  let _multiDragStarts = null;
  node.on('dragstart', () => {
    const own  = _transformer?.nodes() || [];
    const peer = getLayerSelection('overlay');
    const sel  = [...own, ...peer];
    if (sel.length <= 1) return;
    _multiDragStarts = new Map();
    for (const n of sel) _multiDragStarts.set(n, { x: n.x(), y: n.y() });
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

  // Persist drag / resize back to data stores. In multi-drag, ONLY the
  // grabbed node fires dragend — siblings (header AND overlay peers
  // moved via cross-layer delta) don't emit events. We walk the full
  // (former) drag set, persisting header items via updateHeaderItem
  // and overlay peers via cross-layer.scheduleOverlaySave (one shot —
  // overlay's _stage.toJSON captures all overlay node positions).
  node.on('dragend transformend', () => {
    const draggedSet = _multiDragStarts ? [..._multiDragStarts.keys()] : [node];
    _multiDragStarts = null;
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
    let overlayPeerMoved = false;
    for (const n of draggedSet) {
      const id = n.getAttr?.('headerId');
      if (id) {
        updateHeaderItem(id, {
          x: n.x(), y: n.y(), w: n.width(), h: n.height(),
        });
      } else {
        overlayPeerMoved = true;
      }
    }
    if (overlayPeerMoved) scheduleOverlaySave();
  });

  // P3: double-click custom-kind headers to enter the in-place text editor.
  // Dynamic kinds (stepNumber etc.) skip this — their content is auto-
  // resolved per step, so freezing user-typed text on them would be
  // a footgun. Image kind also skips.
  if (item.kind === 'custom') {
    node.on('dblclick', () => {
      const sel = _transformer?.nodes() || [];
      if (sel.length > 1) return;          // mirror overlay: no edit while multi-selected
      _openHeaderTextEditor(node, item);
    });
  }
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
 * Load a .sbsheader payload, replacing the current header items, style
 * templates, and (v3+) the header default. Validates the wrapper shape;
 * ignores unknown fields. v1 / v2 files still load — missing sections
 * just don't get touched.
 *
 * Returns { headers, styles, defaultLoaded } — the boolean reports
 * whether the .sbsheader carried a default block (so the caller can
 * surface that in the status message).
 */
export function importHeaderSetup(payload) {
  const result = { headers: 0, styles: 0, defaultLoaded: false };
  if (!payload || typeof payload !== 'object') return result;

  if (payload.default && typeof payload.default === 'object') {
    state.setState({ headerDefault: { ...state.get('headerDefault'), ...payload.default } });
    result.defaultLoaded = true;
  }

  if (Array.isArray(payload.items)) {
    // Re-stamp ids so loading the same file twice doesn't collide.
    const fresh = payload.items.map(it => ({ ...it, id: generateId('hdr') }));
    state.setState({ headerItems: fresh });
    result.headers = fresh.length;
  }

  if (Array.isArray(payload.styles)) {
    const fresh = payload.styles.map(t => ({ ...t, id: generateId('style') }));
    state.setState({ styleTemplates: fresh });
    result.styles = fresh.length;
  }

  if (result.headers || result.styles || result.defaultLoaded) state.markDirty();
  return result;
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
  // visible-children = real items (transformer + invisible items skipped)
  const real = _layer.getChildren().filter(c => c !== _transformer);
  if (real.length === 0) return null;

  // Hide the transformer for the export snapshot so its handles/border
  // don't bleed into the rendered frame. Restore after.
  const wasVisible = _transformer.visible();
  _transformer.visible(false);

  const sw = _stage.width();
  const sh = _stage.height();
  if (!sw || !sh) { _transformer.visible(wasVisible); return null; }
  const ratio = opts.width  ? opts.width  / sw
              : opts.height ? opts.height / sh
              : 1;
  const canvas = _layer.toCanvas({ pixelRatio: ratio });

  _transformer.visible(wasVisible);
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
