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

import { toCreasedNormals } from '../../vendor/BufferGeometryUtils.bundle.mjs';

// ─── Public API ─────────────────────────────────────────────────────────────

export const HEAD_TYPES   = ['button', 'flat', 'socket', 'lowhead', 'hex', 'flange'];
export const DRIVE_STYLES = ['none', 'phillips', 'slotted', 'hex', 'torx'];

export function generateScrewMesh({ diameter, length, headType, driveStyle }, washers = null) {
  const T = window.THREE;
  if (!T) throw new Error('THREE not loaded');

  const D = Math.max(0.5, Number(diameter) || 4);
  const L = Math.max(D * 0.5, Number(length) || 20);
  const head  = String(headType   || 'socket');
  const drive = String(driveStyle || 'none');

  const parts = [];
  parts.push(_shank(D, L));
  const headParams = _headParams(head, D);
  parts.push(..._buildHead(head, D, drive));

  // V0.2.22.47 — per-instance washers, wedged against the head's
  // underside (y=0, the head/shank interface). _buildWashers picks
  // sizes based on the head's widest radius and the user's
  // washer-stack config (count + spring).
  if (washers && (washers.count || washers.spring)) {
    parts.push(..._buildWashers(washers, D, headParams));
  }

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
      // V0.2.22.46 — flange head is a HEX nut on top of a SOLID
      // circular flange disc. Flange diameter is 5% larger than
      // the hex's point-to-point diameter (corner-to-corner), so
      // the rim sticks out just past the hex corners — a thin
      // lip, like a real flanged hex bolt. Previously the flange
      // was 1.62× the hex; the user wanted ~1.05×.
      topR:      0.866 * D,           // hex circumscribed radius (top)
      botR:      0.866 * 1.05 * D,    // flange disc outer radius (= botR for bottom cap)
      height:    0.7   * D,           // total head height (flange + hex body)
      kind:      'flange',
      hexR:      0.866 * D,           // hex circumscribed radius (across corners)
      flangeR:   0.866 * 1.05 * D,    // flange disc outer radius = hexR × 1.05
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

  // 2. SOLID disc on top of the flange — full circle at y=flangeH, no
  //    cutout. The hex prism (built next) sits ON TOP of this disc;
  //    the disc's interior region is covered by the hex prism's
  //    bottom from above. Z-fight under the hex shares the same
  //    material so it's invisible. V0.2.22.46 — previously this was
  //    an annulus with a hex hole; user asked for a solid disc.
  const ringGeom = new T.ShapeGeometry(new T.Shape(_circlePath2D(p.flangeR, 32)));
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

// ─── Washers (V0.2.22.47) ──────────────────────────────────────────────────
//
// Each washer is wedged against the head's underside (y=0). Multiple
// washers stack downward along the shank. Sizing rules (from user spec):
//
//   - Inner Ø  = shankD × 1.1  (standard clearance hole)
//   - Outer Ø  = headOuterD × 1.2  (single washer / second of stack)
//   - For 2-washer stacks: the first (head-contact) washer is HEAD × 1.1
//     and the second is HEAD × 1.2. Same rule when the first is a
//     spring washer (in a spring+flat combo).
//   - Thickness = D × 0.15 standard, spring's total height = 1.2× that
//
// Stacking order top-down: head → spring (if any) → flat washer(s) → shank.

function _buildWashers(washers, D, headParams) {
  const count  = Math.max(0, Math.min(2, Number(washers?.count) || 0));
  const spring = !!washers?.spring;
  if (!count && !spring) return [];

  // Head outer diameter — widest point of the head, varies by head type.
  // For flange it's the flange disc; for flat it's the wide top; for
  // hex it's the circumscribed radius; etc.
  const headOuterD = Math.max(headParams.topR, headParams.botR) * 2;

  const innerR = D * 0.55;                                  // = D × 1.1 / 2
  const outerR_small = (headOuterD * 1.1) / 2;              // first-in-stack
  const outerR_big   = (headOuterD * 1.2) / 2;              // single / second
  // V0.2.22.50 — fixed 1.2 mm thickness for ALL washers (was D × 0.15,
  // which scaled with screw size). 1 scene unit = 1 mm, so 1.2 here.
  const thickness = 1.2;

  // Build the stack from head DOWN. Each entry: { kind, outerR }.
  //
  // V0.2.22.49 — `count` is the TOTAL washer count; `spring` means ONE
  // of them is a spring washer placed LAST (farthest from head, against
  // the work surface). This matches the menu labels exactly:
  //   {count:1, spring:false} → 1 flat
  //   {count:2, spring:false} → 2 flat
  //   {count:1, spring:true}  → 1 spring (no flat)
  //   {count:2, spring:true}  → 1 flat + 1 spring (spring AFTER the flat)
  //
  // Previously the spring was pushed FIRST (against the head) and the
  // flats were added ON TOP of the count, producing one extra washer.
  // Both bugs fixed here.
  const numFlat = spring ? Math.max(0, count - 1) : count;
  const stack = [];
  for (let i = 0; i < numFlat; i++) stack.push({ kind: 'flat', outerR: 0 });
  if (spring) stack.push({ kind: 'spring', outerR: 0 });

  // Apply the sizing rule: first-in-stack (against head) is HEAD × 1.1
  // when there are 2+ items, otherwise HEAD × 1.2. Subsequent items
  // are HEAD × 1.2.
  if (stack.length === 1) {
    stack[0].outerR = outerR_big;
  } else if (stack.length > 1) {
    stack[0].outerR = outerR_small;
    for (let i = 1; i < stack.length; i++) stack[i].outerR = outerR_big;
  }

  // Lay them out vertically downward from y=0. yTop is the TOP of the
  // current washer (the face that touches whatever's above).
  let yTop = 0;
  const meshes = [];
  for (const w of stack) {
    if (w.kind === 'flat') {
      meshes.push(_flatWasher(innerR, w.outerR, thickness, yTop));
      yTop -= thickness;
    } else {
      // Spring — total height = thickness × 1.4 (pre-compressed look,
      // V0.2.22.50; was 1.2×).
      const totalH = thickness * 1.4;
      meshes.push(_springWasher(innerR, w.outerR, thickness, totalH, yTop));
      yTop -= totalH;
    }
  }
  return meshes;
}

/**
 * Flat washer — annular disc. Built via ExtrudeGeometry of (outer
 * circle with inner-circle hole), extruded downward by `thickness` so
 * the top sits at y=yTop (touching whatever's above).
 */
function _flatWasher(innerR, outerR, thickness, yTop) {
  const T = window.THREE;
  const shape = new T.Shape(_circlePath2D(outerR, 32));
  shape.holes = [new T.Path(_circlePath2D(innerR, 32))];
  const geom = new T.ExtrudeGeometry(shape, {
    depth:        thickness,
    bevelEnabled: false,
    steps:        1,
  });
  // rotateX(+PI/2) sends the extrusion downward (+Z → -Y), matching
  // the driver-insert pattern: top face at y=0 in local, after translate
  // at y=yTop; bottom face at y=yTop-thickness. Top normal +Y, bottom -Y.
  geom.rotateX(Math.PI / 2);
  geom.translate(0, yTop, 0);
  return new T.Mesh(geom);
}

/**
 * Spring washer — annular ring with a helical cut. "Pre-compressed":
 * the helix climb over one revolution is small, so the washer reads as
 * a flat ring with a visible step at the cut rather than a tall spring.
 *
 *   thickness  — radial cross-section's height (material gauge)
 *   totalH     — y-distance from highest point to lowest, including the
 *                helical climb. = thickness × 1.2 per spec.
 *   yTop       — y position of the HIGHEST face (top edge of the cut
 *                at the start of the helix).
 *
 * Geometry:
 *   - Sample N angles around the circumference.
 *   - At each angle θ, the cross-section's BOTTOM y is
 *       yBot(θ) = yTop - thickness - (1 - θ/(2π)) × pitch
 *     where pitch = totalH - thickness. Highest cross-section is at θ=0
 *     (top at yTop), lowest at θ=2π (top at yTop - pitch).
 *   - For each cross-section build 4 vertices (inner-bot, outer-bot,
 *     outer-top, inner-top). 4 surfaces × N segments worth of quads
 *     between consecutive cross-sections, plus 2 cap rectangles at the
 *     helix start/end (the visible split-ring gap).
 */
function _springWasher(innerR, outerR, thickness, totalH, yTop) {
  const T = window.THREE;
  const segments = 32;
  const pitch    = totalH - thickness;    // helical climb over one revolution

  const positions = [];
  const indices   = [];

  // Generate 4 vertices per cross-section (N+1 cross-sections total —
  // the last one is at θ=2π which is NOT shared with θ=0; the gap
  // between them is the split-ring cut).
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    // Highest cross-section at θ=0, descending to θ=2π.
    const yT = yTop - (theta / (Math.PI * 2)) * pitch;
    const yB = yT - thickness;
    positions.push(
      innerR * c, yB, innerR * s,    // 0 inner-bot
      outerR * c, yB, outerR * s,    // 1 outer-bot
      outerR * c, yT, outerR * s,    // 2 outer-top
      innerR * c, yT, innerR * s,    // 3 inner-top
    );
  }

  // Helical ribbon — quad strips connecting consecutive cross-sections.
  // V0.2.22.48 — winding reversed vs .47: every triangle had its normal
  // pointing the wrong way (computeVertexNormals derives the normal from
  // winding, and the whole ribbon was wound clockwise-as-seen-from-
  // outside, which gives inward normals). Swapping the 2nd/3rd index of
  // each triangle flips all of them outward.
  for (let i = 0; i < segments; i++) {
    const a = i * 4;          // first vertex of segment i
    const b = (i + 1) * 4;    // first vertex of segment i+1
    // Outer side (outward-facing).
    indices.push(a + 1, b + 2, b + 1);
    indices.push(a + 1, a + 2, b + 2);
    // Inner side (inward-facing).
    indices.push(a + 0, b + 3, a + 3);
    indices.push(a + 0, b + 0, b + 3);
    // Top side (upward).
    indices.push(a + 3, b + 2, a + 2);
    indices.push(a + 3, b + 3, b + 2);
    // Bottom side (downward).
    indices.push(a + 0, b + 1, b + 0);
    indices.push(a + 0, a + 1, b + 1);
  }

  // Cap faces at the split-ring gap. Start cap at θ=0 (highest end),
  // end cap at θ=2π (lowest end). Both face out of the gap. Winding
  // flipped to match the ribbon (V0.2.22.48).
  indices.push(0, 3, 2);
  indices.push(0, 2, 1);
  // End cap (vertices N..N+3 where N = segments*4):
  const N = segments * 4;
  indices.push(N, N + 2, N + 3);
  indices.push(N, N + 1, N + 2);

  const geom = new T.BufferGeometry();
  geom.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  // V0.2.22.49 — crease normals at 45°. Without this the whole washer is
  // one smooth group: the 90° corners between inner/outer/top/bottom
  // surfaces round off (computeVertexNormals averages across them),
  // making the ring look like a soft torus. A 45° crease angle keeps
  // the gentle helical sweep (consecutive segments differ by only
  // 360/32 ≈ 11°, well under 45°, so they stay smooth) but hardens the
  // surface-to-surface corners (90° > 45° → split normals).
  const creased = toCreasedNormals(geom, Math.PI / 4);   // 45°
  return new T.Mesh(creased);
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
