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
  captureTransformSnapshot,
  applyTransformSnapshot,
} from '../core/transforms.js';
import { parseExpression } from './gizmo-numeric.js';

// ── Constants ────────────────────────────────────────────────────────────────
const AX  = { x: 0xe05555, y: 0x55cc55, z: 0x5588e0 };
const HOVER_COL  = 0xffee22;
const ACTIVE_COL = 0xffffff;
const SCREEN_SIZE = 0.16;   // gizmo = 16% of view height, constant on screen

// Scale-handle drag tuning. Screen-space drag in pixels: every
// SCALE_PIXELS_PER_DOUBLING up = ×2 scale; same magnitude down = ÷2.
// Clamped so a hard drag can't push scale to zero or runaway.
const SCALE_PIXELS_PER_DOUBLING = 200;
const SCALE_FACTOR_MIN = 0.05;
const SCALE_FACTOR_MAX = 20;

/**
 * Map a screen-space drag (start clientY → current clientY) onto a
 * positive multiplicative scale factor. UP = grow, DOWN = shrink.
 * Symmetric in log space (drag up by N px and back down by N px = ×1).
 */
function _factorFromScreenDy(startY, currY) {
  const dy = currY - startY;             // positive = drag DOWN (browser y-axis)
  const stops = -dy / SCALE_PIXELS_PER_DOUBLING;
  const factor = Math.pow(2, stops);
  return Math.max(SCALE_FACTOR_MIN, Math.min(SCALE_FACTOR_MAX, factor));
}

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
    this._spaceMode = 'local';     // 'local' | 'world' | 'pivot'

    // Drag state (set on pointerdown, used through move)
    this._startOffset = [0, 0, 0];
    this._startQuat   = [0, 0, 0, 1];
    this._startWorld  = null;
    this._startAngle  = 0;

    // C5-B: cable-point target. Non-null when the gizmo is following a
    // selected cable point instead of a tree node. Shape:
    //   { cableId, nodeId, getWorldPos(): THREE.Vector3,
    //     beginMove(), applyDelta(worldDelta), commitMove() }
    // _node remains null in this mode and _obj3d points to a hidden
    // stand-in Object3D positioned at the target's world pos each tick
    // — this lets the rest of the gizmo code (which dereferences _obj3d
    // for getWorldPosition) work unchanged. Translate writes are routed
    // through target.applyDelta in _doDrag instead of node.localOffset.
    this._cableTarget    = null;
    this._cableStandIn   = null;   // hidden THREE.Object3D — see init()

    // Space label DOM element
    this._spaceLabelEl = null;

    // Transform panel DOM element
    this._panel = null;

    // Numeric-input integration (driven by ui/gizmo-numeric.js).
    // _numericLock = true → _doDrag bails out, mouse drag is suspended
    // and only typed values apply via applyNumericAmount().
    // _onDragEvent = optional listener fired on start / move / end with
    // a payload describing the active axis + current amount(s) for the
    // status-bar live readout.
    this._numericLock = false;
    this._onDragEvent = null;   // (kind, payload) => void
    this._lastAmount  = null;   // last computed amount(s) for readout
    this._dragMoved   = false;  // true once cursor moved during drag
  }

  // ── Numeric-input bridge ──────────────────────────────────────────────────

  /**
   * Subscribe to gizmo drag events. kind is 'start' | 'move' | 'end'.
   * payload = { type, axis, value: number | { a, b }, node }.
   * Used by gizmo-numeric.js for live status readout + numeric mode.
   */
  setDragListener(fn) { this._onDragEvent = fn || null; }

  /**
   * Snapshot of the active drag for external code.
   * Returns null when no drag is active.
   */
  getActiveDrag() {
    if (!this._dragging || !this._dragEl) return null;
    return {
      type: this._dragEl.type,
      axis: this._dragEl.axis,
      node: this._node,
      locked: !!this._numericLock,
    };
  }

  /**
   * Set whether _doDrag is suspended (true while the user is typing
   * a numeric value during a drag). When unlocked, mouse drag resumes.
   */
  setNumericLock(locked) { this._numericLock = !!locked; }

  /**
   * Apply an absolute axis value from the pre-drag origin.
   *   translate axis (mm) → offset = startOffset + axisVec*value
   *   rotate    axis (deg) → quat   = startQuat ∘ axis-angle(value)
   * Plane handles + cable mode are not supported (return false).
   * Returns true if the value was applied.
   */
  applyNumericAmount(value) {
    if (!this._dragging || !this._dragEl || !this._obj3d) return false;
    if (!Number.isFinite(value)) return false;
    // V0.3.0.164 — numeric entry now works for cable targets (point / socket /
    // group). Replicates the cable drag-apply axis math with the typed amount:
    // translate value = world units along the axis; rotate value = degrees. The
    // cumulative-from-start apply keeps it idempotent, so revertToDragStart's
    // applyNumericAmount(0) cleanly returns to the pre-drag pose.
    if (this._cableTarget) {
      const cel = this._dragEl;
      if (cel.type === 'translate') {
        const worldD = this._axisVec(cel.axis).clone().multiplyScalar(value);
        this._cableTarget.applyCumulativeDelta(worldD);
        this._lastAmount = value;
        return true;
      }
      if (cel.type === 'rotate' && this._cableTarget.applyRotateAroundAxis) {
        const rad    = (value * Math.PI) / 180;
        const signed = (cel.axis === 'x' || cel.axis === 'y') ? -rad : rad;
        this._cableTarget.applyRotateAroundAxis(this._axisVec(cel.axis), signed);
        this._lastAmount = value;
        return true;
      }
      return false;   // plane numeric unsupported for cable targets
    }
    const el = this._dragEl;
    const no = this._node;
    // 'plane' has two-axis input that needs a different field; 'scale'
    // currently only accepts mouse-drag input. Both bail out of numeric.
    if (!no || el.type === 'plane' || el.type === 'scale') return false;

    const T = window.THREE;
    const inPivotEdit       = state.get('pivotEditNodeId')      === no.id;
    const inGlobalEdit = state.get('globalEditNodeId') === no.id;
    const pivotEnabled = no.pivotEnabled === true;

    if (el.type === 'translate') {
      const axVec  = this._axisVec(el.axis);
      const worldD = axVec.clone().multiplyScalar(value);
      if (inPivotEdit) {
        const localD = this._worldToObjectLocalDelta(worldD);
        no.pivotLocalOffset = [
          this._startPivotOffset[0] + localD.x,
          this._startPivotOffset[1] + localD.y,
          this._startPivotOffset[2] + localD.z,
        ];
        no.pivotEnabled = true;
      } else if (inGlobalEdit) {
        const localD = this._worldToLocalDelta(worldD);
        no.baseLocalPosition = [
          this._startBasePosition[0] + localD.x,
          this._startBasePosition[1] + localD.y,
          this._startBasePosition[2] + localD.z,
        ];
      } else {
        const localD = this._worldToLocalDelta(worldD);
        no.localOffset = [
          this._startOffset[0] + localD.x,
          this._startOffset[1] + localD.y,
          this._startOffset[2] + localD.z,
        ];
        no.moveEnabled = true;
      }
    } else if (el.type === 'rotate') {
      // Match _doDrag's negation convention so typed values produce
      // the same visual rotation direction as mouse drag (and the
      // readout). For X / Y rings, internal angle = -typed; for Z,
      // internal = typed. Without this, typing '90' rotated the
      // mesh OPPOSITE to where the mouse had been moving.
      const signed = (el.axis === 'x' || el.axis === 'y') ? -value : value;
      const angle  = signed * Math.PI / 180;
      const baseQ  = new T.Quaternion(
        this._startQuat[0], this._startQuat[1], this._startQuat[2], this._startQuat[3]
      );
      if (inPivotEdit) {
        const localAxis = el.axis === 'x' ? new T.Vector3(1, 0, 0)
                       : el.axis === 'y' ? new T.Vector3(0, 1, 0)
                                         : new T.Vector3(0, 0, 1);
        const deltaQ = new T.Quaternion().setFromAxisAngle(localAxis, angle);
        const startQ = new T.Quaternion(
          this._startPivotQuat[0], this._startPivotQuat[1], this._startPivotQuat[2], this._startPivotQuat[3]
        );
        const newQ = startQ.clone().multiply(deltaQ);
        no.pivotLocalQuaternion = [newQ.x, newQ.y, newQ.z, newQ.w];
        no.pivotEnabled = true;
      } else {
        const rotAxis = this._rotAxisLocal(el.axis);
        const deltaQ  = new T.Quaternion().setFromAxisAngle(rotAxis, angle);
        const newQ    = deltaQ.multiply(baseQ);
        if (pivotEnabled) {
          setNodeLocalRotationPreservePivot(no, [newQ.x, newQ.y, newQ.z, newQ.w]);
        } else {
          no.localQuaternion = [newQ.x, newQ.y, newQ.z, newQ.w];
          no.rotateEnabled   = true;
        }
      }
    }

    applyNodeTransformToObject3D(no, this._obj3d, true);
    steps.scheduleSync();
    this._tick();
    this._lastAmount = value;
    if (this._onDragEvent) this._onDragEvent('move', { type: el.type, axis: el.axis, value, node: no, source: 'numeric' });
    return true;
  }

  /**
   * Restore the pre-drag transform. Used by Esc in numeric input mode.
   */
  revertToDragStart() {
    if (!this._dragging || !this._obj3d || !this._node) return;
    if (this._dragEl?.type === 'plane') {
      // Plane: applyNumericAmount(0) is a no-op for planes; we restore
      // the snapshot manually here.
      const no = this._node;
      no.localOffset = [...this._startOffset];
      no.localQuaternion = [...this._startQuat];
      applyNodeTransformToObject3D(no, this._obj3d, true);
      steps.scheduleSync();
      this._tick();
      return;
    }
    this.applyNumericAmount(0);
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

    // C5-B: hidden stand-in for cable-point mode. Lives off-scene; only
    // its position field is read by getWorldPosition. Re-positioned each
    // tick when _cableTarget is set so the rest of the gizmo's world-pos
    // logic (axis vectors, drag plane) keeps working unchanged.
    this._cableStandIn = new T.Object3D();
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
      // V0.3.0.164 — clickable toggle (was pointer-events:none): a non-keyboard
      // way to pick Local/World, esp. for cable sockets + groups. 'L' still works.
      'pointer-events:auto',
      'cursor:pointer',
      'display:none',
      'user-select:none',
    ].join(';');
    el.title = 'Click (or press L) to toggle Local / World axes';
    el.textContent = 'LOCAL';
    el.addEventListener('click', () => this.toggleSpace());
    document.getElementById('viewer')?.appendChild(el)
      ?? document.body.appendChild(el);
    this._spaceLabelEl = el;
  }

  _buildGeometry() {
    const T = window.THREE;

    // ── Translate arrows ────────────────────────────────────────────────────
    for (const axis of ['x', 'y', 'z']) {
      const color = AX[axis];

      const shaftGeo = new T.CylinderGeometry(0.0125, 0.0125, 0.72, 8);
      const shaftMat = new T.MeshBasicMaterial({ color, depthTest: false });
      const shaft    = new T.Mesh(shaftGeo, shaftMat);
      shaft.position.y = 0.36;

      const coneGeo  = new T.ConeGeometry(0.038, 0.25, 8);
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
    // V0.2.22.114: shrunk + tucked inward + lower opacity so they read as small
    // plane-drag handles, not a big floating "rectangle" near the object.
    const planes = [
      { axis: 'xz', color: AX.y, pos: [0.20, 0, 0.20],    rotX: -Math.PI / 2, rotY: 0 },
      { axis: 'xy', color: AX.z, pos: [0.20, 0.20, 0],    rotX: 0,            rotY: 0 },
      { axis: 'yz', color: AX.x, pos: [0, 0.20, 0.20],    rotX: 0,            rotY: Math.PI / 2 },
    ];
    for (const p of planes) {
      const vGeo  = new T.PlaneGeometry(0.18, 0.18);
      const vMat  = new T.MeshBasicMaterial({ color: p.color, side: T.DoubleSide, transparent: true, opacity: 0.45, depthTest: false });
      const vis   = new T.Mesh(vGeo, vMat);
      vis.position.set(...p.pos);
      vis.rotation.x = p.rotX;
      vis.rotation.y = p.rotY;
      this._group.add(vis);

      const hGeo  = new T.PlaneGeometry(0.26, 0.26);
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

      const geo  = new T.TorusGeometry(0.55, 0.015, 8, 56);
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

    // ── Uniform-scale handle (V0.3.0.88) ─────────────────────────────────
    // A WHITE CUBE at the gizmo hub, shown for ANY selected object in 'all'
    // mode. Drag UP grows / DOWN shrinks; on commit it writes baseLocalScale
    // GLOBALLY (the same scale in every step, via actions.setNodeScaleGlobal)
    // — scale is not per-step animated. Hidden for cable targets.
    const GLOBAL_BOX_COLOUR = 0xffffff;
    const visGeo = new T.BoxGeometry(0.14, 0.14, 0.14);
    const visMat = new T.MeshBasicMaterial({ color: GLOBAL_BOX_COLOUR, depthTest: false });
    const vis    = new T.Mesh(visGeo, visMat);
    vis.visible  = false;
    this._group.add(vis);

    const hitGeo = new T.BoxGeometry(0.22, 0.22, 0.22);
    const hitMat = new T.MeshBasicMaterial({ visible: false, depthTest: false });
    const hit    = new T.Mesh(hitGeo, hitMat);
    hit.visible  = false;
    this._group.add(hit);

    const el = {
      hitMesh: hit, visuals: [vis], mats: [visMat],
      axis: 'uniform', type: 'scale', baseColor: GLOBAL_BOX_COLOUR,
    };
    hit.userData._gEl = el;
    this._elements.push(el);
    // Keep references so visibility can be toggled directly from _tick().
    this._globalDot = vis;
    this._globalHit = hit;
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
    this._cableTarget = null;          // exit cable-point mode if entering
    this._node    = node;
    this._obj3d   = obj3d;
    this._visible = true;
    this._group.visible = true;
    this._mode = 'all';
    this._applyMode();
    this._tick();
    if (this._spaceLabelEl) this._spaceLabelEl.style.display = '';
    this._updateSpaceLabel();
    if (this._panel) this._rebindPanel();
  }

  /**
   * C5-B / E2: show the gizmo for a cable-target selection (point or
   * socket). Cable points are translate-only; sockets get full
   * translate + rotate. The stand-in object3d gets its position
   * refreshed every tick from target.getWorldPos so the gizmo follows
   * the host mesh as it animates.
   *
   * target = {
   *   cableId, nodeId,
   *   getWorldPos(): THREE.Vector3,
   *   getWorldQuat?(): THREE.Quaternion,
   *   beginMove(),
   *   applyCumulativeDelta(worldDelta),
   *   commitMove(),
   *   hasRotate?: boolean,
   *   beginRotate?(),
   *   applyRotateAroundAxis?(worldAxis, angleRad),
   *   commitRotate?(),
   * }
   */
  showForCableTarget(target, mode = 'translate') {
    if (!this._group || !target) return;
    this._cableTarget = target;
    this._node    = null;
    this._obj3d   = this._cableStandIn;
    // Seed stand-in pose so onPointerDown's plane raycast has a valid
    // world position even before the next tick fires.
    const p = target.getWorldPos();
    if (p) this._cableStandIn.position.copy(p);
    const q = target.getWorldQuat ? target.getWorldQuat() : null;
    if (q) this._cableStandIn.quaternion.copy(q);
    else   this._cableStandIn.quaternion.identity();
    this._visible = true;
    this._group.visible = true;
    this._mode = mode;
    // V0.3.0.115 — cable POINTS default to WORLD axes (node positioning felt weird
    // in the surface frame). V0.3.0.132 — SOCKETS ('all' mode) default to LOCAL so
    // fine-adjusting the connection point slides along the surface (X/Y) + in/out
    // (Z). The LOCAL/WORLD toggle (L) still works either way.
    this._spaceMode = (mode === 'all') ? 'local' : 'world';
    this._applyMode();
    this._tick();
    if (this._spaceLabelEl) this._spaceLabelEl.style.display = '';
    this._updateSpaceLabel();
    if (this._panel) this._rebindPanel();
  }

  /** Translate-only — for cable points. */
  showForCablePoint(target) { this.showForCableTarget(target, 'translate'); }

  /** Translate + rotate — for cable sockets. */
  showForCableSocket(target) { this.showForCableTarget(target, 'all'); }

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
    this._visible      = false;
    this._node         = null;
    this._obj3d        = null;
    this._cableTarget  = null;
    this._hovered      = null;
    this._dragging     = false;
    this._dragEl       = null;
    if (this._spaceLabelEl) this._spaceLabelEl.style.display = 'none';
    // Keep the transform panel open if it was already showing — it
    // re-renders into the greyed "no target" state. The user closes the
    // panel explicitly via X or Esc; gizmo hide alone shouldn't dismiss
    // it, since the next selection may bring a new transform target.
    if (this._panel) this._rebindPanel();
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
    const mode = this._spaceMode;
    this._spaceLabelEl.textContent = (mode === 'local' ? 'LOCAL'
                                   : mode === 'world' ? 'WORLD'
                                                       : 'PIVOT') + ' ⇄';
    this._spaceLabelEl.style.color = mode === 'local' ? '#60a5fa'
                                   : mode === 'pivot' ? '#fb923c'
                                                       : '#94a3b8';
  }

  // V0.3.0.99 — uniform scale is SHAPE-ONLY. Folders / meshes / primitives never
  // show the white scale hub (scaling them would distort geometry / break the
  // transform model). Only flatShape instances get it, in 'all' mode.
  _scaleAllowed() {
    return this._node?.type === 'flatShape' && !this._cableTarget && this._mode === 'all';
  }

  _applyMode() {
    // The scale element (white hub cube) is SHAPE-ONLY in 'all' mode;
    // translate/rotate handles follow the active mode.
    for (const el of this._elements) {
      let show;
      if (el.type === 'scale') {
        show = this._scaleAllowed();   // V0.3.0.99 — flatShape only
      } else {
        show = this._mode === 'all'
          || (this._mode === 'translate' && (el.type === 'translate' || el.type === 'plane'))
          || (this._mode === 'rotate'    && el.type === 'rotate');
      }
      for (const v of el.visuals) v.visible = show;
      if (el.hitMesh) el.hitMesh.visible = show;
    }
  }

  // ── Tick (called every frame) ─────────────────────────────────────────────

  _tick() {
    if (!this._visible || !this._obj3d || !this._group) return;
    const T   = window.THREE;

    // C5-B: cable-point mode — refresh stand-in to current target world
    // pose every frame, then mirror it onto the gizmo group. Frame is
    // surface-aligned (target.getWorldQuat maps +Z to face normal) so
    // translate handles read as "Z = lift off surface, X/Y = slide".
    if (this._cableTarget) {
      const p = this._cableTarget.getWorldPos();
      if (p) {
        this._cableStandIn.position.copy(p);
        this._group.position.copy(p);
      }
      // Lock pose during a drag so axes stay stable while the user
      // moves the underlying point — same reason rotate-drag locks.
      const lockPose = this._dragging && this._startRefQuat;
      if (lockPose) {
        this._group.quaternion.copy(this._startRefQuat);
        this._cableStandIn.quaternion.copy(this._startRefQuat);
      } else {
        // V0.3.0.118 — WORLD space (the cable default): orient the gizmo to world
        // axes so the visual matches the world drag axes (was always the point's
        // surface frame → gizmo looked tilted at a "weird angle"). LOCAL toggle
        // restores the surface frame.
        const q = this._spaceMode === 'world'
          ? null
          : (this._cableTarget.getWorldQuat ? this._cableTarget.getWorldQuat() : null);
        if (q) {
          this._group.quaternion.copy(q);
          this._cableStandIn.quaternion.copy(q);
        } else {
          this._group.quaternion.identity();
          this._cableStandIn.quaternion.identity();
        }
      }
      const cam    = sceneCore.camera;
      const dist   = cam.position.distanceTo(this._group.position);
      const fovRad = (cam.fov * Math.PI) / 180;
      const viewH  = 2 * dist * Math.tan(fovRad / 2);
      this._group.scale.setScalar(viewH * SCREEN_SIZE);
      if (this._pivotDot)  this._pivotDot.visible  = false;
      if (this._globalDot) this._globalDot.visible = false;
      return;
    }

    // P-P1: pivot mode awareness.
    //   GREY (pivotEnabled=false)   → gizmo at object world origin (default).
    //   RED  (this node is in edit) → gizmo at pivot world pose; orange dot ON.
    //   BLUE (pivotEnabled, no edit)→ gizmo at pivot world pose; orange dot OFF.
    const node           = this._node;
    const pivotEnabled   = node?.pivotEnabled === true;
    const isPivotEditing = node && state.get('pivotEditNodeId') === node.id;
    const usePivotPose   = pivotEnabled || isPivotEditing;

    // During a rotate drag, lock the gizmo's pose to the snapshot taken
    // at pointerdown WHEN THE OBJECT IS ROTATING (BLUE mode). That
    // stops the "rings spin under the cursor" artefact while the
    // object orbits its pivot.
    //
    // EXCEPTION: in RED pivot edit mode the OBJECT doesn't move — only
    // the pivot's local frame changes. Locking the pose during rotation
    // means the user sees no live feedback and has to release to see
    // the new orientation. Let the gizmo track the pivot's current
    // pose live instead — the X/Y/Z handles spin to reflect where the
    // pivot frame is going, which is exactly the "live preview" the
    // user expects.
    const lockPose = this._dragging
                     && this._dragEl?.type === 'rotate'
                     && this._startGizmoPos
                     && !isPivotEditing;

    const pos = new T.Vector3();
    if (lockPose) {
      pos.copy(this._startGizmoPos);
    } else if (usePivotPose) {
      pos.copy(getPivotWorldPosition(node, this._obj3d));
    } else {
      this._obj3d.getWorldPosition(pos);
    }
    this._group.position.copy(pos);

    // Orient gizmo: world space = identity (world axes); local + pivot
    // space modes both use the gizmo's reference frame (parent or
    // pivot, depending on pivotEnabled). PIVOT panel space is an
    // INPUT-side toggle — visually the gizmo behaves like LOCAL.
    // Lock to snapshot during rotate drag for the same reason as pos.
    const useFrameOrientation = this._spaceMode !== 'world';
    if (lockPose && this._startRefQuat && useFrameOrientation) {
      this._group.quaternion.copy(this._startRefQuat);
    } else if (useFrameOrientation) {
      if (usePivotPose) {
        this._group.quaternion.copy(getPivotWorldQuaternion(node, this._obj3d));
      } else {
        // Use the SAME reference frame as _axisVec / drag-start ref so
        // the idle visual matches the live drag visual. For flatShape
        // this is parent × localQ × planeLocalQuat (polygon's natural
        // frame); for everything else it falls back to parentWorldQuat.
        const rq = this._gizmoReferenceQuat();
        if (rq) this._group.quaternion.copy(rq);
        else    this._group.quaternion.identity();
      }
    } else {
      this._group.quaternion.identity();
    }

    // Orange dot at gizmo hub — only while editing the pivot.
    if (this._pivotDot) this._pivotDot.visible = isPivotEditing;
    // White uniform-scale handle at the hub — SHAPE-ONLY (V0.3.0.99). Drag to
    // scale globally. Hidden for folders / meshes / primitives / cables / modes.
    const showScale = this._scaleAllowed();
    if (this._globalDot) this._globalDot.visible = showScale;
    if (this._globalHit) this._globalHit.visible = showScale;

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

  onPointerDown(clientX, clientY, ctrlInit = false) {
    if (!this._visible) return false;
    // If a prior drag was deferred (click-armed or numeric-locked),
    // commit it before processing this new click. Without this, a user
    // who clicks one handle, types nothing, then clicks another handle
    // would leave the first drag unbalanced (no commitTransformEdit).
    if (this._dragging) {
      this._numericLock = false;
      // Force pointerup path to commit by faking dragMoved so the
      // guard inside onPointerUp doesn't re-defer. After commit
      // _dragging is false, then we proceed with the new click.
      this._dragMoved = true;
      this.onPointerUp();
    }
    const el = this._raycastElements(clientX, clientY);
    if (!el) return false;

    this._setHovered(null);
    this._dragging = true;
    this._dragMoved = false;        // reset — set true on first move
    this._dragEl   = el;
    this._setElColor(el, ACTIVE_COL);

    // C5-B / E2: cable mode — open the right batch on the actions
    // side. Rotate handles → beginRotate (sockets only); everything
    // else → beginMove (translate / plane). The translate/rotate
    // distinction matches the el.type so re-clicking a different
    // handle within the same selection re-batches correctly.
    if (this._cableTarget) {
      if (el.type === 'rotate' && this._cableTarget.beginRotate) {
        this._cableTarget.beginRotate();
      } else {
        this._cableTarget.beginMove();
      }
    }

    // P-P1: in pivot edit mode (RED) the parent enterPivotEdit/commitPivotEdit
    // pair already brackets the undo session — skip beginTransformEdit so we
    // don't push a redundant "Transform" entry during the gesture.
    // Same logic for translate-global mode: enter/commit pair brackets it.
    const inPivotEdit       = !!this._node && state.get('pivotEditNodeId')      === this._node.id;
    const inGlobalEdit = !!this._node && state.get('globalEditNodeId') === this._node.id;
    // Scale drags commit through setNodeScaleGlobal (their own undo), so skip the
    // per-step transform batch for them (V0.3.0.88).
    if (this._node && !inPivotEdit && !inGlobalEdit && this._dragEl?.type !== 'scale') actions.beginTransformEdit(this._node.id);

    const T = window.THREE;
    const no = this._node;
    this._startOffset       = no?.localOffset           ? [...no.localOffset]           : [0, 0, 0];
    this._startQuat         = no?.localQuaternion       ? [...no.localQuaternion]       : [0, 0, 0, 1];
    // Pivot start values for RED-mode drags (writes to pivot fields).
    this._startPivotOffset  = no?.pivotLocalOffset      ? [...no.pivotLocalOffset]      : [0, 0, 0];
    this._startPivotQuat    = no?.pivotLocalQuaternion  ? [...no.pivotLocalQuaternion]  : [0, 0, 0, 1];
    // Global-edit start values (write base* fields when red-cube active).
    this._startBasePosition   = no?.baseLocalPosition   ? [...no.baseLocalPosition]   : [0, 0, 0];
    this._startBaseQuaternion = no?.baseLocalQuaternion ? [...no.baseLocalQuaternion] : [0, 0, 0, 1];
    this._startBaseScale      = no?.baseLocalScale      ? [...no.baseLocalScale]      : [1, 1, 1];

    // P-P1 fix: snapshot the gizmo's reference frame at pointerdown so
    // axis vectors + angle projection stay stable through the whole
    // drag. Without this, RED rotate (pivot rotates → ref frame
    // changes) and BLUE rotate (object rotates → ref frame changes)
    // both drifted as the angle plane shifted underfoot, and rotation
    // felt slippery and off-axis.
    const liveRef = this._gizmoReferenceQuat();
    this._startRefQuat = liveRef ? liveRef.clone() : null;
    // Also snapshot the gizmo's world position so we can lock the
    // visual gizmo in place during a rotate drag (independent of the
    // object's rotation), avoiding the "rings spin under the cursor"
    // visual artefact.
    const liveCenter = new T.Vector3();
    if (no?.pivotEnabled || (state.get('pivotEditNodeId') === no?.id)) {
      liveCenter.copy(getPivotWorldPosition(no, this._obj3d));
    } else {
      this._obj3d.getWorldPosition(liveCenter);
    }
    this._startGizmoPos = liveCenter;

    const plane = this._getDragPlane(el);
    this._startWorld = this._worldPoint(clientX, clientY, plane);

    // Phase 2.1 scale handle uses screen-space dy for the factor — keep
    // the start screen coords so the math is independent of any view /
    // distance changes during the drag.
    this._startClientX = clientX;
    this._startClientY = clientY;

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

    this._lastAmount = null;
    if (this._onDragEvent) this._onDragEvent('start', { type: el.type, axis: el.axis, node: no });

    // Ctrl-drag GLOBAL (V0.3.0.98) — for a normal per-step translate/rotate drag,
    // arm live-Ctrl tracking + the 🌐 badge. On release with Ctrl held the commit
    // broadcasts the delta to a step range (handled in onPointerUp). Excludes
    // pivot / global-edit / scale / cable drags.
    if (this._node && !inPivotEdit && !inGlobalEdit
        && (el.type === 'translate' || el.type === 'plane' || el.type === 'rotate')) {
      this._armGlobalDrag(ctrlInit, clientX, clientY);
    } else {
      this._ctrlGlobal = false;
    }

    return true;
  }

  onPointerMove(clientX, clientY) {
    if (!this._dragging || !this._dragEl) return false;
    this._dragMoved = true;
    this._doDrag(clientX, clientY);
    return true;
  }

  onPointerUp() {
    if (!this._dragging) return;
    // Defer commit if either:
    //   (a) user is currently typing a numeric value (numericLock), or
    //   (b) the click was a pure click — no mouse movement during the
    //       drag — so the user might still want to type a number into
    //       this engaged handle. Commit happens later on Enter, on a
    //       click outside the handle, or via Esc revert.
    if (this._numericLock || !this._dragMoved) { this._teardownGlobalDrag(); return; }
    const _endEl = this._dragEl;
    this._dragging = false;
    this._numericLock = false;
    if (this._onDragEvent && _endEl) {
      this._onDragEvent('end', { type: _endEl.type, axis: _endEl.axis, node: this._node });
    }
    // C5-B / E2: close the active cable batch — rotate or move.
    // Done before the tree-node path because cable mode never has
    // _node set.
    if (this._cableTarget) {
      if (this._dragEl?.type === 'rotate' && this._cableTarget.commitRotate) {
        this._cableTarget.commitRotate();
      } else {
        this._cableTarget.commitMove();
      }
    }
    // P-P1: in pivot edit mode (RED), commit ONE undo entry per drag
    // via commitPivotDrag — captures the pivot pose changed by this
    // gesture only. Does NOT exit edit mode, so the user can keep
    // adjusting and each adjustment is independently undoable.
    //
    // Global-transform mode (Phase 2 / 2.1) follows the same per-drag
    // pattern, dispatched by handle type:
    //   translate / plane  → commitGlobalTranslateDrag (baseLocalPosition)
    //   rotate             → commitGlobalRotateDrag    (baseLocalQuaternion)
    //   scale              → commitGlobalScaleDrag     (baseLocalScale)
    // The scale element only exists / is visible while in global mode —
    // there's no per-step scale path.
    //
    // Outside global mode, commitTransformEdit handles the per-step
    // object-pose undo for translate + rotate.
    const inPivotEdit  = !!this._node && state.get('pivotEditNodeId')  === this._node.id;
    const inGlobalEdit = !!this._node && state.get('globalEditNodeId') === this._node.id;
    const endType      = _endEl?.type;

    if (this._node && endType === 'scale') {
      // V0.3.0.88 — uniform scale is GLOBAL (all steps) in any mode. The drag already
      // mutated the live baseLocalScale; revert it, then re-apply it globally with
      // correct before/after undo via setNodeScaleGlobal.
      const finalScale = [...(this._node.baseLocalScale || [1, 1, 1])];
      this._node.baseLocalScale = [...this._startBaseScale];
      actions.setNodeScaleGlobal(this._node.id, finalScale);
    } else if (this._node && inPivotEdit) {
      actions.commitPivotDrag(this._node.id, {
        offset: this._startPivotOffset,
        quat:   this._startPivotQuat,
      });
    } else if (this._node && inGlobalEdit) {
      if (endType === 'translate' || endType === 'plane') {
        actions.commitGlobalTranslateDrag(this._node.id, this._startBasePosition);
      } else if (endType === 'rotate') {
        actions.commitGlobalRotateDrag(this._node.id, this._startBaseQuaternion);
      }
    } else if (this._node) {
      // Ctrl-drag GLOBAL (V0.3.0.98): on a translate/rotate release with Ctrl
      // held, broadcast the delta to a step range instead of just this step.
      const wantGlobal = this._ctrlGlobal
        && (endType === 'translate' || endType === 'plane' || endType === 'rotate');
      if (wantGlobal) actions.commitTransformEditGlobalCtrl(this._node.id);
      else            actions.commitTransformEdit(this._node.id);
    }
    this._teardownGlobalDrag();
    if (this._dragEl) {
      this._setElColor(this._dragEl, this._dragEl.baseColor);
      this._dragEl = null;
    }
    // Refresh panel values after drag ends
    if (this._panel) this._refreshPanel();
  }

  // ── Ctrl-drag GLOBAL helpers (V0.3.0.98) ──────────────────────────────────
  // While a normal per-step translate/rotate drag is live, track the Ctrl key
  // continuously (seeded from the pointerdown state) and show a 🌐 badge by the
  // cursor whenever it's held. onPointerUp reads this._ctrlGlobal to decide
  // whether to broadcast the delta to a step range.
  _ensureGlobalBadge() {
    if (this._globalBadge) return this._globalBadge;
    const b = document.createElement('div');
    b.textContent = '🌐 Global';
    b.style.cssText = [
      'position:fixed', 'z-index:10000', 'pointer-events:none', 'display:none',
      'background:#0f766e', 'color:#ecfeff', 'border:1px solid #5eead4',
      'border-radius:6px', 'padding:2px 7px', 'font-size:11px', 'font-weight:600',
      'letter-spacing:0.3px', 'box-shadow:0 4px 14px rgba(0,0,0,0.45)',
    ].join(';');
    document.body.appendChild(b);
    this._globalBadge = b;
    return b;
  }

  _updateGlobalBadge() {
    const b = this._ensureGlobalBadge();
    const t = this._dragEl?.type;
    const show = this._dragging && this._ctrlGlobal
      && (t === 'translate' || t === 'plane' || t === 'rotate');
    if (!show) { b.style.display = 'none'; return; }
    b.style.display = 'block';
    b.style.left = `${(this._lastDragX ?? this._startClientX ?? 0) + 16}px`;
    b.style.top  = `${(this._lastDragY ?? this._startClientY ?? 0) + 16}px`;
  }

  _armGlobalDrag(ctrlInit, clientX, clientY) {
    // V0.3.0.125 — the Ctrl-hold global gesture is RETIRED in favour of the
    // Spacebar Global Mode toggle (state.globalMode), which also captures typed
    // inputs and can't be forgotten mid-drag. Force-disarm so `wantGlobal` stays
    // false and every drag takes the normal commitTransformEdit path (the carry
    // session is driven by globalMode now). Code kept dormant for reference.
    this._ctrlGlobal = false;
    this._lastDragX  = clientX;
    this._lastDragY  = clientY;
    this._updateGlobalBadge();
  }

  _teardownGlobalDrag() {
    if (this._globalKeyHandler) {
      document.removeEventListener('keydown', this._globalKeyHandler, true);
      document.removeEventListener('keyup',   this._globalKeyHandler, true);
    }
    this._ctrlGlobal = false;
    if (this._globalBadge) this._globalBadge.style.display = 'none';
  }

  /**
   * Called from canvas contextmenu handler.
   * Returns true if the gizmo consumed the event (opened the panel).
   */
  onRightClick(clientX, clientY) {
    if (!this._visible) return false;
    // V0.3.0.84 — a 2nd right-click while the transform panel is open returns false
    // (without consuming) so the regular context menu opens ALONGSIDE the panel (which
    // stays up-left). Lets the user reach the context menu even on a small model the
    // gizmo fully covers: 1st click = transform panel, 2nd click = context menu.
    if (this._panel) return false;
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
    if (!el || !this._obj3d) return;

    // Numeric input has hijacked the drag — typed values apply via
    // applyNumericAmount(); ignore mouse motion until lock is released.
    if (this._numericLock) return;

    // Ctrl-drag global badge follows the cursor (V0.3.0.98).
    this._lastDragX = clientX;
    this._lastDragY = clientY;
    this._updateGlobalBadge();

    // ── Scale handle (Phase 2.1, GLOBAL ONLY) ─────────────────────────────
    // Uses pure screen-space dy — no plane projection needed. Drag UP →
    // grow, DOWN → shrink. The handle is only ever shown / pickable when
    // state.globalEditNodeId === flatShape, so writes always target
    // baseLocalScale (HOME pose, ripples to every step).
    if (el.type === 'scale' && no) {
      const factor = _factorFromScreenDy(this._startClientY, clientY);
      no.baseLocalScale = [
        this._startBaseScale[0] * factor,
        this._startBaseScale[1] * factor,
        this._startBaseScale[2] * factor,
      ];
      applyNodeTransformToObject3D(no, this._obj3d);
      this._tick();
      this._lastAmount = factor;
      if (this._onDragEvent) this._onDragEvent('move', { type: 'scale', axis: 'uniform', value: factor, node: no, source: 'mouse' });
      return;
    }

    const plane = this._getDragPlane(el);
    const curr  = this._worldPoint(clientX, clientY, plane);
    if (!curr || !this._startWorld) return;

    // C5-B / E2: cable mode — translate / plane → applyCumulativeDelta;
    // rotate (sockets only) → applyRotateAroundAxis with the cursor's
    // angular delta around the gizmo axis. The cumulative-from-start
    // pattern keeps everything idempotent across drag frames.
    if (this._cableTarget) {
      if (el.type === 'translate') {
        const delta  = curr.clone().sub(this._startWorld);
        const axVec  = this._axisVec(el.axis);
        const amount = delta.dot(axVec);
        const worldD = axVec.clone().multiplyScalar(amount);
        this._cableTarget.applyCumulativeDelta(worldD);
      } else if (el.type === 'plane') {
        const delta   = curr.clone().sub(this._startWorld);
        const [a, b]  = el.axis.split('');
        const axA     = this._axisVec(a);
        const axB     = this._axisVec(b);
        const worldD  = axA.clone().multiplyScalar(delta.dot(axA))
                          .add(axB.clone().multiplyScalar(delta.dot(axB)));
        this._cableTarget.applyCumulativeDelta(worldD);
      } else if (el.type === 'rotate' && this._cableTarget.applyRotateAroundAxis) {
        const center = new T.Vector3().copy(this._obj3d.getWorldPosition(new T.Vector3()));
        const rel = curr.clone().sub(center);
        const currAngle = this._atan2ForAxisInSpace(rel, el.axis);
        const rawDelta  = currAngle - this._startAngle;
        const angle     = (el.axis === 'x' || el.axis === 'y') ? -rawDelta : rawDelta;
        const worldAxis = this._axisVec(el.axis);
        this._cableTarget.applyRotateAroundAxis(worldAxis, angle);
      }
      return;
    }

    if (!no) return;

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

    // ── Global-transform mode (Phase 2 / 2.1) ─────────────────────────────
    //   Translate / plane → baseLocalPosition  (instead of localOffset)
    //   Rotate            → baseLocalQuaternion (instead of localQuaternion)
    //   Scale             → baseLocalScale     (instead of localScale)
    //   Math is identical to per-step branches; only the output field
    //   changes. Result: change ripples to every step uniformly.
    const inGlobalEdit = state.get('globalEditNodeId') === no.id;
    if (inGlobalEdit) {
      if (el.type === 'translate' || el.type === 'plane') {
        const delta = curr.clone().sub(this._startWorld);
        let worldD;
        if (el.type === 'translate') {
          const axVec = this._axisVec(el.axis);
          worldD = axVec.clone().multiplyScalar(delta.dot(axVec));
        } else {
          const [a, b] = el.axis.split('');
          const axA = this._axisVec(a);
          const axB = this._axisVec(b);
          worldD = axA.clone().multiplyScalar(delta.dot(axA))
                    .add(axB.clone().multiplyScalar(delta.dot(axB)));
        }
        const localD = this._worldToLocalDelta(worldD);
        no.baseLocalPosition = [
          this._startBasePosition[0] + localD.x,
          this._startBasePosition[1] + localD.y,
          this._startBasePosition[2] + localD.z,
        ];
        applyNodeTransformToObject3D(no, this._obj3d);
        this._tick();
        if (this._onDragEvent) this._onDragEvent('move', { type: el.type, axis: el.axis, value: el.type === 'translate' ? delta.dot(this._axisVec(el.axis)) : null, node: no });
        return;
      }

      if (el.type === 'rotate') {
        // Same axis math as the default per-step rotate path — only the
        // output field changes (writes baseLocalQuaternion instead of
        // localQuaternion).
        const center    = new T.Vector3().copy(this._obj3d.getWorldPosition(new T.Vector3()));
        const rel       = curr.clone().sub(center);
        const currAngle = this._atan2ForAxisInSpace(rel, el.axis);
        const rawDelta  = currAngle - this._startAngle;
        const angle     = (el.axis === 'x' || el.axis === 'y') ? -rawDelta : rawDelta;
        const rotAxis   = this._rotAxisLocal(el.axis);
        const deltaQ    = new T.Quaternion().setFromAxisAngle(rotAxis, angle);
        const baseQ     = new T.Quaternion(
          this._startBaseQuaternion[0], this._startBaseQuaternion[1],
          this._startBaseQuaternion[2], this._startBaseQuaternion[3],
        );
        const newQ = deltaQ.multiply(baseQ);
        no.baseLocalQuaternion = [newQ.x, newQ.y, newQ.z, newQ.w];
        applyNodeTransformToObject3D(no, this._obj3d);
        this._tick();
        if (this._onDragEvent) this._onDragEvent('move', { type: el.type, axis: el.axis, value: angle * 180 / Math.PI, node: no });
        return;
      }

      // (scale is handled by the early return above _getDragPlane —
      // it doesn't need plane projection.)
    }

    // ── Non-pivot-edit paths (default + BLUE rotate) ──────────────────────

    let _emitValue = null;   // for the drag-event readout (single num or {a,b})

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
      _emitValue = amount;

    } else if (el.type === 'plane') {
      const delta   = curr.clone().sub(this._startWorld);
      const [a, b]  = el.axis.split('');
      const axA     = this._axisVec(a);
      const axB     = this._axisVec(b);
      const aAmt    = delta.dot(axA);
      const bAmt    = delta.dot(axB);
      const worldD  = axA.clone().multiplyScalar(aAmt).add(axB.clone().multiplyScalar(bAmt));
      const localD  = this._worldToLocalDelta(worldD);
      no.localOffset = [
        this._startOffset[0] + localD.x,
        this._startOffset[1] + localD.y,
        this._startOffset[2] + localD.z,
      ];
      no.moveEnabled = true;
      _emitValue = { a: aAmt, b: bAmt, axisA: a, axisB: b };

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
      _emitValue = delta * 180 / Math.PI;   // degrees, signed from start
    }
    // (scale is handled by the early return above _getDragPlane.)

    applyNodeTransformToObject3D(no, this._obj3d, true);
    steps.scheduleSync();
    this._tick();

    this._lastAmount = _emitValue;
    if (this._onDragEvent && _emitValue !== null) {
      this._onDragEvent('move', { type: el.type, axis: el.axis, value: _emitValue, node: no, source: 'mouse' });
    }
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

    // local + pivot space modes both align gizmo handles with the
    // gizmo's reference frame (parent or pivot, per pivotEnabled).
    // World stays identity → axes are world.
    if (this._spaceMode !== 'world') {
      // During a drag, prefer the snapshot reference so axes stay
      // stable even when the pivot/object rotates underneath us.
      const refQ = (this._dragging && this._startRefQuat)
        ? this._startRefQuat
        : this._gizmoReferenceQuat();
      if (refQ) v.applyQuaternion(refQ);
    }
    return v;
  }

  /**
   * The gizmo's current reference world quaternion. Drives _axisVec +
   * the orientation set in _tick. RED / BLUE mode → pivot world quat;
   * GREY → parent world quat.
   *
   * NOTE: callers in drag-hot paths should prefer this._startRefQuat
   * (the snapshot at pointerdown) over this live value — the live one
   * shifts as the object/pivot rotates and would make rotation drag
   * drift.
   */
  _gizmoReferenceQuat() {
    // Cable-point mode. WORLD space (default, V0.3.0.118) → world axes so the
    // drag-lock pose matches the world drag axes; LOCAL → the point's surface frame.
    if (this._cableTarget) {
      const T = window.THREE;
      if (this._spaceMode === 'world') return T ? new T.Quaternion() : null;
      const q = this._cableTarget.getWorldQuat ? this._cableTarget.getWorldQuat() : null;
      return q || null;
    }
    if (!this._node || !this._obj3d) return this._parentWorldQuat();
    const inPivotMode = this._node.pivotEnabled === true
      || state.get('pivotEditNodeId') === this._node.id;
    if (inPivotMode) return getPivotWorldQuaternion(this._node, this._obj3d);

    // Flat shapes carry their drawing-plane orientation on planeLocal-
    // Quaternion (baked into the geometry). The polygon's NATURAL frame
    // — the axes the user perceives as the shape's X / Y / normal — is
    // therefore parent × localQ × planeLocalQuat. Aligning the gizmo's
    // LOCAL mode to this frame puts the rings exactly on the polygon's
    // own edges, and _rotAxisLocal (which strips the parent) leaves the
    // correct rotation axis (localQ × planeLocalQuat × axis) so dragging
    // green rotates around the polygon's local Y, etc.
    if (this._node.type === 'flatShape') {
      const T = window.THREE;
      const parentQ = this._parentWorldQuat() || new T.Quaternion();
      const localQ  = new T.Quaternion(...(this._node.localQuaternion       ?? [0, 0, 0, 1]));
      const planeQ  = new T.Quaternion(...(this._node.planeLocalQuaternion ?? [0, 0, 0, 1]));
      return parentQ.clone().multiply(localQ).multiply(planeQ);
    }

    // V0.2.22.72 — hardware instances align the gizmo to the OBJECT'S OWN
    // orientation (a surface-placed nut is tilted via localQuaternion). The
    // generic parent frame would show world axes when the parent is the
    // identity Hardware folder, so LOCAL mode "looked like world" until the
    // user toggled to pivot. Use the object's live world quaternion.
    // V0.3.0.66 — primitives have the identical problem (placed under an
    // identity folder, rotated via their own localQuaternion) → same fix.
    if (this._node.type === 'hardwareInstance' || this._node.type === 'hardwareNut' || this._node.type === 'primitive') {
      const T = window.THREE;
      const q = new T.Quaternion();
      this._obj3d.getWorldQuaternion(q);
      return q;
    }

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
    // Same snapshot-vs-live guard as _axisVec — atan2 needs to project
    // onto a STABLE plane through the drag, not a live one that drifts
    // as the object/pivot rotates.
    const refQ = (this._dragging && this._startRefQuat)
      ? this._startRefQuat
      : this._gizmoReferenceQuat();
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

    const active = this._elements.filter(e => {
      if (e.type === 'scale') return this._scaleAllowed();   // V0.3.0.99 — flatShape only
      return this._mode === 'all'
        || (this._mode === 'translate' && (e.type === 'translate' || e.type === 'plane'))
        || (this._mode === 'rotate'    &&  e.type === 'rotate');
    });
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
   * Open the floating transform panel near the right-click position.
   * If a panel is already open, this just rebinds it to the current
   * selection and lets the existing panel keep its position — the panel
   * is persistent across selection changes (closes only via X / Esc).
   */
  _showTransformPanel(clientX, clientY) {
    if (this._panel) {
      // Already open — rebind to current selection but leave position.
      this._rebindPanel();
      return;
    }
    const panel = document.createElement('div');
    this._panel = panel;

    // V0.3.0.94 — pin to the TOP-LEFT corner of the viewport (was top-right),
    // a predictable out-of-the-way spot clear of the model under the click.
    const _surf = document.getElementById('viewport-surface');
    const _sr = _surf ? _surf.getBoundingClientRect() : null;
    panel.style.cssText = [
      'position:fixed',
      `left:${Math.max(8, (_sr ? _sr.left : 0) + 12)}px`,
      `top:${Math.max(8, (_sr ? _sr.top : 0) + 12)}px`,
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

    document.body.appendChild(panel);

    this._rebindPanel();   // populates HTML + snapshot + wires events

    // V0.3.0.94 — pin to the TOP-LEFT corner of the viewport (clear of the model
    // under the click), a fixed predictable spot instead of the cursor.
    requestAnimationFrame(() => {
      const left0 = _sr ? _sr.left : 8;
      const top0  = _sr ? _sr.top  : 8;
      let left = left0 + 12;
      let top  = top0 + 12;
      if (left < 8) left = 8;
      if (top  < 8) top  = 8;
      panel.style.left = `${left}px`;
      panel.style.top  = `${top}px`;
    });

    // Esc reverts the active node's edits and closes the panel. NO outside-
    // click auto-close — the panel persists across selections; user closes
    // it explicitly via X button or Esc.
    const onKey = (e) => {
      if (e.key === 'Escape' && this._panel) {
        e.preventDefault();
        this._revertPanel();
        this._closePanel();
      }
    };
    setTimeout(() => {
      document.addEventListener('keydown', onKey, { capture: true });
      panel._cleanup = () => {
        document.removeEventListener('keydown', onKey, { capture: true });
      };
    }, 0);
  }

  /**
   * Re-render the open panel against the current selection (`this._node`,
   * `this._obj3d`). Called on selection change so the panel always
   * reflects whatever transform target the gizmo is bound to. If no
   * transform target is available (cable point/socket, mesh, or empty
   * selection), renders a greyed body with a hint.
   *
   * Rebind also: (a) commits any in-flight pivot edit on the previous
   * node before switching, (b) snapshots the new node's transform for
   * Esc-revert, (c) re-enters pivot edit on the new node if the panel
   * is in PIVOT space mode and the new node is transformable.
   */
  _rebindPanel() {
    const panel = this._panel;
    if (!panel) return;

    const newNode = (this._node && !this._cableTarget) ? this._node : null;
    const newObj  = newNode ? this._obj3d : null;
    const prevId  = panel._panelNodeId || null;

    // Switching nodes — commit any open pivot edit on the previous node.
    if (prevId && prevId !== (newNode?.id ?? null) && state.get('pivotEditNodeId') === prevId) {
      actions.commitPivotEdit();
    }

    panel.innerHTML = this._panelHTML(newNode);
    panel._panelNodeId    = newNode?.id ?? null;
    panel._preOpenSnapshot = newNode ? captureTransformSnapshot(newNode) : null;

    if (newNode && newObj) {
      this._wirePanel(panel, newNode, newObj);
      // If the panel is in PIVOT space mode, the user expects orange-dot
      // pivot-edit to follow selection. Enter it for the new node.
      if (this._spaceMode === 'pivot' && state.get('pivotEditNodeId') !== newNode.id) {
        actions.enterPivotEdit(newNode.id);
      }
    } else {
      // Greyed state — only the close (X) button stays live.
      this._wirePanelChromeOnly(panel);
    }
  }

  /** Wire only the chrome (X / drag) when the panel has no transform target. */
  _wirePanelChromeOnly(panel) {
    panel.querySelector('[data-action="close"]')?.addEventListener('click', () => this._closePanel());
    this._wirePanelDragHandle(panel);
  }

  /** Re-usable drag-by-header behaviour, factored out of _wirePanel. */
  _wirePanelDragHandle(panel) {
    const dragHandle = panel.querySelector('[data-panel-drag]');
    if (!dragHandle) return;
    let dragging = false;
    let offsetX  = 0;
    let offsetY  = 0;
    let pointerId = null;
    dragHandle.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true;
      pointerId = e.pointerId;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      try { dragHandle.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    dragHandle.addEventListener('pointermove', e => {
      if (!dragging) return;
      panel.style.left = `${Math.round(e.clientX - offsetX)}px`;
      panel.style.top  = `${Math.round(e.clientY - offsetY)}px`;
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      try { dragHandle.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    };
    dragHandle.addEventListener('pointerup',     endDrag);
    dragHandle.addEventListener('pointercancel', endDrag);
  }

  /**
   * Revert the panel's target node back to the snapshot captured at
   * panel open time. Used by Esc — undoes every live edit made through
   * the panel inputs without pushing an undo entry.
   */
  _revertPanel() {
    const panel = this._panel;
    if (!panel || !panel._preOpenSnapshot || !panel._panelNodeId) return;
    const nb = state.get('nodeById');
    const no = nb?.get(panel._panelNodeId);
    if (!no) return;
    applyTransformSnapshot(no, panel._preOpenSnapshot);
    const obj = steps.object3dById?.get(no.id);
    if (obj) applyNodeTransformToObject3D(no, obj, true);
    steps.scheduleSync();
    this._tick();
    // Cancel the in-flight transform-edit batch so commitTransformEdit
    // doesn't push a no-op (or the would-have-been edit).
    actions.beginTransformEdit(no.id);   // resets _transformBatch.from to current (= reverted)
  }

  _panelHTML(targetNode = undefined) {
    // Header is identical in active vs greyed-out forms — just the title
    // text + close (X) button. Active form follows with full body; grey
    // form shows a single hint line.
    const no = (targetNode === undefined) ? this._node : targetNode;
    const closeBtn = `<button data-action="close" title="Close panel" style="font-size:13px;line-height:1;padding:2px 7px;background:transparent;border:1px solid var(--line,#334155);border-radius:4px;color:var(--muted,#94a3b8);cursor:pointer;font-weight:700;">×</button>`;
    const headerTitle = no ? this._escHTML(no.name || 'Untitled') : 'Transform';
    const headerHTML = `
      <div data-panel-drag="1" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;cursor:move;user-select:none;padding:2px 0;border-bottom:1px solid #1e293b;">
        <span style="font-weight:700;font-size:13px;color:#f1f5f9;letter-spacing:0.3px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${headerTitle}</span>
        ${closeBtn}
      </div>`;

    if (!no) {
      return `${headerHTML}
        <div style="opacity:0.55;pointer-events:none;">
          <div style="display:flex;gap:4px;margin-bottom:10px;">
            <button disabled style="${this._spaceBtn(false)}">LOCAL</button>
            <button disabled style="${this._spaceBtn(false)}">WORLD</button>
            <button disabled style="${this._spaceBtn(false, '#fb923c', '#9a3412')}">PIVOT</button>
          </div>
          <div style="font-size:11px;color:#64748b;line-height:1.5;padding:4px 0;">
            Select a folder, model, or shape in the scene to edit its transform.
          </div>
        </div>`;
    }

    const isPivotMode = this._spaceMode === 'pivot';

    // Translate values:
    //   PIVOT mode  → pivotLocalOffset (object-local; the pivot's offset
    //                  from its home position).
    //   LOCAL/WORLD → localOffset, expressed in the gizmo's reference
    //                  frame (see _offsetInPanelFrame).
    const [ox, oy, oz] = this._offsetInPanelFrame(no);
    const fmt = v => parseFloat(v.toFixed(4));

    // Rotation values:
    //   PIVOT mode  → Euler from pivotLocalQuaternion.
    //   LOCAL/WORLD → Euler from localQuaternion (parent-local).
    const rotSrc = isPivotMode
      ? (no.pivotLocalQuaternion ?? [0, 0, 0, 1])
      : (no.localQuaternion       ?? [0, 0, 0, 1]);
    const [ex, ey, ez] = this._quatToEulerDeg(rotSrc);
    const fmtA = v => parseFloat(v.toFixed(2));

    const spaceLocal = this._spaceMode === 'local';
    const spaceWorld = this._spaceMode === 'world';
    const spacePivot = isPivotMode;

    return `
      ${headerHTML}
      <div style="display:flex;gap:4px;margin-bottom:10px;">
        <button data-space="local" style="${this._spaceBtn(spaceLocal)}">LOCAL</button>
        <button data-space="world" style="${this._spaceBtn(spaceWorld)}">WORLD</button>
        <button data-space="pivot" style="${this._spaceBtn(spacePivot, '#fb923c', '#9a3412')}">PIVOT</button>
      </div>

      <div style="margin-bottom:8px;">
        <div style="font-size:10px;color:#64748b;margin-bottom:4px;letter-spacing:0.5px;">${isPivotMode ? 'PIVOT TRANSLATE (offset from home)' : 'TRANSLATE (offset)'}</div>
        ${this._axisRow('tx', 'X', fmt(ox), '#e05555')}
        ${this._axisRow('ty', 'Y', fmt(oy), '#55cc55')}
        ${this._axisRow('tz', 'Z', fmt(oz), '#5588e0')}
      </div>

      <div>
        <div style="font-size:10px;color:#64748b;margin-bottom:4px;letter-spacing:0.5px;">${isPivotMode ? 'PIVOT ROTATE (°)' : 'ROTATE (°)'}</div>
        ${this._axisRow('rx', 'X', fmtA(ex), '#e05555')}
        ${this._axisRow('ry', 'Y', fmtA(ey), '#55cc55')}
        ${this._axisRow('rz', 'Z', fmtA(ez), '#5588e0')}
      </div>

      ${(isPivotMode || no.type !== 'flatShape') ? '' : `
      <div style="margin-top:8px;">
        <div style="font-size:10px;color:#64748b;margin-bottom:4px;letter-spacing:0.5px;">SCALE (uniform · all steps)</div>
        ${this._axisRow('scale', 'S', fmt(no.baseLocalScale?.[0] ?? 1), '#c084fc')}
      </div>`}

      ${isPivotMode ? `
      <div style="margin-top:10px;">
        <button data-action="snap-to-surface" style="width:100%;font-size:11px;padding:5px 8px;background:#1c2538;border:1px solid #fb923c;border-radius:4px;color:#fb923c;cursor:pointer;font-weight:600;letter-spacing:0.3px;">
          ⌖ Snap pivot to surface…
        </button>
        <div style="font-size:10px;color:#64748b;margin-top:4px;line-height:1.4;">
          Next click on a face in the viewport snaps the pivot to the
          hit point with orientation aligned to the face normal.
        </div>
      </div>
      ` : ''}

      <div style="margin-top:10px;display:flex;justify-content:flex-end;gap:6px;">
        <button data-action="reset" style="font-size:11px;padding:3px 8px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;color:var(--muted);cursor:pointer;">↺ Reset</button>
      </div>
    `;
  }

  /** Tiny HTML escaper — used for the panel header title only. */
  _escHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _spaceBtn(active, activeBg = '#1d4ed8', activeBorder = '#3b82f6') {
    return [
      'font-size:10px',
      'padding:3px 7px',
      'border-radius:4px',
      'cursor:pointer',
      'font-weight:700',
      'letter-spacing:0.5px',
      `background:${active ? activeBg : 'var(--panel2)'}`,
      `border:1px solid ${active ? activeBorder : 'var(--line)'}`,
      `color:${active ? '#eff6ff' : 'var(--muted)'}`,
    ].join(';');
  }

  _axisRow(id, label, value, color) {
    // type=text (not number) so the user can type math expressions —
    // `sin(pi/4)*100`, `180/2`, `2+3*4` — evaluated live by parseExpression.
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="color:${color};font-weight:700;width:12px;flex-shrink:0;">${label}</span>
        <input data-field="${id}" type="text" value="${value}" autocomplete="off" spellcheck="false"
          style="flex:1;background:var(--panel);border:1px solid var(--line);border-radius:4px;
                 color:var(--text);padding:3px 6px;font-size:12px;outline:none;width:0;font-family:monospace;" />
      </div>`;
  }

  _wirePanel(panel, no, obj) {
    // Close (X) — kills the panel. No revert; user explicitly chose to dismiss.
    panel.querySelector('[data-action="close"]')?.addEventListener('click', () => {
      this._closePanel();
    });

    // Space toggle buttons. PIVOT additionally enters orange-dot pivot
    // edit mode (state.pivotEditNodeId === no.id) so dragging the gizmo
    // changes only the pivot pose. Switching back to LOCAL/WORLD commits
    // any open pivot edit so the per-drag undo entries stay coherent.
    panel.querySelectorAll('[data-space]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.space;
        if (target === 'pivot') {
          this.setSpace('pivot');
          if (state.get('pivotEditNodeId') !== no.id) actions.enterPivotEdit(no.id);
        } else {
          if (state.get('pivotEditNodeId') === no.id) actions.commitPivotEdit();
          this.setSpace(target);
        }
        // Re-render panel in place (keep position).
        this._rebindPanel();
      });
    });

    this._wirePanelDragHandle(panel);

    // Snap-to-surface button (PIVOT space mode only — see _panelHTML).
    // Triggers the same pick-mode the tree's "Snap Pivot to Surface…"
    // entry uses; main.js listens for the next viewport pointerdown.
    panel.querySelector('[data-action="snap-to-surface"]')?.addEventListener('click', () => {
      actions.startPivotSnapPicking(no.id);
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

    // Numeric inputs — live update on every keystroke. Each cell accepts
    // math expressions (parseExpression handles plain numbers AND
    // expressions: `sin(pi/4)*100`, `180/2`, `2+3*4`). Invalid /
    // incomplete input is silently ignored — the scene stays at its
    // last valid value while the user edits.
    panel.querySelectorAll('[data-field]').forEach(inp => {
      const field = inp.dataset.field;

      // V0.3.0.87 — uniform GLOBAL scale (baseLocalScale, identical in every step).
      // Its own undoable action; commit on blur / Enter (not per-keystroke) so one
      // edit = one undo. Refuses non-positive values.
      if (field === 'scale') {
        const commitScale = () => {
          const v = parseExpression(inp.value);
          if (Number.isFinite(v) && v > 0) actions.setNodeScaleGlobal(no.id, v);
          this._refreshPanel();
        };
        inp.addEventListener('blur', commitScale);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Escape') return;
          e.stopPropagation();
          if (e.key === 'Enter') inp.blur();
        });
        return;
      }

      const apply = () => {
        const val = parseExpression(inp.value);
        if (!Number.isFinite(val)) return;
        this._applyPanelValue(field, val, no, obj);
        steps.scheduleTransformSync();
        this._tick();
      };

      inp.addEventListener('focus', () => actions.beginTransformEdit(no.id));
      inp.addEventListener('blur',  () => { apply(); actions.commitTransformEdit(no.id); });
      inp.addEventListener('input', apply);

      // Stop propagation so arrow keys don't navigate steps while editing.
      // Don't intercept Esc — let the panel-level Esc handler (revert+close)
      // run via capture phase.
      inp.addEventListener('keydown', e => {
        if (e.key === 'Escape') return;   // panel-level handler takes over
        e.stopPropagation();
        if (e.key === 'Enter') { inp.blur(); }
      });
    });
  }

  _applyPanelValue(field, val, no, obj) {
    const isPivotMode = this._spaceMode === 'pivot';

    if (field === 'tx' || field === 'ty' || field === 'tz') {
      if (isPivotMode) {
        // PIVOT space mode: edit pivotLocalOffset directly (object-local).
        const cur = [...(no.pivotLocalOffset ?? [0, 0, 0])];
        if (field === 'tx') cur[0] = val;
        if (field === 'ty') cur[1] = val;
        if (field === 'tz') cur[2] = val;
        no.pivotLocalOffset = cur;
        no.pivotEnabled     = true;
      } else {
        // LOCAL / WORLD: edit localOffset, displayed in gizmo's reference frame.
        const cur = this._offsetInPanelFrame(no);
        if (field === 'tx') cur[0] = val;
        if (field === 'ty') cur[1] = val;
        if (field === 'tz') cur[2] = val;
        no.localOffset = this._offsetFromPanelFrame(no, cur);
        no.moveEnabled = true;
      }
    }

    if (field === 'rx' || field === 'ry' || field === 'rz') {
      if (isPivotMode) {
        // PIVOT space mode: edit pivotLocalQuaternion (Euler in pivot frame).
        const [ex, ey, ez] = this._quatToEulerDeg(no.pivotLocalQuaternion ?? [0, 0, 0, 1]);
        const nx = field === 'rx' ? val : ex;
        const ny = field === 'ry' ? val : ey;
        const nz = field === 'rz' ? val : ez;
        const q  = this._eulerDegToQuat(nx, ny, nz);
        no.pivotLocalQuaternion = [q.x, q.y, q.z, q.w];
        no.pivotEnabled         = true;
      } else {
        // LOCAL / WORLD: edit localQuaternion. When pivotEnabled, route
        // through the back-solver so the rotation pivots around the
        // active pivot (not the home origin). Mirrors gizmo drag behaviour.
        const [ex, ey, ez] = this._quatToEulerDeg(no.localQuaternion ?? [0, 0, 0, 1]);
        const nx = field === 'rx' ? val : ex;
        const ny = field === 'ry' ? val : ey;
        const nz = field === 'rz' ? val : ez;
        const q  = this._eulerDegToQuat(nx, ny, nz);
        if (no.pivotEnabled) {
          setNodeLocalRotationPreservePivot(no, [q.x, q.y, q.z, q.w]);
        } else {
          no.localQuaternion = [q.x, q.y, q.z, q.w];
          no.rotateEnabled   = true;
        }
      }
    }

    applyNodeTransformToObject3D(no, obj, true);
  }

  /**
   * Convert the panel's translate VALUES to display in the panel.
   *
   * In PIVOT space mode, the panel directly edits pivotLocalOffset
   * (no rotation conversion — pivot data is already in object-local
   * which we treat as the canonical "pivot frame").
   *
   * In LOCAL / WORLD modes, the panel edits localOffset displayed in
   * the gizmo's reference frame — see `_parentToGizmoQuat`.
   */
  _offsetInPanelFrame(no) {
    const T = window.THREE;
    if (this._spaceMode === 'pivot') {
      const p = no.pivotLocalOffset ?? [0, 0, 0];
      return [p[0], p[1], p[2]];
    }
    const parentToGizmo = this._parentToGizmoQuat();
    const v = new T.Vector3(...(no.localOffset ?? [0, 0, 0]));
    if (parentToGizmo) v.applyQuaternion(parentToGizmo);
    return [v.x, v.y, v.z];
  }

  /**
   * Inverse of _offsetInPanelFrame for LOCAL/WORLD modes only —
   * converts panel-frame → parent-local localOffset. Caller must
   * handle PIVOT mode separately (writes pivotLocalOffset directly,
   * no conversion needed).
   */
  _offsetFromPanelFrame(no, panelVec) {
    const T = window.THREE;
    const parentToGizmo = this._parentToGizmoQuat();
    const v = new T.Vector3(panelVec[0], panelVec[1], panelVec[2]);
    if (parentToGizmo) v.applyQuaternion(parentToGizmo.clone().invert());
    return [v.x, v.y, v.z];
  }

  /**
   * Quaternion that rotates a vector from parent-local frame to the
   * gizmo's current reference frame. This is gizmoRefQuat⁻¹ ×
   * parentWorldQ — the parent-world cancels out the parent-local
   * baseline and we land in the gizmo's frame.
   *
   *   LOCAL + no pivot → identity (gizmo IS parent frame)
   *   LOCAL + pivot    → pivotLocalQ⁻¹ × totalLocalQ⁻¹
   *   WORLD            → parentWorldQ (panel shows world coords)
   *
   * Returns null if obj3d isn't ready yet.
   */
  _parentToGizmoQuat() {
    const T = window.THREE;
    if (!this._obj3d) return null;
    const parentQ = new T.Quaternion();
    const parent = this._obj3d.parent;
    if (parent) parent.getWorldQuaternion(parentQ);
    const refQ = this._gizmoReferenceQuat() || parentQ;
    return refQ.clone().invert().multiply(parentQ);
  }

  /**
   * Re-render current values into open panel without recreating it.
   */
  _refreshPanel() {
    if (!this._panel || !this._node) return;
    const no = this._node;
    const isPivotMode = this._spaceMode === 'pivot';

    // Translate displayed in the gizmo's reference frame (matches input).
    const [ox, oy, oz] = this._offsetInPanelFrame(no);
    const rotSrc = isPivotMode
      ? (no.pivotLocalQuaternion ?? [0, 0, 0, 1])
      : (no.localQuaternion       ?? [0, 0, 0, 1]);
    const [ex, ey, ez] = this._quatToEulerDeg(rotSrc);
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
    const spaceWorld = this._spaceMode === 'world';
    const spacePivot = isPivotMode;
    this._panel.querySelector('[data-space="local"]')?.setAttribute('style', this._spaceBtn(spaceLocal));
    this._panel.querySelector('[data-space="world"]')?.setAttribute('style', this._spaceBtn(spaceWorld));
    this._panel.querySelector('[data-space="pivot"]')?.setAttribute('style', this._spaceBtn(spacePivot, '#fb923c', '#9a3412'));
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
