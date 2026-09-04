/**
 * SBS — 3D-anchored overlay shapes (V0.3.2.151)
 * ==============================================
 *
 * An arrow or line whose two ENDPOINTS live in 3D world space. Each endpoint
 * is placed by clicking a surface in the viewport; the click's world point is
 * stored verbatim and the shape is redrawn on the Konva overlay wherever that
 * point projects to. Orbit the camera and the arrow tracks the scene.
 *
 * ANCHORED TO SPACE, NOT TO OBJECTS. The mesh under the click only supplies
 * the coordinate — nothing references it afterwards. Hiding or deleting that
 * object leaves the anchor exactly where it was. That is the whole point: an
 * illustration tool, not a constraint system. (Contrast notes and cables,
 * which deliberately store an object-LOCAL anchor so they DO follow. This is
 * that code minus the worldToLocal step, not plus anything.)
 *
 * Drawn on the overlay so 3D geometry can never occlude it.
 *
 * ── The one rule that keeps this safe ──────────────────────────────────────
 * The world anchors are the ONLY authored state. A Konva node's `points` are
 * a RENDER-TIME SCRATCH VALUE recomputed every frame, and five subsystems in
 * this app assume node geometry is authored and persistent:
 *
 *   - _writeOverlayToStep serialises it into step.overlay  → the camera pose
 *     at save time would be baked into the project file
 *   - render-cache hashes that JSON at 1e-4              → drifting pixels
 *     would thrash the cached render segments
 *   - _rescaleOnCanonicalChange multiplies node x/y      → harmless here only
 *     because anchored nodes keep x/y at 0 and carry absolute coords in
 *     `points`, which that pass does not touch
 *   - shape-links stamps `points` across every step      → anchored shapes are
 *     therefore barred from links
 *   - Transformer + draggable let the user grab it       → anchored shapes are
 *     non-draggable; endpoints move via right-click → reposition
 *
 * Break any of those and it LOOKS fine in the viewport while quietly leaking
 * derived coordinates into the saved project.
 */

import { sceneCore }        from '../core/scene.js';
import { getCanonicalSize } from '../core/safe-frame.js';

/** `kind` attr marking an anchored shape. */
export const ANCHOR_KIND = 'anchor3d';

export function isAnchoredNode(node) {
  return node?.getAttr?.('kind') === ANCHOR_KIND;
}

/**
 * Hide a shape when an endpoint leaves the frame, as opposed to only when it
 * goes BEHIND the camera.
 *
 * Behind-the-camera culling is mandatory — the perspective divide flips and
 * the projected point is meaningless. Off-screen-but-in-front is different:
 * the point is still correct, just outside the frame, and Konva clips it for
 * free. Hiding then makes an arrow pointing at something near the edge blink
 * out on a one-pixel camera nudge.
 *
 * Left OFF for that reason. Flip to true for "any endpoint off-screen hides
 * the whole shape".
 */
const HIDE_WHEN_OFFSCREEN = false;

/**
 * Refresh the camera matrices before projecting.
 *
 * Vector3.project() reads camera.matrixWorldInverse, which the renderer
 * updates inside renderer.render(). Tick hooks run BEFORE that, so without
 * this every projection uses the PREVIOUS frame's pose — visible as lag and
 * jitter while the camera moves. Worse during export: a static-hold frame
 * skips the render entirely, so nothing would ever refresh them.
 * notes-render.js hit the same wall and solves it the same way.
 */
export function refreshCameraMatrices() {
  const cam = sceneCore?.camera;
  if (!cam) return false;
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  return true;
}

/**
 * World XYZ → Konva stage coordinates, or null when the point is behind the
 * camera.
 *
 * The overscan step is the subtle one. With live overscan the camera zooms
 * OUT (zoom = 1/ov) so the canvas shows the export frame plus a margin, which
 * means the canonical frame is the CENTRE 1/ov of the NDC range — multiplying
 * NDC by ov maps it back to [-1,1] of the canonical frame. Konva node coords
 * are canonical export pixels, so that is the space to land in.
 *
 * It must read getEffectiveOverscan(), not getOverscan(): the latter reports
 * the user's live preference and ignores export framing, so using it would
 * scale every point off-centre in an export while looking perfect on screen.
 */
export function projectWorldToStage(world) {
  const cam = sceneCore?.camera;
  if (!cam || !world) return null;
  const v = new THREE.Vector3(world[0], world[1], world[2]);
  v.project(cam);
  // z outside [-1,1] means behind the eye (or past the far plane) — the
  // perspective divide has flipped and x/y are nonsense.
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || v.z > 1 || v.z < -1) return null;

  const ov = typeof sceneCore.getEffectiveOverscan === 'function'
    ? sceneCore.getEffectiveOverscan()
    : 1;
  const c = getCanonicalSize();
  return {
    x: ( v.x * ov + 1) * 0.5 * c.width,
    y: (-v.y * ov + 1) * 0.5 * c.height,
  };
}

/**
 * Recompute one anchored node's points from its world anchors.
 * Returns true when the node is visible, false when it was culled.
 */
export function reprojectNode(node) {
  if (!isAnchoredNode(node)) return true;
  const a = node.getAttr('anchorA');
  const b = node.getAttr('anchorB');
  const pa = projectWorldToStage(a);
  const pb = projectWorldToStage(b);

  if (!pa || !pb) { node.visible(false); return false; }

  if (HIDE_WHEN_OFFSCREEN) {
    const c = getCanonicalSize();
    const out = (p) => p.x < 0 || p.y < 0 || p.x > c.width || p.y > c.height;
    if (out(pa) || out(pb)) { node.visible(false); return false; }
  }

  // Absolute coordinates in `points`, node origin pinned at 0,0 — so the
  // canonical-resize pass (which scales x/y and never touches points) cannot
  // corrupt an anchored shape, and the next tick rebuilds points anyway.
  node.x(0);
  node.y(0);
  node.points([pa.x, pa.y, pb.x, pb.y]);
  node.visible(true);
  return true;
}

/**
 * Reproject every anchored node across the given layers.
 *
 * The ghost layer matters: a step crossfade MOVES the outgoing step's real
 * nodes there rather than destroying them, and the export composites both. A
 * pass that walked only the content layer would leave the fading-out arrows
 * frozen at the previous camera pose for the length of the transition.
 *
 * Returns how many nodes were touched, so a caller can skip a redraw when
 * there is nothing anchored on screen.
 */
export function reprojectAll(layers) {
  let n = 0;
  for (const layer of layers) {
    for (const node of layer?.getChildren?.() || []) {
      if (!isAnchoredNode(node)) continue;
      reprojectNode(node);
      n++;
    }
  }
  return n;
}

/** Does any layer hold an anchored node? Cheap guard for the tick hook. */
export function hasAnchoredNodes(layers) {
  for (const layer of layers) {
    for (const node of layer?.getChildren?.() || []) {
      if (isAnchoredNode(node)) return true;
    }
  }
  return false;
}
