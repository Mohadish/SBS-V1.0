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
import { resolveNodeWorldPosition, listCables } from './cables.js';

// ─── Module state ────────────────────────────────────────────────────────

let _cableRoot       = null;        // THREE.Group on sceneCore.scene
let _cableSubgroups  = new Map();   // cableId → { group, points: [meshes], segments: [meshes] }
let _tickUnsub       = null;
let _initialised     = false;

// Geometry templates (created once, reused via clone)
let _UNIT_CYLINDER   = null;        // CylinderGeometry(1, 1, 1, 12) — scaled per-segment
let _UNIT_SPHERE     = null;        // SphereGeometry(1, 16, 16)     — scaled per-point

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

  _cableRoot = new THREE.Group();
  _cableRoot.name = 'CableRoot';
  sceneCore.scene.add(_cableRoot);

  // Rebuild on data changes — covers create / delete / property edits.
  state.on('change:cables',              _refreshAll);
  state.on('change:cableGlobalScale',    _refreshAll);
  state.on('change:cableHighlightColor', _refreshAll);

  // Phase A: re-apply per-point selection highlight on selection change.
  // Cheap — no geometry rebuild, just material emissive flips.
  state.on('change:selectedCablePoint',  _applySelectionHighlight);

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

// ─── Full rebuild ────────────────────────────────────────────────────────

function _refreshAll() {
  if (!_cableRoot) return;
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
      entry = { group: new THREE.Group(), points: [], segments: [] };
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
  for (const m of entry.segments) { m.material?.dispose?.(); entry.group.remove(m); }
  entry.points   = [];
  entry.segments = [];

  const ctx = { makeVec3: (x, y, z) => new THREE.Vector3(x, y, z) };
  const globalScale = state.get('cableGlobalScale') ?? 1.0;
  const radius      = (cable.style?.radius ?? 3) * globalScale;
  const colorHex    = cable.highlight
    ? (state.get('cableHighlightColor') ?? '#22d3ee')
    : (cable.style?.color ?? '#ffb24a');
  const color = new THREE.Color(colorHex);

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
      new THREE.MeshStandardMaterial({ color: color.clone(), metalness: 0.2, roughness: 0.6 }),
    );
    sphere.position.copy(p);
    sphere.userData.cableId = cable.id;
    sphere.userData.nodeId  = cable.nodes[i].id;
    sphere.scale.setScalar(_pointScaleFor(cable.id, cable.nodes[i].id, radius));
    entry.group.add(sphere);
    entry.points.push(sphere);
  }

  // Cylinder segments — one between each consecutive resolvable pair.
  // We use a unit-height cylinder oriented along Y and stretch via
  // scale.y so per-tick updates are cheap (no geometry rebuild).
  for (let i = 0; i < positions.length - 1; i++) {
    const a = positions[i];
    const b = positions[i + 1];
    if (!a || !b) continue;
    const seg = new THREE.Mesh(
      _UNIT_CYLINDER,
      new THREE.MeshStandardMaterial({ color: color.clone(), metalness: 0.2, roughness: 0.6 }),
    );
    _poseCylinder(seg, a, b, radius);
    seg.userData.cableId    = cable.id;
    seg.userData.fromNodeId = cable.nodes[i].id;
    seg.userData.toNodeId   = cable.nodes[i + 1].id;
    entry.group.add(seg);
    entry.segments.push(seg);
  }
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

/**
 * Phase A: walk every point mesh and apply selection highlight —
 * emissive on the selected sphere, zero on the rest. Fires on
 * change:selectedCablePoint and at the end of _refreshAll. Scale
 * boost is applied by _tickAnchorRefresh (which also handles per-
 * frame radius rewrites) so we don't fight it here.
 */
const _SELECT_EMISSIVE = new THREE.Color('#22d3ee');
function _applySelectionHighlight() {
  const sel = state.get('selectedCablePoint');
  for (const entry of _cableSubgroups.values()) {
    for (const m of entry.points) {
      const mat = m.material;
      if (!mat?.emissive) continue;
      const isSel = sel && m.userData.cableId === sel.cableId && m.userData.nodeId === sel.nodeId;
      if (isSel) {
        mat.emissive.copy(_SELECT_EMISSIVE);
        mat.emissiveIntensity = 0.9;
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
  const isSel = sel && sel.cableId === cableId && sel.nodeId === nodeId;
  return baseRadius * (isSel ? 1.4 : 1.1);
}

function _disposeSubgroup(entry) {
  for (const m of entry.points)   m.material?.dispose?.();
  for (const m of entry.segments) m.material?.dispose?.();
  entry.points   = [];
  entry.segments = [];
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
  if (!_cableRoot || _cableSubgroups.size === 0) return;
  const cables = listCables();
  if (!cables.length) return;
  const ctx = { makeVec3: (x, y, z) => new THREE.Vector3(x, y, z) };
  const globalScale = state.get('cableGlobalScale') ?? 1.0;

  for (const cable of cables) {
    const entry = _cableSubgroups.get(cable.id);
    if (!entry) continue;
    if (!entry.group.visible) continue;   // skip hidden cables

    const radius = (cable.style?.radius ?? 3) * globalScale;
    const positions = (cable.nodes || []).map(n => {
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

    // Reposition segments. positions[i] / positions[i+1] for segment i.
    for (let i = 0; i < entry.segments.length; i++) {
      const a = positions[i];
      const b = positions[i + 1];
      const seg = entry.segments[i];
      if (!a || !b) { seg.visible = false; continue; }
      _poseCylinder(seg, a, b, radius);
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
  _initialised = false;
}
