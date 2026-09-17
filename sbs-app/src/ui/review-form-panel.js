/**
 * 📊 Review form panel (V0.3.3.11) — Tools ▸ Review form…
 * One place for the translation / proofing round trip: create the workbook,
 * import the returned one, and work through the notes that came back.
 */

import { state } from '../core/state.js';
import { setStatus } from './status.js';
import * as lang from '../systems/language-packs.js';
import { exportTranslationSheet, importTranslationSheet } from '../systems/translation-sheet.js';
import { renderReviewNotesTab, openReviewNoteWindow } from './review-notes-tab.js';
import { listReviewNotes } from '../systems/review-notes.js';

let _win = null;
let _busy = false;

export function openReviewFormPanel() {
  if (_win) { _win.style.display = ''; _render(); return; }
  _win = document.createElement('div');
  _win.id = 'review-form-panel';
  _win.style.cssText = [
    'position:fixed', 'left:120px', 'top:80px', 'width:440px', 'max-height:80vh',
    'background:var(--panel,#0f172a)', 'border:1px solid var(--line,#334155)', 'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.5)', 'z-index:45', 'display:flex', 'flex-direction:column',
    'color:var(--text,#e2e8f0)', 'font-size:13px',
  ].join(';');
  _win.innerHTML = `
    <div id="rf-header" style="cursor:move;padding:10px 12px;display:flex;align-items:center;gap:8px;background:rgba(245,158,11,0.16);border-bottom:1px solid var(--line,#334155);border-top-left-radius:10px;border-top-right-radius:10px;user-select:none;">
      <span style="flex:1;font-weight:600;font-size:13px;">📊 Review form</span>
      <button class="btn" id="rf-close" type="button" style="padding:2px 8px;font-size:12px;">✕</button>
    </div>
    <div style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--line,#334155);">
      <div class="small muted" id="rf-note" style="font-size:11.5px;line-height:1.5;"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn" id="rf-export" type="button" style="padding:4px 12px;font-weight:600;" title="Build the workbook: one tab per language, Source beside Target, step previews, Notes column for the reviewer">📤 Create sheet…</button>
        <button class="btn" id="rf-import" type="button" style="padding:4px 12px;font-weight:600;" title="Read a returned .xlsx / .ods: rows are matched by their key, previewed, applied with one undo per tab; Notes become review notes">📥 Import sheet…</button>
        <button class="btn" id="rf-window" type="button" style="padding:4px 12px;" title="Open the floating note window">🗗 Note window</button>
      </div>
    </div>
    <div id="rf-notes" style="flex:1;overflow-y:auto;min-height:120px;"></div>`;
  document.body.appendChild(_win);

  const head = _win.querySelector('#rf-header');
  let drag = null;
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = { dx: e.clientX - _win.offsetLeft, dy: e.clientY - _win.offsetTop }; head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', (e) => { if (!drag) return; _win.style.left = `${Math.max(0, e.clientX - drag.dx)}px`; _win.style.top = `${Math.max(0, e.clientY - drag.dy)}px`; });
  head.addEventListener('pointerup', () => { drag = null; });
  _win.querySelector('#rf-close').addEventListener('click', closeReviewFormPanel);
  _win.querySelector('#rf-export').addEventListener('click', () => _run('export'));
  _win.querySelector('#rf-import').addEventListener('click', () => _run('import'));
  _win.querySelector('#rf-window').addEventListener('click', () => openReviewNoteWindow(null));
  state.on('change:reviewNotes', () => { if (_win && _win.style.display !== 'none') _render(); });
  state.on('change:activeStepId', () => { if (_win && _win.style.display !== 'none') _render(); });
  _render();
}

export function closeReviewFormPanel() { if (_win) _win.style.display = 'none'; }

function _render() {
  if (!_win) return;
  const saved = !!state.get('projectPath');
  const src = lang.sourceLang(), act = lang.activeLang();
  const note = _win.querySelector('#rf-note');
  note.textContent = !saved
    ? 'Save the project first — the sheet is built from the saved project.'
    : act !== src
      ? `Switch the project back to its original language ("${src}") first (Edit ▸ Languages…) — the sheet's Source column is the original text.`
      : `Create a workbook for translators / proofreaders, send it out, keep working; import what comes back whenever it does — rows are matched by each step's permanent key, not by position. ${listReviewNotes().filter(n => !n.resolved).length} open note(s).`;
  for (const id of ['#rf-export', '#rf-import']) {
    const b = _win.querySelector(id);
    b.disabled = _busy || !saved || act !== src;
    b.style.opacity = b.disabled ? '0.45' : '';
  }
  renderReviewNotesTab(_win.querySelector('#rf-notes'));
}

async function _run(dir) {
  if (_busy) return;
  _busy = true; _render();
  try {
    if (dir === 'export') await exportTranslationSheet();
    else await importTranslationSheet();
  } catch (e) {
    console.error(`[review-form] ${dir} failed:`, e);
    setStatus(`Sheet ${dir} failed: ${e?.message || e} — details in the console (Ctrl+Shift+I).`, 'warn', 10000);
  } finally {
    _busy = false;
    _render();
  }
}

if (typeof window !== 'undefined') window.sbsReviewForm = openReviewFormPanel;
