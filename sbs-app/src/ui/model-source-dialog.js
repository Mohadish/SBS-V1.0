/**
 * SBS Step Browser — Model Source Transform panel
 * ===================================================
 * Edit → Model source transform… enters this mode. The left sidebar's
 * tabs hide and this panel takes over until the user clicks Close.
 * Steps panel stays live for navigation (the user clicks through the
 * timeline to verify the model edit lands consistently across every
 * step) — creation / reordering is gated off in steps-panel.js.
 *
 * Transform model:
 *   final_position = baseLocalPosition + step.snapshot.localOffset
 *   final_rotation = baseLocalQuaternion * step.snapshot.localQuaternion
 *   final_scale    = baseLocalScale (no per-step variation)
 *
 * Editing baseLocal* therefore shifts every step uniformly without
 * touching any step's snapshot. originalBaseLocal* is captured at
 * import (storeBaseTransformFromObject3D) and never overwritten —
 * Reset and Reset-all return to those values.
 *
 * Save commits to the SESSION (undoable, marks project dirty); Ctrl-S
 * persists to disk. Save As is offered as part of the unit-conversion
 * warning so the user can fork before a destructive scale change.
 */

import { state }       from '../core/state.js';
import * as actions    from '../systems/actions.js';
import {
  applyAllTransforms,
  ensureTransformDefaults,
  isTransformNode,
  quaternionToEulerDeg,
  eulerDegToQuaternion,
  normalizeQuaternion,
}                      from '../core/transforms.js';
import { steps }       from '../systems/steps.js';
import { setStatus }   from './status.js';
import { saveProject, getSuggestedFilename } from '../io/project.js';
import sceneCore       from '../core/scene.js';

// Module-level state — at most one instance live at a time. Cleared by
// unmountModelSourcePanel.
let _mountedEl     = null;
let _topLevelNodes = [];
let _beforeSnaps   = new Map();   // nodeId → {baseLocalPosition, baseLocalQuaternion, baseLocalScale}
let _currentNode   = null;
let _inputs        = null;
let _unifyScale    = true;
let _previewBox    = null;        // { red, green } THREE.LineSegments on overlayScene

// Unit conversion table — relative to METERS as the canonical unit.
// Conversion factor = "this many meters per unit". To convert from A → B:
// factor = UNITS[A] / UNITS[B] (so a value in A * factor = value in B).
const UNITS = Object.freeze({
  // Metric
  m:  { name: 'Meters',      factor: 1.0,    system: 'metric' },
  cm: { name: 'Centimeters', factor: 0.01,   system: 'metric' },
  mm: { name: 'Millimeters', factor: 0.001,  system: 'metric' },
  // Imperial
  ft: { name: 'Feet',        factor: 0.3048, system: 'imperial' },
  in: { name: 'Inches',      factor: 0.0254, system: 'imperial' },
  yd: { name: 'Yards',       factor: 0.9144, system: 'imperial' },
});

/**
 * Mount the panel. Called by sidebar-left when modelSourceMode flips on.
 */
export function mountModelSourcePanel(container) {
  if (_mountedEl) return;
  _mountedEl = container;

  const root = state.get('treeData');
  _topLevelNodes = (root?.children || []).filter(isTransformNode);

  if (_topLevelNodes.length === 0) {
    container.innerHTML = `
      <div class="card" style="padding:14px;">
        <div class="title">Model source transform</div>
        <div class="small muted" style="margin-top:6px;line-height:1.5;">
          No models loaded. Load a model first, then re-open Edit → Model
          source transform.
        </div>
        <button class="btn" id="ms-close" style="margin-top:10px;">Close</button>
      </div>
    `;
    container.querySelector('#ms-close').addEventListener('click', () => exitModelSourceMode());
    return;
  }

  // Snapshot every node's baseLocal* up front. Close-without-save reverts
  // to these.
  _beforeSnaps = new Map();
  for (const n of _topLevelNodes) {
    ensureTransformDefaults(n);
    _beforeSnaps.set(n.id, _snap(n));
  }
  _currentNode = _topLevelNodes[0];

  _renderPanel();
  _showPreviewBox();   // bbox preview always visible while editing
}

/**
 * Unmount + clean up. Called by sidebar-left when modelSourceMode flips off.
 * Restores any live-preview edits that weren't saved.
 */
export function unmountModelSourcePanel() {
  _hidePreviewBox();
  _mountedEl     = null;
  _topLevelNodes = [];
  _beforeSnaps   = new Map();
  _currentNode   = null;
  _inputs        = null;
}

/**
 * Public toggle from main.js (Edit menu wiring).
 */
export function openModelSourceDialog() {
  state.setState({ modelSourceMode: true });
}

export function exitModelSourceMode() {
  // Revert any uncommitted edits before exit. saveProject is the only
  // commit path — anything not saved through actions is rolled back.
  _revertAllUncommitted();
  state.setState({ modelSourceMode: false });
}

// ─── Panel render ─────────────────────────────────────────────────────────

function _renderPanel() {
  if (!_mountedEl) return;

  _mountedEl.innerHTML = `
    <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="title" style="flex:1;font-size:14px;">Model source transform</div>
        <button class="btn" id="ms-close" title="Close (revert any unsaved edits)">Close</button>
      </div>
      <div class="small muted" style="line-height:1.45;">
        Edits the imported model's base pose. Per-step animations stay
        intact — every step shifts uniformly. Click steps in the right
        panel to verify the change across the timeline.
      </div>

      <label class="colorlab" style="margin-top:4px;">Model
        <select id="ms-model" style="margin-top:4px;width:100%;"></select>
      </label>
    </div>

    <div class="card" id="ms-transforms" style="padding:12px;display:flex;flex-direction:column;gap:10px;">
      ${_axisGroupHTML('Position', 'pos')}
      ${_axisGroupHTML('Rotation (degrees)', 'rot')}
      ${_scaleGroupHTML()}
    </div>

    <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:8px;">
      <div class="small muted" style="font-weight:600;">Unit conversion (scale)</div>
      <div class="small muted" style="line-height:1.45;font-size:11px;">
        Pick a source and target unit; scale auto-fills. Accept prompts
        a confirmation since a large factor can take time.
      </div>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <label class="colorlab">From
          ${_unitSelectHTML('ms-unit-from')}
        </label>
        <label class="colorlab">To
          ${_unitSelectHTML('ms-unit-to')}
        </label>
      </div>
      <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <select id="ms-unit-filter" style="font-size:11px;">
          <option value="all">All units</option>
          <option value="metric">Metric only</option>
          <option value="imperial">Imperial only</option>
        </select>
        <button class="btn" id="ms-unit-apply">Convert ✓</button>
      </div>
      <div class="small muted" id="ms-unit-info" style="font-size:11px;"></div>
    </div>

    <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:6px;">
      <button class="btn" id="ms-reset-all" title="Revert this model's pose to import-time values">↻ Reset all to original</button>
      <button class="btn primary" id="ms-save">Save changes</button>
    </div>
  `;

  // Populate the model select.
  const sel = _mountedEl.querySelector('#ms-model');
  for (const n of _topLevelNodes) {
    const opt = document.createElement('option');
    opt.value = n.id;
    opt.textContent = n.name || '(unnamed)';
    sel.appendChild(opt);
  }
  sel.value = _currentNode.id;

  // Cache input refs.
  _inputs = {
    pos:    ['x','y','z'].map(a => _mountedEl.querySelector(`#ms-pos-${a}`)),
    rot:    ['x','y','z'].map(a => _mountedEl.querySelector(`#ms-rot-${a}`)),
    scl:    ['x','y','z'].map(a => _mountedEl.querySelector(`#ms-scl-${a}`)),
    unify:  _mountedEl.querySelector('#ms-scl-unify'),
  };

  _wireInputs();
  _wireUnitConversion();
  _wireResetAndSave(sel);
  _loadNodeIntoInputs();
}

// ─── HTML builders ────────────────────────────────────────────────────────

const AXIS_COLORS = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' };

function _axisGroupHTML(label, group) {
  return `
    <div>
      <div class="small muted" style="font-weight:600;margin-bottom:4px;">${label}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${['x','y','z'].map(a => `
          <div style="display:flex;align-items:center;gap:3px;">
            <span style="color:${AXIS_COLORS[a]};font-weight:700;font-size:11px;width:10px;">${a.toUpperCase()}</span>
            <input type="number" step="0.01" id="ms-${group}-${a}" style="flex:1;min-width:0;" />
            <button class="btn" data-reset="${group}-${a}" title="Reset ${a.toUpperCase()} to original" style="padding:1px 5px;font-size:10px;">↻</button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function _scaleGroupHTML() {
  return `
    <div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span class="small muted" style="font-weight:600;flex:1;">Scale</span>
        <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
          <input type="checkbox" id="ms-scl-unify" checked />
          <span class="small muted">Unify XYZ</span>
        </label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${['x','y','z'].map(a => `
          <div style="display:flex;align-items:center;gap:3px;">
            <span style="color:${AXIS_COLORS[a]};font-weight:700;font-size:11px;width:10px;">${a.toUpperCase()}</span>
            <input type="number" step="0.01" id="ms-scl-${a}" style="flex:1;min-width:0;" />
            <button class="btn" data-reset="scl-${a}" title="Reset ${a.toUpperCase()} scale to original" style="padding:1px 5px;font-size:10px;">↻</button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function _unitSelectHTML(id) {
  return `<select id="${id}" style="margin-top:4px;width:100%;">
    ${Object.entries(UNITS).map(([key, u]) =>
      `<option value="${key}" data-system="${u.system}">${u.name}</option>`
    ).join('')}
  </select>`;
}

// ─── Wiring ───────────────────────────────────────────────────────────────

function _wireInputs() {
  const sel = _mountedEl.querySelector('#ms-model');
  sel.addEventListener('change', () => {
    if (_isCurrentNodeDirty()) {
      const ok = window.confirm(
        `You have uncommitted changes on "${_currentNode.name}". ` +
        `Switching will discard them. Continue?`
      );
      if (!ok) {
        sel.value = _currentNode.id;   // revert dropdown
        return;
      }
      // Revert just this node before switching.
      _revertNode(_currentNode);
    }
    _currentNode = _topLevelNodes.find(n => n.id === sel.value) || _topLevelNodes[0];
    _loadNodeIntoInputs();
    _updatePreviewBox();
  });

  // Live-preview each input change.
  for (const list of [_inputs.pos, _inputs.rot, _inputs.scl]) {
    for (const inp of list) {
      inp.addEventListener('input', () => {
        _applyInputsToNode();
        _updatePreviewBox();
      });
    }
  }

  // Per-axis reset buttons.
  _mountedEl.querySelectorAll('[data-reset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [group, axis] = btn.dataset.reset.split('-');
      _resetAxis(group, axis);
    });
  });

  // Unify-scale checkbox: when ON, X→Y/Z mirroring on input. When toggled
  // OFF, warn (per spec).
  _inputs.unify.addEventListener('change', e => {
    if (!e.target.checked) {
      const ok = window.confirm(
        'Un-unifying scale lets X/Y/Z scale independently. ' +
        'Non-uniform scale can deform geometry and break some tools. Continue?'
      );
      if (!ok) {
        e.target.checked = true;
        return;
      }
    }
    _unifyScale = e.target.checked;
    _applyInputsToNode();
    _updatePreviewBox();
  });

  // X-scale drives Y/Z when unified.
  _inputs.scl[0].addEventListener('input', () => {
    if (!_unifyScale) return;
    _inputs.scl[1].value = _inputs.scl[0].value;
    _inputs.scl[2].value = _inputs.scl[0].value;
  });
}

function _wireUnitConversion() {
  const fromSel = _mountedEl.querySelector('#ms-unit-from');
  const toSel   = _mountedEl.querySelector('#ms-unit-to');
  const filter  = _mountedEl.querySelector('#ms-unit-filter');
  const info    = _mountedEl.querySelector('#ms-unit-info');
  const apply   = _mountedEl.querySelector('#ms-unit-apply');

  const updateFilter = () => {
    const f = filter.value;
    for (const sel of [fromSel, toSel]) {
      for (const opt of sel.options) {
        const sys = opt.dataset.system;
        opt.hidden = !(f === 'all' || sys === f);
      }
    }
  };
  filter.addEventListener('change', updateFilter);
  updateFilter();

  const updateInfo = () => {
    const factor = _conversionFactor(fromSel.value, toSel.value);
    info.textContent = factor === 1
      ? 'Source = target. No change.'
      : `1 ${fromSel.value} = ${factor} ${toSel.value} → multiply scale by ${factor}.`;
    _updatePreviewBox(factor);
  };
  fromSel.addEventListener('change', updateInfo);
  toSel.addEventListener('change',   updateInfo);
  updateInfo();

  apply.addEventListener('click', () => _onUnitConversionAccept(fromSel.value, toSel.value));
}

function _wireResetAndSave(sel) {
  _mountedEl.querySelector('#ms-close').addEventListener('click', () => exitModelSourceMode());

  _mountedEl.querySelector('#ms-reset-all').addEventListener('click', () => {
    if (!_currentNode) return;
    const ok = window.confirm(
      `Reset all of "${_currentNode.name}" to its original imported pose? ` +
      `(This will discard your unsaved edits to position / rotation / scale.)`
    );
    if (!ok) return;
    _currentNode.baseLocalPosition   = [...(_currentNode.originalBaseLocalPosition   || [0,0,0])];
    _currentNode.baseLocalQuaternion = [...(_currentNode.originalBaseLocalQuaternion || [0,0,0,1])];
    _currentNode.baseLocalScale      = [...(_currentNode.originalBaseLocalScale      || [1,1,1])];
    _applyToScene();
    _loadNodeIntoInputs();
    _updatePreviewBox();
  });

  _mountedEl.querySelector('#ms-save').addEventListener('click', () => {
    let changed = 0;
    for (const n of _topLevelNodes) {
      const before = _beforeSnaps.get(n.id);
      const after  = _snap(n);
      if (_snapEqual(before, after)) continue;
      actions.setModelSourceTransform(n.id, before, after);
      _beforeSnaps.set(n.id, after);   // re-baseline for further edits
      changed++;
    }
    if (changed) setStatus(`Model source saved (${changed} model${changed === 1 ? '' : 's'}). Ctrl-S to write to disk.`);
    else         setStatus('No changes to save.');
  });
}

// ─── Unit conversion helpers ──────────────────────────────────────────────

function _conversionFactor(fromKey, toKey) {
  const from = UNITS[fromKey], to = UNITS[toKey];
  if (!from || !to) return 1;
  // value_in_to = value_in_from * (m_per_from / m_per_to)
  return from.factor / to.factor;
}

function _onUnitConversionAccept(fromKey, toKey) {
  const factor = _conversionFactor(fromKey, toKey);
  if (factor === 1) {
    setStatus('Source = target — no conversion needed.');
    return;
  }

  // Three-button warning: Save As / Cancel / Accept. Save As does NOT
  // close the dialog so the user can still hit Accept after.
  _showUnitConversionWarning(fromKey, toKey, factor);
}

function _showUnitConversionWarning(fromKey, toKey, factor) {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed','inset:0','background:rgba(0,0,0,0.55)',
    'display:flex','align-items:center','justify-content:center','z-index:10000',
  ].join(';');

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = [
    'min-width:380px','max-width:480px','padding:18px',
    'background:var(--panel, #0f172a)','border:1px solid var(--line, #334155)',
    'border-radius:10px','display:flex','flex-direction:column','gap:10px',
  ].join(';');

  card.innerHTML = `
    <div class="title" style="font-size:14px;">Confirm unit conversion</div>
    <div class="small muted" style="line-height:1.5;">
      Converting <b>${UNITS[fromKey].name}</b> → <b>${UNITS[toKey].name}</b>
      multiplies the model's scale by <b>${factor}×</b>.
    </div>
    <div class="small" style="line-height:1.5;color:#fbbf24;">
      ⚠ Large conversions can take time and may stress the renderer on
      heavy models. Save first if the project is important.
    </div>
    <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <button class="btn" id="msw-saveas">Save As…</button>
      <button class="btn" id="msw-cancel">Cancel</button>
    </div>
    <button class="btn primary" id="msw-accept">Accept conversion</button>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  card.querySelector('#msw-cancel').addEventListener('click', () => overlay.remove());
  card.querySelector('#msw-saveas').addEventListener('click', async () => {
    try {
      await saveProject({ mode: 'saveAs', suggestedName: getSuggestedFilename() });
      setStatus('Project saved. Conversion ready when you are.');
    } catch (err) {
      setStatus(`Save As failed: ${err.message}`, 'danger');
    }
    // Stay open per spec.
  });
  card.querySelector('#msw-accept').addEventListener('click', () => {
    overlay.remove();
    _applyUnitConversion(factor);
  });
}

function _applyUnitConversion(factor) {
  if (!_currentNode || !Number.isFinite(factor) || factor <= 0) return;
  _currentNode.baseLocalScale = _currentNode.baseLocalScale.map(v => v * factor);
  _applyToScene();
  _loadNodeIntoInputs();
  _updatePreviewBox();
  setStatus(`Scale × ${factor} applied. Press Save changes to commit, or close to revert.`);
}

// ─── Preview bounding box (red current / green new) ──────────────────────

function _showPreviewBox() {
  if (_previewBox) return;
  if (!_currentNode || !window.THREE || !sceneCore?.overlayScene) return;

  const obj = steps.object3dById?.get(_currentNode.id);
  if (!obj) return;
  const box = new window.THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;

  const size   = new window.THREE.Vector3(); box.getSize(size);
  const centre = new window.THREE.Vector3(); box.getCenter(centre);

  const make = (color) => {
    const geo  = new window.THREE.BoxGeometry(size.x, size.y, size.z);
    const edge = new window.THREE.EdgesGeometry(geo);
    const mat  = new window.THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 });
    const line = new window.THREE.LineSegments(edge, mat);
    line.position.copy(centre);
    line.renderOrder = 999;
    return line;
  };

  _previewBox = {
    red:    make(0xef4444),
    green:  make(0x22c55e),
    centre: centre.clone(),
    size:   size.clone(),
  };
  _previewBox.green.scale.set(1, 1, 1);
  sceneCore.overlayScene.add(_previewBox.red);
  sceneCore.overlayScene.add(_previewBox.green);
}

function _hidePreviewBox() {
  if (!_previewBox || !sceneCore?.overlayScene) {
    _previewBox = null;
    return;
  }
  sceneCore.overlayScene.remove(_previewBox.red);
  sceneCore.overlayScene.remove(_previewBox.green);
  _previewBox.red.geometry.dispose();
  _previewBox.green.geometry.dispose();
  _previewBox.red.material.dispose();
  _previewBox.green.material.dispose();
  _previewBox = null;
}

function _updatePreviewBox(unitFactorOverride = null) {
  if (!_previewBox || !_currentNode) {
    _hidePreviewBox();
    _showPreviewBox();
    return;
  }
  // Red box anchored to the original-base size + currentNode's CURRENT
  // baseLocalScale gives the user a "what is, what will be" frame.
  // Green box previews the inputted scale (or the conversion factor if
  // the unit dropdown is being interacted with).
  const base = _currentNode.originalBaseLocalScale || [1,1,1];
  const cur  = _currentNode.baseLocalScale || [1,1,1];

  let preview = cur;
  if (Number.isFinite(unitFactorOverride) && unitFactorOverride > 0) {
    preview = cur.map(v => v * unitFactorOverride);
  }

  _previewBox.red.scale.set(
    cur[0] / base[0], cur[1] / base[1], cur[2] / base[2],
  );
  _previewBox.green.scale.set(
    preview[0] / base[0], preview[1] / base[1], preview[2] / base[2],
  );
}

// ─── Per-axis reset ───────────────────────────────────────────────────────

function _resetAxis(group, axis) {
  if (!_currentNode) return;
  const idx = { x: 0, y: 1, z: 2 }[axis];
  if (idx == null) return;

  if (group === 'pos') {
    _currentNode.baseLocalPosition[idx] = (_currentNode.originalBaseLocalPosition || [0,0,0])[idx] ?? 0;
  } else if (group === 'rot') {
    // Rotation axes are coupled (quaternion). Reset MEANS reset whole rot.
    // Per-axis reset on Euler-derived inputs would re-enter the "Euler
    // ambiguity" hell (gimbal-lock, sign flips). Document and reset all.
    _currentNode.baseLocalQuaternion = [...(_currentNode.originalBaseLocalQuaternion || [0,0,0,1])];
  } else if (group === 'scl') {
    if (_unifyScale) {
      _currentNode.baseLocalScale = [...(_currentNode.originalBaseLocalScale || [1,1,1])];
    } else {
      _currentNode.baseLocalScale[idx] = (_currentNode.originalBaseLocalScale || [1,1,1])[idx] ?? 1;
    }
  }
  _applyToScene();
  _loadNodeIntoInputs();
  _updatePreviewBox();
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────

function _snap(node) {
  return {
    baseLocalPosition:   [...(node.baseLocalPosition   || [0,0,0])],
    baseLocalQuaternion: [...(node.baseLocalQuaternion || [0,0,0,1])],
    baseLocalScale:      [...(node.baseLocalScale      || [1,1,1])],
  };
}

function _snapEqual(a, b) {
  if (!a || !b) return false;
  const eq = (x, y) => x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
  return eq(a.baseLocalPosition, b.baseLocalPosition)
      && eq(a.baseLocalQuaternion, b.baseLocalQuaternion)
      && eq(a.baseLocalScale, b.baseLocalScale);
}

function _isCurrentNodeDirty() {
  if (!_currentNode) return false;
  return !_snapEqual(_beforeSnaps.get(_currentNode.id), _snap(_currentNode));
}

function _revertNode(node) {
  const snap = _beforeSnaps.get(node.id);
  if (!snap) return;
  node.baseLocalPosition   = [...snap.baseLocalPosition];
  node.baseLocalQuaternion = [...snap.baseLocalQuaternion];
  node.baseLocalScale      = [...snap.baseLocalScale];
  _applyToScene();
}

function _revertAllUncommitted() {
  for (const n of _topLevelNodes) {
    if (!_snapEqual(_beforeSnaps.get(n.id), _snap(n))) _revertNode(n);
  }
}

// ─── Node ↔ inputs ────────────────────────────────────────────────────────

function _loadNodeIntoInputs() {
  if (!_currentNode || !_inputs) return;
  ensureTransformDefaults(_currentNode);
  const pos = _currentNode.baseLocalPosition;
  const eul = quaternionToEulerDeg(_currentNode.baseLocalQuaternion);
  const scl = _currentNode.baseLocalScale;
  ['x','y','z'].forEach((a, i) => {
    _inputs.pos[i].value = _fmt(pos[i]);
    _inputs.scl[i].value = _fmt(scl[i]);
  });
  _inputs.rot[0].value = _fmt(eul.x);
  _inputs.rot[1].value = _fmt(eul.y);
  _inputs.rot[2].value = _fmt(eul.z);
}

function _applyInputsToNode() {
  if (!_currentNode || !_inputs) return;
  const num = (el) => Number.isFinite(Number(el.value)) ? Number(el.value) : 0;
  _currentNode.baseLocalPosition   = _inputs.pos.map(num);
  _currentNode.baseLocalQuaternion = normalizeQuaternion(eulerDegToQuaternion({
    x: num(_inputs.rot[0]),
    y: num(_inputs.rot[1]),
    z: num(_inputs.rot[2]),
  }));
  if (_unifyScale) {
    const v = num(_inputs.scl[0]);
    const safe = Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v;
    _currentNode.baseLocalScale = [safe, safe, safe];
  } else {
    _currentNode.baseLocalScale = _inputs.scl.map(el => {
      const v = num(el);
      return Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v;
    });
  }
  _applyToScene();
}

function _applyToScene() {
  applyAllTransforms(state.get('treeData'), steps.object3dById);
  state.emit('change:treeData', state.get('treeData'));
}

function _fmt(v) {
  if (!Number.isFinite(v)) return '0';
  return Number(v.toFixed(3)).toString();
}
