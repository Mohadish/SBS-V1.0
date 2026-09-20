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
// NAMED export — `import * as state` gives the module namespace, whose `.get`
// is undefined, and the throw inside a pointerenter handler is swallowed: that
// is why the hover preview never appeared in V0.3.4.23/.24.
import { state } from '../core/state.js';
import { frameHeight } from '../core/perspective.js';

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
let _surface = null, _dip = null, _dipTimers = [];

/** The scene's own background, so the dip reads as the view itself fading. */
function _bgCss() {
  const bg = sceneCore.scene?.background;
  if (bg && typeof bg.getStyle === 'function') { try { return bg.getStyle(); } catch {} }
  return '#0f172a';
}

/**
 * Switch WITHOUT moving the camera: the view fades out, the camera is placed
 * instantly, the view fades back in — ~200 ms end to end (user, V0.3.4.24).
 * A flight between two axis views is a long way round for no information; a
 * dip reads as "now you are looking from there".
 *
 * The dip sits above the 3D canvas and the 2D overlay stage but below these
 * buttons, so the thing you clicked never blinks out under your cursor.
 */
function _dipSwitch(apply, ms = 200) {
  const half = Math.max(60, Math.round(ms / 2));
  if (!_surface) { apply(); return; }
  if (!_dip) {
    _dip = document.createElement('div');
    _dip.id = 'standard-view-dip';
    _dip.style.cssText = 'position:absolute;inset:0;z-index:26;pointer-events:none;opacity:0;display:none;';
    _surface.appendChild(_dip);
  }
  for (const t of _dipTimers) clearTimeout(t);
  _dipTimers = [];
  _dip.style.background = _bgCss();
  _dip.style.transition = `opacity ${half}ms linear`;
  _dip.style.display = 'block';
  requestAnimationFrame(() => { _dip.style.opacity = '1'; });
  _dipTimers.push(setTimeout(() => {
    apply();
    sceneCore.requestRender?.(400);
    requestAnimationFrame(() => { _dip.style.opacity = '0'; });
    _dipTimers.push(setTimeout(() => { _dip.style.display = 'none'; }, half + 60));
  }, half + 20));
}

// ── the hover preview, drawn in the scene ──────────────────────────────────
function _clearPreview() {
  _hovering = null;
  if (!_preview) return;
  _preview.visible = false;
  sceneCore.requestRender?.(120);
}

/**
 * A translucent square on the plane you would look through, plus an arrow along
 * the direction you would look — in the middle of the frame, half a frame
 * across, so it reads the same on a bolt and on a machine. One group, reused.
 */
function _showPreview(view) {
  const T = window.THREE;
  const cfg = AXIS[view];
  if (!T || !cfg || !sceneCore.overlayScene || state.get('_exporting')) return;

  // IN THE MIDDLE OF THE FRAME, sized to the frame (V0.3.4.25): the centre of
  // the screen at the depth you are focused on, half a frame across. Anchoring
  // it to the model's bounding sphere instead put it off-screen on a zoomed-in
  // shot and made it a speck on a big assembly.
  const cam = sceneCore.camera;
  const fwdNow = cam.getWorldDirection(new T.Vector3());
  const dNow = Math.max(sceneCore.focusDistance?.() || 0, 1e-3);
  const centre = cam.position.clone().addScaledVector(fwdNow, dNow);
  const R = Math.max(frameHeight(dNow, cam.fov, cam.zoom) * 0.25, 1e-3);   // half a frame across

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

  // The plane you would look THROUGH — square to the view direction, sitting in
  // the middle of the frame — and an arrow that flies in along that direction
  // and lands on it. The arrow is a cylinder + cone rather than an ArrowHelper
  // so both ends can be scaled to the frame.
  const dir = new T.Vector3(...cfg.dir).normalize();           // the way you will look
  const side = dir.clone().multiplyScalar(-1);                 // where you will look FROM
  const size = R * 2;
  plane.scale.set(size, size, 1);
  edge.scale.copy(plane.scale);
  const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), side);
  plane.position.copy(centre); plane.quaternion.copy(q);
  edge.position.copy(centre);  edge.quaternion.copy(q);

  const len = R * 1.6, headLen = R * 0.45, headR = R * 0.16, shaftR = R * 0.05;
  const qy = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
  const start = centre.clone().addScaledVector(side, len);     // tip lands on the plane
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

  _surface = surfaceEl;
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
        _dipSwitch(() => sceneCore.applyStandardView(view, 0));   // 0 = placed, not flown
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
