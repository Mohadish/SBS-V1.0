/**
 * SBS — Brand kit: the PURE part (V0.3.3.12, phase 1).
 * ─────────────────────────────────────────────────────
 * A .sbsbrand file is a company's standard: header layout + default, text
 * and shape styles, constant-title positions, pinned positions, shared crop
 * masks. Its definitions carry STABLE ids, so loading a newer revision
 * UPDATES a linked project in place — every box bound to a style keeps its
 * binding because the project-side id never changes.
 *
 * The project ↔ brand link is kept OUTSIDE the definitions
 * (brand.links[section][projectId] = { brandId, hash }): stamping the defs
 * themselves would change their signatures, which stars every step using
 * them and re-keys the render cache for nothing.
 *
 * No app imports; tested offline.
 */

export const BRAND_VERSION = 1;

/**
 * 🔢 The file's FORMAT number — and whether this build can be trusted to write it back.
 *
 * BRAND_VERSION was written into every brand file and read by nothing. That is harmless
 * while there is one format, and a data-loss trap the day there are two: a build reads only
 * the sections IT knows (every read is `brand.sections[key] || []`), and SAVING a brand writes
 * only those — so an older build updating a newer brand silently drops what it does not
 * understand, bumps the revision, and every linked project is then told to update to the
 * poorer file. The gate has to exist BEFORE the format grows, or no shipped build has it.
 *   Reading a newer file is safe (what is not understood is ignored). WRITING over one is not.
 */
export function brandFormatOf(brand) {
  const n = Number(brand?._sbsbrand?.version);
  const version = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;      // files from before the field mattered are format 1
  return { version, newer: version > BRAND_VERSION };
}

/** Brand section → the state key it lives under, how to label it, what it references, what scales. */
export const SECTIONS = [
  { key: 'textStyles',  stateKey: 'styleTemplates', label: 'Text style',      idPrefix: 'style' },
  { key: 'shapeStyles', stateKey: 'shapeStyles',    label: 'Shape style',     idPrefix: 'shapestyle' },
  { key: 'constTexts',  stateKey: 'constTextBoxes', label: 'Constant title',  idPrefix: 'const',  refs: [{ field: 'styleId', section: 'textStyles' }], pos: true },
  { key: 'constShapes', stateKey: 'constShapes',    label: 'Pinned position', idPrefix: 'pin',    pos: true },
  { key: 'cropMasks',   stateKey: 'cropMasks',      label: 'Crop mask',       idPrefix: 'mask' },          // already normalized 0..1
  { key: 'headerItems', stateKey: 'headerItems',    label: 'Header item',     idPrefix: 'hdr',    refs: [{ field: 'styleId', section: 'textStyles' }], pos: true, size: true },
];
const PASSTHROUGH_REFS = new Set(['', 'custom', null, undefined]);

// ─── hashing ────────────────────────────────────────────────────────────────

function _stable(v) {
  if (Array.isArray(v)) return `[${v.map(_stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${_stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** Content fingerprint of a definition — everything but its id. */
export function defHash(def) {
  const { id, ...rest } = def || {};
  void id;
  const s = _stable(rest);
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (((h2 << 5) + h2) ^ c) >>> 0;
  }
  return `${h1.toString(36)}.${h2.toString(36)}.${s.length.toString(36)}`;
}

const _clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const _round = (n) => Math.round(n * 100) / 100;

// ─── build (project → brand file) ───────────────────────────────────────────

/**
 * @param {Object} p
 * @param {{id:string,name:string,revision:number}} p.meta
 * @param {{width:number,height:number}} p.canonical      the project's export frame
 * @param {Object<string, Array>} p.sections              brand section key → project defs
 * @param {Object} [p.headerDefault]
 * @param {Object} [p.links]                              existing brand.links (may be empty)
 * @returns {{payload:Object, links:Object}} links = the project's link map AFTER this save
 */
export function buildBrand({ meta, canonical, sections, headerDefault = null, links = {} }) {
  const outLinks = {};
  const brandIdOf = {};   // section → Map(projectId → brandId)
  for (const sec of SECTIONS) {
    brandIdOf[sec.key] = new Map();
    for (const d of sections[sec.key] || []) brandIdOf[sec.key].set(d.id, links?.[sec.key]?.[d.id]?.brandId || d.id);
  }
  const payloadSections = {};
  for (const sec of SECTIONS) {
    outLinks[sec.key] = {};
    payloadSections[sec.key] = (sections[sec.key] || []).map(d => {
      const out = _clone(d);
      out.id = brandIdOf[sec.key].get(d.id);
      for (const r of sec.refs || []) {
        const v = d[r.field];
        if (!PASSTHROUGH_REFS.has(v)) out[r.field] = brandIdOf[r.section].get(v) ?? v;
      }
      outLinks[sec.key][d.id] = { brandId: out.id, hash: defHash(d) };
      return out;
    });
  }
  return {
    payload: {
      _sbsbrand: { version: BRAND_VERSION, id: meta.id, name: meta.name, revision: meta.revision, saved: meta.saved || null,
                   canonical: canonical ? { width: canonical.width, height: canonical.height } : null },
      headerDefault: headerDefault ? _clone(headerDefault) : null,
      sections: payloadSections,
    },
    links: outLinks,
  };
}

/** A V1–3 .sbsheader payload as an (unlinked) brand. */
export function brandFromLegacyHeader(payload) {
  return {
    _sbsbrand: { version: BRAND_VERSION, id: null, name: '(header setup)', revision: 0, saved: payload?._sbsheader?.saved || null, canonical: null, legacy: true },
    headerDefault: payload?.default || null,
    sections: { textStyles: payload?.styles || [], headerItems: payload?.items || [], shapeStyles: [], constTexts: [], constShapes: [], cropMasks: [] },
  };
}

// ─── merge (brand file → project) ───────────────────────────────────────────

function _summary(secKey, d) {
  if (!d) return '';
  if (secKey === 'textStyles')  return [d.fontFamily, d.fontSize && `${d.fontSize}px`, d.color, d.fontWeight === 'bold' ? 'bold' : '', d.fontStyle === 'italic' ? 'italic' : '', d.fillColor ? `fill ${d.fillColor}` : ''].filter(Boolean).join(' · ');
  if (secKey === 'shapeStyles') return [d.fill ? `fill ${d.fill}` : 'no fill', d.stroke ? `outline ${d.stroke} ${d.strokeWidth ?? ''}` : 'no outline'].join(' · ');
  if (secKey === 'constTexts' || secKey === 'constShapes') return `${d.anchor === 'tr' ? '⌝' : '⌜'} ${_round(d.x ?? 0)}, ${_round(d.y ?? 0)}`;
  if (secKey === 'cropMasks')   return `${_round((d.x ?? 0) * 100)}%, ${_round((d.y ?? 0) * 100)}% · ${_round((d.w ?? 0) * 100)}% × ${_round((d.h ?? 0) * 100)}%${d.rot ? ` · ${_round(d.rot)}°` : ''}`;
  if (secKey === 'headerItems') return [d.kind, d.text ? `"${String(d.text).slice(0, 30)}"` : '', `${_round(d.x ?? 0)}, ${_round(d.y ?? 0)}`, d.src ? 'image' : ''].filter(Boolean).join(' · ');
  return '';
}

/** The overlay node attribute that binds a node to a definition of each section. */
export const OVERLAY_ATTR = { textStyles: 'styleId', shapeStyles: 'shapeStyleId', constTexts: 'constId', constShapes: 'constShapeId', cropMasks: 'cropMaskId' };

/**
 * Plan AND compute the merge of a brand into a project.
 *
 * Per brand definition: a project def already LINKED to that brand id →
 * UPDATE in place (project id kept, so every binding survives). For project
 * defs that are not linked yet there are two modes:
 *
 *   • opts.mapping given (the matching wizard, V0.3.3.15) — the user decides:
 *       mapping[section][projectDefId] = '<brandId>' | '@keep' | '@delete'
 *     The first project def mapped to a brand def becomes it (LINK, id kept);
 *     every further one mapped to the same brand def is MERGED into it — its
 *     id is rebound to the target everywhere (result.rebinds lists the
 *     overlay re-stamps to perform; references between definitions are
 *     re-pointed here) and the def is removed. '@keep' / unmapped = the
 *     project's own, untouched. '@delete' = removed.
 *   • no mapping — the exact-name rule (header items: unique kind) of phase 1.
 *
 * Brand defs nothing maps to are ADDED. Linked defs the brand no longer
 * carries are ORPHANS — kept, reported.
 *
 * @param {Object} project   { sections:{secKey:defs[]}, links, headerDefault, canonical:{width,height} }
 * @param {Object} brand     parsed .sbsbrand payload
 * @param {Object} opts      { newId:(prefix)=>string, skipLocalChanged?:boolean, mapping?:Object }
 * @returns {{rows:Array, sections:Object, links:Object, headerDefault:Object|null,
 *            changed:{[stateKey]:string[]}, rebinds:{[secKey]:Array<{from,into}>}, deleted:{[secKey]:string[]}}}
 */
export function mergeBrand(project, brand, opts = {}) {
  const newId = opts.newId || ((p) => `${p}_${Math.random().toString(36).slice(2, 10)}`);
  const bc = brand?._sbsbrand?.canonical, pc = project.canonical;
  const sx = bc && pc && bc.width  ? pc.width  / bc.width  : 1;
  const sy = bc && pc && bc.height ? pc.height / bc.height : 1;
  const rows = [];
  const outSections = {}, outLinks = {}, changed = {}, rebinds = {}, deleted = {};
  const brandToProject = {};   // section → Map(brandId → projectId)
  const absorbedInto   = {};   // section → Map(absorbed project id → target project id)

  for (const sec of SECTIONS) {
    let cur = (project.sections?.[sec.key] || []).map(_clone);
    const links = { ...(project.links?.[sec.key] || {}) };
    const bdefs = brand?.sections?.[sec.key] || [];
    const mapSec = opts.mapping ? (opts.mapping[sec.key] || {}) : null;
    const touched = new Set();
    rebinds[sec.key] = []; deleted[sec.key] = [];
    absorbedInto[sec.key] = new Map();

    // References to definitions that an EARLIER section merged away follow their target.
    for (const d of cur) {
      for (const r of sec.refs || []) {
        const into = absorbedInto[r.section]?.get(d[r.field]);
        if (into) { d[r.field] = into; touched.add(d.id); }
      }
    }
    // '@delete' first, so a deleted def can never be picked as a target.
    if (mapSec) {
      for (const d of cur.slice()) {
        if (mapSec[d.id] === '@delete' && !links[d.id]?.brandId) {
          cur = cur.filter(x => x !== d);
          deleted[sec.key].push(d.id);
          rows.push({ section: sec.key, label: sec.label, action: 'delete', name: d.name || d.kind || d.id, projectId: d.id, brandId: null, localChanged: false, before: _summary(sec.key, d), after: '' });
        }
      }
    }
    const byBrandId = new Map();                       // brandId → linked project def
    for (const d of cur) { const l = links[d.id]; if (l?.brandId) byBrandId.set(l.brandId, d); }
    const mappedTo = new Map();                        // brandId → unlinked project defs the user mapped to it
    if (mapSec) {
      for (const d of cur) {
        const t = mapSec[d.id];
        if (!t || t[0] === '@' || links[d.id]?.brandId) continue;
        if (!mappedTo.has(t)) mappedTo.set(t, []);
        mappedTo.get(t).push(d);
      }
    }
    const claimed = new Set();
    const map = brandToProject[sec.key] = new Map();
    const keyOf = (d) => sec.key === 'headerItems' ? (d.kind ? `kind:${d.kind}` : '') : (d.name || '');

    for (const b of bdefs) {
      let target = byBrandId.get(b.id) || null;
      let action = target ? 'update' : null;
      let absorb = [];
      if (mapSec) {
        const list = mappedTo.get(b.id) || [];
        if (target) absorb = list;
        else if (list.length) { target = list[0]; action = 'link'; absorb = list.slice(1); }
      } else if (!target) {
        const k = keyOf(b);
        if (k) {
          const cands = cur.filter(d => !links[d.id]?.brandId && !claimed.has(d.id) && keyOf(d) === k);
          if (sec.key === 'headerItems') {
            if (cands.length === 1 && bdefs.filter(x => keyOf(x) === k).length === 1) target = cands[0];
          } else {
            target = cands[0] || null;
          }
        }
        if (target) action = 'link';
      }
      // The brand's values, in this project's terms.
      const vals = _clone(b);
      delete vals.id;
      for (const r of sec.refs || []) {
        const v = b[r.field];
        if (!PASSTHROUGH_REFS.has(v)) vals[r.field] = brandToProject[r.section]?.get(v) ?? v;
      }
      if (sec.pos)  { if (typeof vals.x === 'number') vals.x = _round(vals.x * sx); if (typeof vals.y === 'number') vals.y = _round(vals.y * sy); }
      if (sec.size) { if (typeof vals.w === 'number') vals.w = _round(vals.w * sx); if (typeof vals.h === 'number') vals.h = _round(vals.h * sy); }

      if (!target) {
        const id = newId(sec.idPrefix);
        const added = { ...vals, id };
        cur.push(added);
        links[id] = { brandId: b.id, hash: defHash(added) };
        map.set(b.id, id);
        touched.add(id);
        rows.push({ section: sec.key, label: sec.label, action: 'add', name: b.name || b.kind || b.id, projectId: id, brandId: b.id, localChanged: false, before: '', after: _summary(sec.key, added) });
        continue;
      }
      claimed.add(target.id);
      map.set(b.id, target.id);
      // Everything else the user dropped on this brand def dissolves into the target.
      for (const a of absorb) {
        if (a === target) continue;
        cur = cur.filter(x => x !== a);
        delete links[a.id];
        absorbedInto[sec.key].set(a.id, target.id);
        rebinds[sec.key].push({ from: a.id, into: target.id });
        touched.add(target.id);
        rows.push({ section: sec.key, label: sec.label, action: 'merge', name: a.name || a.kind || a.id, projectId: a.id, brandId: b.id, into: target.id, localChanged: false, before: _summary(sec.key, a), after: `merged into "${b.name || b.kind || b.id}"` });
      }
      const merged = { ...vals, id: target.id };
      const localChanged = action === 'update' && !!links[target.id]?.hash && links[target.id].hash !== defHash(target);
      const same = defHash(merged) === defHash(target);
      if (same) {
        links[target.id] = { brandId: b.id, hash: defHash(target) };
        rows.push({ section: sec.key, label: sec.label, action: action === 'link' ? 'link' : 'same', name: target.name || b.name || b.kind || b.id, projectId: target.id, brandId: b.id, localChanged: false, before: _summary(sec.key, target), after: _summary(sec.key, target) });
        continue;
      }
      if (localChanged && opts.skipLocalChanged) {
        rows.push({ section: sec.key, label: sec.label, action: 'skip-local', name: target.name || b.name || b.id, projectId: target.id, brandId: b.id, localChanged: true, before: _summary(sec.key, target), after: _summary(sec.key, merged) });
        continue;
      }
      cur[cur.indexOf(target)] = merged;
      links[target.id] = { brandId: b.id, hash: defHash(merged) };
      touched.add(target.id);
      rows.push({ section: sec.key, label: sec.label, action, name: merged.name || b.kind || b.id, projectId: target.id, brandId: b.id, localChanged, before: _summary(sec.key, target), after: _summary(sec.key, merged) });
    }
    // Linked defs the brand dropped → orphans (kept).
    const brandIds = new Set(bdefs.map(b => b.id));
    for (const d of cur) {
      const l = links[d.id];
      if (l?.brandId && !brandIds.has(l.brandId) && !rows.some(r => r.section === sec.key && r.projectId === d.id)) {
        rows.push({ section: sec.key, label: sec.label, action: 'orphan', name: d.name || d.kind || d.id, projectId: d.id, brandId: l.brandId, localChanged: false, before: _summary(sec.key, d), after: _summary(sec.key, d) });
      }
    }
    outSections[sec.key] = cur;
    outLinks[sec.key] = links;
    changed[sec.stateKey] = [...touched].filter(id => cur.some(d => d.id === id));
  }
  const headerDefault = brand?.headerDefault ? { ...(project.headerDefault || {}), ..._clone(brand.headerDefault) } : (project.headerDefault || null);
  return { rows, sections: outSections, links: outLinks, headerDefault, changed, rebinds, deleted };
}

// ─── suggestions for the matching wizard ────────────────────────────────────

const _hex = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? m[1].toLowerCase() : String(c || '').toLowerCase(); };

/**
 * A first guess for the wizard: which brand definition each UNLINKED project
 * definition probably is. Exact name (case-insensitive) → 'name'; otherwise a
 * cautious similarity → 'similar' (same font + close size, same colours, same
 * anchor + close position, overlapping mask). Header items: a kind that is
 * unique on both sides. Anything else is left for the user.
 * @returns {{[secKey]: {[projectId]: {brandId:string, why:'name'|'similar'}}}}
 */
export function suggestMapping(project, brand) {
  const bc = brand?._sbsbrand?.canonical, pc = project.canonical;
  const sx = bc && pc && bc.width  ? pc.width  / bc.width  : 1;
  const sy = bc && pc && bc.height ? pc.height / bc.height : 1;
  const W = pc?.width || 1920, H = pc?.height || 1080;
  const out = {};
  for (const sec of SECTIONS) {
    const o = out[sec.key] = {};
    const bdefs = brand?.sections?.[sec.key] || [];
    const secLinks = project.links?.[sec.key] || {};
    const linkedBrandIds = new Set(Object.values(secLinks).map(l => l.brandId));
    const unlinked = (project.sections?.[sec.key] || []).filter(d => !secLinks[d.id]?.brandId);
    for (const d of unlinked) {
      if (sec.key === 'headerItems') {
        const bk = bdefs.filter(b => b.kind === d.kind), pk = unlinked.filter(x => x.kind === d.kind);
        if (bk.length === 1 && pk.length === 1 && !linkedBrandIds.has(bk[0].id)) o[d.id] = { brandId: bk[0].id, why: 'name' };
        continue;
      }
      const nm = String(d.name || '').trim().toLowerCase();
      let hit = nm ? bdefs.find(b => String(b.name || '').trim().toLowerCase() === nm) : null;
      if (hit) { o[d.id] = { brandId: hit.id, why: 'name' }; continue; }
      if (sec.key === 'textStyles') {
        hit = bdefs.find(b => b.fontFamily === d.fontFamily && Math.abs((b.fontSize || 16) - (d.fontSize || 16)) / Math.max(b.fontSize || 16, d.fontSize || 16) <= 0.25)
           || bdefs.find(b => _hex(b.color) === _hex(d.color) && !!b.fillColor === !!d.fillColor && (b.fontWeight || 'normal') === (d.fontWeight || 'normal'));
      } else if (sec.key === 'shapeStyles') {
        hit = bdefs.find(b => _hex(b.stroke) === _hex(d.stroke) || String(b.fill) === String(d.fill));
      } else if (sec.key === 'constTexts' || sec.key === 'constShapes') {
        let best = null, bestD = 0.08;
        for (const b of bdefs) {
          if ((b.anchor || 'tl') !== (d.anchor || 'tl')) continue;
          const dist = Math.hypot(((b.x || 0) * sx - (d.x || 0)) / W, ((b.y || 0) * sy - (d.y || 0)) / H);
          if (dist < bestD) { best = b; bestD = dist; }
        }
        hit = best;
      } else if (sec.key === 'cropMasks') {
        let best = null, bestI = 0.5;
        for (const b of bdefs) {
          const ix = Math.max(0, Math.min(b.x + b.w, d.x + d.w) - Math.max(b.x, d.x)), iy = Math.max(0, Math.min(b.y + b.h, d.y + d.h) - Math.max(b.y, d.y));
          const inter = ix * iy, uni = b.w * b.h + d.w * d.h - inter;
          const iou = uni > 0 ? inter / uni : 0;
          if (iou > bestI) { best = b; bestI = iou; }
        }
        hit = best;
      }
      if (hit) o[d.id] = { brandId: hit.id, why: 'similar' };
    }
  }
  return out;
}

/** How many of the project's definitions still need a decision (unlinked, in a section the brand covers). */
export function unlinkedCount(project, brand) {
  let n = 0;
  for (const sec of SECTIONS) {
    if (!(brand?.sections?.[sec.key] || []).length) continue;
    for (const d of project.sections?.[sec.key] || []) if (!project.links?.[sec.key]?.[d.id]?.brandId) n++;
  }
  return n;
}

export { _summary as summaryOf };

/** Counts for the preview line. */
export function summarizeMerge(rows) {
  const s = { update: 0, link: 0, add: 0, same: 0, orphan: 0, merge: 0, delete: 0, skipLocal: 0, localChanged: 0 };
  for (const r of rows) {
    if (r.action === 'skip-local') s.skipLocal++; else s[r.action] = (s[r.action] || 0) + 1;
    if (r.localChanged) s.localChanged++;
  }
  return s;
}

/**
 * 🏷 V0.3.4.9 — brand-linked definitions that no longer match what the brand last gave them
 * (or took from them): edited in this project since the last brand load / save. ONE comparison —
 * the definition's content hash against the hash its link remembers — so no definition editor
 * has to report anything, and an undo that restores the content clears it by itself.
 * @returns {Array<{section:string,label:string,id:string,name:string,hash:string}>}
 */
export function brandDrift(sections, links) {
  const out = [];
  for (const sec of SECTIONS) {
    const l = links?.[sec.key] || {};
    for (const d of sections?.[sec.key] || []) {
      const k = d && l[d.id];
      if (!k?.brandId || !k.hash) continue;
      const hash = defHash(d);
      if (hash !== k.hash) out.push({ section: sec.key, label: sec.label, id: d.id, name: String(d.name || d.kind || d.id), hash });
    }
  }
  return out;
}

/** Of the drift now, what is new against a baseline (Map "section/id" → hash, taken when the project opened): changed in THIS session. */
export function driftSince(drift, baseline) {
  return (drift || []).filter(r => baseline?.get?.(`${r.section}/${r.id}`) !== r.hash);
}

/** Brand-owned / project-only / orphan counts per section (the panel's overview). */
export function ownership(sections, links, brand = null) {
  const out = [];
  for (const sec of SECTIONS) {
    const defs = sections?.[sec.key] || [];
    const l = links?.[sec.key] || {};
    const brandIds = brand ? new Set((brand.sections?.[sec.key] || []).map(b => b.id)) : null;
    let owned = 0, own = 0, orphan = 0;
    for (const d of defs) {
      if (!l[d.id]?.brandId) { own++; continue; }
      if (brandIds && !brandIds.has(l[d.id].brandId)) orphan++; else owned++;
    }
    out.push({ key: sec.key, label: sec.label, brand: owned, project: own, orphan });
  }
  return out;
}
