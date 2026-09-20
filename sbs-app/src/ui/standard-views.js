/**
 * SBS — standard views (V0.3.4.23).
 *
 * Six buttons under the Work Camera button, in three stacked pairs — Top over
 * Bottom, Left over Right, Front over Back — each pair in its axis colour:
 * X red, Y green, Z blue, the same code the gizmo and the axes helper speak.
 *
 * Hovering one shows, in the scene itself, the plane you would be looking
 * through and an arrow along the direction you would be looking. Clicking flies
 * there orthographically, keeping your framing: the subject stays the size it
 * is, only the direction and the lens change.
 *
 * Inspection tools, like the work camera they hang under: nothing here writes a
 * step. The view is live until C records it.
 */

import sceneCore from '../core/scene.js';
import * as state from '../core/state.js';

const AXIS = {
  top:    { axis: 'y', color: '#22c55e', hex: 0x22c55e, dir: [0, -1, 0], label: 'Top',    title: 'Look straight down the Y axis' },
  bottom: { axis: 'y', color: '#22c55e', hex: 0x22c55e, dir: [0,  1, 0], label: 'Bottom', title: 'Look straight up the Y axis' },
  left:   { axis: 'x', color: '#ef4444', hex: 0xef4444, dir: [1,  0, 0], label: 'Left',   title: 'Look along the X axis, from the left' },
  right:  { axis: 'x', color: '#ef4444', hex: 0xef4444, dir: [-1, 0, 0], label: 'Right',  title: 'Look along the X axis, from the right' },
  front:  { axis: 'z', color: '#3b82f6', hex: 0x3b82f6, dir: [0, 0, -1], label: 'Front',  title: 'Look along the Z axis, from the front' },
  back:   { axis: 'z', color: '#3b82f6', hex: 0x3b82f6, dir: [0, 0,  1], label: 'Back',   title: 'Look along the Z axis, from the back' },
};
const PAIRS = [['top', 'bottom'], ['left', 'right'], ['front', 'back']];

let _wrap = null, _btns = new Map(), _preview = null, _hovering = null;

// ── the hover preview, drawn in the scene ──────────────────────────────────
function _clearPreview() {
  _hovering = null;
  if (!_preview) return;
  _preview.visible = false;
  sceneCore.requestRender?.(120);
}

/**
 * A translucent square on the plane you would look through, plus an arrow along
 * the direction you would look. Sized to whatever is in the scene, so it reads
 * on a bolt and on a machine alike. Rebuilt on each hover — one group, reused.
 */
function _showPreview(view) {
  const T = window.THREE;
  const cfg = AXIS[view];
  if (!T || !cfg || !sceneCore.overlayScene || state.get('_exporting')) return;

  const box = sceneCore.computeBoundingBox?.(null);
  const sphere = box && !box.isEmpty() ? box.getBoundingSphere(new T.Sphere()) : null;
  const centre = sphere ? sphere.center.clone() : new T.Vector3();
  const R = Math.max(sphere?.radius || 0, 1e-3);

  if (!_preview) {
    _preview = new T.Group();
    _preview.name = 'sbs-standard-view-preview';
    _preview.renderOrder = 9998;
    const planeMat = new T.MeshBasicMaterial({
      transparent: true, opacity: 0.14, side: T.DoubleSide, depthWrite: false, depthTest: false,
    });
    const plane = new T.Mesh(new T.PlaneGeometry(1, 1), planeMat);
    plane.name = 'plane';
    const edgeMat = new T.LineBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false });
    const edge = new T.LineSegments(new T.EdgesGeometry(plane.geometry), edgeMat);
    edge.name = 'edge';
    const shaft = new T.Mesh(
      new T.CylinderGeometry(1, 1, 1, 12),
      new T.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    );
    shaft.name = 'shaft';
    const head = new T.Mesh(
      new T.ConeGeometry(1, 1, 16),
      new T.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
    );
    head.name = 'head';
    _preview.add(plane, edge, shaft, head);
    sceneCore.overlayScene.add(_preview);
  }

  const plane = _preview.getObjectByName('plane');
  const edge  = _preview.getObjectByName('edge');
  const shaft = _preview.getObjectByName('shaft');
  const head  = _preview.getObjectByName('head');
  for (const m of [plane, edge, shaft, head]) m.material.color.setHex(cfg.hex);

  // The plane you look THROUGH: perpendicular to the view direction, on the
  // near side of the model so the arrow reads as coming towards it.
  const dir = new T.Vector3(...cfg.dir).normalize();          // the way you will look
  const side = dir.clone().multiplyScalar(-1);                 // where you will look FROM
  const planePos = centre.clone().addScaledVector(side, R * 1.15);
  const size = R * 2.3;
  plane.scale.set(size, size, 1);
  edge.scale.copy(plane.scale);
  const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), side);
  plane.position.copy(planePos); plane.quaternion.copy(q);
  edge.position.copy(planePos);  edge.quaternion.copy(q);

  // The arrow: from the plane, along the view direction, stopping short of the
  // model. A cylinder + cone rather than ArrowHelper so it can be scaled freely.
  const len = R * 0.95, headLen = R * 0.3, headR = R * 0.11, shaftR = R * 0.035;
  const qy = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
  const start = planePos.clone();
  shaft.scale.set(shaftR, Math.max(len - headLen, 1e-4), shaftR);
  shaft.quaternion.copy(qy);
  shaft.position.copy(start).addScaledVector(dir, (len - headLen) / 2);
  head.scale.set(headR, headLen, headR);
  head.quaternion.copy(qy);
  head.position.copy(start).addScaledVector(dir, len - headLen / 2);

  _preview.visible = true;
  _hovering = view;
  sceneCore.requestRender?.(200);
}

// ── the buttons ────────────────────────────────────────────────────────────
function _syncActive(active) {
  for (const [view, btn] of _btns) {
    const on = view === active;
    btn.style.background = on ? `${AXIS[view].color}44` : 'rgba(10,15,25,0.85)';
    btn.style.borderColor = on ? AXIS[view].color : 'rgba(255,255,255,0.08)';
  }
}

/**
 * Build the grid (hidden until the work camera is on) inside the viewport
 * surface. Returns { setVisible } for the work-camera toggle to drive.
 */
export function initStandardViews(surfaceEl) {
  if (!surfaceEl || _wrap) return { setVisible: (v) => { if (_wrap) _wrap.style.display = v ? 'flex' : 'none'; if (!v) _clearPreview(); } };

  _wrap = document.createElement('div');
  _wrap.id = 'standard-views';
  _wrap.style.cssText = 'position:absolute;top:38px;left:8px;z-index:30;display:none;gap:4px;'
    + 'flex-direction:row;align-items:flex-start;';

  for (const pair of PAIRS) {
    const col = document.createElement('div');
    col.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    for (const view of pair) {
      const cfg = AXIS[view];
      const b = document.createElement('button');
      b.className = 'btn';
      b.type = 'button';
      b.textContent = cfg.label;
      b.title = `${cfg.title} — orthographic, keeping your framing. Turning the view with Alt + middle-drag leaves it.`;
      b.style.cssText = 'height:22px;min-width:58px;padding:0 8px;font-size:11px;font-weight:600;'
        + 'background:rgba(10,15,25,0.85);border:1px solid rgba(255,255,255,0.08);border-radius:7px;'
        + `color:${cfg.color};cursor:pointer;`;
      b.addEventListener('pointerenter', () => _showPreview(view));
      b.addEventListener('pointerleave', () => _clearPreview());
      b.addEventListener('focus', () => _showPreview(view));
      b.addEventListener('blur', () => _clearPreview());
      b.addEventListener('click', () => {
        _clearPreview();
        sceneCore.applyStandardView(view);
      });
      _btns.set(view, b);
      col.appendChild(b);
    }
    _wrap.appendChild(col);
  }
  surfaceEl.appendChild(_wrap);

  sceneCore.on?.('camera:standardView', (v) => _syncActive(v));
  _syncActive(sceneCore.getStandardView?.());

  return {
    setVisible: (v) => {
      _wrap.style.display = v ? 'flex' : 'none';
      if (!v) _clearPreview();
      else _syncActive(sceneCore.getStandardView?.());
    },
  };
}

/** Which view the preview is showing, if any (used by tests / diagnostics). */
export function hoveredStandardView() { return _hovering; }
