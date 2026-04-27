/**
 * SBS — Transform Gizmo
 * ======================
 * Renders in overlayScene (depth-cleared → always on top).
 * Arrows = translate, Rings = rotate, Squares = plane translate.
 *
 * Colors:  X=red  Y=green  Z=blue  hover=yellow  active=white
 * States:  grey(idle) → yellow(hover, +scale) → white(drag)
 *
 * Space modes:
 *   'local'  — gizmo axes align with the parent node's orientation.
 *              Drag and panel inputs operate in parent-local space.
 *   'world'  — gizmo axes align with world axes. Drag deltas are
 *              converted from world space to parent-local before
 *              being stored in localOffset.
 *
 * Integration:
 *   gizmo.init()                   — call once after scene ready
 *   gizmo.show(node, obj3d)        — call on selection change
 *   gizmo.hide()                   — call on deselect / scene clear
 *   gizmo.onHover(x, y)            — call from canvas pointermove (no btn)
 *   gizmo.onPointerDown(x, y) → bool  — true = gizmo consumed event
 *   gizmo.onPointerMove(x, y) → bool  — true = gizmo is dragging
 *   gizmo.onPointerUp()            — commit drag
 *   gizmo.onRightClick(x, y) → bool  — true = gizmo opened panel
 *   gizmo.setMode(m)               — 'all' | 'translate' | 'rotate'
 *   gizmo.toggleSpace()            — cycle 'local' ↔ 'world'
 */

import { sceneCore }  from '../core/scene.js';
import state          from '../core/state.js';
import * as actions   from '../systems/actions.js';
import steps          from '../systems/steps.js';
import {
  applyNodeTransformToObject3D,
  getPivotWorldPosition,
  getPivotWorldQuaternion,
  setNodeLocalRotationPreservePivot,
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
    this._mode     = 'all';        // 'all' | 'translate' | 'rotate'
    this._spaceMode = 'local';     // 'local' | 'world'

    // Drag state (set on pointerdown, used through move)
    this._startOffset = [0, 0, 0];
    this._startQuat   = [0, 0, 0, 1];
    this._startWorld  = null;
    this._startAngle  = 0;

    // Space label DOM element
    this._spaceLabelEl = null;

    // Transform panel DOM element
    this._panel = null;
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
    this._buildSpaceLabel();
  }

  _buildSpaceLabel() {
    // Small on-screen badge showing current space mode
    const el = document.createElement('div');
    el.id = 'gizmo-space-label';
    el.style.cssText = [
      'position:absolute',
      'bottom:54px',
      'left:12px',
      'font-size:11px',
      'font-weight:700',
      'letter-spacing:1px',
      'color:#94a3b8',
      'pointer-events:none',
      'display:none',
      'user-select:none',
    ].join(';');
    el.textContent = 'LOCAL';
    document.getElementById('viewer')?.appendChild(el)
      ?? document.body.appendChild(el);
    this._spaceLabelEl = el;
  }

  _buildGeometry() {
    const T = window.THREE;

    // ── Translate arrows ────────────────────────────────────────────────────
    for (const axis of ['x', 'y', 'z']) {
      const color = AX[axis];

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

      const hitGeo   = new T.CylinderGeometry(0.18, 0.06, 0.97, 8);
      const hitMat   = new T.MeshBasicMaterial({ visible: false, depthTest: false });
      const hit      = new T.Mesh(hitGeo, hitMat);
      hit.position.y = 0.485;

      const hitGroup = new T.Group();
      hitGroup.add(hit);
      this._orientAxis(hitGroup, axis);
      this._group.add(hitGroup);

      const el = { hitMesh: hit, visuals: [visGroup], mats: [shaftMat, coneMat], axis, type: 'translate', baseColor: color };
      hit.userData._gEl = el;
      this._elements.push(el);
    }

    // ── Plane handles (XZ, XY, YZ) ─────────────────────────────────────────
    const planes = [
      { axis: 'xz', color: AX.y, pos: [0.22, 0, 0.22],    rotX: -Math.PI / 2, rotY: 0 },
      { axis: 'xy', color: AX.z, pos: [0.22, 0.22, 0],    rotX: 0,            rotY: 0 },
      { axis: 'yz', color: AX.x, pos: [0, 0.22, 0.22],    rotX: 0,            rotY: Math.PI / 2 },
    ];
    for (const p of planes) {
      const vGeo  = new T.PlaneGeometry(0.20, 0.20);
      const vMat  = new T.MeshBasicMaterial({ color: p.color, side: T.DoubleSide, transparent: true, opacity: 0.65, depthTest: false });
      const vis   = new T.Mesh(vGeo, vMat);
      vis.position.set(...p.pos);
      vis.rotation.x = p.rotX;
      vis.rotation.y = p.rotY;
      this._group.add(vis);

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
    for (const axis of ['x', 'y', 'z']) {
      const color = AX[axis];

      const geo  = new T.TorusGeometry(0.55, 0.030, 8, 56);
      const mat  = new T.MeshBasicMaterial({ color, depthTest: false });
      const ring = new T.Mesh(geo, mat);
      this._orientRing(ring, axis);
      this._group.add(ring);

      const hitGeo = new T.TorusGeometry(0.55, 0.085, 6, 56);
      const hitMat = new T.MeshBasicMaterial({ visible: false, depthTest: false });
      const hit    = new T.Mesh(hitGeo, hitMat);
      this._orientRing(hit, axis);
      this._group.add(hit);

      const el = { hitMesh: hit, visuals: [ring], mats: [mat], axis, type: 'rotate', baseColor: color };
      hit.userData._gEl = el;
      this._elements.push(el);
    }

    // ── P-P1: pivot-edit indicator (orange dot at gizmo hub) ──────────────
    // Visible only while in RED mode (state.pivotEditNodeId === active node).
    // Sits at the gizmo's local origin so it lands on the pivot world point.
    // Not raycastable — it's a status badge, not a draggable handle.
    const dotGeo = new T.SphereGeometry(0.07, 16, 16);
    const dotMat = new T.MeshBasicMaterial({ color: 0xff8c1a, depthTest: false });
    const dot    = new T.Mesh(dotGeo, dotMat);
    dot.visible  = false;
    this._group.add(dot);
    this._pivotDot = dot;
  }

  _orientAxis(obj, axis) {
    if (axis === 'x') obj.rotation.z = -Math.PI / 2;
    if (axis === 'z') obj.rotation.x =  Math.PI / 2;
  }

  _orientRing(obj, axis) {
    if (axis === 'x') obj.rotation.y = Math.PI / 2;
    if (axis === 'y') obj.rotation.x = Math.PI / 2;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  show(node, obj3d) {
    if (!this._group) return;
    this._node    = node;
    this._obj3d   = obj3d;
    this._visible = true;
    this._group.visible = true;
    this._mode = 'all';
    this._applyMode();
    this._tick();
    if (this._spaceLabelEl) this._spaceLabelEl.style.display = '';
    this._updateSpaceLabel();
  }

  hide() {
    if (!this._group) return;
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
    if (this._spaceLabelEl) this._spaceLabelEl.style.display = 'none';
    this._closePanel();
  }

  get isDragging() { return this._dragging; }

  get spaceMode() { return this._spaceMode; }

  setMode(mode) {
    this._mode = mode;
    if (this._visible) this._applyMode();
  }

  /**
   * Set the gizmo's space mode explicitly.
   * @param {'local'|'world'} mode
   */
  setSpace(mode) {
    this._spaceMode = mode;
    if (this._visible) {
      this._tick();
      this._updateSpaceLabel();
    }
    // Refresh panel if open
    if (this._panel) this._refreshPanel();
  }

  /**
   * Toggle between 'local' and 'world' space modes.
   */
  toggleSpace() {
    this.setSpace(this._spaceMode === 'local' ? 'world' : 'local');
  }

  _updateSpaceLabel() {
    if (!this._spaceLabelEl) return;
    this._spaceLabelEl.textContent = this._spaceMode === 'local' ? 'LOCAL' : 'WORLD';
    this._spaceLabelEl.style.color = this._spaceMode === 'local' ? '#60a5fa' : '#94a3b8';
  }

  _applyMode() {
    for (const el of this._elements) {
      const show = this._mode === 'all'
        || (this._mode === 'translate' && (el.type === 'translate' || el.type === 'plane'))
        || (this._mode === 'rotate'    && el.type === 'rotate');
      for (const v of el.visuals) v.visible = show;
    }
  }

  // ── Tick (called every frame) ─────────────────────────────────────────────

  _tick() {
    if (!this._visible || !this._obj3d || !this._group) return;
    const T   = window.THREE;

    // P-P1: pivot mode awareness.
    //   GREY (pivotEnabled=false)   → gizmo at object world origin (default).
    //   RED  (this node is in edit) → gizmo at pivot world pose; orange dot ON.
    //   BLUE (pivotEnabled, no edit)→ gizmo at pivot world pose; orange dot OFF.
    const node           = this._node;
    const pivotEnabled   = node?.pivotEnabled === true;
    const isPivotEditing = node && state.get('pivotEditNodeId') === node.id;
    const usePivotPose   = pivotEnabled || isPivotEditing;

    const pos = new T.Vector3();
    if (usePivotPose) {
      pos.copy(getPivotWorldPosition(node, this._obj3d));
    } else {
      this._obj3d.getWorldPosition(pos);
    }
    this._group.position.copy(pos);

    // Orient gizmo: local mode = parent's world orientation (or pivot's
    // world orientation when in pivot mode), world mode = identity.
    if (this._spaceMode === 'local') {
      if (usePivotPose) {
        this._group.quaternion.copy(getPivotWorldQuaternion(node, this._obj3d));
      } else {
        const pq = this._parentWorldQuat();
        if (pq) this._group.quaternion.copy(pq);
        else    this._group.quaternion.identity();
      }
    } else {
      this._group.quaternion.identity();
    }

    // Orange dot at gizmo hub — only while editing the pivot.
    if (this._pivotDot) this._pivotDot.visible = isPivotEditing;

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

    // P-P1: in pivot edit mode (RED) the parent enterPivotEdit/commitPivotEdit
    // pair already brackets the undo session — skip beginTransformEdit so we
    // don't push a redundant "Transform" entry during the gesture.
    const inPivotEdit = !!this._node && state.get('pivotEditNodeId') === this._node.id;
    if (this._node && !inPivotEdit) actions.beginTransformEdit(this._node.id);

    const T = window.THREE;
    const no = this._node;
    this._startOffset      = no?.localOffset           ? [...no.localOffset]           : [0, 0, 0];
    this._startQuat        = no?.localQuaternion       ? [...no.localQuaternion]       : [0, 0, 0, 1];
    // Pivot start values for RED-mode drags (writes to pivot fields).
    this._startPivotOffset = no?.pivotLocalOffset      ? [...no.pivotLocalOffset]      : [0, 0, 0];
    this._startPivotQuat   = no?.pivotLocalQuaternion  ? [...no.pivotLocalQuaternion]  : [0, 0, 0, 1];

    const plane = this._getDragPlane(el);
    this._startWorld = this._worldPoint(clientX, clientY, plane);

    if (el.type === 'rotate' && this._startWorld) {
      // Rotation centre depends on mode:
      //   RED / BLUE pivot rotate → rotate around pivot world point
      //   GREY                    → rotate around object origin
      const center = (inPivotEdit || (no?.pivotEnabled === true))
        ? getPivotWorldPosition(no, this._obj3d)
        : new T.Vector3().copy(this._obj3d.getWorldPosition(new T.Vector3()));
      const rel = this._startWorld.clone().sub(center);
      this._startAngle = this._atan2ForAxisInSpace(rel, el.axis);
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
    // P-P1: skip commitTransformEdit while in pivot edit — the
    // pivot session covers undo for the whole RED→BLUE gesture.
    const inPivotEdit = !!this._node && state.get('pivotEditNodeId') === this._node.id;
    if (this._node && !inPivotEdit) actions.commitTransformEdit(this._node.id);
    if (this._dragEl) {
      this._setElColor(this._dragEl, this._dragEl.baseColor);
      this._dragEl = null;
    }
    // Refresh panel values after drag ends
    if (this._panel) this._refreshPanel();
  }

  /**
   * Called from canvas contextmenu handler.
   * Returns true if the gizmo consumed the event (opened the panel).
   */
  onRightClick(clientX, clientY) {
    if (!this._visible) return false;
    const el = this._raycastElements(clientX, clientY);
    if (!el) return false;
    this._showTransformPanel(clientX, clientY);
    return true;
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

    // P-P1: three drag modes.
    //   RED  (state.pivotEditNodeId === node.id)
    //         → drag writes pivotLocalOffset / pivotLocalQuaternion;
    //           geometry untouched, only the gizmo's pivot pose moves.
    //   BLUE (no.pivotEnabled, not editing) + rotate
    //         → use setNodeLocalRotationPreservePivot so the pivot world
    //           point stays fixed while the geometry orbits around it.
    //   else → original behaviour (write localOffset / localQuaternion).
    const inPivotEdit  = state.get('pivotEditNodeId') === no.id;
    const pivotEnabled = no.pivotEnabled === true;

    if (inPivotEdit && el.type === 'translate') {
      // Pivot is in OBJECT-LOCAL space; convert world delta via inverse
      // object world quaternion.
      const delta   = curr.clone().sub(this._startWorld);
      const axVec   = this._axisVec(el.axis);
      const amount  = delta.dot(axVec);
      const worldD  = axVec.clone().multiplyScalar(amount);
      const localD  = this._worldToObjectLocalDelta(worldD);
      no.pivotLocalOffset = [
        this._startPivotOffset[0] + localD.x,
        this._startPivotOffset[1] + localD.y,
        this._startPivotOffset[2] + localD.z,
      ];
      no.pivotEnabled = true;
      // Geometry doesn't move — but the gizmo position needs an update.
      this._tick();
      return;
    }

    if (inPivotEdit && el.type === 'plane') {
      const delta   = curr.clone().sub(this._startWorld);
      const [a, b]  = el.axis.split('');
      const axA     = this._axisVec(a);
      const axB     = this._axisVec(b);
      const worldD  = axA.clone().multiplyScalar(delta.dot(axA))
                        .add(axB.clone().multiplyScalar(delta.dot(axB)));
      const localD  = this._worldToObjectLocalDelta(worldD);
      no.pivotLocalOffset = [
        this._startPivotOffset[0] + localD.x,
        this._startPivotOffset[1] + localD.y,
        this._startPivotOffset[2] + localD.z,
      ];
      no.pivotEnabled = true;
      this._tick();
      return;
    }

    if (inPivotEdit && el.type === 'rotate') {
      // Rotate the pivot's local frame around its OWN axis (gizmo is at
      // pivot world pose, so axis 'x'/'y'/'z' = pivot's local x/y/z).
      const center = getPivotWorldPosition(no, this._obj3d);
      const rel       = curr.clone().sub(center);
      const currAngle = this._atan2ForAxisInSpace(rel, el.axis);
      const rawDelta  = currAngle - this._startAngle;
      const angle     = (el.axis === 'x' || el.axis === 'y') ? -rawDelta : rawDelta;
      const localAxis = el.axis === 'x' ? new T.Vector3(1, 0, 0)
                      : el.axis === 'y' ? new T.Vector3(0, 1, 0)
                                        : new T.Vector3(0, 0, 1);
      const deltaQ = new T.Quaternion().setFromAxisAngle(localAxis, angle);
      const startQ = new T.Quaternion(
        this._startPivotQuat[0], this._startPivotQuat[1], this._startPivotQuat[2], this._startPivotQuat[3],
      );
      const newQ = startQ.clone().multiply(deltaQ);
      no.pivotLocalQuaternion = [newQ.x, newQ.y, newQ.z, newQ.w];
      no.pivotEnabled = true;
      this._tick();
      return;
    }

    // ── Non-pivot-edit paths (default + BLUE rotate) ──────────────────────

    if (el.type === 'translate') {
      const delta   = curr.clone().sub(this._startWorld);
      const axVec   = this._axisVec(el.axis);
      const amount  = delta.dot(axVec);
      const worldD  = axVec.clone().multiplyScalar(amount);
      const localD  = this._worldToLocalDelta(worldD);
      no.localOffset = [
        this._startOffset[0] + localD.x,
        this._startOffset[1] + localD.y,
        this._startOffset[2] + localD.z,
      ];
      no.moveEnabled = true;

    } else if (el.type === 'plane') {
      const delta   = curr.clone().sub(this._startWorld);
      const [a, b]  = el.axis.split('');
      const axA     = this._axisVec(a);
      const axB     = this._axisVec(b);
      const worldD  = axA.clone().multiplyScalar(delta.dot(axA))
                        .add(axB.clone().multiplyScalar(delta.dot(axB)));
      const localD  = this._worldToLocalDelta(worldD);
      no.localOffset = [
        this._startOffset[0] + localD.x,
        this._startOffset[1] + localD.y,
        this._startOffset[2] + localD.z,
      ];
      no.moveEnabled = true;

    } else if (el.type === 'rotate') {
      // Rotation centre: pivot in BLUE mode, object origin otherwise.
      const center = pivotEnabled
        ? getPivotWorldPosition(no, this._obj3d)
        : new T.Vector3().copy(this._obj3d.getWorldPosition(new T.Vector3()));
      const rel       = curr.clone().sub(center);
      const currAngle = this._atan2ForAxisInSpace(rel, el.axis);
      const rawDelta  = currAngle - this._startAngle;
      const delta     = (el.axis === 'x' || el.axis === 'y') ? -rawDelta : rawDelta;
      const rotAxis   = this._rotAxisLocal(el.axis);
      const deltaQ    = new T.Quaternion().setFromAxisAngle(rotAxis, delta);
      const baseQ     = new T.Quaternion(this._startQuat[0], this._startQuat[1], this._startQuat[2], this._startQuat[3]);
      const newQ      = deltaQ.multiply(baseQ);

      if (pivotEnabled) {
        // BLUE rotate — back-solve localOffset so pivot world stays fixed.
        // setNodeLocalRotationPreservePivot writes BOTH localQuaternion and
        // localOffset on the node, so we don't touch them ourselves.
        setNodeLocalRotationPreservePivot(no, [newQ.x, newQ.y, newQ.z, newQ.w]);
      } else {
        no.localQuaternion = [newQ.x, newQ.y, newQ.z, newQ.w];
        no.rotateEnabled   = true;
      }
    }

    applyNodeTransformToObject3D(no, this._obj3d, true);
    steps.scheduleSync();
    this._tick();
  }

  /**
   * World-delta → OBJECT-LOCAL delta (used when writing pivot offset,
   * which is stored in object-local space). Different from
   * _worldToLocalDelta which targets PARENT-local for localOffset.
   */
  _worldToObjectLocalDelta(worldDelta) {
    const T = window.THREE;
    if (!this._obj3d) return worldDelta.clone();
    const oq = new T.Quaternion();
    this._obj3d.getWorldQuaternion(oq);
    return worldDelta.clone().applyQuaternion(oq.invert());
  }

  // ── Space helpers ─────────────────────────────────────────────────────────

  /**
   * Get the parent's world quaternion, or null if no parent or identity parent.
   */
  _parentWorldQuat() {
    const T = window.THREE;
    const parent = this._obj3d?.parent;
    if (!parent) return null;
    const q = new T.Quaternion();
    parent.getWorldQuaternion(q);
    return q;
  }

  /**
   * Return the axis vector for 'x'|'y'|'z' in WORLD space.
   * In 'local' mode: rotate the local axis by the GIZMO'S reference
   * world quaternion — that's the pivot's frame in pivot mode (RED or
   * BLUE), parent's frame otherwise. Keeps gizmo handles aligned with
   * what the user sees.
   * In 'world' mode: return the world-aligned unit vector.
   */
  _axisVec(axis) {
    const T = window.THREE;
    let v;
    if (axis === 'x')      v = new T.Vector3(1, 0, 0);
    else if (axis === 'y') v = new T.Vector3(0, 1, 0);
    else                   v = new T.Vector3(0, 0, 1);

    if (this._spaceMode === 'local') {
      const refQ = this._gizmoReferenceQuat();
      if (refQ) v.applyQuaternion(refQ);
    }
    return v;
  }

  /**
   * The gizmo's current reference world quaternion. Drives _axisVec +
   * the orientation set in _tick. RED / BLUE mode → pivot world quat;
   * GREY → parent world quat.
   */
  _gizmoReferenceQuat() {
    if (!this._node || !this._obj3d) return this._parentWorldQuat();
    const inPivotMode = this._node.pivotEnabled === true
      || state.get('pivotEditNodeId') === this._node.id;
    if (inPivotMode) return getPivotWorldQuaternion(this._node, this._obj3d);
    return this._parentWorldQuat();
  }

  /**
   * Convert a world-space delta vector to parent-local space.
   * Uses the inverse of the parent's world quaternion.
   */
  _worldToLocalDelta(worldDelta) {
    const T = window.THREE;
    const parent = this._obj3d?.parent;
    if (!parent) return worldDelta.clone();
    const pq = new T.Quaternion();
    parent.getWorldQuaternion(pq);
    return worldDelta.clone().applyQuaternion(pq.invert());
  }

  /**
   * Return the rotation axis in PARENT-LOCAL space (for storing in localQuaternion).
   *
   * The world axis the user is rotating around comes from _axisVec (which
   * is already pivot-aware and space-mode-aware). To store the rotation
   * delta in parent-local — which is the frame node.localQuaternion lives
   * in — we just convert that world axis through the parent's inverse
   * world quaternion.
   *
   * Without this fix, a pivot with its own orientation made the ring
   * visually point one way but rotate around the parent's axis instead
   * of the pivot's.
   */
  _rotAxisLocal(axis) {
    const T = window.THREE;
    const worldAxis = this._axisVec(axis);   // pivot-aware in pivot mode + local
    const parent = this._obj3d?.parent;
    if (parent) {
      const pq = new T.Quaternion();
      parent.getWorldQuaternion(pq);
      worldAxis.applyQuaternion(pq.invert());
    }
    return worldAxis;
  }

  /**
   * Compute the 2-D angle of `rel` projected onto the plane perpendicular
   * to the gizmo's reference axis. In normal mode the reference is the
   * parent-aligned frame; in pivot mode (RED or BLUE) the reference is
   * the pivot frame, so the angle is measured in the same plane the
   * user sees the rotation ring drawn on.
   */
  _atan2ForAxisInSpace(rel, axis) {
    const T = window.THREE;
    let r = rel.clone();
    const refQ = this._gizmoReferenceQuat();
    if (refQ) r.applyQuaternion(refQ.clone().invert());
    return this._atan2ForAxis(r, axis);
  }

  _atan2ForAxis(rel, axis) {
    if (axis === 'y') return Math.atan2(rel.z, rel.x);
    if (axis === 'z') return Math.atan2(rel.y, rel.x);
                      return Math.atan2(rel.y, rel.z);  // x
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

  // ── Raycasting ────────────────────────────────────────────────────────────

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
    if (el.type !== 'plane') return;
    for (const v of el.visuals) v.scale.setScalar(s);
  }

  // ── Transform Panel ───────────────────────────────────────────────────────

  /**
   * Show a floating transform input panel near the right-click position.
   */
  _showTransformPanel(clientX, clientY) {
    this._closePanel();

    const T  = window.THREE;
    const no = this._node;
    const obj = this._obj3d;
    if (!no || !obj) return;

    const panel = document.createElement('div');
    this._panel = panel;

    panel.style.cssText = [
      'position:fixed',
      `left:${clientX + 12}px`,
      `top:${clientY - 8}px`,
      'z-index:9999',
      'background:#1e293b',
      'border:1px solid #334155',
      'border-radius:8px',
      'padding:12px 14px',
      'min-width:220px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
      'font-size:12px',
      'color:#e2e8f0',
      'user-select:none',
    ].join(';');

    panel.innerHTML = this._panelHTML();
    document.body.appendChild(panel);

    this._wirePanel(panel, no, obj);

    // Nudge panel into viewport
    requestAnimationFrame(() => {
      const r = panel.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      if (r.right  > vw - 8) panel.style.left = `${vw - r.width  - 8}px`;
      if (r.bottom > vh - 8) panel.style.top  = `${vh - r.height - 8}px`;
    });

    // Close on outside click or Escape
    const onDown = (e) => {
      if (!panel.contains(e.target)) this._closePanel();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') this._closePanel();
    };
    setTimeout(() => {
      document.addEventListener('pointerdown', onDown, { capture: true, once: false });
      document.addEventListener('keydown', onKey, { once: true });
      panel._cleanup = () => {
        document.removeEventListener('pointerdown', onDown, { capture: true });
        document.removeEventListener('keydown', onKey);
      };
    }, 0);
  }

  _panelHTML() {
    const no = this._node;
    if (!no) return '';

    // Position = localOffset (user-applied offset in parent-local space)
    const [ox, oy, oz] = no.localOffset ?? [0, 0, 0];
    const fmt = v => parseFloat(v.toFixed(4));

    // Rotation = Euler from localQuaternion in degrees
    const [ex, ey, ez] = this._quatToEulerDeg(no.localQuaternion ?? [0, 0, 0, 1]);
    const fmtA = v => parseFloat(v.toFixed(2));

    const spaceLocal = this._spaceMode === 'local';

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-weight:700;font-size:13px;color:#f1f5f9;">Transform</span>
        <div style="display:flex;gap:4px;">
          <button data-space="local"  style="${this._spaceBtn(spaceLocal)}">LOCAL</button>
          <button data-space="world"  style="${this._spaceBtn(!spaceLocal)}">WORLD</button>
        </div>
      </div>

      <div style="margin-bottom:8px;">
        <div style="font-size:10px;color:#64748b;margin-bottom:4px;letter-spacing:0.5px;">TRANSLATE (offset)</div>
        ${this._axisRow('tx', 'X', fmt(ox), '#e05555')}
        ${this._axisRow('ty', 'Y', fmt(oy), '#55cc55')}
        ${this._axisRow('tz', 'Z', fmt(oz), '#5588e0')}
      </div>

      <div>
        <div style="font-size:10px;color:#64748b;margin-bottom:4px;letter-spacing:0.5px;">ROTATE (°)</div>
        ${this._axisRow('rx', 'X', fmtA(ex), '#e05555')}
        ${this._axisRow('ry', 'Y', fmtA(ey), '#55cc55')}
        ${this._axisRow('rz', 'Z', fmtA(ez), '#5588e0')}
      </div>

      <div style="margin-top:10px;display:flex;justify-content:flex-end;">
        <button data-action="reset" style="font-size:11px;padding:3px 8px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#94a3b8;cursor:pointer;">↺ Reset</button>
      </div>
    `;
  }

  _spaceBtn(active) {
    return [
      'font-size:10px',
      'padding:3px 7px',
      'border-radius:4px',
      'cursor:pointer',
      'font-weight:700',
      'letter-spacing:0.5px',
      `background:${active ? '#1d4ed8' : '#0f172a'}`,
      `border:1px solid ${active ? '#3b82f6' : '#334155'}`,
      `color:${active ? '#eff6ff' : '#64748b'}`,
    ].join(';');
  }

  _axisRow(id, label, value, color) {
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="color:${color};font-weight:700;width:12px;flex-shrink:0;">${label}</span>
        <input data-field="${id}" type="number" value="${value}" step="0.01"
          style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:4px;
                 color:#e2e8f0;padding:3px 6px;font-size:12px;outline:none;width:0;" />
      </div>`;
  }

  _wirePanel(panel, no, obj) {
    // Space toggle buttons
    panel.querySelectorAll('[data-space]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.setSpace(btn.dataset.space);
        // Re-render panel in place
        const pos = { left: panel.style.left, top: panel.style.top };
        this._closePanel();
        this._showTransformPanel(
          parseInt(pos.left) - 12,
          parseInt(pos.top)  + 8
        );
      });
    });

    // Reset button
    panel.querySelector('[data-action="reset"]')?.addEventListener('click', () => {
      actions.beginTransformEdit(no.id);
      no.localOffset     = [0, 0, 0];
      no.localQuaternion = [0, 0, 0, 1];
      no.moveEnabled     = false;
      no.rotateEnabled   = false;
      applyNodeTransformToObject3D(no, obj, true);
      actions.commitTransformEdit(no.id);
      steps.scheduleTransformSync();
      this._refreshPanel();
    });

    // Numeric inputs — live update on change and arrow-key increment
    panel.querySelectorAll('[data-field]').forEach(inp => {
      const field = inp.dataset.field;

      const apply = () => {
        const val = parseFloat(inp.value);
        if (isNaN(val)) return;
        this._applyPanelValue(field, val, no, obj);
        steps.scheduleTransformSync();
        this._tick();
      };

      inp.addEventListener('focus', () => actions.beginTransformEdit(no.id));
      inp.addEventListener('blur',  () => { apply(); actions.commitTransformEdit(no.id); });
      inp.addEventListener('input', apply);

      // Stop propagation so arrow keys don't navigate steps while editing
      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { inp.blur(); }
      });
    });
  }

  _applyPanelValue(field, val, no, obj) {
    const off = [...(no.localOffset ?? [0, 0, 0])];

    if (field === 'tx') { off[0] = val; no.localOffset = off; no.moveEnabled = true; }
    if (field === 'ty') { off[1] = val; no.localOffset = off; no.moveEnabled = true; }
    if (field === 'tz') { off[2] = val; no.localOffset = off; no.moveEnabled = true; }

    if (field === 'rx' || field === 'ry' || field === 'rz') {
      // Read current Euler in degrees, update one axis, convert back to quaternion
      const [ex, ey, ez] = this._quatToEulerDeg(no.localQuaternion ?? [0, 0, 0, 1]);
      const nx = field === 'rx' ? val : ex;
      const ny = field === 'ry' ? val : ey;
      const nz = field === 'rz' ? val : ez;
      const q  = this._eulerDegToQuat(nx, ny, nz);
      no.localQuaternion = [q.x, q.y, q.z, q.w];
      no.rotateEnabled   = true;
    }

    applyNodeTransformToObject3D(no, obj, true);
  }

  /**
   * Re-render current values into open panel without recreating it.
   */
  _refreshPanel() {
    if (!this._panel || !this._node) return;
    const no = this._node;

    const [ox, oy, oz] = no.localOffset ?? [0, 0, 0];
    const [ex, ey, ez] = this._quatToEulerDeg(no.localQuaternion ?? [0, 0, 0, 1]);
    const fmt  = v => parseFloat(v.toFixed(4));
    const fmtA = v => parseFloat(v.toFixed(2));

    const setVal = (id, v) => {
      const el = this._panel.querySelector(`[data-field="${id}"]`);
      if (el && document.activeElement !== el) el.value = v;
    };
    setVal('tx', fmt(ox)); setVal('ty', fmt(oy)); setVal('tz', fmt(oz));
    setVal('rx', fmtA(ex)); setVal('ry', fmtA(ey)); setVal('rz', fmtA(ez));

    // Update space buttons
    const spaceLocal = this._spaceMode === 'local';
    this._panel.querySelector('[data-space="local"]')?.setAttribute('style', this._spaceBtn(spaceLocal));
    this._panel.querySelector('[data-space="world"]')?.setAttribute('style', this._spaceBtn(!spaceLocal));
  }

  _closePanel() {
    if (!this._panel) return;
    this._panel._cleanup?.();
    this._panel.remove();
    this._panel = null;
  }

  // ── Euler / Quaternion helpers ────────────────────────────────────────────

  _quatToEulerDeg(qArr) {
    const T = window.THREE;
    if (!T) return [0, 0, 0];
    const q = new T.Quaternion(qArr[0], qArr[1], qArr[2], qArr[3]).normalize();
    const e = new T.Euler().setFromQuaternion(q, 'XYZ');
    const r2d = 180 / Math.PI;
    return [e.x * r2d, e.y * r2d, e.z * r2d];
  }

  _eulerDegToQuat(dx, dy, dz) {
    const T = window.THREE;
    const d2r = Math.PI / 180;
    const e = new T.Euler(dx * d2r, dy * d2r, dz * d2r, 'XYZ');
    return new T.Quaternion().setFromEuler(e);
  }
}

export const gizmo = new GizmoController();
