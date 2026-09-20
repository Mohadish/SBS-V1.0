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
// STICKY IS A STACK, NOT A SLOT (V0.3.4.58). More than one live thing can want
// the bar at once — a gesture hint while an angle is being typed, say — and
// with a single slot whichever finished LAST wiped the other's message, or
// left a stale one up. Each owner holds a key; the most recent one shows, and
// clearing one falls back to the one underneath rather than to nothing.
let _stickies  = [];   // [{ key, text, level }], last = showing

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

  // A live hint wins: it describes what the user is doing RIGHT NOW, and a
  // transient message talking over it would be gone in four seconds anyway.
  if (_stickies.length) return;

  _el.textContent = text;
  _el.className   = `status-bar status-bar--${level}`;

  if (autoClearMs > 0) {
    _clearTimer = setTimeout(() => {
      if (_el && !_stickies.length) _el.textContent = '';
    }, autoClearMs);
  }
}

export function clearStatus() {
  clearTimeout(_clearTimer);
  if (_el && !_stickies.length) _el.textContent = '';
}

/** Paint whatever is on top of the stack (or nothing). */
function _paintSticky() {
  if (!_el) return;
  const top = _stickies[_stickies.length - 1];
  _el.textContent = top ? top.text : '';
  if (top) _el.className = `status-bar status-bar--${top.level}`;
}

/**
 * Put up a LIVE HINT: it does not time out, and it stays for exactly as long
 * as the thing it describes is true. These are the messages that say what the
 * gesture in progress can do — "hold Ctrl to…", "drag a dot to…" — and they
 * earn their place by being there when the user looks down, not four seconds
 * after they started. Call it again with the same key to update the wording as
 * the state changes; call clearStickyStatus(key) when the mode ends.
 *
 * @param {string} text
 * @param {'info'|'ok'|'warn'|'danger'} [level]
 * @param {string} [key]  who owns this hint; same key replaces, not stacks
 */
export function setStickyStatus(text, level = 'info', key = 'default') {
  if (!_el) return;
  clearTimeout(_clearTimer);
  const at = _stickies.findIndex(s => s.key === key);
  if (at >= 0) _stickies.splice(at, 1);
  _stickies.push({ key, text, level });
  _paintSticky();
}

/**
 * Take a hint down. With no key this clears everything, which is what the old
 * single-slot callers meant; with one, only that owner's hint goes and any
 * other live hint comes back up.
 */
export function clearStickyStatus(key) {
  if (key === undefined) _stickies = [];
  else _stickies = _stickies.filter(s => s.key !== key);
  _paintSticky();
}
