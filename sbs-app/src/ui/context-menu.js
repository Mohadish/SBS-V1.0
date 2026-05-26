/**
 * SBS Step Browser — Context Menu
 * ==================================
 * Generic context menu that renders into #context-menu.
 *
 * Usage:
 *   showContextMenu([{ label, action, disabled, separator }], x, y)
 *   hideContextMenu()
 */

let _el = null;
// V0.2.11 live-label support: track current modifier state while a menu is
// open so items with `liveLabel(ctx)` can rewrite themselves on Ctrl/Shift/
// Alt up + down. `_liveBtns` holds [{btn, item}] for items that opted in;
// `_liveKeyHandler` is the doc-level handler we attach on show + detach on
// hide so multiple menus over a session don't leak listeners.
let _modState        = { ctrl: false, meta: false, shift: false, alt: false };
let _liveBtns        = [];
let _liveKeyHandler  = null;

function _ctxFromEvent(e) {
  return { ctrl: !!e.ctrlKey, meta: !!e.metaKey, shift: !!e.shiftKey, alt: !!e.altKey };
}
function _refreshLiveLabels() {
  for (const { btn, item } of _liveBtns) {
    try { btn.textContent = item.liveLabel(_modState); } catch (_) {}
  }
}
function _attachLiveModListeners() {
  _detachLiveModListeners();
  _liveKeyHandler = (e) => {
    _modState = _ctxFromEvent(e);
    _refreshLiveLabels();
  };
  document.addEventListener('keydown', _liveKeyHandler, true);
  document.addEventListener('keyup',   _liveKeyHandler, true);
}
function _detachLiveModListeners() {
  if (_liveKeyHandler) {
    document.removeEventListener('keydown', _liveKeyHandler, true);
    document.removeEventListener('keyup',   _liveKeyHandler, true);
    _liveKeyHandler = null;
  }
  // NOTE: do NOT clear _liveBtns here. _attachLiveModListeners() calls this
  // to re-arm cleanly, but at that moment showContextMenu has just
  // populated _liveBtns — wiping it leaves the handler with an empty list
  // and live updates silently no-op. The list is reset in showContextMenu.
}

export function initContextMenu() {
  _el = document.getElementById('context-menu');
  if (!_el) return;

  // Close on any click outside
  document.addEventListener('click',   () => hideContextMenu(), true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });
}

/**
 * @param {Array<{label:string, action?:(ctx?:object)=>void, disabled?:boolean, separator?:boolean,
 *                liveLabel?:(ctx:{ctrl,meta,shift,alt})=>string }>} items
 *        `liveLabel(ctx)` (optional): returns the row's current label based
 *        on the live modifier state — updated on every keydown/keyup while
 *        the menu is open. `action(ctx)` receives the modifier state at
 *        click time so add/replace branches can be chosen on click.
 * @param {number} x  clientX
 * @param {number} y  clientY
 * @param {object} [opts]
 * @param {{ctrl,meta,shift,alt}|MouseEvent} [opts.initialMods]
 *        Mod state at show time — pass the original r-click MouseEvent so
 *        a menu opened while Ctrl is already held starts in the right state.
 */
export function showContextMenu(items, x, y, opts = {}) {
  if (!_el) return;

  _el.innerHTML = '';
  // Seed mod state from the show event (else neutral).
  _modState = opts.initialMods
    ? _ctxFromEvent(opts.initialMods)
    : { ctrl: false, meta: false, shift: false, alt: false };
  _liveBtns = [];

  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement('div');
      hr.className = 'context-menu__separator';
      _el.appendChild(hr);
      continue;
    }

    const btn = document.createElement('button');
    btn.className   = 'context-menu__item';
    btn.textContent = typeof item.liveLabel === 'function'
      ? item.liveLabel(_modState)
      : item.label;
    btn.disabled    = !!item.disabled;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _modState = _ctxFromEvent(e);
      hideContextMenu();
      item.action?.(_modState);
    });
    _el.appendChild(btn);
    if (typeof item.liveLabel === 'function') _liveBtns.push({ btn, item });
  }

  // Attach live-label listeners only if at least one item opted in.
  if (_liveBtns.length) _attachLiveModListeners();

  // Position — keep inside viewport
  _el.style.display = 'block';
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = _el.getBoundingClientRect();
  const cx   = x + rect.width  > vw ? vw - rect.width  - 4 : x;
  const cy   = y + rect.height > vh ? vh - rect.height - 4 : y;
  _el.style.left = `${Math.max(4, cx)}px`;
  _el.style.top  = `${Math.max(4, cy)}px`;
}

export function hideContextMenu() {
  if (_el) _el.style.display = 'none';
  _detachLiveModListeners();
  _liveBtns = [];
}

/**
 * Yes / No confirm dialog. Calls onYes if the user confirms.
 * Lives next to showContextMenu so any module that uses the context
 * menu also has a guard for destructive ops without a separate import.
 */
export function showConfirmDialog(title, body, onYes) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">${esc(title)}</div>
      <div class="small" style="margin-top:8px;line-height:1.45;">${esc(body)}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="btn" id="_scd-no">No</button>
        <button class="btn primary" id="_scd-yes">Yes</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  dlg.querySelector('#_scd-no').addEventListener('click',  () => { dlg.close(); dlg.remove(); });
  dlg.querySelector('#_scd-yes').addEventListener('click', () => { dlg.close(); dlg.remove(); onYes?.(); });
  dlg.addEventListener('cancel', () => { dlg.remove(); });
  dlg.showModal();
  requestAnimationFrame(() => dlg.querySelector('#_scd-yes').focus());
}
