/**
 * SBS — Style Tab
 * ================
 * Sidebar UI for the project-level text style templates. Each template
 * is a saved set of typography (font / size / colour / weight / style /
 * decoration / fill) that text boxes can bind to via styleId.
 *
 * Tab layout:
 *   [+ New Style]                       header row
 *   ─────────────
 *   • Heading      [preview swatch]  ✕  ← row, click to select
 *   • Body         [preview swatch]  ✕
 *   ...
 *   ─────────────
 *   <Sample preview at full size — updates live as the user edits>
 *   <text-toolbar mounted in tab — alignment hidden>
 *
 * Editing flow
 *   1. Click a row → that template becomes "active"
 *   2. The shared text-toolbar mounts inside the tab (via the slot
 *      element this module owns) with showAlignment:false
 *   3. Toolbar actions go through a tab-local applier that patches the
 *      active template via updateStyleTemplate(). State emits
 *      'styleTemplate:updated' which the upcoming render-path commit
 *      will use to live-propagate to bound text boxes.
 */

import { state }     from '../core/state.js';
import {
  listStyleTemplates,
  addStyleTemplate,
  updateStyleTemplate,
  removeStyleTemplate,
  renameStyleTemplate,
} from '../systems/style-templates.js';
import { mountTextToolbar, unmountTextToolbar, setToolbarValues } from './text-toolbar.js';

let _activeId  = null;        // which template is being edited
let _container = null;
let _slot      = null;        // host for the mounted text-toolbar

export function renderStyleTab(container) {
  _container = container;
  if (!container) return;
  const items = listStyleTemplates();

  container.innerHTML = `
    <div class="section">
      <div class="title">Text Styles</div>
      <div class="small muted" style="margin-top:6px;line-height:1.5;">
        Project-level templates. Bind a text box to a template via the
        canvas toolbar's "Style" dropdown — the box renders using the
        template's font / colour / fill instead of any inline styles.
        Editing a template updates every box that references it.
      </div>

      <div class="card" style="margin-top:10px;display:flex;gap:6px;">
        <button class="btn" id="style-new" style="flex:1;">+ New style</button>
      </div>

      <div class="card" style="margin-top:8px;padding:0;">
        <div class="title" style="padding:8px 10px;border-bottom:1px solid var(--line);">
          Templates <span class="small muted">(${items.length})</span>
        </div>
        <div id="style-list">
          ${items.length === 0
            ? `<div class="small muted" style="padding:10px;">No styles yet — pick "+ New style".</div>`
            : items.map(t => _row(t)).join('')}
        </div>
      </div>

      <div id="style-editor"></div>
    </div>
  `;

  container.querySelector('#style-new').addEventListener('click', _onCreate);

  // Per-row delegation.
  const list = container.querySelector('#style-list');
  list?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-style-id]');
    if (!row) return;
    const id = row.dataset.styleId;
    const act = e.target.closest('[data-style-act]')?.dataset.styleAct;
    if (act === 'delete') {
      if (confirm('Delete this style? Any text boxes using it will be unbound.')) {
        removeStyleTemplate(id);
        if (_activeId === id) _activeId = null;
      }
      return;
    }
    if (act === 'rename') {
      const tpl = listStyleTemplates().find(t => t.id === id);
      const name = prompt('Style name:', tpl?.name || '');
      if (name) renameStyleTemplate(id, name);
      return;
    }
    _setActive(id);
  });

  if (_activeId && items.find(t => t.id === _activeId)) {
    _renderEditor();
  } else {
    _activeId = null;
  }
}

function _row(tpl) {
  const previewStyle = _previewCss(tpl);
  return `
    <div class="row" data-style-id="${_esc(tpl.id)}"
         style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;${_activeId === tpl.id ? 'background:rgba(34,211,238,0.08);' : ''}">
      <div style="flex:0 0 100px;${previewStyle};border-radius:4px;padding:4px 6px;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">Aa Bb 12</div>
      <div style="flex:1;min-width:0;">
        <div class="small" style="font-weight:600;">${_esc(tpl.name || 'Untitled')}</div>
        <div class="small muted" style="font-size:11px;">${_esc(tpl.fontFamily || '')} · ${tpl.fontSize || 16}px · ${_esc(tpl.color || '#fff')}</div>
      </div>
      <button class="btn icon" data-style-act="rename" title="Rename" style="width:24px;height:24px;padding:0;">✎</button>
      <button class="btn icon" data-style-act="delete" title="Delete" style="width:24px;height:24px;padding:0;color:#f87171;">✕</button>
    </div>
  `;
}

function _previewCss(tpl) {
  const parts = [
    `color:${tpl.color || '#fff'}`,
    `font-family:${tpl.fontFamily || 'Arial'}`,
    `font-size:${Math.min(20, Math.max(10, tpl.fontSize || 16))}px`,   // clamp for swatch readability
    `font-weight:${tpl.fontWeight || 'normal'}`,
    `font-style:${tpl.fontStyle || 'normal'}`,
    `text-decoration:${tpl.textDecoration || 'none'}`,
  ];
  if (tpl.fillColor) parts.push(`background-color:${tpl.fillColor}`);
  else               parts.push('background:rgba(255,255,255,0.04)');
  return parts.join(';');
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

// ─── Active template editor ─────────────────────────────────────────────

function _setActive(id) {
  _activeId = id;
  unmountTextToolbar();
  renderStyleTab(_container);
}

function _renderEditor() {
  const host = _container?.querySelector('#style-editor');
  if (!host) return;
  const tpl = listStyleTemplates().find(t => t.id === _activeId);
  if (!tpl) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <div class="section">
      <div class="title">Editing: ${_esc(tpl.name)}</div>
      <div id="style-toolbar-slot" style="margin-top:8px;display:flex;gap:4px;align-items:center;flex-wrap:wrap;
                                          background:rgba(10,15,25,0.85);border:1px solid rgba(255,255,255,0.08);
                                          border-radius:8px;padding:4px 6px;"></div>
      <div class="small muted" style="margin-top:8px;">Live preview:</div>
      <div id="style-preview" style="margin-top:4px;padding:12px;border-radius:8px;border:1px solid var(--line);
                                     ${_previewCssFull(tpl)}">
        The quick brown fox jumps over the lazy dog. 0123456789
      </div>
    </div>
  `;

  _slot = host.querySelector('#style-toolbar-slot');
  mountTextToolbar(_slot, _styleApplier, null, { showAlignment: false });
  // Seed the toolbar dropdowns with the current template values so the
  // user sees the right starting state.
  setToolbarValues({
    fontSize:  tpl.fontSize,
    fontName:  tpl.fontFamily,
    color:     tpl.color,
    fillColor: _fillHex(tpl.fillColor),
    fillAlpha: _fillAlpha(tpl.fillColor),
  });
}

function _previewCssFull(tpl) {
  const parts = [
    `color:${tpl.color || '#fff'}`,
    `font-family:${tpl.fontFamily || 'Arial'}`,
    `font-size:${tpl.fontSize || 16}px`,
    `font-weight:${tpl.fontWeight || 'normal'}`,
    `font-style:${tpl.fontStyle || 'normal'}`,
    `text-decoration:${tpl.textDecoration || 'none'}`,
    'line-height:1.4',
  ];
  if (tpl.fillColor) parts.push(`background-color:${tpl.fillColor}`);
  return parts.join(';');
}

/**
 * Toolbar action dispatcher for the style-tab editor. Translates the
 * generic engine actions into patches on the active template.
 */
function _styleApplier(action, value) {
  if (!_activeId) return;
  const tpl = listStyleTemplates().find(t => t.id === _activeId);
  if (!tpl) return;
  let patch = null;
  switch (action) {
    case 'color':       patch = { color: String(value) }; break;
    case 'fontFamily':  patch = { fontFamily: String(value) }; break;
    case 'fontSize':    patch = { fontSize: Number(value) || 16 }; break;
    case 'bold':        patch = { fontWeight: tpl.fontWeight === 'bold' ? 'normal' : 'bold' }; break;
    case 'italic':      patch = { fontStyle:  tpl.fontStyle  === 'italic' ? 'normal' : 'italic' }; break;
    case 'underline':   patch = { textDecoration: tpl.textDecoration === 'underline' ? '' : 'underline' }; break;
    case 'fillColor':   patch = { fillColor: String(value) }; break;
    // alignLeft/Center/Right intentionally not supported in style mode.
  }
  if (patch) updateStyleTemplate(_activeId, patch);
}

function _fillHex(rgba) {
  if (!rgba) return null;
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(String(rgba));
  if (!m) return null;
  const hex = (n) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}
function _fillAlpha(rgba) {
  if (!rgba) return null;
  const m = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/i.exec(String(rgba));
  return m ? Math.round(parseFloat(m[1]) * 100) : 100;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

function _onCreate() {
  const tpl = addStyleTemplate({ name: `Style ${listStyleTemplates().length + 1}` });
  _setActive(tpl.id);
}
