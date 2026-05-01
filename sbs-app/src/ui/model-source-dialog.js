/**
 * SBS Step Browser — Model Source Transform dialog
 * ====================================================
 * Edit → Model source transform… opens this. The user picks a
 * top-level node (a directly-imported model) from a dropdown, edits
 * its baseLocalPosition / baseLocalQuaternion / baseLocalScale via
 * numeric inputs, and presses Save to commit. Sub-folders / meshes
 * inside the model are intentionally NOT pickable here — fixing the
 * import-time orientation of one mesh deep in the hierarchy is a
 * different workflow (regular gizmo on a regular step).
 *
 * Live preview: edits write directly to node.baseLocal* and re-apply
 * transforms so the user sees the change in the viewport. Cancel
 * reverts to the snapshot taken at dialog open. Save commits with a
 * single undoable entry — Ctrl-Z later restores the pre-edit state.
 *
 * Per-step transforms aren't touched: each step's snapshot stores
 * localOffset as a DELTA off the base (transforms.js: position =
 * baseLocalPosition + localOffset), so changing the base shifts every
 * step's effective world position uniformly. That's the whole point —
 * fix the model's orientation once, every step inherits the fix.
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

let _activeOverlay = null;

/**
 * Open the modal. No-op if already open.
 */
export function openModelSourceDialog() {
  if (_activeOverlay) return;

  // Top-level transformable children of the scene root — the user's
  // imported models (and any folders they manually placed at the top
  // level). Excludes meshes / sub-folders / the scene root itself.
  const root = state.get('treeData');
  const topLevel = (root?.children || []).filter(isTransformNode);

  if (topLevel.length === 0) {
    setStatus('No models loaded — load a model first to edit its source transform.', 'warn');
    return;
  }

  // Snapshot every top-level node's baseLocal* up front. Cancel + Save
  // both need this to know what to revert to / undo.
  const before = new Map();
  for (const n of topLevel) {
    ensureTransformDefaults(n);
    before.set(n.id, _snap(n));
  }

  // ── DOM ────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.55)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'z-index:9999',
  ].join(';');

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = [
    'min-width:420px', 'max-width:520px', 'padding:18px',
    'background:var(--panel, #0f172a)', 'border:1px solid var(--line, #334155)',
    'border-radius:10px', 'display:flex', 'flex-direction:column', 'gap:10px',
  ].join(';');

  card.innerHTML = `
    <div class="title" style="font-size:14px;">Model source transform</div>
    <div class="small muted" style="line-height:1.5;">
      Edits the imported model's base position / rotation / scale. Per-step
      animations stay intact — every step shifts uniformly with the base.
      Save to commit; Cancel reverts.
    </div>

    <label class="colorlab">Model
      <select id="ms-model" style="margin-top:6px;width:100%;">
        ${topLevel.map(n =>
          `<option value="${_esc(n.id)}">${_esc(n.name || '(unnamed)')}</option>`
        ).join('')}
      </select>
    </label>

    <div class="card" style="background:#0b1220;padding:10px;display:flex;flex-direction:column;gap:8px;">
      <div class="small muted">Position</div>
      <div class="grid3" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${_axisInput('pos', 'x')}
        ${_axisInput('pos', 'y')}
        ${_axisInput('pos', 'z')}
      </div>
      <div class="small muted" style="margin-top:4px;">Rotation (degrees)</div>
      <div class="grid3" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${_axisInput('rot', 'x')}
        ${_axisInput('rot', 'y')}
        ${_axisInput('rot', 'z')}
      </div>
      <div class="small muted" style="margin-top:4px;">Scale</div>
      <div class="grid3" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
        ${_axisInput('scl', 'x')}
        ${_axisInput('scl', 'y')}
        ${_axisInput('scl', 'z')}
      </div>
    </div>

    <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
      <button class="btn" id="ms-reset">Reset</button>
      <button class="btn" id="ms-cancel">Cancel</button>
    </div>
    <button class="btn primary" id="ms-save" style="margin-top:0;">Save changes</button>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _activeOverlay = overlay;

  // ── State + wiring ─────────────────────────────────────────────────
  const sel       = card.querySelector('#ms-model');
  const inputs    = {
    pos: ['x','y','z'].map(a => card.querySelector(`#ms-pos-${a}`)),
    rot: ['x','y','z'].map(a => card.querySelector(`#ms-rot-${a}`)),
    scl: ['x','y','z'].map(a => card.querySelector(`#ms-scl-${a}`)),
  };

  let currentNode = topLevel[0];
  _loadNodeIntoInputs(currentNode, inputs);

  sel.addEventListener('change', () => {
    currentNode = topLevel.find(n => n.id === sel.value) || topLevel[0];
    _loadNodeIntoInputs(currentNode, inputs);
  });

  // Live-preview each input change. Reads ALL inputs, writes back to
  // node, re-applies. The dialog could batch but the inputs are cheap
  // enough that doing it per-keystroke is fine.
  for (const list of Object.values(inputs)) {
    for (const inp of list) {
      inp.addEventListener('input', () => _applyInputsToNode(currentNode, inputs));
    }
  }

  card.querySelector('#ms-reset').addEventListener('click', () => {
    const snap = before.get(currentNode.id);
    if (!snap) return;
    Object.assign(currentNode, _restoreSnapData(snap));
    _loadNodeIntoInputs(currentNode, inputs);
    _applyToScene();
  });

  card.querySelector('#ms-cancel').addEventListener('click', () => {
    // Revert every node we might have touched (user may have switched
    // models mid-edit — snapshot up-front catches all of them).
    for (const n of topLevel) {
      const snap = before.get(n.id);
      if (snap) Object.assign(n, _restoreSnapData(snap));
    }
    _applyToScene();
    _close();
  });

  card.querySelector('#ms-save').addEventListener('click', () => {
    // Push one undo entry per node that actually changed. We could
    // bundle them into a single composite entry, but the existing
    // undoManager has no composite primitive — N entries are correct
    // semantically and the user can undo back through them.
    let changed = 0;
    for (const n of topLevel) {
      const beforeSnap = before.get(n.id);
      const afterSnap  = _snap(n);
      if (_snapEqual(beforeSnap, afterSnap)) continue;
      actions.setModelSourceTransform(n.id, beforeSnap, afterSnap);
      changed++;
    }
    if (changed) setStatus(`Model source transform saved (${changed} model${changed === 1 ? '' : 's'} changed).`);
    else         setStatus('No changes — model source transforms unchanged.');
    _close();
  });

  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      // Click-outside acts as Cancel — same revert.
      for (const n of topLevel) {
        const snap = before.get(n.id);
        if (snap) Object.assign(n, _restoreSnapData(snap));
      }
      _applyToScene();
      _close();
    }
  });
}

function _close() {
  if (!_activeOverlay) return;
  _activeOverlay.remove();
  _activeOverlay = null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function _axisInput(group, axis) {
  return `<input type="number" step="0.01" id="ms-${group}-${axis}" placeholder="${axis.toUpperCase()}" style="width:100%;" />`;
}

function _snap(node) {
  return {
    baseLocalPosition:   [...(node.baseLocalPosition   || [0,0,0])],
    baseLocalQuaternion: [...(node.baseLocalQuaternion || [0,0,0,1])],
    baseLocalScale:      [...(node.baseLocalScale      || [1,1,1])],
  };
}

function _restoreSnapData(snap) {
  return {
    baseLocalPosition:   [...snap.baseLocalPosition],
    baseLocalQuaternion: [...snap.baseLocalQuaternion],
    baseLocalScale:      [...snap.baseLocalScale],
  };
}

function _snapEqual(a, b) {
  if (!a || !b) return false;
  const eq = (x, y) => x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-6);
  return eq(a.baseLocalPosition, b.baseLocalPosition)
      && eq(a.baseLocalQuaternion, b.baseLocalQuaternion)
      && eq(a.baseLocalScale, b.baseLocalScale);
}

function _loadNodeIntoInputs(node, inputs) {
  ensureTransformDefaults(node);
  const pos = node.baseLocalPosition;
  const eul = quaternionToEulerDeg(node.baseLocalQuaternion);
  const scl = node.baseLocalScale;
  ['x','y','z'].forEach((a, i) => {
    inputs.pos[i].value = _fmt(pos[i]);
    inputs.scl[i].value = _fmt(scl[i]);
  });
  inputs.rot[0].value = _fmt(eul.x);
  inputs.rot[1].value = _fmt(eul.y);
  inputs.rot[2].value = _fmt(eul.z);
}

function _applyInputsToNode(node, inputs) {
  const num = (el) => Number.isFinite(Number(el.value)) ? Number(el.value) : 0;
  node.baseLocalPosition   = inputs.pos.map(num);
  node.baseLocalQuaternion = normalizeQuaternion(eulerDegToQuaternion({
    x: num(inputs.rot[0]),
    y: num(inputs.rot[1]),
    z: num(inputs.rot[2]),
  }));
  // Forbid zero/negative scale — silently clamp to 0.001 so a stray
  // 0 entry doesn't make the model invisible / cause NaN propagation.
  node.baseLocalScale = inputs.scl.map(el => {
    const v = num(el);
    return Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : v;
  });
  _applyToScene();
}

function _applyToScene() {
  applyAllTransforms(state.get('treeData'), steps.object3dById);
  state.emit('change:treeData', state.get('treeData'));
}

function _fmt(v) {
  if (!Number.isFinite(v)) return '0';
  // 3 decimals max, drop trailing zeroes.
  return Number(v.toFixed(3)).toString();
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
