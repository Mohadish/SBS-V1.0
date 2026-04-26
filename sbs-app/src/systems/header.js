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
