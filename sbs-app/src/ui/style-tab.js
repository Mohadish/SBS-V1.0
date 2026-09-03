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
import {
  listShapeStyles,
  addShapeStyle,
  updateShapeStyle,
  removeShapeStyle,
  renameShapeStyle,
} from '../systems/shape-styles.js';
import { exportHeaderSetup, importHeaderSetup } from '../systems/header.js';
import { setStatus }    from './status.js';
import { promptString, chooseFromButtons } from './prompt.js';
import { mountTextToolbar, unmountTextToolbar, setToolbarValues } from './text-toolbar.js';

let _activeId  = null;        // which template is being edited
let _container = null;
let _slot      = null;        // host for the mounted text-toolbar
let _tab       = 'text';      // 'text' | 'shape'

/**
 * Tab shell. Text styles and shape styles are two lists of the same kind
 * of thing — saved looks you bind to — so they share this panel rather
 * than competing for sidebar space.
 */
export function renderStyleTab(container) {
  _container = container;
  if (!container) return;

  const tabBtn = (id, label, on) => `
    <button class="btn" id="${id}" style="flex:1;${on
      ? 'background:rgba(34,211,238,0.14);border-color:rgba(34,211,238,0.5);font-weight:600;'
      : 'opacity:0.75;'}">${label}</button>`;

  container.innerHTML = `
    <div class="section" style="padding-bottom:0;">
      <div style="display:flex;gap:6px;">
        ${tabBtn('sty-tab-text',  'Text styles',  _tab === 'text')}
        ${tabBtn('sty-tab-shape', 'Shape styles', _tab === 'shape')}
      </div>
    </div>
    <div id="style-tab-body"></div>
  `;

  container.querySelector('#sty-tab-text').addEventListener('click', () => {
    if (_tab === 'text') return;
    _tab = 'text'; _activeShapeId = null; unmountTextToolbar();
    renderStyleTab(_container);
  });
  container.querySelector('#sty-tab-shape').addEventListener('click', () => {
    if (_tab === 'shape') return;
    _tab = 'shape'; _activeId = null; unmountTextToolbar();
    renderStyleTab(_container);
  });

  const body = container.querySelector('#style-tab-body');
  if (_tab === 'shape') _renderShapeBody(body);
  else                  _renderTextBody(body);
}

function _renderTextBody(container) {
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
        Save Setup exports styles <em>and</em> header items together as
        a single <code>.sbsheader</code> preset file.
      </div>

      <div class="card" style="margin-top:10px;display:flex;gap:6px;">
        <button class="btn" id="style-new" style="flex:1;">+ New style</button>
      </div>

      <div class="card" style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <button class="btn" id="style-save-setup" title="Export styles + header items as a .sbsheader preset file" ${(items.length === 0 && (state.get('headerItems') || []).length === 0) ? 'disabled' : ''}>Save Setup</button>
        <button class="btn" id="style-load-setup" title="Import a .sbsheader file (replaces styles and/or header items)">Load Setup</button>
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

  container.querySelector('#style-new')       .addEventListener('click', _onCreate);
  container.querySelector('#style-save-setup')?.addEventListener('click', _onSaveSetup);
  container.querySelector('#style-load-setup')?.addEventListener('click', _onLoadSetup);

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
      // Electron renderer blocks window.prompt — use the shared modal.
      const tpl = listStyleTemplates().find(t => t.id === id);
      promptString('Style name:', tpl?.name || '').then(name => {
        if (name) renameStyleTemplate(id, name);
      });
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

// ═══ Shape styles ═══════════════════════════════════════════════════════
//
// Same idea as text styles, different property set: fill (colour + its own
// alpha) and outline (colour + thickness). Corner radius is deliberately
// absent — it's rectangle geometry, not styling, so it stays per-shape and
// keeps working even on a shape that's bound to a style.

let _activeShapeId = null;

function _renderShapeBody(container) {
  if (!container) return;
  const items = listShapeStyles();

  container.innerHTML = `
    <div class="section">
      <div class="title">Shape Styles</div>
      <div class="small muted" style="margin-top:6px;line-height:1.5;">
        Saved fill + outline looks. Bind a shape via the canvas toolbar's
        style dropdown — while bound, the style wins and the shape's own
        fill/outline controls are hidden. Pick <em>(no style)</em> to unbind;
        the shape keeps the look it has and becomes editable again.
        Corner radius stays per-shape either way.
      </div>

      <div class="card" style="margin-top:10px;display:flex;gap:6px;">
        <button class="btn" id="shapestyle-new" style="flex:1;">+ New shape style</button>
      </div>

      <div class="card" style="margin-top:8px;padding:0;">
        <div class="title" style="padding:8px 10px;border-bottom:1px solid var(--line);">
          Styles <span class="small muted">(${items.length})</span>
        </div>
        <div id="shapestyle-list">
          ${items.length === 0
            ? `<div class="small muted" style="padding:10px;">No shape styles yet — pick "+ New shape style".</div>`
            : items.map(t => _shapeRow(t)).join('')}
        </div>
      </div>

      <div id="shapestyle-editor"></div>
    </div>
  `;

  container.querySelector('#shapestyle-new').addEventListener('click', () => {
    const tpl = addShapeStyle({ name: `Shape style ${listShapeStyles().length + 1}` });
    _activeShapeId = tpl.id;
    renderStyleTab(_container);
  });

  container.querySelector('#shapestyle-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-shapestyle-id]');
    if (!row) return;
    const id  = row.dataset.shapestyleId;
    const act = e.target.closest('[data-shapestyle-act]')?.dataset.shapestyleAct;
    if (act === 'delete') {
      if (confirm('Delete this shape style? Shapes using it keep their current look and become editable again.')) {
        removeShapeStyle(id);
        if (_activeShapeId === id) _activeShapeId = null;
        renderStyleTab(_container);
      }
      return;
    }
    if (act === 'rename') {
      const tpl = listShapeStyles().find(t => t.id === id);
      promptString('Shape style name:', tpl?.name || '').then(name => {
        if (name) { renameShapeStyle(id, name); renderStyleTab(_container); }
      });
      return;
    }
    _activeShapeId = id;
    renderStyleTab(_container);
  });

  if (_activeShapeId && items.find(t => t.id === _activeShapeId)) _renderShapeEditor();
  else _activeShapeId = null;
}

function _shapeRow(tpl) {
  return `
    <div class="row" data-shapestyle-id="${_esc(tpl.id)}"
         style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;${_activeShapeId === tpl.id ? 'background:rgba(34,211,238,0.08);' : ''}">
      <div style="flex:0 0 46px;height:26px;border-radius:4px;${_shapeSwatchCss(tpl)}"></div>
      <div style="flex:1;min-width:0;">
        <div class="small" style="font-weight:600;">${_esc(tpl.name || 'Untitled')}</div>
        <div class="small muted" style="font-size:11px;">
          ${tpl.fill ? 'fill' : 'no fill'} · ${tpl.stroke ? `${tpl.strokeWidth || 0}px outline` : 'no outline'}
        </div>
      </div>
      <button class="btn icon" data-shapestyle-act="rename" title="Rename" style="width:24px;height:24px;padding:0;">✎</button>
      <button class="btn icon" data-shapestyle-act="delete" title="Delete" style="width:24px;height:24px;padding:0;color:#f87171;">✕</button>
    </div>
  `;
}

function _shapeSwatchCss(tpl) {
  const parts = [];
  parts.push(`background:${tpl.fill || 'transparent'}`);
  if (tpl.stroke) parts.push(`border:${Math.min(6, Math.max(1, tpl.strokeWidth || 1))}px solid ${tpl.stroke}`);
  else            parts.push('border:1px dashed rgba(255,255,255,0.2)');
  return parts.join(';');
}

function _renderShapeEditor() {
  const host = _container?.querySelector('#shapestyle-editor');
  if (!host) return;
  const tpl = listShapeStyles().find(t => t.id === _activeShapeId);
  if (!tpl) { host.innerHTML = ''; return; }

  const fillOn = tpl.fill != null;
  const strkOn = tpl.stroke != null;

  host.innerHTML = `
    <div class="section">
      <div class="title">Editing: ${_esc(tpl.name)}</div>
      <div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;
                  background:rgba(10,15,25,0.85);border:1px solid rgba(255,255,255,0.08);
                  border-radius:8px;padding:8px;font-size:12px;">
        <label style="display:flex;align-items:center;gap:4px;" title="Fill colour">
          Fill <input id="ss-fill" type="color" value="${_esc(_fillHex(tpl.fill) || '#4a90d9')}"
               style="width:28px;height:24px;padding:0;border:1px solid var(--line);background:transparent" />
          <input id="ss-fill-on" type="checkbox" ${fillOn ? 'checked' : ''} title="Enable fill" />
        </label>
        <label style="display:flex;align-items:center;gap:4px;" title="Fill opacity">
          α <input id="ss-fill-alpha" type="range" min="0" max="1" step="0.01"
               value="${_alphaOfRgba(tpl.fill)}" style="width:70px" />
        </label>
        <label style="display:flex;align-items:center;gap:4px;" title="Outline colour">
          Line <input id="ss-stroke" type="color" value="${_esc(tpl.stroke || '#4a90d9')}"
               style="width:28px;height:24px;padding:0;border:1px solid var(--line);background:transparent" />
          <input id="ss-stroke-on" type="checkbox" ${strkOn ? 'checked' : ''} title="Enable outline" />
        </label>
        <label style="display:flex;align-items:center;gap:4px;" title="Outline thickness in pixels">
          Thick <input id="ss-stroke-w" type="number" min="0" max="200" step="1" value="${tpl.strokeWidth ?? 3}"
               style="width:46px;height:22px;padding:0 4px;font-size:12px" />
        </label>
      </div>
      <div class="small muted" style="margin-top:8px;">Live preview:</div>
      <div style="margin-top:4px;padding:14px;border-radius:8px;border:1px solid var(--line);
                  display:flex;justify-content:center;">
        <div id="ss-preview" style="width:120px;height:64px;border-radius:6px;${_shapeSwatchCss(tpl)}"></div>
      </div>
    </div>
  `;

  const q = (sel) => host.querySelector(sel);
  // Compose from the LIVE control values every time, so each tweak stacks
  // on the latest state rather than the moment-of-render snapshot.
  const composeFill = () => _composeRgba(q('#ss-fill').value, q('#ss-fill-alpha').value);
  const patch = (p) => {
    updateShapeStyle(_activeShapeId, p);
    const cur = listShapeStyles().find(t => t.id === _activeShapeId);
    if (!cur) return;
    // Repaint preview + the list row in place. A full re-render would
    // steal focus from the slider mid-drag.
    q('#ss-preview').style.cssText = `width:120px;height:64px;border-radius:6px;${_shapeSwatchCss(cur)}`;
    const row = _container?.querySelector(`[data-shapestyle-id="${cur.id}"]`);
    if (row) {
      const sw = row.firstElementChild;
      if (sw) sw.style.cssText = `flex:0 0 46px;height:26px;border-radius:4px;${_shapeSwatchCss(cur)}`;
      const meta = row.querySelector('.small.muted');
      if (meta) meta.textContent =
        `${cur.fill ? 'fill' : 'no fill'} · ${cur.stroke ? `${cur.strokeWidth || 0}px outline` : 'no outline'}`;
    }
  };

  q('#ss-fill')      .addEventListener('input',  () => { if (q('#ss-fill-on').checked) patch({ fill: composeFill() }); });
  q('#ss-fill-alpha').addEventListener('input',  () => { if (q('#ss-fill-on').checked) patch({ fill: composeFill() }); });
  q('#ss-fill-on')   .addEventListener('change', e  => patch({ fill: e.target.checked ? composeFill() : null }));
  q('#ss-stroke')    .addEventListener('input',  () => { if (q('#ss-stroke-on').checked) patch({ stroke: q('#ss-stroke').value }); });
  q('#ss-stroke-on') .addEventListener('change', e  => patch({ stroke: e.target.checked ? q('#ss-stroke').value : null }));
  q('#ss-stroke-w')  .addEventListener('input',  e  => patch({ strokeWidth: Math.max(0, Number(e.target.value) || 0) }));
}

/** Build 'rgba(r,g,b,a)' from a #rrggbb hex + 0..1 alpha. */
function _composeRgba(hex, alpha) {
  const h = /^#[0-9a-f]{6}$/i.test(String(hex)) ? String(hex) : '#4a90d9';
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${r},${g},${b},${a})`;
}

/** Alpha 0..1 from an rgba() string; 1 for hex / rgb() / null. */
function _alphaOfRgba(rgba) {
  const m = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/i.exec(String(rgba || ''));
  return m ? Math.max(0, Math.min(1, parseFloat(m[1]))) : 1;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

function _onCreate() {
  const tpl = addStyleTemplate({ name: `Style ${listStyleTemplates().length + 1}` });
  _setActive(tpl.id);
}

// ─── .sbsheader unified save / load ─────────────────────────────────────────
//
// The same .sbsheader file format carries BOTH header items and style
// templates (v2). Exposing Save / Load here lets the user round-trip the
// pair from either tab — picking the same file from either side restores
// both sections.

async function _onSaveSetup() {
  const payload = exportHeaderSetup();
  const nItems  = payload.items?.length  || 0;
  const nStyles = payload.styles?.length || 0;
  if (!nItems && !nStyles) { setStatus('Nothing to save (no styles or header items).', 'warning'); return; }
  const json = JSON.stringify(payload, null, 2);

  if (window.sbsNative?.saveHeader && window.sbsNative?.writeFile) {
    const path = await window.sbsNative.saveHeader('header_setup.sbsheader');
    if (!path) return;
    const res = await window.sbsNative.writeFile(path, json, 'utf-8');
    if (res?.ok) setStatus(`Saved preset → ${path.split(/[\\/]/).pop()}`);
    else         setStatus(`Save failed: ${res?.error || 'unknown'}`, 'danger');
    return;
  }
  // Browser fallback — anchor download.
  const blob = new Blob([json], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'header_setup.sbsheader';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus('Saved preset (downloaded).');
}

async function _onLoadSetup() {
  let json = null;

  if (window.sbsNative?.openHeader && window.sbsNative?.readFile) {
    const path = await window.sbsNative.openHeader();
    if (!path) return;
    const res = await window.sbsNative.readFile(path, 'utf-8');
    if (!res?.ok) { setStatus(`Load failed: ${res?.error || 'unknown'}`, 'danger'); return; }
    json = res.data;
  } else {
    json = await new Promise(resolve => {
      const input = document.createElement('input');
      input.type   = 'file';
      input.accept = '.sbsheader,.json,application/json';
      input.onchange = () => {
        const f = input.files?.[0];
        if (!f) { resolve(null); return; }
        const r = new FileReader();
        r.onload  = () => resolve(String(r.result || ''));
        r.onerror = () => resolve(null);
        r.readAsText(f);
      };
      input.click();
    });
    if (!json) return;
  }

  let payload;
  try { payload = JSON.parse(json); }
  catch (err) { setStatus('Invalid .sbsheader file (not JSON).', 'danger'); return; }

  // Style tab loads the STYLE side of a .sbsheader, never the header
  // items — those live in the Header tab and shouldn't disappear when
  // the user is just trying to import some styles. Default Style block
  // is also skipped from the Style tab.
  const incoming = Array.isArray(payload?.styles) ? payload.styles.length : 0;
  if (!incoming) {
    setStatus('No style templates found in the file.', 'warning');
    return;
  }
  const existing = (state.get('styleTemplates') || []).length;

  let stylesMode = 'replace';
  if (existing > 0) {
    const choice = await chooseFromButtons(
      'Load Style Setup',
      `${incoming} style template(s) in the file. You currently have ${existing}. Replace, or add to the existing list (duplicate names get auto-renamed)?`,
      [
        { id: 'cancel',  label: 'Cancel' },
        { id: 'add',     label: 'Add to list', primary: true },
        { id: 'replace', label: 'Replace all', danger: true },
      ],
    );
    if (!choice || choice === 'cancel') return;
    stylesMode = choice;
  }

  const { styles } = importHeaderSetup(payload, {
    itemsMode:   'skip',           // never touch headers from this tab
    stylesMode,                    // user-chosen
    defaultMode: 'skip',           // default belongs to the Header tab
  });
  if (styles) {
    const note = stylesMode === 'add' ? ' (added to existing)' : ' (replaced)';
    setStatus(`Loaded ${styles} style template(s)${note}.`);
  } else {
    setStatus('No styles loaded.', 'warning');
  }
  _activeId = null;
}
