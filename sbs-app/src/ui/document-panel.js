/**
 * 📄 Document panel (V0.3.4.0, phase D1) — Tools ▸ Document…
 * The animation as a paged 2D manual: build the pages, merge the steps that
 * belong together, pick templates and pictures, edit the text independently
 * of the voiceover, see what the animation changed since, export a PDF.
 */

import { state } from '../core/state.js';
import { setStatus } from './status.js';
import { steps } from '../systems/steps.js';
import { srcHashOf } from '../systems/language-packs.js';
import { builtinTemplates, docTextFor, pageRangeLabel, unitsOf } from '../systems/document-core.js';
import * as D from '../systems/document.js';

let _win = null, _busy = false, _open = new Set(), _previewFor = null;
const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FLAG_ICON = { added: '➕', removed: '➖', 'moved-out': '↗', new: '🆕', 'image-left': '🖼', empty: '∅' };

export function openDocumentPanel() {
  if (!_win) _build();
  _win.style.display = '';
  _render();
}
export function closeDocumentPanel() { if (_win) _win.style.display = 'none'; }

function _build() {
  _win = document.createElement('div');
  _win.id = 'document-panel';
  _win.style.cssText = [
    'position:fixed', 'left:90px', 'top:70px', 'width:620px', 'max-height:86vh',
    'background:var(--panel,#0f172a)', 'border:1px solid var(--line,#334155)', 'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.5)', 'z-index:45', 'display:flex', 'flex-direction:column',
    'color:var(--text,#e2e8f0)', 'font-size:13px',
  ].join(';');
  _win.innerHTML = `
    <div id="dp-header" style="cursor:move;padding:10px 12px;display:flex;align-items:center;gap:8px;background:rgba(99,102,241,0.18);border-bottom:1px solid var(--line,#334155);border-top-left-radius:10px;border-top-right-radius:10px;user-select:none;">
      <span style="flex:1;font-weight:600;">📄 Document</span>
      <button class="btn" id="dp-close" type="button" style="padding:2px 8px;font-size:12px;">✕</button>
    </div>
    <div id="dp-body" style="overflow:auto;display:flex;flex-direction:column;"></div>`;
  document.body.appendChild(_win);
  const head = _win.querySelector('#dp-header');
  let drag = null;
  head.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = { dx: e.clientX - _win.offsetLeft, dy: e.clientY - _win.offsetTop }; head.setPointerCapture(e.pointerId); });
  head.addEventListener('pointermove', (e) => { if (!drag) return; _win.style.left = `${Math.max(0, e.clientX - drag.dx)}px`; _win.style.top = `${Math.max(0, e.clientY - drag.dy)}px`; });
  head.addEventListener('pointerup', () => { drag = null; });
  _win.querySelector('#dp-close').addEventListener('click', closeDocumentPanel);
  const rerender = () => { if (_win && _win.style.display !== 'none' && !_busy) _render(); };
  for (const k of ['document', 'steps', 'chapters']) state.on(`change:${k}`, rerender);
}

function _render() {
  const body = _win.querySelector('#dp-body');
  const doc = D.getDocument();
  const allSteps = state.get('steps') || [], chapters = state.get('chapters') || [];
  if (!doc || !doc.pages?.length) {
    body.innerHTML = `
      <div style="padding:16px;display:flex;flex-direction:column;gap:10px;">
        <div class="small muted" style="line-height:1.55;">Turn the approved animation into a paged 2D manual. Every page covers one or more steps: their text on top (the voiceover until you edit it — the document keeps its own copy), a picture of their final state below, inside a fixed page template with your header and footer. Pages refer to steps by their permanent identity, so you can keep editing the animation and sync the document afterwards.</div>
        <div><button class="btn" data-act="build" style="padding:6px 14px;font-weight:600;color:#22d3ee;">Build pages from the steps</button></div>
      </div>`;
    body.querySelector('[data-act="build"]').addEventListener('click', () => { D.buildPages(); });
    return;
  }
  const pending = D.pendingSync();
  const flagged = doc.pages.filter(p => (p.flags || []).length).length;
  const tpls = [...builtinTemplates(), ...(doc.templates || [])];
  const unitById = new Map(unitsOf(allSteps, chapters, doc.options).map(u => [u.id, u]));
  const stepById = new Map(allSteps.map(s => [s.id, s]));
  const perChapter = !!state.get('headerStepNumberPerChapter');
  const f = doc.fields || {};

  const pageRows = doc.pages.map((p, i) => {
    const open = _open.has(p.id);
    const members = (p.stepIds || []).flatMap(id => unitById.get(id)?.members || []);
    const flags = (p.flags || []);
    const texts = !open ? '' : (p.stepIds || []).flatMap(id => unitById.get(id)?.members || []).map(sid => {
      const s = stepById.get(sid); if (!s) return '';
      const t = docTextFor(s, doc.texts, srcHashOf);
      return `<div style="margin:6px 0;">
        <div class="small muted" style="font-size:10.5px;display:flex;gap:8px;align-items:center;">
          <a href="#" data-act="goto" data-step="${_esc(sid)}" style="color:#93c5fd;">${_esc(s.name || 'step')}</a>
          <span>${t.edited ? (t.drifted ? '<span style="color:#fbbf24;">⚠ the voiceover changed after you edited this</span>' : 'edited for the document') : 'follows the voiceover'}</span>
          ${t.edited ? `<a href="#" data-act="reset-text" data-step="${_esc(sid)}" style="color:#93c5fd;">use the voiceover again</a>` : ''}
          ${t.drifted ? `<a href="#" data-act="accept-drift" data-step="${_esc(sid)}" style="color:#93c5fd;">keep mine</a>` : ''}
        </div>
        <textarea data-step="${_esc(sid)}" dir="auto" rows="2" style="width:100%;box-sizing:border-box;background:#0b1220;color:#e2e8f0;border:1px solid ${t.drifted ? '#f59e0b' : '#334155'};border-radius:6px;padding:5px 7px;font:inherit;font-size:12.5px;resize:vertical;">${_esc(t.text)}</textarea>
        ${t.drifted ? `<div class="small muted" dir="auto" style="font-size:10.5px;">voiceover now: ${_esc(String(s.narration?.text ?? s.voiceText ?? ''))}</div>` : ''}
      </div>`;
    }).join('');
    const tplNow = tpls.find(t => t.id === p.templateId) || tpls[0];
    const pictureRows = !open ? '' : (tplNow.images || []).map((_, k) => `
      <label class="small" style="display:flex;gap:6px;align-items:center;font-size:11.5px;">Picture ${k + 1}
        <select data-act="picture" data-slot="${k}" style="flex:1;background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:5px;height:24px;font-size:11.5px;">
          ${k === 0 ? `<option value=""${(p.images?.[0]?.auto || !p.images?.[0]?.stepId) ? ' selected' : ''}>Automatic — the page's last step</option>` : `<option value=""${!p.images?.[k]?.stepId ? ' selected' : ''}>— empty —</option>`}
          ${members.map(sid => `<option value="${_esc(sid)}"${(p.images?.[k]?.stepId === sid && !(k === 0 && p.images?.[0]?.auto)) ? ' selected' : ''}>${_esc(stepById.get(sid)?.name || sid)}</option>`).join('')}
        </select></label>`).join('');
    return `<div data-page="${_esc(p.id)}" style="border:1px solid ${flags.length ? '#f59e0b' : 'var(--line,#334155)'};border-radius:8px;margin:0 10px 6px;background:var(--panel2,#1e293b);">
      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;">
        <a href="#" data-act="toggle" style="color:inherit;text-decoration:none;flex:1;min-width:0;">
          <b>${open ? '▾' : '▸'} Page ${i + 1}</b> <span class="small muted" style="font-size:11.5px;">${_esc(pageRangeLabel(p, allSteps, chapters, perChapter))}</span>
          ${flags.length ? `<span title="${_esc(flags.map(x => x.note).join('\n'))}" style="color:#fbbf24;font-size:12px;"> ❗ ${flags.map(x => FLAG_ICON[x.kind] || '!').join(' ')}</span>` : ''}
        </a>
        <select data-act="template" title="Page template" style="max-width:190px;background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:5px;height:24px;font-size:11.5px;">
          ${tpls.map(t => `<option value="${_esc(t.id)}"${t.id === p.templateId ? ' selected' : ''}>${_esc(t.name)}</option>`).join('')}
        </select>
        <button class="btn" data-act="merge" title="Merge this page into the previous one"${i === 0 ? ' disabled style="opacity:.4;padding:1px 7px;"' : ' style="padding:1px 7px;"'}>⤒</button>
        <button class="btn" data-act="preview" title="Preview this page" style="padding:1px 7px;">👁</button>
      </div>
      ${open ? `<div style="padding:4px 10px 10px;border-top:1px solid var(--line,#334155);">
        ${flags.length ? `<div style="margin:6px 0;padding:6px 8px;border-radius:6px;background:rgba(245,158,11,0.12);font-size:11.5px;line-height:1.5;">${flags.map(x => `${FLAG_ICON[x.kind] || '!'} ${_esc(x.note)}`).join('<br>')}<div style="margin-top:4px;"><a href="#" data-act="reviewed" style="color:#93c5fd;">✓ Seen — clear these marks</a>${!p.stepIds.length ? ` · <a href="#" data-act="delete" style="color:#fca5a5;">Delete this empty page</a>` : ''}</div></div>` : ''}
        <div style="display:flex;flex-direction:column;gap:4px;margin:6px 0;">${pictureRows}</div>
        ${texts}
        ${p.stepIds.length > 1 ? `<div class="small" style="font-size:11.5px;margin-top:4px;">Split: start a new page at ${p.stepIds.slice(1).map(id => `<a href="#" data-act="split" data-step="${_esc(id)}" style="color:#93c5fd;">${_esc(stepById.get(id)?.name || id)}</a>`).join(' · ')}</div>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');

  body.innerHTML = `
    <div style="padding:10px 12px;display:grid;grid-template-columns:1fr 1fr 110px 70px;gap:6px;border-bottom:1px solid var(--line,#334155);">
      ${[['title', 'Title', f.title], ['company', 'Company', f.company], ['docNo', 'Document no.', f.docNo], ['rev', 'Rev', f.rev]].map(([k, l, v]) => `<label class="small muted" style="font-size:10.5px;display:flex;flex-direction:column;gap:2px;">${l}<input data-field="${k}" value="${_esc(v || '')}" dir="auto" style="background:#0b1220;color:#e2e8f0;border:1px solid #334155;border-radius:5px;padding:3px 6px;font:inherit;font-size:12.5px;"></label>`).join('')}
    </div>
    <div style="padding:8px 12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line,#334155);">
      <button class="btn" data-act="export" style="padding:4px 12px;font-weight:600;color:#22d3ee;">⬇ Export PDF…</button>
      <button class="btn" data-act="sync" style="padding:4px 12px;${pending ? 'color:#fbbf24;font-weight:600;' : ''}" title="Bring the pages in line with the animation as it is now: new steps join the page whose range they landed in or get a page of their own, moved and deleted steps leave theirs. Every change is flagged.">${pending ? '⟳ Sync with the animation — it changed' : '⟳ Sync with the animation'}</button>
      ${flagged ? `<button class="btn" data-act="reviewed-all" style="padding:4px 12px;">✓ Clear all ❗ (${flagged})</button>` : ''}
      <span style="flex:1"></span>
      <label class="small" style="font-size:11.5px;display:flex;gap:5px;align-items:center;">Numbers
        <select data-act="numbering" style="background:#1f2937;color:#e5e7eb;border:1px solid #334155;border-radius:5px;height:24px;font-size:11.5px;">
          ${[['step', 'as in the animation'], ['page', '1, 2, 3 per page'], ['none', 'none']].map(([v, l]) => `<option value="${v}"${(doc.options?.numbering || 'step') === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <button class="btn" data-act="rebuild" style="padding:4px 10px;font-size:11.5px;" title="Throw the page layout away and start again with one page per step (texts and fields are kept)">Rebuild…</button>
    </div>
    <div style="padding:8px 0 4px;">${pageRows}</div>
    <div id="dp-preview" style="display:${_previewFor ? 'block' : 'none'};border-top:1px solid var(--line,#334155);padding:8px 12px;">
      <div class="small muted" style="font-size:11px;margin-bottom:4px;display:flex;"><span style="flex:1;">Preview</span><a href="#" data-act="close-preview" style="color:#93c5fd;">close</a></div>
      <div style="width:100%;height:420px;overflow:auto;background:#475569;border-radius:6px;"><iframe id="dp-frame" sandbox="" style="width:794px;height:1123px;border:0;background:#fff;transform:scale(0.72);transform-origin:0 0;"></iframe></div>
    </div>`;

  // fields
  body.querySelectorAll('input[data-field]').forEach(inp => inp.addEventListener('change', () => D.setFields({ [inp.dataset.field]: inp.value })));
  body.querySelectorAll('textarea[data-step]').forEach(ta => ta.addEventListener('change', () => D.setDocText(ta.dataset.step, ta.value)));
  body.addEventListener('click', _onClick);
  body.querySelectorAll('select[data-act]').forEach(sel => sel.addEventListener('change', () => {
    const pid = sel.closest('[data-page]')?.dataset.page;
    if (sel.dataset.act === 'template') D.setPageTemplate(pid, sel.value);
    else if (sel.dataset.act === 'picture') D.setPagePicture(pid, Number(sel.dataset.slot), sel.value || null);
    else if (sel.dataset.act === 'numbering') D.setOptions({ numbering: sel.value });
  }));
  if (_previewFor) _loadPreview(_previewFor);
  _markOverflow();
}

/** ✂ on every page whose text does not fit its zone (it would be cut off in the PDF). */
let _overflowRun = 0;
async function _markOverflow() {
  const run = ++_overflowRun;
  let over = [];
  try { over = await D.overflowingPages(); } catch { return; }
  if (run !== _overflowRun || !_win) return;
  for (const o of over) {
    const row = _win.querySelector(`[data-page="${CSS.escape(o.id)}"] a[data-act="toggle"]`);
    if (row && !row.querySelector('.dp-over')) row.insertAdjacentHTML('beforeend', ' <span class="dp-over" title="The text does not fit on this page — the end of it would be cut off. Shorten it, split the page, or pick a template with more room for text." style="color:#f87171;font-size:11.5px;font-weight:600;">✂ text does not fit</span>');
  }
}

async function _onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT') return;
  e.preventDefault();
  const act = el.dataset.act;
  const pid = el.closest('[data-page]')?.dataset.page || null;
  if (act === 'toggle') { if (_open.has(pid)) _open.delete(pid); else _open.add(pid); _render(); return; }
  if (act === 'merge') return D.mergePageUp(pid);
  if (act === 'split') return D.splitPageBefore(pid, el.dataset.step);
  if (act === 'reviewed') return D.markPageReviewed(pid);
  if (act === 'reviewed-all') return D.markPageReviewed(null);
  if (act === 'delete') return D.deletePage(pid);
  if (act === 'reset-text') return D.setDocText(el.dataset.step, null);
  if (act === 'accept-drift') return D.acceptDrift(el.dataset.step);
  if (act === 'sync') return D.syncWithAnimation();
  if (act === 'rebuild') { if (confirm('Start the page layout again with one page per step? Texts and fields are kept; merges, templates and picture choices are lost. (Undo brings them back.)')) D.buildPages({ rebuild: true }); return; }
  if (act === 'goto') { const id = el.dataset.step; if (state.get('activeStepId') !== id) await steps.activateStep(id, false); return; }
  if (act === 'close-preview') { _previewFor = null; _render(); return; }
  if (act === 'preview') { _previewFor = pid; _render(); return; }
  if (act === 'export') {
    if (_busy) return;
    _busy = true;
    try { await D.exportPdf(); }
    catch (err) { console.error('[document] export failed:', err); setStatus(`Document export failed: ${err?.message || err}`, 'warn', 10000); }
    finally { _busy = false; _render(); }
  }
}

async function _loadPreview(pageId) {
  const frame = _win.querySelector('#dp-frame');
  if (!frame) return;
  _busy = true;
  try {
    const html = await D.documentHtml({ pageId, onProgress: (i, n) => setStatus(`Rendering the picture… ${i}/${n}`, 'info', 0) });
    setStatus('', 'info', 1);
    const f2 = _win.querySelector('#dp-frame');
    if (f2) f2.srcdoc = html;
  } catch (err) {
    console.error('[document] preview failed:', err);
  } finally { _busy = false; }
}
