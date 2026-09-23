/**
 * 📦 Collect project (V0.3.4.101) — everything the project needs, in one .zip.
 * ─────────────────────────────────────────────────────────────────────────
 * 3ds Max calls it Archive, After Effects Collect Files: gather every external
 * thing a project refers to — the CAD models, the video clips (whole, as the
 * user asked; trimming to the used windows is a later option), the brand file,
 * the interface library, and the project's own folders (audio, languages,
 * media; the render cache on request) — beside a COPY of the project whose
 * paths point INTO the package. Unzip anywhere, open the .sbsproj, done.
 *
 * Three verdicts per file, the user's rules:
 *   copy  — it is in the archive, the project points at the copy (relative);
 *   link  — it cannot be read here (a restricted share) or the user chose so:
 *           NOT in the archive, the project keeps an ABSOLUTE path to it, so a
 *           machine that can see the share still loads it;
 *   skip  — left out; the project keeps what it had (the load will report it).
 * A missing file can be located with Browse… before collecting.
 *
 * The .zip is streamed by the main process (electron/collect-zip.js); this
 * module decides WHAT goes in and writes the adjusted project.
 */

import { state } from '../core/state.js';
import { steps } from './steps.js';
import { serialize, encodeProjectBytes, assetPathCandidates } from '../io/project.js';
import * as projectPaths from '../core/project-paths.js';
import { stepVideoClips } from './video-overlay.js';
import { APP_VERSION } from '../core/schema.js';

const _base  = (p) => String(p || '').split(/[\\/]/).pop();
const _norm  = (p) => String(p || '').replace(/\\/g, '/');
const _same  = (a, b) => !!a && !!b && _norm(a).toLowerCase() === _norm(b).toLowerCase();
const _under = (p, dir) => !!p && !!dir && _norm(p).toLowerCase().startsWith(_norm(dir).toLowerCase().replace(/\/+$/, '') + '/');

async function _probe(p) {
  if (!p || !window.sbsNative?.readable) return { ok: false, error: 'ENOENT' };
  try { return await window.sbsNative.readable(p); } catch (e) { return { ok: false, error: e?.message || 'probe failed' }; }
}
const _isAccess = (err) => /^(EACCES|EPERM|EBUSY|EIO)$/i.test(String(err || ''));

/** A zip path nobody else in this collect uses: folder/name, folder/name (2), … */
function _uniqueDst(taken, folder, name) {
  const clean = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_');
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
  let dst = `${folder}/${clean}`, n = 2;
  while (taken.has(dst.toLowerCase())) dst = `${folder}/${stem} (${n++})${ext}`;
  taken.add(dst.toLowerCase());
  return dst;
}

async function _folderItem(id, label, absDir, dstRoot, { include = true, note = '' } = {}) {
  const list = await window.sbsNative?.listTree?.(absDir).catch?.(() => null) ?? (await window.sbsNative?.listTree?.(absDir));
  if (!Array.isArray(list) || !list.length) return null;
  const files = list.map(f => ({ src: `${absDir.replace(/[\\/]+$/, '')}/${f.rel}`, dst: `${dstRoot}/${f.rel}`, size: f.size || 0 }));
  return { id, kind: 'folder', label, src: absDir, files, size: files.reduce((s, f) => s + (f.size || 0), 0), status: 'ok', decision: 'copy', include, note };
}

/**
 * Everything the project refers to, with where each thing was found and what
 * would be done with it. The dialog shows this list and lets the user change
 * the verdicts; runCollect executes them.
 */
export async function gatherCollectItems() {
  const pp = state.get('projectPath');
  if (!pp) throw new Error('Save the project first — the collect works from the saved project and its folders.');
  const dir = projectPaths.projectDir();
  const items = [], taken = new Set();

  // ── CAD models ──
  for (const a of state.get('assets') || []) {
    if (a.type === 'hardware' && a.hardware) continue;   // procedural — rebuilt from its template
    const cands = assetPathCandidates(a, pp);
    let src = null, hit = null, first = null;
    for (const c of cands) { const r = await _probe(c); if (r.ok && !r.dir) { src = c; hit = r; break; } if (!first) first = r; }
    const status = src ? 'ok' : (_isAccess(first?.error) ? 'unreadable' : 'missing');
    const shown = src || cands[0] || '';
    items.push({
      id: `asset:${a.id}`, kind: 'model', assetId: a.id, label: a.name || _base(shown) || 'model', src: shown,
      size: hit?.size || 0, status, decision: status === 'ok' ? 'copy' : status === 'unreadable' ? 'link' : 'skip',
      dst: _uniqueDst(taken, 'assets', _base(shown) || a.name || 'model'),
    });
  }

  // ── video clips on the steps (every step, hidden ones too) ──
  const seenVideo = new Map();
  for (const s of state.get('steps') || []) {
    for (const clip of stepVideoClips(s)) {
      const key = _norm(clip.abs).toLowerCase();
      if (seenVideo.has(key)) { seenVideo.get(key).steps++; continue; }
      const r = await _probe(clip.abs);
      const status = r.ok ? 'ok' : (_isAccess(r.error) ? 'unreadable' : 'missing');
      const it = {
        id: `video:${key}`, kind: 'video', label: _base(clip.abs), src: clip.abs, steps: 1,
        size: r.size || 0, status, decision: status === 'ok' ? 'copy' : status === 'unreadable' ? 'link' : 'skip',
        dst: _uniqueDst(taken, 'media', _base(clip.abs)),
      };
      seenVideo.set(key, it);
      items.push(it);
    }
  }

  // ── the brand file ──
  const brand = state.get('brand');
  if (brand?.file) {
    const r = await _probe(brand.file);
    const status = r.ok ? 'ok' : (_isAccess(r.error) ? 'unreadable' : 'missing');
    items.push({ id: 'brand', kind: 'brand', label: `${brand.name || 'Brand'} (.sbsbrand)`, src: brand.file, size: r.size || 0, status,
      decision: status === 'ok' ? 'copy' : status === 'unreadable' ? 'link' : 'skip', dst: _uniqueDst(taken, 'brand', _base(brand.file)) });
  }

  // ── the interface library folder ──
  const lib = state.get('interfaceLibraryFolder');
  if (lib) {
    const f = await _folderItem('interfaces', 'Interface library (folder)', lib, 'interfaces');
    if (f) items.push(f); else items.push({ id: 'interfaces', kind: 'folder', label: 'Interface library (folder)', src: lib, files: [], size: 0, status: 'missing', decision: 'skip', include: false });
  }

  // ── the project's own folders ──
  if (dir) {
    const own = [
      ['audio',     'Voice-over audio (audio/)',      true,  ''],
      ['languages', 'Language packs (languages/)',    true,  ''],
      ['media',     'Media (media/)',                 true,  'imported clips, posters'],
      ['render',    'Render cache (render/)',         false, 'rendered segments — big, and rebuilt by the next export; tick to carry them'],
    ];
    for (const [key, label, include, note] of own) {
      const abs = projectPaths.subDir(key);
      const f = await _folderItem(`folder:${key}`, label, abs, projectPaths.DIR[key], { include, note });
      if (!f) continue;
      // a clip already listed by its step is not carried twice
      f.files = f.files.filter(x => !seenVideo.has(_norm(x.src).toLowerCase()));
      f.size = f.files.reduce((s, x) => s + (x.size || 0), 0);
      if (f.files.length) items.push(f);
    }
  }
  return items;
}

/** The project as the archive will hold it: paths pointing into the package, or absolute for linked files. */
export async function collectedProject(items) {
  steps.flushSync();
  steps.upsertBaseStep();
  const project = serialize(null);
  const pp = state.get('projectPath');
  const dir = _norm(projectPaths.projectDir() || '').replace(/\/+$/, '');

  // models
  const byAsset = new Map(items.filter(i => i.kind === 'model').map(i => [i.assetId, i]));
  project.assets.items = (project.assets.items || []).map(a => {
    const it = byAsset.get(a.id);
    if (!it) return a;
    if (it.decision === 'copy' && !it.failed) return { ...a, relativePath: it.dst, originalPath: it.src || a.originalPath };
    if (it.decision === 'link' || it.failed)    return { ...a, relativePath: '', originalPath: it.src || a.originalPath };
    return a;
  });

  // video clips — inside each step's overlay string
  const videos = items.filter(i => i.kind === 'video');
  if (videos.length) {
    const find = (abs) => videos.find(v => _same(v.src, abs));
    for (const s of project.steps.items || []) {
      const ov = s.overlay;
      if (typeof ov !== 'string' || !ov || ov.indexOf('"isVideo":true') === -1) continue;
      let spec, changed = false;
      try { spec = JSON.parse(ov); } catch { continue; }
      (function walk(n) {
        if (!n) return;
        const a = n.attrs;
        if (a?.isVideo) {
          const abs = (a.videoRel && dir) ? `${dir}/${_norm(a.videoRel)}` : _norm(a.videoPath || '');
          const it = find(abs);
          if (it) {
            if (it.decision === 'copy' && !it.failed) { if (a.videoRel !== it.dst) { a.videoRel = it.dst; changed = true; } }
            else if (it.decision === 'link' || it.failed) { if (a.videoRel || a.videoPath !== it.src) { a.videoRel = ''; a.videoPath = it.src; changed = true; } }
          }
        }
        (n.children || []).forEach(walk);
      })(spec);
      if (changed) s.overlay = JSON.stringify(spec);
    }
  }

  // brand + interface library
  const brandIt = items.find(i => i.id === 'brand');
  if (brandIt && project.brand) project.brand = { ...project.brand, fileRel: brandIt.decision === 'copy' && !brandIt.failed ? brandIt.dst : '' };
  const libIt = items.find(i => i.id === 'interfaces');
  if (libIt && project.settings) project.settings.interfaceLibraryFolderRel = (libIt.include && libIt.decision === 'copy') ? 'interfaces' : (project.settings.interfaceLibraryFolderRel || '');

  project._sbs.collected = { at: new Date().toISOString(), from: pp, app: APP_VERSION };
  const name = `${projectPaths.projectParts()?.base || 'project'}.sbsproj`;
  return { project, name };
}

function _fmtMB(n) { return `${(Math.max(0, n) / 1048576).toFixed(n > 100 * 1048576 ? 0 : 1)} MB`; }

function _report(items, result, projectName) {
  const L = [];
  L.push(`SBS — collected project`, `${new Date().toString()}`, `App ${APP_VERSION}`, `Project: ${projectName}`, '');
  L.push('Open the .sbsproj in this folder — its paths point at the files beside it.', '');
  const rows = (kind) => items.filter(i => i.kind === kind);
  const line = (i) => `  ${i.label}${i.size ? ` (${_fmtMB(i.size)})` : ''} — ${i.src || ''}`;
  const copied = items.filter(i => i.kind === 'folder' ? i.include : (i.decision === 'copy' && !i.failed));
  const linked = items.filter(i => i.kind !== 'folder' && (i.decision === 'link' || i.failed));
  const skipped = items.filter(i => i.kind === 'folder' ? !i.include : i.decision === 'skip');
  L.push(`COPIED INTO THE ARCHIVE (${copied.length})`); for (const i of copied) L.push(line(i) + (i.kind === 'folder' ? ` — ${i.files.length} file(s)` : ` → ${i.dst}`)); L.push('');
  L.push(`LINKED BY ABSOLUTE PATH — not in the archive (${linked.length})`);
  for (const i of linked) L.push(line(i) + (i.failed ? `   [could not be read: ${i.failed}]` : ''));
  L.push('  The project keeps these absolute paths; a computer that can see them loads them.', '');
  L.push(`LEFT OUT (${skipped.length})`); for (const i of skipped) L.push(line(i) + (i.status === 'missing' ? '   [was missing]' : '')); L.push('');
  if (result?.failed?.length) { L.push('FILES THE ARCHIVE COULD NOT TAKE'); for (const f of result.failed) L.push(`  ${f.dst} — ${f.error}`); L.push(''); }
  void rows;
  return L.join('\n');
}

/**
 * Write the archive. `items` carry the verdicts (decision / include). Progress:
 * { phase, doneBytes, totalBytes, file }. Resolves { path, bytes, count, report }.
 */
export async function runCollect({ items, zipPath, onProgress = null, signal = null } = {}) {
  const api = window.sbsNative?.collect;
  if (!api) throw new Error('This build cannot collect — restart the app (the bridge is missing).');
  const files = [];
  for (const it of items) {
    if (it.kind === 'folder') { if (it.include) for (const f of it.files) files.push({ it, ...f }); }
    else if (it.decision === 'copy') files.push({ it, src: it.src, dst: it.dst, size: it.size });
  }
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  let doneBytes = 0, current = '';
  const b = await api.begin(zipPath);
  if (!b?.ok) throw new Error(b?.error || 'could not create the archive');
  const token = b.token;
  const off = api.onProgress?.((d) => { if (d?.token === token) { doneBytes += d.bytes || 0; onProgress?.({ phase: 'files', doneBytes, totalBytes, file: current }); } });
  const failed = [];
  try {
    for (const f of files) {
      if (signal?.aborted) throw new DOMException('Collect cancelled', 'AbortError');
      current = f.dst;
      onProgress?.({ phase: 'files', doneBytes, totalBytes, file: current });
      const r = await api.addFile(token, f.src, f.dst);
      if (!r?.ok) {
        if (r?.fatal) throw new Error(r.error || 'archive write failed');
        failed.push({ dst: f.dst, error: r?.error || 'unreadable' });
        if (f.it.kind !== 'folder') f.it.failed = r?.error || 'unreadable';   // → linked by absolute path in the project
      }
    }
    onProgress?.({ phase: 'project', doneBytes, totalBytes, file: 'the project file' });
    const { project, name } = await collectedProject(items);
    const bytes = await encodeProjectBytes(project);
    let r = await api.addText(token, name, bytes);
    if (!r?.ok) throw new Error(r?.error || 'could not write the project into the archive');
    r = await api.addText(token, 'COLLECT-REPORT.txt', _report(items, { failed }, name));
    if (!r?.ok) throw new Error(r?.error || 'could not write the report');
    onProgress?.({ phase: 'finish', doneBytes, totalBytes, file: 'closing the archive' });
    const fin = await api.finish(token);
    if (!fin?.ok) throw new Error(fin?.error || 'archive write failed');
    return { path: zipPath, bytes: fin.bytes, count: fin.count, failed, report: _report(items, { failed }, name) };
  } catch (e) {
    try { await api.abort(token); } catch { /* best effort */ }
    throw e;
  } finally {
    try { off?.(); } catch { /* ignore */ }
  }
}

export { _fmtMB as formatMB };
