/**
 * SBS — Parametric primitives  (V0.2.22.90)
 * ==========================================
 * Box / Plane / Sphere / Cylinder / Cone / Torus / Capsule / Tube / Pyramid /
 * GeoSphere — created as STANDALONE mesh nodes (type 'primitive') that carry
 * their OWN parameters (primParams), a kind (primKind) and a tessellation
 * quality 1-5 (primQuality). The THREE geometry is generated from those on
 * create / edit / load — the same procedural pattern as flat shapes + hardware,
 * so it persists and rebuilds via the shared scene-tree machinery.
 *
 * "Quality" is the surface intricacy dial (low = faceted, high = smooth). Curved
 * primitives get smooth vertex normals so they look smooth even at mid quality.
 */
import { materials } from './materials.js';

const T = () => window.THREE;

// Quality 1-5 → radial / segment count for curved primitives.
const SEG = [10, 16, 24, 40, 64];
const qSeg = (q) => SEG[Math.max(1, Math.min(5, q || 3)) - 1];

/**
 * The single source of truth for every primitive: its label, palette icon,
 * whether the quality slider applies, its editable parameters (with defaults +
 * limits) and a builder (params, quality) → THREE.BufferGeometry.
 */
export const PRIMITIVE_DEFS = {
  box: {
    label: 'Box', icon: '⬛', quality: false,
    params: [
      { key: 'width',  label: 'Width',  def: 20, min: 0.1, step: 1 },
      { key: 'height', label: 'Height', def: 20, min: 0.1, step: 1 },
      { key: 'depth',  label: 'Depth',  def: 20, min: 0.1, step: 1 },
    ],
    build: (p) => new (T().BoxGeometry)(p.width, p.height, p.depth),
  },
  plane: {
    label: 'Plane', icon: '▭', quality: false, doubleSide: true,
    params: [
      { key: 'width',  label: 'Width',  def: 20, min: 0.1, step: 1 },
      { key: 'height', label: 'Height', def: 20, min: 0.1, step: 1 },
    ],
    build: (p) => new (T().PlaneGeometry)(p.width, p.height),
  },
  sphere: {
    label: 'Sphere', icon: '⬤', quality: true,
    params: [{ key: 'radius', label: 'Radius', def: 10, min: 0.1, step: 1 }],
    build: (p, q) => { const s = qSeg(q); return new (T().SphereGeometry)(p.radius, s, Math.max(4, Math.round(s / 2))); },
  },
  cylinder: {
    label: 'Cylinder', icon: '⬭', quality: true,
    params: [
      { key: 'radius', label: 'Radius', def: 10, min: 0.1, step: 1 },
      { key: 'height', label: 'Height', def: 20, min: 0.1, step: 1 },
    ],
    build: (p, q) => new (T().CylinderGeometry)(p.radius, p.radius, p.height, qSeg(q)),
  },
  cone: {
    label: 'Cone', icon: '🔺', quality: true,
    params: [
      { key: 'radius', label: 'Radius', def: 10, min: 0.1, step: 1 },
      { key: 'height', label: 'Height', def: 20, min: 0.1, step: 1 },
    ],
    build: (p, q) => new (T().ConeGeometry)(p.radius, p.height, qSeg(q)),
  },
  torus: {
    label: 'Torus', icon: '◯', quality: true,
    params: [
      { key: 'radius', label: 'Ring radius', def: 10, min: 0.1,  step: 1 },
      { key: 'tube',   label: 'Tube',        def: 3,  min: 0.05, step: 0.5 },
    ],
    build: (p, q) => new (T().TorusGeometry)(p.radius, Math.min(p.tube, p.radius), Math.max(6, Math.round(qSeg(q) / 2)), qSeg(q)),
  },
  capsule: {
    label: 'Capsule', icon: '💊', quality: true,
    params: [
      { key: 'radius', label: 'Radius', def: 6,  min: 0.1, step: 0.5 },
      { key: 'length', label: 'Length', def: 16, min: 0,   step: 1 },
    ],
    build: (p, q) => {
      const Th = T();
      if (Th.CapsuleGeometry) return new Th.CapsuleGeometry(p.radius, p.length, Math.max(2, Math.round(qSeg(q) / 8)), qSeg(q));
      return new Th.CylinderGeometry(p.radius, p.radius, p.length + p.radius * 2, qSeg(q)); // fallback (older THREE)
    },
  },
  tube: {
    label: 'Tube', icon: '⊚', quality: true,
    params: [
      { key: 'outer',  label: 'Outer R', def: 10, min: 0.2, step: 1 },
      { key: 'inner',  label: 'Inner R', def: 6,  min: 0.1, step: 1 },
      { key: 'height', label: 'Height',  def: 20, min: 0.1, step: 1 },
    ],
    build: (p, q) => {
      const Th = T();
      const o = Math.max(p.outer, (p.inner || 0) + 0.1);
      const i = Math.max(0.05, Math.min(p.inner, o - 0.1));
      const hh = p.height / 2;
      // Revolve a closed rectangular wall cross-section around Y → hollow tube.
      const pts = [
        new Th.Vector2(o, -hh), new Th.Vector2(o, hh),
        new Th.Vector2(i,  hh), new Th.Vector2(i, -hh),
        new Th.Vector2(o, -hh),
      ];
      return new Th.LatheGeometry(pts, qSeg(q));
    },
  },
  pyramid: {
    label: 'Pyramid', icon: '▲', quality: false,
    params: [
      { key: 'base',   label: 'Base',   def: 20, min: 0.1, step: 1 },
      { key: 'height', label: 'Height', def: 20, min: 0.1, step: 1 },
      { key: 'sides',  label: 'Sides',  def: 4,  min: 3, max: 12, step: 1 },
    ],
    build: (p) => new (T().ConeGeometry)(p.base / 2, p.height, Math.max(3, Math.round(p.sides || 4))),
  },
  geosphere: {
    label: 'GeoSphere', icon: '⬢', quality: true,
    params: [{ key: 'radius', label: 'Radius', def: 10, min: 0.1, step: 1 }],
    build: (p, q) => new (T().IcosahedronGeometry)(p.radius, [0, 1, 2, 3, 4][Math.max(1, Math.min(5, q || 3)) - 1]),
  },
};

export const PRIMITIVE_KINDS = Object.keys(PRIMITIVE_DEFS);

/** Default parameter object for a kind (key → default value). */
export function defaultPrimitiveParams(kind) {
  const def = PRIMITIVE_DEFS[kind];
  const out = {};
  if (def) for (const pr of def.params) out[pr.key] = pr.def;
  return out;
}

function _buildKey(node) {
  return `${node.primKind}|${node.primQuality}|${node.baseAtOrigin ? 'B' : 'C'}|${JSON.stringify(node.primParams || {})}`;
}

// Base-face primitives (V0.3.0.70): origin at the BASE so the primitive extrudes
// UPWARD (+Y) from Y=0 instead of growing symmetrically about its centre — drop a
// cylinder on a surface and it sits ON it, "height" only adds on top. Round/centred
// kinds (torus/capsule/sphere/geosphere) keep their centre pivot. Gated by the
// per-primitive baseAtOrigin flag so EXISTING (centre-pivot) primitives are untouched.
export const BASE_FACE_KINDS = new Set(['box', 'cylinder', 'cone', 'pyramid', 'tube', 'plane']);
function _applyBaseFace(geom, kind, params) {
  if (!BASE_FACE_KINDS.has(kind)) return;
  if (kind === 'plane') { geom.rotateX(-Math.PI / 2); return; }   // lie flat, base face up (+Y)
  const h = Number(params?.height);
  if (Number.isFinite(h)) geom.translate(0, h / 2, 0);            // base at Y=0, extrude +Y
}

const _warned = new Set();
function _warnOnce(node, msg) {
  if (_warned.has(node?.id)) return;
  _warned.add(node?.id);
  console.warn(`[primitive] ${msg}`);
}

/** Build the THREE geometry for a kind + params + quality (smooth normals). */
export function buildPrimitiveGeometry(kind, params, quality, baseAtOrigin = false) {
  const def = PRIMITIVE_DEFS[kind];
  if (!def || !T()) return null;
  const q = Math.max(1, Math.min(5, quality || 3));
  try {
    const p = params || defaultPrimitiveParams(kind);
    const geom = def.build(p, q);
    if (baseAtOrigin) _applyBaseFace(geom, kind, p);   // base-face origin (new primitives)
    geom.computeBoundingBox?.();
    geom.computeVertexNormals?.();   // smooth shading on curved surfaces
    return geom;
  } catch (e) {
    console.warn('[primitive] build failed', kind, e);
    return null;
  }
}

/**
 * Build / rebuild the THREE.Mesh for a primitive node. Cache-hit fast path when
 * params+quality are unchanged (matching primBuildKey). Preserves the visible
 * colour across rebuilds. Registers with the materials map so colour + step
 * visibility work like any other mesh.
 */
export function ensurePrimitiveObject3D(node) {
  const Th = T();
  if (!Th || !node || node.type !== 'primitive' || !node.primKind) return null;

  const sig = _buildKey(node);
  const existing = node.object3d;
  if (existing && existing.userData?.primBuildKey === sig) {
    materials?.registerMesh?.(node.id, existing);
    return existing;
  }
  _warned.delete(node.id);

  const geom = buildPrimitiveGeometry(node.primKind, node.primParams, node.primQuality, node.baseAtOrigin);
  if (!geom) {
    _warnOnce(node, `"${node.name || node.id}" (${node.primKind}) produced no geometry.`);
    return null;
  }

  // Keep the current colour across a param/quality rebuild.
  const prevColor = existing?.material?.color ? '#' + existing.material.color.getHexString() : null;
  // V0.3.0.121 (P1) — primitives can now CONTAIN other objects (their Three.js
  // nodes are parented under this mesh). A param/quality edit disposes + recreates
  // the mesh, which would ORPHAN those children. Detach the real contained nodes
  // first and re-attach them to the new mesh below. (Helper objects like outlines
  // lack a node id, so they're left for the materials system to rebuild.)
  let _preservedChildren = [];
  if (existing) {
    _preservedChildren = existing.children.filter(c =>
      (c.userData?.nodeId && c.userData.nodeId !== node.id) || c.userData?.isCustomFolder);
    for (const c of _preservedChildren) existing.remove(c);
    if (existing.parent) existing.parent.remove(existing);
    existing.geometry?.dispose?.();
    existing.material?.dispose?.();
    node.object3d = null;
  }

  const def = PRIMITIVE_DEFS[node.primKind];
  const mat = new Th.MeshStandardMaterial({
    color:     prevColor || '#bfcad4',
    roughness: 0.55,
    metalness: 0.05,
    side:      def?.doubleSide ? Th.DoubleSide : Th.FrontSide,
  });
  const mesh = new Th.Mesh(geom, mat);
  mesh.name = node.name || def?.label || 'Primitive';
  mesh.userData.primitiveNodeId = node.id;
  mesh.userData.meshNodeId      = node.id;   // enables raycast → selection
  mesh.userData.nodeId          = node.id;
  mesh.userData.primBuildKey    = sig;
  // Re-attach contained objects orphaned by the mesh recreation (P1).
  for (const c of _preservedChildren) mesh.add(c);
  node.object3d = mesh;
  materials?.registerMesh?.(node.id, mesh);
  return mesh;
}

/**
 * Live edit: swap the geometry IN PLACE after a parameter / quality change.
 * Keeps the same Mesh object (so it stays attached to its parent, keeps its
 * material/colour, and stays selected) — only the geometry is replaced, which
 * is what makes the change show instantly. Falls back to a full build if the
 * node has no mesh yet.
 */
export function rebuildPrimitive(node) {
  const mesh = node?.object3d;
  if (!mesh) return ensurePrimitiveObject3D(node);
  const geom = buildPrimitiveGeometry(node.primKind, node.primParams, node.primQuality, node.baseAtOrigin);
  if (!geom) return mesh;
  const old = mesh.geometry;
  mesh.geometry = geom;
  old?.dispose?.();
  mesh.userData.primBuildKey = _buildKey(node);
  return mesh;
}
