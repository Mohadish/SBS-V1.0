# SBS Viewer

Single-page app for playing SBS process files (`.sbsproc`) and assemblies
(`.sbsasm`). Runs as a static web page OR as a packaged desktop app
(Electron) — the same `viewer.html` / `viewer.js` / `styles.css` source
serves both.

## File formats

- **`.sbsproc`** — single-file binary container produced by the SBS
  editor. Layout: 8-byte ASCII magic `SBSPROC1` + 4-byte uint32 LE
  manifest length + UTF-8 JSON manifest (step times, narration text)
  + raw MP4 stream. Self-contained; not a zip.
- **`.sbsasm`** — JSON manifest listing process URLs (relative or
  absolute) plus a title and optional thumbs / descriptions. Built by
  the manager via the in-app Builder; consumed by workers.

## Web mode (no install)

1. Serve the folder over HTTP — browsers block `fetch()` against
   `file://`, so a static server is required:
   ```
   python -m http.server 8000
   ```
2. Open `http://localhost:8000/viewer.html`.
3. Drop a `.sbsproc` or `.sbsasm`; OR pass `?asm=<url>` /
   `?proc=<url>` for direct launch; OR `?mode=build` for the
   admin assembly builder.

## Desktop mode (Electron)

One-time:
```
cd sbs-viewer
npm install
```

Run dev:
```
npm start
```

Build a Windows installer (NSIS, sets up Start Menu + Desktop shortcuts):
```
npm run build
```
→ `dist/SBS Viewer Setup <version>.exe`

Cross-platform:
```
npm run build:mac    # .dmg
npm run build:linux  # AppImage
```

## Source files

| file              | purpose                                             |
|-------------------|-----------------------------------------------------|
| `viewer.html`     | Markup for landing / assembly grid / builder / player |
| `viewer.js`       | Parser, screen routing, builder, transport, audio   |
| `styles.css`      | Dark theme + per-screen layout                      |
| `main.js`         | Electron entry — opens viewer.html in BrowserWindow |
| `package.json`    | Electron dependencies + electron-builder config     |
| `sample.sbsasm`   | Reference assembly manifest                         |
