/**
 * SBS — Asset Verification Dialog
 * =================================
 * Shown before project load when model files can't be auto-resolved
 * (always on web; Electron only when a path is missing/moved).
 *
 * showAssetVerifyDialog(assets, isElectron)
 *   → Promise<Map<assetId, File>>  (only user-provided files; auto-paths handled by caller)
 *   → rejects if user cancels
 */

const ACCEPT = '.step,.stp,.iges,.igs,.brep,.brp,.obj,.stl,.gltf,.glb';

/**
 * @param {Array<{assetEntry, resolvedPath}>} assets
 * @param {boolean} isElectron
 * @returns {Promise<Map<string, File>>}
 */
/**
 * Score a file against a saved asset entry using metadata.
 * Returns: 'ok' | 'warning' | 'missing'
 *   ok      = name + size + lastModified all match (or no metadata to compare)
 *   warning = name matches but size or lastModified differs
 *   missing = no match
 */
function _metaStatus(assetEntry, fileMeta) {
  // fileMeta: { name, size, lastModified } — from File object or fs.stat
  const expName = (assetEntry.originalPath || assetEntry.name || '').split(/[\\/]/).pop().toLowerCase();
  const gotName = (fileMeta.name || '').toLowerCase();
  const nameMatch = expName === gotName
    || expName.replace(/\.[^.]+$/, '') === gotName.replace(/\.[^.]+$/, '');
  if (!nameMatch) return 'missing';

  // Name matches — now check size and lastModified if we have saved values
  const hasSizeCheck = assetEntry.fileSize != null && fileMeta.size != null;
  const hasMtimeCheck = assetEntry.lastModified != null && fileMeta.lastModified != null;

  if (!hasSizeCheck && !hasMtimeCheck) return 'ok';   // no metadata → trust name

  const sizeOk  = !hasSizeCheck  || Math.abs(fileMeta.size - assetEntry.fileSize) < 16;
  // mtime may differ slightly across OS copies; allow 2-second tolerance
  const mtimeOk = !hasMtimeCheck || Math.abs(fileMeta.lastModified - assetEntry.lastModified) < 2000;

  return (sizeOk && mtimeOk) ? 'ok' : 'warning';
}

export async function showAssetVerifyDialog(assets, isElectron, { forceShow = false } = {}) {
  // Build row state with async metadata check for Electron paths
  const rows = await Promise.all(assets.map(async ({ assetEntry, resolvedPath }) => {
    let status = 'missing';
    if (isElectron && resolvedPath) {
      try {
        const stat = window.sbsNative?.statFile
          ? await window.sbsNative.statFile(resolvedPath)
          : null;
        if (stat) {
          const fileName = resolvedPath.split(/[\\/]/).pop();
          status = _metaStatus(assetEntry, { name: fileName, size: stat.size, lastModified: stat.mtimeMs });
        } else {
          // statFile unavailable or returned null — fall back to existence check
          const exists = window.sbsNative?.fileExists
            ? await window.sbsNative.fileExists(resolvedPath)
            : false;
          status = exists ? 'ok' : 'missing';
        }
      } catch {
        // Any error — fall back to existence check
        try {
          const exists = window.sbsNative?.fileExists
            ? await window.sbsNative.fileExists(resolvedPath)
            : false;
          status = exists ? 'ok' : 'missing';
        } catch { /* remain missing */ }
      }
    }
    return { assetEntry, resolvedPath, file: null, status };
  }));

  // All OK and not forced → skip dialog
  if (!forceShow && rows.every(r => r.status === 'ok')) return new Map();

  return new Promise((resolve, reject) => {

    // ── Build dialog ────────────────────────────────────────────────────────
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';

    function _icon(s)  { return s === 'ok' ? '✅' : s === 'warning' ? '⚠️' : '❌'; }
    function _esc(s)   {
      return String(s ?? '').replace(/[&<>"']/g,
        c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
    }

    function _render() {
      let ok = 0, warn = 0, miss = 0;
      rows.forEach(r => { if (r.status === 'ok') ok++; else if (r.status === 'warning') warn++; else miss++; });
      const hasWarn = warn > 0;
      const canLoad = !hasWarn;   // ❌ missing is OK — ⚠️ wrong file is not

      dlg.innerHTML = `
        <div class="sbs-dialog__body" style="width:640px;max-width:calc(100vw - 48px)">
          <div class="sbs-dialog__title">Project Asset Verification</div>
          <div class="small muted" style="margin:4px 0 8px">
            Locate missing model files before loading. Use Browse All for bulk auto-matching.
          </div>
          <div class="small muted" style="margin-bottom:10px">
            ${_icon('ok')} ${ok} OK &nbsp; ${_icon('warning')} ${warn} Warning &nbsp; ${_icon('missing')} ${miss} Missing
          </div>
          ${hasWarn ? `<div class="small" style="color:#f59e0b;margin-bottom:8px">⚠️ Wrong file detected — clear warnings or replace with correct files before loading.</div>` : ''}
          <div id="av-list" style="max-height:52vh;overflow-y:auto;display:flex;flex-direction:column;gap:6px"></div>
          <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;flex-wrap:wrap">
            <button class="btn" id="av-browse-all">Browse All…</button>
            <button class="btn" id="av-cancel">Cancel</button>
            ${hasWarn
              ? `<button class="btn" id="av-clear-warnings" style="color:#f59e0b">Clear All Warnings</button>`
              : `<button class="btn" id="av-load" ${canLoad ? '' : 'disabled'}>Load Project</button>`
            }
          </div>
        </div>
      `;

      const list = dlg.querySelector('#av-list');
      rows.forEach((row, idx) => {
        const pathLabel = row.file
          ? row.file.name
          : (row.resolvedPath || row.assetEntry.originalPath || 'Not found');

        const item = document.createElement('div');
        item.className = 'card';
        item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px';
        item.innerHTML = `
          <span style="font-size:15px;flex-shrink:0">${_icon(row.status)}</span>
          <div style="flex:1;min-width:0">
            <div class="small" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                 title="${_esc(row.assetEntry.name)}">${_esc(row.assetEntry.name)}</div>
            <div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                 title="${_esc(pathLabel)}">${_esc(pathLabel)}</div>
          </div>
          <button class="btn" data-browse="${idx}">Browse…</button>
          ${row.file ? `<button class="btn" data-clear="${idx}" title="Clear">✕</button>` : ''}
        `;
        list.appendChild(item);
      });

      // Wire events
      dlg.querySelectorAll('[data-browse]').forEach(btn =>
        btn.addEventListener('click', () => _browseOne(parseInt(btn.dataset.browse))));
      dlg.querySelectorAll('[data-clear]').forEach(btn =>
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.clear);
          rows[i].file   = null;
          rows[i].status = 'missing';
          _render();
        }));

      dlg.querySelector('#av-browse-all').addEventListener('click', _browseAll);
      dlg.querySelector('#av-cancel').addEventListener('click', () => {
        dlg.close(); dlg.remove(); reject(new Error('cancelled'));
      });
      dlg.querySelector('#av-clear-warnings')?.addEventListener('click', () => {
        rows.forEach(r => { if (r.status === 'warning') { r.file = null; r.status = 'missing'; } });
        _render();
      });
      dlg.querySelector('#av-load')?.addEventListener('click', () => {
        const result = new Map();
        rows.forEach(r => { if (r.file) result.set(r.assetEntry.id, r.file); });
        dlg.close(); dlg.remove();
        resolve(result);
      });
    }

    // ── Score / assign a user-picked file ────────────────────────────────
    function _assign(idx, file) {
      rows[idx].file   = file;
      rows[idx].status = _metaStatus(rows[idx].assetEntry, {
        name:         file.name,
        size:         file.size,
        lastModified: file.lastModified,
      });
      _render();
    }

    // Bulk-browse score: pick best name match when metadata unavailable yet
    function _score(assetEntry, file) {
      const exp = (assetEntry.originalPath || assetEntry.name || '').split(/[\\/]/).pop().toLowerCase();
      const got = file.name.toLowerCase();
      if (exp === got)                                                                           return 3;
      if (exp.replace(/\.[^.]+$/, '') === got.replace(/\.[^.]+$/, ''))                         return 2;
      if (got.includes(exp.replace(/\.[^.]+$/, '')) || exp.includes(got.replace(/\.[^.]+$/, ''))) return 1;
      return 0;
    }

    function _browseOne(idx) {
      const input   = document.createElement('input');
      input.type    = 'file';
      input.accept  = ACCEPT;
      input.onchange = () => { if (input.files[0]) _assign(idx, input.files[0]); };
      input.click();
    }

    function _browseAll() {
      const input    = document.createElement('input');
      input.type     = 'file';
      input.accept   = ACCEPT;
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        const used = new Set();
        rows.forEach((row, idx) => {
          if (row.status === 'ok' && !row.file) return;  // already auto-resolved
          let bestIdx = -1, bestScore = -1;
          files.forEach((f, fi) => {
            if (used.has(fi)) return;
            const s = _score(row.assetEntry, f);
            if (s > bestScore) { bestScore = s; bestIdx = fi; }
          });
          if (bestIdx >= 0 && bestScore > 0) { used.add(bestIdx); _assign(idx, files[bestIdx]); }
        });
      };
      input.click();
    }

    _render();
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}
