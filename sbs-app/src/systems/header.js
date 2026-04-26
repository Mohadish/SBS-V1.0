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

import { state }    from '../core/state.js';
import { generateId } from '../core/schema.js';

// ─── Pure data helpers (no DOM / Konva — usable from export, tests) ─────────

/** Default values for a freshly-created header item of the given kind. */
export function makeHeaderItem(kind = 'custom', opts = {}) {
  const base = {
    id:         generateId('hdr'),
    kind:       kind,
    visible:    true,
    x:          opts.x ?? 100,
    y:          opts.y ?? 40,
    w:          opts.w ?? 480,
    h:          opts.h ?? 64,
    fontSize:   opts.fontSize ?? 32,
    fontWeight: opts.fontWeight ?? 'normal',
    fontStyle:  opts.fontStyle  ?? 'normal',
    color:      opts.color  ?? '#ffffff',
    align:      opts.align  ?? 'center',
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

  // State subscriptions — anything that changes the rendered output triggers
  // a refresh. Cheap re-render: we destroy and recreate nodes each time.
  // Header lists are small (typically < 10 items); no need for diff-based
  // reconciliation.
  state.on('change:headerItems',   refreshHeaderLayer);
  state.on('change:headersHidden', refreshHeaderLayer);
  state.on('change:headersLocked', refreshHeaderLayer);
  state.on('change:activeStepId',  refreshHeaderLayer);
  state.on('change:steps',         refreshHeaderLayer);
  state.on('change:chapters',      refreshHeaderLayer);
  state.on('header:refresh',       refreshHeaderLayer);   // explicit kick from step/chapter rename

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

  const items = state.get('headerItems') || [];
  const ctx   = buildRenderContext();
  const lock  = !!state.get('headersLocked');
  const newNodesById = new Map();

  for (const item of items) {
    if (!item?.visible) continue;
    const node = _buildNode(item, ctx, lock);
    if (!node) continue;
    _layer.add(node);
    newNodesById.set(item.id, node);
  }

  // Restore selection where the underlying item still exists.
  const restored = [];
  for (const id of prevSelection) {
    const n = newNodesById.get(id);
    if (n) restored.push(n);
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
function _buildNode(item, ctx, lock) {
  if (item.kind === 'image') {
    const node = new Konva.Image({
      x: item.x,
      y: item.y,
      width:  item.w,
      height: item.h,
      draggable: !lock,
      name: 'sbs-header-item',
    });
    node.setAttr('headerId',   item.id);
    node.setAttr('headerKind', item.kind);
    node.setAttr('naturalW',   item.naturalW || null);
    node.setAttr('naturalH',   item.naturalH || null);
    _attachItemHandlers(node, item, lock);
    if (item.dataUrl) _hydrateImage(node, item.dataUrl);
    return node;
  }

  // Text-flavoured kinds — resolve text live for dynamic kinds.
  const text = resolveHeaderText(item, ctx);
  const node = new Konva.Text({
    x: item.x,
    y: item.y,
    width:  item.w,
    height: item.h,
    text:   text || ' ',                      // Konva collapses empty boxes; keep a space
    fontSize:   item.fontSize   || 32,
    fontStyle:  [item.fontStyle  === 'italic' ? 'italic' : '',
                 item.fontWeight === 'bold'   ? 'bold'   : ''].filter(Boolean).join(' ') || 'normal',
    fill:    item.color || '#ffffff',
    align:   item.align || 'center',
    verticalAlign: 'middle',
    draggable: !lock,
    name: 'sbs-header-item',
    // Subtle text shadow so light text stays readable on light viewport bg.
    shadowColor:   'rgba(0,0,0,0.45)',
    shadowOffsetY: 1,
    shadowBlur:    2,
  });
  node.setAttr('headerId',   item.id);
  node.setAttr('headerKind', item.kind);
  _attachItemHandlers(node, item, lock);
  return node;
}

function _attachItemHandlers(node, item, lock) {
  if (lock) return;
  node.on('pointerdown', (e) => {
    const additive = !!(e.evt && (e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey));
    _selectHeaderNode(node, additive);
  });
  // Persist drag / resize back to state.headerItems.
  node.on('dragend transformend', () => {
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
    updateHeaderItem(item.id, {
      x: node.x(),
      y: node.y(),
      w: node.width(),
      h: node.height(),
    });
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
  _layer.batchDraw();
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

// ─── .sbsheader file format (cross-project portability) ────────────────────

/** Build the JSON payload for a .sbsheader file from current state. */
export function exportHeaderSetup() {
  return {
    _sbsheader: {
      version: 1,
      saved:   new Date().toISOString(),
    },
    items: JSON.parse(JSON.stringify(state.get('headerItems') || [])),
  };
}

/**
 * Load a .sbsheader payload, replacing the current headerItems list.
 * Validates the wrapper shape; ignores unknown fields.
 *
 * Returns the number of items loaded (0 = invalid file / empty list).
 */
export function importHeaderSetup(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  const items = Array.isArray(payload.items) ? payload.items : null;
  if (!items) return 0;
  // Re-stamp ids so loading the same file twice doesn't collide. Easier
  // than tracking which ones to keep across loads.
  const fresh = items.map(it => ({ ...it, id: generateId('hdr') }));
  state.setState({ headerItems: fresh });
  state.markDirty();
  return fresh.length;
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
  const node = _layer.getChildren().find(c => c.getAttr?.('headerId') === id);
  if (node) _selectHeaderNode(node, false);
}
