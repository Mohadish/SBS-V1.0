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
import { reloadActiveOverlay, countAttrUsage, rebindOverlayAttr, restoreOverlayStrings } from './overlay.js';
import { SECTIONS, OVERLAY_ATTR, BRAND_VERSION, brandFormatOf, buildBrand, mergeBrand, suggestMapping, unlinkedCount, brandFromLegacyHeader, summarizeMerge, ownership, brandDrift, driftSince } from './brand-core.js';
import { openBrandMapDialog } from '../ui/brand-map-dialog.js';

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
  // 🔢 never write over a brand file of a NEWER format: this build would drop what it does not understand (see brandFormatOf)
  const there = await _formatOnDisk(path);
  if (there?.newer) {
    await chooseFromButtons('This brand file is from a newer SBS',
      `"${path}" was saved by a newer version of SBS (file format ${there.version}; this version writes format ${BRAND_VERSION}). Saving over it from here would silently drop everything in it that this version does not understand — and every project linked to the brand would then be told to update to the poorer file. Nothing was written. Save under a different file name, or update SBS.`,
      [{ id: 'ok', label: 'OK', primary: true }]);
    return null;
  }
  const w = await window.sbsNative.writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
  if (w && w.ok === false) { setStatus(`Could not write the brand: ${w.error}`, 'warn', 8000); return null; }
  state.setState({ brand: { id: meta.id, name: meta.name, revision: meta.revision, file: path, links } });
  state.markDirty();
  const total = SECTIONS.reduce((a, s) => a + (view.sections[s.key] || []).length, 0);
  setStatus(`Brand "${meta.name}" revision ${meta.revision} saved — ${total} definition(s). This project is linked to it.`, 'success', 8000);
  return path;
}

/** The format of a brand file already on disk — null when there is none, or it cannot be read as a brand. */
async function _formatOnDisk(path) {
  try {
    if (!window.sbsNative?.readFile) return null;
    if (window.sbsNative.fileExists && !(await window.sbsNative.fileExists(path))) return null;
    const rd = await window.sbsNative.readFile(path, 'utf8');
    if (!rd?.ok) return null;
    const b = JSON.parse(rd.data);
    return b?._sbsbrand ? brandFormatOf(b) : null;
  } catch { return null; }
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

  // 🔢 a brand from a NEWER SBS: reading is safe, and the user is told what that means before anything happens
  const fmt = brandFormatOf(brand);
  if (fmt.newer) {
    const c = await chooseFromButtons('This brand file is from a newer SBS',
      `This brand was saved by a newer version of SBS (file format ${fmt.version}; this version reads format ${BRAND_VERSION}). Everything this version understands will be loaded; anything newer in the file is left out. It is safe to load — but this version will refuse to save over that file.`,
      [{ id: 'go', label: 'Load what this version understands' }, { id: 'no', label: 'Cancel', primary: true }]);
    if (c !== 'go') return null;
  }

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

  // 🧩 V0.3.3.15 — definitions this project has that are not linked to the
  // brand yet need a human decision: which brand definition each really is
  // (several may fold into one), which stay the project's own, which go.
  let mapping;
  if (unlinkedCount(view, brand) > 0) {
    mapping = await openBrandMapDialog({ project: view, brand, suggestions: suggestMapping(view, brand), usage: _usageCounts(view.sections) });
    if (!mapping) return null;
  }

  const plan = mergeBrand(view, brand, { newId, mapping });
  const sum = summarizeMerge(plan.rows);
  const show = plan.rows.filter(r => r.action !== 'same');
  const verb = { update: 'update', link: 'becomes the brand definition', add: 'new', merge: 'merged', delete: 'delete', orphan: 'no longer in the brand — kept', 'skip-local': 'kept' };
  const rowsPreview = show.map(r => ({
    label: `${r.label} · ${r.name} · ${verb[r.action] || r.action}${r.localChanged ? ' · ⚠ edited in this project since the last brand load' : ''}`,
    from: r.before || '—', to: r.action === 'orphan' ? r.before : (r.after || '—'),
  }));
  const msg = `Brand "${meta.name}" revision ${meta.revision ?? '—'}${meta.legacy ? ' (header setup file)' : ''}. `
    + `${sum.update} to update, ${sum.link} matched to a brand definition, ${sum.merge || 0} merged into another, ${sum.delete || 0} deleted, ${sum.add} new, ${sum.same} already up to date, ${sum.orphan} no longer in the brand (kept). `
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
  const result = choice === 'safe' ? mergeBrand(view, brand, { newId, mapping, skipLocalChanged: true }) : plan;

  const before = { sections: _clone(view.sections), headerDefault: _clone(view.headerDefault), brand: _clone(link) };
  const after  = { sections: result.sections, headerDefault: result.headerDefault,
                   brand: { id: meta.id || link?.id || generateId('brand'), name: meta.name, revision: meta.revision || 0, file: path, links: result.links } };
  // Merged-away definitions: every overlay node bound to one follows its
  // target BEFORE the definitions change, so nothing is ever left pointing at
  // an id that no longer exists.
  let prevOverlays = _rebindAll(result.rebinds);
  _apply(after, result.changed);
  undoManager.push(`Update from brand "${meta.name}"`,
    () => { restoreOverlayStrings(prevOverlays); _apply(before, result.changed); },
    () => { prevOverlays = _rebindAll(result.rebinds); _apply(after, result.changed); });
  const merged = Object.values(result.rebinds || {}).reduce((a, l) => a + l.length, 0);
  setStatus(`Brand "${meta.name}" applied — ${sum.update + sum.link} matched / updated, ${merged} merged, ${sum.add} added.`, 'success', 8000);
  return path;
}

/** Re-stamp every overlay node bound to a merged-away definition; returns the strings to restore on undo. */
function _rebindAll(rebinds) {
  const prev = new Map();   // stepId → ORIGINAL overlay (first capture wins across sections)
  for (const sec of SECTIONS) {
    const pairs = rebinds?.[sec.key] || [];
    const attr = OVERLAY_ATTR[sec.key];
    if (!attr || !pairs.length) continue;
    for (const p of rebindOverlayAttr(attr, pairs).prev) if (!prev.has(p.id)) prev.set(p.id, p.overlay);
  }
  return [...prev].map(([id, overlay]) => ({ id, overlay }));
}

/** How much each project definition is used — overlay nodes, plus the definitions that reference a text style. */
function _usageCounts(sections) {
  const out = {};
  for (const sec of SECTIONS) {
    const m = out[sec.key] = new Map();
    const attr = OVERLAY_ATTR[sec.key];
    const ids = (sections[sec.key] || []).map(d => d.id);
    if (attr && ids.length) for (const [id, u] of countAttrUsage(attr, ids)) m.set(id, u.count);
  }
  for (const key of ['constTexts', 'headerItems']) {
    for (const d of sections[key] || []) {
      if (d.styleId && out.textStyles.has(d.styleId)) out.textStyles.set(d.styleId, (out.textStyles.get(d.styleId) || 0) + 1);
    }
  }
  return out;
}

function _setLink(meta, file, links) {
  const link = getBrandLink();
  const next = { id: meta.id || link?.id || null, name: meta.name, revision: meta.revision || 0, file, links };
  // "Already up to date" is the common case (every project open checks) — a load that changes
  // nothing must not leave the project asking to be saved, with no undo entry to explain why
  if (link && JSON.stringify(link) === JSON.stringify(next)) return;
  state.setState({ brand: next });
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

// ─── 🏷 "you changed a brand element" (V0.3.4.9) ─────────────────────────────
// A brand-linked definition edited here is the project's own business until the brand file is
// saved — but the user must KNOW it happened: one notice per definition per session, and a
// question before the window closes (the main process asks; it is told what is pending).
// Only what changed in THIS session counts: what was already different when the project opened
// was asked about in the session that changed it.

let _driftBase = new Map(), _driftTold = new Set(), _driftTimer = 0, _pendingSig = 'null';
const _driftKey = (r) => `${r.section}/${r.id}`;
function _driftNow() {
  const link = getBrandLink();
  return link?.id ? brandDrift(_projectSections(), link.links || {}) : [];
}
/** Brand elements edited in this session and not saved to the brand file. */
export function brandChangesThisSession() { return driftSince(_driftNow(), _driftBase); }

function _mirrorPending(rows) {
  const link = getBrandLink();
  const info = (link?.id && rows.length) ? { brand: String(link.name || ''), count: rows.length, names: rows.slice(0, 6).map(r => `${r.label} "${r.name}"`) } : null;
  const sig = JSON.stringify(info);
  if (sig === _pendingSig) return;
  _pendingSig = sig;
  try { window.sbsNative?.setBrandPending?.(info); } catch { /* no bridge before a full restart */ }
}
function _rebaseDrift() {
  clearTimeout(_driftTimer);
  _driftBase = new Map(_driftNow().map(r => [_driftKey(r), r.hash]));
  _driftTold = new Set();
  _mirrorPending([]);
}
function _checkDrift() {
  const rows = brandChangesThisSession();
  const fresh = rows.filter(r => !_driftTold.has(_driftKey(r)));
  for (const r of fresh) _driftTold.add(_driftKey(r));
  if (fresh.length) {
    const link = getBrandLink();
    const what = fresh.length === 1 ? `${fresh[0].label} "${fresh[0].name}" belongs` : `${fresh.length} elements you changed belong`;
    setStatus(`🏷 ${what} to the brand "${link?.name || ''}". The change is in this project only — Tools ▸ Brand… ▸ Save brand makes it the standard for every project.`, 'info', 14000);
  }
  _mirrorPending(rows);
}
const _scheduleDrift = () => { clearTimeout(_driftTimer); _driftTimer = setTimeout(_checkDrift, 900); };      // a slider drag is ONE change

let _inited = false;
export function initBrand() {
  if (_inited) return;
  _inited = true;
  for (const sec of SECTIONS) state.on(`change:${sec.stateKey}`, _scheduleDrift);
  state.on('change:brand', _scheduleDrift);
  state.on('project:loaded', _rebaseDrift);
  window.sbsNative?.onMenu?.('menu:brandSaveForClose', () => { saveBrand().catch(e => console.error('[brand] save failed:', e)); });
  _rebaseDrift();
  state.on('project:modelsSettled', async () => {
    const up = await checkBrandUpdate();
    if (up) setStatus(`Brand "${up.name}" has a newer revision on disk (r${up.fileRevision}, this project is at r${up.projectRevision}) — Tools ▸ Brand… to update.`, 'info', 12000);
  });
  if (typeof window !== 'undefined') window.sbsBrand = { save: saveBrand, load: loadBrand, check: checkBrandUpdate, overview: brandOverview, changes: brandChangesThisSession };
}
