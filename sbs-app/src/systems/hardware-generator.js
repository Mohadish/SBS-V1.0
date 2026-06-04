/**
 * SBS — Procedural hardware geometry generator (V0.2.22.37).
 *
 * Pure-function geometry for screws (washer/nut later). Returns a single
 * THREE.BufferGeometry that the caller can wrap in a Mesh + Object3D and
 * insert into the scene tree like any imported model.
 *
 * Persistence model: BAKE-AS-MESH at runtime, params survive on the asset
 * entry (assetEntry.hardware = {kind, ...params}). On load, the orchestrator
 * sees the hardware field and re-invokes the generator instead of trying
 * to read a file from disk. Project files stay text-only — no binary
 * sidecars.
 *
 * Units: 1 scene unit = 1 mm (matches the dominant CAD-export convention).
 * If a project uses different units the user scales the resulting model
 * node after the fact.
 *
 * Drive features: rendered as flat decals sitting flush on the head top
 * surface (raised ~0.001 mm to avoid z-fighting). Single material like
 * the rest of the screw — they read as a darker outline because of the
 * geometry edge, not because of separate materials. Identifies the drive
 * style visually without boolean subtraction (which would need a heavy
 * CSG dep).
 *
 * Orientation: shank axis = +Y. Head sits at +Y, shank goes from Y=0
 * (under the head) down to -length. The model's origin is at the
 * head-shank interface so users dragging it into the scene see it
 * "screwed in" from the surface they're hitting.
 */

// ─── Public API ─────────────────────────────────────────────────────────────

export const HEAD_TYPES  = ['pan', 'button', 'flat', 'socket', 'lowhead', 'hex'];
export const DRIVE_STYLES = ['phillips', 'slotted', 'hex', 'torx'];

/**
 * Generate a single BufferGeometry for a screw.
 *
 * @param {object} params
 * @param {number} params.diameter      shank Ø in mm (e.g. 4 for M4)
 * @param {number} params.length        shank length in mm
 * @param {string} params.headType      one of HEAD_TYPES
 * @param {string} params.driveStyle    one of DRIVE_STYLES
 * @returns {THREE.BufferGeometry}      indexed, with positions + normals
 */
export function generateScrewGeometry({ diameter, length, headType, driveStyle }) {
  const T = window.THREE;
  if (!T) throw new Error('THREE not loaded');

  const D = Math.max(0.5, Number(diameter) || 4);
  const L = Math.max(D * 0.5, Number(length) || 20);
  const head  = String(headType   || 'pan');
  const drive = String(driveStyle || 'phillips');

  // Build each component as a temporary Mesh, then merge into one
  // BufferGeometry. Each component's transform bakes into its geometry
  // during merge so the result is a single flat list of vertices.
  const parts = [];

  // ── SHANK — cylinder from Y=0 down to Y=-L ──────────────────────────────
  // Slightly inset top by 0.01 mm so the head fully covers the seam.
  const shank = _cyl(D / 2, D / 2, L, 24);
  shank.position.y = -L / 2;
  parts.push(shank);

  // ── HEAD — geometry varies per type ─────────────────────────────────────
  const headGeom = _buildHead(head, D);
  parts.push(headGeom);

  // ── DRIVE FEATURE — flat decal on the head top surface ──────────────────
  const driveGeom = _buildDriveDecal(drive, head, D);
  if (driveGeom) parts.push(driveGeom);

  return _mergeMeshes(parts);
}

// ─── Head builders (head sits ABOVE Y=0, bottom flush with Y=0) ─────────────

/**
 * Head proportions follow rounded ISO conventions — close enough that an
 * M4 looks like an M4 to anyone glancing at the scene.
 */
function _headParams(headType, D) {
  switch (headType) {
    case 'pan':     return { topR: 0.875 * D, botR: 0.875 * D, height: 0.6 * D };
    case 'button':  return { topR: 0.875 * D, botR: 0.875 * D, height: 0.55 * D, dome: true };
    case 'flat':    return { topR: 1.0   * D, botR: 0.5   * D, height: 0.6 * D };
    case 'socket':  return { topR: 0.75  * D, botR: 0.75  * D, height: 1.0 * D };
    case 'lowhead': return { topR: 0.75  * D, botR: 0.75  * D, height: 0.6 * D };
    case 'hex':     return { topR: 0.866 * D, botR: 0.866 * D, height: 0.6 * D, hex: true };
    default:        return { topR: 0.875 * D, botR: 0.875 * D, height: 0.6 * D };
  }
}

function _buildHead(headType, D) {
  const T = window.THREE;
  const p = _headParams(headType, D);

  // Hex head: 6-sided prism instead of a smooth cylinder.
  // topR is the circumscribed radius (corner-to-corner). The 6 segments
  // give us a real hex outline; SBS users recognise it instantly.
  if (p.hex) {
    const mesh = _cyl(p.topR, p.topR, p.height, 6);
    mesh.position.y = p.height / 2;
    return mesh;
  }

  // Button head: cylindrical body with a domed top. We approximate the
  // dome as a low half-sphere sitting on a short cylinder so the merge
  // is straightforward.
  if (p.dome) {
    const bodyHeight = p.height * 0.4;
    const domeHeight = p.height - bodyHeight;
    const body = _cyl(p.topR, p.botR, bodyHeight, 24);
    body.position.y = bodyHeight / 2;
    // A flattened half-sphere on top — scaleY shrinks the sphere into a
    // proper button profile.
    const sphere = new T.Mesh(new T.SphereGeometry(p.topR, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2));
    sphere.position.y = bodyHeight;
    sphere.scale.y = domeHeight / p.topR;
    // Merge body + dome into a single mesh by returning a tiny group
    // wrapped in a single position/normal merge. _mergeMeshes handles
    // this when we push both.
    return _mergeMeshes([body, sphere]).meshLike();
  }

  // Pan / socket / low-head / flat — straight cylinder (cone for flat).
  // Flat head's botR < topR makes it taper toward the shank.
  const mesh = _cyl(p.topR, p.botR, p.height, 24);
  mesh.position.y = p.height / 2;
  return mesh;
}

// ─── Drive decals — flat shapes flush on the head top ───────────────────────

/**
 * Drive decal sits ~0.01 mm above the head top to avoid z-fighting.
 * Single-material design — visible because the decal edges break the
 * smooth head surface, not because of color. The flat geometry reads
 * as a recess (Phillips slot, hex socket, etc.) at typical viewing
 * angles.
 *
 * Returns null for "no drive" (we don't define that yet but easy to add).
 */
function _buildDriveDecal(driveStyle, headType, D) {
  const T = window.THREE;
  const p = _headParams(headType, D);
  const yTop = p.height + 0.01;      // sit just above the head top
  const decalH = 0.05 * D;            // very thin, just enough to be visible

  // The "head-top radius" we draw on — for flat heads we want to drop
  // the decal at the top of the cone, which is wider than the shank.
  const Rtop = p.topR;

  switch (driveStyle) {
    case 'slotted': {
      // Single slot across the head — long axis ~0.85 × head Ø,
      // width ~0.15 × shank Ø.
      const slot = new T.Mesh(new T.BoxGeometry(Rtop * 1.7, decalH, D * 0.15));
      slot.position.y = yTop + decalH / 2;
      return slot;
    }
    case 'phillips': {
      // Two perpendicular slots, shorter than slotted but two of them.
      const a = new T.Mesh(new T.BoxGeometry(Rtop * 1.4, decalH, D * 0.15));
      a.position.y = yTop + decalH / 2;
      const b = new T.Mesh(new T.BoxGeometry(D * 0.15, decalH, Rtop * 1.4));
      b.position.y = yTop + decalH / 2;
      return _mergeMeshes([a, b]).meshLike();
    }
    case 'hex': {
      // Hex socket — short 6-sided prism. Across-flats ≈ 0.6 × D.
      const hex = _cyl(D * 0.35, D * 0.35, decalH, 6);
      hex.position.y = yTop + decalH / 2;
      return hex;
    }
    case 'torx': {
      // Torx — 6-lobed star approximated as alternating radii.
      // 12 vertices around the perimeter; outer at R, inner at 0.6R.
      const outerR = D * 0.35;
      const innerR = outerR * 0.62;
      const pts = [];
      const lobes = 6;
      for (let i = 0; i < lobes * 2; i++) {
        const r = (i % 2 === 0) ? outerR : innerR;
        const ang = i * Math.PI / lobes;
        pts.push(new T.Vector2(r * Math.cos(ang), r * Math.sin(ang)));
      }
      const shape = new T.Shape(pts);
      const geom  = new T.ExtrudeGeometry(shape, { depth: decalH, bevelEnabled: false });
      // ExtrudeGeometry pushes in +Z; rotate so it stands along +Y.
      geom.rotateX(-Math.PI / 2);
      const mesh = new T.Mesh(geom);
      mesh.position.y = yTop;
      return mesh;
    }
    default:
      return null;
  }
}

// ─── Primitive helpers ──────────────────────────────────────────────────────

/**
 * Indexed cylinder Mesh with computed normals. Wrapper around
 * THREE.CylinderGeometry so the call sites stay readable.
 */
function _cyl(topR, botR, height, segments) {
  const T = window.THREE;
  const geom = new T.CylinderGeometry(topR, botR, height, segments);
  return new T.Mesh(geom);
}

/**
 * Merge a flat list of Mesh objects into a single BufferGeometry,
 * baking each mesh's local transform into its vertices. Single
 * geometry, single material, no groups.
 *
 * Returns an object with both:
 *   .geometry   → the merged BufferGeometry directly (when caller wants raw)
 *   .meshLike() → returns a Mesh wrapping the merged geometry so callers
 *                 can keep treating the result polymorphically with other
 *                 _cyl / new Mesh outputs in further merges.
 *
 * (The .meshLike() escape hatch lets nested _mergeMeshes calls compose.)
 */
function _mergeMeshes(meshes) {
  const T = window.THREE;
  const positions = [];
  const normals   = [];
  const indices   = [];
  let vertexOffset = 0;

  for (const m of meshes) {
    if (!m) continue;
    m.updateMatrix();
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrix);
    if (!g.attributes.normal) g.computeVertexNormals();

    const pos = g.attributes.position.array;
    const nrm = g.attributes.normal.array;

    for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
    for (let i = 0; i < nrm.length; i++) normals.push(nrm[i]);

    if (g.index) {
      const idx = g.index.array;
      for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vertexOffset);
    } else {
      // Non-indexed: synthesize a 0..N-1 index so the merged result is
      // always indexed (consistent for the renderer + later edits).
      const vCount = pos.length / 3;
      for (let i = 0; i < vCount; i++) indices.push(vertexOffset + i);
    }
    vertexOffset += pos.length / 3;
    g.dispose();
  }

  const merged = new T.BufferGeometry();
  merged.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal',   new T.Float32BufferAttribute(normals, 3));
  merged.setIndex(indices);

  // Polymorphic return: callers using .meshLike() get a Mesh they can
  // push into another _mergeMeshes call as if it were a primitive. The
  // .geometry property gives raw access when that's what's needed.
  const out = {
    geometry: merged,
    meshLike() {
      const wrapper = new T.Mesh(merged);
      // Identity transform so the next merge doesn't re-apply anything.
      return wrapper;
    },
  };
  return out;
}

/**
 * Build a human-readable name for a screw hardware spec. Mirrors the
 * ISO shorthand authoring engineers use (M4 × 20 pan, Phillips).
 */
export function describeScrew({ diameter, length, headType, driveStyle }) {
  return `M${diameter}×${length} ${headType}, ${driveStyle}`;
}

/**
 * Generate the screw geometry and wrap it in a THREE.Mesh + THREE.Group
 * (matching the shape of a freshly imported model). Caller is responsible
 * for tree-node + asset-entry creation.
 */
export function generateScrewMesh(params) {
  const T = window.THREE;
  const result = generateScrewGeometry(params);
  // generateScrewGeometry returns the merged-object wrapper (with .geometry).
  // We unwrap here so call sites get a real Mesh.
  const geom = result?.geometry || result;
  const material = new T.MeshStandardMaterial({
    color:      0xc0c4cc,    // brushed-metal grey
    metalness:  0.65,
    roughness:  0.35,
    flatShading: false,
  });
  return new T.Mesh(geom, material);
}
