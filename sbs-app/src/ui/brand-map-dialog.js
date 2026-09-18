/**
 * 🏷 Brand matching wizard (V0.3.3.15).
 * Loading a brand into a project that was not born from it: for every kind
 * of definition, the brand's definitions on the left, the project's own
 * (unlinked) ones as chips you drag onto the brand definition they really
 * are. Several chips on one brand definition = merged into it. "Keep as the
 * project's own" leaves a definition alone; "Delete" is for unused leftovers.
 * The app pre-fills what it can (same name, or clearly similar) — every
 * guess is labelled and can be moved. Positions and masks are drawn on a
 * little frame, because their names are usually garbage.
 *
 * Resolves to mapping[section][projectDefId] = brandId | '@keep' | '@delete',
 * or null when cancelled.
 */

import { SECTIONS, summaryOf } from '../systems/brand-core.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PLURAL = { textStyles: 'Text styles', shapeStyles: 'Shape styles', constTexts: 'Constant title positions', constShapes: 'Pinned positions', cropMasks: 'Crop masks', headerItems: 'Header items' };

// ─── previews ───────────────────────────────────────────────────────────────

function _frame(inner, w = 112, h = 63) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 160 90" style="flex:0 0 auto;border-radius:4px;background:#0b1220;border:1px solid #334155;">${inner}</svg>`;
}
function _marker(nx, ny, anchor, colour) {
  const x = Math.max(3, Math.min(157, nx * 160)), y = Math.max(3, Math.min(87, ny * 90));
  const dir = anchor === 'tr' ? -1 : 1;
  return `<path d="M${x} ${y + 14} V${y} H${x + dir * 22}" stroke="${colour}" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="${x}" cy="${y}" r="3.5" fill="${colour}"/>`;
}
function _maskRect(m, colour, fillOpacity = 0.25) {
  const x = m.x * 160, y = m.y * 90, w = m.w * 160, h = m.h * 90;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" transform="rotate(${m.rot || 0} ${x} ${y})" fill="${colour}" fill-opacity="${fillOpacity}" stroke="${colour}" stroke-width="2"/>`;
}

/** @param canon {width,height} of the side the def belongs to */
function _preview(secKey, d, canon, overlays = '') {
  if (secKey === 'textStyles') {
    const size = Math.max(11, Math.min(24, d.fontSize || 16));
    return `<span style="display:inline-block;max-width:150px;overflow:hidden;white-space:nowrap;font-family:${_esc(d.fontFamily || 'Arial')};font-size:${size}px;color:${_esc(d.color || '#fff')};font-weight:${d.fontWeight === 'bold' ? 'bold' : 'normal'};font-style:${d.fontStyle === 'italic' ? 'italic' : 'normal'};text-decoration:${_esc(d.textDecoration || 'none')};background:${_esc(d.fillColor || '#0b1220')};padding:2px 7px;border-radius:4px;border:1px solid #334155;">Aa Bb 12</span>`;
  }
  if (secKey === 'shapeStyles') {
    return `<span style="display:inline-block;width:52px;height:30px;background:${_esc(d.fill || 'transparent')};border:${Math.max(1, Math.min(5, d.strokeWidth || 0))}px solid ${_esc(d.stroke || 'transparent')};border-radius:2px;flex:0 0 auto;"></span>`;
  }
  if (secKey === 'constTexts' || secKey === 'constShapes') {
    const W = canon?.width || 1920, H = canon?.height || 1080;
    return _frame(overlays + _marker((d.x || 0) / W, (d.y || 0) / H, d.anchor, overlays ? '#22c55e' : '#f59e0b'));
  }
  if (secKey === 'cropMasks') return _frame(overlays + _maskRect(d, overlays ? '#22c55e' : '#f59e0b'));
  if (secKey === 'headerItems') {
    if (d.kind === 'image' && d.dataUrl) return `<img src="${d.dataUrl}" style="height:30px;max-width:90px;object-fit:contain;background:#0b1220;border:1px solid #334155;border-radius:3px;flex:0 0 auto;">`;
    const W = canon?.width || 1920, H = canon?.height || 1080;
    return _frame(`<rect x="${(d.x || 0) / W * 160}" y="${(d.y || 0) / H * 90}" width="${Math.max(4, (d.w || 0) / W * 160)}" height="${Math.max(3, (d.h || 0) / H * 90)}" fill="${overlays ? '#22c55e' : '#f59e0b'}" fill-opacity="0.5"/>`, 96, 54);
  }
  return '';
}

// ─── dialog ─────────────────────────────────────────────────────────────────

/**
 * @param {Object} p
 * @param {Object} p.project      { sections, links, canonical }
 * @param {Object} p.brand        parsed brand
 * @param {Object} p.suggestions  suggestMapping()
 * @param {Object} p.usage        { secKey: Map(defId → count) }
 * @returns {Promise<Object|null>}
 */
export function openBrandMapDialog({ project, brand, suggestions, usage }) {
  const pages = SECTIONS.filter(sec => {
    const b = brand?.sections?.[sec.key] || [];
    const unl = (project.sections?.[sec.key] || []).filter(d => !project.links?.[sec.key]?.[d.id]?.brandId);
    return b.length && unl.length;
  });
  if (!pages.length) return Promise.resolve({});
  const bCanon = brand?._sbsbrand?.canonical || project.canonical;

  // assignment[secKey][projectId] = brandId | '@keep' | '@delete'
  // Only a SAME-NAME match is pre-applied. A "similar" guess is offered as a
  // one-click hint on the chip and nothing more: merging a special style
  // into the brand's Title because both happen to be Impact would restyle
  // the project behind the user's back.
  const assign = {}, why = {}, hint = {};
  for (const sec of SECTIONS) {
    assign[sec.key] = {}; why[sec.key] = {}; hint[sec.key] = {};
    for (const d of (project.sections?.[sec.key] || [])) {
      if (project.links?.[sec.key]?.[d.id]?.brandId) continue;
      const s = suggestions?.[sec.key]?.[d.id];
      assign[sec.key][d.id] = s && s.why === 'name' ? s.brandId : '@keep';
      if (s?.why === 'name') why[sec.key][d.id] = 'name';
      else if (s) hint[sec.key][d.id] = s.brandId;
    }
  }

  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.style.cssText = 'padding:0;max-width:min(1100px,94vw);width:min(1100px,94vw);';
    document.body.appendChild(dlg);
    let page = 0, msg = '';
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };

    const chipHtml = (sec, d) => {
      const n = usage?.[sec.key]?.get?.(d.id) ?? null;
      const w = why[sec.key][d.id];
      const cur = assign[sec.key][d.id];
      let tag = cur && cur[0] !== '@' && w ? `<span style="font-size:10px;padding:0 5px;border-radius:8px;background:rgba(34,197,94,0.25);">same name</span>` : '';
      const hb = hint[sec.key][d.id];
      if (cur === '@keep' && hb) {
        const bn = (brand.sections[sec.key] || []).find(b => b.id === hb);
        if (bn) tag = `<button class="bm-hint" data-id="${_esc(d.id)}" data-to="${_esc(hb)}" title="The app's guess — click to move it there" style="font-size:10px;padding:0 6px;border-radius:8px;border:1px solid #f59e0b;background:rgba(245,158,11,0.18);color:#fbbf24;cursor:pointer;">looks like "${_esc(bn.name || bn.kind || '')}" →</button>`;
      }
      return `<div class="bm-chip" draggable="true" data-id="${_esc(d.id)}" title="Drag onto the brand definition this really is"
          style="display:flex;align-items:center;gap:8px;padding:5px 7px;margin:4px 0;border:1px solid #f59e0b;border-radius:6px;background:rgba(245,158,11,0.10);cursor:grab;">
          ${_preview(sec.key, d, project.canonical)}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(d.name || d.kind || '(no name)')} ${tag}</div>
            <div class="small muted" style="font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(summaryOf(sec.key, d))}${n != null ? ` · used ${n}×` : ''}</div>
          </div>
          <select class="bm-move" data-id="${_esc(d.id)}" title="Move to…" style="max-width:150px;font-size:11px;background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:5px;height:24px;">
            ${(brand.sections[sec.key] || []).map(b => `<option value="${_esc(b.id)}"${cur === b.id ? ' selected' : ''}>→ ${_esc(b.name || b.kind || b.id)}</option>`).join('')}
            <option value="@keep"${cur === '@keep' ? ' selected' : ''}>Keep as the project's own</option>
            <option value="@delete"${cur === '@delete' ? ' selected' : ''}>Delete (unused only)</option>
          </select>
        </div>`;
    };

    const render = () => {
      const sec = pages[page];
      const bdefs = brand.sections[sec.key] || [];
      const pdefs = (project.sections?.[sec.key] || []).filter(d => !project.links?.[sec.key]?.[d.id]?.brandId);
      const inZone = (z) => pdefs.filter(d => assign[sec.key][d.id] === z);
      const spatial = sec.key === 'constTexts' || sec.key === 'constShapes' || sec.key === 'cropMasks';
      const brandCards = bdefs.map(b => {
        const mine = inZone(b.id);
        // positions / masks: the brand's mark in green with everything dropped on it in orange, on one frame
        let over = '';
        if (spatial) {
          const W = project.canonical?.width || 1920, H = project.canonical?.height || 1080;
          over = mine.map(d => sec.key === 'cropMasks' ? _maskRect(d, '#f59e0b', 0.12) : _marker((d.x || 0) / W, (d.y || 0) / H, d.anchor, '#f59e0b')).join('');
        }
        return `<div class="bm-zone" data-zone="${_esc(b.id)}" style="border:1px solid #22c55e;border-radius:8px;padding:7px 9px;margin-bottom:8px;background:rgba(34,197,94,0.07);">
          <div style="display:flex;align-items:center;gap:8px;">
            ${_preview(sec.key, b, bCanon, spatial ? (over || ' ') : '')}
            <div style="flex:1;min-width:0;"><div style="font-weight:700;">${_esc(b.name || b.kind || b.id)}</div>
            <div class="small muted" style="font-size:10.5px;">${_esc(summaryOf(sec.key, b))}</div></div>
            <span class="small muted" style="font-size:10.5px;">${mine.length ? (mine.length > 1 ? `${mine.length} merged into it` : 'takes over 1') : 'new in this project'}</span>
          </div>
          ${mine.map(d => chipHtml(sec, d)).join('')}
        </div>`;
      }).join('');
      dlg.innerHTML = `
        <div style="padding:12px 16px;border-bottom:1px solid var(--line,#334155);display:flex;align-items:center;gap:10px;">
          <div style="flex:1;"><div style="font-weight:700;font-size:14px;">Match this project to the brand "${_esc(brand._sbsbrand?.name || '')}" — ${_esc(PLURAL[sec.key])}</div>
          <div class="small muted" style="font-size:11.5px;line-height:1.45;margin-top:3px;">Left: the brand (green). Orange chips are this project's own definitions — drag each onto the brand definition it really is (or use its "Move to…" list). Several on one = merged into it, and everything that used them follows. Guesses are labelled; move anything that is wrong.</div></div>
          <div class="small muted" style="font-size:11.5px;white-space:nowrap;">Step ${page + 1} of ${pages.length}</div>
        </div>
        <div style="display:grid;grid-template-columns:1.25fr 1fr;gap:14px;padding:12px 16px;max-height:62vh;overflow:auto;">
          <div><div class="small muted" style="font-size:11px;margin-bottom:6px;">BRAND</div>${brandCards}</div>
          <div>
            <div class="bm-zone" data-zone="@keep" style="border:1px dashed #64748b;border-radius:8px;padding:7px 9px;margin-bottom:8px;min-height:70px;">
              <div style="font-weight:700;">Keep as the project's own</div>
              <div class="small muted" style="font-size:10.5px;margin-bottom:4px;">Not part of the brand — brand updates never touch these.</div>
              ${inZone('@keep').map(d => chipHtml(sec, d)).join('') || '<div class="small muted" style="font-size:11px;padding:6px 0;">— nothing —</div>'}
            </div>
            <div class="bm-zone" data-zone="@delete" style="border:1px dashed #ef4444;border-radius:8px;padding:7px 9px;min-height:54px;">
              <div style="font-weight:700;color:#fca5a5;">Delete</div>
              <div class="small muted" style="font-size:10.5px;margin-bottom:4px;">Only definitions nothing uses.</div>
              ${inZone('@delete').map(d => chipHtml(sec, d)).join('')}
            </div>
          </div>
        </div>
        <div style="padding:10px 16px;border-top:1px solid var(--line,#334155);display:flex;align-items:center;gap:8px;">
          <div class="small" style="flex:1;color:#fbbf24;font-size:11.5px;">${_esc(msg)}</div>
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn" data-act="back"${page === 0 ? ' disabled style="opacity:.45"' : ''}>◀ Back</button>
          <button class="btn" data-act="next" style="color:#22d3ee;font-weight:600;">${page === pages.length - 1 ? 'Review the changes ▶' : 'Next ▶'}</button>
        </div>`;
      msg = '';
      const move = (id, zone) => {
        if (zone === '@delete' && (usage?.[sec.key]?.get?.(id) || 0) > 0) { msg = 'That definition is in use — merge it into a brand definition or keep it; only unused ones can be deleted.'; render(); return; }
        assign[sec.key][id] = zone;
        render();
      };
      dlg.querySelectorAll('.bm-chip').forEach(ch => {
        ch.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', ch.dataset.id); e.dataTransfer.effectAllowed = 'move'; });
      });
      dlg.querySelectorAll('.bm-zone').forEach(z => {
        z.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; z.style.outline = '2px solid #22d3ee'; });
        z.addEventListener('dragleave', () => { z.style.outline = ''; });
        z.addEventListener('drop', (e) => { e.preventDefault(); z.style.outline = ''; const id = e.dataTransfer.getData('text/plain'); if (id && id in assign[sec.key]) move(id, z.dataset.zone); });
      });
      dlg.querySelectorAll('.bm-hint').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); move(btn.dataset.id, btn.dataset.to); });
      });
      dlg.querySelectorAll('.bm-move').forEach(sel => {
        sel.addEventListener('mousedown', e => e.stopPropagation());
        sel.addEventListener('change', () => move(sel.dataset.id, sel.value));
      });
      dlg.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
      dlg.querySelector('[data-act="back"]').addEventListener('click', () => { if (page > 0) { page--; render(); } });
      dlg.querySelector('[data-act="next"]').addEventListener('click', () => { if (page < pages.length - 1) { page++; render(); } else done(assign); });
    };
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    render();
    dlg.showModal();
  });
}
