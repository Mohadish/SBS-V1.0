'use strict';

/**
 * SBS — pick a colour from ANYWHERE on screen (main side).
 * ─────────────────────────────────────────────────────────
 * Chromium's eyedropper (the one in its colour popup, and the EyeDropper API)
 * sees only this app's own window under Electron — a browser or a picture
 * viewer beside it is invisible to it. So (V0.3.4.108): snapshot the displays
 * (desktopCapturer), open a frameless always-on-top window over EACH display
 * (V0.3.4.110) showing its snapshot, let the user click a pixel of it
 * (electron/screen-picker.*), answer with the hex. The first click anywhere
 * answers; Esc answers nothing. This app's own windows STAY in the snapshot
 * (V0.3.4.112: the user picks from SBS's interface too).
 *
 * V0.3.4.117 — the wait was ~2 s on two displays. Measured (2026-09-24,
 * E:\claude-temp\picktest): sequential captures 949 ms → parallel 534 ms;
 * PNG data URL 164 ms encode + ~100 ms decode → raw bitmap 6 ms + 8 ms swap;
 * picker windows loading 290 ms, and loading them DURING the capture slows
 * the capture itself (880 ms). So:
 *   • the captures (one per distinct native size — thumbnailSize is shared
 *     by every source in a call, and a smaller display in a bigger call
 *     comes back UPSCALED, no good for exact pixels) run all at once;
 *   • the picker windows are a POOL: created once (when the colour dialog
 *     opens — 'prepare' — or on the first pick), hidden between picks,
 *     dropped when the displays change or the main window closes. A pick
 *     is then just the capture;
 *   • the snapshot travels as raw RGBA, not a PNG data URL, straight into a
 *     canvas; the page asks as soon as a session starts and main answers
 *     when the capture is in;
 *   • a window is shown only when its page reports the snapshot DRAWN
 *     ('drawn'), so no black flash and no window in the picture — and a
 *     page that never reports (4 s) ends the pick, so the app is never
 *     left waiting behind its click veil.
 */

const { app, BrowserWindow, screen, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

const TIMING = !!process.env.SBS_PICK_TIMING;
const _log = (t, what) => { if (TIMING) console.log(`[pick] ${what}: ${(performance.now() - t).toFixed(0)} ms`); };

const _pickShots = new Map();   // display id → { width, height, rgba: Buffer }   (RGBA, top-down)
let   _pickReady = null;        // resolves when the snapshots are in — the pages ask before that
let   _pool      = null;        // { sig, displays, wins: [{ w, displayId, bounds, loaded, shown }] }
let   _active    = false;
let   _installed = false;
const _hookedMain = new WeakSet();

/** BGRA (Skia N32 on Windows) → RGBA, in place. */
function _toRgba(buf) {
  for (let i = 0; i < buf.length; i += 4) { const b = buf[i]; buf[i] = buf[i + 2]; buf[i + 2] = b; }
  return buf;
}

const _sig = (displays) => displays.map(d => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}@${d.scaleFactor}`).join('|');

/** Register the picker pages' IPC and the pool's housekeeping. Once. */
function installScreenPick() {
  if (_installed) return;
  _installed = true;
  ipcMain.handle('color:pickScreen:image', async (_, displayId) => {
    if (!_active) return null;
    try { await _pickReady; } catch {}
    return _pickShots.get(String(displayId)) || null;
  });
  // a picker page under the pointer wants the keyboard (Esc) — it says so on mouseenter
  ipcMain.on('color:pickScreen:focus', (e) => {
    const p = _pool?.wins.find(x => !x.w.isDestroyed() && e.sender === x.w.webContents);
    if (p && p.shown) { try { p.w.focus(); } catch {} }
  });
  // the pool is per display layout. `screen` cannot be touched before the app is
  // ready, and main.js calls this at load (V0.3.4.118 threw exactly that).
  app.whenReady().then(() => {
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => dropScreenPickPool());
  });
}

function dropScreenPickPool() {
  if (!_pool) return;
  for (const p of _pool.wins) { try { if (!p.w.isDestroyed()) p.w.destroy(); } catch {} }
  _pool = null;
}

/**
 * The hidden picker windows, one per display — made now if missing or stale
 * (display layout changed, a window died). Cheap when they exist.
 * `mainWindow`: when it closes the pool goes too, or the app would never quit.
 */
function prepareScreenPick(mainWindow) {
  const displays = screen.getAllDisplays();
  const sig = _sig(displays);
  if (_pool && _pool.sig === sig && _pool.wins.every(p => !p.w.isDestroyed())) return _pool;
  dropScreenPickPool();
  const wins = displays.map(d => {
    const b = d.bounds;
    const w = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      hasShadow: false, show: false, backgroundColor: '#000000', title: 'Pick a colour',
      // backgroundThrottling off: the page lives hidden between picks and must answer a session at full speed
      webPreferences: { preload: path.join(__dirname, 'screen-picker-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    w.setMenuBarVisibility(false);
    w.setAlwaysOnTop(true, 'screen-saver');
    const loaded = w.loadFile(path.join(__dirname, 'screen-picker.html'), { query: { d: String(d.id) } }).then(() => true, () => false);
    return { w, displayId: String(d.id), bounds: b, loaded, shown: false };
  });
  _pool = { sig, displays, wins };
  if (mainWindow && !mainWindow.isDestroyed() && !_hookedMain.has(mainWindow)) {
    _hookedMain.add(mainWindow);
    mainWindow.once('closed', () => dropScreenPickPool());
  }
  return _pool;
}

/**
 * The pick. Resolves with '#rrggbb', or null (Esc, right-click, nothing to
 * show, or a pick already running). `mainWindow` comes back to the front after.
 */
async function pickScreenColor(mainWindow) {
  if (_active) return null;
  _active = true;
  const T = performance.now();
  try {
    const pool = prepareScreenPick(mainWindow);
    const displays = pool.displays;
    _pickShots.clear();

    // ── the captures: one per distinct native size, all at once ──────────
    const bySize = new Map();
    for (const d of displays) {
      const sc = d.scaleFactor || 1;
      const k = `${Math.round(d.size.width * sc)}x${Math.round(d.size.height * sc)}`;
      if (!bySize.has(k)) bySize.set(k, { width: Math.round(d.size.width * sc), height: Math.round(d.size.height * sc), ids: [] });
      bySize.get(k).ids.push(String(d.id));
    }
    const take = (id, img) => {
      if (_pickShots.has(id)) return;
      const { width, height } = img.getSize();
      _pickShots.set(id, { width, height, rgba: _toRgba(img.toBitmap()) });
    };
    const capture = async ({ width, height, ids }) => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      for (const s of sources) { const id = String(s.display_id); if (ids.includes(id) && !s.thumbnail.isEmpty()) take(id, s.thumbnail); }
      // a source that names no display (some drivers): the first unmatched display takes it
      for (const s of sources) if (!ids.includes(String(s.display_id)) && !s.thumbnail.isEmpty()) { const free = ids.find(i => !_pickShots.has(i)); if (free) take(free, s.thumbnail); }
    };
    _pickReady = Promise.all([...bySize.values()].map(capture))
      .then(() => _log(T, `captured ${_pickShots.size} display(s)`), (e) => console.warn('[pick] capture failed:', e?.message || e));

    // ── the session: every pooled page asks for its snapshot, draws it, reports; the first click answers ──
    const hex = await new Promise((resolve) => {
      let settled = false, shown = 0;
      const done = (v) => {
        if (settled) return;
        settled = true;
        ipcMain.removeListener('color:pickScreen:done', onDone);
        ipcMain.removeListener('color:pickScreen:drawn', onDrawn);
        for (const p of pool.wins) p.w.removeListener('closed', onClosed);
        resolve(v);
      };
      const onDone = (e, v) => {
        if (!pool.wins.some(p => !p.w.isDestroyed() && e.sender === p.w.webContents)) return;
        done(typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
      };
      const onDrawn = (e) => {
        const p = pool.wins.find(x => !x.w.isDestroyed() && e.sender === x.w.webContents);
        if (!p || p.shown || settled) return;
        p.shown = true; shown++;
        // the one under the pointer gets the keyboard (Esc); the others show without taking focus
        let underId = null;
        try { underId = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id); } catch {}
        try { p.w.setBounds(p.bounds); if (p.displayId === underId) p.w.show(); else p.w.showInactive(); } catch {}
        _log(T, `picker shown on display ${p.displayId}${p.displayId === underId ? ' (pointer here)' : ''}`);
      };
      // a picker the user SAW going away = cancel; one never shown is nothing
      const onClosed = () => { if (pool.wins.some(p => p.shown && p.w.isDestroyed())) done(null); };
      ipcMain.on('color:pickScreen:done', onDone);
      ipcMain.on('color:pickScreen:drawn', onDrawn);
      for (const p of pool.wins) {
        p.shown = false;
        p.w.on('closed', onClosed);
        p.loaded.then((ok) => { if (ok && !settled && !p.w.isDestroyed()) p.w.webContents.send('color:pickScreen:session'); });
      }
      _pickReady.then(() => {
        if (settled) return;
        if (!_pickShots.size) { done(null); return; }
        // a page that never reports (blocked, crashed) must not leave the app waiting behind its click veil
        setTimeout(() => { if (!shown) { console.warn('[pick] no picker window came up — giving up'); done(null); } }, 4000);
      });
    });

    // back to hidden, kept for the next pick; the pages drop their snapshot
    for (const p of pool.wins) {
      if (p.w.isDestroyed()) continue;
      try { p.w.webContents.send('color:pickScreen:end'); } catch {}
      if (p.shown) { try { p.w.hide(); } catch {} }
      p.shown = false;
    }
    _pickShots.clear();
    _pickReady = null;
    // the app window comes back to the front, where it was
    try { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.moveTop?.(); mainWindow.focus(); } } catch {}
    _log(T, `pick over (${hex || 'nothing'})`);
    return hex;
  } catch (e) {
    console.warn('[pick] screen colour pick failed:', e?.message);
    _pickShots.clear(); _pickReady = null;
    dropScreenPickPool();
    return null;
  } finally {
    _active = false;
  }
}

module.exports = { installScreenPick, prepareScreenPick, pickScreenColor, dropScreenPickPool };
