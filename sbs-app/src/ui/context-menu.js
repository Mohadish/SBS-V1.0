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
