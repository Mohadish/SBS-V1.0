/**
 * 📦 REDUNDANT FOLDERS — the clean-up window (backlog #16).
 *
 * V0.3.2.243 shipped this as a report: every candidate with engineering
 * verdicts (free / bake / skip) and the costs behind them. The user's verdict
 * on that: "like getting a doctor's report — I can't read it, and it's my
 * app." Most of what it listed were folders HE built and uses (a pivot he
 * placed, a folder that hides parts on some steps), which were never
 * redundant at all.
 *
 * V0.3.2.244 — the window now answers one question: which folders can go?
 * Only the free ones are listed, each with a tick box and a plain line. The
 * folders doing a job fold into one line at the bottom. One button removes
 * the ticked ones — after offering to save — through actions.
 * removeRedundantFolders, which proves nothing moves before committing.
 */

import * as actions             from '../systems/actions.js';
import { scanRedundantFolders, KIND_PLAIN } from '../systems/folder-flatten.js';
import { saveProject, getSuggestedFilename } from '../io/project.js';
import { chooseFromButtons }    from './prompt.js';
import { setStatus }            from './status.js';

let _win       = null;
let _scan      = null;
let _unchecked = new Set();   // ids the user un-ticked (everything else defaults ticked)
let _showKept  = false;
let _busy      = false;

export function openFolderFlattenPanel() {
  if (!_win) _build();
  _win.style.display = 'flex';
  rescan();
}

export function closeFolderFlattenPanel() {
  if (!_win || _busy) return;
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
    'position:fixed', 'top:80px', 'left:80px', 'width:480px', 'max-height:78vh',
    'display:flex', 'flex-direction:column', 'z-index:9998',
    'background:var(--panel,#0f172a)', 'border:1px solid var(--line,#334155)',
    'border-radius:10px', 'box-shadow:0 18px 44px rgba(0,0,0,.55)',
    'color:var(--text,#e2e8f0)', 'font-size:12px', 'overflow:hidden',
  ].join(';');

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line,#334155);cursor:move;flex-shrink:0;';
  const title = document.createElement('strong');
  title.textContent = 'Clean up folders';
  title.style.cssText = 'flex:1;font-size:13px;';
  const btnScan  = _btn('🔄', 'Scan again');
  const btnClose = _btn('✕', 'Close');
  btnScan.addEventListener('click',  () => { if (!_busy) rescan(); });
  btnClose.addEventListener('click', () => closeFolderFlattenPanel());
  head.append(title, btnScan, btnClose);
  _dragBy(head);

  const intro = document.createElement('div');
  intro.id = 'ff-intro';
  intro.style.cssText = 'padding:10px 12px 4px;line-height:1.55;flex-shrink:0;';

  const tools = document.createElement('div');
  tools.id = 'ff-tools';
  tools.style.cssText = 'display:flex;gap:6px;padding:4px 12px 0;flex-shrink:0;';

  const body = document.createElement('div');
  body.id = 'ff-rows';
  body.style.cssText = 'flex:1;min-height:0;overflow-y:auto;padding:8px 12px 10px;display:flex;flex-direction:column;gap:4px;';

  const foot = document.createElement('div');
  foot.id = 'ff-foot';
  foot.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--line,#334155);flex-shrink:0;';

  _win.append(head, intro, tools, body, foot);
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
  const free = _scan.candidates.filter(c => c.verdict === 'safe');
  const kept = _scan.candidates.filter(c => c.verdict !== 'safe');
  const ticked = free.filter(c => !_unchecked.has(c.id));

  // Intro — one sentence, plain.
  const intro = _win.querySelector('#ff-intro');
  intro.innerHTML = free.length
    ? `<b>${free.length} folder${free.length === 1 ? '' : 's'} can go.</b> They hold nothing of their own — `
      + `removing them changes nothing you see, in any step. Their contents move up into the folder above.`
    : `<b>Nothing to clean.</b> Every folder in this project is doing a job.`;

  // Select all / none.
  const tools = _win.querySelector('#ff-tools');
  tools.innerHTML = '';
  if (free.length > 1) {
    const all  = _btn('Select all', '');
    const none = _btn('Select none', '');
    all.addEventListener('click',  () => { if (_busy) return; _unchecked.clear(); _render(); });
    none.addEventListener('click', () => { if (_busy) return; _unchecked = new Set(free.map(c => c.id)); _render(); });
    tools.append(all, none);
  }

  const rows = _win.querySelector('#ff-rows');
  rows.innerHTML = '';
  for (const c of free) rows.appendChild(_freeRow(c));

  // The folders doing a job — one line, openable, never actionable here.
  if (kept.length) {
    const toggle = document.createElement('div');
    toggle.style.cssText = 'margin-top:8px;padding:6px 2px;cursor:pointer;opacity:.75;user-select:none;';
    toggle.textContent = `${_showKept ? '▾' : '▸'} ${kept.length} folder${kept.length === 1 ? ' is' : 's are'} doing a job — left alone`;
    toggle.addEventListener('click', () => { _showKept = !_showKept; _render(); });
    rows.appendChild(toggle);
    if (_showKept) for (const c of kept) rows.appendChild(_keptRow(c));
  }

  // Footer — the one action.
  const foot = _win.querySelector('#ff-foot');
  foot.innerHTML = '';
  const note = document.createElement('span');
  note.className = 'small muted';
  note.style.cssText = 'flex:1;line-height:1.4;';
  note.textContent = _busy ? 'Working…' : 'You will be asked to save first. Ctrl+Z undoes it.';
  const go = _btn(`Remove ${ticked.length} folder${ticked.length === 1 ? '' : 's'}`, '');
  go.disabled = _busy || !ticked.length;
  go.style.cssText += ';height:28px;padding:0 12px;font-weight:600;'
    + (go.disabled ? 'opacity:.5;' : 'background:rgba(239,68,68,.22);border-color:rgba(239,68,68,.6);');
  go.addEventListener('click', () => _remove(ticked));
  foot.append(note, go);
}

function _freeRow(c) {
  const el = document.createElement('label');
  el.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:6px;'
    + 'background:rgba(255,255,255,0.03);cursor:pointer;';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !_unchecked.has(c.id);
  box.disabled = _busy;
  box.style.cssText = 'margin-top:2px;flex-shrink:0;';
  box.addEventListener('change', () => {
    if (box.checked) _unchecked.delete(c.id); else _unchecked.add(c.id);
    _render();
  });
  const text = document.createElement('div');
  text.style.cssText = 'flex:1;min-width:0;';
  text.innerHTML = `
    <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${_esc(c.name)}</b></div>
    <div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${
      _esc(KIND_PLAIN[c.kind] || c.kind)}${c.path ? ` · in ${_esc(c.path)}` : ''}</div>`;
  const find = _btn('Show', 'Select this folder in the tree');
  find.style.cssText += ';height:22px;padding:0 6px;';
  find.addEventListener('click', (e) => {
    e.preventDefault();   // a click inside the <label> would otherwise toggle the box
    actions.setSelection(c.id, new Set([c.id]));
  });
  el.append(box, text, find);
  return el;
}

function _keptRow(c) {
  const el = document.createElement('div');
  el.style.cssText = 'display:flex;align-items:baseline;gap:8px;padding:3px 8px 3px 20px;opacity:.8;cursor:pointer;';
  el.title = 'Select this folder in the tree';
  el.innerHTML = `
    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.name)}</span>
    <span class="small muted" style="flex-shrink:0">${_esc(c.plain)}</span>`;
  el.addEventListener('click', () => actions.setSelection(c.id, new Set([c.id])));
  return el;
}

// ─── Remove ─────────────────────────────────────────────────────────────────

async function _remove(ticked) {
  if (_busy || !ticked.length) return;
  const n = ticked.length;

  const choice = await chooseFromButtons(
    'Remove folders',
    `This removes ${n} folder${n === 1 ? '' : 's'} from every step of the project. `
    + `Nothing you see should move — the app checks that before it changes anything, and stops if it would. `
    + `Steps it touches will re-render on the next video export.`,
    [
      { id: 'save',   label: 'Save first, then remove', primary: true },
      { id: 'nosave', label: 'Remove without saving',   danger: true },
      { id: 'cancel', label: 'Cancel' },
    ],
  );
  if (!choice || choice === 'cancel') return;

  _busy = true;
  _render();
  try {
    if (choice === 'save') {
      const r = await saveProject({ mode: 'auto', suggestedName: getSuggestedFilename() });
      if (!r?.saved) {
        setStatus('Not saved — nothing was removed.', 'warn', 5000);
        return;
      }
    }

    const res = await actions.removeRedundantFolders(ticked.map(c => c.id), {
      onProgress: (done, total) => setStatus(`Checking step ${done} of ${total}…`),
    });

    if (res.ok) {
      setStatus(`Removed ${res.removed} folder${res.removed === 1 ? '' : 's'} — nothing moved. Ctrl+Z undoes it.`, 'success', 8000);
    } else if (res.reason === 'verify' || res.reason === 'live') {
      const k = res.check;
      setStatus(`Stopped — "${k.nodeName}" ${k.why} on ${k.stepName}. Nothing was changed.`, 'warn', 15000);
      console.warn('[flatten] refused:', k);
    } else if (res.reason === 'exporting') {
      setStatus('Wait for the export to finish first.', 'warn', 5000);
    } else if (res.reason === 'animating' || res.reason === 'busy') {
      setStatus('A step is still animating — try again in a moment.', 'warn', 5000);
    } else {
      setStatus('Those folders changed since the scan — nothing was removed. Scanned again.', 'warn', 6000);
    }
  } catch (err) {
    console.error('[flatten] removal failed:', err);
    setStatus('Folder clean-up failed — see console.', 'warn', 8000);
  } finally {
    _busy = false;
    rescan();
  }
}

// ─── Utils ──────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

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
