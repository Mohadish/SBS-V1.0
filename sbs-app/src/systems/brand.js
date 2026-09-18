/**
 * SBS — Brand kit wiring (V0.3.3.12, phase 1): save a .sbsbrand from the
 * project, load / update a project from one, remember the link, notice a
 * newer revision on disk. The merge itself is pure (brand-core.js).
 *
 * A brand carries: header items + header default, text styles, shape
 * styles, constant-title positions, pinned positions, shared crop masks.
 * Loading a newer revision updates LINKED definitions in place (project ids
 * never change, so every binding survives), adds what is new, keeps what the
 * brand dropped (reported), and never touches the project's own definitions.
 */

import { state }        from '../core/state.js';
import { undoManager }  from './undo.js';
import { setStatus }    from '../ui/status.js';
import { chooseFromButtons, chooseWithPreview, promptString } from '../ui/prompt.js';
import { generateId }   from '../core/schema.js';
import { getCanonicalSize } from '../core/safe-frame.js';
import { reloadActiveOverlay } from './overlay.js';
import { SECTIONS, buildBrand, mergeBrand, brandFromLegacyHeader, summarizeMerge, ownership } from './brand-core.js';

const BRAND_FILTER = [{ name: 'SBS Brand (.sbsbrand) / header setup (.sbsheader)', extensions: ['sbsbrand', 'sbsheader'] }];
const _clone = (v) => JSON.parse(JSON.stringify(v ?? null));

export function getBrandLink() { return state.get('brand') || null; }

function _projectSections() {
  const out = {};
  for (const sec of SECTIONS) out[sec.key] = state.get(sec.stateKey) || [];
  return out;
}

function _projectView() {
  const c = getCanonicalSize();
  return { sections: _projectSections(), links: getBrandLink()?.links || {}, headerDefault: state.get('headerDefault') || null, canonical: { width: c.width, height: c.height } };
}

/** Brand-owned / project-only / orphan counts per section, for the panel. */
export function brandOverview() {
  return ownership(_projectSections(), getBrandLink()?.links || {});
}

// ─── save ───────────────────────────────────────────────────────────────────

export async function saveBrand() {
  const link = getBrandLink();
  let meta = null, defaultPath = null;
  if (link?.id) {
    const c = await chooseFromButtons('Save brand',
      `This project is linked to the brand "${link.name}" (revision ${link.revision}). Update that brand — every project linked to it can then be brought up to the new standard — or start a new one?`,
      [{ id: 'update', label: `Update "${link.name}" → revision ${link.revision + 1}`, primary: true }, { id: 'new', label: 'Save as a NEW brand…' }, { id: 'cancel', label: 'Cancel' }]);
    if (!c || c === 'cancel') return null;
    if (c === 'update') { meta = { id: link.id, name: link.name, revision: (link.revision || 0) + 1 }; defaultPath = link.file || null; }
  }
  if (!meta) {
    const name = await promptString('Brand name (the company / standard this file represents)', link?.name ? `${link.name} 2` : 'My brand');
    if (!name) return null;
    meta = { id: generateId('brand'), name: name.trim(), revision: 1 };
  }
  meta.saved = new Date().toISOString();
  const view = _projectView();
  const { payload, links } = buildBrand({ meta, canonical: view.canonical, sections: view.sections, headerDefault: view.headerDefault, links: meta.id === link?.id ? view.links : {} });
  const path = await window.sbsNative.saveFile({ title: 'Save brand', defaultPath: defaultPath || `${meta.name}.sbsbrand`, filters: [{ name: 'SBS Brand', extensions: ['sbsbrand'] }] });
  if (!path) return null;
  const w = await window.sbsNative.writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  if (w && w.ok === false) { setStatus(`Could not write the brand: ${w.error}`, 'warn', 8000); return null; }
  state.setState({ brand: { id: meta.id, name: meta.name, revision: meta.revision, file: path, links } });
  state.markDirty();
  const total = SECTIONS.reduce((a, s) => a + (view.sections[s.key] || []).length, 0);
  setStatus(`Brand "${meta.name}" revision ${meta.revision} saved — ${total} definition(s). This project is linked to it.`, 'success', 8000);
  return path;
}

// ─── load / update ──────────────────────────────────────────────────────────

export async function loadBrand(pathOverride = null) {
  const path = pathOverride || await window.sbsNative.openFile({ title: 'Load / update from a brand', filters: BRAND_FILTER });
  if (!path) return null;
  const rd = await window.sbsNative.readFile(path, 'utf8');
  if (!rd?.ok) { setStatus(`Could not read the file: ${rd?.error || 'unknown error'}`, 'warn', 8000); return null; }
  let brand;
  try { brand = JSON.parse(rd.data); } catch (e) { setStatus(`Not a brand file (bad JSON): ${e?.message || e}`, 'warn', 8000); return null; }
  if (brand?._sbsheader && !brand._sbsbrand) brand = brandFromLegacyHeader(brand);
  if (!brand?._sbsbrand) { setStatus('That file is neither a .sbsbrand nor a .sbsheader.', 'warn', 8000); return null; }

  const link = getBrandLink();
  const meta = brand._sbsbrand;
  if (link?.id && meta.id && link.id !== meta.id) {
    const c = await chooseFromButtons('Different brand',
      `This project is linked to "${link.name}". Loading "${meta.name}" re-links it: definitions with the same name are taken over, the rest are added.`,
      [{ id: 'go', label: `Switch to "${meta.name}"`, danger: true }, { id: 'no', label: 'Cancel', primary: true }]);
    if (c !== 'go') return null;
  }
  // A different brand starts from a clean link map (its ids mean nothing here).
  const view = _projectView();
  if (link?.id && meta.id && link.id !== meta.id) view.links = {};
  const newId = (prefix) => generateId(prefix);

  const plan = mergeBrand(view, brand, { newId });
  const sum = summarizeMerge(plan.rows);
  const show = plan.rows.filter(r => r.action !== 'same');
  const verb = { update: 'update', link: 'take over (same name)', add: 'new', orphan: 'no longer in the brand — kept', 'skip-local': 'kept' };
  const rowsPreview = show.map(r => ({
    label: `${r.label} · ${r.name} · ${verb[r.action] || r.action}${r.localChanged ? ' · ⚠ edited in this project since the last brand load' : ''}`,
    from: r.before || '—', to: r.action === 'orphan' ? r.before : (r.after || '—'),
  }));
  const msg = `Brand "${meta.name}" revision ${meta.revision ?? '—'}${meta.legacy ? ' (header setup file)' : ''}. `
    + `${sum.update} to update, ${sum.link} taken over by name, ${sum.add} new, ${sum.same} already up to date, ${sum.orphan} no longer in the brand (kept). `
    + `The project's own definitions are not touched.${sum.localChanged ? ` ${sum.localChanged} were edited in this project since the last brand load.` : ''}`;
  if (!show.length) {
    _setLink(meta, path, plan.links);
    setStatus(`Already up to date with "${meta.name}" revision ${meta.revision ?? '—'}.`, 'info', 6000);
    return path;
  }
  const buttons = [{ id: 'all', label: 'Apply', primary: true }];
  if (sum.localChanged) buttons.push({ id: 'safe', label: 'Apply, but keep what I edited here' });
  buttons.push({ id: 'cancel', label: 'Cancel' });
  const choice = await chooseWithPreview(`Update from brand "${meta.name}"`, msg, rowsPreview, buttons);
  if (!choice || choice === 'cancel') return null;
  const result = choice === 'safe' ? mergeBrand(view, brand, { newId, skipLocalChanged: true }) : plan;

  const before = { sections: _clone(view.sections), headerDefault: _clone(view.headerDefault), brand: _clone(link) };
  const after  = { sections: result.sections, headerDefault: result.headerDefault,
                   brand: { id: meta.id || link?.id || generateId('brand'), name: meta.name, revision: meta.revision || 0, file: path, links: result.links } };
  _apply(after, result.changed);
  undoManager.push(`Update from brand "${meta.name}"`,
    () => _apply(before, result.changed),
    () => _apply(after, result.changed));
  setStatus(`Brand "${meta.name}" applied — ${sum.update + sum.link} updated, ${sum.add} added.`, 'success', 8000);
  return path;
}

function _setLink(meta, file, links) {
  const link = getBrandLink();
  state.setState({ brand: { id: meta.id || link?.id || null, name: meta.name, revision: meta.revision || 0, file, links } });
  state.markDirty();
}

/** Write a whole definitions snapshot and make the live scene follow. */
function _apply(snap, changed) {
  const patch = { brand: snap.brand ? _clone(snap.brand) : null };
  for (const sec of SECTIONS) patch[sec.stateKey] = _clone(snap.sections[sec.key] || []);
  if (snap.headerDefault) patch.headerDefault = _clone(snap.headerDefault);
  state.setState(patch);
  state.markDirty();
  // Live followers: bound text boxes re-raster, shapes re-resolve, the header
  // layer redraws, and the active step's overlay reloads so constant titles,
  // pins and masks snap to their (possibly moved) definitions.
  for (const id of changed?.styleTemplates || []) state.emit('styleTemplate:updated', { id });
  for (const id of changed?.shapeStyles || [])    state.emit('shapeStyle:updated', { id });
  try { reloadActiveOverlay(); } catch (e) { console.warn('[brand] overlay reload failed:', e?.message || e); }
}

export function unlinkBrand() {
  const link = getBrandLink();
  if (!link) return;
  state.setState({ brand: null });
  state.markDirty();
  undoManager.push(`Unlink brand "${link.name}"`, () => { state.setState({ brand: _clone(link) }); state.markDirty(); }, () => { state.setState({ brand: null }); state.markDirty(); });
  setStatus(`Unlinked from "${link.name}". The definitions stay; they are the project's own now.`, 'info', 6000);
}

// ─── newer revision on disk? ────────────────────────────────────────────────

/** @returns {Promise<{name:string, fileRevision:number, projectRevision:number, file:string}|null>} */
export async function checkBrandUpdate() {
  const link = getBrandLink();
  if (!link?.file || !window.sbsNative?.readFile) return null;
  try {
    if (window.sbsNative.fileExists && !(await window.sbsNative.fileExists(link.file))) return null;
    const rd = await window.sbsNative.readFile(link.file, 'utf8');
    if (!rd?.ok) return null;
    const meta = JSON.parse(rd.data)?._sbsbrand;
    if (!meta || meta.id !== link.id) return null;
    if ((meta.revision || 0) > (link.revision || 0)) return { name: link.name, fileRevision: meta.revision, projectRevision: link.revision || 0, file: link.file };
  } catch { /* unreadable brand file — nothing to report */ }
  return null;
}

let _inited = false;
export function initBrand() {
  if (_inited) return;
  _inited = true;
  state.on('project:modelsSettled', async () => {
    const up = await checkBrandUpdate();
    if (up) setStatus(`Brand "${up.name}" has a newer revision on disk (r${up.fileRevision}, this project is at r${up.projectRevision}) — Tools ▸ Brand… to update.`, 'info', 12000);
  });
  if (typeof window !== 'undefined') window.sbsBrand = { save: saveBrand, load: loadBrand, check: checkBrandUpdate, overview: brandOverview };
}
