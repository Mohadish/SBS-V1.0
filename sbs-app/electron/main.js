'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { spawn, execSync } = require('child_process');
const os = require('os');
const say = require('say');

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
 * Languages installed on the OS (display / input languages).
 * Windows: Get-WinUserLanguageList via PowerShell.
 * macOS / Linux: best-effort via app.getPreferredSystemLanguages.
 *
 * Always returns a non-empty list — falls back to a small hardcoded list of
 * common languages if the OS query fails for any reason.
 *
 * Returns: [{ tag: "he-IL", name: "Hebrew" }, ...]
 */
ipcMain.handle('settings:installedLanguages', async () => {
  let result = [];

  if (process.platform === 'win32') {
    try {
      const raw = execSync(
        'powershell -NoProfile -NonInteractive -Command "Get-WinUserLanguageList | Select-Object LanguageTag, EnglishName | ConvertTo-Json -Compress"',
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }
      ).toString();
      // Strip BOM + trim before parse — PowerShell stdout sometimes has both.
      const json = raw.replace(/^\uFEFF/, '').trim();
      console.log('[settings] PowerShell language list output:', json);
      if (json) {
        const parsed = JSON.parse(json);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        result = arr
          .map(o => ({ tag: o?.LanguageTag, name: o?.EnglishName }))
          .filter(o => o.tag && o.name);
      }
      console.log(`[settings] Parsed ${result.length} OS language(s):`,
        result.map(r => `${r.tag}=${r.name}`).join(', '));
    } catch (e) {
      console.warn('[settings] Get-WinUserLanguageList failed:', e.message);
    }
  }

  if (!result.length) {
    // Try Electron's own preference list.
    try {
      const tags = app.getPreferredSystemLanguages?.() || [app.getLocale()];
      result = tags.map(tag => ({ tag, name: _languageNameFromTag(tag) })).filter(o => o.tag && o.name);
      console.log('[settings] Fell back to app.getPreferredSystemLanguages:', result);
    } catch (e) {
      console.warn('[settings] app locale fallback failed:', e.message);
    }
  }

  if (!result.length) {
    // Last resort — give the user something to pick from.
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

  return result;
});

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
    // Non-Windows: fall back to the say-style enumeration.
    return new Promise(resolve => {
      try {
        say.getInstalledVoices((err, voices) => {
          if (err) { console.warn('[tts] listVoices:', err.message); resolve([]); return; }
          resolve((voices || []).filter(Boolean).map(name => ({ name, source: 'os' })));
        });
      } catch (e) { resolve([]); }
    });
  }
  try {
    const raw = execSync(`powershell -NoProfile -NonInteractive -Command "${PS_LIST_VOICES.replace(/\n/g, ' ')}"`, {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
    }).toString().replace(/^\uFEFF/, '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    console.log(`[tts] enumerated ${arr.length} voice(s):`,
      arr.map(v => `${v.Name}/${v.Source}/${v.Culture}`).join(', '));
    return arr.map(v => ({
      name:    v.Name,
      culture: v.Culture,        // BCP-47 e.g. "he-IL"
      lang:    v.Language || _languageNameFromTag(v.Culture || ''),
      gender:  v.Gender,
      source:  v.Source,         // 'sapi5' | 'onecore'
    }));
  } catch (e) {
    console.warn('[tts] PS listVoices failed:', e.message);
    return [];
  }
});

// PowerShell that synthesizes ONE OneCore voice to a WAV file.
// Args: $voiceName (DisplayName), $text, $outFile.
const PS_SYNTH_ONECORE = `
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
$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $args[0] } | Select-Object -First 1;
if (-not $voice) { throw "OneCore voice not found: $($args[0])"; }
$synth.Voice = $voice;
$stream = Await ($synth.SynthesizeTextToStreamAsync($args[1])) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]);
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0));
[void](Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]));
$bytes = New-Object 'byte[]' ($stream.Size);
$reader.ReadBytes($bytes);
[System.IO.File]::WriteAllBytes($args[2], $bytes);
`;

ipcMain.handle('tts:synthesize', async (_, text, voice, speed, opts) => {
  if (!text || !text.trim()) return { ok: false, error: 'Empty text.' };
  const source   = opts?.source || 'sapi5';   // renderer can hint 'onecore'
  const filename = path.join(_ttsTempDir, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);

  if (source === 'onecore' && process.platform === 'win32') {
    // Synthesize via Windows.Media.SpeechSynthesis (OneCore engine).
    return new Promise(resolve => {
      try {
        const psArgs = [
          '-NoProfile', '-NonInteractive', '-Command',
          PS_SYNTH_ONECORE.replace(/\n/g, ' '),
          '-Args', voice, text, filename,
        ];
        const child = spawn('powershell', psArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
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
