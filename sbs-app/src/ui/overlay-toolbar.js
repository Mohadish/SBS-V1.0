/**
 * SBS — Floating toolbar for the per-step overlay editor.
 *
 * Lives at the top-right of the viewport. One button always visible ("✏ Edit")
 * that toggles the editing mode. When active, exposes:
 *   + T  add a text box
 *   + 🖼  add an image (opens file picker)
 *   🗑   delete selected
 *   Font controls when a text box is selected
 *   ✓    exit editing
 *
 * Implementation note: kept intentionally flat — single file, no templating.
 * Any styling lives inline so we don't pollute components.css for a WIP
 * feature. Migrate to a proper class later if the toolbar grows.
 */

import * as overlay from '../systems/overlay.js';
import { setStatus } from './status.js';

let _bar = null;
let _mainBtn = null;
let _tools = null;

export function initOverlayToolbar() {
  const surface = document.getElementById('viewport-surface');
  if (!surface) return;

  _bar = document.createElement('div');
  _bar.id = 'overlay-toolbar';
  _bar.style.cssText = [
    'position:absolute',
    'top:8px', 'right:8px',
    'z-index:30',
    'display:flex', 'gap:6px', 'align-items:center',
    'background:rgba(10,15,25,0.85)',
    'border:1px solid rgba(255,255,255,0.08)',
    'border-radius:8px',
    'padding:4px 6px',
    'font-size:12px',
    'user-select:none',
    'backdrop-filter:blur(4px)',
  ].join(';');

  _mainBtn = _btn('✏ Edit overlay', 'Toggle overlay editing mode');
  _mainBtn.addEventListener('click', () => _setEditing(!overlay.isEditing()));
  _bar.appendChild(_mainBtn);

  _tools = document.createElement('div');
  _tools.style.cssText = 'display:none;gap:4px;align-items:center;';
  const btnText = _btn('+ T', 'Add text box (opens editor)');
  const btnImg  = _btn('+ 🖼', 'Add image');
  const btnDel  = _btn('🗑',  'Delete selected');
  const btnDone = _btn('✓',  'Exit editing mode');
  btnText.addEventListener('click', async () => {
    const node = await overlay.addTextBox();
    if (node) setStatus('Text box added — double-click to edit.');
  });
  btnImg.addEventListener('click', async () => {
    const file = await _pickImageFile();
    if (!file) return;
    try { await overlay.addImage(file); }
    catch (e) { setStatus(`Image load failed: ${e.message}`, 'danger'); }
  });
  btnDel.addEventListener('click', () => overlay.deleteSelected());
  btnDone.addEventListener('click', () => _setEditing(false));
  _tools.append(btnText, btnImg, btnDel, _sep(), btnDone);
  _bar.appendChild(_tools);

  surface.appendChild(_bar);
}

function _setEditing(on) {
  overlay.setEditingMode(on);
  _mainBtn.textContent = on ? '✏ Editing…' : '✏ Edit overlay';
  _mainBtn.style.background = on ? 'rgba(245,158,11,0.25)' : '';
  _tools.style.display      = on ? 'flex' : 'none';
}

// ── Utils ──────────────────────────────────────────────────────────────────

function _btn(label, title) {
  const b = document.createElement('button');
  b.className   = 'btn';
  b.textContent = label;
  b.title       = title || '';
  b.style.cssText = 'height:24px;padding:0 8px;font-size:12px;';
  return b;
}

function _sep() {
  const s = document.createElement('span');
  s.style.cssText = 'width:1px;height:16px;background:rgba(255,255,255,0.15);margin:0 2px;';
  return s;
}

function _pickImageFile() {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => resolve(inp.files?.[0] || null);
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}

