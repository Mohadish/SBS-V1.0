/**
 * 📐 Document template editor (V0.3.4.5) — draw a page layout.
 *
 * A template = where the TEXT box sits and where the PICTURE FRAMES sit on the
 * A4 page. The editor shows the page in true proportion: the header and the
 * footer are fixed bands (not part of a user template), the text box is blue,
 * the picture frames are green and numbered in the order the pictures fill
 * them. Drag a box to move it, drag a handle to resize it, drag on empty paper
 * to DRAW a new picture frame. Everything snaps to a half-millimetre grid and
 * stays inside the content area; boxes may not overlap — a strict layout is
 * what keeps every page of a manual lined up.
 *
 * Pure UI: it edits a copy and hands the result to onSave. No state, no undo
 * of its own (saving is one undoable document edit).
 */

import { CONTENT_MM, PAGE_MM, MAX_FRAMES, clampRect, sanitizeTemplate, templateProblems, builtinTemplates } from '../systems/document-core.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MM = 96 / 25.4;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const RATIOS = [['16:9', 16 / 9], ['3:2', 3 / 2], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4]];

/**
 * @param {Object} o
 * @param {HTMLElement} o.host        the element the editor covers (the workspace centre)
 * @param {Object}      o.template    the layout to start from (a prefab or a user template)
 * @param {boolean}     o.isNew       true = "save as a new template" (the name is asked for)
 * @param {(tpl)=>void} o.onSave
 * @param {()=>void}    o.onCancel
 * @returns {{close:()=>void, el:HTMLElement}}
 */
export function openTemplateEditor({ host, template, isNew = true, onSave, onCancel }) {
  const base = builtinTemplates()[0];
  const tpl = sanitizeTemplate(template);
  const st = {
    name: isNew ? '' : tpl.name,
    text: { ...tpl.text },
    images: tpl.images.map(r => ({ ...r })),
    sel: tpl.images.length ? 0 : 'text',          // index of a picture frame | 'text'
    scale: 1, drag: null,
  };

  const el = document.createElement('div');
  el.id = 'dw-tpled';
  el.tabIndex = -1;
  el.style.cssText = 'position:absolute;inset:0;z-index:6;background:var(--dw-line);display:flex;flex-direction:column;outline:none;';   // V0.3.4.123 — theme-aware (base.css --dw-*)
  el.innerHTML = `
    <style>
      #dw-tpled .te-bar { flex:0 0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;background:var(--dw-panel);border-bottom:1px solid #38bdf8;font-size:12px;color:var(--dw-strong); }
      #dw-tpled .te-in { background:var(--dw-field);color:var(--dw-text);border:1px solid var(--dw-line);border-radius:6px;padding:3px 6px;font:inherit;font-size:12px; }
      #dw-tpled .te-num { width:58px;text-align:right; }
      #dw-tpled .te-stage { flex:1 1 auto;min-height:0;overflow:auto;position:relative; }
      #dw-tpled .te-page { position:absolute;background:#fff;box-shadow:0 6px 30px rgba(0,0,0,.55);user-select:none;touch-action:none; }
      #dw-tpled .te-fixed { position:absolute;background:repeating-linear-gradient(45deg,#e5e7eb 0 6px,#f3f4f6 6px 12px);color:#6b7280;font:11px Arial;display:flex;align-items:center;justify-content:center; }
      #dw-tpled .te-area { position:absolute;border:1px dashed #cbd5e1;pointer-events:none; }
      #dw-tpled .te-box { position:absolute;box-sizing:border-box;cursor:move;display:flex;align-items:center;justify-content:center;font:600 13px Arial; }
      #dw-tpled .te-box.pic { background:rgba(34,197,94,.22);border:2px solid #16a34a;color:#14532d; }
      #dw-tpled .te-box.txt { background:rgba(59,130,246,.18);border:2px solid #2563eb;color:#1e3a8a; }
      #dw-tpled .te-box.sel { box-shadow:0 0 0 2px #f59e0b; }
      #dw-tpled .te-box.bad { border-color:#dc2626;background:rgba(220,38,38,.22);color:#7f1d1d; }
      #dw-tpled .te-h { position:absolute;width:11px;height:11px;background:#fff;border:2px solid #f59e0b;border-radius:2px;margin:-6px 0 0 -6px; }
      #dw-tpled .te-ghost { position:absolute;border:2px dashed #16a34a;background:rgba(34,197,94,.12);pointer-events:none; }
    </style>
    <div class="te-bar">
      <b style="color:#38bdf8;">📐 Page template</b>
      <input class="te-in" data-te="name" placeholder="Name this template…" value="${_esc(st.name)}" style="width:210px;">
      <button class="dw-btn" data-te="add" title="Or simply drag on empty paper to draw one">＋ Picture frame</button>
      <span data-te="selinfo" style="display:flex;gap:6px;align-items:center;"></span>
      <span style="flex:1"></span>
      <span data-te="problems" style="color:#fca5a5;"></span>
      <button class="dw-btn" data-te="cancel">Cancel</button>
      <button class="dw-btn primary" data-te="save">Save template</button>
    </div>
    <div class="te-stage"><div class="te-page"></div></div>
    <div class="te-bar" style="border-top:1px solid var(--dw-line);border-bottom:0;color:var(--dw-muted);font-size:11.5px;">Drag a box to move it · drag a corner or an edge to resize · drag on empty paper to draw a new picture frame · arrows nudge 1 mm (Shift 5) · Delete removes the selected frame · the pictures fill the frames in number order</div>`;
  host.appendChild(el);
  const stage = el.querySelector('.te-stage'), page = el.querySelector('.te-page');

  const px = (mm) => mm * MM * st.scale;
  const rectOf = (key) => (key === 'text' ? st.text : st.images[key]);
  const problems = () => templateProblems({ text: st.text, images: st.images });

  function layout() {
    const pad = 24;
    st.scale = Math.max(0.25, Math.min((stage.clientWidth - pad * 2) / (PAGE_MM.w * MM), (stage.clientHeight - pad * 2) / (PAGE_MM.h * MM)));
    page.style.width = `${px(PAGE_MM.w)}px`; page.style.height = `${px(PAGE_MM.h)}px`;
    page.style.left = `${Math.max(pad, (stage.clientWidth - px(PAGE_MM.w)) / 2)}px`;
    page.style.top = `${Math.max(pad, (stage.clientHeight - px(PAGE_MM.h)) / 2)}px`;
    draw();
  }

  function draw() {
    const bad = new Set(problems().flatMap(p => [p.a, p.b]));        // zone indices: 0 = text, i + 1 = picture i
    const box = (key, r, cls, label) => {
      const sel = st.sel === key, zi = key === 'text' ? 0 : key + 1;
      return `<div class="te-box ${cls}${sel ? ' sel' : ''}${bad.has(zi) ? ' bad' : ''}" data-box="${key}" style="left:${px(r.x)}px;top:${px(r.y)}px;width:${px(r.w)}px;height:${px(r.h)}px;">${_esc(label)}
        ${sel ? HANDLES.map(h => `<span class="te-h" data-h="${h}" style="left:${h.includes('w') ? 0 : h.includes('e') ? 100 : 50}%;top:${h.includes('n') ? 0 : h.includes('s') ? 100 : 50}%;cursor:${h === 'n' || h === 's' ? 'ns' : h === 'e' || h === 'w' ? 'ew' : h === 'nw' || h === 'se' ? 'nwse' : 'nesw'}-resize;"></span>`).join('') : ''}</div>`;
    };
    const fixed = (r, label) => `<div class="te-fixed" style="left:${px(r.x)}px;top:${px(r.y)}px;width:${px(r.w)}px;height:${px(r.h)}px;">${label}</div>`;
    page.innerHTML = fixed(base.header, 'header') + fixed(base.footer, 'footer')
      + `<div class="te-area" style="left:${px(CONTENT_MM.x)}px;top:${px(CONTENT_MM.y)}px;width:${px(CONTENT_MM.w)}px;height:${px(CONTENT_MM.h)}px;"></div>`
      + box('text', st.text, 'txt', 'Text') + st.images.map((r, i) => box(i, r, 'pic', `Picture ${i + 1}`)).join('')
      + (st.drag?.kind === 'draw' && st.drag.ghost ? `<div class="te-ghost" style="left:${px(st.drag.ghost.x)}px;top:${px(st.drag.ghost.y)}px;width:${px(st.drag.ghost.w)}px;height:${px(st.drag.ghost.h)}px;"></div>` : '');
    drawBar();
  }

  function drawBar() {
    const r = rectOf(st.sel), info = el.querySelector('[data-te="selinfo"]');
    if (!info.contains(document.activeElement)) {
      const isPic = st.sel !== 'text' && r;
      info.innerHTML = !r ? '' : `<b style="color:#fbbf24;">${st.sel === 'text' ? 'Text' : `Picture ${st.sel + 1}`}</b>
        ${['x', 'y', 'w', 'h'].map(k => `<label>${k.toUpperCase()} <input class="te-in te-num" data-te-num="${k}" type="number" step="0.5" value="${r[k]}"></label>`).join('')}<span>mm</span>
        ${isPic ? RATIOS.map(([l, v]) => `<button class="dw-btn" data-te-ratio="${v}" style="padding:2px 7px;" title="Keep the width, set the height for ${l}">${l}</button>`).join('') : ''}
        ${isPic ? `<button class="dw-btn" data-te="earlier" style="padding:2px 7px;" title="This frame gets an earlier picture"${st.sel === 0 ? ' disabled' : ''}>◀ #</button><button class="dw-btn" data-te="later" style="padding:2px 7px;" title="This frame gets a later picture"${st.sel === st.images.length - 1 ? ' disabled' : ''}># ▶</button>
        <button class="dw-btn" data-te="del" style="padding:2px 9px;color:#fca5a5;">Delete frame</button>` : ''}`;
    } else {
      for (const inp of info.querySelectorAll('[data-te-num]')) if (inp !== document.activeElement && r) inp.value = r[inp.dataset.teNum];
    }
    const p = problems();
    el.querySelector('[data-te="problems"]').textContent = p.length ? `⚠ ${p[0].text}${p.length > 1 ? ` (+${p.length - 1})` : ''}` : '';
    el.querySelector('[data-te="save"]').disabled = p.length > 0;
    el.querySelector('[data-te="add"]').disabled = st.images.length >= MAX_FRAMES;
  }

  const minOf = (key) => (key === 'text' ? [40, 12] : [15, 15]);
  const setRect = (key, r) => { const [mw, mh] = minOf(key); const c = clampRect(r, mw, mh); if (key === 'text') st.text = c; else st.images[key] = c; };

  // ── pointer: move / resize / draw ──
  const mmAt = (e) => { const b = page.getBoundingClientRect(); return { x: (e.clientX - b.left) / (MM * st.scale), y: (e.clientY - b.top) / (MM * st.scale) }; };
  page.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const handle = e.target.closest('[data-h]'), boxEl = e.target.closest('[data-box]');
    const at = mmAt(e);
    if (boxEl) {
      const key = boxEl.dataset.box === 'text' ? 'text' : Number(boxEl.dataset.box);
      st.sel = key;
      st.drag = { kind: handle ? 'resize' : 'move', h: handle?.dataset.h || '', key, at, start: { ...rectOf(key) } };
    } else if (at.x >= CONTENT_MM.x && at.x <= CONTENT_MM.x + CONTENT_MM.w && at.y >= CONTENT_MM.y && at.y <= CONTENT_MM.y + CONTENT_MM.h && st.images.length < MAX_FRAMES) {
      st.drag = { kind: 'draw', at, ghost: null };
    } else return;
    e.preventDefault();
    try { page.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    el.focus({ preventScroll: true });
    draw();
  });
  page.addEventListener('pointermove', (e) => {
    const d = st.drag; if (!d) return;
    const at = mmAt(e), dx = at.x - d.at.x, dy = at.y - d.at.y;
    if (d.kind === 'move') setRect(d.key, { ...d.start, x: d.start.x + dx, y: d.start.y + dy });
    else if (d.kind === 'resize') {
      let { x, y, w, h } = d.start; const [mw, mh] = minOf(d.key);
      if (d.h.includes('e')) w = Math.max(mw, d.start.w + dx);
      if (d.h.includes('s')) h = Math.max(mh, d.start.h + dy);
      if (d.h.includes('w')) { w = Math.max(mw, d.start.w - dx); x = d.start.x + d.start.w - w; }
      if (d.h.includes('n')) { h = Math.max(mh, d.start.h - dy); y = d.start.y + d.start.h - h; }
      // an edge dragged past the content area must stop there, not push the opposite edge
      const C = CONTENT_MM;
      if (x < C.x) { w -= C.x - x; x = C.x; } if (y < C.y) { h -= C.y - y; y = C.y; }
      w = Math.min(w, C.x + C.w - x); h = Math.min(h, C.y + C.h - y);
      setRect(d.key, { x, y, w, h });
    } else {
      const C = CONTENT_MM, cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const x0 = cl(Math.min(d.at.x, at.x), C.x, C.x + C.w), x1 = cl(Math.max(d.at.x, at.x), C.x, C.x + C.w);
      const y0 = cl(Math.min(d.at.y, at.y), C.y, C.y + C.h), y1 = cl(Math.max(d.at.y, at.y), C.y, C.y + C.h);
      d.ghost = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    draw();
  });
  const endDrag = () => {
    const d = st.drag; st.drag = null;
    if (d?.kind === 'draw' && d.ghost && d.ghost.w >= 15 && d.ghost.h >= 15) { st.images.push(clampRect(d.ghost)); st.sel = st.images.length - 1; }
    if (d) draw();
  };
  page.addEventListener('pointerup', endDrag);
  page.addEventListener('pointercancel', endDrag);

  // ── bar + keys ──
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-te], [data-te-ratio]'); if (!b) return;
    e.stopPropagation();
    if (b.dataset.teRatio) { const r = rectOf(st.sel); if (r && st.sel !== 'text') { setRect(st.sel, { ...r, h: r.w / Number(b.dataset.teRatio) }); draw(); } return; }
    const a = b.dataset.te;
    if (a === 'add') {
      const w = 80, h = 53.5, C = CONTENT_MM;
      // the first free spot on a coarse grid, else the bottom-left corner
      let spot = { x: C.x, y: C.y + C.h - h, w, h };
      outer: for (let y = C.y; y <= C.y + C.h - h; y += 4) for (let x = C.x; x <= C.x + C.w - w; x += 4) {
        const cand = { x, y, w, h };
        if (!templateProblems({ text: st.text, images: [...st.images, cand] }).some(p => p.b === st.images.length + 1 || p.a === st.images.length + 1)) { spot = cand; break outer; }
      }
      st.images.push(clampRect(spot)); st.sel = st.images.length - 1; draw();
    } else if (a === 'del') { if (st.sel !== 'text') { st.images.splice(st.sel, 1); st.sel = st.images.length ? Math.min(st.sel, st.images.length - 1) : 'text'; draw(); } }
    else if (a === 'earlier' || a === 'later') {
      const i = st.sel, j = a === 'earlier' ? i - 1 : i + 1;
      if (i !== 'text' && j >= 0 && j < st.images.length) { [st.images[i], st.images[j]] = [st.images[j], st.images[i]]; st.sel = j; draw(); }
    } else if (a === 'cancel') { close(); onCancel?.(); }
    else if (a === 'save') {
      if (problems().length) return;
      const nameInp = el.querySelector('[data-te="name"]');
      const name = nameInp.value.trim();
      if (!name) { nameInp.focus(); nameInp.style.borderColor = '#f59e0b'; nameInp.placeholder = 'A name first…'; return; }
      const out = sanitizeTemplate({ ...tpl, id: isNew ? '' : tpl.id, name, text: st.text, images: st.images });
      close(); onSave?.(out);
    }
  });
  el.addEventListener('change', (e) => {
    e.stopPropagation();
    const k = e.target.dataset?.teNum; if (!k) return;
    const r = rectOf(st.sel); if (!r) return;
    setRect(st.sel, { ...r, [k]: Number(e.target.value) }); draw();
  });
  el.addEventListener('input', (e) => e.stopPropagation());
  el.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.tagName === 'INPUT') { if (e.key === 'Escape') t.blur(); return; }
    const r = rectOf(st.sel);
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel !== 'text') { e.preventDefault(); st.images.splice(st.sel, 1); st.sel = st.images.length ? Math.min(st.sel, st.images.length - 1) : 'text'; draw(); return; }
    if (/^Arrow/.test(e.key) && r) {
      e.preventDefault();
      const k = e.shiftKey ? 5 : 1;
      setRect(st.sel, { ...r, x: r.x + (e.key === 'ArrowRight' ? k : e.key === 'ArrowLeft' ? -k : 0), y: r.y + (e.key === 'ArrowDown' ? k : e.key === 'ArrowUp' ? -k : 0) });
      draw(); return;
    }
    if (e.key === 'Tab') { e.preventDefault(); const order = ['text', ...st.images.map((_, i) => i)]; st.sel = order[(order.indexOf(st.sel) + (e.shiftKey ? order.length - 1 : 1)) % order.length]; draw(); }
  });

  // keep the keyboard: a click on dead space must leave the focus on the editor (arrows nudge, Delete removes)
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (!e.target.closest('input,button,select')) setTimeout(() => { if (el.isConnected) el.focus({ preventScroll: true }); }, 0);
  });

  // The bar wraps to more or fewer lines depending on what is selected, which changes the room the page has:
  // follow the STAGE's size, not just the window's.
  let lastW = 0, lastH = 0;
  const ro = new ResizeObserver(() => { if (stage.clientWidth !== lastW || stage.clientHeight !== lastH) { lastW = stage.clientWidth; lastH = stage.clientHeight; layout(); } });
  ro.observe(stage);
  function close() { ro.disconnect(); el.remove(); }

  layout();
  el.focus({ preventScroll: true });
  return { close, el, _state: st };
}
