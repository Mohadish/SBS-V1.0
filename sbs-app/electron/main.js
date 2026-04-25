'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { spawn, execSync } = require('child_process');
const os = require('os');
const say = require('say');

// ─── Kokoro worker thread ─────────────────────────────────────────────────
// Kokoro inference is CPU-heavy (~1× real-time) and synchronous in JS,
// so doing it on the main process thread freezes every IPC handler — the
// renderer's UI hangs because most user actions round-trip through main.
// Move it to a worker_threads Worker. Main process stays responsive; the
// worker queues synths internally (it handles one message at a time).
const { Worker } = require('worker_threads');

let _kokoroWorker = null;
let _kokoroSeq    = 0;
const _kokoroPending = new Map();   // id → { resolve, reject }

function _kokoroBundlePaths() {
  return {
    bundleDir: app.isPackaged
      ? path.join(process.resourcesPath, 'kokoro-bundle')
      : path.join(APP_ROOT, 'kokoro-bundle'),
    cacheDir: path.join(app.getPath('userData'), 'kokoro-cache'),
  };
}

function _ensureKokoroWorker() {
  if (_kokoroWorker) return _kokoroWorker;
  const paths = _kokoroBundlePaths();
  try { fs.mkdirSync(paths.cacheDir, { recursive: true }); } catch {}
  console.log(`[kokoro] spawning worker — bundle=${paths.bundleDir}`);
  _kokoroWorker = new Worker(path.join(__dirname, 'kokoro-worker.js'), {
    workerData: paths,
  });
  _kokoroWorker.on('message', (msg) => {
    if (msg?.kind === 'log') { console.log(msg.msg); return; }
    const pending = _kokoroPending.get(msg.id);
    if (!pending) return;
    _kokoroPending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.wav);
    else        pending.reject(new Error(msg.error || 'Kokoro worker error'));
  });
  _kokoroWorker.on('error', (err) => {
    console.error('[kokoro-worker] error:', err);
    // Reject every in-flight call; next request will respawn the worker.
    for (const p of _kokoroPending.values()) p.reject(err);
    _kokoroPending.clear();
    _kokoroWorker = null;
  });
  _kokoroWorker.on('exit', (code) => {
    if (code !== 0) console.warn(`[kokoro-worker] exited with code ${code}`);
    _kokoroWorker = null;
  });
  return _kokoroWorker;
}

function _kokoroSynth(text, voice) {
  return new Promise((resolve, reject) => {
    const id = ++_kokoroSeq;
    _kokoroPending.set(id, { resolve, reject });
    _ensureKokoroWorker().postMessage({ kind: 'synth', id, text, voice });
  });
}

// Stop the worker on app quit so it doesn't hold the process open.
app.on('before-quit', () => {
  if (_kokoroWorker) { try { _kokoroWorker.terminate(); } catch {} _kokoroWorker = null; }
});

const IS_DEV   = process.argv.includes('--dev');
const APP_ROOT = path.join(__dirname, '..');

// ─── Vendor bootstrap ─────────────────────────────────────────────────────
// On first run (or after a clean checkout) the app's vendor/ directory may be
// empty.  We look for a sibling step_browser_runtime/vendor/ and copy files
// from there automatically.  This is a one-time dev-time convenience; the
// production build packages vendor/ directly.
function ensureVendorFiles() {
  const appVendor     = path.join(APP_ROOT, 'vendor');
  const runtimeVendor = path.join(APP_ROOT, '..', 'step_browser_runtime', 'vendor');

  if (!fs.existsSync(runtimeVendor)) return;   // nothing to copy

  // Create vendor dir if it doesn't exist
  if (!fs.existsSync(appVendor)) fs.mkdirSync(appVendor, { recursive: true });

  const needed = [
    'three.min.js',
    'three.module.proxy.mjs',   // required by all *.bundle.mjs loaders
    'occt-import-js.js',
    'occt-import-js.wasm',
    'occt-import-js-worker.js',
    'EBML.min.js',
    'quill.js',
    'quill.core.css',
    'OBJLoader.bundle.mjs',
    'STLLoader.bundle.mjs',
    'GLTFLoader.bundle.mjs',
    'BufferGeometryUtils.bundle.mjs', // required by GLTFLoader
  ];

  let copied = 0;
  for (const file of needed) {
    const src  = path.join(runtimeVendor, file);
    const dest = path.join(appVendor, file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      copied++;
    }
  }
  if (copied > 0) console.log(`[vendor] Copied ${copied} vendor file(s) to ${appVendor}`);
}

// ─── Python helper processes ───────────────────────────────────────────────
let piperProcess   = null;
let exportProcess  = null;

function findPython() {
  const candidates = ['python3', 'python', 'py'];
  for (const cmd of candidates) {
    try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return cmd; }
    catch (_) {}
  }
  return null;
}

function startHelpers() {
  const python = findPython();
  if (!python) {
    console.warn('[main] Python not found — helpers will not start.');
    return;
  }

  // Piper TTS helper (port 8765)
  const piperScript = path.join(APP_ROOT, '..', 'piper_shared', 'piper_tts_helper.py');
  if (fs.existsSync(piperScript)) {
    piperProcess = spawn(python, [piperScript], {
      cwd: path.dirname(piperScript),
      stdio: 'ignore',
      detached: false,
    });
    piperProcess.on('error', err => console.warn('[piper]', err.message));
    console.log('[main] Piper TTS helper started.');
  }

  // Export helper (port 8766)
  const exportScript = path.join(APP_ROOT, '..', 'step_export_helper_v0.148', 'step_export_helper.py');
  if (fs.existsSync(exportScript)) {
    exportProcess = spawn(python, [exportScript], {
      cwd: path.dirname(exportScript),
      stdio: 'ignore',
      detached: false,
    });
    exportProcess.on('error', err => console.warn('[export-helper]', err.message));
    console.log('[main] Export helper started.');
  }
}

function stopHelpers() {
  if (piperProcess)  { piperProcess.kill();  piperProcess  = null; }
  if (exportProcess) { exportProcess.kill(); exportProcess = null; }
}

// ─── Main window ──────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1440,
    height: 900,
    minWidth:  1024,
    minHeight: 640,
    backgroundColor: '#0f172a',   // dark bg while loading — avoids white flash
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,      // NEVER enable — security requirement
      sandbox: false,
    },
    show: false,   // show only once ready to avoid blank-window flash
  });

  mainWindow.loadFile(path.join(APP_ROOT, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Native menu ──────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // File
    {
      label: 'File',
      submenu: [
        { label: 'New Project',       accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('menu:newProject') },
        { label: 'Open Project…',     accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('menu:openProject') },
        { type: 'separator' },
        { label: 'Save Project',      accelerator: 'CmdOrCtrl+S', click: () => mainWindow?.webContents.send('menu:saveProject') },
        { label: 'Save Project As…',  accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow?.webContents.send('menu:saveProjectAs') },
        { type: 'separator' },
        { label: 'Load Model…',       accelerator: 'CmdOrCtrl+L', click: () => mainWindow?.webContents.send('menu:loadModel') },
        { label: 'Browse Assets…',    accelerator: 'CmdOrCtrl+B', click: () => mainWindow?.webContents.send('menu:browseAssets') },
        { type: 'separator' },
        { label: 'Settings…',         accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('menu:openSettings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            if (!mainWindow) return;
            const lvl = mainWindow.webContents.getZoomLevel();
            mainWindow.webContents.setZoomLevel(Math.min(lvl + 0.5, 5));
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            if (!mainWindow) return;
            const lvl = mainWindow.webContents.getZoomLevel();
            mainWindow.webContents.setZoomLevel(Math.max(lvl - 0.5, -5));
          },
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.setZoomLevel(0),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Fit All',     accelerator: 'F', click: () => mainWindow?.webContents.send('menu:fitAll') },
        { label: 'Show All',    click: () => mainWindow?.webContents.send('menu:showAll') },
        { type: 'separator' },
        ...(IS_DEV ? [{ role: 'toggleDevTools' }] : [
          { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
        ]),
        { role: 'reload' },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow?.webContents.reloadIgnoringCache() },
      ],
    },
    // Window
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ],
    },
    // Help
    {
      role: 'help',
      submenu: [
        { label: 'SBS Step Browser Help', click: () => shell.openExternal('https://github.com') },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

// ─── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureVendorFiles();
  startHelpers();
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopHelpers();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopHelpers());

// ─── IPC handlers (renderer → main) ────────────────────────────────────────
// These are the ONLY ways the renderer (UI) can talk to the file system.
// contextIsolation + preload means nothing else can reach Node.js directly.

// Open a CAD / 3D model file
ipcMain.handle('dialog:openModel', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Model File',
    filters: [
      { name: 'CAD & 3D Files', extensions: ['step','stp','iges','igs','brep','brp','obj','stl','gltf','glb','fbx'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? null : result.filePaths;
});

// Open a project file
ipcMain.handle('dialog:openProject', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Project',
    filters: [{ name: 'SBS Project', extensions: ['sbsproj'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Save project (choose location)
ipcMain.handle('dialog:saveProject', async (_, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Project',
    defaultPath: defaultName || 'untitled.sbsproj',
    filters: [{ name: 'SBS Project', extensions: ['sbsproj'] }],
  });
  return result.canceled ? null : result.filePath;
});

// Choose export output folder
ipcMain.handle('dialog:chooseExportFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Export Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Read a file (returns base64 for binary, utf-8 string for text)
ipcMain.handle('fs:readFile', async (_, filePath, encoding = 'base64') => {
  try {
    return { ok: true, data: fs.readFileSync(filePath, encoding) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Write a file
ipcMain.handle('fs:writeFile', async (_, filePath, data, encoding = 'utf-8') => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data, encoding);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Check if a file exists
ipcMain.handle('fs:exists', async (_, filePath) => {
  return fs.existsSync(filePath);
});

// Stat a file — returns { size, mtimeMs } or null
ipcMain.handle('fs:stat', async (_, filePath) => {
  try {
    const s = fs.statSync(filePath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch { return null; }
});

// Get app version
ipcMain.handle('app:getVersion', () => app.getVersion());

// Open file in system explorer
ipcMain.handle('shell:showItemInFolder', (_, filePath) => {
  shell.showItemInFolder(filePath);
});

// ─── User settings (machine-level prefs, separate from project file) ───────
const _userSettingsPath = path.join(app.getPath('userData'), 'user-settings.json');

function _readUserSettingsSync() {
  try {
    if (!fs.existsSync(_userSettingsPath)) return {};
    return JSON.parse(fs.readFileSync(_userSettingsPath, 'utf-8'));
  } catch (e) {
    console.warn('[settings] read failed:', e.message);
    return {};
  }
}

function _writeUserSettingsSync(obj) {
  try {
    fs.mkdirSync(path.dirname(_userSettingsPath), { recursive: true });
    fs.writeFileSync(_userSettingsPath, JSON.stringify(obj, null, 2), 'utf-8');
    return { ok: true };
  } catch (e) {
    console.warn('[settings] write failed:', e.message);
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('settings:read',  ()    => _readUserSettingsSync());
ipcMain.handle('settings:write', (_, o) => _writeUserSettingsSync(o || {}));
ipcMain.handle('settings:locale', () => app.getLocale());   // e.g. "en-US"
ipcMain.handle('settings:path',  () => _userSettingsPath);

/**
 * Languages installed / preferred on the OS.
 * Primary source: Electron's app.getPreferredSystemLanguages() — returns the
 * user's configured language list (matches what Windows Settings Language &
 * Region shows). Reliable across platforms, no shell-out.
 *
 * On Windows we ALSO mine voice cultures from our PS_LIST_VOICES result so
 * a user with Hebrew speech voices but no Hebrew input language still sees
 * Hebrew listed — narration is the point of this filter.
 *
 * Always returns a non-empty list (hardcoded common-language fallback).
 *
 * Returns: [{ tag: "he-IL", name: "Hebrew" }, ...]
 */
ipcMain.handle('settings:installedLanguages', async () => {
  const byTag = new Map();   // de-dupe by tag

  // 1. Electron's preferred-system-languages list — primary, fast, reliable.
  try {
    const tags = app.getPreferredSystemLanguages?.() || [app.getLocale()];
    for (const tag of tags) {
      if (!tag) continue;
      byTag.set(tag, { tag, name: _languageNameFromTag(tag) });
    }
  } catch (e) {
    console.warn('[settings] app.getPreferredSystemLanguages failed:', e.message);
  }

  // 2. Voice cultures (best-effort) — captures languages the user installed
  //    voices for but didn't add as an input language.
  if (process.platform === 'win32') {
    try {
      const list = await _enumerateVoices();
      for (const v of list) {
        const tag = v.culture || v.Culture;
        if (!tag || byTag.has(tag)) continue;
        byTag.set(tag, { tag, name: _languageNameFromTag(tag) });
      }
    } catch { /* voice enumeration may be slow; skip silently */ }
  }

  let result = Array.from(byTag.values());

  if (!result.length) {
    // Last resort — give the user something to pick.
    result = [
      { tag: 'en-US', name: 'English' },
      { tag: 'he-IL', name: 'Hebrew' },
      { tag: 'es-ES', name: 'Spanish' },
      { tag: 'fr-FR', name: 'French' },
      { tag: 'de-DE', name: 'German' },
      { tag: 'it-IT', name: 'Italian' },
      { tag: 'pt-BR', name: 'Portuguese' },
      { tag: 'ru-RU', name: 'Russian' },
      { tag: 'ja-JP', name: 'Japanese' },
      { tag: 'zh-CN', name: 'Chinese' },
      { tag: 'ar-SA', name: 'Arabic' },
    ];
    console.log('[settings] Using hardcoded language fallback list.');
  }
  console.log(`[settings] Returning ${result.length} language(s):`,
    result.map(r => `${r.tag}=${r.name}`).join(', '));
  return result;
});

// Internal — used by both tts:listVoices and settings:installedLanguages.
// Cached for the process lifetime; voices can't change without a restart.
let _voiceListCache = null;
async function _enumerateVoices() {
  if (_voiceListCache) return _voiceListCache;
  const voices = [];

  // Windows OS voices (SAPI 5 + OneCore via PowerShell).
  if (process.platform === 'win32') {
    try {
      const raw = execSync(`powershell -NoProfile -NonInteractive -Command "${PS_LIST_VOICES.replace(/\n/g, ' ')}"`, {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
      }).toString().replace(/^\uFEFF/, '').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const v of arr) voices.push({
          name:    v.Name,
          culture: v.Culture,
          lang:    v.Language || _languageNameFromTag(v.Culture || ''),
          gender:  v.Gender,
          source:  v.Source,
        });
      }
    } catch (e) {
      console.warn('[tts] PS listVoices failed:', e.message);
    }
  }

  // Kokoro voices — ALWAYS listed (independent of OS). Model not loaded
  // unless user actually picks one; here we just add the names + langs from
  // a static manifest so the dropdown populates instantly.
  for (const v of _KOKORO_VOICES) {
    voices.push({ name: v.name, culture: v.culture, lang: v.lang, gender: v.gender, source: 'kokoro' });
  }

  _voiceListCache = voices;
  return voices;
}

// Kokoro v1.0 voice manifest. Listing here (instead of querying the model
// at boot) means the voice dropdown populates without forcing a model
// download. Names exactly match the keys kokoro-js exposes on tts.voices.
const _KOKORO_VOICES = [
  // American English
  { name: 'af_heart',    culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_alloy',    culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_aoede',    culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_bella',    culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_jessica',  culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_kore',     culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_nicole',   culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_nova',     culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_river',    culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_sarah',    culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'af_sky',      culture: 'en-US', lang: 'English (American)', gender: 'Female' },
  { name: 'am_adam',     culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  { name: 'am_echo',     culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  { name: 'am_eric',     culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  { name: 'am_fenrir',   culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  { name: 'am_liam',     culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  { name: 'am_michael',  culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  { name: 'am_onyx',     culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  { name: 'am_puck',     culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  { name: 'am_santa',    culture: 'en-US', lang: 'English (American)', gender: 'Male' },
  // British English
  { name: 'bf_alice',    culture: 'en-GB', lang: 'English (British)',  gender: 'Female' },
  { name: 'bf_emma',     culture: 'en-GB', lang: 'English (British)',  gender: 'Female' },
  { name: 'bf_isabella', culture: 'en-GB', lang: 'English (British)',  gender: 'Female' },
  { name: 'bf_lily',     culture: 'en-GB', lang: 'English (British)',  gender: 'Female' },
  { name: 'bm_daniel',   culture: 'en-GB', lang: 'English (British)',  gender: 'Male' },
  { name: 'bm_fable',    culture: 'en-GB', lang: 'English (British)',  gender: 'Male' },
  { name: 'bm_george',   culture: 'en-GB', lang: 'English (British)',  gender: 'Male' },
  { name: 'bm_lewis',    culture: 'en-GB', lang: 'English (British)',  gender: 'Male' },
  // Spanish, French, Hindi, Italian, Japanese, Portuguese, Mandarin
  { name: 'ef_dora',     culture: 'es-ES', lang: 'Spanish',            gender: 'Female' },
  { name: 'em_alex',     culture: 'es-ES', lang: 'Spanish',            gender: 'Male' },
  { name: 'em_santa',    culture: 'es-ES', lang: 'Spanish',            gender: 'Male' },
  { name: 'ff_siwis',    culture: 'fr-FR', lang: 'French',             gender: 'Female' },
  { name: 'hf_alpha',    culture: 'hi-IN', lang: 'Hindi',              gender: 'Female' },
  { name: 'hf_beta',     culture: 'hi-IN', lang: 'Hindi',              gender: 'Female' },
  { name: 'hm_omega',    culture: 'hi-IN', lang: 'Hindi',              gender: 'Male' },
  { name: 'hm_psi',      culture: 'hi-IN', lang: 'Hindi',              gender: 'Male' },
  { name: 'if_sara',     culture: 'it-IT', lang: 'Italian',            gender: 'Female' },
  { name: 'im_nicola',   culture: 'it-IT', lang: 'Italian',            gender: 'Male' },
  { name: 'jf_alpha',    culture: 'ja-JP', lang: 'Japanese',           gender: 'Female' },
  { name: 'jf_gongitsune', culture: 'ja-JP', lang: 'Japanese',         gender: 'Female' },
  { name: 'jf_nezumi',   culture: 'ja-JP', lang: 'Japanese',           gender: 'Female' },
  { name: 'jf_tebukuro', culture: 'ja-JP', lang: 'Japanese',           gender: 'Female' },
  { name: 'jm_kumo',     culture: 'ja-JP', lang: 'Japanese',           gender: 'Male' },
  { name: 'pf_dora',     culture: 'pt-BR', lang: 'Portuguese (BR)',    gender: 'Female' },
  { name: 'pm_alex',     culture: 'pt-BR', lang: 'Portuguese (BR)',    gender: 'Male' },
  { name: 'pm_santa',    culture: 'pt-BR', lang: 'Portuguese (BR)',    gender: 'Male' },
  { name: 'zf_xiaobei',  culture: 'zh-CN', lang: 'Chinese (Mandarin)', gender: 'Female' },
  { name: 'zf_xiaoni',   culture: 'zh-CN', lang: 'Chinese (Mandarin)', gender: 'Female' },
  { name: 'zf_xiaoxiao', culture: 'zh-CN', lang: 'Chinese (Mandarin)', gender: 'Female' },
  { name: 'zf_xiaoyi',   culture: 'zh-CN', lang: 'Chinese (Mandarin)', gender: 'Female' },
  { name: 'zm_yunjian',  culture: 'zh-CN', lang: 'Chinese (Mandarin)', gender: 'Male' },
  { name: 'zm_yunxi',    culture: 'zh-CN', lang: 'Chinese (Mandarin)', gender: 'Male' },
  { name: 'zm_yunxia',   culture: 'zh-CN', lang: 'Chinese (Mandarin)', gender: 'Male' },
  { name: 'zm_yunyang',  culture: 'zh-CN', lang: 'Chinese (Mandarin)', gender: 'Male' },
];

function _languageNameFromTag(tag) {
  const t = (tag || '').toLowerCase().split(/[-_]/)[0];
  const map = {
    en:'English', he:'Hebrew', es:'Spanish', fr:'French', de:'German',
    it:'Italian', pt:'Portuguese', ru:'Russian', zh:'Chinese', ja:'Japanese',
    ko:'Korean', ar:'Arabic', hi:'Hindi', tr:'Turkish', pl:'Polish',
    cs:'Czech', sk:'Slovak', hu:'Hungarian', el:'Greek', nl:'Dutch',
    sv:'Swedish', no:'Norwegian', da:'Danish', fi:'Finnish', th:'Thai',
    vi:'Vietnamese', id:'Indonesian', uk:'Ukrainian',
  };
  return map[t] || (tag || '').toUpperCase();
}

// ─── OS TTS (PowerShell — SAPI 5 + OneCore engines) ───────────────────────
const _ttsTempDir = path.join(os.tmpdir(), 'sbs-tts');
try { fs.mkdirSync(_ttsTempDir, { recursive: true }); } catch {}

// PowerShell that enumerates BOTH speech engines on Windows:
//   • System.Speech (SAPI 5) — classic desktop voices like David, Zira
//   • Windows.Media.SpeechSynthesis (OneCore) — Mobile/Natural voices like
//     Asaf, Hila, and any "Speech voices" the user installed via Settings.
// `say` only enumerates SAPI 5. Querying both ourselves catches OneCore voices.
const PS_LIST_VOICES = `
$ErrorActionPreference = 'SilentlyContinue';
$voices = New-Object System.Collections.ArrayList;
try {
  Add-Type -AssemblyName System.Speech;
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
  foreach ($v in $synth.GetInstalledVoices()) {
    $info = $v.VoiceInfo;
    [void]$voices.Add([PSCustomObject]@{
      Name=$info.Name; Culture=$info.Culture.Name; Language=$info.Culture.EnglishName;
      Gender=$info.Gender.ToString(); Source='sapi5';
    });
  }
  $synth.Dispose();
} catch {}
try {
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime];
  foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
    [void]$voices.Add([PSCustomObject]@{
      Name=$v.DisplayName; Culture=$v.Language; Language='';
      Gender=$v.Gender.ToString(); Source='onecore';
    });
  }
} catch {}
ConvertTo-Json -Compress -InputObject @($voices)
`;

ipcMain.handle('tts:listVoices', async () => {
  if (process.platform !== 'win32') {
    return new Promise(resolve => {
      try {
        say.getInstalledVoices((err, voices) => {
          if (err) { console.warn('[tts] listVoices:', err.message); resolve([]); return; }
          resolve((voices || []).filter(Boolean).map(name => ({ name, source: 'sapi5' })));
        });
      } catch (e) { resolve([]); }
    });
  }
  const voices = await _enumerateVoices();
  console.log(`[tts] returning ${voices.length} voice(s):`,
    voices.map(v => `${v.name}/${v.source}/${v.culture}`).join(', '));
  return voices;
});

// Body of the OneCore synth script — uses $voiceName / $textToSpeak / $outFile,
// which are SET BY US at the top of the encoded command (see below). Avoids
// the $args binding gotcha that comes with `-Command` mode.
const PS_SYNTH_ONECORE_BODY = `
$ErrorActionPreference = 'Stop';
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime];
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime];
Add-Type -AssemblyName System.Runtime.WindowsRuntime;
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0];
function Await($winRtTask, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType);
  $netTask = $asTask.Invoke($null, @($winRtTask));
  $netTask.Wait(-1) | Out-Null;
  $netTask.Result;
}
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer;
$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $voiceName } | Select-Object -First 1;
if (-not $voice) { throw "OneCore voice not found: $voiceName"; }
$synth.Voice = $voice;
$stream = Await ($synth.SynthesizeTextToStreamAsync($textToSpeak)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]);
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0));
[void](Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]));
$bytes = New-Object 'byte[]' ($stream.Size);
$reader.ReadBytes($bytes);
[System.IO.File]::WriteAllBytes($outFile, $bytes);
`;

/** Escape for PS single-quoted string. Inside '...' only ' needs doubling. */
function _psQuote(s) {
  return "'" + String(s ?? '').replace(/'/g, "''") + "'";
}

/** Build a PS command string with our values inlined as variable assignments. */
function _buildOneCoreSynthCommand(voiceName, text, outFile) {
  return [
    `$voiceName = ${_psQuote(voiceName)};`,
    `$textToSpeak = ${_psQuote(text)};`,
    `$outFile = ${_psQuote(outFile)};`,
    PS_SYNTH_ONECORE_BODY,
  ].join('\n');
}

ipcMain.handle('tts:synthesize', async (_, text, voice, speed, opts) => {
  if (!text || !text.trim()) return { ok: false, error: 'Empty text.' };
  const source   = opts?.source || 'sapi5';   // renderer can hint 'onecore' / 'kokoro'
  const filename = path.join(_ttsTempDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);

  if (source === 'kokoro') {
    try {
      console.log(`[kokoro] generating "${text.slice(0, 40)}…" with voice ${voice}`);
      const wavBuf = await _kokoroSynth(text, voice);
      // wavBuf is a Buffer transferred from the worker.
      const b64 = (Buffer.isBuffer(wavBuf) ? wavBuf : Buffer.from(wavBuf)).toString('base64');
      return { ok: true, data: b64, mime: 'audio/wav' };
    } catch (e) {
      console.warn('[kokoro] synth failed:', e?.message);
      return { ok: false, error: e?.message || 'Kokoro synthesis failed.' };
    }
  }

  if (source === 'onecore' && process.platform === 'win32') {
    // Synthesize via Windows.Media.SpeechSynthesis (OneCore engine).
    // Inline the inputs as PS variable assignments + base64-encode the
    // whole script as UTF-16LE for -EncodedCommand. This bypasses both
    // the $args/Command binding gotcha AND the ANSI-codepage mangling
    // that would corrupt Hebrew / Arabic / Japanese text on the command line.
    return new Promise(resolve => {
      try {
        const cmd     = _buildOneCoreSynthCommand(voice, text, filename);
        const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
        const child = spawn('powershell', [
          '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', d => err += d.toString());
        child.on('close', (code) => {
          if (code !== 0) {
            console.warn('[tts] OneCore synth failed:', err);
            resolve({ ok: false, error: err.trim() || `PowerShell exited ${code}` });
            return;
          }
          try {
            const buf = fs.readFileSync(filename);
            const b64 = buf.toString('base64');
            try { fs.unlinkSync(filename); } catch {}
            resolve({ ok: true, data: b64, mime: 'audio/wav' });
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
        child.on('error', e => resolve({ ok: false, error: e.message }));
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // SAPI 5 path — the existing `say` library handles this well.
  return new Promise(resolve => {
    try {
      say.export(text, voice || null, Number(speed) || 1.0, filename, (err) => {
        if (err) { resolve({ ok: false, error: err.message }); return; }
        try {
          const buf = fs.readFileSync(filename);
          const b64 = buf.toString('base64');
          try { fs.unlinkSync(filename); } catch {}
          resolve({ ok: true, data: b64, mime: 'audio/wav' });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
});
