/**
 * SBS — Interface overlay library (Phase A: folder management).
 *
 * An "interface" is an overlay image drawn from a user-chosen LIBRARY FOLDER.
 * The first time the user adds an interface they pick that folder; afterwards
 * the folder is remembered (runtime for now — persistence lands in a later
 * phase) and its images become the pool you can swap between per step.
 *
 * This module owns only the LIBRARY side (folder + image listing). Insertion,
 * the default pose, the swap picker, and per-step persistence come in Phases
 * B–D. It touches no storage/schema yet, so it can't affect old projects.
 */
import { state } from '../core/state.js';
import * as overlay from './overlay.js';

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']);
const MIME = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp', webp: 'webp' };

/** The currently chosen library folder (absolute path) or null. */
export function getLibraryFolder() {
  return state.get('interfaceLibraryFolder') || null;
}

export function setLibraryFolder(folder) {
  state.setState({ interfaceLibraryFolder: folder || null });
}

/** Open the native folder picker and remember the choice. Returns folder|null. */
export async function chooseLibraryFolder() {
  const nat = window.sbsNative;
  if (!nat?.chooseFolder) return null;
  const folder = await nat.chooseFolder({ title: 'Choose interface library folder' });
  if (folder) setLibraryFolder(folder);
  return folder;
}

/** Ensure a library folder is set, prompting once if needed. Returns folder|null. */
export async function ensureLibraryFolder() {
  return getLibraryFolder() || (await chooseLibraryFolder());
}

/**
 * List the image files in the library folder, sorted by name.
 * Returns [{ name, path }] (path uses '/' — Node fs accepts it on Windows too).
 */
export async function listLibraryImages() {
  const nat = window.sbsNative;
  const folder = getLibraryFolder();
  if (!nat?.listDir || !folder) return [];
  const entries = await nat.listDir(folder);
  if (!entries) return [];
  return entries
    .filter(e => !e.isDir && IMG_EXT.has((e.name.split('.').pop() || '').toLowerCase()))
    .map(e => ({ name: e.name, path: `${folder}/${e.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Default pose (shared by every interface, every step) ────────────────────
// { x, y, width, height } in Konva/overlay coords. Runtime for now; persistence
// lands in a later phase.
export function getDefaultPose() { return state.get('interfaceDefaultPose') || null; }
export function setDefaultPose(pose) {
  state.setState({ interfaceDefaultPose: pose ? { ...pose } : null });
}

// Full Konva geometry (Konva resizes via scaleX/scaleY, so we must carry scale
// + rotation, not just width/height, or reset would lose the user's resize).
function _geomOf(node) {
  return {
    x: node.x(), y: node.y(),
    width: node.width(), height: node.height(),
    scaleX: node.scaleX(), scaleY: node.scaleY(),
    rotation: node.rotation(),
  };
}
function _applyGeom(node, g) {
  if (!node || !g) return;
  node.position({ x: g.x, y: g.y });
  if (g.width  != null) node.width(g.width);
  if (g.height != null) node.height(g.height);
  node.scaleX(g.scaleX ?? 1);
  node.scaleY(g.scaleY ?? 1);
  node.rotation(g.rotation ?? 0);
  // Bonded shapes follow from their stored % — re-derives both position AND
  // size against the interface's new bbox (default / reset scales them too).
  if (isInterfaceNode(node)) overlay.syncBondedShapes?.(node);
  node.getLayer()?.batchDraw();
}

/** Read a library image file → data URL (the form overlay.addImage round-trips).
 *  fs:readFile returns an envelope { ok, data } — NOT the string directly. */
export async function loadImageDataUrl(imgPath, name) {
  const nat = window.sbsNative;
  if (!nat?.readFile) return null;
  let result;
  try { result = await nat.readFile(imgPath, 'base64'); }
  catch { return null; }
  if (!result?.ok || typeof result.data !== 'string' || !result.data) return null;
  const ext = (name || imgPath).split('.').pop().toLowerCase();
  return `data:image/${MIME[ext] || 'png'};base64,${result.data}`;
}

/**
 * Insert the FIRST library image as an interface overlay at the default pose.
 * On the very first insert (no default yet) the centred placement BECOMES the
 * default. The node is tagged ('interface' name + isInterface/interfaceImage
 * attrs) so later phases can find it + know which image it shows.
 * Returns { ok, node?, name?, error? }.
 */
export async function insertFirstInterface() {
  const folder = getLibraryFolder();
  if (!folder) return { ok: false, error: 'no library folder' };
  const imgs = await listLibraryImages();
  if (!imgs.length) return { ok: false, error: 'no images in the library folder' };
  const first = imgs[0];
  const dataUrl = await loadImageDataUrl(first.path, first.name);
  if (!dataUrl) return { ok: false, error: 'could not read the image file' };

  let node;
  try { node = await overlay.addImage(dataUrl); }
  catch (e) { return { ok: false, error: `image load failed: ${e?.message || e}` }; }
  if (!node) return { ok: false, error: 'overlay is not in edit mode' };

  node.addName?.('interface');
  node.setAttr('isInterface', true);
  node.setAttr('interfaceImage', first.name);

  const def = getDefaultPose();
  if (def) _applyGeom(node, def);
  else     setDefaultPose(_geomOf(node));
  node.setAttr('atDefault', true);   // born at the default condition
  return { ok: true, node, name: first.name };
}

/** True if a Konva node is one of our interface overlays. */
export function isInterfaceNode(node) {
  return !!(node && (node.getAttr?.('isInterface') || node.hasName?.('interface')));
}

/** Load an HTMLImageElement from a data URL (resolves null on error). */
function _loadImageEl(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Swap the image shown by an interface node to a different library image,
 * keeping its current pose. Updates the round-tripped `src` + `interfaceImage`
 * attrs. Returns true on success.
 */
export async function swapInterfaceImage(node, imgPath, name) {
  if (!node) return false;
  const dataUrl = await loadImageDataUrl(imgPath, name);
  if (!dataUrl) return false;
  const img = await _loadImageEl(dataUrl);
  if (!img) return false;
  node.image(img);
  node.setAttr('src', dataUrl);
  node.setAttr('interfaceImage', name);
  node.setAttr('naturalW', img.width);
  node.setAttr('naturalH', img.height);
  node.getLayer()?.batchDraw();
  overlay.scheduleSave?.();   // persist the new image into step.overlay (else it reverts on reload)
  return true;
}

/**
 * Open a thumbnail picker over the library folder. Resolves the chosen
 * { name, path }, or null if cancelled / empty.
 */
export async function pickFromLibrary() {
  const imgs = await listLibraryImages();
  if (!imgs.length) return null;
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.style.cssText = [
      'border:1px solid var(--line,#334)', 'border-radius:10px',
      'background:var(--panel,#0f172a)', 'color:var(--text,#e2e8f0)',
      'padding:14px', 'max-width:560px', 'width:80vw', 'max-height:80vh',
    ].join(';');
    const title = document.createElement('div');
    title.textContent = `Pick an interface (${imgs.length})`;
    title.style.cssText = 'font-size:13px;margin-bottom:10px;opacity:0.85;';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;overflow:auto;max-height:60vh;';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.className = 'btn';
    cancel.style.cssText = 'margin-top:12px;';

    const cleanup = (val) => { try { dlg.close(); } catch {} dlg.remove(); resolve(val); };
    for (const im of imgs) {
      const cell = document.createElement('button');
      cell.title = im.name;
      cell.style.cssText = 'display:flex;flex-direction:column;gap:4px;align-items:center;background:var(--panel2,#1e293b);border:1px solid var(--line,#334);border-radius:6px;padding:6px;cursor:pointer;';
      const el = document.createElement('img');
      el.style.cssText = 'width:100%;height:78px;object-fit:contain;background:rgba(0,0,0,0.2);border-radius:4px;';
      loadImageDataUrl(im.path, im.name).then(url => { if (url) el.src = url; });
      const cap = document.createElement('div');
      cap.textContent = im.name;
      cap.style.cssText = 'font-size:10px;opacity:0.75;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      cell.append(el, cap);
      cell.addEventListener('click', () => cleanup(im));
      grid.appendChild(cell);
    }
    cancel.addEventListener('click', () => cleanup(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); cleanup(null); });
    dlg.append(title, grid, cancel);
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

/** Right-click → Change image: pick from the library, then swap. */
export async function changeInterfaceImage(node) {
  if (!isInterfaceNode(node)) return false;
  const pick = await pickFromLibrary();
  if (!pick) return false;
  return swapInterfaceImage(node, pick.path, pick.name);
}

/** Right-click → Reset to default position: snap THIS interface to the default
 *  pose and put it back INTO the default condition. */
export function resetToDefault(node) {
  const def = getDefaultPose();
  if (!def || !isInterfaceNode(node)) return false;
  _applyGeom(node, def);
  node.setAttr('atDefault', true);
  overlay.scheduleSave?.();
  return true;
}

/**
 * Right-click → Update default position: make this interface's CURRENT pose the
 * new shared default, then re-snap every OTHER interface that is still in the
 * default condition (atDefault) to it — interfaces you've deliberately moved are
 * left where they are. (Re-snap across ALL steps arrives with the persistence
 * slice.) Returns { ok, count }.
 */
export function updateDefaultFromNode(node) {
  if (!isInterfaceNode(node)) return { ok: false, count: 0, steps: 0 };
  const pose = _geomOf(node);
  setDefaultPose(pose);
  node.setAttr('atDefault', true);   // the node that defines the default IS at default

  // 1) Live (active) step — re-snap every other at-default interface, then write
  //    the active step's overlay JSON NOW (its nodes already moved).
  let count = 1;
  for (const other of overlay.getInterfaceNodes?.() || []) {
    if (other !== node && other.getAttr('atDefault')) { _applyGeom(other, pose); count++; }
  }
  overlay.flushSave?.();

  // 2) Every OTHER step — patch its saved overlay JSON in place so at-default
  //    interfaces there move too (the cascade). Non-default ones are left alone.
  const allSteps = state.get('steps') || [];
  const activeId = state.get('activeStepId');
  let stepsChanged = 1;
  for (const step of allSteps) {
    if (step.id === activeId || !step.overlay) continue;
    const r = _cascadeDefaultIntoStepJSON(step.overlay, pose);
    if (r.changed) { step.overlay = r.json; stepsChanged++; }
  }
  if (stepsChanged > 1) { state.setState({ steps: [...allSteps] }); state.markDirty?.(); }
  return { ok: true, count, steps: stepsChanged };
}

/** Patch a step's overlay JSON: move every at-default interface node to `pose`.
 *  Returns { json, changed }. Leaves moved (non-default) interfaces untouched. */
function _cascadeDefaultIntoStepJSON(json, pose) {
  let spec;
  try { spec = JSON.parse(json); } catch { return { json, changed: false }; }
  let changed = false;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const a = node.attrs;
    if (a && a.isInterface && a.atDefault) {
      a.x = pose.x; a.y = pose.y;
      a.width = pose.width; a.height = pose.height;
      a.scaleX = pose.scaleX; a.scaleY = pose.scaleY;
      a.rotation = pose.rotation;
      changed = true;
    }
    for (const c of (node.children || [])) walk(c);
  })(spec);
  return { json: changed ? JSON.stringify(spec) : json, changed };
}
