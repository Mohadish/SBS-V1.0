/**
 * SBS — the colour picker, everywhere (V0.3.4.100).
 * ─────────────────────────────────────────────
 * Every `<input type="color">` in the app opens THIS popover instead of the
 * operating system's colour dialog: the current colour and its hex, a
 * 💉 PICK FROM SCREEN button (the EyeDropper API — samples ANY pixel on ANY
 * screen, a browser window beside the app included: the user's request), the
 * last colours picked, and "More colours…" for the classic dialog. Nothing
 * else changes: the popover writes the input's value and fires `input` +
 * `change`, so every existing listener (46 inputs across 14 files) works as
 * before. One capture listener on the document does it — no per-input wiring.
 *
 * Opt out of the popover on one input with `data-native-color`.
 */

const RECENT_KEY = 'sbs.recentColors';
const RECENT_MAX = 12;
let _pop = null;   // { el, input }

const _hex = (v) => {
  const s = String(v || '').trim();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m6) return '#' + m6[1].toLowerCase();
  const m3 = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m3) return '#' + m3[1].split('').map(c => c + c).join('').toLowerCase();
  return null;
};

function _recent() {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(_hex).slice(0, RECENT_MAX) : []; }
  catch { return []; }
}
function _remember(hex) {
  try {
    const list = [hex, ..._recent().filter(h => h !== hex)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage may be unavailable — the picker still works */ }
}

/** Write a colour into the input the way a user's pick would: value + input + change. */
function _commit(input, hex, { final = true } = {}) {
  if (!input || input.isConnected === false) return;
  input.value = hex;
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  if (final) {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    _remember(hex);
  }
}

export function closeColorPopover() {
  if (!_pop) return;
  const { el } = _pop;
  _pop = null;
  el.remove();
}

function _open(input) {
  closeColorPopover();
  const start = _hex(input.value) || '#000000';
  const el = document.createElement('div');
  el.dataset.sbsTextToolbar = '1';     // the in-place text editor's click-outside guard leaves this alone
  el.dataset.sbsColorPop = '1';
  el.setAttribute('role', 'dialog');
  el.style.cssText = 'position:fixed;z-index:10060;background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.55);padding:10px;width:232px;font-size:13px;font-family:inherit;';
  const btn = (label, title) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = title || '';
    b.style.cssText = 'background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:6px;height:28px;padding:0 8px;cursor:pointer;font-size:13px;flex:1;';
    b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    return b;
  };
  // row 1: swatch + hex
  const row1 = document.createElement('div');
  row1.style.cssText = 'display:flex;gap:8px;align-items:center;';
  const sw = document.createElement('div');
  sw.style.cssText = `width:28px;height:28px;border-radius:6px;border:1px solid #475569;background:${start};flex:none;`;
  const hexIn = document.createElement('input');
  hexIn.type = 'text'; hexIn.value = start; hexIn.spellcheck = false; hexIn.maxLength = 7;
  hexIn.title = 'Hex colour — type and press Enter';
  hexIn.style.cssText = 'flex:1;background:#0b1220;color:#e5e7eb;border:1px solid #334155;border-radius:6px;height:28px;padding:0 8px;font-family:Consolas,monospace;font-size:13px;box-sizing:border-box;';
  hexIn.addEventListener('mousedown', e => e.stopPropagation());
  hexIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); const h = _hex(hexIn.value); if (h) { sw.style.background = h; _commit(input, h); closeColorPopover(); } else hexIn.style.borderColor = '#f87171'; }
    if (e.key === 'Escape') { e.preventDefault(); closeColorPopover(); }
  });
  hexIn.addEventListener('input', () => { const h = _hex(hexIn.value); hexIn.style.borderColor = h ? '#334155' : '#f87171'; if (h) { sw.style.background = h; _commit(input, h, { final: false }); } });
  row1.append(sw, hexIn);
  // row 2: pick from screen / more colours
  const row2 = document.createElement('div');
  row2.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
  const pick = btn('💉 Pick from screen', 'Pick a colour from anywhere on any screen — another window included. Esc cancels.');
  const canDrop = typeof window.EyeDropper === 'function';
  if (!canDrop) { pick.disabled = true; pick.title = 'Screen picking needs the EyeDropper API (Chromium 95+)'; pick.style.opacity = '0.5'; }
  pick.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!canDrop) return;
    try {
      const r = await new window.EyeDropper().open();
      const h = _hex(r?.sRGBHex);
      if (h) { hexIn.value = h; sw.style.background = h; _commit(input, h); }
      closeColorPopover();
    } catch { /* Esc — nothing picked */ }
  });
  const more = btn('🎨 More…', 'The classic colour dialog');
  more.style.flex = '0 0 auto';
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    closeColorPopover();
    try { input.showPicker(); } catch { try { input.click(); } catch { /* nothing more to try */ } }
  });
  row2.append(pick, more);
  el.append(row1, row2);
  // row 3: recent colours
  const rec = _recent().filter(h => h !== start);
  if (rec.length) {
    const row3 = document.createElement('div');
    row3.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;';
    for (const h of rec) {
      const d = document.createElement('div');
      d.title = h;
      d.style.cssText = `width:20px;height:20px;border-radius:5px;border:1px solid #475569;background:${h};cursor:pointer;`;
      d.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
      d.addEventListener('click', (e) => { e.stopPropagation(); hexIn.value = h; sw.style.background = h; _commit(input, h); closeColorPopover(); });
      row3.appendChild(d);
    }
    el.appendChild(row3);
  }
  // place it: under the input (or the label wrapping it), inside an open modal dialog if there is one
  const anchor = input.closest('label') || input;
  const r = anchor.getBoundingClientRect();
  const host = input.closest('dialog[open]') || document.body;
  host.appendChild(el);
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let left = Math.round(r.left), top = Math.round(r.bottom + 6);
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, Math.round(r.top - 6 - hgt));
  el.style.left = `${left}px`; el.style.top = `${top}px`;
  _pop = { el, input };
  hexIn.focus(); hexIn.select();
}

/** Install once at boot. */
export function initColorPick() {
  // Every colour input opens the popover instead of the OS dialog. Capture
  // phase: it runs before the input's default action (the dialog) and before
  // any other click handler; preventDefault() keeps the dialog shut.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'color' || t.disabled) return;
    if (t.hasAttribute('data-native-color')) return;
    e.preventDefault();
    if (_pop?.input === t) { closeColorPopover(); return; }
    _open(t);
  }, true);
  // Outside press closes it (the press itself goes through to whatever was pressed).
  document.addEventListener('mousedown', (e) => {
    if (!_pop || _pop.el.contains(e.target)) return;
    const own = _pop.input.closest('label') || _pop.input;
    if (own.contains(e.target)) return;   // the swatch itself: the click that follows toggles it shut
    closeColorPopover();
  }, true);
  window.addEventListener('keydown', (e) => { if (_pop && e.key === 'Escape') { e.stopPropagation(); closeColorPopover(); } }, true);
  window.addEventListener('blur', closeColorPopover);
}
