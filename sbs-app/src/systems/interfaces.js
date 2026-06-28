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
  state.setState({ interfaceDefaultPose: pose ? { x: pose.x, y: pose.y, width: pose.width, height: pose.height } : null });
}

/** Read a library image file → data URL (the form overlay.addImage round-trips). */
export async function loadImageDataUrl(imgPath, name) {
  const nat = window.sbsNative;
  if (!nat?.readFile) return null;
  const base64 = await nat.readFile(imgPath, 'base64');
  if (!base64) return null;
  const ext = (name || imgPath).split('.').pop().toLowerCase();
  return `data:image/${MIME[ext] || 'png'};base64,${base64}`;
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

  const node = await overlay.addImage(dataUrl);
  if (!node) return { ok: false, error: 'overlay is not in edit mode' };

  node.addName?.('interface');
  node.setAttr('isInterface', true);
  node.setAttr('interfaceImage', first.name);

  const def = getDefaultPose();
  if (def) {
    node.position({ x: def.x, y: def.y });
    node.width(def.width);
    node.height(def.height);
    node.getLayer()?.batchDraw();
  } else {
    setDefaultPose({ x: node.x(), y: node.y(), width: node.width(), height: node.height() });
  }
  return { ok: true, node, name: first.name };
}
