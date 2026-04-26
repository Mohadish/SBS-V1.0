/**
 * SBS — Header Tab
 * =================
 * Sidebar UI for the project-level header overlay.
 * Buttons create header items by kind:
 *   • New Header Text       → freeform editable text
 *   • Step Number / Step Name      → dynamic per-step text
 *   • Chapter Number / Chapter Name → dynamic per-chapter text
 *   • Header Image          → upload + place an image
 *
 * Each item gets a row with:
 *   eye toggle (hide/show) · label · ↑↓ reorder · ✎ edit · 🗑 delete
 *
 * Selecting a row opens its editor below (font/color/align/position
 * for text, just position for images).
 *
 * Top-level controls: Hide All, Lock, Save/Load setup.
 */

import { state }      from '../core/state.js';
import { setStatus }  from './status.js';
import {
  addHeaderItem,
  updateHeaderItem,
  removeHeaderItem,
  reorderHeaderItem,
  toggleHeaderItemVisible,
  setHeadersHidden,
  setHeadersLocked,
  selectHeader,
} from '../systems/header.js';

const KIND_LABELS = {
  custom:        'Header Text',
  stepName:      'Step Name',
  stepNumber:    'Step Number',
  chapterName:   'Chapter Name',
  chapterNumber: 'Chapter Number',
  image:         'Header Image',
};

let _activeItemId = null;   // which item's editor is expanded

export function renderHeaderTab(container) {
  if (!container) return;
  const items   = state.get('headerItems') || [];
  const hidden  = !!state.get('headersHidden');
  const locked  = !!state.get('headersLocked');

  container.innerHTML = `
    <div class="section">
      <div class="title">Header</div>
      <div class="small muted" style="margin-top:6px;line-height:1.5;">
        Header items render on every step, on top of the per-step overlay.
        Dynamic kinds (Step / Chapter Name / Number) update automatically.
        Save Setup exports the layout as a <code>.sbsheader</code> file you
        can load into other projects.
      </div>

      <div class="card" style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <button class="btn" id="hdr-new-text">+ Text</button>
        <button class="btn" id="hdr-new-image">+ Image</button>
        <button class="btn" id="hdr-new-step-num">+ Step #</button>
        <button class="btn" id="hdr-new-step-name">+ Step Name</button>
        <button class="btn" id="hdr-new-ch-num">+ Chapter #</button>
        <button class="btn" id="hdr-new-ch-name">+ Chapter Name</button>
      </div>

      <div class="card" style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <button class="btn" id="hdr-toggle-hidden" title="Hide the entire header layer (live + export)">
          ${hidden ? '👁 Show All' : '🙈 Hide All'}
        </button>
        <button class="btn" id="hdr-toggle-lock" title="Prevent header items from being moved on the canvas">
          ${locked ? '🔓 Unlock' : '🔒 Lock'}
        </button>
        <button class="btn" id="hdr-save-setup" title="Export header layout as a .sbsheader file" disabled>Save Setup</button>
        <button class="btn" id="hdr-load-setup" title="Import a .sbsheader file" disabled>Load Setup</button>
      </div>

      <div class="card" style="margin-top:10px;padding:0;">
        <div class="title" style="padding:8px 10px;border-bottom:1px solid var(--line);">
          Items <span class="small muted">(${items.length})</span>
        </div>
        <div id="hdr-list">
          ${items.length === 0
            ? `<div class="small muted" style="padding:10px;">No header items yet — pick a + button above.</div>`
            : items.map((it, i) => _renderItemRow(it, i, items.length)).join('')}
        </div>
      </div>

      <div id="hdr-editor" style="margin-top:10px;"></div>
    </div>
  `;

  // ─── New-item buttons ──────────────────────────────────────────────────
  container.querySelector('#hdr-new-text')     .addEventListener('click', () => _create('custom'));
  container.querySelector('#hdr-new-step-num') .addEventListener('click', () => _create('stepNumber'));
  container.querySelector('#hdr-new-step-name').addEventListener('click', () => _create('stepName'));
  container.querySelector('#hdr-new-ch-num')   .addEventListener('click', () => _create('chapterNumber'));
  container.querySelector('#hdr-new-ch-name')  .addEventListener('click', () => _create('chapterName'));
  container.querySelector('#hdr-new-image')    .addEventListener('click', () => _createImage());

  // ─── Top-row toggles ───────────────────────────────────────────────────
  container.querySelector('#hdr-toggle-hidden').addEventListener('click', () => setHeadersHidden(!hidden));
  container.querySelector('#hdr-toggle-lock')  .addEventListener('click', () => setHeadersLocked(!locked));

  // ─── Per-row delegation ────────────────────────────────────────────────
  container.querySelector('#hdr-list')?.addEventListener('click', e => {
    const row = e.target.closest('[data-hdr-id]');
    if (!row) return;
    const id  = row.dataset.hdrId;
    const act = e.target.closest('[data-hdr-act]')?.dataset.hdrAct;
    if (act === 'toggle')      { toggleHeaderItemVisible(id); return; }
    if (act === 'up')          { reorderHeaderItem(id, -1); return; }
    if (act === 'down')        { reorderHeaderItem(id, +1); return; }
    if (act === 'delete')      {
      if (confirm('Delete this header item?')) {
        removeHeaderItem(id);
        if (_activeItemId === id) _activeItemId = null;
      }
      return;
    }
    // Plain click → open editor + select on canvas.
    _activeItemId = id;
    selectHeader(id);
    _renderEditor(container);
  });

  if (_activeItemId) _renderEditor(container);
}

function _renderItemRow(item, index, total) {
  const label   = KIND_LABELS[item.kind] || item.kind;
  const eye     = item.visible ? '👁' : '·';
  const preview = _itemPreviewText(item);
  return `
    <div class="row" data-hdr-id="${_esc(item.id)}"
         style="display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;${_activeItemId === item.id ? 'background:rgba(34,211,238,0.08);' : ''}">
      <button class="btn icon" data-hdr-act="toggle" title="Show / hide this item" style="width:28px;height:24px;padding:0;opacity:${item.visible ? 1 : 0.4};">${eye}</button>
      <div style="flex:1;min-width:0;">
        <div class="small" style="font-weight:600;">${_esc(label)}</div>
        <div class="small muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(preview)}</div>
      </div>
      <button class="btn icon" data-hdr-act="up"   title="Move up"   style="width:24px;height:24px;padding:0;${index === 0 ? 'opacity:0.3;' : ''}">↑</button>
      <button class="btn icon" data-hdr-act="down" title="Move down" style="width:24px;height:24px;padding:0;${index === total - 1 ? 'opacity:0.3;' : ''}">↓</button>
      <button class="btn icon" data-hdr-act="delete" title="Delete" style="width:24px;height:24px;padding:0;color:#f87171;">✕</button>
    </div>
  `;
}

function _itemPreviewText(item) {
  if (item.kind === 'image')  return item.dataUrl ? '(image)' : '(no image)';
  if (item.kind === 'custom') return item.text || '(empty)';
  return `(auto: ${KIND_LABELS[item.kind]})`;
}

function _renderEditor(container) {
  const host = container.querySelector('#hdr-editor');
  if (!host) return;
  const item = (state.get('headerItems') || []).find(it => it.id === _activeItemId);
  if (!item) { host.innerHTML = ''; return; }

  const isText  = item.kind !== 'image';
  const isFree  = item.kind === 'custom';

  host.innerHTML = `
    <div class="section">
      <div class="title">${_esc(KIND_LABELS[item.kind])}</div>
      ${isFree ? `
        <label class="colorlab" style="margin-top:8px;">Text
          <input type="text" id="hdr-text" value="${_esc(item.text || '')}" />
        </label>
      ` : ''}

      ${isText ? `
        <div class="grid2" style="margin-top:8px;">
          <label class="colorlab">Font size
            <input type="number" id="hdr-font-size" min="8" max="200" step="1" value="${item.fontSize || 32}" />
          </label>
          <label class="colorlab">Color
            <input type="color" id="hdr-color" value="${_esc(item.color || '#ffffff')}" />
          </label>
          <label class="colorlab">Align
            <select id="hdr-align">
              <option value="left"   ${item.align === 'left'   ? 'selected' : ''}>Left</option>
              <option value="center" ${item.align === 'center' ? 'selected' : ''}>Center</option>
              <option value="right"  ${item.align === 'right'  ? 'selected' : ''}>Right</option>
            </select>
          </label>
          <label class="colorlab" style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="hdr-bold"   ${item.fontWeight === 'bold' ? 'checked' : ''} /> Bold
            <input type="checkbox" id="hdr-italic" ${item.fontStyle  === 'italic' ? 'checked' : ''} /> Italic
          </label>
        </div>
      ` : ''}

      ${item.kind === 'image' ? `
        <div style="margin-top:8px;">
          <button class="btn" id="hdr-replace-image">Replace image…</button>
        </div>
      ` : ''}

      <div class="grid2" style="margin-top:8px;">
        <label class="colorlab">X (px)
          <input type="number" id="hdr-x" step="1" value="${Math.round(item.x ?? 0)}" />
        </label>
        <label class="colorlab">Y (px)
          <input type="number" id="hdr-y" step="1" value="${Math.round(item.y ?? 0)}" />
        </label>
        <label class="colorlab">Width
          <input type="number" id="hdr-w" min="20" step="1" value="${Math.round(item.w ?? 0)}" />
        </label>
        <label class="colorlab">Height
          <input type="number" id="hdr-h" min="20" step="1" value="${Math.round(item.h ?? 0)}" />
        </label>
      </div>

      <div class="small muted" style="margin-top:6px;">
        Tip: drag the box on the canvas, or use these fields for exact placement.
      </div>
    </div>
  `;

  const bind = (sel, key, transform = v => v) => {
    const el = host.querySelector(sel);
    if (!el) return;
    el.addEventListener('input',  () => updateHeaderItem(item.id, { [key]: transform(el.value) }));
    el.addEventListener('change', () => updateHeaderItem(item.id, { [key]: transform(el.value) }));
  };
  bind('#hdr-text',      'text');
  bind('#hdr-font-size', 'fontSize',  v => Math.max(8, Number(v) || 32));
  bind('#hdr-color',     'color');
  bind('#hdr-align',     'align');
  bind('#hdr-x',         'x', v => Number(v) || 0);
  bind('#hdr-y',         'y', v => Number(v) || 0);
  bind('#hdr-w',         'w', v => Math.max(20, Number(v) || 0));
  bind('#hdr-h',         'h', v => Math.max(20, Number(v) || 0));

  host.querySelector('#hdr-bold')  ?.addEventListener('change', e =>
    updateHeaderItem(item.id, { fontWeight: e.target.checked ? 'bold' : 'normal' }));
  host.querySelector('#hdr-italic')?.addEventListener('change', e =>
    updateHeaderItem(item.id, { fontStyle:  e.target.checked ? 'italic' : 'normal' }));

  host.querySelector('#hdr-replace-image')?.addEventListener('click', () => _replaceImage(item.id));
}

// ─── Create / image helpers ─────────────────────────────────────────────────

function _create(kind) {
  const item = addHeaderItem(kind);
  _activeItemId = item.id;
  selectHeader(item.id);
}

async function _createImage() {
  const dataUrl = await _pickImage();
  if (!dataUrl) return;
  const dims = await _imageDims(dataUrl);
  const item = addHeaderItem('image', {
    dataUrl,
    naturalW: dims.width,
    naturalH: dims.height,
    w: Math.min(dims.width, 480),
    h: Math.min(dims.height, 64),
  });
  _activeItemId = item.id;
  selectHeader(item.id);
}

async function _replaceImage(id) {
  const dataUrl = await _pickImage();
  if (!dataUrl) return;
  const dims = await _imageDims(dataUrl);
  updateHeaderItem(id, { dataUrl, naturalW: dims.width, naturalH: dims.height });
  setStatus('Header image replaced.');
}

function _pickImage() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const r = new FileReader();
      r.onload  = () => resolve(String(r.result || ''));
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    };
    input.click();
  });
}

function _imageDims(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

// ─── Esc helper ─────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
