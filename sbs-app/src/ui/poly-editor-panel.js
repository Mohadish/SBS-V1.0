/**
 * ⬚ POLY EDITOR PANEL (V0.3.5.14) — the left side while the Poly Editor is open.
 *
 * Covers the project's sidebar (the project tree, the tabs) with the editor's
 * own: the asset's name, Apply / Discard, the VIEWS (in place of steps), the
 * sub-object LEVEL, a few tools and the editor's TREE — folders and parts the
 * user arranges by dragging; that arrangement is the structure of the saved
 * .glb. Everything here calls systems/poly-session.js; this file only draws.
 */
import { undoManager } from '../systems/undo.js';
import {
  onPolySession, polySessionInfo, setPolySessionName, polySelect, polyRename, polyNewFolder, polyMove,
  polyDeleteSelected, polyDuplicateSelected, polyEnterSub, polyExitSub, polyCleanSelected, setPolyView, polyFit,
  applyPolySession, discardPolySession, polySessionUndoOk, polyPrimitiveKinds, polyAddPrimitive,
  polyShowMenu, polySetPivotMode, isPolyPivotMode, polySetScaleMode, polySetScalePercent,
  setPolyTab, setPolyBackground, polyColorsHost, polyProjectPictures, polyRemoveProjection,
} from '../systems/poly-session.js';
import { quadForExtent, quadCoords, isUnitExtent, framedWarp } from '../systems/perspective-warp.js';   // ⌗ V0.3.5.29 — the frame
import { mountColorsPanel, unmountColorsPanel, refreshColorsPanel } from './sidebar-left.js';   // ⬚ V0.3.5.27 — the project's own Colours panel
import { REF_VIEWS, addPolyRef, removePolyRef, squarePolyRef, selectPolyRef, setPolyRefsEdit, setPolyRefProps, movePolyRefOrder } from '../systems/poly-refs.js';   // ⬚ V0.3.5.25

let _root = null, _treeEl = null, _unsub = null, _hiddenContent = null;
const _collapsed = new Set();
let _dragIds = null;
let _coloursMount = null, _coloursHost = null;   // ⬚ V0.3.5.27 — the project's Colours panel lives in this element while its tab shows

const VIEWS = [['persp', 'Persp'], ['top', 'Top'], ['front', 'Front'], ['left', 'Left'], ['right', 'Right'], ['bottom', 'Bottom'], ['back', 'Back']];

// Chromium drops a click whose target was rebuilt between the press and the release. A field's `change` fires
// ON that press (the focus leaves it), so what it starts is held until the press is over.
let _pressing = false; const _afterUp = [];
const _afterPress = (fn) => { if (_pressing) _afterUp.push(fn); else fn(); };
const _onPressDown = (e) => { if (_root?.contains(e.target)) _pressing = true; };
const _onPressUp = () => { _pressing = false; if (!_afterUp.length) return; const q = _afterUp.splice(0); setTimeout(() => { for (const f of q) { try { f(); } catch (err) { console.warn('[poly editor] deferred', err); } } }, 0); };

const el = (tag, css = '', text = '') => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; };
function btn(label, title, onClick, extraCss = '') {
  const b = el('button', `padding:5px 9px;font-size:12px;border-radius:8px;${extraCss}`, label);
  b.className = 'btn'; b.title = title || '';
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(e); b.blur(); });
  return b;
}
const section = (title) => el('div', 'font-size:11px;font-weight:700;letter-spacing:.6px;opacity:.65;margin:12px 0 5px;text-transform:uppercase;', title);
const row = () => el('div', 'display:flex;flex-wrap:wrap;gap:5px;');

export function openPolyEditorPanel() {
  if (_root) return;
  const host = document.getElementById('sidebar-left');
  if (!host) return;
  _hiddenContent = [];
  for (const c of [...host.children]) { _hiddenContent.push([c, c.style.display]); c.style.display = 'none'; }
  _root = el('div', 'flex:1;min-height:0;display:flex;flex-direction:column;padding:12px;gap:2px;overflow:hidden;color:var(--text,#e5e7eb);');
  _root.id = 'poly-editor-panel';
  host.appendChild(_root);
  window.addEventListener('pointerdown', _onPressDown, true);
  window.addEventListener('pointerup', _onPressUp, true);
  window.addEventListener('pointercancel', _onPressUp, true);
  _unsub = onPolySession((what) => { if (what === 'close') return; _render(what); });
  _render();
}

export function closePolyEditorPanel() {
  _unsub?.(); _unsub = null;
  window.removeEventListener('pointerdown', _onPressDown, true);
  window.removeEventListener('pointerup', _onPressUp, true);
  window.removeEventListener('pointercancel', _onPressUp, true);
  _pressing = false; _afterUp.length = 0;
  _dropColours();
  if (_root) { _root.remove(); _root = null; _treeEl = null; }
  if (_hiddenContent) { for (const [c, d] of _hiddenContent) c.style.display = d; _hiddenContent = null; }
  _collapsed.clear();
}

function _dropColours() {
  if (_coloursHost) { try { unmountColorsPanel(); } catch (err) { console.warn('[poly editor] colours panel', err); } }
  _coloursHost = null; _coloursMount = null;
}

function _render(what) {
  if (!_root) return;
  const info = polySessionInfo();
  if (!info) return;
  // The Colours tab holds the project's own panel: it redraws itself (and waits while one of its fields is in
  // use). A selection / tree / undo event must not tear it down — only a change of what is around it does.
  if (info.tab === 'colors' && _coloursHost && _coloursMount?.isConnected && (what === 'select' || what === 'tree' || what === 'undo')) {
    _coloursHost.syncSelection(); refreshColorsPanel();
    return;
  }
  if (info.tab !== 'colors') _dropColours();
  const keepName = document.activeElement?.id === 'poly-editor-name';
  const scroll = _treeEl?.scrollTop || 0, coloursScroll = _coloursMount?.scrollTop || 0;   // an element taken out of the page forgets its scroll
  _root.innerHTML = '';

  const head = el('div', 'display:flex;align-items:center;gap:8px;');
  head.append(el('div', 'font-size:16px;font-weight:700;', '⬚ Poly Editor'), el('div', 'flex:1;'));
  const scopeOk = (redo) => polySessionUndoOk(redo);
  head.append(btn('↶', 'Undo (Ctrl+Z)', () => { if (scopeOk(false)) undoManager.undo(); }), btn('↷', 'Redo (Ctrl+Y)', () => { if (scopeOk(true)) undoManager.redo(); }));
  _root.append(head);

  const nameRow = el('div', 'display:flex;align-items:center;gap:6px;margin-top:8px;');
  const name = el('input', 'flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:1px solid var(--line,#334155);background:transparent;color:inherit;font-size:13px;');
  name.id = 'poly-editor-name'; name.value = info.reedit ? info.reedit.file : info.name;
  name.title = info.reedit ? 'The asset being edited. Apply asks: replace it, or save it as a new asset under another name' : 'The name of the asset (the .glb file and the model in the tree) — Apply asks again';
  if (info.reedit) { name.readOnly = true; name.style.opacity = '.75'; }
  name.addEventListener('input', () => { if (!info.reedit) setPolySessionName(name.value); });
  name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') name.blur(); });
  nameRow.append(el('span', 'font-size:12px;opacity:.7;', 'Asset'), name);
  _root.append(nameRow);

  const act = row(); act.style.marginTop = '8px';
  const green = 'flex:1;background:#14532d;border-color:#22c55e;color:#dcfce7;font-weight:600;';
  if (info.reedit) {
    // re-editing an asset that is already in the project: Apply asks — replace it (the default) or save a copy
    act.append(
      btn('✔ Apply…', `Save the edit: replace ${info.reedit.file} (the same model, updated in every step) or save it as a new asset`, () => applyPolySession(), green),
      btn('✕ Discard', 'Close the editor; the project stays exactly as it was', () => discardPolySession()),
    );
    _root.append(act);
  } else {
    act.append(
      btn('✔ Apply…', 'Name the asset, write the tree as one .glb into the project\'s models folder and load it into the scene', () => applyPolySession(), green),
      btn('✕ Discard', 'Close the editor; the project stays exactly as it was', () => discardPolySession()),
    );
    _root.append(act);
  }

  _root.append(section('Views'));
  const views = row();
  for (const [id, label] of VIEWS) views.append(btn(label, id === 'persp' ? 'Perspective' : `Look from the ${id} — flat (no perspective)`, () => setPolyView(id), info.view === id ? 'background:#1d4ed8;border-color:#60a5fa;color:#fff;' : ''));
  views.append(btn('⛶ Fit', 'Frame the selection, or everything (F)', () => polyFit()));
  _root.append(views);

  // ⬚ V0.3.5.22 — tabs: the model (add / level / tools / tree) · the scene's colours · the editor's background
  const tabs = row(); tabs.style.marginTop = '10px';
  for (const [id, label, tip] of [['model', '⬚ Model', 'Add, edit and arrange the parts'], ['refs', '🖼 Refs', 'Reference pictures — one set per flat view — to model against'], ['colors', '🎨 Colours', "Colour parts with the scene's colours"], ['env', '🌄 Env', 'The background of this editor']]) {
    tabs.append(btn(label, tip, () => setPolyTab(id), `flex:1;${info.tab === id ? 'background:#334155;border-color:#94a3b8;color:#fff;' : ''}`));
  }
  _root.append(tabs);
  if (info.tab === 'refs') { _renderRefs(info); return; }
  if (info.tab === 'colors') { _renderColours(coloursScroll); return; }
  if (info.tab === 'env') { _renderEnv(info); return; }

  _root.append(section('Level'));
  const lv = row();
  const on = 'background:#1d4ed8;border-color:#60a5fa;color:#fff;';
  lv.append(
    btn('Object', 'Select and move whole parts', () => polyExitSub(), info.level === 'object' ? on : ''),
    btn('Vertices (1)', 'Edit the vertices of the selected part', () => polyEnterSub('vertex'), info.level === 'vertex' ? on : ''),
    btn('Faces (4)', 'Edit the faces of the selected part — extrude, loop cut, join / cut', () => polyEnterSub('face'), info.level === 'face' ? on : ''),
  );
  const edges = btn('Edges (2)', 'Not built yet', () => {}); edges.disabled = true; lv.append(edges);
  lv.append(btn('✛ Pivot', 'Move / turn only the PIVOT of the selected part or folder — the geometry stays (Esc ends it). More under right-click ▸ Pivot.', () => polySetPivotMode(!isPolyPivotMode()), isPolyPivotMode() ? 'background:#9a3412;border-color:#fb923c;color:#fff;' : ''));
  _root.append(lv);
  // ⬚ V0.3.5.28 — scale: a 3D box around the selection, a pyramid and a flat triangle on each face
  const scr = row(); scr.style.marginTop = '5px';
  scr.append(btn('⤢ Scale', 'A box around the selection. Pull a pyramid = stretch that side (the opposite side stays; Alt = from the centre; Shift = every direction equally). Pull a coloured corner triangle = scale that face\'s two directions (the opposite corner stays; Shift = keep the proportions; Alt = from the centre). Pull the WHITE tip of a corner = everything equally, the corner across the box stays (Alt = from the centre). Esc ends it.', () => polySetScaleMode(!info.scale), `flex:1;${info.scale ? 'background:#9a3412;border-color:#fb923c;color:#fff;' : ''}`));
  _root.append(scr);
  if (info.scl) {
    // the scale record of the one selected object: 100 % = as it came into the editor. Typing rescales it.
    const sz = el('div', 'display:flex;align-items:center;gap:4px;margin-top:5px;font-size:12px;');
    sz.title = 'The size of the selected object along its own X / Y / Z, in % of how it came into the editor. Type a number (Enter) to rescale it about its pivot — 100 / 100 / 100 gives back the proportions it came with.';
    sz.append(el('span', 'opacity:.7;margin-right:2px;', 'Size %'));
    const boxes = info.scl.map((v, i) => {
      const inp = el('input', 'width:0;flex:1;min-width:0;padding:4px 5px;border-radius:7px;border:1px solid var(--line,#334155);background:transparent;color:inherit;font-size:12px;');
      inp.type = 'number'; inp.min = '1'; inp.step = '1'; inp.value = String(v);
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); else if (e.key === 'Escape') { inp.value = String(v); inp.blur(); } });
      inp.addEventListener('change', () => _afterPress(() => polySetScalePercent(boxes.map(b => Number(b.value)))));
      sz.append(el('span', 'opacity:.6;', 'XYZ'[i]), inp);
      return inp;
    });
    sz.append(btn('↺', 'Back to 100 / 100 / 100: the proportions it came with', () => polySetScalePercent([100, 100, 100]), 'padding:4px 7px;'));
    _root.append(sz);
  }

  // ⬚ V0.3.5.18 — primitives made inside the editor: editable polys from the first moment
  _root.append(section('Add'));
  const add = row();
  for (const p of polyPrimitiveKinds()) add.append(btn(`${p.icon} ${p.label}`, `Add a ${p.label.toLowerCase()} where you are looking — an editable poly: 1 / 4 go into its vertices / faces`, () => polyAddPrimitive(p.kind)));
  _root.append(add);

  _root.append(section('Tools'));
  const tools = row();
  tools.append(
    btn('📁 Folder', 'A new folder (around the selection, if there is one)', () => polyNewFolder()),
    btn('⧉ Duplicate', 'Duplicate the selection (Ctrl+D)', () => polyDuplicateSelected()),
    btn('🗑 Delete', 'Delete the selection (Del)', () => polyDeleteSelected()),
    btn('⬚ Clean edges', 'Merge coplanar faces of the selected part(s)', () => polyCleanSelected()),
  );
  _root.append(tools);

  _root.append(section(`Tree — ${info.parts} part${info.parts === 1 ? '' : 's'} · how it is arranged here is how the objects are separated in the asset`));
  _treeEl = el('div', 'flex:1;min-height:80px;overflow:auto;border:1px solid var(--line,#334155);border-radius:10px;padding:4px 0;');
  _treeEl.className = 'tree';
  _treeEl.addEventListener('dragover', (e) => { if (_dragIds) e.preventDefault(); });
  _treeEl.addEventListener('drop', (e) => { if (!_dragIds) return; e.preventDefault(); const ids = _dragIds; _dragIds = null; polyMove(ids, null); });
  _treeEl.addEventListener('click', (e) => { if (e.target === _treeEl) polySelect([]); });
  for (const r of info.tree) _treeEl.append(_treeRow(r, info));
  _root.append(_treeEl);
  _treeEl.scrollTop = scroll;

  _root.append(el('div', 'font-size:11px;opacity:.6;margin-top:6px;line-height:1.35;', 'Drag a row onto a folder to put it inside, onto a part to place it before it, onto the empty area to bring it to the top level. Double-click a name to rename.'));
  if (keepName) { const n = document.getElementById('poly-editor-name'); n?.focus(); n?.setSelectionRange?.(n.value.length, n.value.length); }
}

const _note = (text) => el('div', 'font-size:11px;opacity:.65;margin-top:8px;line-height:1.4;', text);

/** 🎨 the project's own Colours panel (ui/sidebar-left.js), with the editor's parts as "the selection". */
function _renderColours(scroll = 0) {
  if (!_coloursMount) _coloursMount = el('div', 'flex:1;min-height:0;overflow:auto;margin-top:8px;');
  _root.append(_coloursMount);                             // the same element across re-renders: a field in use is not rebuilt under the hand
  if (!_coloursHost) { _coloursHost = { el: _coloursMount, ...polyColorsHost() }; _coloursHost.syncSelection(); mountColorsPanel(_coloursHost); }
  else { _coloursHost.syncSelection(); refreshColorsPanel(); }
  _coloursMount.scrollTop = scroll;
}

/** 🖼 reference pictures: one set per flat view, standing on the object's centre. */
function _renderRefs(info) {
  const R = info.refs, flat = REF_VIEWS.includes(R.view), cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  _root.append(section('Reference pictures'));
  const top = row();
  top.append(
    btn(`＋ Add a picture${flat ? ` to ${cap(R.view)}` : ' (to Front)'}`, 'Choose a picture, square it up with four corners, and put it on this view', () => addPolyRef(), 'flex:1;font-weight:600;'),
    btn('✥ Move / scale', 'Grab a picture in the view and drag it, or pull one of its corners (Ctrl + a corner = stretch it wider / taller). Where you leave it is its home. (Esc ends it.)', () => setPolyRefsEdit(!R.edit), R.edit ? 'background:#9a3412;border-color:#fb923c;color:#fff;' : ''),
  );
  _root.append(top);
  if (!flat) _root.append(_note('You are in Persp: the pictures are hidden. They show only in the flat views — pick Top, Front, Left… above.'));
  const list = el('div', 'flex:1;min-height:60px;overflow:auto;margin-top:8px;border:1px solid var(--line,#334155);border-radius:10px;padding:4px 0;');
  let any = false;
  for (const view of REF_VIEWS) {
    const items = R.list.filter(r => r.view === view);
    if (!items.length) continue;
    any = true;
    const head = el('div', `display:flex;align-items:center;gap:6px;padding:5px 8px 3px;font-size:11px;font-weight:700;letter-spacing:.5px;cursor:pointer;${R.view === view ? 'color:#60a5fa;' : 'opacity:.7;'}`, `${cap(view).toUpperCase()}${R.view === view ? ' — this view' : ''}`);
    head.title = `Go to the ${cap(view)} view`;
    head.addEventListener('click', () => setPolyView(view, { fit: false }));
    list.append(head);
    for (const r of items.slice().reverse()) {              // the top of the stack first
      const on = R.sel === r.id;
      const box = el('div', `padding:4px 8px;${on ? 'background:rgba(56,189,248,.12);' : ''}`);
      const line = el('div', 'display:flex;align-items:center;gap:4px;');
      const eye = btn(r.visible ? '👁' : '🚫', r.visible ? 'Hide this picture' : 'Show this picture', () => setPolyRefProps(r.id, { visible: !r.visible }), 'padding:2px 6px;');
      const name = el('span', `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;cursor:pointer;${r.missing ? 'color:#f87171;' : ''}`, r.missing ? `${r.name} — file not found` : r.name);
      name.title = 'Select it (and go to its view)';
      name.addEventListener('click', () => selectPolyRef(r.id));
      line.append(eye, name,
        btn(r.proj ? '🎯' : '⊘', r.proj ? 'Used in the projection (merged with the other pictures of this view) — click to leave it out' : 'Left out of the projection — click to use it', () => setPolyRefProps(r.id, { proj: !r.proj }), `padding:2px 6px;${r.proj ? '' : 'opacity:.55;'}`),
        btn('▲', 'Bring it forward (over the other pictures of this view)', () => movePolyRefOrder(r.id, 1), 'padding:2px 6px;'),
        btn('▼', 'Send it back', () => movePolyRefOrder(r.id, -1), 'padding:2px 6px;'),
        btn('⌗', 'Square it up again — four corners onto what should be a rectangle', () => squarePolyRef(r.id), 'padding:2px 6px;'),
        btn('🗑', 'Remove this picture', () => removePolyRef(r.id), 'padding:2px 6px;'));
      box.append(line);
      if (on && !r.missing) {
        const opt = el('div', 'display:flex;align-items:center;gap:8px;margin-top:5px;font-size:12px;');
        const sl = el('input', 'flex:1;min-width:0;'); sl.type = 'range'; sl.min = '0.05'; sl.max = '1'; sl.step = '0.05'; sl.value = String(r.opacity); sl.title = 'How solid the picture is';
        sl.addEventListener('input', () => setPolyRefProps(r.id, { opacity: Number(sl.value) }, { live: true }));
        sl.addEventListener('change', () => setPolyRefProps(r.id, { opacity: Number(sl.value) }));
        const fr = el('label', 'display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = r.front;
        cb.addEventListener('change', () => setPolyRefProps(r.id, { front: cb.checked }));
        fr.title = 'Draw the picture OVER the model (see-through), to trace on top of it. Off = behind the model.';
        fr.append(cb, el('span', '', 'over the model'));
        opt.append(el('span', 'opacity:.7;', 'Opacity'), sl, fr);
        box.append(opt);
        const sz = el('div', 'display:flex;align-items:center;gap:6px;margin-top:5px;font-size:12px;');
        const w = el('input', 'width:90px;padding:3px 6px;border-radius:6px;border:1px solid var(--line,#334155);background:transparent;color:inherit;font-size:12px;');
        w.value = String(Math.round(r.size * 1000) / 1000); w.title = 'The width of the picture in the scene';
        let wLast = r.size;                                   // what was committed last (Enter then the trailing "change" commit once; the field keeps working without a redraw)
        const commitW = (quiet) => { const v = parseFloat(w.value); if (!(v > 0) || Math.abs(v - wLast) <= 1e-9) return; wLast = v; setPolyRefProps(r.id, { size: v }, { quiet }); };
        w.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commitW(false); } });
        w.addEventListener('change', () => commitW(true));   // left by a click elsewhere: no redraw under that click
        sz.append(el('span', 'opacity:.7;', 'Width'), w, el('span', 'opacity:.55;', r.squared ? '· squared up' : '· as it is'));
        box.append(sz);
        // ⬚ V0.3.5.33 — stretched (Ctrl + a corner): how much taller / flatter than its own proportion, and the way back
        const st = el('div', 'display:flex;align-items:center;gap:6px;margin-top:5px;font-size:12px;');
        const k = r.stretch || 1, off = Math.abs(k - 1) > 1e-4;
        st.append(el('span', 'opacity:.7;flex:1;', off ? `Stretched: height ${Math.round(k * 1000) / 10} % of its own proportion` : 'Its own proportion (Ctrl + a corner stretches it)'));
        if (off) st.append(btn('↺ Proportion', 'Back to the picture\'s own proportion (the width stays)', () => setPolyRefProps(r.id, { stretch: 1 }), 'padding:2px 8px;'));
        box.append(st);
      }
      list.append(box);
    }
  }
  if (!any) list.append(el('div', 'padding:10px;font-size:12px;opacity:.6;line-height:1.45;', 'No pictures yet. Go to a flat view (Front, Top, Left…) and add the picture of the object seen from there.'));
  _root.append(list);
  _root.append(_note("A picture stands in the scene on the object's centre: it grows and shrinks with the zoom, and shows only in its own flat view. It is kept with the asset by its file's path."));
  // ⬚ V0.3.5.30 — box projection: every face takes the picture of the side it faces most
  _root.append(section('Project onto the model'));
  const pr = row();
  pr.append(
    btn(`🎯 Project${info.selParts ? ` onto ${info.selParts === 1 ? 'the selected part' : `${info.selParts} parts`}` : ' onto every part'}`, 'Box projection: every face takes the picture of the side it faces most (right / left, top / bottom, front / back), straight along that axis. A side with no picture can borrow the opposite one, through the part — you are asked.', () => polyProjectPictures(), 'flex:1;font-weight:600;'),
    btn('✕ Remove', 'Take the projection off the selected parts (none selected = every part)', () => polyRemoveProjection()),
  );
  _root.append(pr);
  _root.append(_note(info.projected ? `${info.projected} part${info.projected === 1 ? ' has' : 's have'} the pictures projected on. Move, scale or square a picture and its projection follows. A preview for now: Apply does not write it into the asset yet.` : 'Line the pictures up with the model (✥ Move / scale), then project. Hiding a picture does not take its projection away.'));
  _root.append(_note('All the pictures of a view that have 🎯 are merged into one and projected together — the higher in the list covers the lower, like layers: a close-up squared up and enlarged over the whole shot, a sticker on top. Outside the pictures the part keeps its colour.'));
}

/**
 * ⌗ Square a picture up: four corners dragged onto what should be a rectangle (a face of the object, a
 * drawing's frame). V0.3.5.29 — the FRAME: the thing you can trust is often smaller than what you want, so
 * each edge has a square handle; pulling it moves that edge out (or in) while the perspective the corners
 * fixed stays — the frame can take in the whole of what is needed.
 * sq = what the dialog was left at last time ({ ref, ext, aspect }), to open it the same way.
 * → { quad: [tl, tr, br, bl] of what is cut out (fractions of the picture), aspect: w / h | null, sq } | 'asis' | null.
 */
export function askPolySquareUp(src, { title = 'Reference picture', quad = null, aspect = null, sq = null } = {}) {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'max-width:96vw;border-radius:14px;border:1px solid var(--line,#334155);background:var(--panel,#0f172a);color:var(--text,#e5e7eb);padding:16px 18px;');
    dlg.append(el('div', 'font-size:16px;font-weight:700;margin-bottom:4px;', `⌗ ${title}`));
    dlg.append(el('div', 'font-size:12px;opacity:.75;line-height:1.45;margin-bottom:8px;max-width:820px;', 'A photo is never square-on. Drag the four round corners onto something that SHOULD be a rectangle — a face of the object, a label, the frame of a drawing: that fixes the perspective. Then pull the square handles on the edges to make the frame as big as what you need: the perspective stays. A drawing or a clean front shot can be used as it is.'));
    // the picture sits inside a border of empty room, so the frame can be pulled out past it
    const k0 = Math.min((window.innerWidth * 0.8) / src.width, (window.innerHeight * 0.56) / src.height, 1);
    const PAD = Math.max(28, Math.min(110, Math.round(Math.min(src.width, src.height) * k0 * 0.16)));
    const k = Math.min((window.innerWidth * 0.86 - 2 * PAD) / src.width, (window.innerHeight * 0.62 - 2 * PAD) / src.height, 1);
    const W = Math.max(60, Math.round(src.width * k)), H = Math.max(60, Math.round(src.height * k));
    const wrap = el('div', `position:relative;width:${W + 2 * PAD}px;height:${H + 2 * PAD}px;margin:0 auto;user-select:none;touch-action:none;background:rgba(127,127,127,.08);border-radius:8px;overflow:hidden;cursor:grab;`);
    const cv = el('canvas', 'position:absolute;left:0;top:0;display:block;'); cv.width = W + 2 * PAD; cv.height = H + 2 * PAD;
    const ov = el('canvas', 'position:absolute;left:0;top:0;pointer-events:none;'); ov.width = W + 2 * PAD; ov.height = H + 2 * PAD;
    // ⬚ V0.3.5.33 — the view of the picture: zoom (wheel, at the cursor) and pan (drag the picture, or the middle button)
    let vs = 1, vx = PAD, vy = PAD;
    wrap.append(cv, ov);
    const okQuad = (q) => Array.isArray(q) && q.length === 4 && q.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
    const start = okQuad(sq?.ref) ? sq.ref : okQuad(quad) ? quad : [{ x: 0.12, y: 0.12 }, { x: 0.88, y: 0.12 }, { x: 0.88, y: 0.88 }, { x: 0.12, y: 0.88 }];
    const pts = start.map(p => ({ x: p.x, y: p.y }));         // the reference: what should be a rectangle
    let ext = okQuad(sq?.ref) && !isUnitExtent(sq?.ext) ? sq.ext.slice() : [0, 0, 1, 1];   // the frame, in the reference's own coordinates
    const startAspect = okQuad(sq?.ref) ? (sq.aspect || null) : aspect;
    const X = (x) => vx + x * W * vs, Y = (y) => vy + y * H * vs;
    const dots = [], grips = [];
    const frame = () => quadForExtent(pts, ext);
    const path = (c, q) => { c.beginPath(); q.forEach((p, i) => (i ? c.lineTo(X(p.x), Y(p.y)) : c.moveTo(X(p.x), Y(p.y)))); c.closePath(); };
    const draw = () => {
      const c0 = cv.getContext('2d'); c0.clearRect(0, 0, cv.width, cv.height);
      c0.imageSmoothingEnabled = vs < 3;                     // close in, the picture's own pixels show as hard steps — what a corner is aimed at
      c0.drawImage(src, vx, vy, W * vs, H * vs);
      const c = ov.getContext('2d'); c.clearRect(0, 0, ov.width, ov.height);
      const f = frame(), own = !isUnitExtent(ext) && f;
      path(c, pts);
      if (!own) { c.fillStyle = 'rgba(56,189,248,0.10)'; c.fill(); }
      c.lineWidth = 2; c.strokeStyle = '#38bdf8'; c.setLineDash([8, 5]); c.stroke();
      if (own) { path(c, f); c.fillStyle = 'rgba(245,158,11,0.10)'; c.fill(); c.setLineDash([]); c.lineWidth = 2; c.strokeStyle = '#f59e0b'; c.stroke(); }
      dots.forEach((d, i) => { d.style.left = `${X(pts[i].x) - 9}px`; d.style.top = `${Y(pts[i].y) - 9}px`; });
      const q = f || pts;
      grips.forEach((g, i) => {
        const a = q[i], b2 = q[(i + 1) % 4];
        // kept inside the dialog's picture area: under perspective the middle of an edge can run out of it, and a grip that is clipped cannot be grabbed again
        const keep = (v, hi) => Math.min(hi, Math.max(0, v));
        g.style.left = `${keep(X((a.x + b2.x) / 2) - 8, W + 2 * PAD - 20)}px`; g.style.top = `${keep(Y((a.y + b2.y) / 2) - 8, H + 2 * PAD - 20)}px`;
        g.style.transform = `rotate(${Math.atan2(Y(b2.y) - Y(a.y), X(b2.x) - X(a.x))}rad)`;
      });
    };
    // A handle moves BY what the pointer moved, from where it was grabbed (never jumps onto the cursor: zoomed
    // in, a grip can sit pinned at the border far from its edge). start → what the move needs; move(x, y, s).
    const at = (ev) => { const r = wrap.getBoundingClientRect(); return { x: (ev.clientX - r.left - vx) / (W * vs), y: (ev.clientY - r.top - vy) / (H * vs) }; };
    const drag = (node, { start, move: onMove }) => node.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { node.setPointerCapture(e.pointerId); } catch { /* fine */ }
      const p0 = at(e), s = start(p0.x, p0.y);
      const move = (ev) => { const p = at(ev); onMove(p.x, p.y, s); draw(); };
      const up = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up); };
      node.addEventListener('pointermove', move); node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
    });
    pts.forEach((p, i) => {
      const d = el('div', 'position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;border:2px solid #38bdf8;box-shadow:0 1px 4px rgba(0,0,0,.6);cursor:grab;touch-action:none;z-index:2;');
      d.title = `${['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'][i]} corner of what should be a rectangle`;
      drag(d, {
        start: (x, y) => ({ dx: p.x - x, dy: p.y - y }),
        move: (x, y, s) => {
          const was = { x: p.x, y: p.y };
          p.x = Math.min(1, Math.max(0, x + s.dx)); p.y = Math.min(1, Math.max(0, y + s.dy));
          if (!frame()) { p.x = was.x; p.y = was.y; }        // that corner would throw the frame past the horizon
        },
      });
      dots.push(d); wrap.append(d);
    });
    for (let i = 0; i < 4; i++) {
      const g = el('div', 'position:absolute;width:16px;height:16px;border-radius:3px;background:#f59e0b;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6);touch-action:none;z-index:1;');
      g.style.cursor = i % 2 ? 'ew-resize' : 'ns-resize';
      g.title = `Pull the ${['top', 'right', 'bottom', 'left'][i]} edge of the frame out (or in) — the perspective stays`;
      // the edge moves by what the pointer moved, measured in the rectangle's own coordinates (the perspective's)
      const k = [1, 2, 3, 0][i];
      const keepIn = (x, y) => ({ x: Math.min((W + 2 * PAD - vx) / (W * vs), Math.max(-vx / (W * vs), x)), y: Math.min((H + 2 * PAD - vy) / (H * vs), Math.max(-vy / (H * vs), y)) });
      drag(g, {
        start: (x, y) => { const c = quadCoords(pts, keepIn(x, y)); return c ? { c, e: ext.slice() } : null; },
        move: (x, y, s) => {
          if (!s) return;
          const c = quadCoords(pts, keepIn(x, y)); if (!c) return;
          const e2 = s.e.slice(), d = i % 2 === 0 ? c.v - s.c.v : c.u - s.c.u;
          e2[k] = s.e[k] + d;
          if (i === 0) e2[1] = Math.max(-8, Math.min(e2[1], e2[3] - 0.05));
          else if (i === 1) e2[2] = Math.min(9, Math.max(e2[2], e2[0] + 0.05));
          else if (i === 2) e2[3] = Math.min(9, Math.max(e2[3], e2[1] + 0.05));
          else e2[0] = Math.max(-8, Math.min(e2[0], e2[2] - 0.05));
          if (quadForExtent(pts, e2)) ext = e2;              // not past the limit of the perspective
        },
      });
      grips.push(g); wrap.append(g);
    }
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!e.deltaY) return;                                 // a sideways scroll is not a zoom
      const r = wrap.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
      // a wheel notch (≈100) = one 1.25× step; a touchpad's many small events add up to the same, not one step each
      const s2 = Math.min(40, Math.max(0.5, vs * Math.pow(1.25, -Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100))));
      vx = cx - (cx - vx) * (s2 / vs); vy = cy - (cy - vy) * (s2 / vs); vs = s2;   // the point under the cursor stays under it
      draw();
    }, { passive: false });
    wrap.addEventListener('pointerdown', (e) => {
      if (e.target !== cv && e.target !== wrap) return;      // a corner or a grip has its own drag
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      try { wrap.setPointerCapture(e.pointerId); } catch { /* fine */ }
      let lx = e.clientX, ly = e.clientY;
      wrap.style.cursor = 'grabbing';
      const move = (ev) => { vx += ev.clientX - lx; vy += ev.clientY - ly; lx = ev.clientX; ly = ev.clientY; draw(); };
      const up = () => { wrap.style.cursor = 'grab'; wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up); wrap.removeEventListener('pointercancel', up); };
      wrap.addEventListener('pointermove', move); wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
    });
    wrap.addEventListener('auxclick', (e) => e.preventDefault());   // no autoscroll / paste on the middle button
    const fit = () => { vs = 1; vx = PAD; vy = PAD; draw(); };
    wrap.addEventListener('dblclick', (e) => { if (e.target === cv || e.target === wrap) fit(); });
    dlg.append(wrap);
    dlg.append(el('div', 'font-size:11px;opacity:.6;margin-top:5px;text-align:center;', 'Wheel = zoom in / out at the cursor · drag the picture (or the middle button) = move around · double-click = fit'));
    const bar = el('div', 'display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;');
    const sel = el('select', 'height:28px;font-size:12px;border-radius:6px;background:var(--panel,#0f172a);color:inherit;border:1px solid var(--line,#334155);');
    sel.title = "The width : height of what the four round corners mark. Auto measures it from the corners. (The frame's own proportion follows from it.)";
    for (const [v, l] of [['', 'Proportion: auto'], ['1', '1 : 1'], ['1.3333', '4 : 3'], ['1.5', '3 : 2'], ['1.7778', '16 : 9'], ['0.75', '3 : 4'], ['0.6667', '2 : 3']]) { const o = el('option', '', l); o.value = v; if (startAspect && Math.abs(Number(v) - startAspect) < 1e-3) o.selected = true; sel.append(o); }
    const done = (v) => { try { dlg.close(); } catch { /* fine */ } dlg.remove(); resolve(v); };
    const result = () => {
      const refAspect = Number(sel.value) || null, ref = pts.map(p => ({ x: p.x, y: p.y }));
      const f = isUnitExtent(ext) ? null : frame();
      if (!f) return { quad: ref, aspect: refAspect, sq: { ref, ext: [0, 0, 1, 1], aspect: refAspect } };
      // the frame's proportion: the reference's (as given, or measured in picture pixels) times how much wider / taller the frame is
      const fw = framedWarp(ref.map(p => ({ x: p.x * src.width, y: p.y * src.height })), refAspect, ext);
      return { quad: f, aspect: fw.w / fw.h, sq: { ref, ext: ext.slice(), aspect: refAspect } };
    };
    bar.append(sel,
      btn('⤢ Fit', 'Show the whole picture again', fit),
      btn('↺ Frame = the corners', 'Put the frame back on the four corners', () => { ext = [0, 0, 1, 1]; draw(); }),
      el('div', 'flex:1;'),
      btn('⌗ Square it up', 'Re-form the picture so the marked rectangle is one, and cut out the frame', () => done(result()), 'font-weight:600;background:#14532d;border-color:#22c55e;color:#dcfce7;'),
      btn('Use the picture as it is', 'No correction', () => done('asis')),
      btn('Cancel', '', () => done(null)));
    dlg.append(bar);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch { done(null); return; }
    draw();
  });
}

/** 🌄 the background of the editor: for seeing things here only. */
function _renderEnv(info) {
  _root.append(section('Background — this editor only'));
  const sw = row(), marks = [];
  for (const [hex, name] of [['#0f172a', 'Dark blue'], ['#000000', 'Black'], ['#3a3f4b', 'Dark grey'], ['#8b93a1', 'Grey'], ['#d7dbe2', 'Light grey'], ['#ffffff', 'White']]) {
    const b = el('button', `width:30px;height:30px;padding:0;border-radius:7px;cursor:pointer;background:${hex};border:2px solid ${info.bg === hex ? '#60a5fa' : 'rgba(255,255,255,.25)'};`);
    b.title = name;
    b.addEventListener('click', (e) => { e.preventDefault(); setPolyBackground(hex); });
    sw.append(b); marks.push([b, hex]);
  }
  const pick = el('input', 'width:40px;height:32px;padding:0;border:1px solid var(--line,#334155);border-radius:7px;background:transparent;cursor:pointer;');
  pick.type = 'color'; pick.value = info.bg || '#3a3f4b'; pick.title = 'Any colour';
  const backBtn = btn("↺ Use the project's background", 'Show the background the project has', () => setPolyBackground(null), info.bg ? '' : 'background:#334155;border-color:#94a3b8;color:#fff;');
  // Live, and WITHOUT redrawing the panel: the colour dialog closes on the mousedown of the next click, and a
  // panel rebuilt under that click would swallow it (the pressed button would be gone before the mouse is up).
  pick.addEventListener('input', () => {
    setPolyBackground(pick.value, { quiet: true });
    for (const [b, hex] of marks) b.style.borderColor = hex === pick.value.toLowerCase() ? '#60a5fa' : 'rgba(255,255,255,.25)';
    backBtn.style.background = ''; backBtn.style.borderColor = ''; backBtn.style.color = '';
  });
  sw.append(pick);
  _root.append(sw);
  const back = row(); back.style.marginTop = '8px';
  back.append(backBtn);
  _root.append(back);
  _root.append(_note("Only for seeing things in the Poly Editor. The project's own background — its steps and its exports — is not touched; it comes back when the editor closes. The choice is remembered for the next time."));
}

function _treeRow(r, info) {
  const wrap = el('div');
  const line = el('div', `display:flex;align-items:center;gap:6px;padding:4px 8px 4px ${8 + r.depth * 14}px;cursor:pointer;user-select:none;`);
  line.className = `tree-row${r.selected ? ' selected' : ''}`;
  line.draggable = true;
  const folder = r.kind === 'folder', closed = _collapsed.has(r.id);
  const tw = el('span', 'width:12px;display:inline-block;text-align:center;opacity:.7;', folder ? (closed ? '▸' : '▾') : '');
  if (folder) tw.addEventListener('click', (e) => { e.stopPropagation(); if (closed) _collapsed.delete(r.id); else _collapsed.add(r.id); _render(); });
  const label = el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', r.name);
  const dot = folder || !r.color ? null : el('span', `width:10px;height:10px;border-radius:3px;flex:0 0 auto;background:${r.color};border:1px solid rgba(255,255,255,.25);`);
  line.append(tw, el('span', '', folder ? '📁' : '⬚'), ...(dot ? [dot] : []), label);
  if (!folder) line.append(el('span', 'font-size:11px;opacity:.55;', `${r.faces} f`));
  // The first click re-renders the panel (selection), so a dblclick listener would land on a detached
  // label: the SECOND click (detail 2) starts the rename on the row that is on screen now.
  line.addEventListener('click', (e) => {
    if (e.detail >= 2 && !(e.ctrlKey || e.metaKey || e.shiftKey)) { e.stopPropagation(); _renameInline(label, r); return; }
    polySelect([r.id], { toggle: e.ctrlKey || e.metaKey || e.shiftKey });
  });
  // right-click a row = the same menu as right-clicking the object (align / pivot / …)
  line.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!info.selected.includes(r.id)) polySelect([r.id]);
    polyShowMenu(e.clientX, e.clientY);
  });
  line.addEventListener('dragstart', (e) => {
    _dragIds = info.selected.includes(r.id) ? info.selected.slice() : [r.id];
    try { e.dataTransfer.setData('text/plain', JSON.stringify(_dragIds)); e.dataTransfer.effectAllowed = 'move'; } catch { /* fine */ }
  });
  line.addEventListener('dragend', () => { _dragIds = null; });
  line.addEventListener('dragover', (e) => { if (!_dragIds || _dragIds.includes(r.id)) return; e.preventDefault(); e.stopPropagation(); line.classList.add('dropTarget'); });
  line.addEventListener('dragleave', () => line.classList.remove('dropTarget'));
  line.addEventListener('drop', (e) => {
    if (!_dragIds) return;
    e.preventDefault(); e.stopPropagation();
    const ids = _dragIds; _dragIds = null;
    line.classList.remove('dropTarget');
    if (ids.includes(r.id)) return;                          // dropped on itself (a sloppy click): nothing moves
    if (folder) { _collapsed.delete(r.id); polyMove(ids, r.id); } else polyMove(ids, r.parent || null, r.id);
  });
  wrap.append(line);
  if (folder && !closed) for (const c of r.children) wrap.append(_treeRow(c, info));
  return wrap;
}

function _renameInline(label, r) {
  const input = el('input', 'flex:1;min-width:0;padding:1px 4px;border-radius:5px;border:1px solid var(--line,#334155);background:transparent;color:inherit;font-size:inherit;');
  input.value = r.name;
  let done = false;
  const finish = (keep) => { if (done) return; done = true; const v = input.value; if (keep && v.trim() && v.trim() !== r.name) polyRename(r.id, v); else _render(); };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  label.replaceWith(input);
  input.focus(); input.select();
}

function _dialog(title, bodyNodes, buttons) {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'max-width:500px;border-radius:14px;border:1px solid var(--line,#334155);background:var(--panel,#0f172a);color:var(--text,#e5e7eb);padding:18px 20px;');
    dlg.append(el('div', 'font-size:16px;font-weight:700;margin-bottom:8px;', title));
    for (const n of bodyNodes) dlg.append(n);
    const box = el('div', 'display:flex;flex-direction:column;gap:7px;margin-top:12px;');
    const done = (v) => { try { dlg.close(); } catch { /* fine */ } dlg.remove(); resolve(v); };
    for (const [label, value, css] of buttons) box.append(btn(label, '', () => done(value), `justify-content:flex-start;${css || ''}`));
    dlg.append(box);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch { done(null); }
  });
}
const _p = (text) => el('div', 'font-size:13px;line-height:1.45;margin-bottom:8px;', text);

/**
 * ⬚ V0.3.5.30 — a projection reaches sides that have no picture, but the opposite side has one. His rule: say so,
 * and ask — project that picture THROUGH the part onto the other side (a mirror image)? Per side, the user's call.
 * items = [{ view, from }] → { view: true | false } | null (cancelled).
 */
export function askPolyProjectThrough(items) {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'max-width:520px;border-radius:14px;border:1px solid var(--line,#334155);background:var(--panel,#0f172a);color:var(--text,#e5e7eb);padding:18px 20px;');
    dlg.append(el('div', 'font-size:16px;font-weight:700;margin-bottom:8px;', '🎯 Sides without a picture'));
    dlg.append(_p('Some faces look toward a side that has no picture of its own — but the opposite side has one. Project that picture THROUGH the part onto them? (They get its mirror image; untick a side to leave its faces in the part\'s colour.)'));
    const Name = (v) => v[0].toUpperCase() + v.slice(1);
    const boxes = items.map(({ view, from }) => {
      const lab = el('label', 'display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0;cursor:pointer;');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = true;
      lab.append(cb, el('span', '', `${Name(view)} has no picture — use the ${Name(from)} picture, through the part`));
      dlg.append(lab);
      return [view, cb];
    });
    const done = (v) => { try { dlg.close(); } catch { /* fine */ } dlg.remove(); resolve(v); };
    const bar = el('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;');
    bar.append(
      btn('🎯 Project', 'Project the pictures', () => done(Object.fromEntries(boxes.map(([v, cb]) => [v, cb.checked]))), 'font-weight:600;background:#14532d;border-color:#22c55e;color:#dcfce7;'),
      btn('Cancel', '', () => done(null)));
    dlg.append(bar);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch { done(null); }
  });
}

function _nameInput(value) {
  const input = el('input', 'width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid var(--line,#334155);background:transparent;color:inherit;font-size:14px;margin-bottom:6px;');
  input.value = value || '';
  // Enter takes the name as it stands: the first button of the dialog (the one that goes on)
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); input.closest('dialog')?.querySelector('button')?.click(); } });
  setTimeout(() => { try { input.focus(); input.select(); } catch { /* fine */ } }, 0);
  return input;
}

/**
 * Apply on an asset that is already in the project → 'replace' | 'new' | null.
 * Replace is the default: the same file, the same model, every step. `changed` = what was done to the tree.
 */
export function askPolySaveHow({ file, canReplace, whyNot, changed }) {
  const body = [_p(`You edited ${file}. How should it be saved?`)];
  if (changed && canReplace) body.push(_p(`You changed its tree (${changed}). Replacing brings this project up to date in every step; other projects that use ${file} get the new tree the next time they open.`));
  if (!canReplace) body.push(_p(`It cannot be replaced: ${whyNot}`));
  return _dialog('Save the edit', body, [
    ...(canReplace ? [[`✔ Replace ${file} — the same model, updated in the project`, 'replace', 'font-weight:600;']] : []),
    [`＋ Save as a new asset… (${file} is left as it is)`, 'new', canReplace ? '' : 'font-weight:600;'],
    ['Cancel', null, ''],
  ]);
}

/** Opening the editor on objects of the project (or empty): the name of the new object → name | null (Cancel = do not open). */
export async function askPolyStartName({ name, count = 0 }) {
  const input = _nameInput(name);
  const ok = await _dialog('⬚ Poly Editor — name the object', [
    _p(count ? `${count === 1 ? 'This object goes' : `These ${count} objects go`} into one folder in the editor. What is it called?` : 'A new, empty object. What is it called?'),
    input,
    _p('It is the name of its folder, and the name the .glb is saved under (it can be changed at Apply). Press Enter to take this name.'),
  ], [
    ['✔ Open the editor', 'ok', 'font-weight:600;'],
    ['Cancel', null, ''],
  ]);
  return ok ? (input.value.trim() || name) : null;
}

/** A new asset: what is it called? → name | null. keeps = the asset it was made from (it stays as it is). */
export async function askPolyName({ name, keeps = null }) {
  const input = _nameInput(name);
  const ok = await _dialog('Save the asset', [
    _p("What should this model be called? It is written as one .glb into the project's models folder and loaded into the scene."),
    input,
    ...(keeps ? [_p(`It is added as a separate model, where it stands. ${keeps} is not touched — to hide or remove it, or to let the new one take its place, do that in the project afterwards.`)] : []),
  ], [
    ['✔ Save & load', 'ok', 'font-weight:600;'],
    ['Cancel', null, ''],
  ]);
  return ok ? (input.value.trim() || name) : null;
}

/** The update was refused: these hang on parts that were removed in the editor. */
export function showPolyBlocked(attached, file) {
  const list = el('div', 'font-size:13px;line-height:1.5;max-height:220px;overflow:auto;border:1px solid var(--line,#334155);border-radius:8px;padding:8px 10px;margin-bottom:8px;');
  for (const a of attached.slice(0, 40)) list.append(el('div', '', `• ${a.name} (${a.type || 'object'}) — on "${a.onName || a.on}"${a.where && a.where !== 'the scene' ? `, in ${a.where}` : ''}`));
  if (attached.length > 40) list.append(el('div', 'opacity:.7;', `… and ${attached.length - 40} more`));
  return _dialog(`${file} was not changed`, [
    _p('You removed parts that still have something attached to them in the project:'),
    list,
    _p('Move or delete those in the project first, or keep the parts — or save the edit as a new asset.'),
  ], [['OK', null, 'justify-content:center;font-weight:600;']]);
}

/**
 * After Apply: what about the objects the asset was made from?
 * → { action: 'keep' | 'archive' | 'delete', group: boolean } (or null when the dialog is dismissed = keep, no group).
 */
export function askPolyOriginals({ count, deletable }) {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'max-width:460px;border-radius:14px;border:1px solid var(--line,#334155);background:var(--panel,#0f172a);color:var(--text,#e5e7eb);padding:18px 20px;');
    dlg.append(el('div', 'font-size:16px;font-weight:700;margin-bottom:8px;', 'The new object is in the scene'));
    dlg.append(el('div', 'font-size:13px;line-height:1.45;margin-bottom:12px;', `It was made from ${count} object${count === 1 ? '' : 's'} that ${count === 1 ? 'is' : 'are'} still in the project. What should happen to ${count === 1 ? 'it' : 'them'}?`));
    const grpRow = el('label', 'display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:14px;cursor:pointer;');
    const grp = el('input'); grp.type = 'checkbox'; grp.checked = true;
    grpRow.append(grp, el('span', '', 'Keep them together as a selection group (Select tab)'));
    dlg.append(grpRow);
    const buttons = el('div', 'display:flex;flex-direction:column;gap:7px;');
    const done = (action) => { try { dlg.close(); } catch { /* fine */ } dlg.remove(); resolve(action ? { action, group: grp.checked } : null); };
    buttons.append(
      btn('🗃️ Archive them (hidden, kept in the tree) — recommended', '', () => done('archive'), 'justify-content:flex-start;font-weight:600;'),
      btn('Keep them as they are', '', () => done('keep'), 'justify-content:flex-start;'),
      btn(deletable ? `🗑 Delete the ${deletable} that can be deleted, archive the rest` : '🗑 Delete — none of these can be deleted (parts of imported models): archive instead', '', () => done(deletable ? 'delete' : 'archive'), 'justify-content:flex-start;'),
    );
    dlg.append(buttons);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch { done(null); }
  });
}
