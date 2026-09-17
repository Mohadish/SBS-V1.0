/**
 * 📝 Review notes tab + floating note window (V0.3.3.8).
 * A list of every remark that came back on a translation / proofing sheet:
 * tick = addressed, filter all / open / addressed, click a row → jump to
 * its step and open the note in a movable window (full text, the client's
 * pictures, ◀ ▶ through the list).
 */

import { state }   from '../core/state.js';
import { steps }   from '../systems/steps.js';
import { setStatus } from './status.js';
import { listReviewNotes, setReviewNoteResolved, deleteReviewNote, clearResolvedReviewNotes } from '../systems/review-notes.js';
import { stepLabelOf } from '../systems/translation-sheet-core.js';

let _filter = 'open';        // 'all' | 'open' | 'done'
let _win = null;             // floating window element
let _winNoteId = null;
let _winPos = null;          // remembered position

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function _label(n) {
  const parts = [];
  if (n.stepId) parts.push(stepLabelOf(n.stepId, state.get('steps') || [], state.get('chapters') || [], !!state.get('headerStepNumberPerChapter')) || 'Step');
  else if (n.key?.startsWith('chapter:')) parts.push('Chapter');
  else if (n.key?.startsWith('header:')) parts.push('Header');
  if (n.type) parts.push(n.type);
  if (n.lang) parts.push(n.lang);
  return parts.join(' · ');
}

function _visible() {
  const all = listReviewNotes();
  if (_filter === 'open') return all.filter(n => !n.resolved);
  if (_filter === 'done') return all.filter(n => n.resolved);
  return all;
}

// ─── tab ────────────────────────────────────────────────────────────────────

export function renderReviewNotesTab(panel) {
  if (!panel) return;
  const all = listReviewNotes();
  const open = all.filter(n => !n.resolved).length;
  const list = _visible();
  const activeId = state.get('activeStepId');
  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;padding:8px 8px 6px;flex-wrap:wrap;">
      <span style="font-weight:600;font-size:13px;">📝 Review notes</span>
      <span class="small muted" style="font-size:11px;">${open} open · ${all.length - open} addressed</span>
      <span style="flex:1"></span>
      <select id="rn-filter" class="btn" style="padding:2px 6px;font-size:12px;">
        <option value="open"${_filter === 'open' ? ' selected' : ''}>Open only</option>
        <option value="done"${_filter === 'done' ? ' selected' : ''}>Addressed only</option>
        <option value="all"${_filter === 'all' ? ' selected' : ''}>All</option>
      </select>
      <button class="btn" id="rn-open" style="padding:2px 8px;font-size:12px;" title="Open the floating note window">🗗 Open note window</button>
    </div>
    <div class="small muted" style="padding:0 8px 6px;font-size:11px;line-height:1.4;">Remarks from returned translation / proofing sheets. Click a note to jump to its step; tick it when it is addressed.</div>
    <div id="rn-list" style="display:flex;flex-direction:column;gap:3px;padding:0 6px 10px;"></div>
    <div style="padding:0 8px 10px;">
      ${all.length - open ? `<button class="btn" id="rn-clear" style="padding:2px 8px;font-size:11.5px;" title="Delete every addressed note">🧹 Clear addressed (${all.length - open})</button>` : ''}
    </div>`;
  const listEl = panel.querySelector('#rn-list');
  if (!list.length) {
    listEl.innerHTML = `<div class="small muted" style="padding:10px 4px;font-size:12px;">${all.length ? 'Nothing in this filter.' : 'No notes yet — they arrive with an imported sheet (Edit ▸ Languages ▸ 📥 Sheet).'}</div>`;
  }
  for (const n of list) {
    const row = document.createElement('div');
    const here = n.stepId && n.stepId === activeId;
    row.style.cssText = `display:flex;align-items:flex-start;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:12px;`
      + `border:1px solid ${here ? '#3b82f6' : 'var(--line,#334155)'};background:${here ? 'rgba(59,130,246,0.16)' : 'var(--panel2,#1e293b)'};`
      + (n.resolved ? 'opacity:0.65;' : '');
    row.title = n.text;
    row.innerHTML = `
      <input type="checkbox" ${n.resolved ? 'checked' : ''} title="Addressed" style="margin-top:2px;">
      <div style="flex:1;min-width:0;">
        <div class="small muted" style="font-size:10.5px;">${_esc(_label(n))}${n.images?.length ? ' · 📎' : ''}</div>
        <div dir="auto" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${n.resolved ? 'text-decoration:line-through;' : ''}">${_esc(n.text || '(picture only)')}</div>
      </div>`;
    row.querySelector('input').addEventListener('click', (e) => { e.stopPropagation(); setReviewNoteResolved(n.id, e.target.checked); });
    row.addEventListener('click', () => { _jumpTo(n); openReviewNoteWindow(n.id); });
    listEl.appendChild(row);
  }
  panel.querySelector('#rn-filter').addEventListener('change', (e) => { _filter = e.target.value; renderReviewNotesTab(panel); });
  panel.querySelector('#rn-open').addEventListener('click', () => openReviewNoteWindow(_winNoteId || list[0]?.id || null));
  panel.querySelector('#rn-clear')?.addEventListener('click', () => { const k = clearResolvedReviewNotes(); if (k) setStatus(`${k} addressed note(s) cleared.`, 'info', 4000); });
}

async function _jumpTo(n) {
  if (!n.stepId) return;
  if (!(state.get('steps') || []).some(s => s.id === n.stepId)) { setStatus('That step no longer exists.', 'warn', 4000); return; }
  if (state.get('activeStepId') !== n.stepId) await steps.activateStep(n.stepId, false);
}

// ─── floating window ────────────────────────────────────────────────────────

export function openReviewNoteWindow(id) {
  const all = listReviewNotes();
  if (!all.length) { setStatus('No review notes yet.', 'info', 3000); return; }
  const note = all.find(n => n.id === id) || _visible()[0] || all[0];
  _winNoteId = note.id;
  if (!_win) _buildWindow();
  _renderWindow();
  _win.style.display = '';
}

export function closeReviewNoteWindow() {
  if (_win) _win.style.display = 'none';
}

function _buildWindow() {
  _win = document.createElement('div');
  _win.id = 'review-note-window';
  _win.style.cssText = [
    'position:fixed', 'z-index:46', 'width:360px', 'max-height:70vh', 'display:flex', 'flex-direction:column',
    'background:var(--panel,#0f172a)', 'border:1px solid #f59e0b', 'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.55)', 'color:var(--text,#e2e8f0)', 'font-size:12.5px', 'user-select:text',
    `left:${_winPos?.left ?? Math.max(20, window.innerWidth - 400)}px`, `top:${_winPos?.top ?? 90}px`,
  ].join(';');
  _win.innerHTML = `
    <div id="rn-head" style="cursor:move;padding:8px 10px;display:flex;align-items:center;gap:6px;background:rgba(245,158,11,0.18);border-bottom:1px solid var(--line,#334155);border-top-left-radius:10px;border-top-right-radius:10px;user-select:none;">
      <span style="font-weight:600;flex:1;">📝 Review note</span>
      <button class="btn" data-act="prev" title="Previous note" style="padding:1px 7px;font-size:12px;">◀</button>
      <span id="rn-pos" class="small muted" style="font-size:11px;"></span>
      <button class="btn" data-act="next" title="Next note" style="padding:1px 7px;font-size:12px;">▶</button>
      <button class="btn" data-act="close" title="Close" style="padding:1px 7px;font-size:12px;">✕</button>
    </div>
    <div id="rn-body" style="padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:8px;"></div>
    <div style="padding:8px 12px;border-top:1px solid var(--line,#334155);display:flex;align-items:center;gap:8px;">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="rn-done"> Addressed</label>
      <span style="flex:1"></span>
      <button class="btn" data-act="jump" style="padding:2px 8px;font-size:12px;" title="Go to the step this note is about">Go to step</button>
      <button class="btn" data-act="delete" style="padding:2px 8px;font-size:12px;color:#f87171;" title="Delete this note">🗑</button>
    </div>`;
  document.body.appendChild(_win);
  // drag by the header
  const head = _win.querySelector('#rn-head');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = { dx: e.clientX - _win.offsetLeft, dy: e.clientY - _win.offsetTop };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const left = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - 80);
    const top  = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 40);
    _win.style.left = `${left}px`; _win.style.top = `${top}px`;
    _winPos = { left, top };
  });
  head.addEventListener('pointerup', () => { drag = null; });
  _win.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const list = _visible().length ? _visible() : listReviewNotes();
    const i = list.findIndex(n => n.id === _winNoteId);
    if (act === 'close') closeReviewNoteWindow();
    else if (act === 'prev' && list.length) { const n = list[(i - 1 + list.length) % list.length]; _winNoteId = n.id; _jumpTo(n); _renderWindow(); }
    else if (act === 'next' && list.length) { const n = list[(i + 1) % list.length]; _winNoteId = n.id; _jumpTo(n); _renderWindow(); }
    else if (act === 'jump') { const n = listReviewNotes().find(x => x.id === _winNoteId); if (n) _jumpTo(n); }
    else if (act === 'delete') { deleteReviewNote(_winNoteId); const rest = listReviewNotes(); if (!rest.length) closeReviewNoteWindow(); else { _winNoteId = rest[0].id; _renderWindow(); } }
  });
  _win.querySelector('#rn-done').addEventListener('change', (e) => setReviewNoteResolved(_winNoteId, e.target.checked));
  state.on('change:reviewNotes', () => { if (_win && _win.style.display !== 'none') _renderWindow(); });
}

function _renderWindow() {
  const all = listReviewNotes();
  const note = all.find(n => n.id === _winNoteId);
  const body = _win.querySelector('#rn-body');
  if (!note) { body.innerHTML = '<div class="small muted">This note is gone.</div>'; return; }
  const list = _visible().length ? _visible() : all;
  const i = list.findIndex(n => n.id === note.id);
  _win.querySelector('#rn-pos').textContent = i >= 0 ? `${i + 1} / ${list.length}` : `— / ${list.length}`;
  _win.querySelector('#rn-done').checked = !!note.resolved;
  const stepGone = note.stepId && !(state.get('steps') || []).some(s => s.id === note.stepId);
  body.innerHTML = `
    <div class="small muted" style="font-size:11px;">${_esc(_label(note))}${stepGone ? ' · <span style="color:#f87171">step deleted</span>' : ''}${note.file ? ` · ${_esc(note.file)}` : ''}</div>
    <div dir="auto" style="white-space:pre-wrap;word-break:break-word;line-height:1.45;">${_esc(note.text) || '<span class="small muted">(no text — picture only)</span>'}</div>
    ${(note.images || []).map(u => `<img src="${u}" style="max-width:100%;border-radius:6px;border:1px solid var(--line,#334155);">`).join('')}`;
}
