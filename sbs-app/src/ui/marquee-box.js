/**
 * SBS — the rubber-band rectangle + its live mode badge (V0.3.4.11), for the OVERLAY's
 * box-select. Same look and the same two glyphs as the 3D scene's (src/main.js, "Marquee
 * (box-select) overlay"): that one is woven into the 3D pointer handlers and is left alone —
 * this is its twin with its own two elements, so the overlay can never strand the 3D badge
 * nor the other way round.
 *
 *   mode glyph:  ⿻ intersect — whatever the box touches (default) · ⿴ fully enclosed (Ctrl / ⌘)
 *   op badge:    + green = ADD (Shift) · − red = REMOVE (Alt; wins over Shift)
 *
 * The badge is a DOM element that follows the pointer, not a CSS cursor: browsers freeze the
 * CSS cursor while a button is held, so a cursor could only change after the release.
 */

let _rect = null, _icon = null;

function _ensure() {
  if (_rect) return;
  _rect = document.createElement('div');
  _rect.id = 'overlay-selection-rect';
  _rect.style.cssText = 'position:fixed;pointer-events:none;border:1px solid #f59e0b;background:rgba(245,158,11,0.10);display:none;z-index:999;';
  _icon = document.createElement('div');
  _icon.id = 'overlay-marquee-icon';
  _icon.style.cssText = 'position:fixed;pointer-events:none;display:none;z-index:1000;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));';
  document.body.appendChild(_rect);
  document.body.appendChild(_icon);
}

function _iconSvg(windowMode, op) {
  const main = `<text x="11" y="20" font-size="18" text-anchor="middle" fill="white" stroke="black" stroke-width="0.6" font-family="sans-serif" paint-order="stroke">${windowMode ? '⿴' : '⿻'}</text>`;
  const opEl = op ? `<text x="25" y="13" font-size="14" text-anchor="middle" fill="${op === '+' ? '#4ade80' : '#f87171'}" stroke="black" stroke-width="0.8" font-family="sans-serif" font-weight="bold" paint-order="stroke">${op}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="26" style="display:block">${main}${opEl}</svg>`;
}

/** Draw the rectangle between two CLIENT points and park the badge at the second one. */
export function showMarqueeBox(x1, y1, x2, y2, { ctrl = false, shift = false, alt = false } = {}) {
  _ensure();
  _rect.style.left = `${Math.min(x1, x2)}px`;
  _rect.style.top = `${Math.min(y1, y2)}px`;
  _rect.style.width = `${Math.abs(x2 - x1)}px`;
  _rect.style.height = `${Math.abs(y2 - y1)}px`;
  _rect.style.display = 'block';
  _icon.style.left = `${x2 + 16}px`;
  _icon.style.top = `${y2 + 10}px`;
  setMarqueeBadge({ ctrl, shift, alt });
}

/** The badge alone — a modifier went down or up while the pointer stood still. */
export function setMarqueeBadge({ ctrl = false, shift = false, alt = false } = {}) {
  _ensure();
  _icon.innerHTML = _iconSvg(!!ctrl, alt ? '−' : shift ? '+' : null);
  _icon.style.display = 'block';
}

export function hideMarqueeBox() {
  if (!_rect) return;
  _rect.style.display = 'none';
  _icon.style.display = 'none';
}

export const marqueeBoxVisible = () => !!_rect && _rect.style.display !== 'none';
