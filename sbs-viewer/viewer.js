/* SBS Viewer
 * ================
 * Loads a .sbsproc file (12-byte header + UTF-8 JSON manifest + MP4
 * payload) and plays it with step-aware navigation.
 *
 * File format (must match the writer in sbs-app/src/systems/video-export.js):
 *
 *   [8 bytes]  ASCII magic   "SBSPROC1"
 *   [4 bytes]  uint32 LE     manifest_len
 *   [N bytes]  UTF-8 JSON    manifest
 *   [rest]     raw bytes     MP4 stream
 *
 * Navigation rules (mirror the editor's group-aware playback):
 *
 *   - The step list shows TOP-LEVEL viewer-steps. Group heads carry
 *     a chevron; clicking the chevron expands the head's sub_steps.
 *   - Click a step row → seek to its time_in_ms, play, auto-pause at
 *     time_out_ms of the containing viewer-step.
 *   - Click a sub-step row → seek to its time_in_ms; pause window is
 *     still the parent group's time_out_ms (groups play head→subs as
 *     ONE viewer-step, per the editor's auto-chain rule).
 *   - Prev/Next + ← / → arrows step between TOP-LEVEL viewer-steps.
 *
 * The viewer never modifies the .sbsproc file — read-only player.
 */

// ── Format constants ────────────────────────────────────────────────
const SBS_MAGIC      = 'SBSPROC1';
const SBS_HEADER_LEN = 12;          // 8 magic + 4 length

// ── State (kept on a single object so debugging in DevTools is easy) ─
const app = {
  manifest:     null,
  videoBlobUrl: null,
  /** @type {{ id, title, time_in_ms, time_out_ms, sub_steps?, _isSub?, _parentId? }[]} */
  flatSteps:    [],     // every viewer-step (heads + subs) flattened, for keyboard / scrubbing math
  topLevelIds:  [],     // ids of just the TOP-LEVEL viewer-steps (the prev/next nav set)
  activeId:     null,   // currently-active viewer-step (head or sub)
  expandedIds:  new Set(),  // group-head ids the user has manually expanded
  pendingPause: null,   // { atSec: number } — pause the video when currentTime reaches this
  // Assembly mode — when the viewer was opened with `?asm=<url>`, we
  // hold the parsed manifest + the source URL (so per-process URLs in
  // the manifest can be resolved against it). When set, the player's
  // X / Esc returns to the assembly grid instead of the file picker.
  assembly:     null,   // { title, description?, processes: [{title, url, thumb?, description?}] }
  assemblyUrl:  null,   // base URL of the .sbsasm — used to resolve relative process URLs
};

// ── DOM refs ────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  landing:       null, assembly: null, builder: null, player: null,
  filePicker:    null, dropZone: null, landingError: null,
  loading:       null, loadingMsg: null,
  btnCreateAssembly: null, asmExit: null, bldExit: null,
  asmTitle:      null, asmMeta: null, asmDescription: null, asmGrid: null, asmError: null,
  bldTitle:      null, bldDescription: null, bldRows: null, bldStatus: null,
  bldDrop:       null, bldDropInput: null,
  bldDownload:   null, bldLoad: null,
  projectTitle:  null, stepCounter: null, btnClose: null,
  videoWrap:     null, video: null,
  stepProgress:  null, stepProgressFill: null,
  stepList:      null,
  btnPrev:       null, btnPlay: null, btnNext: null,
  btnMute:       null, volSlider: null,
  btnFullscreen: null,
  timeReadout:   null,
};
// Pre-mute volume — restored when the user unmutes. Defaults to 1.0
// (full volume) so the very first unmute lands on max.
let _preMuteVolume = 1.0;

document.addEventListener('DOMContentLoaded', async () => {
  els.landing          = $('landing');
  els.assembly         = $('assembly');
  els.player           = $('player');
  els.filePicker       = $('file-picker');
  els.dropZone         = $('drop-zone');
  els.landingError     = $('landing-error');
  els.loading          = $('loading');
  els.loadingMsg       = $('loading-msg');
  els.asmTitle         = $('assembly-title');
  els.asmMeta          = $('assembly-meta');
  els.asmDescription   = $('assembly-description');
  els.asmGrid          = $('assembly-grid');
  els.asmError         = $('assembly-error');
  els.builder          = $('builder');
  els.bldTitle         = $('builder-title');
  els.bldDescription   = $('builder-description');
  els.bldRows          = $('builder-rows');
  els.bldStatus        = $('builder-status');
  els.bldDrop          = $('builder-drop');
  els.bldDropInput     = $('builder-add-process-input');
  els.bldDownload      = $('builder-download');
  els.bldLoad          = $('builder-load');
  els.btnCreateAssembly = $('btn-create-assembly');
  els.asmExit          = $('assembly-exit');
  els.bldExit          = $('builder-exit');
  // Settings popover (Electron-only feature — see _wireSettings)
  els.btnSettings      = $('btn-settings');
  els.settingsPopover  = $('settings-popover');
  els.settingsClose    = $('settings-close');
  els.modeStation      = $('mode-station');
  els.modeManager      = $('mode-manager');
  els.settingsModeNote = $('settings-mode-note');
  els.projectTitle     = $('project-title');
  els.stepCounter      = $('step-counter');
  els.btnClose         = $('btn-close');
  els.videoWrap        = $('video-wrap');
  els.video            = $('video');
  els.stepProgress     = $('step-progress');
  els.stepProgressFill = $('step-progress-fill');
  els.stepList         = $('step-list');
  els.btnPrev          = $('btn-prev');
  els.btnPlay          = $('btn-play');
  els.btnNext          = $('btn-next');
  els.btnMute          = $('btn-mute');
  els.volSlider        = $('vol-slider');
  els.btnFullscreen    = $('btn-fullscreen');
  els.timeReadout      = $('time-readout');

  _wireLanding();
  _wirePlayer();
  _wireKeyboard();
  _wireVolume();
  _wireFullscreen();
  _wireBuilder();

  // ── Station / Manager mode gate ──────────────────────────────────────
  // Resolve effective mode BEFORE wiring URL routes so we can block
  // builder-only entry points in station installs. License-gate.js has
  // already enforced the activation state by the time we get here.
  // Web mode (no Electron IPC) → assume manager (no restriction); the
  // file server is the gate there.
  let allowBuilder = true;
  if (window.sbsViewer?.license?.status) {
    try {
      const status = await window.sbsViewer.license.status();
      // Manager features require BOTH: the install opted into manager mode
      // AND the active license authorises it. License-gate ensures
      // `state === 'valid' || 'grace'` by the time this runs.
      allowBuilder = (status?.effectiveMode === 'manager');
    } catch (err) {
      console.warn('[viewer] could not resolve install mode:', err);
      allowBuilder = false;   // fail safe to station
    }
  }
  if (!allowBuilder && els.btnCreateAssembly) {
    els.btnCreateAssembly.hidden = true;
  }

  // Settings UI is Electron-only (relies on window.sbsViewer.license.*).
  // In web mode the button stays hidden, and mode is always 'manager' since
  // no IPC means no install-mode persistence.
  if (window.sbsViewer?.license?.installMode) {
    els.btnSettings.hidden = false;
    _wireSettings();
  }

  // URL routing — four entry points:
  //   ?mode=build → admin builder: form to create / edit .sbsasm files.
  //                 BLOCKED for station installs — falls through to landing.
  //   ?asm=<url>  → assembly mode: fetch JSON, show landing grid, click
  //                 a card to load that .sbsproc, X returns to grid.
  //   ?proc=<url> → direct process: fetch + play one .sbsproc.
  //   neither    → file-picker landing.
  const params = new URLSearchParams(window.location.search);
  const mode    = params.get('mode');
  const asmUrl  = params.get('asm');
  const procUrl = params.get('proc');
  if      (mode === 'build' && allowBuilder) _showBuilder();
  else if (asmUrl)                           _loadAssemblyFromUrl(asmUrl);
  else if (procUrl)                          _loadFromUrl(procUrl);
});

// ── Landing wiring ──────────────────────────────────────────────────

function _wireLanding() {
  // File picker.
  els.filePicker.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) _loadFromFile(file);
  });

  // Drag-and-drop.
  const dz = els.dropZone;
  ['dragenter', 'dragover'].forEach(ev => {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); });
  });
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) _loadFromFile(file);
  });

  // "Create new assembly" → builder. No URL change, just swap screens.
  els.btnCreateAssembly.addEventListener('click', _showBuilder);

  // Exit buttons on assembly + builder screens both return to landing.
  // _showLanding resets all transient state (assembly manifest, video
  // blob, etc.) so the user starts fresh.
  els.asmExit.addEventListener('click', _showLanding);
  els.bldExit.addEventListener('click', _showLanding);
}

/**
 * Show exactly one screen — hide every other. Centralising the swap
 * here means every transition cleanly hides the previous screen. Past
 * code toggled screens individually and missed sibling-hide ops, which
 * left two screens visible at once (the assembly grid lingering
 * behind the player was the user-reported symptom).
 */
function _showScreen(name) {
  const map = {
    landing:  els.landing,
    assembly: els.assembly,
    builder:  els.builder,
    player:   els.player,
  };
  for (const [key, el] of Object.entries(map)) {
    if (!el) continue;
    el.hidden = key !== name;
  }
}

/**
 * Reset all screens / state and show the landing page. Used by:
 *   - Assembly Exit button   (after the user is done with an assembly)
 *   - Builder Exit button    (after they save / cancel a build)
 *   - Player close in non-assembly mode (existing _resetToLanding path)
 *
 * Anything still in flight (player blob URL, assembly manifest, builder
 * form) gets cleared so re-entering a screen lands on a clean start.
 */
function _showLanding() {
  // Tear down player if it's running.
  _stopPlaybackTick();
  if (app.videoBlobUrl) {
    URL.revokeObjectURL(app.videoBlobUrl);
    app.videoBlobUrl = null;
  }
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
  app.manifest    = null;
  app.flatSteps   = [];
  app.topLevelIds = [];
  app.activeId    = null;
  app.expandedIds.clear();
  app.pendingPause = null;
  if (els.stepProgressFill) els.stepProgressFill.style.width = '0%';
  // Drop assembly so the next .sbsasm load starts clean.
  app.assembly    = null;
  app.assemblyUrl = null;

  _showScreen('landing');
  els.landingError.hidden = true;
  els.filePicker.value = '';
  _hideLoading();
}

function _showLandingError(msg) {
  els.landingError.textContent = msg;
  els.landingError.hidden = false;
}

async function _loadFromFile(file) {
  els.landingError.hidden = true;
  _showLoading(`Reading ${_humanSize(file.size)}…`);
  try {
    // Dispatch by extension first (cheap), fall back to magic-byte sniff
    // for unhinted drops. Both .sbsasm (JSON) and .sbsproc (binary)
    // share the landing picker so the worker doesn't have to know
    // which file type they were sent.
    const name = file.name.toLowerCase();
    if (name.endsWith('.sbsasm')) {
      const text = await file.text();
      _bootAssemblyFromJson(text, name);
      return;
    }
    if (name.endsWith('.sbsproc')) {
      const buf = await file.arrayBuffer();
      _bootPlayer(buf);
      return;
    }
    // Unknown extension — peek the first 8 bytes for the .sbsproc magic.
    const buf = await file.arrayBuffer();
    if (buf.byteLength >= 8) {
      const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
      if (magic === SBS_MAGIC) { _bootPlayer(buf); return; }
    }
    // Try parsing as JSON (.sbsasm without the .sbsasm extension).
    try {
      const text = new TextDecoder('utf-8').decode(buf);
      const json = JSON.parse(text);
      if (json?.format === 'sbsasm') { _bootAssemblyFromJson(text, name); return; }
    } catch { /* not JSON */ }
    throw new Error('File is neither a .sbsproc nor a .sbsasm.');
  } catch (err) {
    console.error('[viewer] load failed:', err);
    _showLandingError(`Could not open file: ${err.message}`);
  } finally {
    _hideLoading();
  }
}

/**
 * Parse a .sbsasm text payload and switch to assembly mode. Used by
 * both the URL path (?asm=) and the local file picker — when loaded
 * from a file, relative URLs in the manifest resolve against the
 * VIEWER's URL (which is the server folder serving viewer.html). For
 * the typical "drop .sbsasm next to .sbsproc files in one folder"
 * deploy that's exactly what we want.
 */
function _bootAssemblyFromJson(text, displayName = '') {
  const json = JSON.parse(text);
  if (json?.format !== 'sbsasm') {
    throw new Error(`Manifest format mismatch: ${json?.format ?? '<missing>'}`);
  }
  if (!Array.isArray(json.processes)) {
    throw new Error('Manifest missing `processes` array.');
  }
  app.assembly    = json;
  // No source URL — relative URLs in the manifest resolve against
  // window.location (i.e. wherever viewer.html itself was served from).
  // _launchProcess uses `app.assemblyUrl` as the base for new URL();
  // setting it to window.location.href makes "./foo.sbsproc" resolve to
  // "<server>/<viewer-folder>/foo.sbsproc".
  app.assemblyUrl = window.location.href;
  _showScreen('assembly');
  _renderAssembly();
}

async function _loadFromUrl(url) {
  els.landingError.hidden = true;
  els.asmError.hidden = true;
  _showLoading('Downloading .sbsproc…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    _bootPlayer(buf);
  } catch (err) {
    console.error('[viewer] fetch failed:', err);
    // Surface the error on whichever screen is visible — assembly grid
    // when launched from an .sbsasm, file-picker landing otherwise.
    if (app.assembly) _showAssemblyError(`Could not load process: ${err.message}`);
    else              _showLandingError(`Could not load .sbsproc: ${err.message}`);
  } finally {
    _hideLoading();
  }
}

function _showLoading(msg) {
  els.loadingMsg.textContent = msg;
  els.loading.hidden = false;
}
function _hideLoading() { els.loading.hidden = true; }

function _humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

// ── Assembly mode (.sbsasm) ─────────────────────────────────────────
//
// `.sbsasm` is a simple JSON manifest hosted on the closed server. It
// declares a list of `.sbsproc` URLs (workflow processes) the worker
// can run. The viewer fetches it via `?asm=<url>`, shows the landing
// grid, lets the worker click a card → loads that .sbsproc → on close
// returns here. Process URLs in the manifest can be relative — they
// resolve against the .sbsasm's own URL.

async function _loadAssemblyFromUrl(url) {
  els.asmError.hidden = true;
  _showScreen('assembly');
  // Show a transient state on the title so the user knows something's happening.
  els.asmTitle.textContent = 'Loading assembly…';
  els.asmMeta.textContent  = '';
  els.asmDescription.hidden = true;
  els.asmGrid.innerHTML = '';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json?.format !== 'sbsasm') {
      throw new Error(`Manifest format mismatch: ${json?.format ?? '<missing>'}`);
    }
    if (!Array.isArray(json.processes)) {
      throw new Error('Manifest missing `processes` array.');
    }
    app.assembly    = json;
    app.assemblyUrl = url;
    _renderAssembly();
  } catch (err) {
    console.error('[viewer] assembly fetch failed:', err);
    els.asmTitle.textContent = 'Assembly';
    _showAssemblyError(`Could not load assembly: ${err.message}`);
  }
}

function _renderAssembly() {
  const asm = app.assembly;
  if (!asm) return;
  els.asmTitle.textContent = asm.title || 'Assembly';
  els.asmMeta.textContent  = `${asm.processes.length} process${asm.processes.length === 1 ? '' : 'es'}`;
  if (asm.description) {
    els.asmDescription.textContent = asm.description;
    els.asmDescription.hidden = false;
  } else {
    els.asmDescription.hidden = true;
  }

  els.asmGrid.innerHTML = '';
  asm.processes.forEach((proc, idx) => {
    if (!proc?.url) return;   // skip malformed entry — no URL to load
    const card = document.createElement('div');
    card.className = 'proc-card';
    const thumbHtml = proc.thumb
      ? `<div class="proc-thumb"><img src="${_escAttr(proc.thumb)}" alt="" /></div>`
      : `<div class="proc-thumb">${idx + 1}</div>`;
    card.innerHTML = `
      ${thumbHtml}
      <div class="proc-body">
        <div class="proc-title">${_escapeHtml(proc.title || 'Untitled')}</div>
        ${proc.description
          ? `<div class="proc-description">${_escapeHtml(proc.description)}</div>`
          : ''}
      </div>
    `;
    card.addEventListener('click', () => _launchProcess(proc));
    els.asmGrid.appendChild(card);
  });
}

function _launchProcess(proc) {
  // Resolve relative URLs against the .sbsasm's own URL — lets the
  // manager publish self-contained assemblies (assembly + processes
  // alongside each other on the server) without writing absolute URLs.
  let target = proc.url;
  if (app.assemblyUrl) {
    try { target = new URL(proc.url, app.assemblyUrl).toString(); }
    catch { /* fall through with raw url */ }
  }
  // Same-tab load — viewer.js already handles tearing down a previous
  // process (revokeObjectURL etc.) inside _loadFromUrl → _bootPlayer.
  _loadFromUrl(target);
}

function _showAssemblyError(msg) {
  els.asmError.textContent = msg;
  els.asmError.hidden = false;
}


// ── Assembly Builder (admin mode, ?mode=build) ─────────────────────
//
// Form-driven editor that produces .sbsasm files. Manager-only — no
// runtime impact for workers. Loading an existing .sbsasm populates
// the form; "Download .sbsasm" serialises whatever is in the form to
// JSON and triggers a download via the same helper as the .sbsproc
// exporter. Process rows are reorderable via HTML5 drag-and-drop.

function _showBuilder() {
  _showScreen('builder');
  _bldRenumber();
}

// ── Settings popover (Electron only) ──────────────────────────────────
// Lets the user switch between Station and Manager install modes. Mode
// changes need a reload to take effect because the gate decision (hide
// "Create new assembly", block ?mode=build) runs at init time. The
// Manager radio is DISABLED when the active license is station-only —
// `verify.js` returns licenseMode='station' in that case, so we can't
// honour a manager request and there's no point letting them try.
function _wireSettings() {
  const open = async () => {
    let licenseMode = 'station';
    let installMode = 'station';
    try {
      const status = await window.sbsViewer.license.status();
      licenseMode = status?.licenseMode || 'station';
      installMode = status?.installMode || 'station';
    } catch {}

    // Radios reflect CURRENT install-mode setting; license authority
    // gates whether Manager is selectable.
    els.modeStation.checked  = (installMode === 'station');
    els.modeManager.checked  = (installMode === 'manager');
    els.modeManager.disabled = (licenseMode !== 'manager');

    els.settingsModeNote.textContent = (licenseMode === 'manager')
      ? 'Manager mode unlocks "Create new assembly". Switching mode reloads the viewer.'
      : 'Your license only authorises Station mode. Contact your distributor for a Manager license.';

    els.settingsPopover.hidden = false;
  };
  const close = () => { els.settingsPopover.hidden = true; };

  els.btnSettings.addEventListener('click', open);
  els.settingsClose.addEventListener('click', close);
  // Click outside the card → close.
  els.settingsPopover.addEventListener('click', e => {
    if (e.target === els.settingsPopover) close();
  });

  // Radio changes save immediately + reload (the gate runs at init).
  const onModeChange = async (e) => {
    if (!e.target.checked) return;
    const mode = e.target.value;
    try {
      await window.sbsViewer.license.setInstallMode(mode);
      // Tiny delay so the user sees the toggle land before the reload.
      setTimeout(() => location.reload(), 120);
    } catch (err) {
      console.error('[settings] could not save mode:', err);
    }
  };
  els.modeStation.addEventListener('change', onModeChange);
  els.modeManager.addEventListener('change', onModeChange);
}

function _wireBuilder() {
  // Click the drop zone OR drop files on it → file picker / drop handler.
  // The drop zone itself is a <label> wrapping the hidden file input,
  // so a click anywhere on the zone opens the system file picker.
  els.bldDropInput.addEventListener('change', e => {
    _bldAddFiles(e.target.files);
    e.target.value = '';   // allow re-picking the same file later
  });
  ['dragenter', 'dragover'].forEach(ev =>
    els.bldDrop.addEventListener(ev, e => { e.preventDefault(); els.bldDrop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev =>
    els.bldDrop.addEventListener(ev, e => { e.preventDefault(); els.bldDrop.classList.remove('dragover'); }));
  els.bldDrop.addEventListener('drop', e => {
    if (e.dataTransfer?.files?.length) _bldAddFiles(e.dataTransfer.files);
  });

  els.bldDownload.addEventListener('click', _bldDownload);
  els.bldLoad.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) _bldLoadFromFile(file);
    e.target.value = '';
  });
}

/**
 * Add one or more .sbsproc files to the assembly. Browsers don't expose
 * the picked file's path for security — we only get its name. We
 * therefore assume same-folder layout: the .sbsasm and every .sbsproc
 * live in the same server folder, so URLs are written as `./<name>`.
 * The manager uploads them as a bundle. Non-.sbsproc files are skipped.
 */
function _bldAddFiles(fileList) {
  const accepted = [...fileList].filter(f => /\.sbsproc$/i.test(f.name));
  const skipped  = fileList.length - accepted.length;
  for (const f of accepted) {
    const baseName  = f.name.replace(/\.sbsproc$/i, '');
    const niceTitle = baseName.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const row = _bldAddRow({
      title: niceTitle || baseName,
      url:   `./${f.name}`,
      _file: f.name,
    });
    // Async — extract a poster frame and stamp it on the row. The
    // manager keeps editing while thumbs land. Failure is silent;
    // the row just stays without a thumb (worker grid falls back to
    // the index badge).
    _extractThumbFromSbsproc(f).then(dataUrl => {
      if (!dataUrl) return;
      row.dataset.thumb = dataUrl;
      const slot = row.querySelector('.row-thumb');
      if (slot) slot.innerHTML = `<img src="${dataUrl}" alt="" />`;
    });
  }
  if (accepted.length) {
    _bldStatus(`Added ${accepted.length} process(es).${skipped ? ' (' + skipped + ' non-.sbsproc skipped)' : ''}`);
  } else if (skipped) {
    _bldStatus('Only .sbsproc files are accepted.', true);
  }
}

/**
 * Extract a single poster frame from a .sbsproc as a small JPEG data
 * URL. Used by the builder to populate `entry.thumb` in the resulting
 * .sbsasm so the worker assembly grid has visuals. Hidden <video>
 * element + canvas — no editor / extension dependencies. Bails after
 * 8 s in case the source MP4 seek hangs.
 */
async function _extractThumbFromSbsproc(file) {
  const buf = await file.arrayBuffer();
  let videoBlob;
  try {
    const parsed = _parseSbsProc(buf);
    videoBlob = parsed.videoBlob;
  } catch {
    return null;             // not a valid .sbsproc — nothing to grab
  }
  return new Promise((resolve) => {
    const url   = URL.createObjectURL(videoBlob);
    const video = document.createElement('video');
    video.muted       = true;
    video.playsInline = true;
    video.preload     = 'auto';
    video.src         = url;

    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(out);
    };
    video.addEventListener('loadeddata', () => {
      // Seek a hair into the timeline so we don't grab a black warmup
      // frame. 1 s, or 25 % into a short clip — whichever is smaller.
      const seekTo = Math.min(1.0, (video.duration || 4) * 0.25);
      video.currentTime = Math.max(0, seekTo);
    });
    video.addEventListener('seeked', () => {
      try {
        const srcW = video.videoWidth  || 320;
        const srcH = video.videoHeight || 180;
        const W = 240;                  // small enough to keep .sbsasm lean
        const H = Math.max(1, Math.round(W * srcH / srcW));
        const canvas = document.createElement('canvas');
        canvas.width  = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, W, H);
        // 0.5 quality → ~6–12 KB per thumb in base64 → ~200 KB for a
        // 20-process assembly. Acceptable JSON overhead.
        finish(canvas.toDataURL('image/jpeg', 0.5));
      } catch {
        finish(null);
      }
    });
    video.addEventListener('error', () => finish(null));
    setTimeout(() => finish(null), 8000);
  });
}

/**
 * Append a row. `seed` carries `{ title, url, description?, thumb?, _file? }`.
 * `_file` is the display-only filename (shown on the row); it isn't
 * serialised. When loading an existing .sbsasm, we derive `_file` from
 * the URL so reloaded rows look identical to freshly-added ones.
 */
function _bldAddRow(seed = null) {
  const row = document.createElement('div');
  row.className = 'builder-row';
  row.draggable = true;
  const fileLabel = seed?._file
    || (seed?.url ? seed.url.split('/').pop() : '')
    || '';
  // Stash the URL on the row's dataset — it's not editable in this
  // simplified UI but we still need it on download. Same for optional
  // description / thumb (edit them by re-loading the .sbsasm and
  // hand-editing for now; v1 keeps the row UI minimal).
  row.dataset.url         = seed?.url         || '';
  row.dataset.description = seed?.description || '';
  row.dataset.thumb       = seed?.thumb       || '';
  // Thumb slot — populated either from the seed (when loading an
  // existing .sbsasm) or asynchronously from the dropped .sbsproc's
  // first frame (see _extractThumbFromSbsproc). Falls back to a
  // page-icon glyph until/unless an image is available.
  const thumbInner = seed?.thumb
    ? `<img src="${_escAttr(seed.thumb)}" alt="" />`
    : '📄';
  row.innerHTML = `
    <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
    <span class="row-num"></span>
    <span class="row-thumb">${thumbInner}</span>
    <input class="row-title" type="text" value="${_escAttr(seed?.title || '')}" placeholder="Process title" />
    <span class="row-file" title="${_escAttr(fileLabel)}">${_escapeHtml(fileLabel)}</span>
    <button class="row-delete" type="button" title="Remove process">✕</button>
  `;
  // Delete.
  row.querySelector('.row-delete').addEventListener('click', () => {
    row.remove();
    _bldRenumber();
    _bldStatus(`${els.bldRows.children.length} process(es).`);
  });
  // HTML5 drag-reorder. Same pattern as before: dragstart marks the
  // row, dragover on siblings shifts it, dragend cleans up. Inputs
  // suppress drag so text selection still works.
  row.addEventListener('dragstart', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      e.preventDefault();
      return;
    }
    _bldDragging = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    if (_bldDragging) _bldDragging.classList.remove('dragging');
    _bldDragging = null;
    [...els.bldRows.children].forEach(r => r.classList.remove('drag-over'));
    _bldRenumber();
  });
  row.addEventListener('dragover', e => {
    if (!_bldDragging || _bldDragging === row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect  = row.getBoundingClientRect();
    const above = (e.clientY - rect.top) < rect.height / 2;
    if (above) els.bldRows.insertBefore(_bldDragging, row);
    else       els.bldRows.insertBefore(_bldDragging, row.nextSibling);
    _bldRenumber();
  });

  els.bldRows.appendChild(row);
  _bldRenumber();
  return row;
}
let _bldDragging = null;

/** Refresh the 1-based numeric badges shown on each row after add/delete/reorder. */
function _bldRenumber() {
  [...els.bldRows.children].forEach((row, i) => {
    const badge = row.querySelector('.row-num');
    if (badge) badge.textContent = String(i + 1).padStart(2, '0');
  });
}

/** Build a .sbsasm JSON object from current form state. */
function _bldHarvest() {
  const processes = [];
  for (const row of els.bldRows.children) {
    const title = row.querySelector('.row-title')?.value.trim() || 'Untitled';
    const url   = row.dataset.url || '';
    if (!url) continue;
    const entry = { title, url };
    if (row.dataset.description) entry.description = row.dataset.description;
    if (row.dataset.thumb)       entry.thumb       = row.dataset.thumb;
    processes.push(entry);
  }
  const manifest = {
    format:   'sbsasm',
    version:  1,
    title:    els.bldTitle.value.trim() || 'Untitled Assembly',
    processes,
  };
  const description = els.bldDescription.value.trim();
  if (description) manifest.description = description;
  return manifest;
}

/** Serialise + download the current form state as a .sbsasm file. */
function _bldDownload() {
  const manifest = _bldHarvest();
  if (!manifest.processes.length) {
    _bldStatus('Add at least one process row with a URL before downloading.', true);
    return;
  }
  const json  = JSON.stringify(manifest, null, 2);
  const blob  = new Blob([json], { type: 'application/json' });
  const slug  = (manifest.title || 'assembly').toLowerCase()
    .replace(/[^\w\d-]+/g, '-').replace(/^-+|-+$/g, '') || 'assembly';
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;
  a.download  = `${slug}.sbsasm`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
  _bldStatus(`Downloaded ${a.download} (${manifest.processes.length} process(es)).`);
}

/** Read an existing .sbsasm file from disk and populate the form. */
async function _bldLoadFromFile(file) {
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (json?.format !== 'sbsasm') {
      throw new Error(`Not a .sbsasm file (format=${json?.format ?? '<missing>'}).`);
    }
    if (!Array.isArray(json.processes)) {
      throw new Error('Manifest missing `processes` array.');
    }
    els.bldTitle.value       = json.title       || '';
    els.bldDescription.value = json.description || '';
    els.bldRows.innerHTML    = '';
    for (const p of json.processes) _bldAddRow(p);
    if (!json.processes.length) _bldAddRow();   // always show one empty row
    _bldStatus(`Loaded ${file.name} (${json.processes.length} process(es)).`);
  } catch (err) {
    console.error('[builder] load failed:', err);
    _bldStatus(`Could not load: ${err.message}`, true);
  }
}

function _bldStatus(msg, isError = false) {
  els.bldStatus.textContent = msg;
  els.bldStatus.style.color = isError ? '#fca5a5' : '';
}

function _escAttr(s) {
  // Keep it simple — for img src strings we only need to escape quotes
  // and angle brackets. Same as _escapeHtml is fine.
  return _escapeHtml(s);
}

// ── Boot the player from a parsed .sbsproc buffer ───────────────────

function _bootPlayer(buf) {
  const { manifest, videoBlob } = _parseSbsProc(buf);

  // Release any previously held Blob URL (re-entrant load).
  if (app.videoBlobUrl) URL.revokeObjectURL(app.videoBlobUrl);

  app.manifest     = manifest;
  app.videoBlobUrl = URL.createObjectURL(videoBlob);
  app.flatSteps    = _flattenManifestSteps(manifest);
  app.topLevelIds  = (manifest.steps || []).map(s => s.id);
  app.activeId     = app.topLevelIds[0] || null;
  app.expandedIds  = new Set();

  els.projectTitle.textContent = manifest.title || 'Untitled Process';
  els.video.src = app.videoBlobUrl;

  _showScreen('player');

  _renderStepList();
  _refreshTransport();
  _refreshMuteIcon();
  _refreshFullscreenIcon();
  _seekToActive(/*play=*/ true);
}

/**
 * Parse the .sbsproc binary into { manifest, videoBlob }. Throws on
 * any structural problem (bad magic, truncated header, malformed JSON).
 */
function _parseSbsProc(arrayBuffer) {
  if (arrayBuffer.byteLength < SBS_HEADER_LEN) {
    throw new Error('File is too small to be a .sbsproc.');
  }
  const dv = new DataView(arrayBuffer);
  const magicBytes = new Uint8Array(arrayBuffer, 0, 8);
  const magic = new TextDecoder('utf-8', { fatal: true }).decode(magicBytes);
  if (magic !== SBS_MAGIC) {
    throw new Error(`Bad magic: expected "${SBS_MAGIC}", got "${magic}".`);
  }
  const manifestLen = dv.getUint32(8, true);
  if (manifestLen <= 0 || SBS_HEADER_LEN + manifestLen > arrayBuffer.byteLength) {
    throw new Error('Manifest length out of range — file is truncated or corrupt.');
  }
  const manifestBytes = new Uint8Array(arrayBuffer, SBS_HEADER_LEN, manifestLen);
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch (e) {
    throw new Error(`Manifest JSON parse failed: ${e.message}`);
  }
  if (manifest?.format !== 'sbsproc') {
    throw new Error(`Manifest format mismatch: ${manifest?.format ?? '<missing>'}`);
  }
  const mp4Bytes = arrayBuffer.slice(SBS_HEADER_LEN + manifestLen);
  const videoBlob = new Blob([mp4Bytes], { type: 'video/mp4' });
  return { manifest, videoBlob };
}

/**
 * Flatten manifest.steps into a single list with both heads and sub-
 * steps. Each entry knows its parent group (if any). Used for fast id
 * lookup and for keyboard nav within a group's sub-step list.
 */
function _flattenManifestSteps(manifest) {
  const out = [];
  for (const s of (manifest.steps || [])) {
    out.push({ ...s, _isSub: false, _parentId: null });
    for (const sub of (s.sub_steps || [])) {
      out.push({ ...sub, _isSub: true, _parentId: s.id });
    }
  }
  return out;
}

/** Locate an entry in flatSteps by id. */
function _findStep(id) { return app.flatSteps.find(s => s.id === id) || null; }

/** Resolve a step id to the TOP-LEVEL viewer-step that contains it. */
function _topLevelOf(id) {
  const s = _findStep(id);
  if (!s) return null;
  return s._isSub ? _findStep(s._parentId) : s;
}

// ── Player wiring ───────────────────────────────────────────────────

function _wirePlayer() {
  els.btnClose.addEventListener('click', _resetToLanding);
  els.btnPrev .addEventListener('click', () => _gotoSibling(-1));
  els.btnNext .addEventListener('click', () => _gotoSibling(+1));
  els.btnPlay .addEventListener('click', _togglePlay);

  // timeupdate drives the readout + step-progress bar — fires at
  // ~250 ms intervals which is fine for those visuals. The auto-pause
  // boundary check runs on rAF (~16 ms) instead because the 250 ms
  // latency made the playhead overshoot the step end into next-step
  // frames before we could pause. See _onPlaybackTick / _stopPlaybackTick.
  els.video.addEventListener('timeupdate', _onTimeUpdate);
  els.video.addEventListener('ended',      _onEnded);
  els.video.addEventListener('play',       () => { _refreshPlayLabel(); _startPlaybackTick(); });
  els.video.addEventListener('pause',      () => { _refreshPlayLabel(); _stopPlaybackTick(); });
}

// ── Playback rAF tick for tight auto-pause boundary detection ──────────────
let _playbackRaf = 0;

function _startPlaybackTick() {
  if (_playbackRaf) return;
  const tick = () => {
    _playbackRaf = 0;
    if (els.video.paused || els.video.ended) return;
    _checkAutoPause();
    _playbackRaf = requestAnimationFrame(tick);
  };
  _playbackRaf = requestAnimationFrame(tick);
}

function _stopPlaybackTick() {
  if (_playbackRaf) {
    cancelAnimationFrame(_playbackRaf);
    _playbackRaf = 0;
  }
}

function _checkAutoPause() {
  if (!app.pendingPause) return;
  const t = els.video.currentTime;
  const PAUSE_BACKOFF_SEC = 0.05;
  // Trigger when within back-off of the boundary. rAF runs ~16 ms apart
  // so the worst-case overshoot is one video frame; the snap parks the
  // playhead 50 ms before the boundary (well inside this step's last
  // hold) so no visible flicker into the next step.
  if (t >= app.pendingPause.atSec - PAUSE_BACKOFF_SEC) {
    els.video.pause();
    els.video.currentTime = Math.max(0, app.pendingPause.atSec - PAUSE_BACKOFF_SEC);
    app.pendingPause = null;
  }
}

function _resetToLanding() {
  _stopPlaybackTick();
  if (app.videoBlobUrl) {
    URL.revokeObjectURL(app.videoBlobUrl);
    app.videoBlobUrl = null;
  }
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
  app.manifest    = null;
  app.flatSteps   = [];
  app.topLevelIds = [];
  app.activeId    = null;
  app.expandedIds.clear();
  app.pendingPause = null;
  if (els.stepProgressFill) els.stepProgressFill.style.width = '0%';
  // If we were launched from an assembly, X/close returns to that
  // grid (workers operate inside an assembly all day; dumping them at
  // a file picker would be confusing). Direct-process / drop-file
  // launches go back to the landing.
  if (app.assembly) {
    _showScreen('assembly');
  } else {
    _showScreen('landing');
    els.landingError.hidden = true;
    els.filePicker.value = '';
  }
  _hideLoading();
}

// ── Keyboard ────────────────────────────────────────────────────────

function _wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (els.player.hidden) return;
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); _gotoSibling(+1); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); _gotoSibling(-1); return; }
    if (e.key === ' ')          { e.preventDefault(); _togglePlay();    return; }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); _toggleMute();       return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); _toggleFullscreen(); return; }
  });
}

// ── Volume / mute ───────────────────────────────────────────────────

function _wireVolume() {
  els.volSlider.addEventListener('input', () => {
    const v = Math.max(0, Math.min(1, Number(els.volSlider.value) / 100));
    els.video.volume = v;
    els.video.muted  = v === 0;
    if (v > 0) _preMuteVolume = v;
    _refreshMuteIcon();
  });
  els.btnMute.addEventListener('click', _toggleMute);
  // Reflect external volume / muted changes (e.g. system media keys).
  els.video.addEventListener('volumechange', () => {
    if (!els.video.muted) {
      els.volSlider.value = String(Math.round(els.video.volume * 100));
      if (els.video.volume > 0) _preMuteVolume = els.video.volume;
    } else {
      els.volSlider.value = '0';
    }
    _refreshMuteIcon();
  });
}

function _toggleMute() {
  if (els.video.muted || els.video.volume === 0) {
    // Unmute → restore previous level (or 1.0 if we never had one).
    els.video.muted = false;
    els.video.volume = _preMuteVolume > 0 ? _preMuteVolume : 1.0;
    els.volSlider.value = String(Math.round(els.video.volume * 100));
  } else {
    _preMuteVolume = els.video.volume;
    els.video.muted = true;
    els.volSlider.value = '0';
  }
  _refreshMuteIcon();
}

function _refreshMuteIcon() {
  const muted = els.video.muted || els.video.volume === 0;
  els.btnMute.textContent = muted ? '🔇' : '🔊';
  els.btnMute.title       = muted ? 'Unmute (M)' : 'Mute (M)';
}

// ── Fullscreen ──────────────────────────────────────────────────────

function _wireFullscreen() {
  els.btnFullscreen.addEventListener('click', _toggleFullscreen);
  // Sync icon state on cross-API fullscreen change events.
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(ev, _refreshFullscreenIcon);
  }
}

function _toggleFullscreen() {
  const target = els.videoWrap;
  const docFs  = document.fullscreenElement || document.webkitFullscreenElement;
  if (!docFs) {
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    req?.call(target).catch(err => console.warn('[viewer] fullscreen denied:', err?.message));
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    exit?.call(document).catch(() => {});
  }
}

function _refreshFullscreenIcon() {
  const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  els.btnFullscreen.textContent = inFs ? '⤡' : '⛶';
  els.btnFullscreen.title       = inFs ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
}

// ── Step list rendering ─────────────────────────────────────────────

function _renderStepList() {
  els.stepList.innerHTML = '';
  const steps = app.manifest?.steps || [];
  steps.forEach((s, i) => {
    const isHead    = Array.isArray(s.sub_steps) && s.sub_steps.length > 0;
    const expanded  = app.expandedIds.has(s.id);
    const activeTop = _topLevelOf(app.activeId)?.id === s.id && !_findStep(app.activeId)?._isSub;
    const row = document.createElement('div');
    row.className = 'step-row' + (isHead ? ' is-group' : '') + (activeTop ? ' active' : '');
    row.dataset.stepId = s.id;
    row.innerHTML = `
      <span class="step-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="step-title">${_escapeHtml(s.title || 'Step')}</span>
      <span class="step-time">${_formatRange(s.time_in_ms, s.time_out_ms)}</span>
      ${isHead ? `<span class="step-chevron">${expanded ? '▾' : '▸'}</span>` : ''}
    `;
    row.addEventListener('click', (e) => {
      // Click on the chevron toggles expansion only — doesn't seek.
      if (isHead && e.target.classList.contains('step-chevron')) {
        if (expanded) app.expandedIds.delete(s.id);
        else          app.expandedIds.add(s.id);
        _renderStepList();
        return;
      }
      _activateStepById(s.id);
    });
    els.stepList.appendChild(row);

    if (isHead && expanded) {
      const subWrap = document.createElement('div');
      subWrap.className = 'sub-list';
      for (const sub of s.sub_steps) {
        const subRow = document.createElement('div');
        const isActiveSub = app.activeId === sub.id;
        subRow.className = 'sub-row' + (isActiveSub ? ' active' : '');
        subRow.dataset.stepId = sub.id;
        subRow.innerHTML = `
          <span class="step-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="step-title">${_escapeHtml(sub.title || 'Sub-step')}</span>
          <span class="step-time">${_formatRange(sub.time_in_ms, sub.time_out_ms)}</span>
        `;
        subRow.addEventListener('click', () => _activateStepById(sub.id));
        subWrap.appendChild(subRow);
      }
      els.stepList.appendChild(subWrap);
    }
  });
}

// ── Activation / playback ───────────────────────────────────────────

function _activateStepById(id) {
  const s = _findStep(id);
  if (!s) return;
  app.activeId = id;
  // Auto-expand the parent group when a sub-step is activated, so the
  // user sees where they are in the timeline.
  if (s._isSub && s._parentId) app.expandedIds.add(s._parentId);
  _renderStepList();
  _refreshTransport();
  _seekToActive(/*play=*/ true);
}

function _seekToActive(play) {
  const s = _findStep(app.activeId);
  if (!s) return;
  // Seek to this step's start. Auto-pause at the CONTAINING viewer-
  // step's end (group end for sub-steps; this step's end otherwise).
  const tl = _topLevelOf(app.activeId);
  els.video.currentTime = s.time_in_ms / 1000;
  app.pendingPause = { atSec: tl.time_out_ms / 1000 };
  // Snap the step-progress bar to whatever fraction of the new viewer-
  // step the playhead lands on (sub-step → mid-bar; head → 0%).
  _updateStepProgress(s.time_in_ms / 1000);
  if (play) {
    els.video.play().catch(() => { /* autoplay may be blocked; user clicks to play */ });
  }
}

function _togglePlay() {
  if (els.video.paused || els.video.ended) {
    // At the end of the active viewer-step's window, the auto-pause has
    // already landed the playhead exactly on the boundary. Pressing
    // Play again should REPLAY the current step from its start — NOT
    // auto-advance. Advancing is reserved for the explicit Next button
    // / right-arrow ("stay on this step until Next is pressed").
    const tl = _topLevelOf(app.activeId);
    if (tl && els.video.currentTime >= (tl.time_out_ms / 1000) - 0.05) {
      const s = _findStep(app.activeId);
      if (s) {
        els.video.currentTime = s.time_in_ms / 1000;
        app.pendingPause = { atSec: tl.time_out_ms / 1000 };
        _updateStepProgress(s.time_in_ms / 1000);
      }
    }
    els.video.play().catch(() => {});
  } else {
    els.video.pause();
  }
}

function _onTimeUpdate() {
  // Auto-pause moved to rAF (_checkAutoPause) for tighter boundary
  // detection. timeupdate just drives the readout + progress bar +
  // live sub-step highlight here.
  const t = els.video.currentTime;
  _updateTimeReadout();
  _updateStepProgress(t);

  // Live-highlight the sub-step the playhead is in (when its parent
  // group is expanded). Cheap — only re-renders if the active id
  // actually changes.
  const newActive = _stepAtTime(t * 1000);
  if (newActive && newActive.id !== app.activeId) {
    app.activeId = newActive.id;
    _renderStepList();
    _refreshTransport();
  }
}

/**
 * Drive the step-progress bar at the bottom of the video. Fills based
 * on (currentTime − stepStart) / (stepEnd − stepStart) for the CURRENT
 * top-level viewer-step. Resets at every step boundary.
 */
function _updateStepProgress(currentSec) {
  if (!els.stepProgressFill) return;
  const tl = _topLevelOf(app.activeId);
  if (!tl) { els.stepProgressFill.style.width = '0%'; return; }
  const startSec = tl.time_in_ms  / 1000;
  const endSec   = tl.time_out_ms / 1000;
  const span     = Math.max(0.0001, endSec - startSec);
  const pct = Math.max(0, Math.min(1, (currentSec - startSec) / span));
  els.stepProgressFill.style.width = `${(pct * 100).toFixed(1)}%`;
}

function _onEnded() {
  app.pendingPause = null;
  _refreshPlayLabel();
}

function _stepAtTime(ms) {
  // Find the deepest entry covering this time — prefer a sub-step over
  // its parent head when both match (the manifest sub-step's window is
  // strictly inside the head's window).
  let best = null;
  for (const s of app.flatSteps) {
    if (ms >= s.time_in_ms && ms < s.time_out_ms) {
      if (!best || s._isSub) best = s;
    }
  }
  return best;
}

// ── Sibling navigation (top-level prev/next) ────────────────────────

function _gotoSibling(delta) {
  const tl = _topLevelOf(app.activeId);
  if (!tl) return;
  const idx = app.topLevelIds.indexOf(tl.id);
  if (idx < 0) return;
  const nextIdx = idx + delta;
  if (nextIdx < 0 || nextIdx >= app.topLevelIds.length) return;
  _activateStepById(app.topLevelIds[nextIdx]);
}

// ── Transport refresh ───────────────────────────────────────────────

function _refreshTransport() {
  const tl = _topLevelOf(app.activeId);
  const idx = tl ? app.topLevelIds.indexOf(tl.id) : -1;
  els.stepCounter.textContent = (idx >= 0)
    ? `Step ${idx + 1} of ${app.topLevelIds.length}`
    : `– / –`;
  els.btnPrev.disabled = idx <= 0;
  els.btnNext.disabled = idx < 0 || idx >= app.topLevelIds.length - 1;
  _refreshPlayLabel();
}

function _refreshPlayLabel() {
  els.btnPlay.textContent = els.video.paused ? '▶ Play' : '❚❚ Pause';
}

function _updateTimeReadout() {
  const t = els.video.currentTime || 0;
  const d = (app.manifest?.total_duration_ms || 0) / 1000;
  els.timeReadout.textContent = `${_formatTime(t)} / ${_formatTime(d)}`;
}

// ── Tiny helpers ────────────────────────────────────────────────────

function _formatTime(sec) {
  if (!Number.isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function _formatRange(inMs, outMs) {
  return `${_formatTime(inMs / 1000)}–${_formatTime(outMs / 1000)}`;
}

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
