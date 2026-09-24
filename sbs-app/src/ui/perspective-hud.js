/**
 * SBS — the Alt-wheel perspective badge (V0.3.4.22).
 *
 * While Alt is held over the viewport, a small chip follows the cursor showing
 * a wireframe box drawn AT THE CURRENT PERSPECTIVE — the back face shrinks as
 * the lens widens and sits exactly behind the front face at the orthographic
 * end. The icon is the readout: you see what the wheel is about to do before
 * you turn it.
 *
 * DOM, fixed-positioned, `pointer-events:none`, created lazily — the same
 * treatment as the magnet's guides (ui/snap-guides.js). Nothing here touches
 * the Konva stage or the 3D scene, so nothing can be baked into a step.
 */

import { kOf, isOrtho, perspectiveLabel } from '../core/perspective.js';

const AMBER = '#f59e0b';
let _el = null, _icon = null, _val = null, _hint = null;
let _x = 0, _y = 0, _shown = false;

function _ensure() {
  if (_el) return;
  _el = document.createElement('div');
  _el.id = 'perspective-badge';
  _el.style.cssText = 'position:fixed;left:0;top:0;z-index:999;display:none;pointer-events:none;'
    + 'background:var(--float-bg-solid);border:1px solid var(--float-line);border-radius:10px;'   // V0.3.4.120 — theme-aware
    + 'padding:7px 10px 6px;box-shadow:var(--shadow-float);'
    + 'font:600 12px/1.25 system-ui,sans-serif;color:var(--float-text);text-align:center;user-select:none;';

  _icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  _icon.setAttribute('viewBox', '0 0 56 48');
  _icon.setAttribute('width', '56');
  _icon.setAttribute('height', '48');
  _icon.style.cssText = 'display:block;margin:0 auto 4px;overflow:visible;';
  _el.appendChild(_icon);

  _val = document.createElement('div');
  _val.style.cssText = `color:${AMBER};font-variant-numeric:tabular-nums;white-space:nowrap;`;
  _el.appendChild(_val);

  _hint = document.createElement('div');
  _hint.textContent = 'Alt + wheel';
  _hint.style.cssText = 'margin-top:2px;font:500 10px/1.2 system-ui,sans-serif;color:#9ca3af;'
    + 'letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;';
  _el.appendChild(_hint);

  document.body.appendChild(_el);
}

/**
 * The box, drawn at this perspective. The back face is the front face scaled by
 * s = 1/(1 + depth·2k) — the same size ratio a real box would show at this lens,
 * so the icon is a tiny, honest preview: parallel edges at the flat end, sharply
 * converging ones wide open.
 */
function _drawBox(fovDeg) {
  const k = kOf(fovDeg);
  const s = 1 / (1 + 2.6 * k);
  const fx = 5, fy = 13, fw = 24, fh = 25;            // front face
  const dx = 21, dy = -9;                              // depth direction
  const cx = fx + fw / 2 + dx, cy = fy + fh / 2 + dy;  // back-face centre
  const bw = fw * s, bh = fh * s;
  const bx = cx - bw / 2, by = cy - bh / 2;

  const rect = (x, y, w, h, op, wid) =>
    `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"`
    + ` fill="none" stroke="${AMBER}" stroke-opacity="${op}" stroke-width="${wid}" stroke-linejoin="round"/>`;
  const line = (x1, y1, x2, y2) =>
    `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"`
    + ` stroke="${AMBER}" stroke-opacity="0.55" stroke-width="1.3" stroke-linecap="round"/>`;

  const corners = [[fx, fy, bx, by], [fx + fw, fy, bx + bw, by],
                   [fx + fw, fy + fh, bx + bw, by + bh], [fx, fy + fh, bx, by + bh]];

  _icon.innerHTML =
    rect(bx, by, bw, bh, 0.45, 1.3)
    + corners.map(c => line(c[0], c[1], c[2], c[3])).join('')
    + rect(fx, fy, fw, fh, 1, 1.8);
}

function _place() {
  if (!_el) return;
  const w = _el.offsetWidth || 92, h = _el.offsetHeight || 84;
  const x = Math.min(Math.max(_x + 20, 6), window.innerWidth - w - 6);
  const y = Math.min(Math.max(_y + 18, 6), window.innerHeight - h - 6);
  _el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/** Show (or refresh) the badge at a client point, for this fov. */
export function showPerspectiveBadge(clientX, clientY, fovDeg) {
  _ensure();
  _x = clientX; _y = clientY;
  setPerspectiveBadgeValue(fovDeg);
  if (!_shown) { _el.style.display = 'block'; _shown = true; }
  _place();
}

/** Move it with the cursor without touching the value. */
export function movePerspectiveBadge(clientX, clientY) {
  if (!_shown) return;
  _x = clientX; _y = clientY;
  _place();
}

/**
 * New value, same position — what the wheel calls on every notch.
 * `hint` replaces the bottom line: the wheel passes "C saves it to the step",
 * because the camera is live until a step records it and that is the one thing
 * a user needs to be told at that moment.
 */
export function setPerspectiveBadgeValue(fovDeg, hint) {
  if (!_el) return;
  _drawBox(fovDeg);
  _val.textContent = perspectiveLabel(fovDeg);
  _val.style.color = isOrtho(fovDeg) ? '#7dd3fc' : AMBER;
  _hint.textContent = hint || 'Alt + wheel';
  _hint.style.color = hint ? '#d1d5db' : '#9ca3af';
  _place();
}

export function hidePerspectiveBadge() {
  if (!_el || !_shown) return;
  _el.style.display = 'none';
  _shown = false;
}

export function isPerspectiveBadgeVisible() { return _shown; }
