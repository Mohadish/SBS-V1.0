/**
 * 🏷 Brand panel (V0.3.3.12) — Tools ▸ Brand…
 * The link between this project and a company standard (.sbsbrand): what it
 * is linked to, what belongs to the brand vs to the project, save / update.
 */

import { state } from '../core/state.js';
import { setStatus } from './status.js';
import { getBrandLink, brandOverview, saveBrand, loadBrand, unlinkBrand, checkBrandUpdate } from '../systems/brand.js';

let _win = null;
let _busy = false;
let _update = null;   // newer revision on disk, if any

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function openBrandPanel() {
  if (!_win) _build();
  _win.style.display = '';
  _update = await checkBrandUpdate().catch(() => null);
  _render();
}

export function closeBrandPanel() { if (_win) _win.style.display = 'none'; }

function _build() {
  _win = document.createElement('div');
  _win.id = 'brand-panel';
  _win.style.cssText = [
    'position:fixed', 'left:160px', 'top:100px', 'width:430px', 'max-height:80vh',
    'background:var(--panel,#0f172a)', 'border:1px solid var(--line,#334155)', 'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.5)', 'z-index:45', 'display:flex', 'flex-direction:column',
    'color:var(--text,#e2e8f0)', 'font-size:13px',
  ].join(';');
  _win.innerHTML = `
    <div id="bp-header" style="cursor:move;padding:10px 12px;display:flex;align-items:center;gap:8px;background:rgba(34,197,94,0.16);border-bottom:1px solid var(--line,#334155);border-top-left-radius:10px;border-top-right-radius:10px;user-select:none;">
      <span style="flex:1;font-weight:600;">🏷 Brand</span>
      <button class="btn" id="bp-close" type="button" style="padding:2px 8px;font-size:12px;">✕</button>
    </div>
    <div id="bp-body" style="padding:12px;display:flex;flex-direction:column;gap:10px;overflow:auto;"></div>`;
  document.body.appendChild(_win);
  const head = _win.querySelector('#bp-header');
  let drag = null;
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = { dx: e.clientX - _win.offsetLeft, dy: e.clientY - _win.offsetTop }; head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', (e) => { if (!drag) return; _win.style.left = `${Math.max(0, e.clientX - drag.dx)}px`; _win.style.top = `${Math.max(0, e.clientY - drag.dy)}px`; });
  head.addEventListener('pointerup', () => { drag = null; });
  _win.querySelector('#bp-close').addEventListener('click', closeBrandPanel);
  const rerender = () => { if (_win && _win.style.display !== 'none') _render(); };
  for (const k of ['brand', 'styleTemplates', 'shapeStyles', 'constTextBoxes', 'constShapes', 'cropMasks', 'headerItems']) state.on(`change:${k}`, rerender);
}

function _render() {
  const link = getBrandLink();
  const body = _win.querySelector('#bp-body');
  const rows = brandOverview();
  body.innerHTML = `
    <div class="small muted" style="font-size:11.5px;line-height:1.5;">A brand is a company's standard in one file: header and logo, text and shape styles, constant-title positions, pinned positions, shared crop masks — and the look of the printed document (page layouts, its header and footer, watermark, company name). Save it from a project that looks right; load it into another project to bring it to the standard — and load it again whenever the standard changes.</div>
    <div style="padding:8px 10px;border:1px solid var(--line,#334155);border-radius:8px;background:var(--panel2,#1e293b);">
      ${link?.id
        ? `<div><b>${_esc(link.name)}</b> · revision ${_esc(link.revision)}</div><div class="small muted" style="font-size:11px;word-break:break-all;">${_esc(link.file || '')}</div>`
        : '<div class="small muted">This project is not linked to a brand yet.</div>'}
      ${_update ? `<div style="margin-top:6px;color:#fbbf24;font-size:12px;">⬆ Revision ${_esc(_update.fileRevision)} is on disk — this project is at ${_esc(_update.projectRevision)}.</div>` : ''}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${_update ? '<button class="btn" data-act="update" style="padding:4px 12px;font-weight:600;color:#fbbf24;">⬆ Update to the new revision</button>' : ''}
      <button class="btn" data-act="load" style="padding:4px 12px;font-weight:600;" title="Pick a .sbsbrand (or an old .sbsheader): linked definitions update in place, new ones are added, the project's own are left alone — previewed first, one undo">📥 Load / update from a brand…</button>
      <button class="btn" data-act="save" style="padding:4px 12px;font-weight:600;" title="Write this project's header, styles, positions, masks and the look of its document as a .sbsbrand">💾 Save brand…</button>
      ${link?.id ? '<button class="btn" data-act="unlink" style="padding:4px 12px;" title="Forget the link; every definition stays and becomes the project\'s own">Unlink</button>' : ''}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr style="color:var(--muted,#94a3b8);text-align:left;"><th style="padding:3px 4px;">Definitions</th><th style="padding:3px 4px;">Brand</th><th style="padding:3px 4px;">Project's own</th></tr>
      ${rows.map(r => `<tr><td style="padding:3px 4px;border-top:1px solid var(--line,#334155);">${_esc(r.label)}s</td><td style="padding:3px 4px;border-top:1px solid var(--line,#334155);">${r.brand}</td><td style="padding:3px 4px;border-top:1px solid var(--line,#334155);">${r.project}</td></tr>`).join('')}
    </table>
    <div class="small muted" style="font-size:11px;line-height:1.45;">📄 <b>The document's look</b> travels too — page layouts (matched by name), header and footer with their pictures, watermark, company name, numbering options. Loading a brand shows what would change in the document first, and you can apply the rest without it. Pages, texts, the title and the document number are never part of a brand.</div>
    <div class="small muted" style="font-size:11px;line-height:1.45;">"Project's own" definitions are never touched by a brand update. When you load a brand into a project that has definitions of its own, a matching page opens first: drag each of yours onto the brand definition it really is (several can fold into one), keep it as the project's own, or delete it. Only exact same-name matches are filled in for you.</div>`;
  body.querySelectorAll('[data-act]').forEach(b => {
    b.disabled = _busy;
    b.addEventListener('click', () => _run(b.dataset.act));
  });
}

async function _run(act) {
  if (_busy) return;
  _busy = true; _render();
  try {
    if (act === 'save') await saveBrand();
    else if (act === 'load') await loadBrand();
    else if (act === 'update') await loadBrand(_update?.file || null);
    else if (act === 'unlink') unlinkBrand();
    _update = await checkBrandUpdate().catch(() => null);
  } catch (e) {
    console.error(`[brand] ${act} failed:`, e);
    setStatus(`Brand ${act} failed: ${e?.message || e} — details in the console (Ctrl+Shift+I).`, 'warn', 10000);
  } finally {
    _busy = false;
    _render();
  }
}
