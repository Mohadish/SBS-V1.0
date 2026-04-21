'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { spawn, execSync } = require('child_process');

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
