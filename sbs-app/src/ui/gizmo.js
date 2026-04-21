/**
 * SBS — Transform Gizmo
 * ======================
 * Renders in overlayScene (depth-cleared → always on top).
 * Arrows = translate, Rings = rotate, Squares = plane translate.
 *
 * Colors:  X=red  Y=green  Z=blue  hover=yellow  active=white
 * States:  grey(idle) → yellow(hover, +scale) → white(drag)
 *
 * Integration:
 *   gizmo.init()                   — call once after scene ready
 *   gizmo.show(node, obj3d)        — call on selection change
 *   gizmo.hide()                   — call on deselect / scene clear
 *   gizmo.onHover(x, y)            — call from canvas pointermove (no btn)
 *   gizmo.onPointerDown(x, y) → bool  — true = gizmo consumed event
 *   gizmo.onPointerMove(x, y) → bool  — true = gizmo is dragging
 *   gizmo.onPointerUp()            — commit drag
 *   gizmo.setMode(m)               — 'all' | 'translate' | 'rotate'
 */

import { sceneCore }  from '../core/scene.js';
import * as actions   from '../systems/actions.js';
import steps          from '../systems/steps.js';
import {
  applyNodeTransformToObject3D,
} from '../core/transforms.js';

// ── Constants ────────────────────────────────────────────────────────────────
const AX  = { x: 0xe05555, y: 0x55cc55, z: 0x5588e0 };
const HOVER_COL  = 0xffee22;
const ACTIVE_COL = 0xffffff;
const SCREEN_SIZE = 0.16;   // gizmo = 16% of view height, constant on screen

// ── GizmoController ──────────────────────────────────────────────────────────

class GizmoController {
  constructor() {
    this._group    = null;
    this._elements = [];     // { hitMesh, visuals[], mats[], axis, type, baseColor }
    this._hovered  = null;
    this._dragging = false;
    this._dragEl   = null;
    this._node     = null;
    this._obj3d    = null;
    this._visible  = false;
    this._mode     = 'all';  // 'all' | 'translate' | 'rotate'

    // Drag state (set on pointerdown, used through move)
    this._startOffset = [0, 0, 0];
    this._startQuat   = [0, 0, 0, 1];
    this._startWorld  = null;
    this._startAngle  = 0;
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  init() {
    const T = window.THREE;
    if (!T) return;
    this._group = new T.Group();
    this._group.visible = false;
    sceneCore.overlayScene.add(this._group);
    this._buildGeometry();
    sceneCore.addTickHook(() => this._tick());
  }

  _buildGeometry() {
    const T = window.THREE;

    // ── Translate arrows ────────────────────────────────────────────────────
    // Arrow total reach ~0.97; rings sit at radius 0.55 — no overlap.
    // Hit mesh must be in a wrapper Group so _orientAxis rotates around the
    // gizmo origin (same pattern as visGroup); otherwise position.y offset
    // stays in world-Y after the object rotation, putting X/Z hits in wrong place.
    for (const axis of ['x', 'y', 'z']) {
      const color = AX[axis];

      // ── Visuals ──
      const shaftGeo = new T.CylinderGeometry(0.025, 0.025, 0.72, 8);
      const shaftMat = new T.MeshBasicMaterial({ color, depthTest: false });
      const shaft    = new T.Mesh(shaftGeo, shaftMat);
      shaft.position.y = 0.36;

      const coneGeo  = new T.ConeGeometry(0.065, 0.25, 8);
      const coneMat  = new T.MeshBasicMaterial({ color, depthTest: false });
      const cone     = new T.Mesh(coneGeo, coneMat);
      cone.position.y = 0.845;

      const visGroup = new T.Group();
      visGroup.add(shaft, cone);
      this._orientAxis(visGroup, axis);
      this._group.add(visGroup);

      // ── Hit (tapered: wide at tip, thin at base — same wrapper trick) ──
      // CylinderGeometry(radiusTop, radiusBottom, height):
      //   top = +Y of hitGroup = tip direction after orientation.
      const hitGeo   = new T.CylinderGeometry(0.18, 0.06, 0.97, 8);
      const hitMat   = new T.MeshBasicMaterial({ visible: false, depthTest: false });
      const hit      = new T.Mesh(hitGeo, hitMat);
      hit.position.y = 0.485;          // center inside the wrapper's local Y

      const hitGroup = new T.Group();  // wrapper keeps position offset in local space
      hitGroup.add(hit);
      this._orientAxis(hitGroup, axis);
      this._group.add(hitGroup);

      const el = { hitMesh: hit, visuals: [visGroup], mats: [shaftMat, coneMat], axis, type: 'translate', baseColor: color };
      hit.userData._gEl = el;
      this._elements.push(el);
    }

    // ── Plane handles (XZ, XY, YZ) ─────────────────────────────────────────
    // Separate visual and hit meshes so _applyMode can hide visuals independently.
    const planes = [
      { axis: 'xz', color: AX.y, pos: [0.22, 0, 0.22],    rotX: -Math.PI / 2, rotY: 0 },
      { axis: 'xy', color: AX.z, pos: [0.22, 0.22, 0],    rotX: 0,            rotY: 0 },
      { axis: 'yz', color: AX.x, pos: [0, 0.22, 0.22],    rotX: 0,            rotY: Math.PI / 2 },
    ];
    for (const p of planes) {
      // Visual (colored, semi-transparent)
      const vGeo  = new T.PlaneGeometry(0.20, 0.20);
      const vMat  = new T.MeshBasicMaterial({ color: p.color, side: T.DoubleSide, transparent: true, opacity: 0.65, depthTest: false });
      const vis   = new T.Mesh(vGeo, vMat);
      vis.position.set(...p.pos);
      vis.rotation.x = p.rotX;
      vis.rotation.y = p.rotY;
      this._group.add(vis);

      // Hit mesh (invisible, same size)
      const hGeo  = new T.PlaneGeometry(0.20, 0.20);
      const hMat  = new T.MeshBasicMaterial({ visible: false, side: T.DoubleSide, depthTest: false });
      const hit   = new T.Mesh(hGeo, hMat);
      hit.position.set(...p.pos);
      hit.rotation.x = p.rotX;
      hit.rotation.y = p.rotY;
      this._group.add(hit);

      const el = { hitMesh: hit, visuals: [vis], mats: [vMat], axis: p.axis, type: 'plane', baseColor: p.color };
      hit.userData._gEl = el;
      this._elements.push(el);
    }

    // ── Rotation rings ──────────────────────────────────────────────────────
    // Radius 0.55 — well inside arrow tips (~0.97), clearly visible.
    for (const axis of ['x', 'y', 'z']) {
      const color = AX[axis];

      const geo  = new T.TorusGeometry(0.55, 0.030, 8, 56);
      const mat  = new T.MeshBasicMaterial({ color, depthTest: false });
      const ring = new T.Mesh(geo, mat);
      this._orientRing(ring, axis);
      this._group.add(ring);

      // Hit torus (wider tube for easier grabbing)
      const hitGeo = new T.TorusGeometry(0.55, 0.085, 6, 56);
      const hitMat = new T.MeshBasicMaterial({ visible: false, depthTest: false });
      const hit    = new T.Mesh(hitGeo, hitMat);
      this._orientRing(hit, axis);
      this._group.add(hit);

      const el = { hitMesh: hit, visuals: [ring], mats: [mat], axis, type: 'rotate', baseColor: color };
      hit.userData._gEl = el;
      this._elements.push(el);
    }
  }

  _orientAxis(obj, axis) {
    if (axis === 'x') obj.rotation.z = -Math.PI / 2;
    if (axis === 'z') obj.rotation.x =  Math.PI / 2;
    // y = default (no rotation)
  }

  _orientRing(obj, axis) {
    // TorusGeometry default: lies in XY plane, normal = Z.
    // X ring: normal must be X → rotate around Y by 90°
    // Y ring: normal must be Y → rotate around X by 90° (XY→XZ plane)
    // Z ring: normal must be Z → no rotation (default)
    if (axis === 'x') obj.rotation.y = Math.PI / 2;
    if (axis === 'y') obj.rotation.x = Math.PI / 2;
    // z: no rotation
  }

  // ── Public API ────────────────────────────────────────────────────────────

  show(node, obj3d) {
    if (!this._group) return;
    this._node    = node;
    this._obj3d   = obj3d;
    this._visible = true;
    this._group.visible = true;
    this._mode = 'all';       // always start fresh — mode was left over from G/R keys
    this._applyMode();
    this._tick();
  }

  hide() {
    if (!this._group) return;
    // Restore any element left in hover or drag state before clearing refs
    if (this._hovered) {
      this._setElColor(this._hovered, this._hovered.baseColor);
      this._setElScale(this._hovered, 1.0);
    }
    if (this._dragEl && this._dragEl !== this._hovered) {
      this._setElColor(this._dragEl, this._dragEl.baseColor);
    }
    this._group.visible = false;
    this._visible  = false;
    this._node     = null;
    this._obj3d    = null;
    this._hovered  = null;
    this._dragging = false;
    this._dragEl   = null;
  }

  get isDragging() { return this._dragging; }

  setMode(mode) {
    this._mode = mode;  // 'all' | 'translate' | 'rotate'
    if (this._visible) this._applyMode();
  }

  _applyMode() {
    for (const el of this._elements) {
      const show = this._mode === 'all'
        || (this._mode === 'translate' && (el.type === 'translate' || el.type === 'plane'))
        || (this._mode === 'rotate'    && el.type === 'rotate');
      for (const v of el.visuals) v.visible = show;
      // Hit meshes are invisible by material; raycasting is filtered in _raycastElements.
    }
  }

  // ── Tick (called every frame) ─────────────────────────────────────────────

  _tick() {
    if (!this._visible || !this._obj3d || !this._group) return;
    const T   = window.THREE;
    const pos = new T.Vector3();
    this._obj3d.getWorldPosition(pos);
    this._group.position.copy(pos);

    // Constant screen-space size
    const cam    = sceneCore.camera;
    const dist   = cam.position.distanceTo(pos);
    const fovRad = (cam.fov * Math.PI) / 180;
    const viewH  = 2 * dist * Math.tan(fovRad / 2);
    this._group.scale.setScalar(viewH * SCREEN_SIZE);
  }

  // ── Pointer: hover ────────────────────────────────────────────────────────

  onHover(clientX, clientY) {
    if (!this._visible || this._dragging) return;
    const el = this._raycastElements(clientX, clientY);
    this._setHovered(el);
  }

  // ── Pointer: down / move / up ─────────────────────────────────────────────

  onPointerDown(clientX, clientY) {
    if (!this._visible) return false;
    const el = this._raycastElements(clientX, clientY);
    if (!el) return false;

    this._setHovered(null);
    this._dragging = true;
    this._dragEl   = el;
    this._setElColor(el, ACTIVE_COL);

    // Snapshot for undo
    if (this._node) actions.beginTransformEdit(this._node.id);

    // Capture drag start state
    const T = window.THREE;
    const no = this._node;
    this._startOffset = no?.localOffset       ? [...no.localOffset]       : [0, 0, 0];
    this._startQuat   = no?.localQuaternion   ? [...no.localQuaternion]   : [0, 0, 0, 1];

    const plane = this._getDragPlane(el);
    this._startWorld = this._worldPoint(clientX, clientY, plane);

    if (el.type === 'rotate' && this._startWorld) {
      const center = new T.Vector3();
      this._obj3d.getWorldPosition(center);
      const rel = this._startWorld.clone().sub(center);
      this._startAngle = this._atan2ForAxis(rel, el.axis);
    }

    return true;
  }

  onPointerMove(clientX, clientY) {
    if (!this._dragging || !this._dragEl) return false;
    this._doDrag(clientX, clientY);
    return true;
  }

  onPointerUp() {
    if (!this._dragging) return;
    this._dragging = false;
    if (this._node) actions.commitTransformEdit(this._node.id);
    if (this._dragEl) {
      this._setElColor(this._dragEl, this._dragEl.baseColor);
      this._dragEl = null;
    }
  }

  // ── Drag logic ────────────────────────────────────────────────────────────

  _doDrag(clientX, clientY) {
    const T   = window.THREE;
    const el  = this._dragEl;
    const no  = this._node;
    if (!el || !no || !this._obj3d) return;

    const plane = this._getDragPlane(el);
    const curr  = this._worldPoint(clientX, clientY, plane);
    if (!curr || !this._startWorld) return;

    if (el.type === 'translate') {
      const delta  = curr.clone().sub(this._startWorld);
      const axVec  = this._axisVec(el.axis);
      const amount = delta.dot(axVec);
      no.localOffset = [
        this._startOffset[0] + axVec.x * amount,
        this._startOffset[1] + axVec.y * amount,
        this._startOffset[2] + axVec.z * amount,
      ];
      no.moveEnabled = true;

    } else if (el.type === 'plane') {
      const delta  = curr.clone().sub(this._startWorld);
      const [a, b] = el.axis.split('');
      no.localOffset = [
        this._startOffset[0] + (a === 'x' || b === 'x' ? delta.x : 0),
        this._startOffset[1] + (a === 'y' || b === 'y' ? delta.y : 0),
        this._startOffset[2] + (a === 'z' || b === 'z' ? delta.z : 0),
      ];
      no.moveEnabled = true;

    } else if (el.type === 'rotate') {
      const center = new T.Vector3();
      this._obj3d.getWorldPosition(center);
      const rel        = curr.clone().sub(center);
      const currAngle  = this._atan2ForAxis(rel, el.axis);
      // X and Y axes need delta inverted (right-hand rule vs screen drag direction)
      const rawDelta   = currAngle - this._startAngle;
      const delta      = (el.axis === 'x' || el.axis === 'y') ? -rawDelta : rawDelta;
      const axVec      = this._axisVec(el.axis);
      const deltaQ     = new T.Quaternion().setFromAxisAngle(axVec, delta);
      const baseQ      = new T.Quaternion(this._startQuat[0], this._startQuat[1], this._startQuat[2], this._startQuat[3]);
      const newQ       = deltaQ.multiply(baseQ);
      no.localQuaternion = [newQ.x, newQ.y, newQ.z, newQ.w];
      no.rotateEnabled   = true;
    }

    applyNodeTransformToObject3D(no, this._obj3d, true);
    steps.scheduleSync();
    this._tick();
  }

  // ── Drag plane ────────────────────────────────────────────────────────────

  _getDragPlane(el) {
    const T      = window.THREE;
    const center = this._group.position.clone();
    const camDir = sceneCore.camera.position.clone().sub(center).normalize();

    if (el.type === 'rotate') {
      return new T.Plane().setFromNormalAndCoplanarPoint(this._axisVec(el.axis), center);
    }
    if (el.type === 'plane') {
      const perp = el.axis === 'xz' ? 'y' : el.axis === 'xy' ? 'z' : 'x';
      return new T.Plane().setFromNormalAndCoplanarPoint(this._axisVec(perp), center);
    }
    // Translate along axis: plane containing axis and facing camera
    const ax   = this._axisVec(el.axis);
    const side = new T.Vector3().crossVectors(ax, camDir);
    if (side.lengthSq() < 1e-8) {
      return new T.Plane().setFromNormalAndCoplanarPoint(camDir, center);
    }
    side.normalize();
    const normal = new T.Vector3().crossVectors(ax, side).normalize();
    return new T.Plane().setFromNormalAndCoplanarPoint(normal, center);
  }

  _worldPoint(clientX, clientY, plane) {
    const T    = window.THREE;
    const rect = sceneCore.renderer.domElement.getBoundingClientRect();
    const ptr  = new T.Vector2(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      ((clientY - rect.top)  / rect.height) * -2 + 1,
    );
    const rc  = new T.Raycaster();
    rc.setFromCamera(ptr, sceneCore.camera);
    const hit = new T.Vector3();
    return rc.ray.intersectPlane(plane, hit) ? hit : null;
  }

  // ── Raycasting against gizmo elements ────────────────────────────────────

  _raycastElements(clientX, clientY) {
    if (!this._group) return null;
    const T    = window.THREE;
    const rect = sceneCore.renderer.domElement.getBoundingClientRect();
    const ptr  = new T.Vector2(
      ((clientX - rect.left) / rect.width)  *  2 - 1,
      ((clientY - rect.top)  / rect.height) * -2 + 1,
    );
    const rc = new T.Raycaster();
    rc.setFromCamera(ptr, sceneCore.camera);
    this._group.updateMatrixWorld(true);

    // Only raycast visible-mode elements
    const active = this._elements.filter(e =>
      this._mode === 'all'
      || (this._mode === 'translate' && (e.type === 'translate' || e.type === 'plane'))
      || (this._mode === 'rotate'    &&  e.type === 'rotate')
    );
    const hits = rc.intersectObjects(active.map(e => e.hitMesh), false);
    return hits[0]?.object?.userData?._gEl ?? null;
  }

  // ── Hover highlight ───────────────────────────────────────────────────────

  _setHovered(el) {
    if (this._hovered === el) return;
    if (this._hovered) {
      this._setElColor(this._hovered, this._hovered.baseColor);
      this._setElScale(this._hovered, 1.0);
    }
    this._hovered = el;
    if (el) {
      this._setElColor(el, HOVER_COL);
      this._setElScale(el, 1.3);
    }
  }

  _setElColor(el, hex) {
    for (const m of el.mats) m.color.setHex(hex);
  }

  _setElScale(el, s) {
    if (el.type !== 'plane') return;   // only scale plane handles on hover
    for (const v of el.visuals) v.scale.setScalar(s);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _axisVec(axis) {
    const T = window.THREE;
    if (axis === 'x') return new T.Vector3(1, 0, 0);
    if (axis === 'y') return new T.Vector3(0, 1, 0);
                      return new T.Vector3(0, 0, 1);
  }

  _atan2ForAxis(rel, axis) {
    // Returns the 2-D angle of `rel` projected onto the plane perpendicular to `axis`
    if (axis === 'y') return Math.atan2(rel.z, rel.x);
    if (axis === 'z') return Math.atan2(rel.y, rel.x);
                      return Math.atan2(rel.y, rel.z);  // x axis
  }
}

export const gizmo = new GizmoController();
