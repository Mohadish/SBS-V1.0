/**
 * SBS Step Browser — Model Source Transform panel
 * ===================================================
 * Edit → Model source transform… enters this mode. The left sidebar's
 * tabs hide and this panel takes over until the user clicks Close.
 *
 * What "source transform" actually does
 * -------------------------------------
 * Every model node's outer THREE.Group contains a child INNER group
 * (the "source-transform group", marked via userData.sbsSourceGroup).
 * The model's actual mesh content lives inside the inner group. The
 * inner group's local transform is the source transform.
 *
 *     outer group   ← per-step transforms + pivot live here
 *       └─ inner group   ← source transform lives here (our edits)
 *            └─ meshes + sub-folders   ← model geometry
 *
 * Editing source* therefore re-orients the model's geometry RELATIVE
 * to the pivot frame, not the world. The pivot's world position +
 * orientation are untouched no matter how we rotate / translate the
 * source. Cascades through every step automatically because the
 * inner group is part of the model node's hierarchy — every step
 * that uses the model picks up the same source transform.
 *
 * Steps panel stays interactive for navigation while in this mode so
 * the user can scrub through the timeline and verify the source edit
 * lands consistently — that's the verification loop the feature is
 * really for.
 */

import { state }       from '../core/state.js';
import * as actions    from '../systems/actions.js';
import {
  ensureTransformDefaults,
  applyNodeSourceTransformToObject3D,
  quaternionToEulerDeg,
  eulerDegToQuaternion,
  normalizeQuaternion,
}                      from '../core/transforms.js';
import { steps }       from '../systems/steps.js';
import { setStatus }   from './status.js';
import { saveProject, getSuggestedFilename } from '../io/project.js';

// Module-level state — at most one instance live at a time.
let _mountedEl     = null;
let _models        = [];          // top-level model nodes
let _beforeSnaps   = new Map();   // nodeId → source* snapshot at panel-open
let _currentNode   = null;
let _inputs        = null;
let _unifyScale    = true;

// Unit conversion table — meters as canonical. To convert from A → B:
// factor = UNITS[A] / UNITS[B] (so value_in_B = value_in_A × factor).
const UNITS = Object.freeze({
  m:  { name: 'Meters',      factor: 1.0,    system: 'metric' },
  cm: { name: 'Centimeters', factor: 0.01,   system: 'metric' },
  mm: { name: 'Millimeters', factor: 0.001,  system: 'metric' },
  ft: { name: 'Feet',        factor: 0.3048, system: 'imperial' },
  in: { name: 'Inches',      factor: 0.0254, system: 'imperial' },
  yd: { name: 'Yards',       factor: 0.9144, system: 'imperial' },
});

const AXIS_COLORS = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' };

// ─── Public API ─────────────────────────────────────────────────────────────

export function openModelSourceDialog() { state.setState({ modelSourceMode: true }); }

export function exitModelSourceMode(force = false) {
  if (!force && _hasUncommittedChanges()) {
    const ok = window.confirm(
      'You have unsaved model-source edits. Closing will discard them. Continue?'
    );
    if (!ok) return false;
  }
  _revertAllUncommitted();
  state.setState({ modelSourceMode: false });
  return true;
}

export function mountModelSourcePanel(container) {
  // Re-snapshot every time the panel is opened — the user may have
  // committed source edits in a previous session and we want the new
  // session's _beforeSnaps to match the current state, not stale data
  // from last time.
  _mountedEl     = container;
  _models        = [];
  _beforeSnaps   = new Map();
  _currentNode   = null;
  _inputs        = null;

  const root = state.get('treeData');
  _models = (root?.children || []).filter(n => n?.type === 'model');

  if (_models.length === 0) {
    container.innerHTML = `
      <div class="card" style="padding:14px;">
        <div class="title">Model source transform</div>
        <div class="small muted" style="margin-top:6px;line-height:1.5;">
          No models loaded. Load a model first, then re-open Edit →
          Model source transform.
        </div>
        <button class="btn" id="ms-close" style="margin-top:10px;">Close</button>
      </div>
    `;
    container.querySelector('#ms-close').addEventListener('click', () => exitModelSourceMode(true));
    return;
  }

  _beforeSnaps = new Map();
  for (const n of _models) {
    ensureTransformDefaults(n);
    _beforeSnaps.set(n.id, _snap(n));
  }
  _currentNode = _models[0];
  _renderPanel();
}

export function unmountModelSourcePanel() {
  _mountedEl     = null;
  _models        = [];
  _beforeSnaps   = new Map();
  _currentNode   = null;
  _inputs        = null;
}

// ─── Panel render ───────────────────────────────────────────────────────────

function _renderPanel() {
  if (!_mountedEl) return;

  _mountedEl.innerHTML = `
    <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="title" style="flex:1;font-size:14px;">Model source transform</div>
        <button class="btn" id="ms-close" title="Close (revert any unsaved edits)">Close</button>
      </div>
      <div class="small muted" style="line-height:1.45;">
        Edits the model's geometry inside its pivot frame. Pivot stays
        put. Per-step animations stay intact — every step that uses
        this model picks up the same source transform. Click steps in
        the right panel to verify the change.
      </div>

      <label class="colorlab" style="margin-top:4px;">Model
        <select id="ms-model" style="margin-top:4px;width:100%;"></select>
      </label>
    </div>

    <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:10px;">
      ${_axisGroupHTML('Position', 'pos')}
      ${_axisGroupHTML('Rotation (degrees)', 'rot')}
      ${_scaleGroupHTML()}
    </div>

    <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:8px;">
      <div class="small muted" style="font-weight:600;">Unit conversion (scale)</div>
      <div class="small muted" style="line-height:1.45;font-size:11px;">
        Pick a source and target unit; scale auto-fills. Convert
        prompts a confirmation since a large factor can take time.
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
        <button class="btn" id="ms-unit-apply" type="button">Convert ✓</button>
      </div>
      <div class="small muted" id="ms-unit-info" style="font-size:11px;"></div>
    </div>

    <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:6px;">
      <button class="btn" id="ms-reset-all" type="button">↻ Reset all to original</button>
      <button class="btn primary" id="ms-save" type="button">Save changes</button>
    </div>
  `;

  // Populate model select.
  const sel = _mountedEl.querySelector('#ms-model');
  for (const n of _models) {
    const opt = document.createElement('option');
    opt.value = n.id;
    opt.textContent = n.name || '(unnamed)';
    sel.appendChild(opt);
  }
  sel.value = _currentNode.id;

  _inputs = {
    pos:    ['x','y','z'].map(a => _mountedEl.querySelector(`#ms-pos-${a}`)),
    rot:    ['x','y','z'].map(a => _mountedEl.querySelector(`#ms-rot-${a}`)),
    scl:    ['x','y','z'].map(a => _mountedEl.querySelector(`#ms-scl-${a}`)),
    unify:  _mountedEl.querySelector('#ms-scl-unify'),
  };

  _wireModelPicker(sel);
  _wirePositionInputs();
  _wireRotationInputs();
  _wireScaleInputs();
  _wireUnitConversion();
  _wireBottomButtons();
  _loadNodeIntoInputs();
}

// ─── HTML builders ──────────────────────────────────────────────────────────

function _axisGroupHTML(label, group) {
  return `
    <div>
      <div class="small muted" style="font-weight:600;margin-bottom:4px;">${label}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${['x','y','z'].map(a => `
          <div style="display:flex;align-items:center;gap:3px;">
            <span style="color:${AXIS_COLORS[a]};font-weight:700;font-size:11px;width:10px;">${a.toUpperCase()}</span>
            <input type="number" step="0.01" id="ms-${group}-${a}" style="flex:1;min-width:0;" />
            <button class="btn" type="button" data-reset="${group}-${a}" title="Reset ${a.toUpperCase()} to original" style="padding:1px 5px;font-size:10px;">↻</button>
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
            <button class="btn" type="button" data-reset="scl-${a}" title="Reset ${a.toUpperCase()} scale to original" style="padding:1px 5px;font-size:10px;">↻</button>
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

// ─── Wiring (per-group, no cross-field interference) ────────────────────────

function _wireModelPicker(sel) {
  sel.addEventListener('change', () => {
    if (_isCurrentNodeDirty()) {
      const ok = window.confirm(
        `Uncommitted edits on "${_currentNode.name}". Switch will discard them. Continue?`
      );
      if (!ok) { sel.value = _currentNode.id; return; }
      _revertNode(_currentNode);
    }
    _currentNode = _models.find(n => n.id === sel.value) || _models[0];
    _loadNodeIntoInputs();
  });
}

function _wirePositionInputs() {
  for (const inp of _inputs.pos) {
    inp.addEventListener('change', () => {
      _writePosition();
      _applySourceToScene();
    });
  }
  _wireResetButton('pos');
}

function _wireRotationInputs() {
  for (const inp of _inputs.rot) {
    inp.addEventListener('change', () => {
      _writeRotation();
      _applySourceToScene();
    });
  }
  _wireResetButton('rot');
}

function _wireScaleInputs() {
  // X-scale mirrors to Y/Z when unified — fires `change` so the apply
  // listener still picks up the values.
  _inputs.scl[0].addEventListener('change', () => {
    if (_unifyScale) {
      _inputs.scl[1].value = _inputs.scl[0].value;
      _inputs.scl[2].value = _inputs.scl[0].value;
    }
    _writeScale();
    _applySourceToScene();
  });
  for (let i = 1; i < 3; i++) {
    _inputs.scl[i].addEventListener('change', () => {
      _writeScale();
      _applySourceToScene();
    });
  }
  _inputs.unify.addEventListener('change', e => {
    if (!e.target.checked) {
      const ok = window.confirm(
        'Un-unifying scale lets X/Y/Z scale independently. Non-uniform ' +
        'scale can deform geometry and break some tools. Continue?'
      );
      if (!ok) { e.target.checked = true; return; }
    }
    _unifyScale = e.target.checked;
  });
  _wireResetButton('scl');
}

function _wireResetButton(group) {
  _mountedEl.querySelectorAll(`[data-reset^="${group}-"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const [, axis] = btn.dataset.reset.split('-');
      _resetAxis(group, axis);
    });
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
        opt.hidden = !(f === 'all' || opt.dataset.system === f);
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
  };
  fromSel.addEventListener('change', updateInfo);
  toSel.addEventListener('change',   updateInfo);
  updateInfo();

  apply.addEventListener('click', () => _onUnitConversionAccept(fromSel.value, toSel.value));
}

function _wireBottomButtons() {
  _mountedEl.querySelector('#ms-close').addEventListener('click', () => exitModelSourceMode());
  _mountedEl.querySelector('#ms-reset-all').addEventListener('click', () => {
    if (!_currentNode) return;
    // window.confirm consistently jams Electron's renderer keyboard
    // focus state — after dismiss, number inputs accept clicks but
    // silently swallow typed digits (no amount of blur / focus
    // reordering reliably restores it). Render an inline confirm in
    // the panel instead. No native dialog, no focus race.
    _showInlineConfirm({
      title:   `Reset "${_currentNode.name || 'model'}" to original?`,
      message: 'Discards your unsaved source-transform edits to position, rotation, and scale.',
      confirmLabel: 'Reset',
      onConfirm: () => {
        _currentNode.sourceLocalPosition   = [...(_currentNode.originalSourceLocalPosition   || [0,0,0])];
        _currentNode.sourceLocalQuaternion = [...(_currentNode.originalSourceLocalQuaternion || [0,0,0,1])];
        _currentNode.sourceLocalScale      = [...(_currentNode.originalSourceLocalScale      || [1,1,1])];
        _applySourceToScene();
        _loadNodeIntoInputs();
      },
    });
  });
  _mountedEl.querySelector('#ms-save').addEventListener('click', () => {
    let changed = 0;
    for (const n of _models) {
      const before = _beforeSnaps.get(n.id);
      const after  = _snap(n);
      if (_snapEqual(before, after)) continue;
      actions.setModelSourceTransform(n.id, before, after);
      _beforeSnaps.set(n.id, after);
      changed++;
    }
    if (changed) setStatus(`Source transform saved (${changed} model${changed === 1 ? '' : 's'}). Ctrl-S to write to disk.`);
    else         setStatus('No changes to save.');
  });
}

// ─── Unit conversion ────────────────────────────────────────────────────────

function _conversionFactor(fromKey, toKey) {
  const from = UNITS[fromKey], to = UNITS[toKey];
  if (!from || !to) return 1;
  return from.factor / to.factor;
}

function _onUnitConversionAccept(fromKey, toKey) {
  const factor = _conversionFactor(fromKey, toKey);
  if (factor === 1) {
    setStatus('Source = target — no conversion needed.');
    return;
  }
  _showUnitConversionWarning(fromKey, toKey, factor);
}

function _showUnitConversionWarning(fromKey, toKey, factor) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:10000;';

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'min-width:380px;max-width:480px;padding:18px;background:var(--panel,#0f172a);border:1px solid var(--line,#334155);border-radius:10px;display:flex;flex-direction:column;gap:10px;';
  card.innerHTML = `
    <div class="title" style="font-size:14px;">Confirm unit conversion</div>
    <div class="small muted" style="line-height:1.5;">
      Converting <b>${UNITS[fromKey].name}</b> → <b>${UNITS[toKey].name}</b>
      multiplies the model's source scale by <b>${factor}×</b>.
    </div>
    <div class="small" style="line-height:1.5;color:#fbbf24;">
      ⚠ Large conversions can take time and may stress the renderer on
      heavy models. Save first if the project is important.
    </div>
    <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <button class="btn" type="button" id="msw-saveas">Save As…</button>
      <button class="btn" type="button" id="msw-cancel">Cancel</button>
    </div>
    <button class="btn primary" type="button" id="msw-accept">Accept conversion</button>
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
  });
  card.querySelector('#msw-accept').addEventListener('click', () => {
    overlay.remove();
    _applyUnitConversion(factor);
  });
}

function _applyUnitConversion(factor) {
  if (!_currentNode || !Number.isFinite(factor) || factor <= 0) return;
  _currentNode.sourceLocalScale = _currentNode.sourceLocalScale.map(v => v * factor);
  _applySourceToScene();
  _loadNodeIntoInputs();
  setStatus(`Source scale × ${factor} applied. Save to commit, or close to revert.`);
}

// ─── Per-axis reset ─────────────────────────────────────────────────────────

function _resetAxis(group, axis) {
  if (!_currentNode) return;
  const idx = { x: 0, y: 1, z: 2 }[axis];
  if (idx == null) return;

  if (group === 'pos') {
    _currentNode.sourceLocalPosition[idx] = (_currentNode.originalSourceLocalPosition || [0,0,0])[idx] ?? 0;
  } else if (group === 'rot') {
    // Rotation can't be cleanly per-axis-reset (Euler ambiguity, gimbal
    // lock). Reset the whole rotation to original.
    _currentNode.sourceLocalQuaternion = [...(_currentNode.originalSourceLocalQuaternion || [0,0,0,1])];
  } else if (group === 'scl') {
    if (_unifyScale) {
      _currentNode.sourceLocalScale = [...(_currentNode.originalSourceLocalScale || [1,1,1])];
    } else {
      _currentNode.sourceLocalScale[idx] = (_currentNode.originalSourceLocalScale || [1,1,1])[idx] ?? 1;
    }
  }
  _applySourceToScene();
  _loadNodeIntoInputs();
}

// ─── Snapshot helpers ───────────────────────────────────────────────────────

function _snap(node) {
  return {
    sourceLocalPosition:   [...(node.sourceLocalPosition   || [0,0,0])],
    sourceLocalQuaternion: [...(node.sourceLocalQuaternion || [0,0,0,1])],
    sourceLocalScale:      [...(node.sourceLocalScale      || [1,1,1])],
  };
}

function _snapEqual(a, b) {
  if (!a || !b) return false;
  const eq = (x, y) => x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
  return eq(a.sourceLocalPosition, b.sourceLocalPosition)
      && eq(a.sourceLocalQuaternion, b.sourceLocalQuaternion)
      && eq(a.sourceLocalScale, b.sourceLocalScale);
}

function _isCurrentNodeDirty() {
  if (!_currentNode) return false;
  return !_snapEqual(_beforeSnaps.get(_currentNode.id), _snap(_currentNode));
}

function _hasUncommittedChanges() {
  for (const n of _models) {
    if (!_snapEqual(_beforeSnaps.get(n.id), _snap(n))) return true;
  }
  return false;
}

function _revertNode(node) {
  const snap = _beforeSnaps.get(node.id);
  if (!snap) return;
  node.sourceLocalPosition   = [...snap.sourceLocalPosition];
  node.sourceLocalQuaternion = [...snap.sourceLocalQuaternion];
  node.sourceLocalScale      = [...snap.sourceLocalScale];
  const obj = steps.object3dById?.get(node.id);
  if (obj) applyNodeSourceTransformToObject3D(node, obj);
}

function _revertAllUncommitted() {
  for (const n of _models) {
    if (!_snapEqual(_beforeSnaps.get(n.id), _snap(n))) _revertNode(n);
  }
}

// ─── Inputs ↔ node ──────────────────────────────────────────────────────────

function _num(el) { return Number.isFinite(Number(el?.value)) ? Number(el.value) : 0; }

function _writePosition() {
  if (!_currentNode || !_inputs) return;
  _currentNode.sourceLocalPosition = _inputs.pos.map(_num);
}

function _writeRotation() {
  if (!_currentNode || !_inputs) return;
  _currentNode.sourceLocalQuaternion = normalizeQuaternion(eulerDegToQuaternion({
    x: _num(_inputs.rot[0]),
    y: _num(_inputs.rot[1]),
    z: _num(_inputs.rot[2]),
  }));
}

function _writeScale() {
  if (!_currentNode || !_inputs) return;
  if (_unifyScale) {
    const v = _num(_inputs.scl[0]);
    const safe = Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v;
    _currentNode.sourceLocalScale = [safe, safe, safe];
  } else {
    _currentNode.sourceLocalScale = _inputs.scl.map(el => {
      const v = _num(el);
      return Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v;
    });
  }
}

function _loadNodeIntoInputs() {
  if (!_currentNode || !_inputs) return;
  ensureTransformDefaults(_currentNode);
  const pos = _currentNode.sourceLocalPosition;
  const eul = quaternionToEulerDeg(_currentNode.sourceLocalQuaternion);
  const scl = _currentNode.sourceLocalScale;
  ['x','y','z'].forEach((a, i) => {
    _inputs.pos[i].value = _fmt(pos[i]);
    _inputs.scl[i].value = _fmt(scl[i]);
  });
  _inputs.rot[0].value = _fmt(eul.x);
  _inputs.rot[1].value = _fmt(eul.y);
  _inputs.rot[2].value = _fmt(eul.z);
}

function _applySourceToScene() {
  if (!_currentNode) return;
  const obj = steps.object3dById?.get(_currentNode.id);
  if (obj) applyNodeSourceTransformToObject3D(_currentNode, obj);
}

function _fmt(v) {
  if (!Number.isFinite(v)) return '0';
  return Number(v.toFixed(3)).toString();
}

/**
 * Inline confirmation dialog rendered INSIDE the panel — no native
 * window.confirm. Built to dodge the Electron focus-jam where
 * window.confirm leaves number inputs in a "spinner-only" state.
 * Returns nothing; calls onConfirm() if user picks Confirm.
 */
function _showInlineConfirm({ title, message, confirmLabel = 'Confirm', onConfirm }) {
  if (!_mountedEl) return;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;background:rgba(15,23,42,0.85);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px;';
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:340px;padding:14px;display:flex;flex-direction:column;gap:8px;background:var(--panel,#0f172a);border:1px solid var(--line,#334155);border-radius:10px;';
  card.innerHTML = `
    <div class="title" style="font-size:13px;">${_escHtml(title)}</div>
    <div class="small muted" style="line-height:1.45;">${_escHtml(message)}</div>
    <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
      <button class="btn" type="button" data-act="cancel">Cancel</button>
      <button class="btn primary" type="button" data-act="confirm">${_escHtml(confirmLabel)}</button>
    </div>
  `;
  overlay.appendChild(card);

  // Position relative to the panel: make _mountedEl positioning-aware
  // so the absolute overlay lands on top of just the panel.
  const prevPos = _mountedEl.style.position;
  if (!prevPos || prevPos === 'static') _mountedEl.style.position = 'relative';
  _mountedEl.appendChild(overlay);

  const close = () => {
    overlay.remove();
    if (!prevPos) _mountedEl.style.position = '';
  };
  card.querySelector('[data-act=cancel]').addEventListener('click', close);
  card.querySelector('[data-act=confirm]').addEventListener('click', () => {
    close();
    try { onConfirm?.(); } catch (e) { console.warn('[model-source] confirm action failed:', e); }
  });
}

function _escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
