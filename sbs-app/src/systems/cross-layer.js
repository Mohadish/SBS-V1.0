/**
 * SBS — Cross-layer coordination.
 *
 * Tiny registry that lets the overlay and header layers cooperate
 * without importing each other (circular imports are technically
 * allowed in ES modules but easy to misuse). Each layer registers
 * a small adapter on init; cross-layer features (currently: combined
 * multi-select drag) read from the registry.
 *
 * Adapter shape — both layers must register one to participate:
 *   {
 *     getSelection:    () => Konva.Node[],   // nodes in this layer's transformer
 *     scheduleSave?:   () => void,           // optional: kick this layer's
 *                                            //   persistence (overlay → step.overlay)
 *     persistFromNode?: (Konva.Node) => void // optional: per-node persistence
 *                                            //   (header → updateHeaderItem)
 *   }
 *
 * NOT a full event bus. We keep this minimal — features that span
 * layers should add a function here and document why; features that
 * live inside one layer should NOT route through this module.
 */

const _layers = {};

/** Layer init calls this once with its adapter. Re-registering replaces. */
export function registerLayer(name, adapter) {
  _layers[name] = adapter || null;
}

/** Currently-selected nodes in the named layer (empty if not registered). */
export function getLayerSelection(name) {
  return _layers[name]?.getSelection?.() || [];
}

/** Empty the named layer's selection (the overlay's rubber-band REPLACE also replaces a header selection). */
export function clearLayerSelection(name) {
  _layers[name]?.clearSelection?.();
}

/** Combined selection across overlay + header — used by multi-drag. */
export function getCombinedSelection() {
  return [...getLayerSelection('overlay'), ...getLayerSelection('header')];
}

// ─── ONE mover for a multi-select drag (V0.3.4.10) ──────────────────────────
// Dragging one of several selected items carries the others along. SBS does that itself
// (the grabbed node's dragmove writes start + delta to every other item): it is the only
// mover that knows the OTHER layer's selection — and, when the grabbed item is an overlay
// item, an interface's bonded shapes and that a pinned item stays put (a HEADER-grabbed drag
// still carries the overlay selection as it is: follow-up). But Konva 9's Transformer ALSO does it on its own — _proxyDrag,
// registered for every node on each nodes(...) call: on the first dragmove it shifts every
// other attached node by the first delta and start-drags each of them natively. Two movers:
// the siblings got the first delta TWICE (ours, then Konva's on top), every sibling then
// fired its own dragstart / dragmove / dragend through our handlers with a snapshot taken
// mid-gesture, and the group ended with the grabbed item one first-delta away from the rest
// — a few px on a slow start, tens on a fast one ("they sometimes jump") — plus one undo
// entry PER item, siblings bonded / unbonded by where the POINTER was, and a pinned sibling
// nudged while its refusal killed the whole drag. Reproduced and measured on the vendored
// Konva 9.3.22 with real mouse input before this was written.
//
// There is no Transformer option for it, so the instance's private hook is shadowed right
// after construction: setNodes() then registers no proxy listeners at all — on any call
// site, now or later. The transformer's box still follows the items (its per-node
// absoluteTransformChange listener). Vendored Konva is pinned; if an upgrade renames the
// hook this warns once instead of silently bringing the second mover back.
export function useOwnMultiDrag(transformer, who = '') {
  if (!transformer) return false;
  if (typeof transformer._proxyDrag !== 'function') {
    console.warn(`[${who || 'konva'}] Transformer._proxyDrag is gone — check multi-select dragging after this Konva upgrade (cross-layer.js, useOwnMultiDrag)`);
    return false;
  }
  transformer._proxyDrag = () => {};
  return true;
}

/**
 * The end state of a multi-drag is start + the grabbed item's total delta BY CONSTRUCTION.
 * Re-applied once at release against the positions captured at dragstart, so no missed frame
 * and no foreign writer can leave a relative offset behind; says so in the console if it had
 * to correct anything.
 * @param {Map<object,{x:number,y:number}>} starts  node → position captured at dragstart
 * @param {object} grabbed                           the node that was dragged natively
 * @returns {number} how many items were off their place
 */
export function reapplyGroupDelta(starts, grabbed, who = '') {
  const g0 = starts?.get?.(grabbed);
  if (!g0 || starts.size <= 1) return 0;
  const dx = grabbed.x() - g0.x, dy = grabbed.y() - g0.y;
  let off = 0;
  for (const [n, s] of starts) {
    if (n === grabbed || !s) continue;
    const x = s.x + dx, y = s.y + dy;
    if (Math.abs(n.x() - x) > 0.01 || Math.abs(n.y() - y) > 0.01) off++;
    n.x(x); n.y(y);
  }
  if (off) console.warn(`[${who || 'multi-drag'}] ${off} item(s) were off their place at release — corrected. Is a second mover active?`);
  return off;
}

/** A HEADER-grabbed drag moved these OVERLAY items by x()/y(): the overlay does for them what their own dragend would have. */
export function notifyOverlayPeersMoved(nodes) {
  if (nodes?.length) _layers.overlay?.peersMoved?.(nodes);
}

/** …and its undo / redo wrote their old / new places back: bond % only — never the link sync, which pushes an undo entry of its own. */
export function notifyOverlayBondsRestored(nodes) {
  if (nodes?.length) _layers.overlay?.bondsRestored?.(nodes);
}

/** Kick overlay persistence (writes overlay layer to active step.overlay). */
export function scheduleOverlaySave() {
  _layers.overlay?.scheduleSave?.();
}

/**
 * Persist a single node back to its layer's data store. Used after a
 * cross-layer multi-drag — the grabbed node's dragend has to write
 * back positions for nodes from BOTH layers, since only the grabbed
 * node fires its own dragend.
 *
 *   - header node (has `headerId` attr): updateHeaderItem(id, x/y/w/h)
 *   - overlay node:                       no-op here; its position is
 *                                          part of step.overlay JSON,
 *                                          which scheduleOverlaySave
 *                                          captures in one go.
 */
export function persistNodeIfHeader(node) {
  if (!node) return;
  if (node.getAttr?.('headerId')) {
    _layers.header?.persistFromNode?.(node);
  }
}
