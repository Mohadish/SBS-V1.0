/**
 * 🚀 Quick start (V0.3.5.60) — "what do you want to do?"
 *
 * Not a tutorial: a launcher for the occasional user, who knows what the job
 * is but not where the app keeps it. Five jobs, each one running the app's
 * EXISTING flows in order (nothing here re-implements New / Open / brand /
 * import / document / review — it only asks the questions up front and
 * chains the doors):
 *
 *   📂 Continue a project   recent list (core/recent-projects.js) · Open another…
 *   ✨ New project          New → brand? → empty / steps from Excel / steps from another project
 *   ⬚ Design an object     the Poly Editor, empty (new asset)
 *   📄 Make a document      which project? → open it → the Document workspace
 *   📊 Client's corrections which project? → which returned sheet? → open → Review form ▸ Import
 *
 * Every question may be answered with Cancel / Esc: the flow just stops.
 *
 * Opens with the app (user setting quickStart.showAtStart, "Don't show this at
 * start" in the corner, Settings ▸ Start-up turns it back on) — never during an
 * export, a test harness, or when a project is already open / opening. Always
 * reachable: Files tab ▸ 🚀 Quick start, Help ▸ Quick start.
 *
 * Also records the recent list: a project opened or saved goes on top.
 */

import { state } from '../core/state.js';
import * as userSettings from '../core/user-settings.js';
import { setStatus } from './status.js';
import { addRecent, removeRecent, markMissing, recentWhen, samePath, cleanRecent } from '../core/recent-projects.js';

let _dlg = null;
let _inited = false;

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TASKS = [
  { id: 'continue',    ico: '📂', name: 'Continue a project',            desc: 'Pick up where you left off — one of your recent projects, or any other.' },
  { id: 'new',         ico: '✨', name: 'New project',                   desc: 'Start fresh — with your brand, and steps from an Excel sheet or another project if you like.' },
  { id: 'design',      ico: '⬚', name: 'Design an object',              desc: 'Model a new part from simple shapes and keep it as a file any project can load.' },
  { id: 'document',    ico: '📄', name: 'Make a document',               desc: "Turn a project's steps into a printable manual (PDF)." },
  { id: 'corrections', ico: '📊', name: "Apply the client's corrections", desc: 'Bring a review sheet the client sent back into its project — text fixes and notes.' },
];

// ─── boot wiring ────────────────────────────────────────────────────────────

/** Once, at boot (main.js): recent-list recording, the Help-menu door, the console handle. */
export function initQuickStart() {
  if (_inited) return;
  _inited = true;
  // 'project:loaded' fires twice per open (applyProjectToState, then loadProject with
  // the payload, AFTER the path is set) — the second one has the real path.
  state.on('project:loaded', (p) => { if (p?.project) _remember(state.get('projectPath')); });
  state.on('project:saved',  (p) => _remember(p?.path));
  window.sbsNative?.onMenu?.('menu:quickStart', () => openQuickStart());
  window.sbsQuickStart = { open: openQuickStart, close: closeQuickStart };
}

/**
 * At start, after the user settings are in (main.js). Waits for any window
 * already up (a licence notice) to close, then shows — unless the user turned
 * it off, a harness drives the app, or work has already begun.
 */
export function maybeShowQuickStartAtBoot() {
  const us = userSettings.get();
  if (us.quickStart?.showAtStart === false || _automated()) return;
  const t0 = performance.now();
  const tick = () => {
    if (_busyElsewhere()) return;                              // work began (a project is opening, an export, the Poly Editor): never on top of it
    if (document.querySelector('dialog[open]')) {             // the licence notices / prompts are all <dialog>s
      if (performance.now() - t0 < 60000) setTimeout(tick, 500);
      return;
    }
    openQuickStart();
  };
  setTimeout(tick, 400);                                      // let the first frame paint
}

// A test harness drives the app through CDP: a modal window would swallow its keys.
function _automated() {
  try {
    if (navigator.webdriver) return true;
    if (/[?&]noquickstart\b/i.test(location.search || '')) return true;
    if (window.sbsNative?.noQuickStart) return true;
    if (localStorage.getItem('sbs.noQuickStart') === '1') return true;
  } catch { /* storage blocked: not automated */ }
  return false;
}

function _busyElsewhere() {
  return !!(state.get('projectPath') || state.get('_projectLoading') || state.get('_exporting')
    || state.get('polySession') || (state.get('assets') || []).length);
}

async function _remember(path) {
  // Only a real file path can be reopened later (the web build has a file NAME only).
  if (!window.sbsNative?.isElectron || typeof path !== 'string' || !/[\\/]/.test(path)) return;
  try {
    await userSettings.initUserSettings();                    // get() before init would hand back the DEFAULT (empty) list
    const cur = userSettings.get().quickStart || {};
    await userSettings.patch({ quickStart: { recent: addRecent(cur.recent, path) } });
  } catch (e) { console.warn('[quick start] recent list not saved:', e?.message || e); }
}

async function _forget(path) {
  const cur = userSettings.get().quickStart || {};
  await userSettings.patch({ quickStart: { recent: removeRecent(cur.recent, path) } });
}

// ─── the window ─────────────────────────────────────────────────────────────

export async function openQuickStart() {
  if (state.get('_exporting')) { setStatus('A video export is running — open Quick start when it has finished.', 'warn', 6000); return; }
  await userSettings.initUserSettings();
  if (!_dlg) _build();
  _showHome();
  if (!_dlg.open) { try { _dlg.showModal(); } catch { closeQuickStart(); } }
}

export function closeQuickStart() {
  if (!_dlg) return;
  try { _dlg.close(); } catch { /* fine */ }
  _dlg.remove();
  _dlg = null;
}

function _build() {
  _dlg = document.createElement('dialog');
  _dlg.className = 'sbs-dialog';
  _dlg.id = 'quick-start';
  _dlg.style.cssText = 'width:min(780px,94vw);max-width:94vw;';
  _dlg.innerHTML = `
    <style>
      #quick-start .qs-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:10px; }
      #quick-start .qs-card { display:flex; gap:12px; align-items:flex-start; text-align:left; padding:14px; min-height:86px;
        border:1px solid var(--line); border-radius:12px; background:rgba(127,127,127,.06); color:var(--text); font:inherit; cursor:pointer; }
      #quick-start .qs-card:hover, #quick-start .qs-card:focus-visible { border-color:#f59e0b; background:rgba(245,158,11,.10); outline:none; }
      #quick-start .qs-ico { font-size:26px; line-height:1; flex-shrink:0; }
      #quick-start .qs-name { font-weight:700; font-size:14px; margin-bottom:4px; }
      #quick-start .qs-desc { font-size:12px; line-height:1.45; color:var(--muted); }
      #quick-start .qs-list { display:flex; flex-direction:column; gap:6px; max-height:46vh; overflow:auto; }
      #quick-start .qs-row { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; cursor:pointer; }
      #quick-start .qs-row:hover, #quick-start .qs-row:focus-visible { border-color:#f59e0b; background:rgba(245,158,11,.08); outline:none; }
      #quick-start .qs-row.missing { opacity:.5; cursor:default; }
      #quick-start .qs-row.missing:hover { border-color:var(--line); background:none; }
      #quick-start .qs-rmain { flex:1; min-width:0; }
      #quick-start .qs-rname { font-weight:600; font-size:13px; }
      #quick-start .qs-rfolder { font-size:11px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:ltr; }
      #quick-start .qs-rwhen { font-size:11px; color:var(--muted); white-space:nowrap; }
      #quick-start .qs-opt { display:flex; gap:8px; align-items:flex-start; margin:6px 0; cursor:pointer; font-size:13px; }
      #quick-start .qs-h { font-weight:700; font-size:13px; margin:12px 0 4px; }
    </style>
    <div class="sbs-dialog__body" style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;align-items:flex-start;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div class="sbs-dialog__title" id="qs-title">🚀 Quick start</div>
          <div class="small muted" id="qs-sub">What do you want to do?</div>
        </div>
        <button class="btn" id="qs-close" type="button" title="Close (Esc)" style="padding:2px 9px;">✕</button>
      </div>
      <div id="qs-view"></div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:10px;">
        <label class="small" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="qs-noshow" /> Don't show this at start
        </label>
        <span style="flex:1;"></span>
        <span class="small muted" style="font-size:11px;">Always here: Files tab ▸ 🚀 Quick start · Help ▸ Quick start</span>
      </div>
    </div>`;
  document.body.appendChild(_dlg);

  // keys typed here are the window's — never the app's shortcuts behind it. Esc still reaches 'cancel'.
  const stopKey = (e) => e.stopPropagation();
  _dlg.addEventListener('keydown', stopKey);
  _dlg.addEventListener('keyup', stopKey);
  _dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeQuickStart(); });
  _dlg.querySelector('#qs-close').addEventListener('click', closeQuickStart);

  const cb = _dlg.querySelector('#qs-noshow');
  cb.checked = userSettings.get().quickStart?.showAtStart === false;
  cb.addEventListener('change', () => {
    userSettings.patch({ quickStart: { showAtStart: !cb.checked } }).catch(e => console.warn('[quick start] setting not saved:', e));
    if (cb.checked) setStatus('Quick start will not open at start — Settings ▸ Start-up turns it back on.', 'info', 6000);
  });
}

function _head(title, sub) {
  _dlg.querySelector('#qs-title').textContent = title;
  _dlg.querySelector('#qs-sub').textContent = sub;
}

const _view = () => _dlg.querySelector('#qs-view');

function _showHome() {
  _head('🚀 Quick start', 'What do you want to do?');
  // autofocus: showModal() focuses it rather than the ✕ (Enter must not close the window by accident)
  _view().innerHTML = `<div class="qs-grid">${TASKS.map((t, i) => `
    <button class="qs-card" type="button" data-task="${t.id}"${i === 0 ? ' autofocus' : ''}>
      <span class="qs-ico">${t.ico}</span>
      <span><div class="qs-name">${_esc(t.name)}</div><div class="qs-desc">${_esc(t.desc)}</div></span>
    </button>`).join('')}</div>`;
  _view().querySelectorAll('[data-task]').forEach(b => b.addEventListener('click', () => _startTask(b.dataset.task)));
  _view().querySelector('[data-task]')?.focus();
}

function _startTask(id) {
  if (id === 'continue')    return _showContinue();
  if (id === 'new')         return _showNew();
  if (id === 'design')      return _runDesign();
  if (id === 'document')    return _showProjectPick('document');
  if (id === 'corrections') return _showProjectPick('corrections');
}

const _backBtn = `<button class="btn" type="button" data-qs="back">◀ Back</button>`;
function _wireBack() { _view().querySelector('[data-qs="back"]')?.addEventListener('click', _showHome); }

// ─── recent list (shared by Continue / Document / Corrections) ──────────────

async function _recentRows(onPick) {
  if (!_dlg) return;
  const list = cleanRecent(userSettings.get().quickStart?.recent);
  const host = _view().querySelector('#qs-recent');
  if (!host) return;
  if (!list.length) {
    host.innerHTML = '<div class="small muted" style="padding:6px 2px;">No recent projects yet — they appear here once you open or save one.</div>';
    return;
  }
  const exists = window.sbsNative?.fileExists ? (p) => window.sbsNative.fileExists(p) : null;
  const rows = await markMissing(list, exists);
  if (!_dlg || !host.isConnected) return;                     // closed / moved on while the disk was asked
  const cur = state.get('projectPath');
  host.innerHTML = rows.map((e, i) => `
    <div class="qs-row${e.missing ? ' missing' : ''}" data-i="${i}" ${e.missing ? '' : 'tabindex="0" role="button"'} title="${_esc(e.path)}">
      <span style="font-size:18px;">${e.missing ? '⚠' : '📁'}</span>
      <div class="qs-rmain">
        <div class="qs-rname">${_esc(e.name)}${samePath(e.path, cur) ? ' <span class="small muted">(open now)</span>' : ''}${e.missing ? ' <span class="small muted">— file not found</span>' : ''}</div>
        <div class="qs-rfolder">${_esc(e.folder)}</div>
      </div>
      <span class="qs-rwhen">${_esc(recentWhen(e.at))}</span>
      ${e.missing ? `<button class="btn" type="button" data-rm="${i}" title="Take it off the list" style="padding:2px 8px;font-size:11px;">✕ Remove</button>` : ''}
    </div>`).join('');
  host.querySelectorAll('.qs-row:not(.missing)').forEach(r => {
    const go = () => onPick(rows[Number(r.dataset.i)].path);
    r.addEventListener('click', go);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  host.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    await _forget(rows[Number(b.dataset.rm)].path).catch(() => {});
    _recentRows(onPick);
  }));
}

// ─── 📂 Continue a project ──────────────────────────────────────────────────

function _showContinue() {
  _head('📂 Continue a project', 'Pick a recent project, or open another one.');
  _view().innerHTML = `
    <div class="qs-list" id="qs-recent"><div class="small muted">Looking…</div></div>
    <div style="display:flex;gap:8px;margin-top:12px;">
      ${_backBtn}<span style="flex:1;"></span>
      <button class="btn" type="button" id="qs-browse" style="font-weight:600;">📂 Open another…</button>
    </div>`;
  _wireBack();
  _view().querySelector('#qs-browse').addEventListener('click', () => { closeQuickStart(); _open(null); });
  _recentRows((path) => {
    if (samePath(path, state.get('projectPath'))) { closeQuickStart(); setStatus('That project is already open.', 'info', 4000); return; }
    closeQuickStart(); _open(path);
  });
}

async function _open(path) {
  const sl = await import('./sidebar-left.js');
  return sl.openProjectFlow(path);
}

// ─── ✨ New project ─────────────────────────────────────────────────────────

function _showNew() {
  _head('✨ New project', 'A few choices, then the project is ready to work on.');
  const canBrand = !!window.sbsNative?.openFile;
  _view().innerHTML = `
    ${canBrand ? `
      <div class="qs-h">Brand</div>
      <label class="qs-opt"><input type="checkbox" id="qs-brand" />
        <span>Load a brand (.sbsbrand) — your company's header, logo, text styles and positions</span></label>` : ''}
    <div class="qs-h">Start from</div>
    <label class="qs-opt"><input type="radio" name="qs-from" value="empty" checked /><span><b>An empty project</b> — add models and steps yourself</span></label>
    <label class="qs-opt"><input type="radio" name="qs-from" value="excel" /><span><b>Steps from an Excel sheet</b> — one step per row: names, voice-over, titles</span></label>
    <label class="qs-opt"><input type="radio" name="qs-from" value="project" /><span><b>Steps from another project</b> — copy the steps you choose, with what they show</span></label>
    <div style="display:flex;gap:8px;margin-top:14px;">
      ${_backBtn}<span style="flex:1;"></span>
      <button class="btn" type="button" id="qs-create" style="font-weight:600;">✨ Create project</button>
    </div>`;
  _wireBack();
  _view().querySelector('#qs-create').addEventListener('click', () => {
    const brand = !!_view().querySelector('#qs-brand')?.checked;
    const from = _view().querySelector('input[name="qs-from"]:checked')?.value || 'empty';
    closeQuickStart();
    _runNew(brand, from).catch(err => { console.error('[quick start] new project:', err); setStatus(`New project: ${err?.message || err}`, 'danger', 8000); });
  });
}

async function _runNew(brand, from) {
  const sl = await import('./sidebar-left.js');
  if (!sl.newProjectFlow()) return;                           // refused (Poly Editor open) or unsaved work kept
  if (brand) {
    const b = await import('../systems/brand.js');
    if (!(await b.loadBrand())) return;                       // picker / question cancelled: stop here, the project stays new and empty
  }
  if (from === 'excel') {
    const m = await import('./sheet-import-dialog.js');
    await m.openSheetImport();
  } else if (from === 'project') {
    const m = await import('./steps-panel.js');
    await m.importStepsFromProject();
  }
}

// ─── ⬚ Design an object ─────────────────────────────────────────────────────

function _runDesign() {
  closeQuickStart();
  // V0.3.5.18's empty start (Primitives tab ▸ "New asset in the Poly Editor…"): it asks the object's name itself
  import('../systems/poly-session.js')
    .then(m => m.startPolySession([], { empty: true }))
    .catch(err => { console.warn('[quick start] poly editor:', err); setStatus(`The Poly Editor did not open: ${err?.message || err}`, 'danger', 8000); });
}

// ─── 📄 Make a document · 📊 Apply the client's corrections ─────────────────

function _hasOpenProject(needsFile) {
  if (state.get('projectPath')) return true;
  return !needsFile && !!(state.get('treeData') || (state.get('assets') || []).length);
}

function _showProjectPick(job) {
  const isDoc = job === 'document';
  _head(isDoc ? '📄 Make a document' : "📊 Apply the client's corrections",
    isDoc ? 'Which project is the document for?' : 'Which project are the corrections for? Next you pick the sheet the client sent back.');
  const curOk = _hasOpenProject(!isDoc);                      // the review sheet is matched against a SAVED project
  const curName = state.get('projectName') || 'Untitled';
  _view().innerHTML = `
    ${curOk ? `
      <div class="qs-list" style="margin-bottom:10px;">
        <div class="qs-row" id="qs-current" tabindex="0" role="button">
          <span style="font-size:18px;">⭐</span>
          <div class="qs-rmain"><div class="qs-rname">The project open now — ${_esc(curName)}</div></div>
        </div>
      </div>` : ''}
    <div class="small muted" style="margin:2px 0 6px;">Recent projects</div>
    <div class="qs-list" id="qs-recent"><div class="small muted">Looking…</div></div>
    <div style="display:flex;gap:8px;margin-top:12px;">
      ${_backBtn}<span style="flex:1;"></span>
      <button class="btn" type="button" id="qs-browse" style="font-weight:600;">📂 Another project…</button>
    </div>`;
  _wireBack();
  const run = (pick) => {
    closeQuickStart();
    (isDoc ? _runDocument(pick) : _runCorrections(pick))
      .catch(err => { console.error(`[quick start] ${job}:`, err); setStatus(`${isDoc ? 'Document' : 'Corrections'}: ${err?.message || err}`, 'danger', 8000); });
  };
  const cur = _view().querySelector('#qs-current');
  if (cur) {
    cur.addEventListener('click', () => run({ current: true }));
    cur.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run({ current: true }); } });
  }
  _view().querySelector('#qs-browse').addEventListener('click', () => run({ browse: true }));
  _recentRows((path) => run(samePath(path, state.get('projectPath')) ? { current: true } : { path }));
}

async function _runDocument(pick) {
  if (!pick.current && !(await _open(pick.path || null))) return;
  const m = await import('./document-workspace.js');
  m.openDocumentWorkspace();
}

async function _runCorrections(pick) {
  const nat = window.sbsNative;
  let path = pick.path || null;
  // "Another project…": only its PATH now (Electron) — the sheet is asked before anything is opened
  if (pick.browse && nat?.openProject) {
    path = await nat.openProject();
    if (!path) return;
    if (samePath(path, state.get('projectPath'))) { pick = { current: true }; path = null; }
  }
  let sheet = null;
  if (nat?.openFile) {
    sheet = await nat.openFile({ title: 'The review sheet the client sent back (.xlsx / .ods)', filters: [{ name: 'Spreadsheet (Excel .xlsx, OpenDocument .ods)', extensions: ['xlsx', 'ods'] }] });
    if (!sheet) return;
  }
  if (!pick.current && !(await _open(path))) return;          // web build "Another project…": the usual picker
  const m = await import('./review-form-panel.js');
  await m.openReviewFormPanel(sheet ? { importPath: sheet } : {});
}
