/**
 * SBS — Procedural hardware geometry generator (V0.2.22.38).
 *
 * Pure-function geometry. Returns a single THREE.Mesh (head + shank
 * merged into one BufferGeometry, one material) suitable for wrapping
 * in a hardware-instance node and inserting into the scene tree.
 *
 * Drive recess (V0.2.22.38): proper subtractive geometry. The head's
 * top face is an annulus shaped like the drive profile cut out
 * (cross / slot / hex / star). The recess walls drop straight down,
 * capped by a flat floor in the drive shape. No CSG library — built
 * by stacking two ExtrudeGeometry passes:
 *
 *   TOP PIECE     ExtrudeGeometry(outerShape WITH driveHole, depth=recess)
 *                   → outer side wall + top annulus + inner recess walls
 *                     + matching annulus on the bottom (the rim sealing
 *                     the recess to the bottom piece).
 *   BOTTOM PIECE  ExtrudeGeometry(outerShape NO hole,        depth=H-recess)
 *                   → solid puck for the bottom of the head; its TOP face
 *                     becomes the visible floor of the recess (visible
 *                     only inside the drive-shaped hole — the rest is
 *                     covered by the top piece's bottom annulus).
 *
 * Internal seam between TOP and BOTTOM is hidden inside the solid (both
 * faces are co-planar at y = H-recess). The visible result reads as a
 * proper machined screw socket from any angle.
 *
 * Units: 1 scene unit = 1 mm.
 * Orientation: shank axis = +Y. Head sits at +Y, shank goes from Y=0
 * down to Y = -length. Origin = head-shank interface.
 */

// ─── Public API ─────────────────────────────────────────────────────────────

export const HEAD_TYPES   = ['pan', 'button', 'flat', 'socket', 'lowhead', 'hex'];
export const DRIVE_STYLES = ['phillips', 'slotted', 'hex', 'torx'];

/**
 * Generate the screw mesh.
 *
 * @param {object} params
 * @param {number} params.diameter      shank Ø in mm
 * @param {number} params.length        shank length in mm
 * @param {string} params.headType
 * @param {string} params.driveStyle
 * @returns {THREE.Mesh}
 */
export function generateScrewMesh({ diameter, length, headType, driveStyle }) {
  const T = window.THREE;
  if (!T) throw new Error('THREE not loaded');

  const D = Math.max(0.5, Number(diameter) || 4);
  const L = Math.max(D * 0.5, Number(length) || 20);
  const head  = String(headType   || 'pan');
  const drive = String(driveStyle || 'phillips');

  const parts = [];

  // ── SHANK ─────────────────────────────────────────────────────────────
  parts.push(_shank(D, L));

  // ── HEAD ──────────────────────────────────────────────────────────────
  // Build the head with a real recess for the drive style.  Hex heads and
  // button heads skip the recess: hex is externally-driven (wrench grips
  // the outside), and button heads have a dome where a flat recess would
  // look wrong. Drive style stays in the spec for both — just not visible.
  parts.push(..._buildHead(head, D, drive));

  // Merge everything into one BufferGeometry with one material.
  const geom = _mergeMeshes(parts);
  const material = new T.MeshStandardMaterial({
    color:      0xc0c4cc,
    metalness:  0.65,
    roughness:  0.35,
  });
  return new T.Mesh(geom, material);
}

/** Human-readable label for a screw spec — mirrors ISO shorthand. */
export function describeScrew({ diameter, length, headType, driveStyle }) {
  return `M${diameter}×${length} ${headType}, ${driveStyle}`;
}

// ─── Head builders ──────────────────────────────────────────────────────────

function _headParams(headType, D) {
  // Standard-ish ISO proportions. Visual match, not certifiable spec.
  switch (headType) {
    case 'pan':     return { topR: 0.875 * D, botR: 0.875 * D, height: 0.6 * D, kind: 'cyl' };
    case 'button':  return { topR: 0.875 * D, botR: 0.875 * D, height: 0.55 * D, kind: 'button' };
    case 'flat':    return { topR: 1.0   * D, botR: 0.5   * D, height: 0.6 * D, kind: 'cone' };
    case 'socket':  return { topR: 0.75  * D, botR: 0.75  * D, height: 1.0 * D, kind: 'cyl' };
    case 'lowhead': return { topR: 0.75  * D, botR: 0.75  * D, height: 0.6 * D, kind: 'cyl' };
    case 'hex':     return { topR: 0.866 * D, botR: 0.866 * D, height: 0.6 * D, kind: 'hex' };
    default:        return { topR: 0.875 * D, botR: 0.875 * D, height: 0.6 * D, kind: 'cyl' };
  }
}

/**
 * Returns an array of THREE.Mesh parts. Hex + button skip the recess;
 * everyone else gets a real subtractive recess.
 */
function _buildHead(headType, D, driveStyle) {
  const T = window.THREE;
  const p = _headParams(headType, D);

  // Hex head: external drive — no recess. Single 6-sided prism.
  if (p.kind === 'hex') {
    const m = _cyl(p.topR, p.topR, p.height, 6);
    m.position.y = p.height / 2;
    return [m];
  }

  // Button head: cylindrical base + dome on top. No recess (dome covers
  // where it would go in a real button screw with a recessed drive; for
  // SBS visual purposes the dome is the dominant feature).
  if (p.kind === 'button') {
    const baseH = p.height * 0.45;
    const domeH = p.height - baseH;
    const base = _cyl(p.topR, p.botR, baseH, 24);
    base.position.y = baseH / 2;
    const dome = new T.Mesh(new T.SphereGeometry(p.topR, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2));
    dome.position.y = baseH;
    dome.scale.y = domeH / p.topR;
    return [base, dome];
  }

  // Flat head: cone outer (smaller at bottom). No internal recess for the
  // first version — a Phillips/slot/hex/Torx recess in a tapered countersunk
  // head is geometrically fiddly (the recess intersects the cone walls).
  // Render the head as just the cone for now; drive style stays in the spec.
  if (p.kind === 'cone') {
    const m = _cyl(p.topR, p.botR, p.height, 24);
    m.position.y = p.height / 2;
    return [m];
  }

  // Cylindrical heads (pan, socket cap, low head) — real subtractive recess.
  return _buildHeadWithRecess(p, D, driveStyle);
}

/**
 * Build a cylindrical head with a true drive-shaped recess via two
 * stacked ExtrudeGeometry passes. See file header for the geometry plan.
 */
function _buildHeadWithRecess(p, D, driveStyle) {
  const T = window.THREE;
  const recessDepth = Math.min(p.height * 0.55, p.height - D * 0.1);
  const baseHeight  = p.height - recessDepth;

  // ── Drive profile (2D path) ──────────────────────────────────────────
  const drivePath = _drivePath2D(driveStyle, D);
  // Outer head outline (circle as polygon).
  const outerPath = _circlePath2D(p.topR, 32);

  // TOP PIECE: outer shape with drive cut as hole. Extruded "depth" puts
  // the shape's polygon at z=0 and the back face at z=depth. We extrude
  // along Z then rotate to Y axis (extrude is +Z by default; we want +Y).
  const topShape = new T.Shape(outerPath);
  topShape.holes = [new T.Path(drivePath)];
  const topGeom = new T.ExtrudeGeometry(topShape, {
    depth:        recessDepth,
    bevelEnabled: false,
    steps:        1,
  });
  // ExtrudeGeometry sits in the XY plane extruded along +Z.  Rotate so
  // the extrusion axis becomes +Y (the screw's axis), and translate so
  // the recess top sits at y = p.height (the head's top surface).
  topGeom.rotateX(-Math.PI / 2);
  topGeom.translate(0, p.height, 0);
  const topMesh = new T.Mesh(topGeom);

  // BOTTOM PIECE: solid puck, outer shape only, no hole. Forms the
  // structural body of the head below the recess and seals its floor.
  const bottomShape = new T.Shape(outerPath);
  const bottomGeom = new T.ExtrudeGeometry(bottomShape, {
    depth:        baseHeight,
    bevelEnabled: false,
    steps:        1,
  });
  bottomGeom.rotateX(-Math.PI / 2);
  bottomGeom.translate(0, baseHeight, 0);
  const bottomMesh = new T.Mesh(bottomGeom);

  return [topMesh, bottomMesh];
}

// ─── Shank ──────────────────────────────────────────────────────────────────

function _shank(D, L) {
  const m = _cyl(D / 2, D / 2, L, 24);
  m.position.y = -L / 2;
  return m;
}

// ─── 2D path helpers ────────────────────────────────────────────────────────

/** Closed-loop array of Vector2 forming a circle of given radius. */
function _circlePath2D(radius, segments) {
  const T = window.THREE;
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new T.Vector2(radius * Math.cos(a), radius * Math.sin(a)));
  }
  return pts;
}

/**
 * 2D path for the drive socket profile (the cut-out shape in the head top).
 *
 * Returned as a closed loop of Vector2.  Caller wraps in THREE.Path and
 * adds as a hole on a Shape.  Hole winding must be OPPOSITE the shape
 * winding — outer is CCW (default for our circle), so holes need CW.
 * Three.js's Shape.holes accept either winding and reorient internally.
 */
function _drivePath2D(driveStyle, D) {
  const T = window.THREE;
  switch (driveStyle) {
    case 'phillips': {
      // Cross — two perpendicular rectangles unioned. Build as a single
      // closed polygon by tracing the outline of the union (12 vertices).
      // Slot arm length = 0.75 D, arm width = 0.18 D.
      const armL = D * 0.375;     // half-length
      const armW = D * 0.09;      // half-width
      return _crossOutline(armL, armW);
    }
    case 'slotted': {
      // Single rectangle.
      const halfL = D * 0.4;
      const halfW = D * 0.075;
      return [
        new T.Vector2(-halfL, -halfW),
        new T.Vector2( halfL, -halfW),
        new T.Vector2( halfL,  halfW),
        new T.Vector2(-halfL,  halfW),
      ];
    }
    case 'hex': {
      // Regular hexagon, across-flats ≈ 0.55 D (typical Allen socket).
      const r = D * 0.32;     // circumscribed radius
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;  // flat top
        pts.push(new T.Vector2(r * Math.cos(a), r * Math.sin(a)));
      }
      return pts;
    }
    case 'torx': {
      // 6-lobe star — alternating outer/inner radii.
      const outerR = D * 0.32;
      const innerR = outerR * 0.62;
      const lobes  = 6;
      const pts = [];
      for (let i = 0; i < lobes * 2; i++) {
        const r = (i % 2 === 0) ? outerR : innerR;
        const a = (i / (lobes * 2)) * Math.PI * 2;
        pts.push(new T.Vector2(r * Math.cos(a), r * Math.sin(a)));
      }
      return pts;
    }
    default: {
      // Fallback — small circle (looks like a centre drill).
      return _circlePath2D(D * 0.15, 16);
    }
  }
}

/**
 * Trace the outline of two perpendicular rectangles (a cross), starting
 * at the top-right outer corner of the horizontal arm, walking CCW.
 * 12 vertices total — the outer perimeter of the cross with no internal
 * edges, so it works as a single closed Path.
 *
 * Layout (each "arm" extends from origin outward; armL is half-length,
 * armW is half-width):
 *
 *           +y
 *           ┌─┐
 *           │ │
 *      ┌────┘ └────┐
 *  -x  │           │  +x
 *      └────┐ ┌────┘
 *           │ │
 *           └─┘
 *           -y
 */
function _crossOutline(armL, armW) {
  const T = window.THREE;
  return [
    new T.Vector2( armL, -armW),  // bottom-right of horizontal arm
    new T.Vector2( armL,  armW),  // top-right of horizontal arm
    new T.Vector2( armW,  armW),  // inner corner (right side of vertical arm)
    new T.Vector2( armW,  armL),  // top-right of vertical arm
    new T.Vector2(-armW,  armL),  // top-left of vertical arm
    new T.Vector2(-armW,  armW),  // inner corner (left side of vertical arm)
    new T.Vector2(-armL,  armW),  // top-left of horizontal arm
    new T.Vector2(-armL, -armW),  // bottom-left of horizontal arm
    new T.Vector2(-armW, -armW),  // inner corner (left side, bottom of vert arm)
    new T.Vector2(-armW, -armL),  // bottom-left of vertical arm
    new T.Vector2( armW, -armL),  // bottom-right of vertical arm
    new T.Vector2( armW, -armW),  // inner corner (right side, bottom of vert arm)
  ];
}

// ─── Primitive helpers ──────────────────────────────────────────────────────

function _cyl(topR, botR, height, segments) {
  const T = window.THREE;
  return new T.Mesh(new T.CylinderGeometry(topR, botR, height, segments));
}

/**
 * Merge a flat list of Mesh objects into a single BufferGeometry,
 * baking each mesh's local transform into its vertices.  Single
 * geometry, single material, no groups.  Returns BufferGeometry only
 * (caller wraps in Mesh with chosen material).
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
  return merged;
}
