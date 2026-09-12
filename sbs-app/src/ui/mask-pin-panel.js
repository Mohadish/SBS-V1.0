// ─── 🗂 Masks & Pins panel (V0.3.2.221) ─────────────────────────────────────
//
// One floating navigator for the two overlay libraries that had none:
//   🎭 Crop masks      — shared canvas-fixed crop rectangles (cropMaskId)
//   📌 Pinned positions — shared positions for shapes / images / clips
//                         (constShapeId)
//
// Both are "project-level definition + per-node id attr", so both get the
// same row: name, project-wide usage, rename, jump to a step that uses it,
// edit, delete. Usage counts come from overlay.countAttrUsage() — a raw
// string scan of every step's overlay, captured on open and on 🔄, never
// live. After hand-editing steps elsewhere, hit 🔄.
//
// Deleting a definition does NOT touch the items bound to it: a mask whose
// definition is gone draws the whole image, a pin whose definition is gone
// leaves the item where it sits, and both offer a repair entry in their
// right-click menu. That asymmetry with constant TEXT (which refuses to
// delete a type still in use) is deliberate — a missing crop or pin is
// visible and harmless, while a missing text type would blank content.
//
// Leaf module: imported dynamically from the overlay toolbar.

import { state } from '../core/state.js';
import { steps } from '../systems/steps.js';
import {
  countAttrUsage, listCropMaskDefs, listPinnedPosDefs,
  renameCropMaskDef, renamePinnedPosDef, deletePinnedPosDef, deleteCropMaskDef,
  selectByAttr, editCropMaskById,
} from '../systems/overlay.js';
import { promptString } from './prompt.js';
import { setStatus } from './status.js';

let _win   = null;
let _tab   = 'masks';          // 'masks' | 'pins'
let _usage = new Map();        // defId → { count, stepIds } — snapshot
let _navAt = new Map();        // defId → index into its stepIds

const KIND = {
  masks: {
    attr:  'cropMaskId',
    title: '🎭 Crop masks',
    empty: 'No shared masks yet. Right-click an image ▸ Add mask… ▸ New rectangle mask…, then Crop options ▸ Set as global.',
    list:   listCropMaskDefs,
    rename: renameCropMaskDef,
    remove: deleteCropMaskDef,
    detail: (d) => `${Math.round(d.w * 100)}% × ${Math.round(d.h * 100)}% of frame`,
  },
  pins: {
    attr:  'constShapeId',
    title: '📌 Pinned positions',
    empty: 'No pinned positions yet. Right-click a shape, image or clip ▸ Make pinned position…',
    list:   listPinnedPosDefs,
    rename: renamePinnedPosDef,
    remove: deletePinnedPosDef,
    detail: (d) => `anchor ${d.anchor === 'tr' ? 'top-right' : 'top-left'} · ${Math.round(d.x)}, ${Math.round(d.y)}`,
  },
};

export function openMaskPinPanel(tab = 'masks') {
  _tab = KIND[tab] ? tab : 'masks';
  if (!_win) _build();
  _win.style.display = 'flex';
  _refresh();
}

export function closeMaskPinPanel() {
  if (!_win) return;
  _win.remove();
  _win = null;
  _usage = new Map();
  _navAt = new Map();
}

// ─── Build ──────────────────────────────────────────────────────────────────

function _build() {
  _win = document.createElement('div');
  _win.id = 'mask-pin-window';
  _win.style.cssText = [
    'position:fixed', 'top:90px', 'left:90px', 'width:380px', 'max-height:72vh',
    'display:flex', 'flex-direction:column', 'z-index:9998',
    'background:var(--panel,#0f172a)', 'border:1px solid var(--line,#334155)',
    'border-radius:10px', 'box-shadow:0 18px 44px rgba(0,0,0,.55)',
    'color:var(--text,#e2e8f0)', 'font-size:12px', 'overflow:hidden',
  ].join(';');

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line,#334155);cursor:move;flex-shrink:0;';
  const title = document.createElement('strong');
  title.textContent = 'Masks & pinned positions';
  title.style.cssText = 'flex:1;font-size:13px;';
  const btnRefresh = _btn('🔄', 'Recount usage across all steps');
  const btnClose   = _btn('✕', 'Close');
  btnRefresh.addEventListener('click', () => _refresh());
  btnClose.addEventListener('click',  () => closeMaskPinPanel());
  head.append(title, btnRefresh, btnClose);
  _dragBy(head);

  const tabs = document.createElement('div');
  tabs.style.cssText = 'display:flex;gap:6px;padding:8px 12px 0;flex-shrink:0;';
  for (const key of ['masks', 'pins']) {
    const b = _btn(KIND[key].title, '');
    b.dataset.tab = key;
    b.addEventListener('click', () => { _tab = key; _refresh(); });
    tabs.appendChild(b);
  }

  const body = document.createElement('div');
  body.id = 'mp-rows';
  body.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:8px 12px 12px;display:flex;flex-direction:column;gap:6px;';

  const foot = document.createElement('div');
  foot.id = 'mp-foot';
  foot.className = 'small muted';
  foot.style.cssText = 'padding:8px 12px;border-top:1px solid var(--line,#334155);flex-shrink:0;line-height:1.5;';

  _win.append(head, tabs, body, foot);
  document.body.appendChild(_win);
}

function _btn(label, tip) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = label;
  if (tip) b.title = tip;
  b.style.cssText = 'height:24px;padding:0 8px;flex-shrink:0;';
  return b;
}

/** Drag the window by its header. */
function _dragBy(handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    on = true; sx = e.clientX; sy = e.clientY;
    const r = _win.getBoundingClientRect(); ox = r.left; oy = r.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!on) return;
    _win.style.left = `${Math.round(ox + e.clientX - sx)}px`;
    _win.style.top  = `${Math.round(oy + e.clientY - sy)}px`;
  });
  const stop = () => { on = false; };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

// ─── Render ─────────────────────────────────────────────────────────────────

function _refresh() {
  if (!_win) return;
  const kind = KIND[_tab];
  const defs = kind.list();
  _usage = countAttrUsage(kind.attr, defs.map(d => d.id));

  for (const b of _win.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === _tab;
    b.style.background = on ? 'rgba(59,130,246,0.25)' : '';
    b.style.fontWeight = on ? '700' : '';
  }

  const body = _win.querySelector('#mp-rows');
  body.innerHTML = '';
  if (!defs.length) {
    const empty = document.createElement('div');
    empty.className = 'small muted';
    empty.style.cssText = 'padding:10px 2px;line-height:1.6;';
    empty.textContent = kind.empty;
    body.appendChild(empty);
  }
  for (const def of defs) body.appendChild(_row(kind, def));

  const total = defs.reduce((n, d) => n + (_usage.get(d.id)?.count || 0), 0);
  _win.querySelector('#mp-foot').textContent =
    `${defs.length} definition(s) · ${total} use(s) across ${(state.get('steps') || []).length} step(s). `
    + 'Counts are a snapshot — press 🔄 after editing steps elsewhere.';
}

function _row(kind, def) {
  const u = _usage.get(def.id) || { count: 0, stepIds: [] };
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px;border:1px solid var(--line,#334155);border-radius:8px;';

  const info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;';
  const use = u.count
    ? `${u.count}× · ${u.stepIds.length} step(s)`
    : '<span style="color:#f59e0b;">unused</span>';
  info.innerHTML = `
    <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(def.name || def.id)}</div>
    <div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${use} · ${_esc(kind.detail(def))}</div>`;

  const btnGo = _btn('▸', u.count ? 'Go to the next step that uses this' : 'Nothing uses this yet');
  btnGo.disabled = !u.count;
  btnGo.addEventListener('click', () => _jump(kind, def.id));

  const btnEdit = _btn('✎', _tab === 'masks'
    ? 'Edit this mask on the current step (moves every image using it)'
    : 'Select an item pinned here on the current step');
  btnEdit.addEventListener('click', () => {
    const ok = _tab === 'masks' ? editCropMaskById(def.id) : selectByAttr(kind.attr, def.id);
    if (!ok && _tab === 'pins') setStatus('Nothing on this step uses that pin — press ▸ to jump to a step that does.', 'warn', 5000);
  });

  const btnRen = _btn('✏', 'Rename');
  btnRen.addEventListener('click', async () => {
    const name = await promptString('Rename', def.name || '');
    if (!name) return;
    kind.rename(def.id, name);
    _refresh();
  });

  const btnDel = _btn('🗑', 'Delete this definition');
  btnDel.addEventListener('click', () => {
    const msg = u.count
      ? `Delete "${def.name}"?\n\nIt is used ${u.count}× on ${u.stepIds.length} step(s). Those items keep their current look; `
        + (_tab === 'masks' ? 'the images go back to showing in full.' : 'the items stay where they are and can be re-pinned.')
        + '\n\nCtrl+Z undoes this.'
      : `Delete "${def.name}"? Nothing uses it.`;
    if (!window.confirm(msg)) return;
    kind.remove(def.id);
    _refresh();
  });

  row.append(info, btnGo, btnEdit, btnRen, btnDel);
  return row;
}

/** Activate the next step that uses this definition, cycling. */
async function _jump(kind, defId) {
  const u = _usage.get(defId);
  if (!u?.stepIds.length) return;
  const at = ((_navAt.get(defId) ?? -1) + 1) % u.stepIds.length;
  _navAt.set(defId, at);
  const stepId = u.stepIds[at];
  try { await steps.activateStep(stepId, false); }
  catch (err) { console.warn('[masks] jump failed:', err?.message); return; }
  setStatus(`Step ${at + 1} of ${u.stepIds.length} using this.`, 'info', 3000);
  // The overlay reloads asynchronously; select once its nodes exist.
  setTimeout(() => selectByAttr(kind.attr, defId), 350);
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
