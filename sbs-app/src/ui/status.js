/**
 * SBS Step Browser — Status Bar
 * ================================
 * Manages the #status-bar element.
 * Shows transient messages that auto-clear after a timeout.
 */

let _el        = null;
let _clearTimer = null;

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

  _el.textContent = text;
  _el.className   = `status-bar status-bar--${level}`;

  if (autoClearMs > 0) {
    _clearTimer = setTimeout(() => {
      if (_el) _el.textContent = '';
    }, autoClearMs);
  }
}

export function clearStatus() {
  clearTimeout(_clearTimer);
  if (_el) _el.textContent = '';
}
