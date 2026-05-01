/**
 * SBS Step Browser — Model Source Transform window
 * =====================================================
 * Edit → Model source transform… opens this. Floating, draggable,
 * lives in document.body. Independent of sidebar / steps panel.
 *
 * Architecture (per user spec)
 * ----------------------------
 * Source transform is BAKED into the model's geometry chain via a
 * dedicated INNER Three.js group between the model's outer group and
 * its mesh children. Equivalent to opening the model file in another
 * DCC, applying the transform there, and reloading:
 *
 *   outer group (per-step transforms + pivot system)
 *     └─ inner sbs-source group (source transform — what this window writes)
 *          └─ mesh children
 *
 * - Per-step localOffset / localQuaternion are NEVER touched.
 * - Pivot reads the outer group. Source lives on the inner group.
 *   Pivot world position + orientation are unaffected.
 * - Cascades through every step automatically because the inner is
 *   part of the model's hierarchy. Move the model into a folder?
 *   Inner goes with it. Different per-step poses? Inner reflects
 *   the same source transform under each.
 *
 * Inputs are ABSOLUTE source values (not deltas). Pick a model →
 * inputs populate from its current source. Edit → Apply → those
 * values are written. Successive applies replace, not stack.
 */

import { state }    from '../core/state.js';
import * as actions from '../systems/actions.js';
import {
  ensureTransformDefaults,
  quaternionToEulerDeg,
  eulerDegToQuaternion,
  normalizeQuaternion,
}                   from '../core/transforms.js';
import { setStatus } from './status.js';

let _windowEl      = null;
let _currentNodeId = null;

const AXIS_COLORS = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' };

// ─── Public API ─────────────────────────────────────────────────────────────

export function openModelSourceDialog() {
  if (_windowEl) {
    _windowEl.style.display = 'flex';
    _refreshModelList();
    _loadCurrentNodeIntoInputs();
    return;
  }
  _build();
}

export function closeModelSourceDialog() {
  if (!_windowEl) return;
  _windowEl.remove();
  _windowEl = null;
  _currentNodeId = null;
}

// ─── Build / Render ─────────────────────────────────────────────────────────

function _build() {
  _windowEl = document.createElement('div');
  _windowEl.id = 'model-source-window';
  _windowEl.style.cssText = [
    'position:fixed', 'top:80px', 'left:80px', 'width:340px',
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
        Bakes a transform into the model file's geometry — like
        re-importing a pre-edited model. Per-step transforms and the
        pivot are unaffected; every step picks up the source through
        the model's hierarchy.
      </div>

      <label class="colorlab">Model
        <select id="ms-model" style="margin-top:4px;width:100%;"></select>
      </label>

      ${_axisGroupHTML('Position', 'pos', '0', '0.01')}
      ${_axisGroupHTML('Rotation (Euler XYZ°)', 'rot', '0', '1')}
      ${_axisGroupHTML('Scale', 'scl', '1', '0.01')}

      <button class="btn primary" id="ms-apply" type="button" style="margin-top:6px;">Apply</button>
      <button class="btn" id="ms-reset" type="button" style="margin-top:0;">Reset (identity)</button>
      <div class="small muted" id="ms-status" style="font-size:11px;min-height:14px;"></div>
    </div>
  `;

  document.body.appendChild(_windowEl);

  _refreshModelList();
  _wireDrag();
  _wireModelPicker();
  _wireApply();

  _windowEl.querySelector('#ms-window-close').addEventListener('click', closeModelSourceDialog);
}

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
  _loadCurrentNodeIntoInputs();
}

function _wireModelPicker() {
  const sel = _windowEl.querySelector('#ms-model');
  sel.addEventListener('change', () => {
    _currentNodeId = sel.value;
    _loadCurrentNodeIntoInputs();
  });
}

// ─── HTML ──────────────────────────────────────────────────────────────────

function _axisGroupHTML(label, group, defaultVal, step) {
  return `
    <div>
      <div class="small muted" style="font-weight:600;margin-bottom:4px;font-size:11px;">${label}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${['x','y','z'].map(a => `
          <div style="display:flex;align-items:center;gap:3px;">
            <span style="color:${AXIS_COLORS[a]};font-weight:700;font-size:11px;width:10px;">${a.toUpperCase()}</span>
            <input type="number" step="${step}" id="ms-${group}-${a}" value="${defaultVal}" style="flex:1;min-width:0;" />
          </div>
        `).join('')}
      </div>
    </div>
  `;
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

// ─── Inputs ↔ node ─────────────────────────────────────────────────────────

function _num(el, fallback = 0) {
  return Number.isFinite(Number(el?.value)) ? Number(el.value) : fallback;
}
function _fmt(v) {
  if (!Number.isFinite(v)) return '0';
  return Number(v.toFixed(3)).toString();
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
}

function _readInputs() {
  const get = (id) => _windowEl.querySelector(id);
  const pos = [_num(get('#ms-pos-x')), _num(get('#ms-pos-y')), _num(get('#ms-pos-z'))];
  const eul = {
    x: _num(get('#ms-rot-x')),
    y: _num(get('#ms-rot-y')),
    z: _num(get('#ms-rot-z')),
  };
  const quat = normalizeQuaternion(eulerDegToQuaternion(eul));
  const scl = [_num(get('#ms-scl-x'), 1), _num(get('#ms-scl-y'), 1), _num(get('#ms-scl-z'), 1)]
    .map(v => Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v);
  return { pos, quat, scl };
}

// ─── Apply / Reset ─────────────────────────────────────────────────────────

function _wireApply() {
  _windowEl.querySelector('#ms-apply').addEventListener('click', () => {
    if (!_currentNodeId) {
      _setStatus('No model selected.');
      return;
    }
    const { pos, quat, scl } = _readInputs();
    actions.setModelSourceTransform(_currentNodeId, pos, quat, scl);
    _setStatus('Source transform applied.');
    setStatus('Model source transform applied.');
  });

  _windowEl.querySelector('#ms-reset').addEventListener('click', () => {
    if (!_currentNodeId) return;
    actions.setModelSourceTransform(_currentNodeId, [0,0,0], [0,0,0,1], [1,1,1]);
    _loadCurrentNodeIntoInputs();
    _setStatus('Reset to identity.');
  });
}

function _setStatus(msg) {
  if (!_windowEl) return;
  const el = _windowEl.querySelector('#ms-status');
  if (el) el.textContent = msg;
}
