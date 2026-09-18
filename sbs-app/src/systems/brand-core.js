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

/**
 * Plan AND compute the merge of a brand into a project.
 *
 * Matching per brand definition: a project def already linked to that brand
 * id → UPDATE in place (project id kept, so every binding survives); else an
 * UNLINKED project def of the same section with the exact same name → LINK
 * (and update); else ADD. Linked project defs the brand no longer carries
 * are ORPHANS — kept, reported. Unlinked project defs are the project's own
 * ("utility") and never touched.
 *
 * @param {Object} project   { sections:{secKey:defs[]}, links, headerDefault, canonical:{width,height} }
 * @param {Object} brand     parsed .sbsbrand payload
 * @param {Object} opts      { newId:(prefix)=>string, skipLocalChanged?:boolean }
 * @returns {{rows:Array, sections:Object, links:Object, headerDefault:Object|null, changed:{[stateKey]:string[]}}}
 */
export function mergeBrand(project, brand, opts = {}) {
  const newId = opts.newId || ((p) => `${p}_${Math.random().toString(36).slice(2, 10)}`);
  const bc = brand?._sbsbrand?.canonical, pc = project.canonical;
  const sx = bc && pc && bc.width  ? pc.width  / bc.width  : 1;
  const sy = bc && pc && bc.height ? pc.height / bc.height : 1;
  const rows = [];
  const outSections = {}, outLinks = {}, changed = {};
  const brandToProject = {};   // section → Map(brandId → projectId)

  for (const sec of SECTIONS) {
    const cur = (project.sections?.[sec.key] || []).map(_clone);
    const links = { ...(project.links?.[sec.key] || {}) };
    const bdefs = brand?.sections?.[sec.key] || [];
    const byBrandId = new Map();                       // brandId → project def
    for (const d of cur) { const l = links[d.id]; if (l?.brandId) byBrandId.set(l.brandId, d); }
    const claimed = new Set();
    const map = brandToProject[sec.key] = new Map();
    const touched = [];

    for (const b of bdefs) {
      let target = byBrandId.get(b.id) || null;
      let action = target ? 'update' : null;
      if (!target) {
        target = cur.find(d => !links[d.id]?.brandId && !claimed.has(d.id) && (d.name || '') !== '' && d.name === b.name) || null;
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
        touched.push(id);
        rows.push({ section: sec.key, label: sec.label, action: 'add', name: b.name || b.kind || b.id, projectId: id, brandId: b.id, localChanged: false, before: '', after: _summary(sec.key, added) });
        continue;
      }
      claimed.add(target.id);
      map.set(b.id, target.id);
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
      touched.push(target.id);
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
    changed[sec.stateKey] = touched;
  }
  const headerDefault = brand?.headerDefault ? { ...(project.headerDefault || {}), ..._clone(brand.headerDefault) } : (project.headerDefault || null);
  return { rows, sections: outSections, links: outLinks, headerDefault, changed };
}

/** Counts for the preview line. */
export function summarizeMerge(rows) {
  const s = { update: 0, link: 0, add: 0, same: 0, orphan: 0, skipLocal: 0, localChanged: 0 };
  for (const r of rows) {
    if (r.action === 'skip-local') s.skipLocal++; else s[r.action] = (s[r.action] || 0) + 1;
    if (r.localChanged) s.localChanged++;
  }
  return s;
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
