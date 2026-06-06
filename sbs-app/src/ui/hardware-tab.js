/**
 * SBS — Hardware tab (V0.2.22.38).
 *
 * Template library + instance dropper. Mirrors the shape-tab pattern:
 *
 *   ─ Templates list ──────────────────────
 *   [name]            [+ Drop instance]
 *                     [Edit…]  [Delete]
 *
 *   ─ + Create new template ───────────────
 *   (form for diameter / length / head / drive)
 *
 * Editing a template updates every live instance immediately (geometry
 * rebuild propagates through hardware-templates.js). Deleting a template
 * offers to cascade-delete its instances or keep them as orphans.
 *
 * Each instance is an independent scene-tree node — duplicate, delete,
 * transform, color, animate like any imported model.
 */

import { state }       from '../core/state.js';
import {
  createTemplate,
  editTemplate,
  deleteTemplate,
  renameTemplate,
  restoreTemplateName,
}                       from '../systems/hardware-actions.js';
import { getEffectiveDefaults, setProjectDefault, clearProjectDefault } from '../systems/hardware-defaults.js';
import { setStatus }   from './status.js';
import { showConfirmDialog } from './context-menu.js';
import * as preview    from './hardware-preview.js';
import * as hardwarePlacePicker from '../systems/hardware-place-picker.js';

const HEAD_OPTIONS = [
  { value: 'socket',  label: 'Socket cap'             },
  { value: 'button',  label: 'Button (shallow dome)'  },
  { value: 'flat',    label: 'Flat / Countersunk'     },
  { value: 'lowhead', label: 'Low head'               },
  { value: 'hex',     label: 'Hex head'               },
  { value: 'flange',  label: 'Flange head'            },
  { value: 'none',    label: 'None (pin / grub)'      },
];

const DRIVE_OPTIONS = [
  { value: 'none',     label: 'None (smooth top)'   },
  { value: 'phillips', label: 'Phillips'            },
  { value: 'slotted',  label: 'Slotted'             },
  { value: 'hex',      label: 'Hex / Allen'         },
  { value: 'torx',     label: 'Torx'                },
];

// Form state for "+ Create new" persists between tab visits so the user
// can iterate on a spec before committing. Reset on creation.
let _formSpec = {
  diameter:   4,
  length:     20,
  headType:   'socket',
  driveStyle: 'phillips',
};

// Currently-editing template id (null when in "create" mode). When set,
// the form is bound to this template and "Save" updates it instead of
// creating a new one.
let _editingId = null;

// V0.2.22.61 — collapsable-section + expandable-row state (tab reorg).
let _defaultsOpen = false;            // insertion-anim defaults section
let _createOpen   = false;            // create / edit template section
const _expandedRows = new Set();      // template ids whose spec is expanded

let _panelEl = null;

function _chevron(open) { return open ? '▾' : '▸'; }

/** Live editor for this project's insertion-animation defaults. */
function _renderDefaultsEditor() {
  const d = getEffectiveDefaults();
  const sz = d.tagSize || 'medium';
  return `
    <div class="grid2" style="gap:8px;margin-top:8px;">
      <label class="small muted">Spacing X (mm)
        <input type="number" id="hd-x" value="${_esc(String(d.distance))}" min="1" step="1"
          style="width:100%;box-sizing:border-box;margin-top:2px;" />
      </label>
      <label class="small muted">Reposition (ms)
        <input type="number" id="hd-ms" value="${_esc(String(d.repositionMs))}" min="0" step="10"
          style="width:100%;box-sizing:border-box;margin-top:2px;" />
      </label>
    </div>
    <label style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;">
      <input type="checkbox" id="hd-tag" ${d.tagName ? 'checked' : ''}/>
      <span class="small">Name tag</span>
      <select id="hd-size" style="margin-left:6px;">
        <option value="small"  ${sz==='small' ?'selected':''}>Small</option>
        <option value="medium" ${sz==='medium'?'selected':''}>Medium</option>
        <option value="large"  ${sz==='large' ?'selected':''}>Large</option>
      </select>
      <input type="color" id="hd-tagcolor" value="${_esc(d.tagColor || '#ffffff')}" title="Tag text colour"
        style="width:32px;height:24px;margin-left:4px;padding:2px;border-radius:4px;cursor:pointer;" />
    </label>
    <label style="display:flex;align-items:center;gap:6px;margin-top:6px;margin-left:22px;cursor:pointer;">
      <input type="checkbox" id="hd-tagprev" ${d.tagPrev ? 'checked' : ''}/>
      <span class="small">Also show on the step before insertion</span>
    </label>
    <label style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;">
      <input type="checkbox" id="hd-traj" ${d.trajectory ? 'checked' : ''}/>
      <span class="small">Trajectory line</span>
    </label>
    <div class="grid3" style="gap:8px;margin-top:4px;margin-left:22px;">
      <label class="small muted">Thickness
        <input type="number" id="hd-thick" value="${_esc(String(d.lineThickness))}" min="0.05" step="0.05"
          style="width:100%;box-sizing:border-box;margin-top:2px;" />
      </label>
      <label class="small muted">Gap scale
        <input type="number" id="hd-gap" value="${_esc(String(d.lineGap))}" min="0" step="0.25"
          style="width:100%;box-sizing:border-box;margin-top:2px;" title="gap = thickness × this" />
      </label>
      <label class="small muted">Colour
        <input type="color" id="hd-color" value="${_esc(d.lineColor || '#ffaa00')}"
          style="width:44px;height:26px;margin-top:2px;padding:2px;border-radius:4px;cursor:pointer;" />
      </label>
    </div>
  `;
}

function _wireDefaultsEditor(panelEl) {
  const g = (id) => panelEl.querySelector(id);
  const push = () => setProjectDefault({
    distance:      Math.max(1, Number(g('#hd-x').value)     || 20),
    repositionMs:  Math.max(0, Number(g('#hd-ms').value)    || 300),
    tagName:       g('#hd-tag').checked,
    tagSize:       g('#hd-size').value,
    tagColor:      g('#hd-tagcolor').value,
    tagPrev:       g('#hd-tagprev').checked,
    trajectory:    g('#hd-traj').checked,
    lineThickness: Math.max(0.05, Number(g('#hd-thick').value) || 0.5),
    lineGap:       Math.max(0,    Number(g('#hd-gap').value)   || 2),
    lineColor:     g('#hd-color').value,
  });
  for (const id of ['#hd-x','#hd-ms','#hd-tag','#hd-size','#hd-tagcolor','#hd-tagprev','#hd-traj','#hd-thick','#hd-gap','#hd-color']) {
    g(id)?.addEventListener('change', push);
  }
  const st = g('#hw-file-default-state');
  const refresh = () => { if (st) st.textContent = state.get('hardwareDefaults') ? '(custom for this file)' : '(matching system)'; };
  refresh();
  g('#hw-file-default-clear')?.addEventListener('click', (e) => {
    e.preventDefault();
    clearProjectDefault();
    _render();   // re-render to show system values
    setStatus('Reset to system defaults.', 'info', 2000);
  });
}

export function renderHardwareTab(panelEl) {
  if (!panelEl) return;
  _panelEl = panelEl;
  _render();

  // Re-render when the template list changes from outside (undo / load).
  state.on('change:hardwareTemplates', _onTplListChange);
}

/**
 * Hand-off from outside (e.g. tree right-click → Edit template). Loads
 * the form with this template + flips into editing mode. Caller is
 * expected to have already switched the sidebar to the Hardware tab.
 */
export function startEditTemplate(templateId) {
  _editingId = templateId;
  _createOpen = true;   // editing reveals the form
  if (_panelEl) _render();
}

function _onTplListChange() {
  if (_panelEl) _render();
}

function _render() {
  const panelEl = _panelEl;
  if (!panelEl) return;

  const tpls = state.get('hardwareTemplates') || [];
  const editing = _editingId ? tpls.find(t => t.id === _editingId) : null;
  if (editing) _createOpen = true;   // editing always reveals the form
  // When editing, seed the form from that template (one-time per render).
  const formSpec = editing ? editing.params : _formSpec;

  panelEl.innerHTML = `
    <!-- 1) Insertion-animation defaults — collapsable, top of tab. -->
    <div class="card">
      <div class="title" id="hw-defaults-head"
           style="font-size:13px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;">
        <span style="width:12px;display:inline-block;">${_chevron(_defaultsOpen)}</span>
        Insertion-animation defaults
      </div>
      <div id="hw-defaults-body" style="display:${_defaultsOpen ? 'block' : 'none'};">
        <div class="small muted" style="margin-top:4px;font-size:11px;">
          Apply to every nut set to "use default". Editing any value here
          makes it this project's default, overriding the system default
          (Settings → Nuts) — without changing it.
        </div>
        ${_renderDefaultsEditor()}
        <div class="small muted" style="margin-top:6px;">
          <a href="#" id="hw-file-default-clear">↺ Reset to system defaults</a>
          <span id="hw-file-default-state" style="margin-left:8px;font-size:11px;"></span>
        </div>
      </div>
    </div>

    <!-- 2) Create / edit template — collapsable. -->
    <div class="card" style="margin-top:8px;">
      <div class="title" id="hw-create-head"
           style="font-size:13px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;">
        <span style="width:12px;display:inline-block;">${_chevron(_createOpen)}</span>
        ${editing
          ? `Editing: <span style="color:#fbbf24;">${_esc(editing.name)}</span>`
          : '+ Create new nut template'}
      </div>
      <div id="hw-create-body" style="display:${_createOpen ? 'block' : 'none'};">
        ${_createOpen ? _renderCreateForm(editing, formSpec) : ''}
      </div>
    </div>

    <!-- 3) Library — list, each row expandable to its spec. -->
    <div class="card" style="margin-top:8px;">
      <div class="title" style="font-size:13px;">Library</div>
      ${tpls.length === 0
        ? `<div class="small muted" style="margin-top:6px;font-style:italic;">No templates yet — create one above.</div>`
        : tpls.map(t => _renderLibRow(t)).join('')}
    </div>
  `;

  _wire(panelEl);
}

/** The create/edit form body (preview + fields + buttons). */
function _renderCreateForm(editing, formSpec) {
  return `
    <!-- Live preview canvas (hardware-preview.js — independent scene).
         Drag to orbit, wheel to zoom. -->
    <div style="margin-top:8px;display:flex;flex-direction:column;align-items:center;">
      <canvas id="hw-preview-canvas" width="220" height="160"
              style="width:220px;height:160px;background:#0a0f1a;border:1px solid var(--line);border-radius:6px;"></canvas>
      <div class="small muted" style="font-size:10px;margin-top:2px;opacity:0.6;">drag to orbit · wheel to zoom</div>
    </div>

    <div class="grid2" style="margin-top:8px;gap:6px;">
      <label class="small muted">Ø Diameter (mm)
        <input type="number" id="hw-d" min="1" max="30" step="0.5"
               value="${formSpec.diameter}"
               style="width:100%;margin-top:2px;padding:4px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);" />
      </label>
      <label class="small muted">Length (mm)
        <input type="number" id="hw-l" min="2" max="500" step="1"
               value="${formSpec.length}"
               style="width:100%;margin-top:2px;padding:4px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);" />
      </label>
    </div>

    <label class="small muted" style="display:block;margin-top:8px;">Head type
      <select id="hw-head" style="width:100%;margin-top:2px;">
        ${HEAD_OPTIONS.map(o => `
          <option value="${o.value}" ${o.value === formSpec.headType ? 'selected' : ''}>${o.label}</option>
        `).join('')}
      </select>
    </label>

    <label class="small muted" style="display:block;margin-top:8px;">Drive style
      <select id="hw-drive" style="width:100%;margin-top:2px;">
        ${DRIVE_OPTIONS.map(o => `
          <option value="${o.value}" ${o.value === formSpec.driveStyle ? 'selected' : ''}>${o.label}</option>
        `).join('')}
      </select>
    </label>

    <div class="grid2" style="margin-top:10px;gap:6px;">
      ${editing
        ? `
          <button class="btn" id="hw-save"   style="background:#fbbf24;color:#000;font-weight:600;">Save changes</button>
          <button class="btn" id="hw-cancel">Cancel</button>
        `
        : `<button class="btn" id="hw-create" style="font-weight:600;grid-column:1 / -1;">＋ Create template</button>`}
    </div>

    <div class="small muted" style="margin-top:6px;font-size:11px;opacity:0.75;">
      ${editing
        ? 'Edits propagate to every instance of this template.'
        : 'Hex heads ignore the drive selection (externally driven). Button heads skip the recess (drive style stays as data only).'}
    </div>
  `;
}

/** One library row: name + actions, "+ place on surface", expandable spec. */
function _renderLibRow(t) {
  const open = _expandedRows.has(t.id);
  const p = t.params || {};
  const headLabel  = (HEAD_OPTIONS.find(o => o.value === p.headType)   || {}).label || p.headType   || '—';
  const driveLabel = (DRIVE_OPTIONS.find(o => o.value === p.driveStyle) || {}).label || p.driveStyle || '—';
  return `
    <div class="card" style="margin-top:6px;padding:6px 8px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <button class="btn" data-hw-expand="${t.id}" title="Show spec" style="font-size:11px;padding:2px 5px;width:22px;">${_chevron(open)}</button>
        <input class="small" data-hw-rename="${t.id}" value="${_esc(t.name)}" title="Rename (Enter to save)"
               style="flex:1;min-width:0;background:transparent;border:1px solid transparent;color:var(--text);font-size:12px;padding:2px 4px;border-radius:4px;" />
        <button class="btn" data-hw-restore="${t.id}" title="Restore default name (from spec)" style="font-size:11px;padding:3px 6px;">↺</button>
        <button class="btn" data-hw-edit="${t.id}" title="Edit this template's parameters" style="font-size:11px;padding:3px 6px;">✎</button>
        <button class="btn" data-hw-del="${t.id}"  title="Delete this template" style="font-size:11px;padding:3px 6px;">🗑</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn" data-hw-place-surface="${t.id}"
                title="Click a surface to place; empty space drops it 50mm in front of the camera"
                style="font-size:11px;padding:4px 8px;flex:1;">+ place on surface</button>
        <button class="btn" data-hw-place-3pt="${t.id}"
                title="Snap 3 points around a circle to place the nut at its centre"
                style="font-size:11px;padding:4px 8px;flex:1;">+ place by 3 points</button>
      </div>
      ${open ? `
        <div class="small muted" style="margin-top:6px;font-size:11px;line-height:1.6;border-top:1px solid var(--line);padding-top:6px;">
          Ø ${_esc(String(p.diameter))} × ${_esc(String(p.length))} mm<br/>
          Head: ${_esc(headLabel)}<br/>
          Drive: ${_esc(driveLabel)}
        </div>` : ''}
    </div>`;
}

function _wire(panelEl) {
  // ── Collapsable section headers (V0.2.22.61) ───────────────────────
  panelEl.querySelector('#hw-defaults-head')?.addEventListener('click', () => {
    _defaultsOpen = !_defaultsOpen; _render();
  });
  panelEl.querySelector('#hw-create-head')?.addEventListener('click', () => {
    _createOpen = !_createOpen;
    if (!_createOpen && _editingId) _editingId = null;   // collapsing exits edit mode
    _render();
  });
  // Expandable library rows — toggle the spec view.
  for (const btn of panelEl.querySelectorAll('[data-hw-expand]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.hwExpand;
      if (_expandedRows.has(id)) _expandedRows.delete(id); else _expandedRows.add(id);
      _render();
    });
  }
  // "+ place on surface" / "+ place by 3 points" — arm the placement picker.
  for (const btn of panelEl.querySelectorAll('[data-hw-place-surface]')) {
    btn.addEventListener('click', () => {
      hardwarePlacePicker.startPlaceOnSurface(btn.dataset.hwPlaceSurface);
    });
  }
  for (const btn of panelEl.querySelectorAll('[data-hw-place-3pt]')) {
    btn.addEventListener('click', () => {
      hardwarePlacePicker.startPlaceBy3Points(btn.dataset.hwPlace3pt);
    });
  }

  // ── Project insertion-defaults editor (V0.2.22.59) ─────────────────
  _wireDefaultsEditor(panelEl);

  // Inline rename — commit on Enter or blur.
  for (const inp of panelEl.querySelectorAll('[data-hw-rename]')) {
    const commit = () => renameTemplate(inp.dataset.hwRename, inp.value);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); inp.blur(); }
      e.stopPropagation();
    });
    inp.addEventListener('blur', commit);
    inp.addEventListener('click', (e) => e.stopPropagation());
  }
  // Restore default (spec) name.
  for (const btn of panelEl.querySelectorAll('[data-hw-restore]')) {
    btn.addEventListener('click', () => { restoreTemplateName(btn.dataset.hwRestore); _render(); });
  }
  for (const btn of panelEl.querySelectorAll('[data-hw-edit]')) {
    btn.addEventListener('click', () => {
      _editingId  = btn.dataset.hwEdit;
      _createOpen = true;   // reveal the form
      _render();
    });
  }
  for (const btn of panelEl.querySelectorAll('[data-hw-del]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.hwDel;
      const tpls = state.get('hardwareTemplates') || [];
      const tpl  = tpls.find(t => t.id === id);
      if (!tpl) return;
      // Count live instances of this template to inform the prompt.
      const root = state.get('treeData');
      const count = _countInstancesOf(root, id);
      const title = `Delete template?`;
      const body = count > 0
        ? `"${tpl.name}" has ${count} instance${count > 1 ? 's' : ''} in the scene. Deleting will remove them too.`
        : `Remove "${tpl.name}" from the library.`;
      showConfirmDialog(title, body, () => {
        deleteTemplate(id, { deleteInstances: true });
        if (_editingId === id) _editingId = null;
        setStatus(`Deleted: ${tpl.name}.`, 'info', 2000);
      });
    });
  }

  // Form fields — bind change handlers that keep _formSpec in sync.
  const dInp     = panelEl.querySelector('#hw-d');
  const lInp     = panelEl.querySelector('#hw-l');
  const headSel  = panelEl.querySelector('#hw-head');
  const driveSel = panelEl.querySelector('#hw-drive');

  const _readForm = () => ({
    diameter:   Math.max(0.5, Number(dInp.value)  || 4),
    length:     Math.max(1,   Number(lInp.value)  || 20),
    headType:   String(headSel.value  || 'socket'),
    driveStyle: String(driveSel.value || 'none'),
  });

  // V0.2.22.39 — wire the live-preview canvas. Renders once now (so the
  // form opens already showing something) and on every form change.
  const previewCanvas = panelEl.querySelector('#hw-preview-canvas');
  if (previewCanvas) {
    preview.attach(previewCanvas);
    preview.update(_readForm());
  }

  const _trackForm = () => {
    if (!_editingId) _formSpec = _readForm();
    if (previewCanvas) preview.update(_readForm());
  };
  // 'input' fires on every keystroke / slider drag — instant feedback.
  // 'change' is the canonical "commit" event but lags one blur for typing.
  dInp?.addEventListener('input',      _trackForm);
  lInp?.addEventListener('input',      _trackForm);
  dInp?.addEventListener('change',     _trackForm);
  lInp?.addEventListener('change',     _trackForm);
  headSel?.addEventListener('change',  _trackForm);
  driveSel?.addEventListener('change', _trackForm);

  // Create / Save / Cancel buttons.
  const createBtn  = panelEl.querySelector('#hw-create');
  const saveBtn    = panelEl.querySelector('#hw-save');
  const cancelBtn  = panelEl.querySelector('#hw-cancel');

  createBtn?.addEventListener('click', () => {
    const params = _readForm();
    const tpl = createTemplate({ kind: 'screw', params });
    setStatus(`Created template: ${tpl.name}.`, 'success', 2000);
  });
  saveBtn?.addEventListener('click', () => {
    if (!_editingId) return;
    const params = _readForm();
    editTemplate(_editingId, { params });
    const tpls = state.get('hardwareTemplates') || [];
    const tpl  = tpls.find(t => t.id === _editingId);
    setStatus(`Updated: ${tpl?.name || 'template'} — all instances refreshed.`, 'success', 2000);
    _editingId = null;
    _render();
  });
  cancelBtn?.addEventListener('click', () => {
    _editingId = null;
    _render();
  });
}

function _countInstancesOf(root, templateId) {
  let n = 0;
  (function walk(node) {
    if (!node) return;
    if (node.type === 'hardwareInstance' && node.templateId === templateId) n++;
    for (const c of (node.children || [])) walk(c);
  })(root);
  return n;
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
