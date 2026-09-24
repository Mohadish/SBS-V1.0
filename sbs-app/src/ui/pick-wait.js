/**
 * SBS — the "hold on, photographing the screens" wait (V0.3.4.117).
 * ─────────────────────────────────────────────────────────────────
 * A screen colour pick starts with a snapshot of every display, and that
 * takes a moment (≈0.6 s on two displays after .117; ≈2 s before). With no
 * sign of it the user clicks again, somewhere else, and then has to redo the
 * pick. So, for the wait:
 *   • the OS busy pointer (arrow + the spinning ring) over the whole window,
 *   • a transparent veil that swallows clicks inside SBS (a click meant for
 *     the picker must not land on a button underneath),
 *   • a status line saying what is going on,
 *   • and, in the colour dialog, the eyedropper button itself spins.
 * Nothing opaque anywhere: the SBS window is PART of the snapshot the picker
 * shows (V0.3.4.112), so a big veil or a card would end up in the picture.
 */

import { setStickyStatus, clearStickyStatus } from './status.js';

const STATUS = 'Photographing every screen for the eyedropper — the picker opens in a moment (hold on, don\'t click yet)';

let _veil = null;
let _n = 0;

/** Start the wait; returns the function that ends it (idempotent). */
export function beginScreenPickWait() {
  _n++;
  if (!_veil) {
    const v = document.createElement('div');
    v.dataset.sbsPickWait = '1';
    v.style.cssText = 'position:fixed;inset:0;z-index:10090;background:transparent;cursor:progress;';
    const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel']) v.addEventListener(t, swallow);
    document.body.appendChild(v);
    _veil = v;
    document.documentElement.style.cursor = 'progress';
    setStickyStatus(STATUS, 'info', 'pickwait');
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (--_n > 0) return;
    _n = 0;
    _veil?.remove(); _veil = null;
    document.documentElement.style.cursor = '';
    clearStickyStatus('pickwait');
  };
}

/** A spinning ring, inline, for a button that is waiting (the keyframes are injected once). */
export function spinnerHtml(size = 22) {
  if (!document.getElementById('sbs-spin-css')) {
    const st = document.createElement('style');
    st.id = 'sbs-spin-css';
    st.textContent = '@keyframes sbs-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
  }
  return `<span aria-label="Working…" style="display:inline-block;width:${size}px;height:${size}px;box-sizing:border-box;border:3px solid rgba(229,231,235,.22);border-top-color:#22d3ee;border-radius:50%;animation:sbs-spin .8s linear infinite;"></span>`;
}
