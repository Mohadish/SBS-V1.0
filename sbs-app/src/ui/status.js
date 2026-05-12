/**
 * SBS Step Browser — Status Bar
 * ================================
 * Manages the #status-bar element.
 * Shows transient messages that auto-clear after a timeout, plus a
 * "sticky" channel used by live interactions (gizmo drag readout,
 * numeric-input mode) that overrides transient messages until cleared.
 */

let _el        = null;
let _clearTimer = null;
let _sticky    = '';   // current sticky text (gizmo readout / numeric input)

export function initStatus() {
  _el = document.getElementById('status-bar');
}

/**
 * Show a status message.
 * @param {string}  text
 * @param {'info'|'ok'|'warn'|'danger'} [level='info']
 * @param {number}  [autoClearMs=4000]  0 = don't auto-clear
 */
export function setStatus(text, level = 'info', autoClearMs = 4000) {
  if (!_el) return;

  clearTimeout(_clearTimer);

  // Sticky text wins — buffer the transient message so it shows up
  // once the sticky channel clears. Simpler model: just suppress
  // transient when sticky is active.
  if (_sticky) return;

  _el.textContent = text;
  _el.className   = `status-bar status-bar--${level}`;

  if (autoClearMs > 0) {
    _clearTimer = setTimeout(() => {
      if (_el && !_sticky) _el.textContent = '';
    }, autoClearMs);
  }
}

export function clearStatus() {
  clearTimeout(_clearTimer);
  if (_el && !_sticky) _el.textContent = '';
}

/**
 * Set sticky text (no auto-clear, overrides transient setStatus).
 * Use for live gizmo readout and numeric input mode.
 */
export function setStickyStatus(text, level = 'info') {
  if (!_el) return;
  _sticky = text;
  clearTimeout(_clearTimer);
  _el.textContent = text;
  _el.className   = `status-bar status-bar--${level}`;
}

/**
 * Clear sticky text and restore the bar to empty.
 */
export function clearStickyStatus() {
  _sticky = '';
  if (_el) _el.textContent = '';
}
