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
let _socketLockRatio = false;    // sticky lock-ratio toggle in socket editor

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

      <div class="card" style="margin-top:8px;padding:8px 10px;">
        <label class="colorlab" style="display:flex;align-items:center;gap:8px;">
          <span class="small" style="flex:0 0 100px;">Global Radius</span>
          <input type="number" id="cbl-global-radius" min="0.05" max="50" step="0.1"
                 value="${state.get('cableGlobalRadius') ?? 1}"
                 style="flex:1;" />
        </label>
        <label class="colorlab" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          <span class="small" style="flex:0 0 100px;">Highlight Color</span>
          <input type="color" id="cbl-highlight-color"
                 value="${_esc(state.get('cableHighlightColor') ?? '#22d3ee')}"
                 style="flex:1;height:24px;" />
        </label>
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
            : _renderCablesTreeHtml(cables, placingId)}
        </div>
      </div>

      <div id="cbl-editor" style="margin-top:10px;"></div>
    </div>
  `;

  container.querySelector('#cbl-new')?.addEventListener('click', _onCreate);
  container.querySelector('#cbl-stop')?.addEventListener('click', () => actions.stopCablePlacement());
  // Phase G: project-level cable global radius commits on change.
  container.querySelector('#cbl-global-radius')?.addEventListener('change', e => {
    actions.setCableGlobalRadius(Number(e.target.value));
  });
  container.querySelector('#cbl-highlight-color')?.addEventListener('change', e => {
    actions.setCableHighlightColor(e.target.value);
  });

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

/**
 * Phase F: render cables as a tree — roots first, branches indented
 * under their source cable, recursive. A "branch" is any cable whose
 * branchSource.cableId points to another cable in the list. Detects
 * a missing parent and falls back to flat rendering for orphans.
 */
function _renderCablesTreeHtml(cables, placingId) {
  const byId = new Map(cables.map(c => [c.id, c]));
  // Build parent → [child cable ids]
  const childrenOf = new Map();
  const orphans = [];
  for (const c of cables) {
    const pid = c.branchSource?.cableId;
    if (pid && byId.has(pid)) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(c.id);
    } else if (pid) {
      orphans.push(c);   // parent missing — render at root
    }
  }
  const roots = cables.filter(c => !c.branchSource?.cableId || !byId.has(c.branchSource.cableId));
  const out = [];
  function walk(cable, depth) {
    out.push(_renderCableRow(cable, placingId, depth));
    const children = childrenOf.get(cable.id) || [];
    for (const childId of children) {
      const child = byId.get(childId);
      if (child) walk(child, depth + 1);
    }
  }
  for (const r of roots) walk(r, 0);
  return out.join('');
}

function _renderCableRow(cable, placingId, depth = 0) {
  const eye = cable.visible ? '👁' : '·';
  const isPlacing = placingId === cable.id;
  const placeColor = isPlacing ? '#dc2626' : '#22d3ee';
  const placeIcon  = isPlacing ? '◉' : '+';
  const placeTitle = isPlacing ? 'Placing… click viewport to add points' : 'Place points on this cable';
  const highlight  = cable.highlight ? '★' : '☆';
  const pointCount = cable.nodes?.length ?? 0;
  // Phase F: indent branches under their source cable. 14px / level
  // (matches the scene-tree convention) plus a thin guide marker.
  const indent = depth * 14;
  const branchIndicator = depth > 0 ? '<span class="small muted" style="margin-right:4px;">└</span>' : '';
  return `
    <div class="row" data-cbl-id="${_esc(cable.id)}"
         style="display:flex;align-items:center;gap:6px;padding:8px 10px 8px ${10 + indent}px;border-bottom:1px solid var(--line);cursor:pointer;${_activeCableId === cable.id ? 'background:rgba(34,211,238,0.08);' : ''}">
      ${branchIndicator}
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

  const selPt   = state.get('selectedCablePoint');
  const selSock = state.get('selectedCableSocket');
  const selectedPointNodeId  = selPt   && selPt.cableId   === cable.id ? selPt.nodeId   : null;
  const selectedSocketNodeId = selSock && selSock.cableId === cable.id ? selSock.nodeId : null;

  const pointsHtml = (cable.nodes || []).map((n, i) => _renderPointRow(n, i, selectedPointNodeId, selectedSocketNodeId)).join('') ||
    `<div class="small muted" style="padding:8px 10px;">No points yet — use the place button on the row above.</div>`;

  const selectedSocketNode = selectedSocketNodeId
    ? (cable.nodes || []).find(n => n.id === selectedSocketNodeId)
    : null;
  const socketEditorHtml = selectedSocketNode?.socket
    ? _renderSocketEditor(cable.id, selectedSocketNode)
    : '';

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
        <label class="colorlab">Size %
          <input type="number" id="cbl-size" min="5" max="1000" step="5"
                 value="${cable.style?.size ?? (typeof cable.style?.radius === 'number' ? Math.round(cable.style.radius * 100 / (state.get('cableGlobalRadius') ?? 1)) : 100)}" />
        </label>
      </div>

      <div class="card" style="margin-top:10px;padding:0;">
        <div class="title" style="padding:8px 10px;border-bottom:1px solid var(--line);">
          Points <span class="small muted">(${(cable.nodes || []).length})</span>
        </div>
        <div id="cbl-points">${pointsHtml}</div>
      </div>

      ${socketEditorHtml}

      <div class="small muted" style="margin-top:6px;line-height:1.4;">
        Click a row to select. Right-click a point in the viewport for
        Re-anchor / Add socket / Insert / Delete.
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
  host.querySelector('#cbl-size')?.addEventListener('change',
    e => actions.setCableStyle(cable.id, { size: Math.max(5, Number(e.target.value) || 100) }));

  // Per-point + socket row delegation (select / delete / select socket).
  host.querySelector('#cbl-points')?.addEventListener('click', e => {
    const sockRow = e.target.closest('[data-sock-id]');
    if (sockRow) {
      const ptId = sockRow.dataset.sockId;
      const act  = e.target.closest('[data-sock-act]')?.dataset.sockAct;
      if (act === 'remove') {
        actions.removeCableSocket(cable.id, ptId);
        return;
      }
      actions.selectCableSocket(cable.id, ptId);
      return;
    }
    const row = e.target.closest('[data-pt-id]');
    if (!row) return;
    const ptId = row.dataset.ptId;
    const act  = e.target.closest('[data-pt-act]')?.dataset.ptAct;
    if (act === 'delete') {
      if (confirm('Delete this point?')) actions.deleteCablePoint(cable.id, ptId);
      return;
    }
    if (act === 'add-socket') {
      actions.addCableSocket(cable.id, ptId);
      return;
    }
    actions.selectCablePoint(cable.id, ptId);
  });

  // Socket editor field bindings — values are percentages, with an
  // optional lock-ratio checkbox that scales W/H/D proportionally
  // off whichever input the user touched.
  if (socketEditorHtml) {
    const ptId = selectedSocketNodeId;
    host.querySelector('#sock-color')?.addEventListener('change', e => {
      actions.setCableSocketProps(cable.id, ptId, { color: e.target.value });
    });
    const wInput    = host.querySelector('#sock-w');
    const hInput    = host.querySelector('#sock-h');
    const dInput    = host.querySelector('#sock-d');
    const lockInput = host.querySelector('#sock-lock');
    lockInput?.addEventListener('change', () => {
      _socketLockRatio = !!lockInput.checked;   // sticky across re-renders
    });
    const inputs = { w: wInput, h: hInput, d: dInput };
    Object.entries(inputs).forEach(([key, input]) => {
      if (!input) return;
      input.addEventListener('change', () => {
        const newVal = Number(input.value);
        if (lockInput?.checked) {
          // Compute ratio from the field that changed vs its prior
          // value — read from cable state (live) since the input has
          // already been overwritten.
          const live = (state.get('cables') || [])
            .find(c => c.id === cable.id)?.nodes
            .find(n => n.id === ptId)?.socket?.size;
          const oldVal = live ? live[key] : 100;
          if (oldVal > 0) {
            const ratio = newVal / oldVal;
            for (const [k, inp] of Object.entries(inputs)) {
              if (!inp || k === key) continue;
              inp.value = String(Math.round(Number(inp.value) * ratio));
            }
          }
        }
        actions.setCableSocketProps(cable.id, ptId, {
          size: {
            w: Number(wInput.value),
            h: Number(hInput.value),
            d: Number(dInput.value),
          },
        });
      });
    });
  }
}

function _renderPointRow(node, index, selectedPointNodeId, selectedSocketNodeId) {
  const isSelected = node.id === selectedPointNodeId;
  const tag = node.anchorType === 'mesh'   ? 'M'
            : node.anchorType === 'branch' ? 'B'
            : node.anchorType === 'free'   ? 'F'
                                            : '?';
  const tagColor = node.anchorType === 'mesh'   ? '#22c55e'
                 : node.anchorType === 'branch' ? '#a78bfa'
                 : node.anchorType === 'free'   ? '#f59e0b'
                                                : '#ef4444';
  const hasSocket    = !!node.socket;
  const sockSelected = node.id === selectedSocketNodeId;
  const pointHtml = `
    <div class="row" data-pt-id="${_esc(node.id)}"
         style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer;${isSelected ? 'background:rgba(34,211,238,0.10);' : ''}">
      <span class="small muted" style="width:18px;text-align:right;">${index + 1}</span>
      <span title="${_esc(node.anchorType || '')} anchor"
            style="display:inline-block;width:18px;height:18px;border-radius:4px;background:${tagColor};color:#000;font-size:11px;font-weight:700;text-align:center;line-height:18px;">${tag}</span>
      <div class="small" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${_esc(node.id)}
      </div>
      ${hasSocket ? '' : `<button class="btn icon" data-pt-act="add-socket" title="Add socket" style="width:22px;height:22px;padding:0;color:#22d3ee;">＋</button>`}
      <button class="btn icon" data-pt-act="delete" title="Delete this point" style="width:22px;height:22px;padding:0;color:#f87171;">✕</button>
    </div>
  `;
  if (!hasSocket) return pointHtml;
  // Indented socket sub-row.
  const sockColor = node.socket.color || '#ff9d57';
  return pointHtml + `
    <div class="row" data-sock-id="${_esc(node.id)}"
         style="display:flex;align-items:center;gap:8px;padding:4px 10px 4px 32px;border-bottom:1px solid var(--line);cursor:pointer;background:${sockSelected ? 'rgba(34,211,238,0.10)' : 'rgba(255,255,255,0.02)'};">
      <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${_esc(sockColor)};border:1px solid rgba(0,0,0,0.4);"></span>
      <div class="small" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#94a3b8;">
        socket
      </div>
      <button class="btn icon" data-sock-act="remove" title="Remove socket" style="width:22px;height:22px;padding:0;color:#f87171;">✕</button>
    </div>
  `;
}

function _renderSocketEditor(cableId, node) {
  const sock = node.socket;
  const size = sock.size || { w: 100, h: 100, d: 100 };
  return `
    <div class="card" style="margin-top:10px;padding:10px;">
      <div class="title" style="margin-bottom:8px;">Socket</div>
      <div class="grid2" style="gap:6px;">
        <label class="colorlab">Color
          <input type="color" id="sock-color" value="${_esc(sock.color || '#ff9d57')}" />
        </label>
        <label class="colorlab" style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" id="sock-lock" ${_socketLockRatio ? 'checked' : ''} />
          <span class="small">Lock ratio</span>
        </label>
      </div>
      <div class="small muted" style="margin-top:8px;">Size as % of default (cable radius × 4 / 4 / 6).</div>
      <div class="grid2" style="margin-top:4px;gap:6px;">
        <label class="colorlab">W %
          <input type="number" id="sock-w" min="10" max="500" step="5" value="${size.w}" />
        </label>
        <label class="colorlab">H %
          <input type="number" id="sock-h" min="10" max="500" step="5" value="${size.h}" />
        </label>
      </div>
      <div class="grid2" style="margin-top:6px;gap:6px;">
        <label class="colorlab">D %
          <input type="number" id="sock-d" min="10" max="500" step="5" value="${size.d}" />
        </label>
      </div>
    </div>
  `;
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
