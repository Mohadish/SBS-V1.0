/**
 * SBS — the colour dialog (V0.3.4.110).
 * ────────────────────────────────────
 * The picker every colour swatch opens: the same layout as Chromium's own
 * popup — a saturation / brightness square, a hue strip, the preview, a
 * HEX / RGB / HSL switch with its fields — plus one difference: the
 * eyedropper (the pipette icon, ui/icons.js) picks from ANYWHERE on screen (every display, the app's own
 * windows made transparent for the snapshot — main's color:pickScreen).
 * Chromium's own eyedropper cannot: under Electron it sees only this window.
 *
 * Changes are live (`input` on every move) and final on close (`change`), so
 * every swatch listener in the app works exactly as with the native popup.
 */

import { eyedropperSvg } from './icons.js';   // V0.3.4.115 — the pipette (was the 💧 emoji)
import { beginScreenPickWait, spinnerHtml } from './pick-wait.js';   // V0.3.4.117 — the button spins + busy pointer while the screens are photographed

let _dlg = null;   // { el, input, close }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hexOf = (v) => {
  const s = String(v || '').trim();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(s); if (m6) return '#' + m6[1].toLowerCase();
  const m3 = /^#?([0-9a-f]{3})$/i.exec(s); if (m3) return '#' + m3[1].split('').map(c => c + c).join('').toLowerCase();
  return null;
};
const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return [h, max ? d / max : 0, max];
}
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h; if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function _fire(input, hex, final) {
  if (!input || input.isConnected === false) return;
  if (input.value !== hex) { input.value = hex; input.dispatchEvent(new Event('input', { bubbles: true })); }
  if (final) input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function closeColorDialog(commit = true) {
  if (!_dlg) return;
  const d = _dlg; _dlg = null;
  d.close(commit);
}

export function isColorDialogOpen() { return !!_dlg; }

/** Open the dialog for a colour input, anchored under it. */
export function openColorDialog(input) {
  closeColorDialog(true);
  const start = hexOf(input.value) || '#000000';
  let [h, s, v] = rgbToHsv(...hexToRgb(start));
  let cur = start, mode = 'hex';

  const el = document.createElement('div');
  el.dataset.sbsTextToolbar = '1';    // the in-place text editor's click-outside guard leaves it alone
  el.dataset.sbsColorDialog = '1';
  el.setAttribute('role', 'dialog');
  // V0.3.4.113 — roomier than .110 (the hex was unreadable): a wider panel, a
  // taller square, 15 px monospace fields, the hex field across the width.
  el.style.cssText = 'position:fixed;z-index:10060;width:332px;background:#1f2937;color:#e5e7eb;border:1px solid #475569;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.6);padding:12px;font:13px system-ui,sans-serif;user-select:none;';
  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:stretch;">
      <canvas data-sv width="236" height="170" style="width:236px;height:170px;border-radius:6px;cursor:crosshair;flex:none;"></canvas>
      <div style="display:flex;flex-direction:column;gap:8px;flex:1;">
        <button type="button" data-drop title="Eyedropper — pick a colour from anywhere on screen: every display, other windows included (the same as Alt+click on the swatch). Esc cancels." style="height:44px;background:#0f172a;color:#e5e7eb;border:1px solid #475569;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;">${eyedropperSvg(30)}</button>
        <div data-preview style="flex:1;border-radius:6px;border:1px solid #475569;background:${start};"></div>
      </div>
    </div>
    <canvas data-hue width="308" height="16" style="width:308px;height:16px;border-radius:8px;margin-top:10px;cursor:ew-resize;display:block;"></canvas>
    <div style="display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px;align-items:end;margin-top:10px;">
      <select data-mode title="How the colour is written" style="width:100%;background:#0f172a;color:#e5e7eb;border:1px solid #475569;border-radius:6px;height:32px;padding:0 6px;font-size:13px;box-sizing:border-box;">
        <option value="hex">HEX</option><option value="rgb">RGB</option><option value="hsl">HSL</option>
      </select>
      <div data-fields style="display:grid;grid-template-columns:1fr;gap:6px;min-width:0;"></div>
    </div>`;
  const sv = el.querySelector('[data-sv]'), hue = el.querySelector('[data-hue]'), preview = el.querySelector('[data-preview]');
  const modeSel = el.querySelector('[data-mode]'), fields = el.querySelector('[data-fields]'), drop = el.querySelector('[data-drop]');
  for (const b of [drop, modeSel]) b.addEventListener('mousedown', e => e.stopPropagation());

  // V0.3.4.114 — the fields sit in a GRID (one column for hex, three for RGB /
  // HSL), so every field gets its real share of the width: the .113 flex
  // layout left the hex field a sliver.
  const field = (label, value, max, onChange, wide = false) => {
    const w = document.createElement('label');
    w.style.cssText = 'display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;min-width:0;';
    const i = document.createElement('input');
    i.type = 'text'; i.value = value; i.spellcheck = false; i.inputMode = max ? 'numeric' : 'text';
    i.style.cssText = `background:#0f172a;color:#e5e7eb;border:1px solid #475569;border-radius:6px;height:32px;padding:0 8px;font:${wide ? 16 : 15}px Consolas,monospace;letter-spacing:.5px;box-sizing:border-box;width:100%;min-width:0;display:block;`;
    i.addEventListener('mousedown', e => e.stopPropagation());
    i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); onChange(i.value, true); } if (e.key === 'Escape') { e.preventDefault(); closeColorDialog(true); } });
    i.addEventListener('input', () => onChange(i.value, false));
    w.append(i, document.createTextNode(label));
    return { w, i };
  };
  let inputs = [];
  const renderFields = () => {
    fields.innerHTML = ''; inputs = [];
    fields.style.gridTemplateColumns = mode === 'hex' ? '1fr' : 'repeat(3, minmax(0, 1fr))';
    const [r, g, b] = hexToRgb(cur);
    if (mode === 'hex') {
      const f = field('hex', cur, 0, (val) => { const hx = hexOf(val); if (hx) setHex(hx, false); }, true);
      inputs = [f]; fields.append(f.w);
    } else if (mode === 'rgb') {
      const vals = [r, g, b];
      inputs = ['R', 'G', 'B'].map((l, k) => field(l, String(Math.round(vals[k])), 255, () => {
        const n = inputs.map(x => clamp(Number(x.i.value) || 0, 0, 255)); setHex(rgbToHex(...n), false);
      }));
      inputs.forEach(f => fields.append(f.w));
    } else {
      const [hh, ss, ll] = rgbToHsl(r, g, b);
      const vals = [Math.round(hh), Math.round(ss * 100), Math.round(ll * 100)];
      inputs = ['H', 'S%', 'L%'].map((l, k) => field(l, String(vals[k]), k ? 100 : 360, () => {
        const n = inputs.map(x => Number(x.i.value) || 0); setHex(rgbToHex(...hslToRgb(clamp(n[0], 0, 360) % 360, clamp(n[1], 0, 100) / 100, clamp(n[2], 0, 100) / 100)), false);
      }));
      inputs.forEach(f => fields.append(f.w));
    }
  };
  const syncFields = () => {
    if (document.activeElement && fields.contains(document.activeElement)) return;   // never overwrite what is being typed
    const [r, g, b] = hexToRgb(cur);
    if (mode === 'hex') inputs[0].i.value = cur;
    else if (mode === 'rgb') [r, g, b].forEach((x, k) => { inputs[k].i.value = String(Math.round(x)); });
    else { const [hh, ss, ll] = rgbToHsl(r, g, b); [Math.round(hh), Math.round(ss * 100), Math.round(ll * 100)].forEach((x, k) => { inputs[k].i.value = String(x); }); }
  };
  const SW = sv.width, SH = sv.height, HW = hue.width, HH = hue.height;
  const drawSv = () => {
    const g = sv.getContext('2d');
    const [hr, hg, hb] = hsvToRgb(h, 1, 1);
    g.fillStyle = `rgb(${hr},${hg},${hb})`; g.fillRect(0, 0, SW, SH);
    const gx = g.createLinearGradient(0, 0, SW, 0); gx.addColorStop(0, 'rgba(255,255,255,1)'); gx.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gx; g.fillRect(0, 0, SW, SH);
    const gy = g.createLinearGradient(0, 0, 0, SH); gy.addColorStop(0, 'rgba(0,0,0,0)'); gy.addColorStop(1, 'rgba(0,0,0,1)'); g.fillStyle = gy; g.fillRect(0, 0, SW, SH);
    const x = s * SW, y = (1 - v) * SH;
    g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.strokeStyle = v > 0.5 && s < 0.5 ? '#000' : '#fff'; g.lineWidth = 2; g.stroke();
  };
  const drawHue = () => {
    const g = hue.getContext('2d');
    const gr = g.createLinearGradient(0, 0, HW, 0);
    for (let i = 0; i <= 6; i++) { const [r, gg, b] = hsvToRgb(i * 60 % 360, 1, 1); gr.addColorStop(i / 6, `rgb(${r},${gg},${b})`); }
    g.fillStyle = gr; g.fillRect(0, 0, HW, HH);
    const x = (h / 360) * HW;
    g.beginPath(); g.rect(x - 3, 1, 6, HH - 2); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke();
  };
  const apply = (final) => { cur = rgbToHex(...hsvToRgb(h, s, v)); preview.style.background = cur; drawSv(); drawHue(); syncFields(); _fire(input, cur, final); };
  const setHex = (hx, final) => { [h, s, v] = rgbToHsv(...hexToRgb(hx)); apply(final); };

  // drags on the square and the strip
  const dragOn = (cv, fn) => {
    const move = (e) => { const r = cv.getBoundingClientRect(); fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)); apply(false); };
    cv.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); cv.setPointerCapture(e.pointerId); move(e); const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); apply(false); }; cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); });
  };
  dragOn(sv, (x, y) => { s = x; v = 1 - y; });
  dragOn(hue, (x) => { h = x * 360; });
  modeSel.addEventListener('change', () => { mode = modeSel.value; renderFields(); });
  drop.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!window.sbsNative?.pickScreenColor) { const { setStatus } = await import('./status.js'); setStatus('Picking from the screen needs a full restart of SBS (the new version\'s bridge is not loaded yet).', 'warn', 8000); return; }
    if (drop.disabled) return;   // one pick at a time
    // V0.3.4.117 — the wait is visible: the button spins, the pointer shows the
    // busy ring, clicks inside SBS are held until the picker is up.
    const endWait = beginScreenPickWait();
    const icon = drop.innerHTML;
    drop.disabled = true; drop.innerHTML = spinnerHtml(22);
    let hx = null;
    try { hx = await window.sbsNative.pickScreenColor(); } catch (err) { console.warn('[pick] screen colour pick failed:', err?.message || err); }
    finally { endWait(); drop.innerHTML = icon; drop.disabled = false; }
    if (hx && _dlg?.el === el) setHex(hx, false);
  });
  renderFields();
  drawSv(); drawHue();
  // V0.3.4.117 — the picker windows warm up while the user looks at the dialog:
  // a click on the eyedropper then waits for the capture only (~0.5 s)
  try { window.sbsNative?.prepareScreenPick?.(); } catch {}

  // place it under the swatch (its label when wrapped), inside an open modal if there is one
  const anchor = input.closest('label') || input;
  const r = anchor.getBoundingClientRect();
  const host = input.closest('dialog[open]') || document.body;
  host.appendChild(el);
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let left = Math.round(r.left), top = Math.round(r.bottom + 6);
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, Math.round(r.top - 6 - hgt));
  el.style.left = `${left}px`; el.style.top = `${top}px`;

  const onDown = (e) => { if (!el.contains(e.target) && !(anchor.contains(e.target))) closeColorDialog(true); };
  const onKey  = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeColorDialog(true); } };
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  _dlg = { el, input, close: (commit) => {
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    if (commit) _fire(input, cur, true);
  } };
}
