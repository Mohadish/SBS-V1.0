/**
 * SBS — Procedural hardware geometry generator (V0.2.22.39).
 *
 * Returns a single THREE.Mesh per screw — head + shank merged into one
 * BufferGeometry, one material — ready for insertion into the scene tree.
 *
 * V0.2.22.39 rewrite (relative to .38):
 *   1. ALL head types now get the drive recess (button + flat + hex too).
 *      Previously only pan / socket cap / low head had real geometry; the
 *      others rendered as plain shells.
 *   2. New "none" drive style — smooth flat top with no recess at all.
 *      Useful when the user wants a generic fastener cylinder without
 *      committing to a drive interface (rivet-like).
 *   3. Outer wall is built as ONE continuous mesh per head, not stacked
 *      extrusions. Fixes the visible shading seam at the recess depth
 *      that V0.2.22.38 had (two ExtrudeGeometry pieces meeting at
 *      y = baseHeight produced disjoint vertex sets even though their
 *      positions matched — vertex-normal smoothing across the gap
 *      couldn't merge them, so a hard shading line appeared).
 *
 * Build pattern per head (with recess):
 *
 *    1. OUTER WALL    one open-ended cylinder / cone / hex prism / dome.
 *                     Full headHeight in one continuous mesh — no seam.
 *    2. TOP CAP       flat polygon at y=headHeight, outer outline with
 *                     the drive profile cut out (Shape + hole + ShapeGeometry).
 *    3. RECESS WALLS  hollow extrusion of just the drive profile, walls
 *                     only, from y=headHeight down to y=headHeight-recess.
 *    4. RECESS FLOOR  flat polygon (drive profile) at y=headHeight-recess.
 *    5. BOTTOM CAP    flat disk at y=0 closing the head from below.
 *
 * For drive="none": only steps 1, 2(full disk no hole), and 5 run.
 *
 * Units: 1 scene unit = 1 mm. Shank axis = +Y. Origin = head-shank interface.
 */

// ─── Public API ─────────────────────────────────────────────────────────────

export const HEAD_TYPES   = ['pan', 'button', 'flat', 'socket', 'lowhead', 'hex'];
export const DRIVE_STYLES = ['none', 'phillips', 'slotted', 'hex', 'torx'];

export function generateScrewMesh({ diameter, length, headType, driveStyle }) {
  const T = window.THREE;
  if (!T) throw new Error('THREE not loaded');

  const D = Math.max(0.5, Number(diameter) || 4);
  const L = Math.max(D * 0.5, Number(length) || 20);
  const head  = String(headType   || 'pan');
  const drive = String(driveStyle || 'none');

  const parts = [];
  parts.push(_shank(D, L));
  parts.push(..._buildHead(head, D, drive));

  const geom = _mergeMeshes(parts);
  const material = new T.MeshStandardMaterial({
    color:     0xc0c4cc,
    metalness: 0.65,
    roughness: 0.35,
  });
  return new T.Mesh(geom, material);
}

export function describeScrew({ diameter, length, headType, driveStyle }) {
  const dr = driveStyle && driveStyle !== 'none' ? `, ${driveStyle}` : '';
  return `M${diameter}×${length} ${headType}${dr}`;
}

// ─── Head proportions ──────────────────────────────────────────────────────

function _headParams(headType, D) {
  // kind = 'cyl' | 'cone' | 'hex'
  //   cyl  — straight cylinder outer wall (pan, socket cap, low head)
  //   cone — tapered cylinder (flat / countersunk; topR > botR)
  //   hex  — 6-sided prism outer wall
  //
  // Note V0.2.22.39: button head currently renders as a slightly taller
  // pan (kind='cyl') so the recess geometry works without the round-dome
  // / drive-hole intersection problem. A proper rounded-top button head
  // with a recessed drive socket is queued.
  switch (headType) {
    case 'pan':     return { topR: 0.875 * D, botR: 0.875 * D, height: 0.6  * D, kind: 'cyl' };
    case 'button':  return { topR: 0.875 * D, botR: 0.875 * D, height: 0.7  * D, kind: 'cyl' };
    case 'flat':    return { topR: 1.0   * D, botR: 0.5   * D, height: 0.6  * D, kind: 'cone' };
    case 'socket':  return { topR: 0.75  * D, botR: 0.75  * D, height: 1.0  * D, kind: 'cyl' };
    case 'lowhead': return { topR: 0.75  * D, botR: 0.75  * D, height: 0.6  * D, kind: 'cyl' };
    case 'hex':     return { topR: 0.866 * D, botR: 0.866 * D, height: 0.6  * D, kind: 'hex' };
    default:        return { topR: 0.875 * D, botR: 0.875 * D, height: 0.6  * D, kind: 'cyl' };
  }
}

// ─── Head builder — universal pattern ──────────────────────────────────────

function _buildHead(headType, D, driveStyle) {
  const p = _headParams(headType, D);
  const hasRecess = driveStyle !== 'none';
  const recessDepth = hasRecess
    ? Math.min(p.height * 0.55, p.height - D * 0.1)
    : 0;

  const meshes = [];

  // 1. Outer wall — single continuous mesh per head, no internal seams.
  meshes.push(..._buildOuterWall(p));

  // 2. Top cap — flat polygon at y=p.height with the drive shape cut
  //    out as a hole (or full disk when drive='none').
  meshes.push(_buildTopCap(p, D, driveStyle));

  // 3+4. Recess walls + floor (only when there's a drive recess).
  if (hasRecess) {
    meshes.push(..._buildRecess(driveStyle, D, p.height, recessDepth));
  }

  // 5. Bottom cap — closes the head from below.
  meshes.push(_buildBottomCap(p));

  return meshes;
}

// ─── Outer wall ────────────────────────────────────────────────────────────

/**
 * Open-ended outer wall mesh — one continuous primitive per head.
 *
 *   cyl  — straight cylinder (pan / socket cap / low head / button-v1)
 *   cone — tapered cylinder (flat / countersunk)
 *   hex  — 6-sided prism
 *
 * Open ends (no caps): _buildTopCap and _buildBottomCap own the caps so
 * the top cap can be shaped with the drive hole. Single continuous mesh
 * means no shading seam at any height — the issue V0.2.22.38 had at the
 * recess-depth seam is gone for good.
 */
function _buildOuterWall(p) {
  const T = window.THREE;
  const segments = (p.kind === 'hex') ? 6 : 24;
  const wall = new T.Mesh(
    new T.CylinderGeometry(p.topR, p.botR, p.height, segments, 1, /* open */ true)
  );
  wall.position.y = p.height / 2;
  return [wall];
}

// ─── Top cap with drive hole ───────────────────────────────────────────────

function _buildTopCap(p, D, driveStyle) {
  const T = window.THREE;
  // Outer outline of the cap: depends on head shape (hex vs round).
  const outer = (p.kind === 'hex')
    ? _hexagonPath2D(p.topR)
    : _circlePath2D(p.topR, 32);
  const shape = new T.Shape(outer);

  if (driveStyle && driveStyle !== 'none') {
    const drivePath = _drivePath2D(driveStyle, D);
    shape.holes = [new T.Path(drivePath)];
  }

  // Flat polygon (no extrusion) — sits at y=p.height.
  const geom = new T.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);       // XY plane → XZ plane (Y is up)
  geom.translate(0, p.height, 0);
  return new T.Mesh(geom);
}

// ─── Bottom cap (full disk / hex) ──────────────────────────────────────────

function _buildBottomCap(p) {
  const T = window.THREE;
  const outer = (p.kind === 'hex')
    ? _hexagonPath2D(p.botR)
    : _circlePath2D(p.botR, 32);
  const shape = new T.Shape(outer);
  const geom = new T.ShapeGeometry(shape);
  // Flip so the bottom-cap normals face downward (-Y).
  geom.rotateX(Math.PI / 2);
  // Already at y=0; no translate needed.
  return new T.Mesh(geom);
}

// ─── Recess walls + floor ──────────────────────────────────────────────────

/**
 * Drive-shaped recess. ONE ExtrudeGeometry handles walls + floor in a
 * single mesh — the extrusion's auto-generated caps double as the
 * floor (visible) and the unused top cap (culled).
 *
 * Normals + winding are inverted so the recess reads as a CAVITY:
 *   - side walls face INWARD (toward the centroid) — visible from inside
 *     the recess looking out, hidden from outside looking in.
 *   - top cap (at y=headHeight) faces DOWN → back-face culled when the
 *     camera looks down at the screw; recess opening stays clear.
 *   - bottom cap (at y=headHeight-depth) faces UP → visible from above;
 *     serves as the recess floor with the correct drive shape.
 *
 * Net: one mesh, drive-shaped socket from any viewing angle. No
 * z-fighting (single floor face), no covered opening.
 */
function _buildRecess(driveStyle, D, headHeight, recessDepth) {
  const T = window.THREE;
  const drivePath = _drivePath2D(driveStyle, D);

  const shape = new T.Shape(drivePath);
  const geom  = new T.ExtrudeGeometry(shape, {
    depth:        recessDepth,
    bevelEnabled: false,
    steps:        1,
  });
  // Extrude is in +Z; rotate to +Y, translate to head top.
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, headHeight, 0);

  // Flip normals + winding so the extrusion reads as a hole. Done in
  // place; no copy.
  const norm = geom.attributes.normal;
  if (norm) {
    for (let i = 0; i < norm.array.length; i++) norm.array[i] *= -1;
    norm.needsUpdate = true;
  }
  if (geom.index) {
    const idx = geom.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const tmp = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = tmp;
    }
    geom.index.needsUpdate = true;
  }

  return [new T.Mesh(geom)];
}

// ─── Shank ─────────────────────────────────────────────────────────────────

function _shank(D, L) {
  const m = _cyl(D / 2, D / 2, L, 24);
  m.position.y = -L / 2;
  return m;
}

// ─── 2D path helpers ───────────────────────────────────────────────────────

function _circlePath2D(radius, segments) {
  const T = window.THREE;
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new T.Vector2(radius * Math.cos(a), radius * Math.sin(a)));
  }
  return pts;
}

function _hexagonPath2D(circumscribedR) {
  const T = window.THREE;
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;   // flat top orientation
    pts.push(new T.Vector2(circumscribedR * Math.cos(a), circumscribedR * Math.sin(a)));
  }
  return pts;
}

function _drivePath2D(driveStyle, D) {
  const T = window.THREE;
  switch (driveStyle) {
    case 'phillips': {
      const armL = D * 0.375;
      const armW = D * 0.09;
      return _crossOutline(armL, armW);
    }
    case 'slotted': {
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
      const r = D * 0.32;
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        pts.push(new T.Vector2(r * Math.cos(a), r * Math.sin(a)));
      }
      return pts;
    }
    case 'torx': {
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
    default:
      return _circlePath2D(D * 0.15, 16);
  }
}

function _crossOutline(armL, armW) {
  const T = window.THREE;
  return [
    new T.Vector2( armL, -armW),
    new T.Vector2( armL,  armW),
    new T.Vector2( armW,  armW),
    new T.Vector2( armW,  armL),
    new T.Vector2(-armW,  armL),
    new T.Vector2(-armW,  armW),
    new T.Vector2(-armL,  armW),
    new T.Vector2(-armL, -armW),
    new T.Vector2(-armW, -armW),
    new T.Vector2(-armW, -armL),
    new T.Vector2( armW, -armL),
    new T.Vector2( armW, -armW),
  ];
}

// ─── Primitive helpers ─────────────────────────────────────────────────────

function _cyl(topR, botR, height, segments) {
  const T = window.THREE;
  return new T.Mesh(new T.CylinderGeometry(topR, botR, height, segments));
}

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
