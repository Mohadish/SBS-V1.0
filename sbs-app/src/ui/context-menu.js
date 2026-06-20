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
let _flyoutEl = null;   // V0.2.22.129 — submenu flyout (lazily created, reused)
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

  // Close on any click OUTSIDE the menu (or its flyout). Clicks inside are
  // handled by the item buttons themselves (which close explicitly), so a
  // submenu parent can open its flyout on click without dismissing the menu.
  document.addEventListener('click', (e) => {
    if (_el && _el.contains(e.target)) return;
    if (_flyoutEl && _flyoutEl.contains(e.target)) return;
    hideContextMenu();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });
}

// ── Submenu flyout ───────────────────────────────────────────────────────────
function _makeActionButton(item) {
  const btn = document.createElement('button');
  btn.className   = 'context-menu__item';
  btn.textContent = typeof item.liveLabel === 'function' ? item.liveLabel(_modState) : item.label;
  btn.disabled    = !!item.disabled;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    _modState = _ctxFromEvent(e);
    hideContextMenu();
    item.action?.(_modState);
  });
  return btn;
}

function _closeFlyout() {
  if (_flyoutEl) _flyoutEl.style.display = 'none';
}

function _openFlyout(parentBtn, subItems) {
  if (!_flyoutEl) {
    _flyoutEl = document.createElement('div');
    _flyoutEl.className = 'context-menu';   // reuse menu surface styling
    _flyoutEl.style.position = 'fixed';
    _flyoutEl.style.zIndex   = '91';        // above the parent menu (z-90)
    document.body.appendChild(_flyoutEl);
  }
  _flyoutEl.innerHTML = '';
  for (const sub of subItems) {
    if (sub.separator) {
      const hr = document.createElement('div');
      hr.className = 'context-menu__separator';
      _flyoutEl.appendChild(hr);
    } else {
      _flyoutEl.appendChild(_makeActionButton(sub));
    }
  }
  _flyoutEl.style.display = 'block';
  // Position to the right of the parent row; flip left if it would overflow.
  const r  = parentBtn.getBoundingClientRect();
  const fr = _flyoutEl.getBoundingClientRect();
  let fx = r.right - 2;
  if (fx + fr.width > window.innerWidth) fx = r.left - fr.width + 2;
  let fy = r.top - 6;
  if (fy + fr.height > window.innerHeight) fy = window.innerHeight - fr.height - 4;
  _flyoutEl.style.left = `${Math.max(4, fx)}px`;
  _flyoutEl.style.top  = `${Math.max(4, fy)}px`;
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

    // Submenu (flyout): renders with a ▸ indicator; opens a side panel on
    // hover or click. HYBRID rows (V0.3.0.92): if the item ALSO carries an
    // `action`, the ▸ still opens the flyout on hover, but a plain click runs
    // the primary action and closes — so the row is both a button and a
    // submenu opener (used by the Visibility row: click = hide/show this step,
    // hover = the across-steps options).
    if (Array.isArray(item.submenu)) {
      const btn = document.createElement('button');
      btn.className   = 'context-menu__item';
      btn.textContent = `${item.label}  ▸`;
      btn.disabled    = !!item.disabled;
      const open = () => { if (!btn.disabled) _openFlyout(btn, item.submenu); };
      btn.addEventListener('mouseenter', open);
      if (typeof item.action === 'function') {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          _modState = _ctxFromEvent(e);
          hideContextMenu();
          item.action(_modState);
        });
      } else {
        btn.addEventListener('click', e => { e.stopPropagation(); open(); });
      }
      _el.appendChild(btn);
      if (typeof item.liveLabel === 'function') _liveBtns.push({ btn, item });
      continue;
    }

    const btn = _makeActionButton(item);
    btn.addEventListener('mouseenter', _closeFlyout);   // leaving a submenu row closes its flyout
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
  _closeFlyout();
  _detachLiveModListeners();
  _liveBtns = [];
}

// ── Canonical menu order (V0.3.0.96) ──────────────────────────────────────────
// The tree + viewport ENTITY menus push items in code order, which differs per
// node type. canonicalizeMenuOrder() re-sorts a finished item list into ONE
// section order so every object / folder / model reads the same, and regenerates
// the separators between sections. Pure reorder — each item's action / disabled /
// submenu is preserved. Items whose label matches no rule fall into the per-type
// "special" section (group 8) in their original relative order (stable sort).
// Apply ONLY to the entity menu — pass mode-specific menus (shape editor, cable
// routing, note picking) through untouched.
const _MENU_SECTIONS = [
  // [matcher(label), group] — first match wins; groups render in ascending order.
  // Viewport-only globals — tested FIRST so '🎯 Fit view' doesn't match the
  // entity '🎯 Fit' rule below; they sink to the very bottom (group 13).
  [l => l.startsWith('📷') || l.startsWith('🎯 Fit view') || l.startsWith('✖ Deselect'), 13],
  [l => l.startsWith('⚠️'),                                          0],  // missing-asset header
  [l => l.startsWith('💬 Add Note'),                                 1],  // add note
  [l => l.startsWith('🗒 Notes on') || /^\s+[👁🚫]/.test(l),         1],  // notes list (header + rows)
  [l => l.startsWith('👁 Visibility'),                               2],  // "this object" group
  [l => l.startsWith('🔍 Isolate') || l.startsWith('🌐 Un-isolate'), 2],
  [l => l.startsWith('🎯 Fit'),                                      2],
  [l => l.startsWith('✏ Rename'),                                    2],
  [l => l.startsWith('📁→ Move'),                                    2],
  [l => l.includes('Copy Transforms') || l.includes('Paste Transforms')
        || l.startsWith('↺ Reset'),                                  3],  // transforms
  [l => l.startsWith('🎯 Align'),                                    4],  // align
  [l => l.startsWith('⊕ Copy Pivot') || l.startsWith('⊕ Paste Pivot')
        || l.startsWith('🧲 Snap Pivot') || l.startsWith('⊕ Pivot'), 5],  // pivot
  [l => l.includes('Follow object') || l.includes('Stop following'), 6],  // follow
  [l => (l.startsWith('📋 Copy') && !l.includes('Transforms') && !l.includes('tree'))
        || l.startsWith('📄 Paste') || l.startsWith('🔗 Paste Instance')
        || l.startsWith('🪄 Make transformable')
        || l.startsWith('＋ Add to replace'),                        7],  // object clipboard / upgrade
  // group 8 = per-type SPECIAL (default) — hardware / shape-edit / show-color
  [l => l.startsWith('🧹 Clean') || l.startsWith('🔒 Lock') || l.startsWith('🔓 Unlock')
        || l.startsWith('📁＋ New Folder') || l.startsWith('⤵') || l.startsWith('⊟ Collapse'), 9], // tree-only utilities
  [l => l.startsWith('🗑') || l.startsWith('🚫🔄 Remove'),           10], // delete
  [l => l.startsWith('🗃') || l.startsWith('📤 Unarchive'),          11], // archive (bottom)
  [l => l.includes('Copy tree') || l.includes('Paste tree'),         12], // scene tree clipboard
];
const _MENU_DEFAULT_GROUP = 8;

function _menuGroup(label) {
  const l = label || '';
  for (const [test, g] of _MENU_SECTIONS) {
    try { if (test(l)) return g; } catch (_) {}
  }
  return _MENU_DEFAULT_GROUP;
}

// A menu item that's purely a divider — either the tree style ({separator:true})
// or the viewport style ({label:'─', disabled:true}). Both are dropped before
// re-sorting; canonicalizeMenuOrder regenerates dividers between sections (else
// the viewport's literal '─' items pile up in the 'special' group — the "7 dashes").
function _isDivider(it) {
  return !it || it.separator === true || (it.label === '─' && it.disabled === true);
}

export function canonicalizeMenuOrder(items) {
  if (!Array.isArray(items) || items.length < 2) return items;
  const real = items.filter(it => !_isDivider(it));
  const ranked = real.map((it, i) => ({ it, i, g: _menuGroup(it.label || '') }));
  ranked.sort((a, b) => (a.g - b.g) || (a.i - b.i));   // stable within a section
  const out = [];
  let prevG = null;
  for (const r of ranked) {
    if (prevG !== null && r.g !== prevG) out.push({ separator: true });
    out.push(r.it);
    prevG = r.g;
  }
  return out;
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
