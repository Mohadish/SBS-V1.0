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
  applyPolySession, discardPolySession, polySessionUndoScope, polyPrimitiveKinds, polyAddPrimitive,
  polyShowMenu, polySetPivotMode, isPolyPivotMode,
  setPolyTab, setPolyBackground, polyApplyPreset, polyNewColor,
} from '../systems/poly-session.js';

let _root = null, _treeEl = null, _unsub = null, _hiddenContent = null;
const _collapsed = new Set();
let _dragIds = null;
let _newHex = '#8fa3b8', _newName = '';   // the "new colour" row survives the panel's re-renders

const VIEWS = [['persp', 'Persp'], ['top', 'Top'], ['front', 'Front'], ['left', 'Left'], ['right', 'Right'], ['bottom', 'Bottom'], ['back', 'Back']];

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
  _unsub = onPolySession((what) => { if (what === 'close') return; _render(); });
  _render();
}

export function closePolyEditorPanel() {
  _unsub?.(); _unsub = null;
  if (_root) { _root.remove(); _root = null; _treeEl = null; }
  if (_hiddenContent) { for (const [c, d] of _hiddenContent) c.style.display = d; _hiddenContent = null; }
  _collapsed.clear();
}

function _render() {
  if (!_root) return;
  const info = polySessionInfo();
  if (!info) return;
  const keepName = document.activeElement?.id === 'poly-editor-name';
  const scroll = _treeEl?.scrollTop || 0;
  _root.innerHTML = '';

  const head = el('div', 'display:flex;align-items:center;gap:8px;');
  head.append(el('div', 'font-size:16px;font-weight:700;', '⬚ Poly Editor'), el('div', 'flex:1;'));
  const scopeOk = (redo) => (redo ? undoManager.redoScope?.() : undoManager.undoScope?.()) === polySessionUndoScope;
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
  for (const [id, label, tip] of [['model', '⬚ Model', 'Add, edit and arrange the parts'], ['colors', '🎨 Colours', "Colour parts with the scene's colours"], ['env', '🌄 Environment', 'The background of this editor']]) {
    tabs.append(btn(label, tip, () => setPolyTab(id), `flex:1;${info.tab === id ? 'background:#334155;border-color:#94a3b8;color:#fff;' : ''}`));
  }
  _root.append(tabs);
  if (info.tab === 'colors') { _renderColours(info); return; }
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

/** 🎨 the scene's colours: click one = the selected parts wear it; a new one is added to the scene too. */
function _renderColours(info) {
  _root.append(section("The scene's colours"));
  _root.append(el('div', 'font-size:12px;opacity:.8;margin-bottom:7px;', info.selParts
    ? `Click a colour to put it on the ${info.selParts === 1 ? 'selected part' : `${info.selParts} selected parts`}.`
    : 'Select a part in the view (or in the Model tab), then click a colour.'));
  const grid = el('div', 'display:flex;flex-wrap:wrap;gap:6px;max-height:42vh;overflow:auto;padding:2px;');
  for (const p of info.colors) {
    const b = el('button', `width:30px;height:30px;padding:0;border-radius:7px;cursor:pointer;background:${p.color};border:2px solid ${info.selPreset === p.id ? '#ffffff' : 'rgba(255,255,255,.2)'};${info.selPreset === p.id ? 'box-shadow:0 0 0 2px #2563eb;' : ''}`);
    b.title = p.name;
    b.addEventListener('click', (e) => { e.preventDefault(); polyApplyPreset(p.id); b.blur(); });
    grid.append(b);
  }
  if (!info.colors.length) grid.append(el('div', 'font-size:12px;opacity:.6;', 'The scene has no colours yet — make one below.'));
  _root.append(grid);

  _root.append(section('New colour'));
  const nr = el('div', 'display:flex;align-items:center;gap:6px;');
  const pick = el('input', 'width:40px;height:32px;padding:0;border:1px solid var(--line,#334155);border-radius:7px;background:transparent;cursor:pointer;flex:0 0 auto;');
  pick.type = 'color'; pick.value = _newHex; pick.title = 'Choose the colour';
  pick.addEventListener('input', () => { _newHex = pick.value; });
  const nm = el('input', 'flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:1px solid var(--line,#334155);background:transparent;color:inherit;font-size:13px;');
  nm.placeholder = 'Name (optional)'; nm.value = _newName;
  nm.addEventListener('input', () => { _newName = nm.value; });
  nm.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); add(); } });
  const add = () => { const name = _newName.trim(); _newName = ''; polyNewColor(_newHex, name); };
  nr.append(pick, nm, btn('＋ Add', "Add this colour to the scene's colours — and put it on the selected part(s)", add));
  _root.append(nr);
  _root.append(_note("A colour made here is added to the project's colours as well. After Apply, the parts wear these same colours in the scene."));
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
