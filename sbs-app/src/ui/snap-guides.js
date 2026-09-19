/**
 * SBS — the magnet's guide lines (V0.3.4.12). Thin DOM lines in CLIENT px over the viewport,
 * shown while a dragged overlay item sits on a snap line. DOM on purpose, never Konva nodes:
 * the overlay stage is serialised WHOLE into step.overlay, and a debounced save in the middle
 * of a drag would bake a guide into the step.
 */

const COLOR = '#ff3df2';            // loud on purpose: visible on a dark model and on a white panel alike
let _host = null;
const _pool = [];

function _ensure() {
  if (_host) return;
  _host = document.createElement('div');
  _host.id = 'overlay-snap-guides';
  _host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:998;';
  document.body.appendChild(_host);
}

/** @param {Array<{x1:number,y1:number,x2:number,y2:number}>} lines  axis-parallel segments, client px */
export function showSnapGuides(lines) {
  _ensure();
  const n = (lines || []).length;
  while (_pool.length < n) {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;background:${COLOR};box-shadow:0 0 0 0.5px rgba(0,0,0,.35);pointer-events:none;display:none;`;
    _host.appendChild(d); _pool.push(d);
  }
  _pool.forEach((d, i) => {
    const l = lines?.[i];
    if (!l) { d.style.display = 'none'; return; }
    const vertical = Math.abs(l.x1 - l.x2) < 0.5;
    d.style.left = `${Math.round(Math.min(l.x1, l.x2))}px`;
    d.style.top = `${Math.round(Math.min(l.y1, l.y2))}px`;
    d.style.width = vertical ? '1px' : `${Math.max(1, Math.round(Math.abs(l.x2 - l.x1)))}px`;
    d.style.height = vertical ? `${Math.max(1, Math.round(Math.abs(l.y2 - l.y1)))}px` : '1px';
    d.style.display = 'block';
  });
}

export function hideSnapGuides() {
  for (const d of _pool) d.style.display = 'none';
}
