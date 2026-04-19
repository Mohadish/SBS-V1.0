/**
 * SBS Step Browser — HUD (Selection Info)
 * ==========================================
 * Populates #hud-content with information about the currently
 * selected scene node. Subscribes to state selection changes.
 */

import { state } from '../core/state.js';
import { countMeshNodes } from '../core/nodes.js';

let _el = null;

export function initHud() {
  _el = document.getElementById('hud-content');
  state.on('selection:change', () => renderHud());
  state.on('change:treeData',  () => renderHud());
}

export function renderHud() {
  if (!_el) return;

  const selectedId = state.get('selectedId');
  const nodeById   = state.get('nodeById');
  const node       = (selectedId && nodeById) ? nodeById.get(selectedId) : null;

  if (!node) {
    _el.innerHTML = '<span class="text-muted">Nothing selected.</span>';
    return;
  }

  const meshCount  = countMeshNodes(node);
  const childCount = (node.children || []).length;
  const multiCount = state.get('multiSelectedIds')?.size ?? 0;

  _el.innerHTML = `
    <div class="hud-row"><span class="hud-key">Name</span><span class="hud-val">${esc(node.name || '(unnamed)')}</span></div>
    <div class="hud-row"><span class="hud-key">Type</span><span class="hud-val">${node.type}</span></div>
    <div class="hud-row"><span class="hud-key">Children</span><span class="hud-val">${childCount}</span></div>
    <div class="hud-row"><span class="hud-key">Total meshes</span><span class="hud-val">${meshCount}</span></div>
    <div class="hud-row"><span class="hud-key">Visible</span><span class="hud-val">${node.localVisible ? 'yes' : 'no'}</span></div>
    ${multiCount > 1 ? `<div class="hud-row"><span class="hud-key">Selected</span><span class="hud-val">${multiCount}</span></div>` : ''}
  `;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
