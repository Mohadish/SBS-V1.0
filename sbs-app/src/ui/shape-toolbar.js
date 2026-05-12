/**
 * SBS — Shape property toolbar
 * =============================
 *
 * Mini toolbar surfaced when a shape (rect / circle / ellipse / path / …)
 * is selected on the 2D overlay. Mirrors the lifecycle pattern of
 * text-toolbar.js: mountShapeToolbar() injects DOM into the host slot,
 * unmountShapeToolbar() rips it out.
 *
 * The toolbar reads its initial values from a getter callback and pipes
 * every control change through a single applyFn — overlay.js's apply
 * handler then writes the new attribute(s) onto every selected shape +
 * triggers save / undo.
 */

let _bar     = null;
let _applyFn = null;

const _esc = (s) => String(s ?? '').replace(/[<>&"']/g, c => (
  { '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]
));

/**
 * Convert any colour string the engine returns into a 7-char #rrggbb
 * for <input type="color">. Konva returns whatever the user set so we
 * have to be defensive — accept "#RGB" / "#RRGGBB" / "rgb()" / named.
 * Returns '#ffffff' on parse failure.
 */
function _toHex6(input) {
  if (!input) return '#ffffff';
  const s = String(input).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  // rgb()/rgba() — pull the digits.
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b] = m[1].split(',').map(p => Math.max(0, Math.min(255, Number(p) || 0)));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  // named colours — punt to a temp element.
  const div = document.createElement('div');
  div.style.color = s;
  document.body.appendChild(div);
  const cs = getComputedStyle(div).color;
  div.remove();
  const m2 = cs.match(/^rgba?\(([^)]+)\)$/);
  if (m2) {
    const [r, g, b] = m2[1].split(',').map(p => Math.max(0, Math.min(255, Number(p) || 0)));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  return '#ffffff';
}

/** Extract alpha (0..1) from a colour string. Defaults to 1 for opaque. */
function _alphaOf(input) {
  if (!input) return 1;
  const s = String(input).trim().toLowerCase();
  const m = s.match(/^rgba\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',').map(p => Number(p));
    return parts.length === 4 && Number.isFinite(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1;
  }
  return 1;   // hex / rgb() / named — fully opaque
}

/** Build an `rgba(r,g,b,a)` string from a #rrggbb hex + 0..1 alpha. */
function _composeRgba(hex, alpha) {
  const h = _toHex6(hex);
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * Mount the shape toolbar inside `host`. `getValues()` returns
 * { fill, stroke, strokeWidth, opacity, cornerRadius } for the current
 * selection. `applyFn(patch)` is called with a partial-attrs object
 * whenever the user nudges a control.
 *
 * Idempotent — calling twice replaces the previous instance.
 */
export function mountShapeToolbar(host, getValues, applyFn) {
  if (!host) return;
  unmountShapeToolbar();
  _applyFn = applyFn;
  // Slot starts display:none — unhide it so the toolbar is actually
  // visible. unmount restores display:none so other consumers don't see
  // a stray empty bar.
  host.style.display = 'flex';
  host.dataset.sbsShapeToolbar = '1';

  _bar = document.createElement('div');
  _bar.id = 'sbs-shape-toolbar';
  _bar.style.cssText = [
    'display:flex', 'gap:8px', 'align-items:center', 'flex-wrap:nowrap',
    'font-size:12px', 'user-select:none',
  ].join(';');
  _bar.innerHTML = `
    <label style="display:flex;align-items:center;gap:4px" title="Fill colour">
      Fill <input id="shp-fill" type="color" style="width:28px;height:24px;padding:0;border:1px solid var(--line);background:transparent" />
      <input id="shp-fill-on" type="checkbox" title="Enable fill" checked />
    </label>
    <label style="display:flex;align-items:center;gap:4px" title="Fill alpha (0 = transparent, 1 = opaque) — only the fill, stroke stays solid">
      α <input id="shp-fill-alpha" type="range" min="0" max="1" step="0.01" style="width:60px" />
    </label>
    <label style="display:flex;align-items:center;gap:4px" title="Stroke colour">
      Line <input id="shp-stroke" type="color" style="width:28px;height:24px;padding:0;border:1px solid var(--line);background:transparent" />
      <input id="shp-stroke-on" type="checkbox" title="Enable stroke" checked />
    </label>
    <label style="display:flex;align-items:center;gap:4px" title="Line thickness in pixels">
      Thick <input id="shp-stroke-w" type="number" min="0" max="200" step="1"
             style="width:46px;height:22px;padding:0 4px;font-size:12px" />
    </label>
    <label id="shp-radius-row" style="display:none;align-items:center;gap:4px" title="Corner radius">
      Corner <input id="shp-radius" type="number" min="0" max="500" step="1"
             style="width:46px;height:22px;padding:0 4px;font-size:12px" />
    </label>
  `;
  host.appendChild(_bar);

  const v = (typeof getValues === 'function' ? getValues() : null) || {};
  const fillHex   = _toHex6(v.fill);
  const strokeHex = _toHex6(v.stroke);
  const fillAlpha = _alphaOf(v.fill);
  _bar.querySelector('#shp-fill').value        = fillHex;
  _bar.querySelector('#shp-stroke').value      = strokeHex;
  _bar.querySelector('#shp-fill-on').checked   = v.fill   != null && v.fill   !== 'transparent';
  _bar.querySelector('#shp-stroke-on').checked = v.stroke != null && v.stroke !== 'transparent';
  _bar.querySelector('#shp-stroke-w').value    = String(v.strokeWidth ?? 3);
  _bar.querySelector('#shp-fill-alpha').value  = String(fillAlpha);
  if (Number.isFinite(v.cornerRadius)) {
    _bar.querySelector('#shp-radius-row').style.display = 'flex';
    _bar.querySelector('#shp-radius').value = String(v.cornerRadius);
  }

  const apply = (patch) => { if (_applyFn) _applyFn(patch); };
  // Helper — push the current fill colour + slider alpha as one rgba.
  // Always reads the live values from the DOM so each tweak composes on
  // top of the latest state (rather than the moment-of-mount snapshot).
  const composeFill = () => _composeRgba(
    _bar.querySelector('#shp-fill').value,
    _bar.querySelector('#shp-fill-alpha').value,
  );

  _bar.querySelector('#shp-fill').addEventListener('input', () => {
    if (_bar.querySelector('#shp-fill-on').checked) apply({ fill: composeFill() });
  });
  _bar.querySelector('#shp-fill-on').addEventListener('change', e => {
    apply({ fill: e.target.checked ? composeFill() : null });
  });
  _bar.querySelector('#shp-fill-alpha').addEventListener('input', () => {
    if (_bar.querySelector('#shp-fill-on').checked) apply({ fill: composeFill() });
  });
  _bar.querySelector('#shp-stroke').addEventListener('input', e => {
    if (_bar.querySelector('#shp-stroke-on').checked) apply({ stroke: e.target.value });
  });
  _bar.querySelector('#shp-stroke-on').addEventListener('change', e => {
    apply({ stroke: e.target.checked ? _bar.querySelector('#shp-stroke').value : null });
  });
  _bar.querySelector('#shp-stroke-w').addEventListener('input', e => {
    apply({ strokeWidth: Math.max(0, Number(e.target.value) || 0) });
  });
  _bar.querySelector('#shp-radius').addEventListener('input', e => {
    apply({ cornerRadius: Math.max(0, Number(e.target.value) || 0) });
  });
}

export function unmountShapeToolbar() {
  if (_bar) {
    const host = _bar.parentElement;
    _bar.remove();
    _bar = null;
    _applyFn = null;
    if (host && host.dataset.sbsShapeToolbar) {
      host.style.display = 'none';
      delete host.dataset.sbsShapeToolbar;
    }
  }
}

export function isShapeToolbarMounted() { return !!_bar; }
