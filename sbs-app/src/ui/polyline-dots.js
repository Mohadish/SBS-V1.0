/**
 * SBS — the point handles of a 2D line / arrow in its point-edit mode (V0.3.4.15).
 * DOM dots in CLIENT px over the viewport — never Konva nodes: the overlay stage is serialised
 * WHOLE into step.overlay, and a handle alive during a debounced save would be baked into the
 * step. The overlay owns the geometry; this file only shows dots and reports gestures.
 *
 *   drag a dot          → onMove(index, clientX, clientY, event) … onEnd(index, moved)
 *   double-click a dot  → onDblClick(index)
 */

let _host = null, _h = null, _drag = null;
const _pool = [];

function _ensure() {
  if (_host) return;
  _host = document.createElement('div');
  _host.id = 'overlay-polyline-dots';
  _host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:997;';
  document.body.appendChild(_host);
  window.addEventListener('pointermove', (e) => {
    if (!_drag) return;
    if (!(e.buttons & 1)) { _finish(); return; }                       // the release was lost (another window took it)
    if (!_drag.moved && Math.hypot(e.clientX - _drag.x0, e.clientY - _drag.y0) < 3) return;
    _drag.moved = true;
    _h?.onMove?.(_drag.index, e.clientX, e.clientY, e);
  }, true);
  window.addEventListener('pointerup', () => _finish(), true);
  window.addEventListener('pointercancel', () => _finish(), true);
  window.addEventListener('blur', () => _finish());
}
function _finish() {
  const d = _drag; if (!d) return;
  _drag = null;
  _h?.onEnd?.(d.index, d.moved);
}

function _dot() {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;box-sizing:border-box;border-radius:50%;border:2px solid #f59e0b;cursor:grab;touch-action:none;display:none;box-shadow:0 0 0 1px rgba(0,0,0,.45);';
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    _drag = { index: Number(d.dataset.index), x0: e.clientX, y0: e.clientY, moved: false };
    _h?.onStart?.(_drag.index, e);
  });
  d.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); _h?.onDblClick?.(Number(d.dataset.index), e); });
  d.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  return d;
}

/**
 * @param {Array<{x:number,y:number,end:boolean,head:boolean}>} dots  client px, in point order
 * @param {{onStart?,onMove?,onEnd?,onDblClick?}} handlers
 */
export function showPolylineDots(dots, handlers) {
  _ensure();
  _h = handlers || null;
  while (_pool.length < dots.length) { const d = _dot(); _host.appendChild(d); _pool.push(d); }
  _pool.forEach((d, i) => {
    const p = dots[i];
    if (!p || p.hidden) { d.style.display = 'none'; d.dataset.index = String(i); return; }
    const size = p.end ? 14 : 11;
    d.dataset.index = String(i);
    d.style.width = d.style.height = `${size}px`;
    d.style.left = `${Math.round(p.x - size / 2)}px`;
    d.style.top = `${Math.round(p.y - size / 2)}px`;
    d.style.background = p.end && p.head ? '#f59e0b' : '#ffffff';       // a filled end wears an arrowhead
    d.title = p.end
      ? `Drag to move this end · double-click: arrowhead ${p.head ? 'off' : 'on'}`
      : 'Drag to move this point · double-click: delete it';
    d.style.display = 'block';
  });
}

export function hidePolylineDots() {
  _drag = null; _h = null;
  for (const d of _pool) d.style.display = 'none';
}

export const polylineDotDragging = () => !!_drag;
