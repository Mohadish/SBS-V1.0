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

export const HEAD_TYPES   = ['button', 'flat', 'socket', 'lowhead', 'hex', 'flange'];
export const DRIVE_STYLES = ['none', 'phillips', 'slotted', 'hex', 'torx'];

export function generateScrewMesh({ diameter, length, headType, driveStyle }) {
  const T = window.THREE;
  if (!T) throw new Error('THREE not loaded');

  const D = Math.max(0.5, Number(diameter) || 4);
  const L = Math.max(D * 0.5, Number(length) || 20);
  const head  = String(headType   || 'socket');
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
  // kind = 'cyl' | 'cone' | 'hex' | 'dome' | 'flange'
  //   cyl    — straight cylinder outer wall (socket cap, low head)
  //   cone   — tapered cylinder (flat / countersunk; topR > botR)
  //   hex    — 6-sided prism outer wall
  //   dome   — shallow elliptical dome (button) — LatheGeometry profile
  //   flange — stepped profile: head body on top of a wider flange —
  //            LatheGeometry profile
  switch (headType) {
    case 'flat':    return { topR: 1.0   * D, botR: 0.5   * D, height: 0.6  * D, kind: 'cone' };
    case 'socket':  return { topR: 0.75  * D, botR: 0.75  * D, height: 1.0  * D, kind: 'cyl' };
    case 'lowhead': return { topR: 0.75  * D, botR: 0.75  * D, height: 0.6  * D, kind: 'cyl' };
    case 'hex':     return { topR: 0.866 * D, botR: 0.866 * D, height: 0.6  * D, kind: 'hex' };
    case 'button':  return { topR: 0.95  * D, botR: 0.95  * D, height: 0.4  * D, kind: 'dome' };
    case 'flange':  return {
      // V0.2.22.45 — flange head is a HEX nut with a circular rim
      // (flange) at the bottom. Upper portion: 6-sided prism (like
      // any hex bolt). Lower portion: round flange disc, wider than
      // the hex's circumscribed radius. Two separate primitives
      // composed: open hex prism on top of a cylindrical flange.
      // 'kind' stays 'flange' but the builder now produces hex+rim
      // geometry instead of the smooth-stepped LatheGeometry.
      topR:      0.866 * D,           // hex circumscribed radius (top)
      botR:      1.4   * D,           // flange disc outer radius (= botR for bottom cap)
      height:    0.7   * D,           // total head height (flange + hex body)
      kind:      'flange',
      hexR:      0.866 * D,           // hex circumscribed radius (across corners)
      flangeR:   1.4   * D,           // flange disc outer radius
      flangeH:   0.18  * D,           // flange disc thickness
    };
    default:        return { topR: 0.75  * D, botR: 0.75  * D, height: 0.6  * D, kind: 'cyl' };
  }
}

// ─── Head builder — universal pattern ──────────────────────────────────────

function _buildHead(headType, D, driveStyle) {
  const p = _headParams(headType, D);
  const hasDrive = driveStyle !== 'none';
  const cavityR  = D * 0.45;                          // constant, fits every drive
  // Cavity depth — for dome (button) heads, clamp tighter so the cavity
  // doesn't poke through the dome's underside.
  const cavityDepth = Math.min(
    p.height * (p.kind === 'dome' ? 0.55 : 0.65),
    p.height - D * 0.1,
  );

  const meshes = [];
  // Bottom cap (closes the head from below) is shared by every head type.
  meshes.push(_buildBottomCap(p));

  if (p.kind === 'dome') {
    // ── Button head — single elliptical dome via LatheGeometry. ─────────
    //   Outer surface + cavity opening rim are one continuous mesh.
    const profile = _domeProfile(p.topR, p.height, hasDrive ? cavityR : null, 12);
    meshes.push(_buildLathe(profile));
  } else if (p.kind === 'flange') {
    // ── Flange head — hex prism on top of a circular rim disc. ───────────
    //   Multi-part: open hex prism (flat-shaded), annular ring on top of
    //   the flange, open cylinder for the flange's outer wall, plus the
    //   standard top cap with cavity hole. Bottom cap (the flange disc's
    //   underside) is added by _buildBottomCap above.
    meshes.push(..._buildFlangeOuter(p, hasDrive ? cavityR : null));
    if (hasDrive) {
      meshes.push(_buildHeadTopHexWithCircleHole(p.hexR, p.height, cavityR));
    } else {
      meshes.push(_buildFlatTopCapHex(p.hexR, p.height));
    }
  } else {
    // ── Cylindrical / conical / hex heads ───────────────────────────────
    //   Outer wall = open primitive; top cap = separate flat polygon
    //   (with or without cavity hole depending on driveStyle).
    meshes.push(..._buildOuterWall(p));
    if (hasDrive) {
      meshes.push(_buildHeadTopWithCircleHole(p, cavityR));
    } else {
      meshes.push(_buildFlatTopCap(p));
    }
  }

  // ── Cavity floor + driver insert (only when there's a drive) ──────────
  if (hasDrive) {
    meshes.push(_buildCavityFloor(p, cavityR, cavityDepth));
    meshes.push(_buildDriverInsert(driveStyle, D, cavityR, p.height, cavityDepth));
  }

  return meshes;
}

// ─── Flange head builder — hex prism + circular rim ────────────────────────

/**
 * Build the outer body of a flange head: open hex prism for the upper
 * portion + open cylinder for the lower flange + annular ring connecting
 * the two at the flange-top transition.
 *
 * The hex prism gets flat shading (toNonIndexed + computeVertexNormals)
 * so each of the 6 faces reads as a distinct flat surface. Without that,
 * vertex-normal averaging across segments makes the hex look round.
 *
 * V0.2.22.45 — replaces the previous LatheGeometry flange. The old
 * lathe made the whole head smooth-shaded (one continuous curve), so
 * the hex faces blurred together and the flange-to-body transition had
 * no visible step.
 */
function _buildFlangeOuter(p, cavityR) {
  const T = window.THREE;
  const meshes = [];
  const hexBodyH = p.height - p.flangeH;     // upper hex portion height

  // 1. Flange outer wall — short cylinder, open ends.
  const flangeWall = new T.Mesh(
    new T.CylinderGeometry(p.flangeR, p.flangeR, p.flangeH, 32, 1, /* open */ true),
  );
  flangeWall.position.y = p.flangeH / 2;
  meshes.push(flangeWall);

  // 2. Annular ring on top of the flange (between hex outer and flange
  //    outer) — this is the visible "step" between flange and hex body.
  const ringShape = new T.Shape(_circlePath2D(p.flangeR, 32));
  ringShape.holes = [new T.Path(_circlePath2D(p.hexR, 6))];   // hex hole
  const ringGeom  = new T.ShapeGeometry(ringShape);
  ringGeom.rotateX(-Math.PI / 2);
  ringGeom.translate(0, p.flangeH, 0);
  meshes.push(new T.Mesh(ringGeom));

  // 3. Hex prism (upper head body) — open hex cylinder, flat-shaded so
  //    each of the 6 faces reads as a distinct flat surface.
  const hexWall = new T.Mesh(
    _flatShade(new T.CylinderGeometry(p.hexR, p.hexR, hexBodyH, 6, 1, true)),
  );
  hexWall.position.y = p.flangeH + hexBodyH / 2;
  meshes.push(hexWall);

  return meshes;
}

/**
 * Convert geometry to non-indexed and recompute vertex normals so each
 * face has its own face normal (flat shading). Returns a new geometry
 * — caller assigns it to the Mesh.
 *
 * Use for the hex prism in flange heads and (V0.2.22.45+) the hex head
 * outer wall — without flat shading, vertex-normal averaging blurs the
 * six faces into a smooth cylinder.
 */
function _flatShade(geom) {
  const nonIdx = geom.toNonIndexed();
  nonIdx.computeVertexNormals();
  geom.dispose();
  return nonIdx;
}

/** Hex top cap with a circular cavity hole — flange head, drive case. */
function _buildHeadTopHexWithCircleHole(hexR, headHeight, cavityR) {
  const T = window.THREE;
  const shape = new T.Shape(_hexagonPath2D(hexR));
  shape.holes = [new T.Path(_circlePath2D(cavityR, 32))];
  const geom  = new T.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, headHeight, 0);
  return new T.Mesh(geom);
}

/** Hex top cap, no hole — flange head, drive='none' case. */
function _buildFlatTopCapHex(hexR, headHeight) {
  const T = window.THREE;
  const geom = new T.ShapeGeometry(new T.Shape(_hexagonPath2D(hexR)));
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, headHeight, 0);
  return new T.Mesh(geom);
}

// ─── Lathe-based head profiles ─────────────────────────────────────────────

/**
 * Wrap a 2D profile (array of Vector2, x=radial, y=vertical) into a
 * LatheGeometry revolved 32 segments around the +Y axis.
 *
 * The profile must NOT start or end mid-radius if you want a sealed
 * solid — for our heads, the bottom cap (separate disk at y=0) closes
 * the open end at (outerR, 0), and the top either tapers to the axis
 * (drive=none case) or stops at the cavity opening (drive case, the
 * cavity wall/floor/insert provide the closure).
 */
function _buildLathe(profile) {
  const T = window.THREE;
  return new T.Mesh(new T.LatheGeometry(profile, 32));
}

/**
 * Dome profile for the button head — quarter-ellipse from the bottom
 * outer corner up to either (a) the axis apex when drive='none', or
 * (b) the cavity opening edge at (cavityR, p.height) when there's a
 * drive. The ellipse's vertical semi-axis is sized so the cavity edge
 * sits exactly at y=p.height — that way the cavity opening is flush
 * with the head's nominal top, even though the dome's "virtual apex"
 * (where it would peak if not truncated) is higher.
 */
function _domeProfile(headOuterR, headTop, cavityR, segments) {
  const T = window.THREE;
  const points = [];
  if (cavityR == null) {
    // Full dome to apex. Simple quarter-ellipse with semi-axes
    // (headOuterR, headTop).
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * (Math.PI / 2);
      points.push(new T.Vector2(
        headOuterR * Math.cos(theta),
        headTop    * Math.sin(theta),
      ));
    }
  } else {
    // Truncated dome — cavity opens at (cavityR, headTop). Solve for
    // the ellipse vertical semi-axis b such that the curve passes
    // through both (headOuterR, 0) and (cavityR, headTop):
    //   x²/a² + y²/b² = 1, with a = headOuterR.
    //   At (cavityR, headTop):  (cavityR/a)² + (headTop/b)² = 1
    //   → b = headTop / sqrt(1 - (cavityR/a)²)
    const a = headOuterR;
    const ratio = cavityR / a;
    const b = headTop / Math.sqrt(Math.max(1e-6, 1 - ratio * ratio));
    const thetaEnd = Math.acos(ratio);
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * thetaEnd;
      points.push(new T.Vector2(
        a * Math.cos(theta),
        b * Math.sin(theta),
      ));
    }
    // Snap last point exactly to (cavityR, headTop) — floating-point
    // accumulation can leave it off by ~1e-9, which produces a tiny
    // gap with the cavity floor/insert geometry below.
    points[points.length - 1] = new T.Vector2(cavityR, headTop);
  }
  return points;
}

/**
 * Head top with a circular cavity opening cut out. The cavity walls + floor
 * are intentionally NOT built here — the driver insert provides those
 * surfaces (its outer cylinder + bottom disk). LEGO-style: head has the
 * hole, insert has the body that fills the hole.
 */
function _buildHeadTopWithCircleHole(p, cavityR) {
  const T = window.THREE;
  const outer = (p.kind === 'hex')
    ? _hexagonPath2D(p.topR)
    : _circlePath2D(p.topR, 32);
  const shape = new T.Shape(outer);
  shape.holes = [new T.Path(_circlePath2D(cavityR, 32))];
  const geom = new T.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, p.height, 0);
  return new T.Mesh(geom);
}

// ─── Head's cavity floor (visible through the insert's drive hole) ─────────

/**
 * Full disk at the bottom of the head's cylindrical pocket. The drive
 * socket appears to "have a floor" because this disk is visible through
 * the drive-shaped through-hole in the insert above it.
 *
 *   - Radius cavityR (full pocket width).
 *   - At y = p.height - cavityDepth.
 *   - Normal +Y (faces up; visible from above through the drive hole).
 *
 * The annular portion of this floor (outside the drive-shape area) is
 * coincident with the insert's bottom annulus but with opposite normal
 * — same-material so any z-fight is invisible, and back-face culling
 * keeps only the floor's +Y face rendered when looking from above.
 */
function _buildCavityFloor(p, cavityR, cavityDepth) {
  const T = window.THREE;
  const geom = new T.ShapeGeometry(new T.Shape(_circlePath2D(cavityR, 32)));
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, p.height - cavityDepth, 0);
  return new T.Mesh(geom);
}

// ─── Driver insert — single extrusion of a 2D outline ──────────────────────

/**
 * The driver insert, authored exactly as you'd do it in a CAD tool:
 *
 *   1. Draw a circle (Ø = 2 × cavityR).
 *   2. Inside the circle, draw the driver shape (cross / slot / hex / star).
 *   3. Extrude the resulting (circle MINUS drive shape) outline up by
 *      cavityDepth so its top is flush with the head top.
 *
 * The extrusion produces a cylinder with a drive-shaped through-hole.
 * ExtrudeGeometry handles ALL the surfaces in one mesh:
 *
 *   - Outer wall (radius cavityR, normals outward — barely visible at
 *     the cavity-opening grazing angles, otherwise hidden by the head).
 *   - Top annulus (cavityR outer, drive-shape inner) at y=insertTopY —
 *     this is the visible rim around the drive socket.
 *   - Drive socket walls (the inner walls of the hole — normals point
 *     into the hole, which is what you see looking down into the socket).
 *   - Bottom annulus (back-face culled from above; redundant with the
 *     head's cavity floor where they overlap).
 *
 * No separate floor needed — the head's cavity floor is visible through
 * the drive-shape hole and serves as the socket floor.
 */
function _buildDriverInsert(driveStyle, D, cavityR, insertTopY, insertH) {
  const T = window.THREE;

  // 2D outline: circle with the drive shape carved out.
  const shape = new T.Shape(_circlePath2D(cavityR, 32));
  shape.holes = [new T.Path(_drivePath2D(driveStyle, D))];

  // Extrude vertically. ExtrudeGeometry extrudes along +Z. We need the
  // extrusion to go DOWN (from head top into the cavity), so we apply
  // rotateX(+PI/2) — that maps +Z onto -Y.
  //
  // After rotateX(+PI/2):
  //   original z=0 plane (the 2D shape) → y=0, normal +Y (faces up)
  //   original z=depth plane (extrusion end) → y=-depth, normal -Y
  // Translate by insertTopY: shape sits at y=insertTopY (flush with
  // head top, facing up), extrusion end at y=insertTopY-depth (cavity
  // floor level, facing down). ✓
  //
  // V0.2.22.42 had rotateX(-PI/2) — extrusion went UP, putting the
  // entire insert ABOVE the head. That's what made the screw look like
  // a head + a stub on top with the drive in the stub. This direction
  // tucks the insert into the head where it belongs.
  const geom = new T.ExtrudeGeometry(shape, {
    depth:        insertH,
    bevelEnabled: false,
    steps:        1,
  });
  geom.rotateX(Math.PI / 2);
  geom.translate(0, insertTopY, 0);

  return new T.Mesh(geom);
}

// ─── Flat (no-drive) top cap ────────────────────────────────────────────────

function _buildFlatTopCap(p) {
  const T = window.THREE;
  const outer = (p.kind === 'hex')
    ? _hexagonPath2D(p.topR)
    : _circlePath2D(p.topR, 32);
  const geom = new T.ShapeGeometry(new T.Shape(outer));
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, p.height, 0);
  return new T.Mesh(geom);
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
  let geom = new T.CylinderGeometry(p.topR, p.botR, p.height, segments, 1, /* open */ true);
  // V0.2.22.45 — flat-shade the hex head's outer prism so each face is
  // distinct. Without this, vertex normals average across segments and
  // the hex looks like a smooth cylinder.
  if (p.kind === 'hex') geom = _flatShade(geom);
  const wall = new T.Mesh(geom);
  wall.position.y = p.height / 2;
  return [wall];
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
