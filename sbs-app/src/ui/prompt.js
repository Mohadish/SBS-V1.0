/**
 * SBS — Prompt dialog (renderer-safe).
 *
 * Electron's renderer blocks `window.prompt()` (security: no native
 * blocking dialogs in renderer). This module provides a Promise-based
 * replacement using <dialog> — same shape as native prompt() but
 * non-blocking and styled to match the app.
 *
 * Returns a string (trimmed) on OK, or null on Cancel / empty.
 */
export function promptString(title, defaultVal = '') {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div class="sbs-dialog__title">${_esc(title)}</div>
        <input type="text" data-sbs-prompt-input value="${_esc(defaultVal)}"
          style="margin-top:10px;width:100%;box-sizing:border-box" />
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button class="btn" data-sbs-prompt-cancel>Cancel</button>
          <button class="btn" data-sbs-prompt-ok>OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const input  = dlg.querySelector('[data-sbs-prompt-input]');
    const done   = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    dlg.querySelector('[data-sbs-prompt-cancel]').addEventListener('click', () => done(null));
    dlg.querySelector('[data-sbs-prompt-ok]')    .addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
    dlg.showModal();
    // Explicit focus — <dialog> sometimes auto-focuses the first button
    // instead of the input, which eats the Enter keystroke.
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

/**
 * Multi-button choice dialog. Returns the clicked button's `id`, or
 * null if the user dismissed via Esc / clicking the dialog backdrop.
 *
 *   buttons: [{ id, label, primary?: boolean, danger?: boolean }, ...]
 *
 * Use when the choice is more than yes/no — e.g. Replace / Add / Cancel.
 * Confirm() is binary; this fills the gap without needing a dependency.
 */
export function chooseFromButtons(title, message, buttons) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    const btnHtml = buttons.map(b => {
      const colour = b.danger ? 'color:#f87171;' : (b.primary ? 'color:#22d3ee;font-weight:600;' : '');
      return `<button class="btn" data-sbs-choice="${_esc(b.id)}" style="${colour}">${_esc(b.label)}</button>`;
    }).join('');
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div class="sbs-dialog__title">${_esc(title)}</div>
        ${message ? `<div class="small muted" style="margin-top:8px;line-height:1.5;">${_esc(message)}</div>` : ''}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;">${btnHtml}</div>
      </div>
    `;
    document.body.appendChild(dlg);
    const done = (id) => { dlg.close(); dlg.remove(); resolve(id); };
    dlg.querySelectorAll('[data-sbs-choice]').forEach(btn => {
      btn.addEventListener('click', () => done(btn.dataset.sbsChoice));
    });
    dlg.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    dlg.showModal();
  });
}

/**
 * Like chooseFromButtons, but with a scrollable BEFORE → AFTER preview list
 * between the message and the buttons. For bulk operations that must show
 * exactly what they will change before the user commits (V0.3.2.66).
 *
 * @param {string} title
 * @param {string} message
 * @param {Array<{label?:string, from:string, to:string}>} rows
 * @param {Array<{id:string,label:string,primary?:boolean,danger?:boolean}>} buttons
 * @returns {Promise<string|null>} the chosen button id, or null on cancel
 */
export function chooseWithPreview(title, message, rows, buttons) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    const btnHtml = buttons.map(b => {
      const colour = b.danger ? 'color:#f87171;' : (b.primary ? 'color:#22d3ee;font-weight:600;' : '');
      return `<button class="btn" data-sbs-choice="${_esc(b.id)}" style="${colour}">${_esc(b.label)}</button>`;
    }).join('');
    // dir="auto" on the text cells so Hebrew previews read correctly.
    const rowHtml = (rows || []).map(r => `
      <div style="padding:6px 8px;border-bottom:1px solid var(--line);">
        ${r.label ? `<div class="small muted" style="font-size:11px;margin-bottom:2px;">${_esc(r.label)}</div>` : ''}
        <div dir="auto" style="font-size:12px;color:#f87171;white-space:pre-wrap;word-break:break-word;">− ${_esc(r.from)}</div>
        <div dir="auto" style="font-size:12px;color:#4ade80;white-space:pre-wrap;word-break:break-word;">+ ${_esc(r.to)}</div>
      </div>
    `).join('');
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="max-width:min(760px,90vw);">
        <div class="sbs-dialog__title">${_esc(title)}</div>
        ${message ? `<div class="small muted" style="margin-top:8px;line-height:1.5;white-space:pre-wrap;">${_esc(message)}</div>` : ''}
        <div style="margin-top:10px;max-height:min(46vh,420px);overflow:auto;border:1px solid var(--line);border-radius:6px;background:rgba(0,0,0,0.18);">
          ${rowHtml || '<div class="small muted" style="padding:10px;">Nothing to change.</div>'}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;">${btnHtml}</div>
      </div>
    `;
    document.body.appendChild(dlg);
    const done = (id) => { dlg.close(); dlg.remove(); resolve(id); };
    dlg.querySelectorAll('[data-sbs-choice]').forEach(btn => {
      btn.addEventListener('click', () => done(btn.dataset.sbsChoice));
    });
    dlg.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    dlg.showModal();
  });
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
