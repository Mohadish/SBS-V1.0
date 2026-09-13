/**
 * 📦 REDUNDANT FOLDERS — the scan report (V0.3.2.243, backlog #16 Phase 1).
 *
 * A read-only window. It lists every folder level the scanner thinks adds
 * nothing, says what removing one would cost, and lets you click through to
 * see it in the tree. Nothing here changes the project — collapsing is Phase 2
 * and will be its own explicit, undoable action.
 *
 * Deliberately a report first: the last time a structural cleanup was built
 * blind (Rebuild Cascade) it turned out not to fix the thing it was aimed at,
 * and there was no way to see that beforehand. This one is inspectable before
 * a single node moves.
 */

import * as actions           from '../systems/actions.js';
import { scanRedundantFolders } from '../systems/folder-flatten.js';
import { setStatus }          from './status.js';

let _win  = null;
let _scan = null;
let _filter = 'all';

const VERDICT = {
  safe:   { icon: '✅', label: 'Free',   color: '#4ade80',
            blurb: 'identity everywhere — removing it is a pure reparent' },
  bake:   { icon: '⚠️', label: 'Bake',   color: '#fbbf24',
            blurb: 'carries a transform — every child must absorb it, per step' },
  unsafe: { icon: '⛔', label: 'Skip',   color: '#f87171',
            blurb: 'something points at this folder, or its pose cannot be composed away' },
};

const KIND_LABEL = {
  adj:         '↪ adjustment wrapper',
  passthrough: 'holds one container',
  empty:       'empty',
};

export function openFolderFlattenPanel() {
  if (!_win) _build();
  _win.style.display = 'flex';
  rescan();
}

export function closeFolderFlattenPanel() {
  if (!_win) return;
  _win.remove();
  _win = null;
  _scan = null;
}

export function rescan() {
  if (!_win) return;
  try {
    _scan = scanRedundantFolders();
  } catch (err) {
    console.error('[flatten] scan failed:', err);
    setStatus('Folder scan failed — see console.', 'warn', 6000);
    return;
  }
  _render();
}

// ─── Build ──────────────────────────────────────────────────────────────────

function _build() {
  _win = document.createElement('div');
  _win.id = 'folder-flatten-window';
  _win.style.cssText = [
    'position:fixed', 'top:80px', 'left:80px', 'width:520px', 'max-height:78vh',
    'display:flex', 'flex-direction:column', 'z-index:9998',
    'background:var(--panel,#0f172a)', 'border:1px solid var(--line,#334155)',
    'border-radius:10px', 'box-shadow:0 18px 44px rgba(0,0,0,.55)',
    'color:var(--text,#e2e8f0)', 'font-size:12px', 'overflow:hidden',
  ].join(';');

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line,#334155);cursor:move;flex-shrink:0;';
  const title = document.createElement('strong');
  title.textContent = 'Redundant folders';
  title.style.cssText = 'flex:1;font-size:13px;';
  const btnScan  = _btn('🔄', 'Scan again');
  const btnClose = _btn('✕', 'Close');
  btnScan.addEventListener('click',  () => rescan());
  btnClose.addEventListener('click', () => closeFolderFlattenPanel());
  head.append(title, btnScan, btnClose);
  _dragBy(head);

  const tabs = document.createElement('div');
  tabs.id = 'ff-tabs';
  tabs.style.cssText = 'display:flex;gap:6px;padding:8px 12px 0;flex-shrink:0;flex-wrap:wrap;';

  const body = document.createElement('div');
  body.id = 'ff-rows';
  body.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:8px 12px 12px;display:flex;flex-direction:column;gap:6px;';

  const foot = document.createElement('div');
  foot.id = 'ff-foot';
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

// ─── Render ─────────────────────────────────────────────────────────────────

function _render() {
  if (!_win || !_scan) return;
  const all   = _scan.candidates;
  const count = v => all.filter(c => c.verdict === v).length;

  const tabs = _win.querySelector('#ff-tabs');
  tabs.innerHTML = '';
  const defs = [
    ['all',    `All (${all.length})`],
    ['safe',   `${VERDICT.safe.icon} Free (${count('safe')})`],
    ['bake',   `${VERDICT.bake.icon} Bake (${count('bake')})`],
    ['unsafe', `${VERDICT.unsafe.icon} Skip (${count('unsafe')})`],
  ];
  for (const [key, label] of defs) {
    const b = _btn(label, '');
    if (_filter === key) b.style.cssText += ';outline:2px solid var(--accent,#38bdf8);outline-offset:-2px;';
    b.addEventListener('click', () => { _filter = key; _render(); });
    tabs.appendChild(b);
  }

  const rows = _win.querySelector('#ff-rows');
  rows.innerHTML = '';
  const shown = _filter === 'all' ? all : all.filter(c => c.verdict === _filter);

  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'small muted';
    empty.style.cssText = 'padding:16px 4px;line-height:1.6;';
    empty.textContent = all.length
      ? 'Nothing in this category.'
      : `No redundant folder levels found — ${_scan.folders} folder(s) checked across ${_scan.steps} step(s).`;
    rows.appendChild(empty);
  }

  for (const c of shown) rows.appendChild(_row(c));

  const foot = _win.querySelector('#ff-foot');
  foot.innerHTML = `${_scan.folders} folder(s) · ${_scan.steps} step(s) scanned. `
    + `<span style="color:${VERDICT.safe.color}">Free</span> = ${VERDICT.safe.blurb}. `
    + `<span style="color:${VERDICT.bake.color}">Bake</span> = ${VERDICT.bake.blurb}. `
    + `<span style="color:${VERDICT.unsafe.color}">Skip</span> = ${VERDICT.unsafe.blurb}.<br>`
    + `<b>Nothing here changes the project.</b> Collapsing is a separate action, not built yet.`;
}

function _row(c) {
  const v = VERDICT[c.verdict] || VERDICT.unsafe;
  const el = document.createElement('div');
  el.style.cssText = `border:1px solid ${v.color}55;border-left:3px solid ${v.color};`
    + 'border-radius:6px;padding:7px 9px;background:rgba(255,255,255,0.03);cursor:pointer;';
  el.title = 'Click to select this folder in the tree';

  const lines = [...c.reasons, ...c.notes];
  el.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:6px">
      <span style="flex-shrink:0">${v.icon}</span>
      <strong style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.name)}</strong>
      <span class="small muted" style="flex-shrink:0">${_esc(KIND_LABEL[c.kind] || c.kind)} · ${c.childCount} child${c.childCount === 1 ? '' : 'ren'}</span>
    </div>
    ${c.path ? `<div class="small muted" style="margin-top:2px;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.path)}</div>` : ''}
    ${lines.length ? `<div class="small" style="margin-top:4px;line-height:1.5;color:${v.color}">${
      lines.map(t => `• ${_esc(t)}`).join('<br>')}</div>` : ''}
  `;

  el.addEventListener('click', () => {
    // Selecting is the only thing this panel does to the app, and it goes
    // through the normal undoable selection path like any tree click.
    actions.setSelection(c.id, new Set([c.id]));
    setStatus(`Selected "${c.name}".`);
  });
  return el;
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// ─── Drag ───────────────────────────────────────────────────────────────────

function _dragBy(handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = _win.getBoundingClientRect();
    ox = r.left; oy = r.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    _win.style.left = `${Math.max(0, ox + e.clientX - sx)}px`;
    _win.style.top  = `${Math.max(0, oy + e.clientY - sy)}px`;
  });
  handle.addEventListener('pointerup', (e) => {
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  });
}
