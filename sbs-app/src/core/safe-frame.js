/**
 * SBS — Safe Frame / Canonical Coordinates
 * =========================================
 * The "safe frame" is the rectangle inside the viewport that maps 1:1
 * to the export image (e.g. 1920×1080). All overlay items (textboxes,
 * images, headers) live in CANONICAL coordinates — pixels in the
 * export image's space — so a project saved on one machine renders
 * identically on another regardless of viewport size, screen DPR, or
 * browser zoom.
 *
 * Display flow:
 *   • Canonical size = state.export.width × state.export.height.
 *   • computeSafeFrameRect(viewportRect) returns the rect inside the
 *     viewport (centred) that has the canonical aspect ratio and fits.
 *   • Konva stage / overlay code feeds positions through
 *     canonicalToViewport on render and viewportToCanonical on commit.
 *
 * This module is pure math — no DOM, no state writes. Callers pull the
 * canonical size on demand so changing state.export.width/height
 * propagates without subscriptions here.
 */

import state from './state.js';

/**
 * Pull the canonical export size from state.export. Falls back to
 * 1920×1080 if missing or non-positive (so a fresh project has a
 * reasonable default before the user touches the Export tab).
 *
 * @returns {{ width:number, height:number, aspect:number }}
 */
export function getCanonicalSize() {
  const exp = state.get('export') || {};
  const width  = (Number.isFinite(exp.width)  && exp.width  > 0) ? exp.width  : 1920;
  const height = (Number.isFinite(exp.height) && exp.height > 0) ? exp.height : 1080;
  return { width, height, aspect: width / height };
}

/**
 * Compute the safe-frame rectangle inside a viewport. The frame keeps
 * the canonical aspect ratio and is centred in the viewport,
 * letterboxing whichever axis is the limiting factor.
 *
 * @param {{ width:number, height:number }} viewport
 * @returns {{ x:number, y:number, width:number, height:number, scale:number }}
 *   `scale` = canonicalToViewport multiplier on either axis (uniform).
 */
export function computeSafeFrameRect(viewport) {
  const { width: cw, height: ch, aspect: ca } = getCanonicalSize();
  const vw = viewport?.width  || 0;
  const vh = viewport?.height || 0;
  if (vw <= 0 || vh <= 0) return { x: 0, y: 0, width: 0, height: 0, scale: 0 };

  const va = vw / vh;
  let w, h;
  if (va >= ca) {
    // Viewport is wider than canonical → pillarbox left/right.
    h = vh;
    w = vh * ca;
  } else {
    // Viewport is taller than canonical → letterbox top/bottom.
    w = vw;
    h = vw / ca;
  }
  const scale = w / cw;   // == h / ch
  return {
    x: (vw - w) / 2,
    y: (vh - h) / 2,
    width:  w,
    height: h,
    scale,
  };
}

/**
 * Convert a viewport pixel coord to canonical coord. Useful at commit
 * time — drag handlers run in viewport pixels and convert once when
 * persisting.
 *
 * @param {number} vx
 * @param {number} vy
 * @param {{ width:number, height:number }} viewport
 * @returns {{ x:number, y:number }}  in canonical pixels
 */
export function viewportToCanonical(vx, vy, viewport) {
  const r = computeSafeFrameRect(viewport);
  if (r.scale <= 0) return { x: 0, y: 0 };
  return { x: (vx - r.x) / r.scale, y: (vy - r.y) / r.scale };
}

/**
 * Convert a canonical pixel coord to viewport coord. Used at render
 * time to position canonical overlays inside the safe frame.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {{ width:number, height:number }} viewport
 * @returns {{ x:number, y:number }}  in viewport pixels
 */
export function canonicalToViewport(cx, cy, viewport) {
  const r = computeSafeFrameRect(viewport);
  return { x: r.x + cx * r.scale, y: r.y + cy * r.scale };
}

/**
 * Position the existing #export-safe-frame DOM element to draw the
 * frame outline at the correct rect inside its container. Pure DOM
 * work — caller is responsible for visibility (the CSS .show class).
 *
 * @param {HTMLElement} frameEl     #export-safe-frame
 * @param {HTMLElement} containerEl the viewport container the frame
 *                                  is positioned within
 */
export function positionSafeFrameEl(frameEl, containerEl) {
  if (!frameEl || !containerEl) return;
  const r = computeSafeFrameRect({
    width:  containerEl.clientWidth,
    height: containerEl.clientHeight,
  });
  frameEl.style.left   = `${r.x}px`;
  frameEl.style.top    = `${r.y}px`;
  frameEl.style.width  = `${r.width}px`;
  frameEl.style.height = `${r.height}px`;
}
