/**
 * SBS — delete a style that is IN USE by moving its users onto another
 * style (V0.3.4.116).
 * ─────────────────────────────────────────────────────────────────────
 * The user's rule (2026-09-24): "if I delete a style that other items use,
 * ask me which style replaces it — they need to be picked up by something
 * else, they can't just be thrown out."
 *
 * What a text style's users are: text boxes on EVERY step (the overlay
 * strings, `"styleId":"<id>"` — constant-title instances included), the
 * constant-title definitions (constTextBoxes[].styleId) and header items
 * (headerItems[].styleId). A shape style's users: shapes on every step
 * (`"shapeStyleId":"<id>"`).
 *
 * The move reuses the brand wizard's machinery (overlay.js): countAttrUsage
 * for the numbers, rebindOverlayAttr to re-stamp every step's overlay string
 * AND the live layer (it also schedules the active step's reload from the
 * patched string, so the boxes re-rasterise with the new style), and
 * restoreOverlayStrings for the way back. ONE undo entry for the whole thing:
 * the list-only put / drop helpers in style-templates.js / shape-styles.js
 * push none of their own.
 */

import { state }       from '../core/state.js';
import { undoManager } from './undo.js';
import { countAttrUsage, rebindOverlayAttr, restoreOverlayStrings } from './overlay.js';
import { getStyleTemplate, flushStyleBatch, putStyleTemplateRaw, dropStyleTemplateRaw } from './style-templates.js';
import { getShapeStyle, flushShapeStyleBatch, putShapeStyleRaw, dropShapeStyleRaw } from './shape-styles.js';

const _clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const _n = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ─── usage ───────────────────────────────────────────────────────────────────

/** How much a text style is used: boxes (all steps), header items, constant titles. */
export function textStyleUsage(id) {
  const u = countAttrUsage('styleId', [id]).get(id) || { count: 0, stepIds: [] };
  const consts  = (state.get('constTextBoxes') || []).filter(d => d?.styleId === id).length;
  const headers = (state.get('headerItems')    || []).filter(it => it?.styleId === id).length;
  return { boxes: u.count, stepIds: u.stepIds, consts, headers, total: u.count + consts + headers };
}

/** How much a shape style is used: shapes on all steps. */
export function shapeStyleUsage(id) {
  const u = countAttrUsage('shapeStyleId', [id]).get(id) || { count: 0, stepIds: [] };
  return { shapes: u.count, stepIds: u.stepIds, total: u.count };
}

/** "3 text boxes on 2 steps, 1 header item and 2 constant titles" — the subject of a sentence. */
export function describeUsage(u) {
  const parts = [];
  if (u.boxes)  parts.push(`${_n(u.boxes, 'text box', 'text boxes')} on ${_n(u.stepIds.length, 'step', 'steps')}`);
  if (u.shapes) parts.push(`${_n(u.shapes, 'shape', 'shapes')} on ${_n(u.stepIds.length, 'step', 'steps')}`);
  if (u.headers) parts.push(_n(u.headers, 'header item', 'header items'));
  if (u.consts)  parts.push(_n(u.consts, 'constant title', 'constant titles'));
  if (!parts.length) return 'nothing';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ─── delete + move ───────────────────────────────────────────────────────────

/**
 * Delete text style `id`; every user moves to style `intoId` first.
 * Returns the usage that moved, or null when either style is missing.
 */
export function deleteTextStyleInto(id, intoId) {
  flushStyleBatch();
  const tpl  = getStyleTemplate(id);
  const into = getStyleTemplate(intoId);
  if (!tpl || !into || id === intoId) return null;
  const use = textStyleUsage(id);

  const constBefore = _clone(state.get('constTextBoxes') || []);
  const hdrBefore   = _clone(state.get('headerItems')    || []);
  const constAfter  = constBefore.map(d  => d?.styleId  === id ? { ...d,  styleId: intoId } : d);
  const hdrAfter    = hdrBefore.map(it   => it?.styleId === id ? { ...it, styleId: intoId } : it);

  let prevOverlays = [];
  const apply = () => {
    // 1. the boxes on every step + the live layer (schedules the active step's reload)
    prevOverlays = rebindOverlayAttr('styleId', [{ from: id, into: intoId }]).prev;
    // 2. the definitions that name a style — BEFORE the style goes, so the
    //    header's "template removed" refresh already sees the new bindings
    state.setState({ constTextBoxes: _clone(constAfter), headerItems: _clone(hdrAfter) });
    state.markDirty();
    // 3. the style itself (emits styleTemplate:removed → header layer refresh)
    dropStyleTemplateRaw(id);
    // 4. live boxes now on the target re-rasterise at once (the reload does it too)
    state.emit('styleTemplate:updated', { id: intoId });
  };
  const revert = () => {
    state.setState({ constTextBoxes: _clone(constBefore), headerItems: _clone(hdrBefore) });
    state.markDirty();
    putStyleTemplateRaw(tpl);                 // emits styleTemplate:updated → header + live boxes
    restoreOverlayStrings(prevOverlays);      // every step's string back; the active step reloads
  };

  apply();
  undoManager.push(`Delete style "${tpl.name}" → "${into.name}"`, revert, apply);
  return use;
}

/**
 * Delete shape style `id`; every shape bound to it moves to `intoId` first.
 * Returns the usage that moved, or null when either style is missing.
 */
export function deleteShapeStyleInto(id, intoId) {
  flushShapeStyleBatch();
  const tpl  = getShapeStyle(id);
  const into = getShapeStyle(intoId);
  if (!tpl || !into || id === intoId) return null;
  const use = shapeStyleUsage(id);

  let prevOverlays = [];
  const apply = () => {
    prevOverlays = rebindOverlayAttr('shapeStyleId', [{ from: id, into: intoId }]).prev;
    dropShapeStyleRaw(id);                                  // emits shapeStyle:removed → live re-resolve
    state.emit('shapeStyle:updated', { id: intoId });       // the shapes now on the target follow it
  };
  const revert = () => {
    putShapeStyleRaw(tpl);
    restoreOverlayStrings(prevOverlays);
    state.emit('shapeStyle:updated', { id });
  };

  apply();
  undoManager.push(`Delete shape style "${tpl.name}" → "${into.name}"`, revert, apply);
  return use;
}
