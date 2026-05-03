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

export function initContextMenu() {
  _el = document.getElementById('context-menu');
  if (!_el) return;

  // Close on any click outside
  document.addEventListener('click',   () => hideContextMenu(), true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });
}

/**
 * @param {Array<{label:string, action?:()=>void, disabled?:boolean, separator?:boolean}>} items
 * @param {number} x  clientX
 * @param {number} y  clientY
 */
export function showContextMenu(items, x, y) {
  if (!_el) return;

  _el.innerHTML = '';

  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement('div');
      hr.className = 'context-menu__separator';
      _el.appendChild(hr);
      continue;
    }

    const btn = document.createElement('button');
    btn.className   = 'context-menu__item';
    btn.textContent = item.label;
    btn.disabled    = !!item.disabled;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      hideContextMenu();
      item.action?.();
    });
    _el.appendChild(btn);
  }

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
