/**
 * SBS — Cable Tab
 * ================
 * Sidebar UI for the cable system. Mirrors the header-tab pattern:
 * top buttons + list + per-item editor.
 *
 * C3 scope (this file):
 *   • + New Cable button
 *   • Stop Placement button (visible only while placing)
 *   • Cable list — each row: name · point count · place / hide / highlight / delete
 *   • Per-item editor (when a row is selected): name + color + radius
 *
 * Not in C3 (later phases):
 *   • Sockets (C4)
 *   • Branch / re-anchor (C6 / C7)
 *   • Anchor health panel (C6)
 *   • Global scale + highlight color (C9)
 */

import { state }      from '../core/state.js';
import * as actions   from '../systems/actions.js';
import { listCables } from '../systems/cables.js';

let _activeCableId = null;       // which cable's editor is expanded

export function renderCableTab(container) {
  if (!container) return;
  const cables    = listCables();
  const placingId = state.get('cablePlacingId');

  container.innerHTML = `
    <div class="section">
      <div class="title">Cables</div>
      <div class="small muted" style="margin-top:6px;line-height:1.5;">
        3D wires routed between mesh anchor points and free positions.
        Click <strong>+ New Cable</strong>, then click in the viewport
        to drop points — on a mesh face = anchored, empty = free.
      </div>

      <div class="card" style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <button class="btn" id="cbl-new">+ New Cable</button>
        <button class="btn" id="cbl-stop"
                ${placingId ? '' : 'disabled'}
                style="${placingId ? 'background:#dc2626;color:#fff;' : ''}">
          ${placingId ? '■ Stop Placement' : 'Stop Placement'}
        </button>
      </div>

      ${placingId ? `
        <div class="card" style="margin-top:8px;padding:10px;background:rgba(220,38,38,0.08);border-color:#dc2626;">
          <div class="small" style="color:#fca5a5;font-weight:600;">
            ◉ Placing — click a face to anchor, empty space to free-place. Esc / Stop to finish.
          </div>
        </div>
      ` : ''}

      <div class="card" style="margin-top:10px;padding:0;">
        <div class="title" style="padding:8px 10px;border-bottom:1px solid var(--line);">
          Cables <span class="small muted">(${cables.length})</span>
        </div>
        <div id="cbl-list">
          ${cables.length === 0
            ? `<div class="small muted" style="padding:10px;">No cables yet — pick + New Cable.</div>`
            : cables.map(c => _renderCableRow(c, placingId)).join('')}
        </div>
      </div>

      <div id="cbl-editor" style="margin-top:10px;"></div>
    </div>
  `;

  container.querySelector('#cbl-new')?.addEventListener('click', _onCreate);
  container.querySelector('#cbl-stop')?.addEventListener('click', () => actions.stopCablePlacement());

  // Per-row delegation
  container.querySelector('#cbl-list')?.addEventListener('click', e => {
    const row = e.target.closest('[data-cbl-id]');
    if (!row) return;
    const id  = row.dataset.cblId;
    const act = e.target.closest('[data-cbl-act]')?.dataset.cblAct;

    if (act === 'place')     { actions.startCablePlacement(id); _activeCableId = id; return; }
    if (act === 'hide')      { actions.toggleCableVisibility(id); return; }
    if (act === 'highlight') { actions.toggleCableHighlight(id); return; }
    if (act === 'delete')    {
      if (confirm('Delete this cable?')) {
        actions.deleteCable(id);
        if (_activeCableId === id) _activeCableId = null;
      }
      return;
    }
    // Plain click → open editor.
    _activeCableId = id;
    _renderEditor(container);
  });

  if (_activeCableId && cables.find(c => c.id === _activeCableId)) {
    _renderEditor(container);
  } else {
    _activeCableId = null;
  }
}

function _renderCableRow(cable, placingId) {
  const eye = cable.visible ? '👁' : '·';
  const isPlacing = placingId === cable.id;
  const placeColor = isPlacing ? '#dc2626' : '#22d3ee';
  const placeIcon  = isPlacing ? '◉' : '+';
  const placeTitle = isPlacing ? 'Placing… click viewport to add points' : 'Place points on this cable';
  const highlight  = cable.highlight ? '★' : '☆';
  const pointCount = cable.nodes?.length ?? 0;
  return `
    <div class="row" data-cbl-id="${_esc(cable.id)}"
         style="display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;${_activeCableId === cable.id ? 'background:rgba(34,211,238,0.08);' : ''}">
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${_esc(cable.style?.color || '#ffb24a')};flex-shrink:0;"></span>
      <button class="btn icon" data-cbl-act="hide" title="Show / hide" style="width:24px;height:24px;padding:0;opacity:${cable.visible ? 1 : 0.4};">${eye}</button>
      <div style="flex:1;min-width:0;">
        <div class="small" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(cable.name || '(unnamed)')}</div>
        <div class="small muted" style="font-size:11px;">${pointCount} point${pointCount === 1 ? '' : 's'}</div>
      </div>
      <button class="btn icon" data-cbl-act="place" title="${_esc(placeTitle)}" style="width:24px;height:24px;padding:0;color:${placeColor};">${placeIcon}</button>
      <button class="btn icon" data-cbl-act="highlight" title="Highlight" style="width:24px;height:24px;padding:0;color:${cable.highlight ? '#22d3ee' : 'var(--muted)'};">${highlight}</button>
      <button class="btn icon" data-cbl-act="delete" title="Delete" style="width:24px;height:24px;padding:0;color:#f87171;">✕</button>
    </div>
  `;
}

function _renderEditor(container) {
  const host = container.querySelector('#cbl-editor');
  if (!host) return;
  const cable = listCables().find(c => c.id === _activeCableId);
  if (!cable) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <div class="section">
      <div class="title">Editing: ${_esc(cable.name || '(unnamed)')}</div>

      <label class="colorlab" style="margin-top:8px;">Name
        <input type="text" id="cbl-name" value="${_esc(cable.name || '')}" />
      </label>

      <div class="grid2" style="margin-top:8px;">
        <label class="colorlab">Color
          <input type="color" id="cbl-color" value="${_esc(cable.style?.color || '#ffb24a')}" />
        </label>
        <label class="colorlab">Radius
          <input type="number" id="cbl-radius" min="0.5" max="20" step="0.5" value="${cable.style?.radius ?? 3}" />
        </label>
      </div>

      <div class="small muted" style="margin-top:6px;line-height:1.4;">
        Tip: use the eye / star / +/- buttons in the row above for
        per-cable visibility, highlight, and placement.
      </div>
    </div>
  `;

  // Name commits on blur (Enter blurs too) — one undo entry per edit.
  const nameInput = host.querySelector('#cbl-name');
  nameInput?.addEventListener('change', () => actions.renameCable(cable.id, nameInput.value));
  nameInput?.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });

  // Style fields — change-event commits.
  host.querySelector('#cbl-color')?.addEventListener('change',
    e => actions.setCableStyle(cable.id, { color: e.target.value }));
  host.querySelector('#cbl-radius')?.addEventListener('change',
    e => actions.setCableStyle(cable.id, { radius: Math.max(0.5, Number(e.target.value) || 3) }));
}

// ─── Create / lifecycle ─────────────────────────────────────────────────────

function _onCreate() {
  const cable = actions.createCable(`Cable ${listCables().length}`);
  _activeCableId = cable.id;
  // Auto-enter placement so the user can immediately start clicking
  // points — same UX as header / overlay add.
  actions.startCablePlacement(cable.id);
}

// ─── Esc helper ─────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
