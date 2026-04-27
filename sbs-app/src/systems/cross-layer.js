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

/** Combined selection across overlay + header — used by multi-drag. */
export function getCombinedSelection() {
  return [...getLayerSelection('overlay'), ...getLayerSelection('header')];
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
