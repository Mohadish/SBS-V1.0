/**
 * SBS — pick a colour from anywhere on screen (V0.3.4.108).
 * ─────────────────────────────────────────────────────
 * A left click on any colour swatch opens the ordinary colour dialog, exactly
 * as before (the .100 popover was not wanted). A RIGHT click on a swatch asks
 * the main process for a screen pick: it snapshots the display the pointer is
 * on and opens that snapshot edge to edge; click a pixel of it — a browser, a
 * picture viewer, anything on screen — and the colour lands in the swatch,
 * with the same `input` + `change` events a pick in the dialog fires.
 *
 * Why not the dialog's own eyedropper: under Electron, Chromium's eyedropper
 * (the popup's and the EyeDropper API's) sees only this app's window.
 */

const HINT = 'Right-click: pick a colour from anywhere on screen';

function _commit(input, hex) {
  if (!input || input.isConnected === false) return;
  input.value = hex;
  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function _swatchOf(target) {
  if (!(target instanceof Element)) return null;
  if (target instanceof HTMLInputElement && target.type === 'color') return target;
  const lab = target.closest('label');
  const inp = lab?.querySelector('input[type="color"]');
  return inp || null;
}

let _busy = false;

export function initColorPick() {
  // Right-click on a swatch (or the label around it) → the screen picker.
  document.addEventListener('contextmenu', async (e) => {
    const input = _swatchOf(e.target);
    if (!input || input.disabled || !window.sbsNative?.pickScreenColor) return;
    e.preventDefault(); e.stopPropagation();
    if (_busy) return;
    _busy = true;
    try {
      const hex = await window.sbsNative.pickScreenColor();
      if (hex) _commit(input, hex);
    } catch (err) { console.warn('[pick] screen colour pick failed:', err?.message || err); }
    finally { _busy = false; }
  }, true);
  // Say so on hover: the hint joins the swatch's own tooltip.
  document.addEventListener('mouseover', (e) => {
    const input = _swatchOf(e.target);
    if (!input) return;
    const host = input.closest('label') || input;
    if (host.title?.includes(HINT)) return;
    host.title = host.title ? `${host.title} · ${HINT}` : HINT;
  }, true);
}
