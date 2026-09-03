/**
 * SBS — Drop shadow + outline popover (V0.3.2.144)
 *
 * Opened from the "Fx" button on the text toolbar. Nine controls is far
 * too many to sit inline on a floating panel that already hovers over the
 * user's text, so they live in a popover anchored under the button.
 *
 * The popover owns no state: it reads the current selection's values
 * through getValues() and pushes every tweak through onChange(patch).
 * Undo batching is the caller's business — the popover reports a session
 * start/end so overlay.js can collapse a whole editing burst into one
 * entry instead of one per slider pixel.
 *
 * z-index 45 keeps it above the floating toolbar (40) and below the modal
 * layer (50), matching the ladder the rest of the overlay UI uses.
 */

import { defaultShadow, defaultOutline } from '../systems/text-effects.js';

let _pop      = null;
let _onClose  = null;
let _outside  = null;

const _esc = (s) => String(s ?? '').replace(/[<>&"']/g, c => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
));

export function closeTextEffectsPopover() {
  if (_outside) { document.removeEventListener('mousedown', _outside, true); _outside = null; }
  if (_pop) { _pop.remove(); _pop = null; }
  const cb = _onClose; _onClose = null;
  if (cb) { try { cb(); } catch { /* caller's undo bookkeeping */ } }
}

export function isTextEffectsPopoverOpen() { return !!_pop; }

/**
 * @param anchorEl  the Fx button — the popover parks under it
 * @param getValues () => ({ shadow, outline }) for the current selection
 * @param onChange  (patch) => void, patch = { shadow?, outline? } (null = off)
 * @param onClose   optional, fired once when the popover closes
 */
export function openTextEffectsPopover(anchorEl, getValues, onChange, onClose) {
  if (_pop) { closeTextEffectsPopover(); return; }   // toggle
  const vals    = (typeof getValues === 'function' ? getValues() : null) || {};
  const shadow  = vals.shadow  || null;
  const outline = vals.outline || null;
  const sh = shadow  || defaultShadow();
  const ol = outline || defaultOutline();
  _onClose = onClose || null;

  _pop = document.createElement('div');
  _pop.dataset.sbsTextToolbar = '1';   // don't dismiss the in-place editor
  _pop.style.cssText = [
    'position:fixed', 'z-index:45',
    'background:rgba(10,15,25,0.97)',
    'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:8px', 'padding:10px 12px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.55)',
    'font-size:12px', 'color:#e5e7eb', 'user-select:none',
    'display:grid', 'gap:6px', 'min-width:250px',
  ].join(';');

  const row = (label, control) =>
    `<label style="display:grid;grid-template-columns:64px 1fr auto;gap:8px;align-items:center;">
       <span style="opacity:0.75;">${_esc(label)}</span>${control}
     </label>`;
  const slider = (id, min, max, step, val) =>
    `<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}" style="width:100%" />
     <span id="${id}-v" style="opacity:0.6;min-width:30px;text-align:right;">${val}</span>`;
  const colour = (id, val) =>
    `<input id="${id}" type="color" value="${_esc(val)}"
       style="width:32px;height:22px;padding:0;border:1px solid #334155;background:transparent" /><span></span>`;
  const head = (id, label, on) =>
    `<div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
       <input id="${id}" type="checkbox" ${on ? 'checked' : ''} />
       <b style="font-size:12px;">${_esc(label)}</b>
     </div>`;

  _pop.innerHTML = `
    ${head('fx-sh-on', 'Drop shadow', !!shadow)}
    <div id="fx-sh-body" style="display:grid;gap:5px;${shadow ? '' : 'opacity:0.4;pointer-events:none;'}">
      ${row('Colour',   colour('fx-sh-color', sh.color))}
      ${row('Distance', slider('fx-sh-dist',  0, 40,  1, sh.distance))}
      ${row('Angle',    slider('fx-sh-angle', 0, 360, 1, sh.angle))}
      ${row('Blur',     slider('fx-sh-blur',  0, 40,  1, sh.blur))}
      ${row('Expand',   slider('fx-sh-spread',0, 20,  1, sh.spread))}
      ${row('Opacity',  slider('fx-sh-op',    0, 100, 1, Math.round(sh.opacity * 100)))}
    </div>
    <div style="height:1px;background:rgba(255,255,255,0.1);margin:4px 0;"></div>
    ${head('fx-ol-on', 'Outline', !!outline)}
    <div id="fx-ol-body" style="display:grid;gap:5px;${outline ? '' : 'opacity:0.4;pointer-events:none;'}">
      ${row('Colour',    colour('fx-ol-color', ol.color))}
      ${row('Thickness', slider('fx-ol-w',  0, 20,  1, ol.thickness))}
      ${row('Opacity',   slider('fx-ol-op', 0, 100, 1, Math.round(ol.opacity * 100)))}
    </div>
  `;
  document.body.appendChild(_pop);

  // Park under the button, clamped into the window.
  const r  = anchorEl?.getBoundingClientRect?.() || { left: 20, bottom: 20, width: 0 };
  const pw = _pop.offsetWidth, ph = _pop.offsetHeight;
  let left = r.left + r.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  let top = r.bottom + 6;
  if (top + ph + 8 > window.innerHeight) top = Math.max(8, r.top - ph - 6);
  _pop.style.left = `${Math.round(left)}px`;
  _pop.style.top  = `${Math.round(top)}px`;

  const q = (id) => _pop.querySelector('#' + id);

  const readShadow = () => ({
    color:    q('fx-sh-color').value,
    distance: Number(q('fx-sh-dist').value),
    angle:    Number(q('fx-sh-angle').value),
    blur:     Number(q('fx-sh-blur').value),
    spread:   Number(q('fx-sh-spread').value),
    opacity:  Number(q('fx-sh-op').value) / 100,
  });
  const readOutline = () => ({
    color:     q('fx-ol-color').value,
    thickness: Number(q('fx-ol-w').value),
    opacity:   Number(q('fx-ol-op').value) / 100,
  });

  const push = () => onChange?.({
    shadow:  q('fx-sh-on').checked ? readShadow()  : null,
    outline: q('fx-ol-on').checked ? readOutline() : null,
  });

  // Live readouts beside each slider.
  for (const id of ['fx-sh-dist', 'fx-sh-angle', 'fx-sh-blur', 'fx-sh-spread', 'fx-sh-op', 'fx-ol-w', 'fx-ol-op']) {
    const el = q(id);
    el.addEventListener('input', () => { q(id + '-v').textContent = el.value; push(); });
  }
  for (const id of ['fx-sh-color', 'fx-ol-color']) q(id).addEventListener('input', push);

  const toggle = (cbId, bodyId) => {
    q(cbId).addEventListener('change', () => {
      const on = q(cbId).checked;
      q(bodyId).style.opacity       = on ? '' : '0.4';
      q(bodyId).style.pointerEvents = on ? '' : 'none';
      push();
    });
  };
  toggle('fx-sh-on', 'fx-sh-body');
  toggle('fx-ol-on', 'fx-ol-body');

  // Click-away closes. Capture phase, and the anchor button is excluded so
  // its own click toggles rather than close-then-reopen.
  _outside = (e) => {
    if (_pop?.contains(e.target) || anchorEl?.contains?.(e.target)) return;
    closeTextEffectsPopover();
  };
  document.addEventListener('mousedown', _outside, true);
}
