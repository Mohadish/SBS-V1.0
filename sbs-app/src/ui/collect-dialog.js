/**
 * 📦 Collect project — the dialog (V0.3.4.101).
 * ────────────────────────────────────────────
 * File ▸ Collect Project for Another Computer…  Lists everything the project
 * uses with where it was found; the user settles each file — copy, link by
 * absolute path, skip — locates a missing one with Browse…, ticks the folders
 * to carry, then picks where the .zip goes. Progress inside the dialog.
 */

import { state } from '../core/state.js';
import { setStatus } from './status.js';
import { gatherCollectItems, runCollect, formatMB } from '../systems/collect.js';
import * as projectPaths from '../core/project-paths.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KIND = { model: '🧊 CAD model', video: '🎬 Video clip', brand: '🏷 Brand', folder: '📁 Folder' };
const STATUS = {
  ok:         (i) => `<span style="color:#34d399;">✓ found</span>${i.size ? ` · ${formatMB(i.size)}` : ''}`,
  missing:    () => `<span style="color:#f87171;">✕ missing</span>`,
  unreadable: () => `<span style="color:#fbbf24;">🔒 cannot be read here</span>`,
};

export async function openCollectDialog() {
  if (!state.get('projectPath')) { setStatus('Save the project first — the collect works from the saved project and its folders.', 'warn', 7000); return; }
  if (document.getElementById('sbs-collect-dialog')) return;
  setStatus('Looking up everything the project uses…', 'info', 0);
  let items;
  try { items = await gatherCollectItems(); }
  catch (e) { setStatus(`Could not collect: ${e?.message || e}`, 'danger', 8000); return; }
  setStatus('', 'info', 1);

  const dlg = document.createElement('dialog');
  dlg.id = 'sbs-collect-dialog';
  dlg.className = 'sbs-dialog';
  dlg.style.cssText = 'width:min(1180px,96vw);max-width:96vw;max-height:90vh;overflow:hidden;';
  const parts = projectPaths.projectParts();
  const zipName = `${parts?.base || 'project'}-collected.zip`;

  const rowHtml = (i) => {
    const isFolder = i.kind === 'folder';
    const st = STATUS[i.status]?.(i) || '';
    const verdict = isFolder
      ? `<label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" data-act="include" ${i.include ? 'checked' : ''}> carry${i.files ? ` (${i.files.length} file${i.files.length === 1 ? '' : 's'}, ${formatMB(i.size)})` : ''}</label>`
      : `<select data-act="decision" style="background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:6px;height:26px;padding:0 6px;font-size:12px;">
           <option value="copy" ${i.decision === 'copy' ? 'selected' : ''} ${i.status !== 'ok' ? 'disabled' : ''}>Copy into the archive</option>
           <option value="link" ${i.decision === 'link' ? 'selected' : ''}>Link — keep the absolute path</option>
           <option value="skip" ${i.decision === 'skip' ? 'selected' : ''}>Skip — leave out</option>
         </select>${i.status !== 'ok' ? ' <button class="btn" data-act="browse" style="height:26px;padding:0 8px;font-size:12px;">Browse…</button>' : ''}`;
    return `
      <tr data-id="${_esc(i.id)}" style="border-bottom:1px solid var(--line);">
        <td style="padding:6px 8px;vertical-align:top;overflow:hidden;">${KIND[i.kind] || i.kind}</td>
        <td style="padding:6px 8px;vertical-align:top;overflow:hidden;">
          <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(i.src)}">${_esc(i.label)}${i.steps > 1 ? ` <span class="muted small">· ${i.steps} steps</span>` : ''}</div>
          <div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;" title="${_esc(i.src)}">${_esc(i.src)}</div>
          ${i.note ? `<div class="small muted">${_esc(i.note)}</div>` : ''}
        </td>
        <td class="small" data-cell="status" style="padding:6px 8px;vertical-align:top;overflow:hidden;">${st}</td>
        <td data-cell="verdict" style="padding:6px 8px;vertical-align:top;overflow:hidden;">${verdict}</td>
      </tr>`;
  };

  dlg.innerHTML = `
    <div class="sbs-dialog__body" style="display:flex;flex-direction:column;max-height:88vh;padding:16px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="flex:1;min-width:0;">
          <strong style="font-size:14px;">📦 Collect the project for another computer</strong>
          <div class="small muted" style="margin-top:2px;">One .zip: a copy of the project with paths pointing inside it, and every file it uses. Unzip anywhere, open the .sbsproj. Files that cannot be read here can be <b>linked</b> instead: the project keeps their absolute path.</div>
        </div>
      </div>
      <div style="flex:1;min-height:0;overflow:auto;margin-top:10px;border:1px solid var(--line);border-radius:8px;">
        <table style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:13px;">
          <colgroup><col style="width:130px;"><col><col style="width:150px;"><col style="width:330px;"></colgroup>
          <thead><tr style="position:sticky;top:0;background:#111827;"><th style="text-align:left;padding:6px 8px;">What</th><th style="text-align:left;padding:6px 8px;">File</th><th style="text-align:left;padding:6px 8px;">Found?</th><th style="text-align:left;padding:6px 8px;">In the archive</th></tr></thead>
          <tbody id="col-rows">${items.length ? items.map(rowHtml).join('') : '<tr><td colspan="4" class="small muted" style="padding:12px;">This project refers to no external file — the archive will hold the project alone.</td></tr>'}</tbody>
        </table>
      </div>
      <div id="col-total" class="small muted" style="margin-top:8px;"></div>
      <div id="col-progress" style="display:none;margin-top:8px;">
        <div id="col-progress-text" class="small"></div>
        <div style="height:6px;background:#1f2937;border-radius:3px;overflow:hidden;margin-top:4px;"><div id="col-progress-bar" style="height:100%;width:0%;background:#22d3ee;transition:width .15s;"></div></div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
        <button class="btn" id="col-cancel">Cancel</button>
        <button class="btn" id="col-go" style="font-weight:600;color:#22d3ee;">Collect…</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  const byId = new Map(items.map(i => [i.id, i]));
  const totalEl = dlg.querySelector('#col-total');
  const refreshTotal = () => {
    let bytes = 0, n = 0, linked = 0, skipped = 0;
    for (const i of items) {
      if (i.kind === 'folder') { if (i.include) { bytes += i.size; n += i.files.length; } else skipped++; continue; }
      if (i.decision === 'copy') { bytes += i.size; n++; } else if (i.decision === 'link') linked++; else skipped++;
    }
    totalEl.textContent = `${n} file${n === 1 ? '' : 's'} to copy (~${formatMB(bytes)}, stored without compression)${linked ? ` · ${linked} linked by absolute path` : ''}${skipped ? ` · ${skipped} left out` : ''}`;
  };
  refreshTotal();

  dlg.querySelector('#col-rows').addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-id]'); const it = tr && byId.get(tr.dataset.id); if (!it) return;
    const act = e.target.dataset.act;
    if (act === 'include') it.include = !!e.target.checked;
    if (act === 'decision') it.decision = e.target.value;
    refreshTotal();
  });
  dlg.querySelector('#col-rows').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act="browse"]'); if (!b) return;
    const tr = b.closest('tr[data-id]'); const it = tr && byId.get(tr.dataset.id); if (!it) return;
    const ext = (it.src.match(/\.([A-Za-z0-9]+)$/) || [])[1];
    const picked = await window.sbsNative?.openFile?.({ title: `Locate "${it.label}"`, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : undefined });
    if (!picked) return;
    const r = await window.sbsNative.readable(picked);
    if (!r?.ok) { setStatus(`"${picked}" cannot be read: ${r?.error || 'unknown'}.`, 'warn', 6000); return; }
    it.src = picked; it.size = r.size || 0; it.status = 'ok'; it.decision = 'copy';
    tr.querySelector('[data-cell="status"]').innerHTML = STATUS.ok(it);
    tr.querySelector('.small.muted[title]').textContent = picked; tr.querySelector('.small.muted[title]').title = picked;
    tr.querySelector('[data-cell="verdict"]').innerHTML = `<select data-act="decision" style="background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:6px;height:26px;padding:0 6px;font-size:12px;"><option value="copy" selected>Copy into the archive</option><option value="link">Link — keep the absolute path</option><option value="skip">Skip — leave out</option></select>`;
    refreshTotal();
  });

  const close = () => { try { dlg.close(); } catch {} dlg.remove(); };
  dlg.querySelector('#col-cancel').addEventListener('click', close);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!dlg.dataset.busy) close(); });

  dlg.querySelector('#col-go').addEventListener('click', async () => {
    const defaultPath = parts ? projectPaths.joinPath(parts.dir, zipName) : zipName;
    const zipPath = await window.sbsNative?.saveFile?.({ title: 'Collect the project to…', defaultPath, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
    if (!zipPath) return;
    const out = /\.zip$/i.test(zipPath) ? zipPath : `${zipPath}.zip`;
    dlg.dataset.busy = '1';
    for (const el of dlg.querySelectorAll('select, input, button')) el.disabled = true;
    const prog = dlg.querySelector('#col-progress'), ptxt = dlg.querySelector('#col-progress-text'), pbar = dlg.querySelector('#col-progress-bar');
    prog.style.display = '';
    try {
      const r = await runCollect({ items, zipPath: out, onProgress: (p) => {
        const pct = p.totalBytes ? Math.min(100, Math.round(100 * p.doneBytes / p.totalBytes)) : (p.phase === 'files' ? 0 : 100);
        pbar.style.width = `${pct}%`;
        ptxt.textContent = p.phase === 'files' ? `Copying ${p.file}… ${formatMB(p.doneBytes)} of ${formatMB(p.totalBytes)}` : p.phase === 'project' ? 'Writing the project file…' : 'Closing the archive…';
      } });
      close();
      const note = r.failed.length ? ` ${r.failed.length} file(s) could not be read and were linked by absolute path instead — see COLLECT-REPORT.txt inside.` : '';
      setStatus(`📦 Collected: ${formatMB(r.bytes)}, ${r.count} entries → ${out}.${note}`, r.failed.length ? 'warning' : 'success', 15000);
      try { await window.sbsNative?.showInFolder?.(out); } catch { /* optional */ }
    } catch (e) {
      delete dlg.dataset.busy;
      for (const el of dlg.querySelectorAll('select, input, button')) el.disabled = false;
      prog.style.display = 'none';
      setStatus(`Collect failed: ${e?.message || e}`, 'danger', 10000);
    }
  });
  dlg.showModal();
}
