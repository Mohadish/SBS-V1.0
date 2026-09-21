/**
 * SBS — the LOOK of a document, as something that can travel (V0.3.4.76).
 * ────────────────────────────────────────────────────────────────────────
 * A company's printed manuals look alike: the same page layouts, the same
 * header and footer, the same watermark, the same company name. That look now
 * travels inside the brand file (.sbsbrand, format 2) as ONE block:
 *
 *   look = { templates[], defaultTemplate, header, footer, bands, assets{},
 *            watermark, company, options{} }
 *
 * WHY A BLOCK AND NOT BRAND "SECTIONS". The brand's sections are flat lists of
 * definitions under top-level state keys, matched through a link map and a
 * drag-and-drop wizard. A document is ONE nested record, half of it singletons
 * (there is one header, one watermark): forced into that machinery, a section
 * row pointing at `document` would have overwritten the whole document with one
 * of its parts. So the look is handled like the brand's header default — brand
 * wins, previewed first, one undo — and page templates are matched by NAME.
 *
 * WHAT NEVER TRAVELS: pages, texts, custom numbers, hidden steps, extra pages,
 * the title / document no. / revision — they are this project's content — and
 * two options that are derived from one project's content (reading direction,
 * the interface framing correction).
 *
 * THREE THINGS THAT WOULD HAVE GONE WRONG SILENTLY:
 *   • a header picture is only an ASSET ID. Copied without the asset it prints
 *     as a grey box, with no warning. The look carries the pictures its header
 *     and footer use, and lands them under ids of the receiving project.
 *   • a header item may show a STEP of the animation. That means nothing in
 *     another project — such items are left out, on the way out AND in.
 *   • brand data ends up in style attributes (template geometry) and in a
 *     <style> rule (the watermark). The document's own editors sanitise what
 *     they write; a file does not. Everything read from a brand goes through
 *     the same sanitisers the editors use — sanitizeLook is not optional.
 *
 * Pure: no app imports (document-core and watermark-core are pure too).
 */

import { builtinTemplates, sanitizeTemplate, templateProblems, bandsOf, tableAssetIds, emptyDocument, ASSET_URL_RX } from './document-core.js';
import { watermarkOf } from './watermark-core.js';

/** Options that are part of the LOOK. Not: includeHidden (content), direction + ifaceAdjust (derived from one project's content). */
export const LOOK_OPTION_KEYS = Object.freeze(['numbering', 'pictureNumbers', 'dropSilent', 'toc', 'tocSteps']);
const MAX_LOOK_TEMPLATES = 40, MAX_LOOK_ASSETS = 40, MAX_ASSET_CHARS = 16_000_000;

const _norm = (s) => String(s ?? '').trim().toLowerCase();
const _cells = (c) => ({ left: String(c?.left ?? '').slice(0, 400), center: String(c?.center ?? '').slice(0, 400), right: String(c?.right ?? '').slice(0, 400) });
const _stable = (v) => Array.isArray(v) ? `[${v.map(_stable).join(',')}]`
  : (v && typeof v === 'object') ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${_stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null);
const _same = (a, b) => _stable(a) === _stable(b);

const _tplOut = (t) => ({ id: t.id, name: t.name, text: t.text, images: t.images });
const _assetOk = (a) => !!a && typeof a.dataUrl === 'string' && a.dataUrl.length <= MAX_ASSET_CHARS && ASSET_URL_RX.test(a.dataUrl)
  && Number(a.w) >= 1 && Number(a.h) >= 1 && Number(a.w) <= 20000 && Number(a.h) <= 20000;
const _assetOut = (a) => ({ dataUrl: a.dataUrl, w: Math.round(Number(a.w)), h: Math.round(Number(a.h)), name: String(a.name ?? '').slice(0, 200) });

/** The pictures a band item needs from doc.assets. */
const _itemAssetIds = (it) => it.type === 'image' ? (it.assetId && !it.logo ? [it.assetId] : []) : tableAssetIds(it);

/**
 * Bands, fit to travel: step-bound pictures out, pictures whose asset is missing out (they were
 * grey boxes already), and the assets the rest still needs.
 * @returns {{bands: null|{header, footer}, assets: Object}}
 */
function _travelBands(bandsIn, assetsIn) {
  const b = bandsOf({ bands: bandsIn });
  if (!b.header && !b.footer) return { bands: null, assets: {} };
  const assets = {}, out = {};
  for (const side of ['header', 'footer']) {
    if (!b[side]) { out[side] = null; continue; }
    const items = [];
    for (const it of b[side].items) {
      if (it.type === 'image' && it.stepId) continue;                          // shows a step of ONE animation
      if (it.type === 'image' && !it.logo && !_assetOk(assetsIn?.[it.assetId])) continue;
      let item = it;
      if (it.type === 'table') {                                               // a cell picture that did not come along leaves its cell, not the table
        const imgs = Object.fromEntries(Object.entries(it.imgs || {}).filter(([, id]) => _assetOk(assetsIn?.[id])));
        item = { ...it, imgs };
      }
      for (const id of _itemAssetIds(item)) if (Object.keys(assets).length < MAX_LOOK_ASSETS || assets[id]) assets[id] = _assetOut(assetsIn[id]);
      items.push(item);
    }
    out[side] = { rule: b[side].rule, items };
  }
  return { bands: out, assets };
}

/** The look of a document, ready to be written into a brand. null = the project has no document. */
export function documentLookOf(doc) {
  if (!doc) return null;
  const templates = (doc.templates || []).map(sanitizeTemplate).filter(t => t.id && t.name && !templateProblems(t).length).slice(0, MAX_LOOK_TEMPLATES).map(_tplOut);
  const mine = templates.find(t => t.id === doc.templateId);
  const builtin = builtinTemplates().some(t => t.id === doc.templateId) ? doc.templateId : 'tpl_standard';
  const { bands, assets } = _travelBands(doc.bands, doc.assets);
  const base = emptyDocument();
  const options = {};
  for (const k of LOOK_OPTION_KEYS) if (doc.options && k in doc.options) options[k] = doc.options[k];
  return {
    templates,
    defaultTemplate: mine ? { name: mine.name } : { builtin },
    header: _cells(doc.header || base.header), footer: _cells(doc.footer || base.footer),
    bands, assets,
    watermark: _watermarkOut(watermarkOf(doc)),
    company: String(doc.fields?.company ?? '').slice(0, 200),
    options,
  };
}

function _watermarkOut(w) {
  const im = w.image;
  return { ...w, image: im ? { dataUrl: im.dataUrl, w: im.w, h: im.h, mode: im.mode === 'white' || im.mode === 'black' ? im.mode : 'keep',
    tint: /^#[0-9a-f]{6}$/i.test(String(im.tint || '')) ? im.tint : null, name: String(im.name ?? '').slice(0, 200) } : null };
}

/** Whatever a brand file held → a well-formed look. Nothing from the file reaches the document except through here. */
export function sanitizeLook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seen = new Set(), templates = [];
  for (const t of (Array.isArray(raw.templates) ? raw.templates : []).slice(0, MAX_LOOK_TEMPLATES)) {
    const clean = sanitizeTemplate(t);
    if (!_norm(clean.name) || seen.has(_norm(clean.name)) || templateProblems(clean).length) continue;
    seen.add(_norm(clean.name));
    templates.push(_tplOut(clean));
  }
  const dt = raw.defaultTemplate;
  const defaultTemplate = (dt && typeof dt.name === 'string' && seen.has(_norm(dt.name))) ? { name: String(dt.name).slice(0, 80) }
    : { builtin: builtinTemplates().some(t => t.id === dt?.builtin) ? dt.builtin : 'tpl_standard' };
  const assetsIn = {};
  for (const [id, a] of Object.entries(raw.assets && typeof raw.assets === 'object' ? raw.assets : {})) if (/^[\w-]{1,80}$/.test(id) && _assetOk(a)) assetsIn[id] = a;
  const { bands, assets } = _travelBands(raw.bands, assetsIn);
  const options = {};
  if (['step', 'page', 'none'].includes(raw.options?.numbering)) options.numbering = raw.options.numbering;
  for (const k of LOOK_OPTION_KEYS) if (k !== 'numbering' && typeof raw.options?.[k] === 'boolean') options[k] = raw.options[k];
  const base = emptyDocument();
  return {
    templates, defaultTemplate,
    header: _cells(raw.header || base.header), footer: _cells(raw.footer || base.footer),
    bands, assets,
    watermark: _watermarkOut(watermarkOf({ watermark: raw.watermark })),
    company: String(raw.company ?? '').slice(0, 200),
    options,
  };
}

// ─── what the user is shown ─────────────────────────────────────────────────

const _tplWords = (t) => t ? `text box + ${t.images.length} picture frame${t.images.length === 1 ? '' : 's'}` : '—';
const _bandWords = (bands, header, footer) => {
  if (!bands || (!bands.header && !bands.footer)) return `standard layout — ${[header?.left, header?.center, header?.right].filter(Boolean).join(' | ') || 'empty'} / ${[footer?.left, footer?.center, footer?.right].filter(Boolean).join(' | ') || 'empty'}`;
  const n = (s) => bands[s] ? `${bands[s].items.length} item${bands[s].items.length === 1 ? '' : 's'}` : 'standard';
  return `own design — header: ${n('header')}, footer: ${n('footer')}`;
};
const _wmWords = (w) => !w?.enabled ? 'off' : w.kind === 'image' ? (w.image ? `picture "${w.image.name || 'image'}" · ${Math.round(w.opacity * 100)}%` : 'picture (none chosen)') : `"${String(w.text).slice(0, 30)}" · ${Math.round(w.opacity * 100)}%`;
const _optWords = (o) => LOOK_OPTION_KEYS.filter(k => k in (o || {})).map(k => `${k}: ${o[k]}`).join(' · ') || '—';

/**
 * Bring a document to a brand's look. Pure: returns the NEXT document and one row per part, in the
 * brand preview's own row shape ({label, name, action: 'same'|'update'|'add', before, after}).
 *
 *   • a template with the same NAME is replaced IN PLACE — it keeps this project's id, so every
 *     page wearing it keeps wearing it. Ids are minted per project and never match across two.
 *   • a template the project lacks is added; the project's other templates are left alone.
 *   • header / footer, watermark: the brand's. A brand with the standard header puts the standard
 *     header back — the project is meant to LOOK LIKE the brand, and the preview says so first.
 *   • a header picture arrives under a new asset id — or the id of an identical picture already
 *     here, so updating from the same brand twice changes nothing the second time.
 *   • the company name only if the brand has one.
 * @param {Object|null} docIn   null = the project has no document yet: it gets an empty one (no pages) wearing the look
 * @param {Object} look         from sanitizeLook
 * @param {{newId:(prefix:string)=>string}} opts
 */
export function applyLook(docIn, look, opts = {}) {
  let n = 0;
  const newId = opts.newId || ((p) => `${p}_${Date.now().toString(36)}${(++n).toString(36)}`);
  const doc = docIn || emptyDocument();
  const rows = [];
  const row = (label, name, action, before, after) => rows.push({ section: 'document', label, name, action, before, after, localChanged: false });

  // page templates, by name
  const templates = (doc.templates || []).map(t => ({ ...t }));
  const idOfName = new Map(templates.map(t => [_norm(t.name), t.id]));
  for (const bt of look.templates) {
    const at = templates.findIndex(t => _norm(t.name) === _norm(bt.name));
    if (at >= 0) {
      const cur = _tplOut(sanitizeTemplate(templates[at])), next = { ...bt, id: templates[at].id };
      row('Page template', bt.name, _same({ ...cur, id: 0 }, { ...next, id: 0 }) ? 'same' : 'update', _tplWords(cur), _tplWords(next));
      templates[at] = next;
    } else {
      const id = newId('utpl');
      templates.push({ ...bt, id }); idOfName.set(_norm(bt.name), id);
      row('Page template', bt.name, 'add', '', _tplWords(bt));
    }
  }
  const nameOfTpl = (id) => templates.find(t => t.id === id)?.name || builtinTemplates().find(t => t.id === id)?.name || id;
  const templateId = look.defaultTemplate.name ? (idOfName.get(_norm(look.defaultTemplate.name)) || doc.templateId) : look.defaultTemplate.builtin;
  row('Document', 'Default page layout', templateId === doc.templateId ? 'same' : 'update', nameOfTpl(doc.templateId), nameOfTpl(templateId));

  // header / footer — pictures land under this project's ids
  const assets = { ...(doc.assets || {}) };
  const idMap = new Map();
  for (const [bid, a] of Object.entries(look.assets || {})) {
    const twin = Object.entries(assets).find(([, x]) => x?.dataUrl === a.dataUrl);
    const id = twin ? twin[0] : newId('asset');
    if (!twin) assets[id] = { ...a };
    idMap.set(bid, id);
  }
  const remap = (it) => it.type === 'image' ? (it.assetId ? { ...it, assetId: idMap.get(it.assetId) || '' } : it)
    : it.type === 'table' ? { ...it, imgs: Object.fromEntries(Object.entries(it.imgs || {}).map(([k, id]) => [k, idMap.get(id)]).filter(([, id]) => id)) } : it;
  const bands = look.bands ? { header: look.bands.header ? { ...look.bands.header, items: look.bands.header.items.map(remap) } : null,
                               footer: look.bands.footer ? { ...look.bands.footer, items: look.bands.footer.items.map(remap) } : null } : null;
  const before = { bands: bandsOf(doc).header || bandsOf(doc).footer ? bandsOf(doc) : null, header: _cells(doc.header), footer: _cells(doc.footer) };
  const after = { bands: bands ? bandsOf({ bands }) : null, header: look.header, footer: look.footer };
  row('Document', 'Header and footer', _same(before, after) ? 'same' : 'update', _bandWords(before.bands, before.header, before.footer), _bandWords(after.bands, after.header, after.footer));

  const wmNow = _watermarkOut(watermarkOf(doc));
  row('Document', 'Watermark', _same(wmNow, look.watermark) ? 'same' : 'update', _wmWords(wmNow), _wmWords(look.watermark));

  const company = look.company ? look.company : String(doc.fields?.company ?? '');
  row('Document', 'Company name', company === String(doc.fields?.company ?? '') ? 'same' : 'update', String(doc.fields?.company ?? '') || '—', company || '—');

  const pick = (o) => Object.fromEntries(Object.keys(look.options).map(k => [k, o?.[k]]));
  const options = { ...(doc.options || {}), ...look.options };
  row('Document', 'Numbering and contents options', _same(pick(doc.options), pick(options)) ? 'same' : 'update', _optWords(pick(doc.options)), _optWords(look.options));

  return {
    doc: { ...doc, templates, templateId, header: look.header, footer: look.footer, bands, assets, watermark: look.watermark, fields: { ...(doc.fields || {}), company }, options },
    rows,
    changed: rows.some(r => r.action !== 'same'),
  };
}
