/**
 * SBS Step Browser — Flat Shapes (Phase 1)
 * ============================================
 * Library + instance pipeline for 2D polygons mounted in 3D.
 *
 *   ShapeTemplate          (state.shapeTemplates) — { id, name, fill, polygon }
 *   FlatShape tree node    (type='flatShape')      — { templateId, transforms… }
 *
 * Geometry is built from the TEMPLATE's polygon. Instances carry the
 * world-space pose (the plane the user drew on at create time) via the
 * standard localOffset / localQuaternion fields, so the gizmo works
 * out of the box. See ui/shape-editor.js for the viewport draw flow.
 *
 * Polygon coordinates are PLANE-LOCAL 2D — the editor projects each
 * world-space click onto a plane basis (qx, qy at the plane origin)
 * before storing. Mounting puts geometry at Z=0 in instance-local space;
 * the instance's quaternion brings the plane back to world.
 */

import state                          from '../core/state.js';
import { generateId }                  from '../core/schema.js';
import { applyNodeTransformToObject3D } from '../core/transforms.js';
import { materials }                   from './materials.js';

// ─────────────────────────────────────────────────────────────────────────
//  GEOMETRY BUILDER
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compose a list of input polygons into the XOR result polygon — the
 * standard polygon-clipping multi-polygon shape:
 *   [ polygon, polygon, … ]    where polygon = [ ring, hole, hole, … ]
 *                              and ring/hole = [ [x,y], [x,y], … ]
 *
 * Used both at mesh-build time and at editor preview time. Falls back
 * gracefully when polygon-clipping isn't available (returns the input
 * polygons as-is, so a single-polygon template still renders).
 */
export function xorPolygonList(polygons) {
  const PC = window.polygonClipping;
  if (!PC?.xor) {
    // No lib loaded — best-effort: just return the list as-is, formatted
    // for ShapeGeometry consumption (each entry's outer + holes).
    return (polygons || [])
      .filter(p => p?.outer?.length >= 3)
      .map(p => [p.outer, ...(p.holes || []).filter(h => h?.length >= 3)]);
  }
  // polygon-clipping wants closed rings, but it tolerates open rings too.
  // Each input polygon → MultiPolygon-of-one (= [[ring]]).
  const inputs = (polygons || [])
    .filter(p => p?.outer?.length >= 3)
    .map(p => [[p.outer, ...(p.holes || []).filter(h => h?.length >= 3)]]);
  if (inputs.length === 0) return [];
  if (inputs.length === 1) {
    // No XOR needed — single polygon. Return its rings.
    return inputs[0];
  }
  // Apply XOR cumulatively: a ⊕ b ⊕ c ⊕ …
  let acc = inputs[0];
  for (let i = 1; i < inputs.length; i++) {
    try { acc = PC.xor(acc, inputs[i]); }
    catch (e) {
      console.warn('[flat-shapes] polygon-clipping XOR failed:', e);
      return inputs[0];   // bail to first polygon on numerical issues
    }
  }
  return acc;
}

/**
 * Build a flat THREE.Mesh from a list of input polygons + fill, with
 * the drawing-plane orientation BAKED INTO the geometry vertices.
 *
 * The list is XOR-ed via polygon-clipping, then the resulting multi-
 * polygon is materialised as an array of THREE.Shape (each with its own
 * holes) and tessellated by a single ShapeGeometry call.
 *
 * Why bake the plane: keeping baseLocalQuaternion at identity makes the
 * gizmo's rotation math behave exactly like a folder's (no axis-swap
 * caused by a non-identity base quaternion). The 2D points are placed
 * at z=0, then rotated by `planeQuat` in 3D — so the mesh sits on the
 * picked face's plane in world without needing the mesh's own
 * quaternion to do any work.
 *
 * @param {Array<{outer:number[][], holes:number[][][]}>} polygons
 * @param {string}   fill                                 hex colour
 * @param {number[]} [planeQuat=[0,0,0,1]]                parent-local plane orientation
 * @returns {THREE.Mesh|null}
 */
export function buildFlatShapeMesh(polygons, fill, planeQuat = [0, 0, 0, 1]) {
  const T = window.THREE;
  if (!T) return null;
  const list = Array.isArray(polygons) ? polygons : [];
  if (list.length === 0) return null;

  const composed = xorPolygonList(list);
  if (!composed.length) return null;

  // Each composed polygon → THREE.Shape with optional holes.
  const shapes = [];
  for (const poly of composed) {
    if (!poly || !poly.length) continue;
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    const shape = new T.Shape();
    shape.moveTo(outer[0][0], outer[0][1]);
    for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i][0], outer[i][1]);
    shape.closePath();
    for (let h = 1; h < poly.length; h++) {
      const hole = poly[h];
      if (!hole || hole.length < 3) continue;
      const path = new T.Path();
      path.moveTo(hole[0][0], hole[0][1]);
      for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], hole[i][1]);
      path.closePath();
      shape.holes.push(path);
    }
    shapes.push(shape);
  }
  if (!shapes.length) return null;

  const geom = new T.ShapeGeometry(shapes);

  // Bake the plane rotation into the vertex positions.
  const [qx, qy, qz, qw] = planeQuat;
  if (Math.abs(qx) + Math.abs(qy) + Math.abs(qz) > 1e-7) {
    const m = new T.Matrix4().makeRotationFromQuaternion(
      new T.Quaternion(qx, qy, qz, qw),
    );
    geom.applyMatrix4(m);
    geom.computeVertexNormals?.();
  }

  const mat = new T.MeshBasicMaterial({
    color:       new T.Color(fill || '#cccccc'),
    side:        T.DoubleSide,
    transparent: true,
    opacity:     1.0,
    depthWrite:  true,
  });
  return new T.Mesh(geom, mat);
}

/**
 * Read a template's polygons, applying the legacy single-polygon
 * migration in-place. Old templates stored `polygon: {outer, holes}`;
 * new ones store `polygons: [{outer, holes}, …]`. This helper makes the
 * caller's life simple — always returns an array.
 */
export function ensureTemplatePolygons(tpl) {
  if (!tpl) return [];
  if (Array.isArray(tpl.polygons) && tpl.polygons.length) return tpl.polygons;
  if (tpl.polygon && Array.isArray(tpl.polygon.outer) && tpl.polygon.outer.length) {
    tpl.polygons = [{
      outer: tpl.polygon.outer.map(p => [p[0], p[1]]),
      holes: (tpl.polygon.holes || []).map(h => h.map(p => [p[0], p[1]])),
    }];
    delete tpl.polygon;
    return tpl.polygons;
  }
  tpl.polygons = [{ outer: [], holes: [] }];
  return tpl.polygons;
}

/**
 * Compute a [minX, minY, maxX, maxY] bbox for a polygon.
 */
export function bboxFromPolygon(polygon) {
  const outer = polygon?.outer ?? [];
  if (!outer.length) return null;
  let minX =  Infinity, minY =  Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outer) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}


// ─────────────────────────────────────────────────────────────────────────
//  MOUNT LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build (if needed) and return the THREE.Mesh for a flatShape node.
 * Idempotent — reuses node.object3d if already built. Looks up the
 * referenced template from state to source polygon + fill. Tags userData
 * so picking + selection identify the right tree node.
 *
 * Disposes-and-rebuilds when the cached mesh is stale (template polygon
 * or fill changed since last build) — detected via a signature on
 * userData.shapeBuildKey.
 *
 * @param {TreeNode} node    flatShape data node (must have templateId)
 * @returns {THREE.Mesh|null}
 */
export function ensureFlatShapeObject3D(node) {
  if (!node || node.type !== 'flatShape') return null;
  if (!node.templateId) return null;

  // ── Legacy migration ─────────────────────────────────────────────────
  // Earlier builds stored the plane orientation in baseLocalQuaternion.
  // That broke the gizmo (axis-swap on rotation) because non-identity
  // baseQ makes parent-local axes not equal object-local axes. Now the
  // plane goes into geometry, baseQ stays identity. Detect old data and
  // migrate in place.
  if (!Array.isArray(node.planeLocalQuaternion)) {
    const baseQ = node.baseLocalQuaternion;
    const isIdentity = !Array.isArray(baseQ)
      || (Math.abs(baseQ[0]) + Math.abs(baseQ[1]) + Math.abs(baseQ[2]) < 1e-7
          && Math.abs((baseQ[3] ?? 1) - 1) < 1e-7);
    node.planeLocalQuaternion = isIdentity ? [0, 0, 0, 1] : [...baseQ];
    if (!isIdentity) node.baseLocalQuaternion = [0, 0, 0, 1];
  }

  const tpl = _lookupTemplate(node.templateId);
  if (!tpl) return null;
  const polygons = ensureTemplatePolygons(tpl);

  const sig = _buildKey(tpl, polygons, node.planeLocalQuaternion);
  const existing = node.object3d;
  if (existing && existing.userData?.shapeBuildKey === sig) return existing;

  // Stale or missing — rebuild.
  if (existing) {
    if (existing.parent) existing.parent.remove(existing);
    existing.geometry?.dispose?.();
    existing.material?.dispose?.();
    node.object3d = null;
  }

  const mesh = buildFlatShapeMesh(polygons, tpl.fill, node.planeLocalQuaternion);
  if (!mesh) return null;
  mesh.name = node.name || tpl.name || 'Shape';
  mesh.userData.flatShapeNodeId = node.id;
  mesh.userData.meshNodeId      = node.id;   // enables raycast → selection
  mesh.userData.nodeId          = node.id;
  mesh.userData.shapeBuildKey   = sig;
  node.object3d = mesh;
  // Register with the materials map so step transitions can detect
  // visibility changes on this node (materials.meshById is what
  // _prepareVisibility iterates). Without this, flatShapes silently
  // skip every hide/show transition. Re-registers idempotently after
  // rebuilds — the latest Mesh wins.
  materials?.registerMesh?.(node.id, mesh);
  return mesh;
}

/**
 * Walk every flatShape instance in the live tree and force-rebuild its
 * mesh from the (now-updated) template. Called by actions when a
 * template's polygon or fill changes so every instance ripples
 * immediately.
 *
 * The rebuilt THREE.Mesh starts at the default pose (origin / identity);
 * we re-apply the node's transform afterward so the shape stays put
 * (and survives a step navigation that would otherwise reapply the
 * stale node transform onto a freshly-placed mesh).
 *
 * @param {TreeNode} root         live tree root
 * @param {Map}      object3dById steps.object3dById
 * @param {string}   templateId   template that was edited
 */
export function rebuildInstancesOfTemplate(root, object3dById, templateId) {
  if (!root || !templateId) return;
  // Build a parent-id index so we can recover the Three.js parent even
  // when the instance currently has no live mesh (e.g. the polygon was
  // just wiped to empty by a "New shape" mid-edit). Without this, the
  // new mesh would be built but never parented and silently disappear.
  const parentById = new Map();
  (function walk(node, parentId) {
    if (parentId !== null) parentById.set(node.id, parentId);
    for (const c of (node.children || [])) walk(c, node.id);
  })(root, null);

  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'flatShape' && n.templateId === templateId) {
      const oldMesh = n.object3d;
      // Capture the parent BEFORE disposal — fall back to the data-tree
      // parent's object3d when the old mesh isn't attached anywhere.
      let parent = oldMesh?.parent ?? null;
      if (!parent) {
        const pid = parentById.get(n.id);
        if (pid && object3dById) parent = object3dById.get(pid) ?? null;
      }
      if (oldMesh) {
        if (oldMesh.parent) oldMesh.parent.remove(oldMesh);
        oldMesh.geometry?.dispose?.();
        oldMesh.material?.dispose?.();
        n.object3d = null;
      }
      const newMesh = ensureFlatShapeObject3D(n);
      if (newMesh) {
        if (parent) parent.add(newMesh);
        if (object3dById) object3dById.set(n.id, newMesh);
        // Restore the instance's pose onto the fresh mesh — without this
        // the shape jumps to parent-local origin until the next
        // applyAllTransformsToScene pass, and any subsequent step
        // navigation would briefly flash the wrong pose too.
        applyNodeTransformToObject3D(n, newMesh, true);
      }
    }
    if (n.children) for (const c of n.children) stack.push(c);
  }
}

/**
 * Dispose the geometry + material of a flatShape's mesh and detach from
 * its parent. Used when deleting a node or on full project clear.
 */
export function disposeFlatShape(node) {
  const mesh = node?.object3d;
  if (!mesh) return;
  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.geometry?.dispose?.();
  mesh.material?.dispose?.();
  node.object3d = null;
  materials?.unregisterMesh?.(node.id);
}


// ─────────────────────────────────────────────────────────────────────────
//  PRIVATE
// ─────────────────────────────────────────────────────────────────────────

function _lookupTemplate(templateId) {
  const list = state.get('shapeTemplates') || [];
  return list.find(t => t.id === templateId) || null;
}

function _buildKey(tpl, polygons, planeQuat = [0, 0, 0, 1]) {
  // Cheap signature across all input polygons: vertex count + first /
  // mid / last coord per polygon + fill + plane quaternion. Any change
  // invalidates the cached mesh.
  const parts = [tpl.id, tpl.fill];
  for (const p of (polygons || [])) {
    const o = p?.outer ?? [];
    const n = o.length;
    const head = o[0]?.join(',') ?? '';
    const tail = o[n - 1]?.join(',') ?? '';
    const mid  = o[Math.floor(n / 2)]?.join(',') ?? '';
    parts.push(`${n}:${head}:${mid}:${tail}:${(p?.holes || []).length}`);
  }
  const pq = planeQuat.map(v => Math.round((v ?? 0) * 1e6) / 1e6).join(',');
  parts.push(pq);
  return parts.join('|');
}
