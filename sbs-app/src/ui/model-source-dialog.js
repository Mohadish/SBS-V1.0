/**
 * SBS Step Browser — Model Source Transform window
 * =====================================================
 * Edit → Model source transform… opens this. Floating, draggable,
 * lives in document.body. Independent of sidebar / steps panel.
 *
 * What this writes
 * ----------------
 * The "source transform" is BAKED into the model's geometry vertices —
 * equivalent to opening the model in another DCC, applying the
 * transform there, and reloading. The bake rides INSIDE the geometry,
 * so it cascades through every step regardless of where each mesh has
 * been moved in any given step.
 *
 *   • Per-step transforms are NEVER touched.
 *   • The pivot system is unaffected.
 *   • Inputs are ABSOLUTE source values, not deltas.
 *
 * Edit lifecycle
 * --------------
 *   1. Open dialog → capture _baseline = current source state.
 *   2. User types in Position / Rotation fields → live bake preview
 *      (no undo entry yet).
 *   3. User types in Scale fields or picks a unit conversion → live
 *      red/green bbox PREVIEW only; geometry is NOT baked yet.
 *   4. Click Apply:
 *        • If scale changed: combined "this may take time / save first"
 *          warning. Buttons: [Cancel] [Save As…] [Apply].
 *        • Bake commits, ONE undo entry pushed (_baseline → current).
 *        • Bbox preview cleared, _baseline updated.
 *   5. Click Reset (whole): confirm modal → set inputs to identity →
 *      live preview. Apply still required to commit.
 *   6. Per-axis ↺ buttons reset that single field.
 *   7. Close dialog or pick a different model → restore _baseline if
 *      anything was previewed but never committed (silent revert).
 */

import { state }    from '../core/state.js';
import { sceneCore } from '../core/scene.js';
import { steps }    from '../systems/steps.js';
import * as actions from '../systems/actions.js';
import {
  ensureTransformDefaults,
  quaternionToEulerDeg,
  eulerDegToQuaternion,
  normalizeQuaternion,
  collectModelMeshBoxes,
} from '../core/transforms.js';
import { saveProject } from '../io/project.js';
import { setStatus } from './status.js';

let _windowEl      = null;
let _currentNodeId = null;
let _baseline      = null;     // {pos, quat, scl}: state when dialog opened or last applied
let _bboxState     = null;     // {modelId, redGroup, greenGroup, visible}

const AXIS_COLORS = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' };

// ─── Unit conversion table ─────────────────────────────────────────────────
// Base = how many millimetres in one of this unit. Scale factor for a
// "from X to Y" conversion is from.base / to.base.

const UNIT_GROUPS = [
  { label: 'Metric',   units: [
    { id: 'mm', name: 'mm — millimetres', base: 1 },
    { id: 'cm', name: 'cm — centimetres', base: 10 },
    { id: 'm',  name: 'm — metres',       base: 1000 },
    { id: 'km', name: 'km — kilometres',  base: 1000000 },
  ]},
  { label: 'Imperial', units: [
    { id: 'in', name: 'in — inches',      base: 25.4 },
    { id: 'ft', name: 'ft — feet',        base: 304.8 },
    { id: 'yd', name: 'yd — yards',       base: 914.4 },
    { id: 'mi', name: 'mi — miles',       base: 1609344 },
  ]},
];

function _findUnit(id) {
  for (const g of UNIT_GROUPS) {
    const u = g.units.find(u => u.id === id);
    if (u) return u;
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function openModelSourceDialog() {
  if (_windowEl) {
    _windowEl.style.display = 'flex';
    _refreshModelList();
    _captureBaseline();
    _loadCurrentNodeIntoInputs();
    return;
  }
  _build();
}

export function closeModelSourceDialog() {
  if (!_windowEl) return;
  _revertToBaseline();           // silent revert of any uncommitted preview
  _hideBboxes();
  _disposeBboxes();
  _windowEl.remove();
  _windowEl = null;
  _currentNodeId = null;
  _baseline = null;
}

// ─── Build / Render ─────────────────────────────────────────────────────────

function _build() {
  _windowEl = document.createElement('div');
  _windowEl.id = 'model-source-window';
  _windowEl.style.cssText = [
    'position:fixed', 'top:80px', 'left:80px', 'width:380px',
    'background:var(--panel,#0f172a)',
    'border:1px solid var(--line,#334155)',
    'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.5)',
    'z-index:9999',
    'display:flex', 'flex-direction:column',
    'user-select:none',
  ].join(';');

  _windowEl.innerHTML = `
    <div id="ms-window-header" style="
      cursor:move;padding:10px 12px;display:flex;align-items:center;gap:8px;
      background:rgba(59,130,246,0.18);border-bottom:1px solid var(--line,#334155);
      border-top-left-radius:10px;border-top-right-radius:10px;
    ">
      <span style="flex:1;font-weight:600;font-size:13px;color:#dbeafe;">Model source transform</span>
      <button class="btn" id="ms-window-close" type="button" style="padding:2px 8px;font-size:12px;">✕</button>
    </div>

    <div style="padding:12px;display:flex;flex-direction:column;gap:10px;">
      <div class="small muted" style="line-height:1.45;font-size:11px;">
        Bakes a transform into the model's geometry — like re-importing a
        pre-edited model. Per-step transforms and the pivot are unaffected.
        Position / Rotation preview live; Scale previews via red/green bbox
        and is baked only on Apply.
      </div>

      <label class="colorlab">Model
        <select id="ms-model" style="margin-top:4px;width:100%;"></select>
      </label>

      ${_axisGroupHTML('Position', 'pos', '0', '0.01')}
      ${_axisGroupHTML('Rotation (Euler XYZ°)', 'rot', '0', '1')}
      ${_scaleGroupHTML()}

      <button class="btn primary" id="ms-apply" type="button" style="margin-top:6px;">Apply</button>
      <button class="btn" id="ms-reset" type="button" style="margin-top:0;">Reset all to identity</button>
      <div class="small muted" id="ms-status" style="font-size:11px;min-height:14px;"></div>
    </div>
  `;

  document.body.appendChild(_windowEl);

  _refreshModelList();
  _wireDrag();
  _wireModelPicker();
  _wireAxisInputs();
  _wireScaleControls();
  _wireApply();
  _wireReset();
  _wireFocusBboxToggle();

  _windowEl.querySelector('#ms-window-close').addEventListener('click', closeModelSourceDialog);
}

// ─── HTML builders ─────────────────────────────────────────────────────────

function _axisGroupHTML(label, group, defaultVal, step) {
  return `
    <div data-axis-group="${group}">
      <div class="small muted" style="font-weight:600;margin-bottom:4px;font-size:11px;">${label}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${['x','y','z'].map(a => `
          <div style="display:flex;align-items:center;gap:3px;">
            <span style="color:${AXIS_COLORS[a]};font-weight:700;font-size:11px;width:10px;">${a.toUpperCase()}</span>
            <input type="number" step="${step}" id="ms-${group}-${a}"
                   data-default="${defaultVal}"
                   value="${defaultVal}" style="flex:1;min-width:0;" />
            <button class="btn" type="button"
                    data-axis-reset="ms-${group}-${a}"
                    title="Reset ${a.toUpperCase()}"
                    style="padding:0 4px;font-size:10px;line-height:1;">↺</button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function _scaleGroupHTML() {
  // Build the unit dropdown options once.
  const optionsHTML = UNIT_GROUPS.map(g => `
    <optgroup label="${g.label}">
      ${g.units.map(u => `<option value="${u.id}">${u.name}</option>`).join('')}
    </optgroup>
  `).join('');

  return `
    <div data-axis-group="scl">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <div class="small muted" style="font-weight:600;font-size:11px;flex:1;">Scale</div>
        <label class="small" style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;">
          <input type="checkbox" id="ms-scl-uniform" />Uniform
        </label>
      </div>
      <div id="ms-scl-three" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${['x','y','z'].map(a => `
          <div style="display:flex;align-items:center;gap:3px;">
            <span style="color:${AXIS_COLORS[a]};font-weight:700;font-size:11px;width:10px;">${a.toUpperCase()}</span>
            <input type="number" step="0.01" id="ms-scl-${a}"
                   data-default="1"
                   value="1" style="flex:1;min-width:0;" />
            <button class="btn" type="button"
                    data-axis-reset="ms-scl-${a}"
                    title="Reset ${a.toUpperCase()} scale"
                    style="padding:0 4px;font-size:10px;line-height:1;">↺</button>
          </div>
        `).join('')}
      </div>
      <div id="ms-scl-uni" style="display:none;align-items:center;gap:3px;margin-top:0;">
        <span style="font-weight:700;font-size:11px;width:10px;">U</span>
        <input type="number" step="0.01" id="ms-scl-u"
               data-default="1"
               value="1" style="flex:1;min-width:0;" />
        <button class="btn" type="button"
                data-axis-reset="ms-scl-u"
                title="Reset uniform scale"
                style="padding:0 4px;font-size:10px;line-height:1;">↺</button>
      </div>

      <div style="display:flex;align-items:center;gap:6px;margin-top:6px;">
        <span class="small muted" style="font-size:11px;">Convert</span>
        <select id="ms-unit-from" style="flex:1;min-width:0;font-size:11px;">
          <option value="">From…</option>${optionsHTML}
        </select>
        <span class="small muted" style="font-size:11px;">→</span>
        <select id="ms-unit-to" style="flex:1;min-width:0;font-size:11px;">
          <option value="">To…</option>${optionsHTML}
        </select>
      </div>
      <div id="ms-bbox-info" class="small muted" style="font-size:10px;margin-top:4px;line-height:1.35;"></div>
    </div>
  `;
}

// ─── Model list ────────────────────────────────────────────────────────────

function _refreshModelList() {
  if (!_windowEl) return;
  const sel = _windowEl.querySelector('#ms-model');
  const models = ((state.get('treeData')?.children) || []).filter(n => n?.type === 'model');
  sel.innerHTML = '';
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no models loaded)';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const n of models) {
    const opt = document.createElement('option');
    opt.value = n.id;
    opt.textContent = n.name || '(unnamed)';
    sel.appendChild(opt);
  }
  if (_currentNodeId && models.some(n => n.id === _currentNodeId)) {
    sel.value = _currentNodeId;
  } else {
    _currentNodeId = sel.value;
  }
  _captureBaseline();
  _loadCurrentNodeIntoInputs();
}

function _wireModelPicker() {
  const sel = _windowEl.querySelector('#ms-model');
  sel.addEventListener('change', () => {
    _revertToBaseline();         // silent revert of any uncommitted preview on previous model
    _hideBboxes();
    _disposeBboxes();
    _currentNodeId = sel.value;
    _captureBaseline();
    _loadCurrentNodeIntoInputs();
  });
}

// ─── Drag (header) ─────────────────────────────────────────────────────────

function _wireDrag() {
  const header = _windowEl.querySelector('#ms-window-header');
  let dragOffsetX = 0, dragOffsetY = 0, dragging = false;
  header.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    dragging = true;
    const rect = _windowEl.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth  - 200, e.clientX - dragOffsetX));
    const y = Math.max(0, Math.min(window.innerHeight - 80,  e.clientY - dragOffsetY));
    _windowEl.style.left = `${x}px`;
    _windowEl.style.top  = `${y}px`;
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

function _num(el, fallback = 0) {
  return Number.isFinite(Number(el?.value)) ? Number(el.value) : fallback;
}
function _fmt(v) {
  if (!Number.isFinite(v)) return '0';
  return Number(v.toFixed(3)).toString();
}

function _captureBaseline() {
  if (!_currentNodeId) { _baseline = null; return; }
  const node = state.get('nodeById')?.get(_currentNodeId);
  if (!node) { _baseline = null; return; }
  ensureTransformDefaults(node);
  _baseline = {
    pos: [...(node.sourceLocalPosition   || [0,0,0])],
    quat:[...(node.sourceLocalQuaternion || [0,0,0,1])],
    scl: [...(node.sourceLocalScale      || [1,1,1])],
  };
}

function _loadCurrentNodeIntoInputs() {
  if (!_windowEl || !_currentNodeId) return;
  const node = state.get('nodeById')?.get(_currentNodeId);
  if (!node) return;
  ensureTransformDefaults(node);
  const pos = node.sourceLocalPosition   || [0, 0, 0];
  const eul = quaternionToEulerDeg(node.sourceLocalQuaternion);
  const scl = node.sourceLocalScale      || [1, 1, 1];
  const set = (id, v) => {
    const el = _windowEl.querySelector(id);
    if (el) el.value = _fmt(v);
  };
  set('#ms-pos-x', pos[0]); set('#ms-pos-y', pos[1]); set('#ms-pos-z', pos[2]);
  set('#ms-rot-x', eul.x);  set('#ms-rot-y', eul.y);  set('#ms-rot-z', eul.z);
  set('#ms-scl-x', scl[0]); set('#ms-scl-y', scl[1]); set('#ms-scl-z', scl[2]);
  // Uniform field shows X if all 3 are equal, else X for editing.
  set('#ms-scl-u', scl[0]);
  // Reset unit conversion dropdowns to placeholders on model change.
  const fromSel = _windowEl.querySelector('#ms-unit-from');
  const toSel   = _windowEl.querySelector('#ms-unit-to');
  if (fromSel) fromSel.value = '';
  if (toSel)   toSel.value   = '';
  _updateBboxInfo();
}

function _readPosRot() {
  const get = (id) => _windowEl.querySelector(id);
  const pos = [_num(get('#ms-pos-x')), _num(get('#ms-pos-y')), _num(get('#ms-pos-z'))];
  const eul = {
    x: _num(get('#ms-rot-x')),
    y: _num(get('#ms-rot-y')),
    z: _num(get('#ms-rot-z')),
  };
  const quat = normalizeQuaternion(eulerDegToQuaternion(eul));
  return { pos, quat };
}

function _readScale() {
  const get = (id) => _windowEl.querySelector(id);
  const isUniform = !!get('#ms-scl-uniform')?.checked;
  let s;
  if (isUniform) {
    const u = _num(get('#ms-scl-u'), 1);
    s = [u, u, u];
  } else {
    s = [_num(get('#ms-scl-x'), 1), _num(get('#ms-scl-y'), 1), _num(get('#ms-scl-z'), 1)];
  }
  return s.map(v => Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v);
}

function _scaleEqualsBaseline() {
  if (!_baseline) return true;
  const s = _readScale();
  const b = _baseline.scl;
  return Math.abs(s[0] - b[0]) < 1e-9 &&
         Math.abs(s[1] - b[1]) < 1e-9 &&
         Math.abs(s[2] - b[2]) < 1e-9;
}

// ─── Wiring: live preview on Position / Rotation, scale → bbox preview ────

function _wireAxisInputs() {
  // Position + Rotation: every change → live BAKE preview (no undo).
  for (const id of ['#ms-pos-x','#ms-pos-y','#ms-pos-z','#ms-rot-x','#ms-rot-y','#ms-rot-z']) {
    const el = _windowEl.querySelector(id);
    if (!el) continue;
    el.addEventListener('input', () => _previewLive());
  }
  // Per-axis ↺ buttons.
  _windowEl.querySelectorAll('[data-axis-reset]').forEach(btn => {
    btn.addEventListener('click', e => {
      const targetId = btn.getAttribute('data-axis-reset');
      const input = _windowEl.querySelector('#' + targetId);
      if (!input) return;
      input.value = input.getAttribute('data-default') || '0';
      // Treat as input event so live preview / bbox refresh fires.
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

function _wireScaleControls() {
  const uni = _windowEl.querySelector('#ms-scl-uniform');
  const three = _windowEl.querySelector('#ms-scl-three');
  const uniRow = _windowEl.querySelector('#ms-scl-uni');
  const fromSel = _windowEl.querySelector('#ms-unit-from');
  const toSel   = _windowEl.querySelector('#ms-unit-to');

  uni.addEventListener('change', () => {
    if (uni.checked) {
      three.style.display = 'none';
      uniRow.style.display = 'flex';
      // Carry the X value into U as a sensible starting point.
      const x = _num(_windowEl.querySelector('#ms-scl-x'), 1);
      _windowEl.querySelector('#ms-scl-u').value = _fmt(x);
    } else {
      three.style.display = 'grid';
      uniRow.style.display = 'none';
    }
    _onScaleInput();
  });

  // Scale fields → bbox preview only (no live bake).
  for (const id of ['#ms-scl-x','#ms-scl-y','#ms-scl-z','#ms-scl-u']) {
    const el = _windowEl.querySelector(id);
    if (!el) continue;
    el.addEventListener('input', () => _onScaleInput());
    el.addEventListener('focus', () => _onScaleInteraction());
  }

  // Unit conversion: any change recomputes the scale fields.
  const recomputeFactor = () => {
    const from = _findUnit(fromSel.value);
    const to   = _findUnit(toSel.value);
    if (!from || !to) return;
    const factor = from.base / to.base;
    if (uni.checked) {
      _windowEl.querySelector('#ms-scl-u').value = _fmt(factor);
    } else {
      _windowEl.querySelector('#ms-scl-x').value = _fmt(factor);
      _windowEl.querySelector('#ms-scl-y').value = _fmt(factor);
      _windowEl.querySelector('#ms-scl-z').value = _fmt(factor);
    }
    _onScaleInput();
  };
  fromSel.addEventListener('change', () => { _onScaleInteraction(); recomputeFactor(); });
  toSel.addEventListener  ('change', () => { _onScaleInteraction(); recomputeFactor(); });
  fromSel.addEventListener('focus',  () => _onScaleInteraction());
  toSel  .addEventListener('focus',  () => _onScaleInteraction());
}

function _wireFocusBboxToggle() {
  // Focusing Pos / Rot or anything else hides the bbox preview.
  for (const id of ['#ms-pos-x','#ms-pos-y','#ms-pos-z','#ms-rot-x','#ms-rot-y','#ms-rot-z']) {
    const el = _windowEl.querySelector(id);
    if (!el) continue;
    el.addEventListener('focus', () => _hideBboxes());
  }
}

// ─── Live preview / bbox preview ──────────────────────────────────────────

function _previewLive() {
  if (!_currentNodeId) return;
  // Bake current pos+rot, but keep CURRENT BAKED SCALE (committed _baseline.scl).
  // Scale changes don't bake until Apply — use baseline scale here.
  const { pos, quat } = _readPosRot();
  const scl = _baseline ? _baseline.scl : _readScale();
  actions.previewModelSourceTransform(_currentNodeId, pos, quat, scl);
}

function _onScaleInteraction() {
  // Called whenever the user touches a scale-related control (input,
  // focus, dropdown). Refreshes the red/green bbox preview from the
  // CURRENT baked geometry (red) and the input scale (green).
  if (!_currentNodeId) return;
  _showBboxes();
  _updateBboxInfo();
}

function _onScaleInput() {
  // Scale field value changed: green box updates only.
  if (!_currentNodeId) return;
  if (_scaleEqualsBaseline()) {
    // Back to baseline — no preview needed.
    _hideBboxes();
    _updateBboxInfo();
    return;
  }
  _showBboxes();
  _updateGreenBoxes();
  _updateBboxInfo();
}

// ─── Bbox visualisation ────────────────────────────────────────────────────

function _ensureBboxState() {
  if (!window.THREE || !sceneCore?.scene) return null;
  if (_bboxState && _bboxState.modelId === _currentNodeId) return _bboxState;
  _disposeBboxes();
  _bboxState = {
    modelId: _currentNodeId,
    redGroup:   new window.THREE.Group(),
    greenGroup: new window.THREE.Group(),
    visible:    false,
  };
  _bboxState.redGroup.name   = 'sbs:source-bbox-red';
  _bboxState.greenGroup.name = 'sbs:source-bbox-green';
  // Parent to the model's outer group so the boxes inherit any per-step
  // transforms automatically (model frame).
  const outer = steps.object3dById?.get(_currentNodeId);
  const parent = outer ?? sceneCore.scene;
  parent.add(_bboxState.redGroup);
  parent.add(_bboxState.greenGroup);
  return _bboxState;
}

function _buildBoxLines(min, max, colorHex) {
  const T = window.THREE;
  const w = Math.max(max[0] - min[0], 1e-6);
  const h = Math.max(max[1] - min[1], 1e-6);
  const d = Math.max(max[2] - min[2], 1e-6);
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const edges = new T.EdgesGeometry(new T.BoxGeometry(w, h, d));
  const mat = new T.LineBasicMaterial({
    color: colorHex,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
    linewidth: 1,
  });
  const lines = new T.LineSegments(edges, mat);
  lines.position.set(cx, cy, cz);
  lines.renderOrder = 999;       // always-on-top
  return lines;
}

function _rebuildRedBoxes() {
  if (!_currentNodeId) return;
  const node = state.get('nodeById')?.get(_currentNodeId);
  if (!node) return;
  const st = _ensureBboxState();
  if (!st) return;
  // Wipe + rebuild.
  while (st.redGroup.children.length) {
    const c = st.redGroup.children.pop();
    c.geometry?.dispose?.();
    c.material?.dispose?.();
  }
  const boxes = collectModelMeshBoxes(node, steps.object3dById);
  for (const b of boxes) {
    st.redGroup.add(_buildBoxLines(b.min, b.max, 0xff3344));
  }
}

function _updateGreenBoxes() {
  if (!_currentNodeId) return;
  const node = state.get('nodeById')?.get(_currentNodeId);
  if (!node) return;
  const st = _ensureBboxState();
  if (!st) return;
  // Wipe + rebuild green boxes from RED extents scaled by the current
  // scale-input values (delta from baseline scale).
  while (st.greenGroup.children.length) {
    const c = st.greenGroup.children.pop();
    c.geometry?.dispose?.();
    c.material?.dispose?.();
  }
  const inputScl = _readScale();
  const baseScl  = _baseline ? _baseline.scl : [1, 1, 1];
  // Delta scale = input / baseline. Applied to red bbox extents.
  const dx = baseScl[0] !== 0 ? inputScl[0] / baseScl[0] : 1;
  const dy = baseScl[1] !== 0 ? inputScl[1] / baseScl[1] : 1;
  const dz = baseScl[2] !== 0 ? inputScl[2] / baseScl[2] : 1;
  const boxes = collectModelMeshBoxes(node, steps.object3dById);
  for (const b of boxes) {
    const min = [b.min[0] * dx, b.min[1] * dy, b.min[2] * dz];
    const max = [b.max[0] * dx, b.max[1] * dy, b.max[2] * dz];
    st.greenGroup.add(_buildBoxLines(min, max, 0x22ee44));
  }
}

function _showBboxes() {
  const st = _ensureBboxState();
  if (!st) return;
  if (!st.visible) {
    _rebuildRedBoxes();
    st.visible = true;
  }
  _updateGreenBoxes();
  st.redGroup.visible   = true;
  st.greenGroup.visible = true;
}

function _hideBboxes() {
  if (!_bboxState) return;
  _bboxState.redGroup.visible   = false;
  _bboxState.greenGroup.visible = false;
  _bboxState.visible            = false;
}

function _disposeBboxes() {
  if (!_bboxState) return;
  for (const grp of [_bboxState.redGroup, _bboxState.greenGroup]) {
    while (grp.children.length) {
      const c = grp.children.pop();
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    }
    grp.parent?.remove(grp);
  }
  _bboxState = null;
}

function _updateBboxInfo() {
  if (!_windowEl) return;
  const el = _windowEl.querySelector('#ms-bbox-info');
  if (!el) return;
  if (!_currentNodeId) { el.textContent = ''; return; }
  const node = state.get('nodeById')?.get(_currentNodeId);
  if (!node) { el.textContent = ''; return; }
  const boxes = collectModelMeshBoxes(node, steps.object3dById);
  if (boxes.length === 0) { el.textContent = ''; return; }
  // Aggregate model-frame extents.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of boxes) {
    if (b.min[0] < minX) minX = b.min[0]; if (b.max[0] > maxX) maxX = b.max[0];
    if (b.min[1] < minY) minY = b.min[1]; if (b.max[1] > maxY) maxY = b.max[1];
    if (b.min[2] < minZ) minZ = b.min[2]; if (b.max[2] > maxZ) maxZ = b.max[2];
  }
  const w = maxX - minX, h = maxY - minY, d = maxZ - minZ;
  const baseScl = _baseline ? _baseline.scl : [1, 1, 1];
  const inputScl = _readScale();
  const dx = baseScl[0] !== 0 ? inputScl[0] / baseScl[0] : 1;
  const dy = baseScl[1] !== 0 ? inputScl[1] / baseScl[1] : 1;
  const dz = baseScl[2] !== 0 ? inputScl[2] / baseScl[2] : 1;
  const meshes = boxes.length;
  const fmt = v => Number.isFinite(v) ? v.toFixed(2) : '–';
  el.innerHTML = `
    <span style="color:#ff8089">● now</span>
    ${fmt(w)} × ${fmt(h)} × ${fmt(d)} (${meshes} mesh${meshes === 1 ? '' : 'es'})
    <br><span style="color:#5fe680">● apply</span>
    ${fmt(w * dx)} × ${fmt(h * dy)} × ${fmt(d * dz)}
  `;
}

// ─── Apply / Reset ─────────────────────────────────────────────────────────

function _wireApply() {
  _windowEl.querySelector('#ms-apply').addEventListener('click', () => _onApply());
}

function _wireReset() {
  _windowEl.querySelector('#ms-reset').addEventListener('click', () => {
    _confirmModal({
      title: 'Reset all to identity?',
      body:  'Set position, rotation and scale inputs back to identity. ' +
             'You still need to click Apply to commit the change.',
      buttons: [
        { label: 'Cancel',           kind: 'btn'         },
        { label: 'Reset',            kind: 'btn primary', value: 'ok' },
      ],
    }).then(result => {
      if (result !== 'ok') return;
      _setInputsToIdentity();
      _previewLive();
      _onScaleInput();
      _setStatus('Inputs reset to identity (not applied yet).');
    });
  });
}

function _setInputsToIdentity() {
  const set = (id, v) => {
    const el = _windowEl.querySelector(id);
    if (el) el.value = v;
  };
  set('#ms-pos-x', '0'); set('#ms-pos-y', '0'); set('#ms-pos-z', '0');
  set('#ms-rot-x', '0'); set('#ms-rot-y', '0'); set('#ms-rot-z', '0');
  set('#ms-scl-x', '1'); set('#ms-scl-y', '1'); set('#ms-scl-z', '1');
  set('#ms-scl-u', '1');
  const fromSel = _windowEl.querySelector('#ms-unit-from');
  const toSel   = _windowEl.querySelector('#ms-unit-to');
  if (fromSel) fromSel.value = '';
  if (toSel)   toSel.value   = '';
}

async function _onApply() {
  if (!_currentNodeId) {
    _setStatus('No model selected.');
    return;
  }
  const { pos, quat } = _readPosRot();
  const scl = _readScale();
  const scaleChanged = !_scaleEqualsBaseline();

  if (scaleChanged) {
    // Combined "may take time / save first" gate.
    let resolved = false;
    while (!resolved) {
      const choice = await _confirmModal({
        title: 'Apply scale conversion?',
        body:
          'Scale conversion bakes new vertex positions into every mesh of ' +
          'this model. On large models this can take time and may even ' +
          'crash on extremely heavy files.<br><br>' +
          'Save your project as a new file before proceeding so the ' +
          'original is preserved.',
        buttons: [
          { label: 'Cancel',     kind: 'btn'         },
          { label: 'Save As…',   kind: 'btn',         value: 'saveas' },
          { label: 'Apply',      kind: 'btn primary', value: 'apply'  },
        ],
      });
      if (choice !== 'saveas') {
        if (choice !== 'apply') {
          // Cancel — silently revert any pending scale preview.
          _hideBboxes();
          return;
        }
        resolved = true;
      } else {
        try {
          const result = await saveProject({ mode: 'saveAs' });
          if (result?.saved) setStatus(`Saved: ${state.get('projectName')}.`);
          // Loop back to the warning so the user explicitly confirms Apply.
        } catch (err) {
          console.error('Save As failed:', err);
          setStatus('Save As failed.', 'danger');
        }
      }
    }
  }

  // Commit: push ONE undo entry covering baseline → current.
  actions.setModelSourceTransform(_currentNodeId, pos, quat, scl);
  _captureBaseline();              // new baseline for any subsequent edits
  _hideBboxes();
  if (_bboxState) _rebuildRedBoxes();   // refresh stored red boxes for next session
  _setStatus('Source transform applied.');
  setStatus('Model source transform applied.');
}

function _revertToBaseline() {
  // Silent revert (no undo entry). Restores node fields to the captured
  // _baseline and re-bakes geometry. Called on close / model change /
  // cancel of any pending preview.
  if (!_currentNodeId || !_baseline) return;
  actions.previewModelSourceTransform(
    _currentNodeId,
    _baseline.pos,
    _baseline.quat,
    _baseline.scl,
  );
}

function _setStatus(msg) {
  if (!_windowEl) return;
  const el = _windowEl.querySelector('#ms-status');
  if (el) el.textContent = msg;
}

// ─── Inline confirm modal ─────────────────────────────────────────────────
//
// Promise-based modal that lives inside the dialog's window so it stays
// out of Electron's main window-focus lane. Resolves to the `value` of the
// clicked button, or undefined for the dismiss button.

function _confirmModal({ title, body, buttons }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed','inset:0','z-index:10000',
      'display:flex','align-items:center','justify-content:center',
      'background:rgba(0,0,0,0.55)',
    ].join(';');

    overlay.innerHTML = `
      <div style="
        background:var(--panel,#0f172a);
        border:1px solid var(--line,#334155);
        border-radius:10px;
        max-width:420px;width:90%;
        padding:16px;
        box-shadow:0 20px 50px rgba(0,0,0,0.6);
        font-size:13px;color:#e2e8f0;
      ">
        <div style="font-weight:600;font-size:14px;margin-bottom:10px;">${title}</div>
        <div class="small" style="line-height:1.5;font-size:12px;color:#cbd5e1;">${body}</div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
          ${buttons.map((b, i) => `
            <button class="${b.kind || 'btn'}" data-i="${i}" type="button"
                    style="padding:6px 12px;font-size:12px;">${b.label}</button>
          `).join('')}
        </div>
      </div>
    `;

    const finish = (val) => {
      overlay.remove();
      resolve(val);
    };

    overlay.querySelectorAll('button[data-i]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-i'));
        finish(buttons[i]?.value);
      });
    });

    document.body.appendChild(overlay);
  });
}
