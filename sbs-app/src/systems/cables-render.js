/**
 * SBS — Cables render
 * ====================
 * Three.js visualisation for the data layer in `cables.js`. Owns one
 * `THREE.Group` named CableRoot mounted directly on `sceneCore.scene`
 * (NOT under rootGroup — cables shouldn't be torn down by tree
 * cleanup) and rebuilds per-cable subgroups whenever state.cables
 * changes.
 *
 * C2 scope:
 *   • Cylinder segments between consecutive cable nodes (straight
 *     only — `style.type === 'straight'`. catenary/bezier slot in C9).
 *   • Sphere visual at each node.
 *   • Per-frame tick refreshes mesh-anchored world positions and
 *     re-poses segments without rebuilding geometry (unit-length
 *     cylinders stretched via scale.y → cheap).
 *   • Cache write-through every tick the mesh is alive (seeds the
 *     3-tier resolver's cache so model removal hands off cleanly).
 *
 * NOT in C2 (later phases):
 *   • Sockets (C4)
 *   • Selection / hover visuals (C5)
 *   • Right-click / re-anchor / branching UI (C6, C7)
 *   • Highlight colour, global scale UI (C9 — globalScale already
 *     read from state but the slider is wired in C9)
 *
 * Data flow:
 *   state.cables changes → _refreshAll rebuilds geometry
 *   sceneCore tick → _tickAnchorRefresh updates positions in place
 */

import state    from '../core/state.js';
import sceneCore from '../core/scene.js';
import * as clock from '../core/clock.js';
import { resolveNodeWorldPosition, listCables } from './cables.js';
import { socketActualSize, cableEffectiveRadius } from './actions.js';
import steps from './steps.js';   // for object3dById fallback in anchor resolution

// ─── Module state ────────────────────────────────────────────────────────

let _cableRoot       = null;        // THREE.Group on sceneCore.scene
let _cableSubgroups  = new Map();   // cableId → { group, points: [meshes], segments: [meshes] }
let _tickUnsub       = null;
let _initialised     = false;

// Geometry templates (created once, reused via clone)
let _UNIT_CYLINDER   = null;        // CylinderGeometry(1, 1, 1, 12) — scaled per-segment
let _UNIT_SPHERE     = null;        // SphereGeometry(1, 16, 16)     — scaled per-point
let _UNIT_BOX        = null;        // BoxGeometry(1, 1, 1)          — scaled per-socket

// ─── Init ────────────────────────────────────────────────────────────────

/**
 * Mount CableRoot on the scene and start the per-frame ticker.
 * Idempotent. Called from main.js after sceneCore is up.
 */
export function initCableRender() {
  if (_initialised) return;
  if (typeof window === 'undefined' || !window.THREE) {
    console.warn('[cables-render] THREE not available — render disabled.');
    return;
  }
  if (!sceneCore?.scene) {
    console.warn('[cables-render] sceneCore.scene missing — call sceneCore.init first.');
    return;
  }

  _UNIT_CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false);
  _UNIT_SPHERE   = new THREE.SphereGeometry(1, 16, 16);
  _UNIT_BOX      = new THREE.BoxGeometry(1, 1, 1);

  _cableRoot = new THREE.Group();
  _cableRoot.name = 'CableRoot';
  sceneCore.scene.add(_cableRoot);

  // Rebuild on data changes — covers create / delete / property edits.
  state.on('change:cables',              _refreshAll);
  state.on('change:cableGlobalScale',    _refreshAll);
  state.on('change:cableGlobalRadius',   _refreshAll);
  state.on('change:cableHighlightColor', _refreshAll);

  // Phase A: re-apply per-point selection highlight on selection change.
  // Cheap — no geometry rebuild, just material emissive flips.
  state.on('change:selectedCablePoint',  _applySelectionHighlight);
  state.on('change:selectedCablePoints', _applySelectionHighlight);   // V0.3.0.119 multi
  // V0.3.0.120 — selected-cable node markers (emissive + on-top now; the per-frame
  // tick rescales them via _pointScaleFor, so request a render to kick it).
  state.on('change:selectedCableId', () => { _applySelectionHighlight(); sceneCore.requestRender?.(); });
  // E2: same for socket selection.
  state.on('change:selectedCableSocket', _applySelectionHighlight);

  // Per-frame anchor sync — folds into existing render loop, no new rAF.
  _tickUnsub = sceneCore.addTickHook(_tickAnchorRefresh);

  _initialised = true;
  _refreshAll();
}

/**
 * Phase A: returns every cable-point sphere mesh as a flat array, for
 * use as a raycast target list in main.js. Empty when render isn't
 * initialised or no cables exist. Mesh `userData` carries `{ cableId,
 * nodeId }` set by `_rebuildCable`.
 */
export function getCablePointMeshes() {
  const out = [];
  for (const entry of _cableSubgroups.values()) {
    for (const m of entry.points) out.push(m);
  }
  return out;
}

/**
 * Phase D: returns every cable-segment cylinder mesh as a flat array.
 * Mesh `userData` carries `{ cableId, fromNodeId, toNodeId }`. Used
 * by main.js to drive a "Insert point here" right-click on a segment.
 */
export function getCableSegmentMeshes() {
  const out = [];
  for (const entry of _cableSubgroups.values()) {
    for (const m of entry.segments) out.push(m);
  }
  return out;
}

/**
 * E2: returns every cable-socket box mesh as a flat array. Mesh
 * `userData` carries `{ cableId, nodeId, kind:'socket' }`. Used for
 * socket-pick raycasting in main.js.
 */
export function getCableSocketMeshes() {
  const out = [];
  for (const entry of _cableSubgroups.values()) {
    for (const m of (entry.sockets || [])) out.push(m);
  }
  return out;
}

// ─── Cable phase animation (H1) ──────────────────────────────────────────
//
// Per-step transitions for cable visibility (opacity fade) and colour
// (lerp). Driven by steps.js' phase runner — at the start of the
// 'cable' phase it calls beginCableTransitions(toSnap, durationMs,
// easeFn, onDone). The runner awaits onDone to know when to move on.
//
// During the transition we override material opacity + colour
// directly. _refreshAll on completion (or via state.cables update)
// resyncs to the cable's final state.

let _cableTransitions = new Map();    // cableId → transition record
let _cableTransitionDoneCb = null;

export function beginCableTransitions(toCablesSnap, durationMs, easeFn, onDone) {
  // Resolve any in-flight transition so a prior phase await unblocks.
  if (_cableTransitionDoneCb) {
    const prev = _cableTransitionDoneCb;
    _cableTransitionDoneCb = null;
    prev();
  }
  _cableTransitions.clear();

  const startMs = clock.now();
  const cables  = listCables();
  const highlightColor = state.get('cableHighlightColor') ?? '#22d3ee';

  for (const cable of cables) {
    const fromVisible   = cable.visible !== false;
    const toEntry       = toCablesSnap?.[cable.id];
    const toVisible     = toEntry?.visible   !== undefined ? !!toEntry.visible   : fromVisible;
    const fromHighlight = !!cable.highlight;
    const toHighlight   = toEntry?.highlight !== undefined ? !!toEntry.highlight : fromHighlight;
    const baseColor     = cable.style?.color ?? '#ffb24a';
    const fromColorHex  = fromHighlight ? highlightColor : baseColor;
    const toColorHex    = toHighlight   ? highlightColor : baseColor;

    // V0.3.0.126 (cable morph) — FREE-node position lerp. FROM = live
    // node.position (captured now, before applyStepSnapshot sets TO on
    // step:applied); TO = snapshot. Only nodes that actually move are kept.
    let fromPos = null, toPos = null, hasPos = false;
    const toNodes = toEntry?.nodes;
    if (toNodes && typeof toNodes === 'object') {
      for (const n of (cable.nodes || [])) {
        if (n.anchorType !== 'free' || !Array.isArray(n.position)) continue;
        const tp = toNodes[n.id];
        if (!Array.isArray(tp)) continue;
        const fp = n.position;
        if (Math.abs(fp[0] - tp[0]) < 1e-4 && Math.abs(fp[1] - tp[1]) < 1e-4
            && Math.abs(fp[2] - tp[2]) < 1e-4) continue;
        if (!fromPos) { fromPos = new Map(); toPos = new Map(); }
        fromPos.set(n.id, fp.slice());
        toPos.set(n.id, tp.slice());
        hasPos = true;
      }
    }

    if (fromVisible === toVisible && fromColorHex === toColorHex && !hasPos) continue;

    _cableTransitions.set(cable.id, {
      fromOpacity: fromVisible ? 1 : 0,
      toOpacity:   toVisible   ? 1 : 0,
      fromColor:   new THREE.Color(fromColorHex),
      toColor:     new THREE.Color(toColorHex),
      fromPos, toPos, hasPos,
      startMs, durationMs, easeFn,
    });
  }

  // Seed initial material state so frame 0 of the lerp is correct.
  // Materials are born transparent in _rebuildCable so we just nudge
  // opacity / colour here.
  for (const [cableId, t] of _cableTransitions) {
    const entry = _cableSubgroups.get(cableId);
    if (!entry) continue;
    entry.group.visible = true;   // force on for the fade window
    for (const m of entry.points)   { m.material.opacity = t.fromOpacity; m.material.color.copy(t.fromColor); }
    for (const m of entry.segments) { m.material.opacity = t.fromOpacity; m.material.color.copy(t.fromColor); }
    for (const m of (entry.sockets || [])) { m.material.opacity = t.fromOpacity; }
  }

  if (_cableTransitions.size === 0) {
    if (onDone) onDone();
    return;
  }
  _cableTransitionDoneCb = onDone || null;
}

/**
 * H1 snap: for snapCurrentToFinal — fast-forward all in-flight cable
 * transitions to their target state and resolve the done callback.
 */
export function snapCableTransitionsToFinal() {
  if (!_cableTransitions.size) {
    if (_cableTransitionDoneCb) {
      const cb = _cableTransitionDoneCb;
      _cableTransitionDoneCb = null;
      cb();
    }
    return;
  }
  for (const [cableId, t] of _cableTransitions) {
    const entry = _cableSubgroups.get(cableId);
    if (!entry) continue;
    for (const m of entry.points)   { m.material.opacity = t.toOpacity; m.material.color.copy(t.toColor); }
    for (const m of entry.segments) { m.material.opacity = t.toOpacity; m.material.color.copy(t.toColor); }
    for (const m of (entry.sockets || [])) { m.material.opacity = t.toOpacity; }
    entry._morphPos = null;   // V0.3.0.126 — drop morph; node.position is now TO (applyStepSnapshot)
  }
  _cableTransitions.clear();
  if (_cableTransitionDoneCb) {
    const cb = _cableTransitionDoneCb;
    _cableTransitionDoneCb = null;
    cb();
  }
}

function _advanceCableTransitions(nowMs) {
  if (!_cableTransitions.size) return;
  let allDone = true;
  for (const [cableId, t] of _cableTransitions) {
    const elapsed = nowMs - t.startMs;
    const raw     = Math.min(1, Math.max(0, elapsed / t.durationMs));
    const u       = t.easeFn ? t.easeFn(raw) : raw;
    const opacity = t.fromOpacity + (t.toOpacity - t.fromOpacity) * u;
    const color   = t.fromColor.clone().lerp(t.toColor, u);
    const entry   = _cableSubgroups.get(cableId);
    if (entry) {
      for (const m of entry.points)   { m.material.opacity = opacity; m.material.color.copy(color); }
      for (const m of entry.segments) { m.material.opacity = opacity; m.material.color.copy(color); }
      for (const m of (entry.sockets || [])) { m.material.opacity = opacity; }
      // V0.3.0.126 — lerped FREE-node positions for _tickAnchorRefresh to render
      // (it runs right after this in the same tick). Mesh/branch nodes are NOT
      // here, so the tick still resolves them live (auto-follow).
      if (t.hasPos && t.fromPos) {
        let mp = entry._morphPos;
        if (!mp) { mp = new Map(); entry._morphPos = mp; }
        for (const [nodeId, fp] of t.fromPos) {
          const tp = t.toPos.get(nodeId);
          mp.set(nodeId, new THREE.Vector3(
            fp[0] + (tp[0] - fp[0]) * u,
            fp[1] + (tp[1] - fp[1]) * u,
            fp[2] + (tp[2] - fp[2]) * u,
          ));
        }
      }
    }
    if (raw < 1) allDone = false;
  }
  if (allDone) {
    for (const [cableId] of _cableTransitions) {
      const entry = _cableSubgroups.get(cableId);
      if (entry) entry._morphPos = null;   // done → tick resolves live again (node.position now = TO)
    }
    _cableTransitions.clear();
    if (_cableTransitionDoneCb) {
      const cb = _cableTransitionDoneCb;
      _cableTransitionDoneCb = null;
      cb();
    }
  }
}

// ─── Insert-point ghost preview (Phase D follow-up) ──────────────────────
//
// During cable insert-pick mode, main.js calls setInsertHoverPosition
// with the current cursor's world raycast hit so the user sees where
// the new point would land. Yellow, semi-transparent, depthTest off
// so it's always visible. Sized from the target cable's radius.

let _insertHoverSphere = null;

export function setInsertHoverPosition(worldPos) {
  if (!_cableRoot || !window.THREE) return;
  if (!_insertHoverSphere) {
    _insertHoverSphere = new THREE.Mesh(
      _UNIT_SPHERE,
      new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        emissive: 0xfacc15,
        emissiveIntensity: 0.7,
        transparent: true,
        opacity: 0.75,
        depthTest: false,
      }),
    );
    _insertHoverSphere.renderOrder = 999;
    _insertHoverSphere.visible = false;
    _cableRoot.add(_insertHoverSphere);
  }
  if (!worldPos) {
    _insertHoverSphere.visible = false;
    return;
  }
  _insertHoverSphere.visible = true;
  _insertHoverSphere.position.copy(worldPos);
  // Size from the active insert target's cable so it visually matches
  // the host cable's points.
  const target = state.get('cableInsertPickingTarget');
  let radius = 3;
  if (target) {
    const c = listCables().find(x => x.id === target.cableId);
    radius = c?.style?.radius ?? 3;
  }
  _insertHoverSphere.scale.setScalar(radius * 1.4);
}

// ─── Full rebuild ────────────────────────────────────────────────────────

function _refreshAll() {
  if (!_cableRoot) return;
  // H1 guard: while a cable phase animation is in flight, defer the
  // full rebuild — _refreshAll tears down + recreates materials,
  // which would reset transparent/opacity in the middle of a fade.
  if (_cableTransitions.size > 0) return;
  const cables = listCables();
  const liveIds = new Set(cables.map(c => c.id));

  // Drop subgroups for cables that no longer exist.
  for (const [id, entry] of _cableSubgroups) {
    if (!liveIds.has(id)) {
      _disposeSubgroup(entry);
      _cableRoot.remove(entry.group);
      _cableSubgroups.delete(id);
    }
  }

  // Build / rebuild per-cable groups.
  for (const cable of cables) {
    let entry = _cableSubgroups.get(cable.id);
    if (!entry) {
      entry = { group: new THREE.Group(), points: [], segments: [], sockets: [] };
      entry.group.name = `Cable_${cable.id}`;
      _cableRoot.add(entry.group);
      _cableSubgroups.set(cable.id, entry);
    }
    _rebuildCable(cable, entry);
    entry.group.visible = cable.visible !== false;
  }

  // Phase A: re-apply emissive on the (possibly new) point materials.
  _applySelectionHighlight();
}

function _rebuildCable(cable, entry) {
  // Tear down existing geometry. The unit geometries are shared but
  // each mesh has a per-instance material to honour the cable's
  // colour / highlight; dispose materials only.
  for (const m of entry.points)   { m.material?.dispose?.(); entry.group.remove(m); }
  for (const m of entry.segments) { m.material?.dispose?.(); if (m.geometry && m.geometry !== _UNIT_CYLINDER) m.geometry.dispose?.(); entry.group.remove(m); }
  for (const m of (entry.sockets || [])) { m.material?.dispose?.(); entry.group.remove(m); }
  entry.points   = [];
  entry.segments = [];
  entry.sockets  = [];

  // ctx.object3dById = fallback lookup map for the cable resolver.
  // When node.object3d on a data-tree node is stale (e.g. after a relink
  // or model-source-bake desync), the resolver falls back to this map
  // before giving up to the cached worldPos.
  const ctx = {
    makeVec3:     (x, y, z) => new THREE.Vector3(x, y, z),
    object3dById: steps.object3dById,
  };
  const globalScale = state.get('cableGlobalScale') ?? 1.0;
  // Phase G: effective radius = cableGlobalRadius × per-cable size %.
  const radius      = cableEffectiveRadius(cable) * globalScale;
  const colorHex    = cable.highlight
    ? (state.get('cableHighlightColor') ?? '#22d3ee')
    : (cable.style?.color ?? '#ffb24a');
  const color = new THREE.Color(colorHex);
  entry._color = color;   // remembered for per-tick flexible-tube rebuilds

  // Resolve every node's current world position once. Side effect:
  // refreshes cachedWorldPos on the data so future step-jumps + missing
  // mesh handoffs are smooth.
  const positions = (cable.nodes || []).map(n => {
    const r = resolveNodeWorldPosition(n, ctx);
    return r.pos ? new THREE.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
  });

  // Point spheres — one per resolvable node. Unresolvable nodes
  // (anchorless + no cache) get skipped silently.
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (!p) continue;
    const sphere = new THREE.Mesh(
      _UNIT_SPHERE,
      new THREE.MeshStandardMaterial({
        color: color.clone(), metalness: 0.2, roughness: 0.6,
        // H1: born transparent so opacity tweens during the cable phase
        // engage the alpha pipeline immediately (flipping `transparent`
        // at runtime didn't take consistently in MeshStandardMaterial).
        transparent: true, opacity: 1,
      }),
    );
    sphere.position.copy(p);
    sphere.userData.cableId = cable.id;
    sphere.userData.nodeId  = cable.nodes[i].id;
    sphere.scale.setScalar(_pointScaleFor(cable.id, cable.nodes[i].id, radius));
    entry.group.add(sphere);
    entry.points.push(sphere);
  }

  // Cable body — one spline tube when flexible, else cheap cylinder segments.
  _buildSegments(cable, entry, positions, radius, color);

  // C5-E1: socket boxes — one per node that carries a socket. Sized
  // by socket.size, coloured by socket.color (independent of cable
  // colour / highlight), oriented by the host mesh's world quat
  // composed with socket.localQuaternion. Position offset by half-
  // depth along socket-local +Z so the back face touches the cable
  // point (matches schema doc + persistSocketFromVisual inverse math).
  for (let i = 0; i < (cable.nodes || []).length; i++) {
    const node = cable.nodes[i];
    if (!node?.socket) continue;
    const p = positions[i];
    if (!p) continue;
    const wq = _socketWorldQuat(node);
    if (!wq) continue;
    // Size = cable-radius * BASE_* * (percent / 100), with global scale.
    const actual = socketActualSize(cable, node.socket);
    const w = actual.w * globalScale;
    const h = actual.h * globalScale;
    const d = actual.d * globalScale;
    const sockColor = new THREE.Color(node.socket.color || '#ff9d57');
    const box = new THREE.Mesh(
      _UNIT_BOX,
      new THREE.MeshStandardMaterial({
        color: sockColor, metalness: 0.3, roughness: 0.5,
        transparent: true, opacity: 1,
      }),
    );
    box.scale.set(w, h, d);
    box.quaternion.copy(wq);
    // Centre offset: +d/2 along the socket's world +Z so the BACK face
    // (-Z in box-local) touches the cable point.
    // Front face touches the cable point; the box extends the other
     // way along its local +Z. With the IK shift on socket creation
     // (addCableSocket lifts the anchor by d along the normal), the
     // back face lands at the original anchored surface — the
     // "plugged in" look. Without that shift, the box renders inside
     // the surface, signalling that the user should move the point.
    const zWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(wq);
    box.position.copy(p).addScaledVector(zWorld, -d / 2);
    box.userData.cableId   = cable.id;
    box.userData.nodeId    = node.id;
    box.userData.kind      = 'socket';
    entry.group.add(box);
    entry.sockets.push(box);
  }
}

/**
 * Compute a socket's world-space quaternion. Mesh-anchored hosts
 * compose the mesh's world quat with socket.localQuaternion (or fall
 * back to a quaternion derived from node.normalLocal so a freshly-
 * added socket sits flush on the surface). Branch / free hosts use
 * socket.quaternion directly. Returns null when nothing is available
 * — caller skips that socket's render.
 */
function _socketWorldQuat(node) {
  const T = window.THREE;
  const sock = node.socket;
  if (!sock) return null;

  // Mesh-anchored: compose meshWorldQuat * (sock.localQuaternion or
  // a normal-derived default).
  if (node.anchorType === 'mesh' && node.nodeId) {
    const sceneNode = state.get('nodeById')?.get?.(node.nodeId);
    const obj = sceneNode?.object3d;
    if (!obj) return null;
    const meshQ = new T.Quaternion();
    obj.getWorldQuaternion(meshQ);
    if (Array.isArray(sock.localQuaternion) && sock.localQuaternion.length === 4) {
      const local = new T.Quaternion(
        sock.localQuaternion[0], sock.localQuaternion[1],
        sock.localQuaternion[2], sock.localQuaternion[3],
      );
      return meshQ.clone().multiply(local);
    }
    if (Array.isArray(node.normalLocal) && node.normalLocal.length === 3) {
      // Default: orient socket's local +Z to the surface normal so the
      // box "stands proud" of the face.
      const normalLocal = new T.Vector3(
        node.normalLocal[0], node.normalLocal[1], node.normalLocal[2],
      );
      const worldNormal = normalLocal.applyQuaternion(meshQ);
      const q = new T.Quaternion();
      q.setFromUnitVectors(new T.Vector3(0, 0, 1), worldNormal.clone().normalize());
      return q;
    }
    return meshQ;
  }

  // Branch / free hosts.
  if (Array.isArray(sock.quaternion) && sock.quaternion.length === 4) {
    return new T.Quaternion(
      sock.quaternion[0], sock.quaternion[1], sock.quaternion[2], sock.quaternion[3],
    );
  }
  return new T.Quaternion();   // identity fallback
}

/**
 * Position + orient a unit-length cylinder mesh between world-space
 * points a and b, stretched to length and scaled by radius. Centre
 * the cylinder on the midpoint; rotate so its native Y axis points
 * from a to b.
 */
function _poseCylinder(mesh, a, b, radius) {
  const dir  = new THREE.Vector3().subVectors(b, a);
  const len  = dir.length();
  if (len < 1e-6) {
    mesh.visible = false;   // degenerate — coincident endpoints
    return;
  }
  mesh.visible = true;
  const mid  = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  mesh.position.copy(mid);
  // Cylinder native is along Y; rotate Y → dir.
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  );
  mesh.scale.set(radius, len, radius);
}

// ── Flexible cables (V0.3.0.24): smooth spline tube through the nodes ────────

/** Socket emergence axis (world +Z) for a node, or null if it has no socket. */
function _socketAxis(node) {
  if (!node?.socket) return null;
  const wq = _socketWorldQuat(node);
  if (!wq) return null;
  return new THREE.Vector3(0, 0, 1).applyQuaternion(wq).normalize();
}

/**
 * CatmullRom curve through the resolvable node positions. A socketed ENDPOINT
 * gets a phantom control point a short way along its socket axis, so the cable
 * emerges/arrives straight out of the socket (plugged-in) before curving.
 */
function _buildFlexCurve(cable, positions) {
  const pts = [], idxs = [];
  for (let i = 0; i < positions.length; i++) {
    if (positions[i]) { pts.push(positions[i]); idxs.push(i); }
  }
  if (pts.length < 2) return null;
  const nodes = cable.nodes || [];
  const handleFrac = state.get('cableFlexHandle') ?? 0.4;
  const last = pts.length - 1;

  const ctrl = [pts[0]];
  const startAxis = _socketAxis(nodes[idxs[0]]);
  if (startAxis) ctrl.push(pts[0].clone().addScaledVector(startAxis, handleFrac * pts[0].distanceTo(pts[1])));
  for (let k = 1; k < last; k++) ctrl.push(pts[k]);
  const endAxis = _socketAxis(nodes[idxs[last]]);
  if (endAxis) ctrl.push(pts[last].clone().addScaledVector(endAxis, handleFrac * pts[last].distanceTo(pts[last - 1])));
  ctrl.push(pts[last]);

  return new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.5);
}

/** Tube mesh skinned along the flexible curve. */
function _makeFlexTube(curve, radius, color, cableId) {
  const segs = Math.min(240, Math.max(24, curve.points.length * 24));
  const mesh = new THREE.Mesh(
    new THREE.TubeGeometry(curve, segs, radius, 8, false),
    new THREE.MeshStandardMaterial({
      color: color.clone(), metalness: 0.2, roughness: 0.6, transparent: true, opacity: 1,
    }),
  );
  mesh.userData.cableId = cableId;
  mesh.userData.kind    = 'cableTube';
  return mesh;
}

/** Cheap change-detector for the per-tick: flexible flag + quantized positions. */
function _posHash(cable, positions) {
  let s = cable.flexible ? 'F' : 'S';
  for (const p of positions) s += p ? `|${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` : '|x';
  return s;
}

/** Build the cable BODY: one spline tube when flexible, else cylinder segments. */
function _buildSegments(cable, entry, positions, radius, color) {
  for (const m of entry.segments) {
    m.material?.dispose?.();
    if (m.geometry && m.geometry !== _UNIT_CYLINDER) m.geometry.dispose?.();
    entry.group.remove(m);
  }
  entry.segments   = [];
  entry._isFlexible = !!cable.flexible;
  if (cable.flexible) {
    const curve = _buildFlexCurve(cable, positions);
    if (curve) {
      const tube = _makeFlexTube(curve, radius, color, cable.id);
      entry.group.add(tube);
      entry.segments.push(tube);
    }
    entry._posHash = _posHash(cable, positions);
  } else {
    for (let i = 0; i < positions.length - 1; i++) {
      const a = positions[i], b = positions[i + 1];
      if (!a || !b) continue;
      const seg = new THREE.Mesh(_UNIT_CYLINDER, new THREE.MeshStandardMaterial({
        color: color.clone(), metalness: 0.2, roughness: 0.6, transparent: true, opacity: 1,
      }));
      _poseCylinder(seg, a, b, radius);
      seg.userData.cableId    = cable.id;
      seg.userData.fromNodeId = cable.nodes[i].id;
      seg.userData.toNodeId   = cable.nodes[i + 1].id;
      entry.group.add(seg);
      entry.segments.push(seg);
    }
  }
}

/**
 * Phase A: walk every point mesh and apply selection highlight —
 * emissive on the selected sphere, zero on the rest. Fires on
 * change:selectedCablePoint and at the end of _refreshAll. Scale
 * boost is applied by _tickAnchorRefresh (which also handles per-
 * frame radius rewrites) so we don't fight it here.
 */
const _SELECT_EMISSIVE = new THREE.Color('#22d3ee');
const _MARKER_EMISSIVE = new THREE.Color('#0ea5e9');   // V0.3.0.120 — node pick markers
function _applySelectionHighlight() {
  const selPt   = state.get('selectedCablePoint');
  const selSock = state.get('selectedCableSocket');
  // V0.3.0.119 — highlight EVERY multi-selected point, not just the primary.
  const selSet  = new Set((state.get('selectedCablePoints') || []).map(p => `${p.cableId}:${p.nodeId}`));
  // V0.3.0.120 — the selected cable's nodes ALL get a visible, always-on-top
  // marker so they're easy to see + pick (cable nodes are otherwise tiny).
  const markerCableId = state.get('selectedCableId');
  for (const entry of _cableSubgroups.values()) {
    for (const m of entry.points) {
      const mat = m.material;
      if (!mat?.emissive) continue;
      const isPicked = selSet.has(`${m.userData.cableId}:${m.userData.nodeId}`)
        || (selPt && m.userData.cableId === selPt.cableId && m.userData.nodeId === selPt.nodeId);
      const isMarker = markerCableId && m.userData.cableId === markerCableId;
      if (isPicked) {
        mat.emissive.copy(_SELECT_EMISSIVE);
        mat.emissiveIntensity = 0.9;
      } else if (isMarker) {
        mat.emissive.copy(_MARKER_EMISSIVE);
        mat.emissiveIntensity = 0.55;
      } else {
        mat.emissive.setRGB(0, 0, 0);
        mat.emissiveIntensity = 0;
      }
      // Markers + picked nodes render ON TOP (depthTest off) so they show through
      // the model and are always clickable; others render normally.
      const onTop = isPicked || isMarker;
      mat.depthTest = !onTop;
      m.renderOrder = onTop ? 9000 : 0;
    }
    for (const m of (entry.sockets || [])) {
      const mat = m.material;
      if (!mat?.emissive) continue;
      const isSel = selSock && m.userData.cableId === selSock.cableId && m.userData.nodeId === selSock.nodeId;
      if (isSel) {
        mat.emissive.copy(_SELECT_EMISSIVE);
        mat.emissiveIntensity = 0.6;
      } else {
        mat.emissive.setRGB(0, 0, 0);
        mat.emissiveIntensity = 0;
      }
    }
  }
}

/** Multiplier for the selected point's sphere — applied in tick + rebuild. */
function _pointScaleFor(cableId, nodeId, baseRadius) {
  const sel = state.get('selectedCablePoint');
  const inMulti = (state.get('selectedCablePoints') || [])
    .some(p => p.cableId === cableId && p.nodeId === nodeId);   // V0.3.0.119
  const isSel = inMulti || (sel && sel.cableId === cableId && sel.nodeId === nodeId);
  // V0.3.0.120 — every node of the SELECTED cable inflates into a pick marker so
  // it's easy to see/grab; the picked node(s) inflate the most. Use a floor so the
  // marker is visible even on a very thin cable.
  const isMarker = state.get('selectedCableId') === cableId;
  if (isSel)     return Math.max(baseRadius * 1.8, baseRadius + 6);
  if (isMarker)  return Math.max(baseRadius * 1.5, baseRadius + 4);
  return baseRadius;  // unselected = exactly the cable radius
}

function _disposeSubgroup(entry) {
  for (const m of entry.points)   m.material?.dispose?.();
  for (const m of entry.segments) m.material?.dispose?.();
  for (const m of (entry.sockets || [])) m.material?.dispose?.();
  entry.points   = [];
  entry.segments = [];
  entry.sockets  = [];
}

// ─── Per-frame anchor refresh ────────────────────────────────────────────

/**
 * On every tick, walk mesh-anchored nodes (and branch-start nodes
 * that recurse onto them) and update their visuals in place. We
 * skip the heavy geometry rebuild path — just reposition / scale
 * the existing meshes. If a cable has no mesh-anchored nodes (all
 * free), the work is essentially a couple of map lookups per cable.
 *
 * Optimisation seam for later: a matrixWorld signature check per
 * anchor mesh would skip the work entirely when nothing moved.
 * Today it's cheap enough not to matter at typical cable counts.
 */
function _tickAnchorRefresh() {
  // H1: drive any in-flight cable phase animations first so they advance
  // even when no cables exist yet (e.g. brand-new project) wouldn't
  // matter, but the size check below would skip — keep it ahead.
  _advanceCableTransitions(clock.now());

  if (!_cableRoot || _cableSubgroups.size === 0) return;
  const cables = listCables();
  if (!cables.length) return;
  // ctx.object3dById = fallback for anchor resolution when node.object3d
  // is stale; see cables.js resolveNodeWorldPosition for the failover.
  const ctx = {
    makeVec3:     (x, y, z) => new THREE.Vector3(x, y, z),
    object3dById: steps.object3dById,
  };
  const globalScale = state.get('cableGlobalScale') ?? 1.0;

  for (const cable of cables) {
    const entry = _cableSubgroups.get(cable.id);
    if (!entry) continue;
    if (!entry.group.visible) continue;   // skip hidden cables

    const radius = cableEffectiveRadius(cable) * globalScale;
    // V0.3.0.126 — during a cable-shape transition, _advanceCableTransitions (run
    // at the top of this tick) parks lerped FREE-node positions in entry._morphPos.
    // Use them so the tube morphs; mesh/branch nodes still resolve live (follow).
    const morph = entry._morphPos;
    const positions = (cable.nodes || []).map(n => {
      if (morph && n.anchorType === 'free' && morph.has(n.id)) return morph.get(n.id).clone();
      const r = resolveNodeWorldPosition(n, ctx);
      return r.pos ? new THREE.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
    });

    // Reposition point spheres in lock-step with the resolver output.
    // (Geometry stays — only transforms change.)
    for (let i = 0; i < entry.points.length && i < positions.length; i++) {
      const p = positions[i];
      const sphere = entry.points[i];
      if (!p) { sphere.visible = false; continue; }
      sphere.visible = true;
      sphere.position.copy(p);
      sphere.scale.setScalar(_pointScaleFor(sphere.userData.cableId, sphere.userData.nodeId, radius));
    }

    // Cable body. Flexible: rebuild the spline tube when the flexible flag flips
    // or the path moves (cheap hash gate avoids per-frame rebuilds when static).
    // Straight: just re-pose the cheap cylinders.
    if (cable.flexible || entry._isFlexible) {
      const hash = _posHash(cable, positions);
      if (cable.flexible !== entry._isFlexible || hash !== entry._posHash) {
        _buildSegments(cable, entry, positions, radius, entry._color || new THREE.Color('#ffb24a'));
      }
    } else {
      for (let i = 0; i < entry.segments.length; i++) {
        const a = positions[i];
        const b = positions[i + 1];
        const seg = entry.segments[i];
        if (!a || !b) { seg.visible = false; continue; }
        _poseCylinder(seg, a, b, radius);
      }
    }

    // C5-E1: re-pose socket boxes so they ride the host mesh as it
    // animates. Lookup by userData.nodeId since sockets aren't 1:1
    // indexed against entry.points (only nodes with a socket exist).
    if (entry.sockets && entry.sockets.length) {
      const T = window.THREE;
      for (const box of entry.sockets) {
        const idx = (cable.nodes || []).findIndex(n => n.id === box.userData.nodeId);
        if (idx < 0) { box.visible = false; continue; }
        const node = cable.nodes[idx];
        const p    = positions[idx];
        if (!p || !node?.socket) { box.visible = false; continue; }
        const wq = _socketWorldQuat(node);
        if (!wq) { box.visible = false; continue; }
        const actual = socketActualSize(cable, node.socket);
        const w = actual.w * globalScale;
        const h = actual.h * globalScale;
        const d = actual.d * globalScale;
        box.visible = true;
        box.scale.set(w, h, d);
        box.quaternion.copy(wq);
        const zWorld = new T.Vector3(0, 0, 1).applyQuaternion(wq);
        box.position.copy(p).addScaledVector(zWorld, -d / 2);
      }
    }
  }
}

// ─── Teardown (called on scene reset; rarely used) ───────────────────────

export function disposeCableRender() {
  if (_tickUnsub) { _tickUnsub(); _tickUnsub = null; }
  for (const entry of _cableSubgroups.values()) {
    _disposeSubgroup(entry);
    _cableRoot?.remove(entry.group);
  }
  _cableSubgroups.clear();
  if (_cableRoot) {
    sceneCore.scene?.remove(_cableRoot);
    _cableRoot = null;
  }
  _UNIT_CYLINDER?.dispose?.(); _UNIT_CYLINDER = null;
  _UNIT_SPHERE?.dispose?.();   _UNIT_SPHERE   = null;
  _UNIT_BOX?.dispose?.();      _UNIT_BOX      = null;
  _initialised = false;
}
