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

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']);

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
