/**
 * SBS — colour swatches (V0.3.4.113).
 * ─────────────────────────────────
 * A click on any `<input type="color">` opens SBS's own colour dialog
 * (ui/color-dialog.js): the colour square, the hue strip, HEX / RGB / HSL —
 * and an eyedropper that picks from ANYWHERE on screen (every display, the
 * app's own window included). Chromium's popup cannot offer that: under
 * Electron its eyedropper sees only this window, and it is not ours to hook —
 * so the dialog is ours (the user's call, 2026-09-23: "left-click the swatch,
 * the interface opens, click the eyedropper, the Alt+click effect happens").
 *
 * A right-click (or Alt+click) on a swatch goes straight to the screen pick.
 * `data-native-color` on an input keeps the native popup for it.
 */

import { openColorDialog, closeColorDialog, isColorDialogOpen } from './color-dialog.js';

const HINT = 'Right-click (or Alt+click): pick a colour from anywhere on screen — both screens';

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

async function _pickInto(input) {
  if (_busy) return;
  if (!window.sbsNative?.pickScreenColor) {
    // the renderer is newer than the running main process (Ctrl+R, no restart)
    const { setStatus } = await import('./status.js');
    setStatus('Picking a colour from the screen needs a full restart of SBS (the new version\'s bridge is not loaded yet) — close and open the app.', 'warn', 9000);
    return;
  }
  _busy = true;
  try {
    const hex = await window.sbsNative.pickScreenColor();
    if (hex) _commit(input, hex);
  } catch (err) { console.warn('[pick] screen colour pick failed:', err?.message || err); }
  finally { _busy = false; }
}

export function initColorPick() {
  // Left click → SBS's colour dialog (the native popup stays shut).
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'color' || t.disabled) return;
    if (t.hasAttribute('data-native-color')) return;
    e.preventDefault();
    if (e.altKey) { e.stopPropagation(); _pickInto(t); return; }
    if (isColorDialogOpen()) { closeColorDialog(true); return; }
    openColorDialog(t);
  }, true);
  // Right-click on a swatch (or the label around it) → straight to the screen picker.
  document.addEventListener('contextmenu', (e) => {
    const input = _swatchOf(e.target);
    if (!input || input.disabled) return;
    e.preventDefault(); e.stopPropagation();
    closeColorDialog(true);
    _pickInto(input);
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
