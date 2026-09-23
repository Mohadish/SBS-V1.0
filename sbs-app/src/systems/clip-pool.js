/**
 * SBS — THE CLIPBOARD POOL (V0.3.4.90, phase 1).
 * ─────────────────────────────────────────────
 * "A hidden pool, unified between all the SBS windows that are open: copy in one,
 * paste in another." The pool IS the operating system's clipboard. Every SBS copy
 * writes an ENVELOPE there, under a private format only SBS reads, and beside it
 * whatever a stranger can use — the plain text of a text box, the tab-separated
 * cells of a table — so a paste into Word or Excel still gets something sane.
 * Every SBS paste reads the envelope back. Two windows, two runs of the app, or
 * one window: one path.
 *
 *   envelope = { sbs: 1, kind, at, origin: { brand: {id, name, revision} | null,
 *                                            canonical: {width, height} },
 *                payload }
 *   kind     'overlay'      payload { items:[{spec, capturedAt}], defs, links }
 *            'tableCells'   payload { rows, cols, tsv, fmt, imgs }
 *
 * Copy from Word / Excel / a browser INTO SBS is untouched: that content carries
 * no envelope, readClip() says so, and the handlers that read text and pictures
 * off the clipboard run exactly as before. The envelope is only ever consulted
 * first, and only by a handler that knows its kind.
 *
 * THE DEFINITIONS AN OVERLAY ITEM POINTS AT (text style, shape style, constant
 * title, pinned position, crop mask) are ids of ONE project. The copy carries
 * the definitions themselves and their brand links; the paste resolves each:
 *   1. the id exists here (same project, same window)  → untouched
 *   2. both projects wear the same brand, and the definition is linked to a
 *      brand id the target also has                     → the TARGET's definition
 *      ("the collective's settings, not the copy's" — the user)
 *   3. a definition of the same name exists here        → the target's
 *   4. otherwise                                        → the copied definition is
 *      ADDED here as the project's own (the brand notice will say so)
 * "Paste with its own look" (break from the brand) is not built: it can be done
 * after the paste, on the definition.
 *
 * What cannot be read (a clipboard the browser will not hand over) falls back to
 * this window's own last copy; what CAN be read and holds no envelope means the
 * user copied something else since — the last copy is then stale and is NOT used.
 *
 * THE FRAME (V0.3.4.91). Overlay geometry is in CANONICAL pixels — the project's
 * export frame (safe-frame.js), not the screen. Two projects with different
 * export sizes (1280×720 and 1920×1080) put "the same place" at different
 * numbers, so the envelope carries the origin's frame and the paste FITS what it
 * gets by the ratio of the two frames — the rule the brand uses for its pinned
 * positions (brand-core mergeBrand) and the overlay uses when the export size is
 * changed (_rescaleOnCanonicalChange): positions per axis, text boxes per axis,
 * pictures / shapes / tables uniformly by the width ratio. A definition brought
 * along that owns a position (constant title, pinned position) is fitted the
 * same way. Text SIZES are definitions (a style's font size, a table's text
 * size) and stay as they are, exactly as they do when a brand is applied.
 */

import { state } from '../core/state.js';
import { generateId } from '../core/schema.js';
import { getCanonicalSize } from '../core/safe-frame.js';
import { SECTIONS, OVERLAY_ATTR, defHash } from './brand-core.js';

const TYPE = 'web application/x-sbs-clip';        // a custom web clipboard format (Chromium 104+)
const MAX_JSON = 48 * 1024 * 1024;                 // beyond this the clipboard write is not attempted
const ANCHOR_KIND = 'anchor3d';                    // anchored-shapes.js — a 3D-anchored arrow's points are derived per frame, never fitted
let _mirror = null;                                // this window's last envelope — the fallback when the clipboard cannot be read

const _origin = () => {
  const b = state.get('brand'), c = getCanonicalSize();
  return {
    brand: b?.id ? { id: b.id, name: b.name || '', revision: b.revision || 0 } : null,
    canonical: { width: c.width, height: c.height },
  };
};

/**
 * How much the origin's frame must be scaled to fit THIS project's: sx = width ratio, sy = height
 * ratio. An envelope without a frame (an older one) is taken as-is (1, 1).
 * @returns {{ sx:number, sy:number, same:boolean, from:{width:number,height:number}|null, to:{width:number,height:number} }}
 */
export function canonicalScale(env) {
  const from = env?.origin?.canonical, to = getCanonicalSize();
  const sx = from?.width  > 0 ? to.width  / from.width  : 1;
  const sy = from?.height > 0 ? to.height / from.height : 1;
  const same = Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6;
  return { sx, sy, same, from: from?.width > 0 && from?.height > 0 ? { width: from.width, height: from.height } : null, to: { width: to.width, height: to.height } };
}

const _num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Fit copied overlay items ({spec, capturedAt}) from the origin's frame into this one — the
 * overlay's own resolution-change rule, applied to serialised specs. Returns new objects; the
 * input is not touched. sx = sy = 1 returns the input.
 */
export function scaleOverlayItems(items, { sx, sy }) {
  if (!Array.isArray(items) || (Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9)) return items;
  return items.map(e => {
    const spec = e?.spec;
    if (!spec) return e;
    const a = { ...(spec.attrs || {}) };
    const cls = spec.className;
    const isText = typeof a.textHtml === 'string' && !!a.textHtml;
    if (_num(a.x)) a.x *= sx;
    if (_num(a.y)) a.y *= sy;
    if (a.kind === ANCHOR_KIND) {
      // its geometry comes from the two world points every frame; only its origin is a canvas position
    } else if (a.name === 'userShape') {
      // shapes keep their proportions (uniform sx): one radius behind a circle / a polygon, points behind a line / an arrow
      if (cls === 'Circle' || cls === 'RegularPolygon') { if (_num(a.radius)) a.radius *= sx; }
      else if (cls === 'Line' || cls === 'Arrow')       { if (Array.isArray(a.points)) a.points = a.points.map(v => (_num(v) ? v * sx : v)); }
      else if (cls === 'Ellipse')                       { if (_num(a.radiusX)) a.radiusX *= sx; if (_num(a.radiusY)) a.radiusY *= sx; }
      else                                              { if (_num(a.width)) a.width *= sx; if (_num(a.height)) a.height *= sx; }
    } else {
      // a text box follows the frame per axis (it reflows into the new aspect); a picture, a video, a table keeps its proportions
      const hR = isText ? sy : sx;
      if (_num(a.width))       a.width       *= sx;
      if (_num(a.height))      a.height      *= hR;
      if (_num(a.textWidth))   a.textWidth   *= sx;
      if (_num(a.tableWidth))  a.tableWidth  *= sx;
      if (_num(a.tableHeight)) a.tableHeight *= sx;
      if (a.isTable && a.tableData && Array.isArray(a.tableData.rowH)) a.tableData = { ...a.tableData, rowH: a.tableData.rowH.map(v => (_num(v) && v > 0 ? v * sx : v)) };
      // cropX/Y/W/H are pixels of the picture itself; a private cropMask is 0..1 of the frame already
    }
    const cap = e.capturedAt ? { ...e.capturedAt, x: (Number(e.capturedAt.x) || 0) * sx, y: (Number(e.capturedAt.y) || 0) * sy } : e.capturedAt;
    return { ...e, spec: { ...spec, attrs: a }, capturedAt: cap };
  });
}
const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Put an envelope on the clipboard, with a stranger-readable text beside it. Fire-and-forget. */
export async function writeClip(kind, payload, { text = '' } = {}) {
  const env = { sbs: 1, kind, at: Date.now(), origin: _origin(), payload };
  _mirror = env;
  let json;
  try { json = JSON.stringify(env); } catch (e) { console.warn('[clip] envelope not serialisable:', e?.message); return false; }
  if (json.length > MAX_JSON) { console.warn(`[clip] envelope too large for the clipboard (${(json.length / 1048576).toFixed(1)} MB) — this window only`); return false; }
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('no async clipboard');
    const parts = { [TYPE]: new Blob([json], { type: TYPE }) };
    if (text) {
      parts['text/plain'] = new Blob([text], { type: 'text/plain' });
      parts['text/html']  = new Blob([`<!--sbs-clip:${env.at}--><pre>${_esc(text)}</pre>`], { type: 'text/html' });
    }
    await navigator.clipboard.write([new ClipboardItem(parts)]);
    return true;
  } catch (e) {
    console.warn('[clip] clipboard write failed — this window only:', e?.message || e);
    return false;
  }
}

/**
 * The envelope on the clipboard, if it is one of `kinds`.
 * @returns {object|null|undefined}  null = the clipboard holds no SBS envelope (the user copied
 *   something else, or nothing); undefined = the clipboard could not be read, and this window's
 *   own last copy is returned in its place when it fits the kinds.
 */
export async function readClip(kinds = null) {
  const fits = (env) => env && env.sbs === 1 && typeof env.kind === 'string' && env.payload && (!kinds || kinds.includes(env.kind));
  try {
    if (!navigator.clipboard?.read) throw new Error('no async clipboard');
    const items = await navigator.clipboard.read();
    for (const it of items) {
      if (!it.types?.includes(TYPE)) continue;
      const env = _parse(await (await it.getType(TYPE)).text());
      return fits(env) ? env : null;
    }
    return null;
  } catch (e) {
    // could not read (permission, focus, a format the browser withholds): this window's own copy is the best there is
    return fits(_mirror) ? _mirror : undefined;
  }
}

function _parse(text) {
  try {
    const env = JSON.parse(text);
    if (!env || env.sbs !== 1 || typeof env.kind !== 'string' || !env.payload || typeof env.payload !== 'object') return null;
    return env;
  } catch { return null; }
}

/** The plain text of overlay specs — what a stranger gets: the text boxes' words, in order. */
export function overlayPlainText(specs) {
  const out = [];
  for (const s of specs || []) {
    const html = s?.attrs?.textHtml;
    if (typeof html !== 'string' || !html) continue;
    const t = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
    if (t) out.push(t);
  }
  return out.join('\n\n');
}

// ─── the definitions an overlay copy carries, and how a paste resolves them ──

/** The definitions the given specs point at, and their brand links — to ride in the envelope. */
export function collectDefs(specs) {
  const defs = {}, links = {};
  const brandLinks = state.get('brand')?.links || {};
  for (const sec of SECTIONS) {
    const attr = OVERLAY_ATTR[sec.key];
    if (!attr) continue;
    const ids = new Set();
    for (const s of specs || []) { const v = s?.attrs?.[attr]; if (v && v !== 'custom') ids.add(String(v)); }
    if (!ids.size) continue;
    const have = state.get(sec.stateKey) || [];
    defs[sec.key] = have.filter(d => ids.has(d.id)).map(d => JSON.parse(JSON.stringify(d)));
    for (const id of ids) { const b = brandLinks?.[sec.key]?.[id]?.brandId; if (b) (links[sec.key] ||= {})[id] = b; }
  }
  return { defs, links };
}

/**
 * Point every spec at a definition of THIS project, adding what is missing. Mutates state for the
 * added definitions and returns the undo/redo of that, so the caller can fold it into one entry.
 * @returns {{ specs: object[], added: Array<{section:string, name:string}>, undo: Function|null, redo: Function|null, note: string }}
 */
export function remapDefs(env, specs) {
  const out = (specs || []).map(s => ({ ...s, attrs: { ...(s?.attrs || {}) } }));
  const carried = env?.payload?.defs || {}, carriedLinks = env?.payload?.links || {};
  const myBrand = state.get('brand'), myLinks = myBrand?.links || {};
  const sameBrand = !!(myBrand?.id && env?.origin?.brand?.id && myBrand.id === env.origin.brand.id);
  const { sx, sy } = canonicalScale(env);   // a definition that owns a position is fitted into this project's frame (rule 4 only: the others are this project's already)
  const r2 = (v) => Math.round(v * 100) / 100;
  const before = {}, after = {}, added = [];
  for (const sec of SECTIONS) {
    const attr = OVERLAY_ATTR[sec.key];
    if (!attr) continue;
    const have = (state.get(sec.stateKey) || []).slice();
    const byBrandId = new Map();
    for (const d of have) { const b = myLinks?.[sec.key]?.[d.id]?.brandId; if (b) byBrandId.set(b, d.id); }
    const byName = new Map(have.map(d => [String(d.name || '').trim().toLowerCase(), d.id]));
    const resolved = new Map();          // copied id → this project's id
    let grew = false;
    for (const s of out) {
      const v = s.attrs[attr];
      if (!v || v === 'custom') continue;
      const id = String(v);
      if (resolved.has(id)) { s.attrs[attr] = resolved.get(id); continue; }
      let target = null;
      if (have.some(d => d.id === id)) target = id;                                              // 1. it is here already
      else if (sameBrand && carriedLinks?.[sec.key]?.[id] && byBrandId.has(carriedLinks[sec.key][id])) target = byBrandId.get(carriedLinks[sec.key][id]);   // 2. the same brand definition, this project's copy
      else {
        const def = (carried[sec.key] || []).find(d => d.id === id);
        if (def) {
          const nm = String(def.name || '').trim().toLowerCase();
          if (nm && byName.has(nm)) target = byName.get(nm);                                   // 3. the same name here
          else {                                                                               // 4. brought along, as this project's own
            const fresh = { ...JSON.parse(JSON.stringify(def)), id: generateId(sec.idPrefix) };
            if (sec.pos)  { if (_num(fresh.x)) fresh.x = r2(fresh.x * sx); if (_num(fresh.y)) fresh.y = r2(fresh.y * sy); }
            if (sec.size) { if (_num(fresh.w)) fresh.w = r2(fresh.w * sx); if (_num(fresh.h)) fresh.h = r2(fresh.h * sy); }
            have.push(fresh); grew = true;
            if (nm) byName.set(nm, fresh.id);
            added.push({ section: sec.label, name: def.name || '(unnamed)' });
            target = fresh.id;
          }
        }
      }
      if (target) { resolved.set(id, target); s.attrs[attr] = target; }
      // no definition carried and none here: the id is left as it is — the same dangling state a deleted definition leaves
    }
    if (grew) { before[sec.stateKey] = state.get(sec.stateKey) || []; after[sec.stateKey] = have; }
  }
  if (added.length) { state.setState(after); state.markDirty?.(); }
  const note = added.length ? `${added.length} definition${added.length === 1 ? '' : 's'} came along and ${added.length === 1 ? 'is' : 'are'} this project's own now: ${added.slice(0, 4).map(a => `${a.section} "${a.name}"`).join(', ')}${added.length > 4 ? '…' : ''}` : '';
  return {
    specs: out, added, note,
    undo: added.length ? () => { state.setState(before); state.markDirty?.(); } : null,
    redo: added.length ? () => { state.setState(after);  state.markDirty?.(); } : null,
  };
}

/** For debugging from the console. */
if (typeof window !== 'undefined') window.sbsClip = { read: readClip, write: writeClip, defHash, canonicalScale };
