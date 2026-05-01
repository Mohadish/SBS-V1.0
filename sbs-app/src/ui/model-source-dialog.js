/**
 * SBS Step Browser — Model Source Transform window
 * =====================================================
 * Edit → Model source transform… opens this. Floating, draggable,
 * lives in document.body — independent of the sidebar / steps panel.
 *
 * Architecture (per user spec)
 * ----------------------------
 * Source transform is a CASCADE through every step's stored snapshot:
 *
 *   for each step:
 *     step.snapshot.transforms[modelId].localOffset     += Δposition
 *     step.snapshot.transforms[modelId].localQuaternion  = old × Δq
 *   node.pivotLocalQuaternion = inv(Δq) × old   (pivot world-orientation invariant)
 *   node.baseLocalScale       *= Δscale          (project-level scale)
 *
 * No extra Three.js groups, no per-frame composition. Each step's
 * stored transform IS the world transform — pivot system stays clean,
 * gizmo behaviour unchanged. The cascade is undoable as ONE entry.
 *
 * UI is intentionally minimal: pick a model, type the delta you want,
 * Apply. Inputs reset to 0/1 after apply so successive deltas stack.
 */

import { state }    from '../core/state.js';
import * as actions from '../systems/actions.js';
import {
  eulerDegToQuaternion,
  normalizeQuaternion,
}                   from '../core/transforms.js';
import { setStatus } from './status.js';

let _windowEl   = null;
let _currentNodeId = null;

const AXIS_COLORS = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' };

export function openModelSourceDialog() {
  if (_windowEl) {
    _windowEl.style.display = 'flex';
    _bringToFront();
    _refreshModelList();
    return;
  }
  _build();
}

export function closeModelSourceDialog() {
  if (!_windowEl) return;
  _windowEl.remove();
  _windowEl = null;
}

function _build() {
  _windowEl = document.createElement('div');
  _windowEl.id = 'model-source-window';
  _windowEl.style.cssText = [
    'position:fixed',
    'top:80px',
    'left:80px',
    'width:340px',
    'background:var(--panel,#0f172a)',
    'border:1px solid var(--line,#334155)',
    'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.5)',
    'z-index:9999',
    'display:flex',
    'flex-direction:column',
    'gap:0',
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
        Picks a model. Enter a delta in position / rotation / scale,
        press Apply — the same delta cascades through every step.
        Pivot world orientation stays put.
      </div>

      <label class="colorlab">Model
        <select id="ms-model" style="margin-top:4px;width:100%;"></select>
      </label>

      ${_axisGroupHTML('Position (delta)', 'pos', '0', '0.1')}
      ${_axisGroupHTML('Rotation (Δ°, Euler XYZ)', 'rot', '0', '1')}
      ${_axisGroupHTML('Scale (multiplier)',     'scl', '1', '0.1')}

      <button class="btn primary" id="ms-apply" type="button" style="margin-top:6px;">Apply (cascade to all steps)</button>
      <div class="small muted" id="ms-status" style="font-size:11px;min-height:14px;"></div>
    </div>
  `;

  document.body.appendChild(_windowEl);

  _refreshModelList();
  _wireDrag();
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
  // Preserve current selection if still present.
  if (_currentNodeId && models.some(n => n.id === _currentNodeId)) {
    sel.value = _currentNodeId;
  } else {
    _currentNodeId = sel.value;
  }
  sel.addEventListener('change', () => { _currentNodeId = sel.value; });
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
    // Don't start drag when the user clicks on the close button.
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

function _bringToFront() {
  if (_windowEl) _windowEl.style.zIndex = '9999';
}

// ─── Apply ─────────────────────────────────────────────────────────────────

function _wireApply() {
  const get = (id) => _windowEl.querySelector(id);
  const num = (el, fallback = 0) => Number.isFinite(Number(el?.value)) ? Number(el.value) : fallback;

  get('#ms-apply').addEventListener('click', () => {
    const sel = get('#ms-model');
    const id  = sel.value;
    if (!id) {
      _setLocalStatus('No model selected.');
      return;
    }
    const dPos = [
      num(get('#ms-pos-x')),
      num(get('#ms-pos-y')),
      num(get('#ms-pos-z')),
    ];
    const eul = {
      x: num(get('#ms-rot-x')),
      y: num(get('#ms-rot-y')),
      z: num(get('#ms-rot-z')),
    };
    const dQuat = normalizeQuaternion(eulerDegToQuaternion(eul));
    const dScl = [
      num(get('#ms-scl-x'), 1),
      num(get('#ms-scl-y'), 1),
      num(get('#ms-scl-z'), 1),
    ].map(v => Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v);

    // No-op short-circuit.
    const isPosZero  = dPos.every(v => Math.abs(v) < 1e-9);
    const isQuatId   = Math.abs(dQuat[0]) < 1e-9 && Math.abs(dQuat[1]) < 1e-9
                       && Math.abs(dQuat[2]) < 1e-9 && Math.abs(dQuat[3] - 1) < 1e-9;
    const isScaleOne = dScl.every(v => Math.abs(v - 1) < 1e-9);
    if (isPosZero && isQuatId && isScaleOne) {
      _setLocalStatus('Nothing to apply (delta is identity).');
      return;
    }

    actions.cascadeModelSourceTransform(id, dPos, dQuat, dScl);

    // Reset inputs so the user can stack another delta.
    ['x','y','z'].forEach(a => {
      get(`#ms-pos-${a}`).value = '0';
      get(`#ms-rot-${a}`).value = '0';
      get(`#ms-scl-${a}`).value = '1';
    });
    _setLocalStatus(`Applied. Cascaded across all steps.`);
    setStatus(`Model source transform applied.`);
  });
}

function _setLocalStatus(msg) {
  if (!_windowEl) return;
  const el = _windowEl.querySelector('#ms-status');
  if (el) el.textContent = msg;
}
