/**
 * SBS Step Browser — Scene Tree Panel
 * ======================================
 * Features:
 *   - Expand / collapse nodes
 *   - Click to select, Ctrl+Click for multi-select
 *   - Eye button to toggle local visibility
 *   - Transform gizmo state icons for model/folder
 *   - Drag-and-drop to reparent nodes (cross-asset blocked)
 *   - Full right-click context menu (multi-select aware)
 *   - Auto-expand tree to show selected objects
 *   - Auto-collapse on deselect, remembers intentional expansions
 *   - Move To Folder dialog with inline folder creation
 */

import { state }                from '../core/state.js';
import { sceneCore }            from '../core/scene.js';
import { steps }                from '../systems/steps.js';
import * as actions             from '../systems/actions.js';
import { undoManager }          from '../systems/undo.js';
import {
  findNode,
  findParent,
  getPathToNode,
  collectDescendantIds,
  buildNodeMap,
  serializeModelTree,
}                               from '../core/nodes.js';
import {
  isTransformNode,
  applyAllTransforms,
  applyAllVisibility,
  applyNodeTransformToObject3D,
  captureTransformSnapshot,
  applyTransformSnapshot,
  setStoredQuaternion,
  isNearZero,
  isIdentityQuaternion,
}                               from '../core/transforms.js';
import { generateId }           from '../core/schema.js';
import { setStatus }            from './status.js';
import { showContextMenu, hideContextMenu, showConfirmDialog } from './context-menu.js';
import { showColorForNode, editHardwareTemplate } from './sidebar-left.js';
import * as folderAlignPicker   from '../systems/folder-align-picker.js';
import * as folderAlign3ptPicker from '../systems/folder-align-3pt-picker.js';

// ── State ────────────────────────────────────────────────────────────────────

// _intentional: nodes the user explicitly clicked open (persist until collapsed)
// _expanded:    superset — includes _intentional + auto-expanded ancestors of selection
const _intentional = new Set(['scene_root']);
const _expanded    = new Set(['scene_root']);

let _container  = null;
let _dragIds    = [];
let _dropTarget = null;
let _isDragging = false;

// V0.2.22.20 — progressive folder click counter. Plain (no-modifier) clicks
// on a non-locked folder row escalate the selection:
//   1st click  → just the folder
//   2nd click  → folder + DIRECT non-folder children (recursive into models /
//                meshes / shapes, but NOT into sub-folders)
//   3rd+ click → folder + entire subtree (the legacy behaviour)
// The counter resets if the user clicks a different node, waits past the
// window, or uses any selection modifier. Locked folders bypass the
// counter — they're always a unit (full subtree, single click).
let _lastFolderClickId = null;
let _lastFolderClickAt = 0;
let _folderClickCount  = 0;
const _FOLDER_CLICK_WINDOW_MS = 500;

// Copy/paste tree clipboard — session-scoped. Cleared only by a new copy
// or page reload. Stores the full snapshot needed to recreate added
// folders with their transforms/visibility/pivot intact:
//   { tree, transforms, visibility, folderBases, sourceStepName }
// folderBases captures baseLocal* fields (project-global, not in
// snapshot.transforms) per folder, so global-edit pivots / orientations
// survive paste even when the live folder node was wiped by step nav.
let _copiedSnapshot     = null;
let _copiedFromStepName = '';

// V0.2.20 — folder transform clipboard. Session-scoped (cleared on reload).
// Captures the CURRENT-STEP localOffset / localQuaternion / orientation /
// pivot* fields of a folder + every transform-bearing descendant, keyed by
// the descendant's RELATIVE PATH (name path) from the folder root. Letting
// paste target a DIFFERENT folder of the same shape, or the SAME folder in
// a different step (the main use-case: posing a folder once + pushing the
// same pose to other steps).
//
// Visibility / Show-Hide / materials are INTENTIONALLY not captured per
// user spec — Paste Transforms only moves transforms.
//
// Shape: { rootName, sourceStepName, entries: [{ relPath, type, name, xf }] }
let _folderXfClipboard = null;


// ── Init ─────────────────────────────────────────────────────────────────────

// V0.2.22.22 — state listeners are now registered at module load (below the
// initTree function), not inside it. Reason: before this fix, initTree only
// ran when the Tree tab was opened for the first time. If the user started
// in another tab (Colors / Files / etc.) and selected viewport objects,
// the listeners never fired, _expanded never tracked the selection, and
// switching to Tree later showed a collapsed view with the selected node
// hidden. Listeners now run on every selection regardless of which tab is
// active; _syncExpanded updates the expand set in the background, and
// renderTree is a no-op until initTree binds a container.
export function initTree(containerEl) {
  _container = containerEl;
  if (!_container) return;

  // V0.2.8: Ctrl+L-drag marquee — same UX as the Colors tab. Each tree
  // row whose rect intersects the box has its node (+ descendant meshes)
  // toggled in/out of the scene selection. Needs the container, so it
  // stays in initTree (not at module level).
  _setupTreeMarquee();

  renderTree();
}

// ── Eager state listeners (V0.2.22.22) ──────────────────────────────────────
// These fire whether or not the Tree tab has been opened. renderTree() and
// the marquee guards both check `_container` and no-op when null, so it's
// safe to register before initTree runs. The key win is _syncExpanded() —
// it mutates the module-level `_expanded` set so that when the Tree tab
// IS eventually opened, the auto-expanded ancestors of the current
// selection are already correct.
state.on('change:treeData',         () => { _syncExpanded(); renderTree(); });
// Templates own the visible label of any template-linked note in the
// tree — re-render on template rename / create / delete so labels
// update without a project reload.
state.on('change:noteTemplates',    () => renderTree());
state.on('selection:change',        () => { _syncExpanded(); renderTree(); });
state.on('change:activeStepId',     () => renderTree());
// step:applied fires AFTER applyVisibilitySnapshot has mutated each
// node.localVisible. change:activeStepId above fires too early — at
// that point the per-node localVisible flags are still from the
// previous step, so the eye icons would show stale visibility for the
// duration of the animation (or forever, on instant apply).
state.on('step:applied',            () => renderTree());
// P-P1: pivot button color reflects active edit. Re-render when the
// edit session opens / closes so the button repaints in real time.
state.on('change:pivotEditNodeId',  () => renderTree());
// Re-render so the "Global Transform" menu label flips between active /
// inactive when the mode toggles externally (e.g. click-outside commit).
state.on('change:globalEditNodeId', () => renderTree());

// ── Ctrl+L-drag marquee (V0.2.8) ────────────────────────────────────────
let _treeMarqueeJustDragged = false;

function _setupTreeMarquee() {
  if (!_container) return;
  let down = null, box = null;
  _container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    // Don't start a marquee from inside an interactive control (input /
    // button / select) so existing widgets keep working.
    if (e.target.closest('input, button, select, textarea, label')) return;
    down = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!box && (dx * dx + dy * dy) < 25) return;
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;'
        + 'background:rgba(74,144,217,0.15);border:1px dashed #4A90D9;border-radius:2px';
      document.body.appendChild(box);
    }
    const x1 = Math.min(down.x, e.clientX), y1 = Math.min(down.y, e.clientY);
    const x2 = Math.max(down.x, e.clientX), y2 = Math.max(down.y, e.clientY);
    box.style.left = x1 + 'px'; box.style.top = y1 + 'px';
    box.style.width = (x2 - x1) + 'px'; box.style.height = (y2 - y1) + 'px';
  });
  document.addEventListener('pointerup', () => {
    if (!down) return;
    if (box) {
      const r = box.getBoundingClientRect();
      box.remove(); box = null;
      _treeMarqueeJustDragged = true;
      setTimeout(() => { _treeMarqueeJustDragged = false; }, 60);
      const nodeById = state.get('nodeById') || new Map();
      const multi    = new Set(state.get('multiSelectedIds') || []);
      let changed   = false;
      let firstNode = null;
      _container.querySelectorAll('.tree-row[data-node-id]').forEach(row => {
        const rect = row.getBoundingClientRect();
        if (rect.right < r.left || rect.left > r.right
         || rect.bottom < r.top  || rect.top > r.bottom) return;
        const nodeId = row.dataset.nodeId;
        const node   = nodeById.get(nodeId);
        if (!node) return;
        const setIds = new Set(); _collectAllIds(node, setIds);
        const present = multi.has(nodeId);
        for (const id of setIds) { if (present) multi.delete(id); else multi.add(id); }
        changed = true;
        if (!firstNode) firstNode = node;
      });
      if (changed) {
        if (multi.size === 0) {
          actions.clearSelection();
        } else {
          const prev = state.get('selectedId');
          const primary = (prev && multi.has(prev)) ? prev
                        : (firstNode ? firstNode.id : [...multi][0]);
          actions.setSelection(primary, multi);
        }
      }
    }
    down = null;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function renderTree() {
  if (!_container) return;
  const root = state.get('treeData');
  _container.innerHTML = '';
  if (!root) {
    _container.innerHTML = '<div class="tree-empty">No models loaded.</div>';
    return;
  }
  _container.appendChild(_buildNode(root, 0));
}

export function expandPathToNode(nodeId) {
  const root = state.get('treeData');
  if (!root) return;
  _collectAncestors(root, nodeId, _intentional);  // treat programmatic expand as intentional
  _collectAncestors(root, nodeId, _expanded);
  renderTree();
}

export function collapseAll() {
  _intentional.clear();
  _intentional.add('scene_root');
  _expanded.clear();
  _expanded.add('scene_root');
  renderTree();
}


// ── Auto-expand to show selection ─────────────────────────────────────────────

/**
 * Re-sync _expanded based on current selection + intentional set.
 * Called whenever selection or tree data changes.
 */
function _syncExpanded() {
  const root     = state.get('treeData');
  const multiIds = state.get('multiSelectedIds') || new Set();

  // Start from intentional expansions only
  _expanded.clear();
  _intentional.forEach(id => _expanded.add(id));

  if (!root || !multiIds.size) return;

  // Auto-expand ancestors of every selected node
  for (const id of multiIds) {
    _collectAncestors(root, id, _expanded);
  }
}

/**
 * Collect all ancestor IDs of targetId into the given set.
 * Returns true if targetId was found.
 */
function _collectAncestors(root, targetId, out) {
  function walk(node) {
    if (node.id === targetId) return true;
    for (const child of (node.children || [])) {
      if (walk(child)) {
        out.add(node.id);
        return true;
      }
    }
    return false;
  }
  walk(root);
}


// ── Tree construction ─────────────────────────────────────────────────────────

function _buildNode(node, depth) {
  const wrap = document.createElement('div');
  wrap.appendChild(_buildRow(node, depth));

  // V0.1.82 — locked groups DO NOT render their children. Tree stays
  // collapsed at the group level so the user sees the group as a
  // single entity (matches the viewport's selection-promotion UX).
  // Unlocked groups + plain folders behave normally (expand/collapse
  // via twisty + _expanded set).
  const isLockedGroup = node.type === 'folder' && node.locked === true;
  const hasKids = (node.children?.length ?? 0) > 0;
  const showKids = hasKids && !isLockedGroup && _expanded.has(node.id);
  if (showKids) {
    const childList = document.createElement('div');
    childList.className = 'children';
    for (const child of node.children) {
      childList.appendChild(_buildNode(child, depth + 1));
    }
    wrap.appendChild(childList);
  }

  return wrap;
}

function _buildRow(node, depth) {
  const selectedId   = state.get('selectedId');
  const multiIds     = state.get('multiSelectedIds') || new Set();
  const isPrimary    = node.id === selectedId;
  const isMulti      = multiIds.has(node.id);
  const isDropTarget = node.id === _dropTarget;
  const hasChildren  = (node.children?.length ?? 0) > 0;
  const isExpanded   = _expanded.has(node.id);

  const row = document.createElement('div');
  row.className = [
    'tree-row',
    isPrimary             ? 'selected'  : '',
    isMulti && !isPrimary ? 'multi'     : '',
    isDropTarget          ? 'dropTarget': '',
  ].filter(Boolean).join(' ');
  row.style.paddingLeft = `${6 + depth * 14}px`;
  row.dataset.nodeId = node.id;
  if (!node.localVisible) row.style.opacity = '0.45';
  if (node.missing && node.type !== 'folder') row.style.opacity = '0.5';
  // Archive trumps the other dim states — locked-hidden nodes get the
  // most aggressive grey-out so they read as "preserved but inert".
  if (node.archived) row.style.opacity = '0.25';
  row.draggable = node.type !== 'scene';

  // Twisty
  const twisty = document.createElement('span');
  twisty.className   = 'twisty';
  // V0.1.82 — locked groups show NO twisty (they're always collapsed in
  // tree; click on group selects the whole thing, children hidden).
  // Unlocked groups + plain folders use the standard expand/collapse.
  const isLockedGroup = node.type === 'folder' && node.locked === true;
  twisty.textContent = (hasChildren && !isLockedGroup)
    ? (isExpanded ? '▾' : '▸')
    : '';
  twisty.addEventListener('click', e => {
    e.stopPropagation();
    if (!hasChildren) return;
    if (isLockedGroup) return;       // locked group: twisty inert
    if (isExpanded) {
      _expanded.delete(node.id);
      _intentional.delete(node.id);
    } else {
      _expanded.add(node.id);
      _intentional.add(node.id);   // user explicitly opened — remember it
    }
    renderTree();
  });

  // Icon — archived nodes display a uniform 🗃️ marker. Everything else
  // (incl. locked folders — V0.1.92) uses its type icon; a folder's lock
  // state is conveyed by the row lock toggle + auto-collapse, not the icon.
  const icon = document.createElement('span');
  icon.className   = 'icon';
  if (node.archived) {
    icon.textContent = '🗃️';
    icon.title       = 'Archived (r-click → Unarchive)';
  } else {
    icon.textContent = _typeIcon(node.type);
  }

  // Label — notes show their (truncated) text, or the template's NAME
  // when template-linked (so the tree mirrors the user-facing label
  // chosen in the Notes tab instead of the empty instance text).
  const label = document.createElement('span');
  label.className   = 'label';
  if (node.type === 'note') {
    let labelTxt = '';
    if (node.templateId) {
      const tpl = (state.get('noteTemplates') || []).find(t => t.id === node.templateId);
      labelTxt = tpl?.name || '(linked template)';
    } else {
      const t = (node.text || '').replace(/\s+/g, ' ').trim();
      labelTxt = t ? (t.length > 40 ? t.slice(0, 40) + '…' : t) : '(empty note)';
    }
    label.textContent = labelTxt;
    label.style.fontStyle = 'italic';
  } else {
    label.textContent = node.name || '(unnamed)';
  }

  // Transform buttons (model / folder only). Archived nodes hide them
  // entirely — they're inert and the buttons would mislead the user
  // into thinking the row still responds to gizmo edits.
  const transformGroup = document.createElement('span');
  transformGroup.style.display = (isTransformNode(node) && !node.archived) ? 'inline-flex' : 'none';
  transformGroup.style.gap = '1px';
  if (isTransformNode(node) && !node.archived) {
    transformGroup.append(
      _mkTransformBtn('✥', 'Move',   'moveEnabled',   node),
      // Pivot only on folders — the root model node carries the
      // imported asset's reference frame and shouldn't have its pivot
      // relocated (the user can't visually verify what that means).
      ...(node.type === 'folder' ? [_mkPivotBtn(node)] : []),
      _mkTransformBtn('⟳', 'Rotate', 'rotateEnabled', node),
    );
  }

  // Folder lock toggle (V0.1.92) — on EVERY folder, default unlocked.
  // 🔒︎ (lock + VS15 text variation) = locked; ꗃ (Vai syllable, looks
  // like an open container) = unlocked. Both are TEXT-style glyphs so
  // `color: var(--text)` adapts to dark/light theme. Locking a folder
  // makes a viewport click on any child select the whole folder, and
  // collapses it in the tree (treat the sub-assembly as one unit).
  let groupLockBtn = null;
  if (node.type === 'folder' && !node.archived) {
    const locked = node.locked === true;
    groupLockBtn = document.createElement('button');
    groupLockBtn.type      = 'button';
    groupLockBtn.className = 'group-lock';
    groupLockBtn.textContent = locked ? '🔒︎' : 'ꗃ';
    groupLockBtn.title     = locked
      ? 'Locked folder — click to unlock (children individually selectable)'
      : 'Unlocked folder — click to lock (clicking a child selects the whole folder)';
    groupLockBtn.style.cssText = [
      'background:transparent',
      'border:none',
      'padding:0 4px',
      'cursor:pointer',
      'font-size:14px',
      'color:var(--text)',
      locked ? 'opacity:0.95' : 'opacity:0.45',
    ].join(';');
    groupLockBtn.addEventListener('click', e => {
      e.stopPropagation();
      actions.setFolderLocked(node.id, !locked);
    });
  }

  // Eye — hidden entirely on archived rows. Archive forces invisible
  // regardless of the eye state, so showing it would be misleading.
  // The 🗃️ icon at the start of the row carries all the meaning.
  const eye = document.createElement('button');
  eye.className   = 'eye';
  eye.textContent = node.localVisible ? '👁' : '🚫';
  eye.title       = node.localVisible ? 'Visible' : 'Hidden';
  eye.addEventListener('click', e => { e.stopPropagation(); _toggleVisibility(node); });
  if (node.archived) eye.style.visibility = 'hidden';

  if (groupLockBtn) row.append(twisty, icon, label, transformGroup, groupLockBtn, eye);
  else              row.append(twisty, icon, label, transformGroup, eye);

  row.addEventListener('click',       e => _onRowClick(e, node));
  row.addEventListener('dblclick',    e => _onRowDblClick(e, node));
  row.addEventListener('contextmenu', e => _onRowContextMenu(e, node));
  row.addEventListener('dragstart',   e => _onDragStart(e, node));
  row.addEventListener('dragend',     ()  => _onDragEnd());
  row.addEventListener('dragover',    e => _onDragOver(e, node));
  row.addEventListener('dragleave',   e => _onDragLeave(e, node));
  row.addEventListener('drop',        e => _onDrop(e, node));

  return row;
}

function _typeIcon(type) {
  switch (type) {
    case 'scene':        return '🌐';
    case 'model':        return '🧩';
    case 'folder':       return '🗂';
    case 'mesh':         return '◼';
    case 'note':         return '💬';
    case 'flatShape':    return '▰';   // M1: 2D shape in 3D
    case 'replaceModel': return '🔄';  // B.2-NEW: container that replaces an object
    case 'hardwareInstance': return '🔩';  // V0.2.22.38: procedural fastener
    default:             return '📄';
  }
}

/**
 * 3-state transform toggle button:
 *   GREY  — no delta stored (inert, click does nothing)
 *   BLUE  — delta stored + applied
 *   RED   — delta stored + muted (data kept, not applied)
 *
 * Clicking BLUE → RED, clicking RED → BLUE. Grey is inert.
 */
function _mkTransformBtn(icon, title, flagKey, node) {
  // Determine whether a meaningful delta exists for this axis
  let hasData;
  if (flagKey === 'moveEnabled') {
    hasData = !isNearZero(node.localOffset);
  } else if (flagKey === 'rotateEnabled') {
    hasData = !isIdentityQuaternion(node.localQuaternion);
  } else { // pivotEnabled
    hasData = !isNearZero(node.pivotLocalOffset) || !isIdentityQuaternion(node.pivotLocalQuaternion);
  }
  const enabled = node[flagKey] !== false;

  // grey = no data | blue = data+on | red = data+off
  const btnState = !hasData ? 'grey' : enabled ? 'blue' : 'red';
  const COLOR = { grey: '#6b7280', blue: '#3b82f6', red: '#ef4444' };
  const TIPS  = { grey: `${title}: no data`, blue: `${title}: active (click to mute)`, red: `${title}: muted (click to restore)` };

  const btn = document.createElement('button');
  btn.className         = 'moveBtn';
  btn.textContent       = icon;
  btn.title             = TIPS[btnState];
  btn.style.color       = COLOR[btnState];
  btn.style.opacity     = hasData ? '1' : '0.45';
  btn.style.cursor      = hasData ? 'pointer' : 'default';

  btn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    if (!hasData) return;  // grey — inert
    actions.toggleTransformEnabled(node.id, flagKey);
    renderTree();
  });
  return btn;
}

/**
 * P-P1: pivot button — 3-way cycle (grey → red → blue → grey).
 *
 *   GREY — pivotEnabled=false. Click → enterPivotEdit (RED).
 *   RED  — this node currently in edit mode. Click → commitPivotEdit
 *          (lands BLUE — same as clicking in the viewport).
 *   BLUE — pivotEnabled=true, not editing. Click → setPivotEnabled(false)
 *          (lands GREY; pivot offset/quat data preserved for re-activation).
 *
 * The button cycles the same way regardless of whether pivot data
 * existed before. To CANCEL an in-progress edit, press Ctrl+Z after
 * clicking through to BLUE — the whole session is one undo entry.
 */
function _mkPivotBtn(node) {
  const isEditing = state.get('pivotEditNodeId') === node.id;
  const enabled   = node.pivotEnabled === true;
  const btnState  = isEditing ? 'red' : enabled ? 'blue' : 'grey';

  const COLOR = { grey: '#6b7280', red: '#ef4444', blue: '#3b82f6' };
  const TIPS  = {
    grey: 'Pivot: at home (click to relocate)',
    red:  'Pivot: editing — click to commit (or click in viewport)',
    blue: 'Pivot: relocated (click to send home — data preserved)',
  };

  const btn = document.createElement('button');
  btn.className   = 'moveBtn';
  btn.textContent = '◎';
  btn.title       = TIPS[btnState];
  btn.style.color = COLOR[btnState];
  btn.style.opacity = '1';
  btn.style.cursor  = 'pointer';

  btn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    if (btnState === 'grey') {
      // GREY → RED: enable pivot + start edit session.
      actions.enterPivotEdit(node.id);
    } else if (btnState === 'red') {
      // RED → BLUE: commit edit (same as clicking in viewport).
      actions.commitPivotEdit();
    } else {
      // BLUE → GREY: disable pivot, data preserved.
      actions.setPivotEnabled(node.id, false);
    }
    renderTree();
  });
  return btn;
}


// ── Selection ─────────────────────────────────────────────────────────────────

// Anchor for Shift-range selection (file-explorer style).
let _treeAnchorId = null;

/**
 * Visible row order — DFS mirroring _buildNode (descend into a node's
 * children only when it's expanded and not a locked folder). Used for
 * Shift-range selection.
 */
function _visibleNodeIds() {
  const root = state.get('treeData');
  const out  = [];
  if (!root) return out;
  (function walk(node) {
    out.push(node.id);
    const isLockedFolder = node.type === 'folder' && node.locked === true;
    const hasKids = (node.children?.length ?? 0) > 0;
    if (hasKids && !isLockedFolder && _expanded.has(node.id)) {
      for (const c of node.children) walk(c);
    }
  })(root);
  return out;
}

function _onRowClick(e, node) {
  // Suppress the click that fires right after a Ctrl+drag marquee — the
  // drag set the selection; the trailing click would clobber it.
  if (_treeMarqueeJustDragged) return;
  e.stopPropagation();
  hideContextMenu();
  const nodeById = state.get('nodeById') || new Map();
  const multiIds = new Set(state.get('multiSelectedIds') || []);
  // Each row's "set" includes the node + its descendant meshes so containers
  // highlight their geometry; the primary selectedId stays the clicked node
  // so the gizmo attaches to it. Mirrors viewport-click + double-click.
  const descIds = (n) => { const s = new Set(); _collectAllIds(n, s); return s; };
  const setIds  = descIds(node);
  const hasMod  = e.shiftKey || e.altKey || e.ctrlKey || e.metaKey;

  // ── V0.2.22.20 / .21.2 — folder plain-click selection rules ──────────
  // Non-locked folder: PROGRESSIVE click
  //    1st click  → folder only
  //    2nd click  → folder + DIRECT non-folder children
  //    3rd+ click → folder + entire subtree
  // Locked folder: always JUST the folder id (the unit). Silhouette
  //    outline-pass (V0.2.22.21) automatically wraps the descendant
  //    mesh mass — including descendants in multi was the V0.2.18
  //    mechanism for per-mesh outlineOnly hulls, no longer needed.
  // Modifier keys and clicks on a different row reset the counter.
  if (!hasMod && node.type === 'folder') {
    let ids;
    if (node.locked === true) {
      // Locked folder is a unit — single-id selection, no progression.
      ids = new Set([node.id]);
      _folderClickCount = 0;
      _lastFolderClickId = node.id;
    } else {
      const now = Date.now();
      if (_lastFolderClickId !== node.id
          || (now - _lastFolderClickAt) > _FOLDER_CLICK_WINDOW_MS) {
        _folderClickCount = 0;
      }
      _folderClickCount++;
      _lastFolderClickId = node.id;
      _lastFolderClickAt = now;

      if (_folderClickCount === 1) {
        ids = new Set([node.id]);
      } else if (_folderClickCount === 2) {
        ids = new Set([node.id]);
        for (const c of (node.children || [])) {
          if (c.type !== 'folder') _collectAllIds(c, ids);
        }
      } else {
        ids = descIds(node);   // 3+ → full subtree
      }
    }
    _treeAnchorId = node.id;
    actions.setSelection(node.id, ids);
    return;
  }
  // Any other path (modifier or non-folder) resets the progressive counter
  // so the next plain folder click starts at step 1.
  _lastFolderClickId = null;
  _folderClickCount  = 0;

  // ── Shift: range-select over the visible rows from the anchor (replace) ──
  if (e.shiftKey && _treeAnchorId && nodeById.has(_treeAnchorId)) {
    const order = _visibleNodeIds();
    const a = order.indexOf(_treeAnchorId), b = order.indexOf(node.id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = new Set();
      for (let i = lo; i <= hi; i++) {
        const n = nodeById.get(order[i]);
        if (n) for (const id of descIds(n)) range.add(id);
      }
      actions.setSelection(node.id, range);
      return;   // anchor stays put for further range extension
    }
  }

  // ── Alt: remove the node (+ descendants) from the selection ──────────────
  if (e.altKey) {
    for (const id of setIds) multiIds.delete(id);
    _treeAnchorId = node.id;
    if (multiIds.size === 0) {
      actions.clearSelection();
    } else {
      const prev = state.get('selectedId');
      actions.setSelection(multiIds.has(prev) ? prev : [...multiIds][0], multiIds);
    }
    return;
  }

  // ── Ctrl/⌘: toggle the node (+ descendants) ──────────────────────────────
  if (e.ctrlKey || e.metaKey) {
    if (multiIds.has(node.id)) { for (const id of setIds) multiIds.delete(id); }
    else                       { for (const id of setIds) multiIds.add(id); }
    _treeAnchorId = node.id;
    actions.setSelection(node.id, multiIds);
  } else {
    // Plain click → replace.
    _treeAnchorId = node.id;
    actions.setSelection(node.id, setIds);
  }
  // NOTE: Do NOT call steps.scheduleSync() here.
  // Selection is not a mutation — syncing re-captures parentMap from the
  // current tree (which may already be rearranged by applyParentMap), causing
  // the step's stored parentMap to drift every time the user clicks.
}

function _onRowDblClick(e, node) {
  e.preventDefault();
  e.stopPropagation();
  if (node.type === 'mesh' || node.type === 'scene') return;
  // V0.2.22.20 — folder rows now use progressive click semantics in
  // _onRowClick. The browser's dblclick fires AFTER the two click
  // events, so consuming it here would override step-2 selection with
  // a full-subtree expand. Leave folders to the click counter.
  // Non-folder containers (model, flatShape) keep the legacy
  // expand-on-double-click affordance.
  if (node.type === 'folder') return;
  const ids = new Set();
  _collectAllIds(node, ids);
  state.setSelection(node.id, ids);
}

function _collectAllIds(node, out) {
  out.add(node.id);
  (node.children || []).forEach(c => _collectAllIds(c, out));
}


// ── Visibility ────────────────────────────────────────────────────────────────

function _toggleVisibility(node) {
  const multiIds = state.get('multiSelectedIds') || new Set();
  const ids = multiIds.has(node.id) && multiIds.size > 1
    ? Array.from(multiIds)
    : [node.id];
  actions.toggleVisibility(ids);
}


// ── Context menu ──────────────────────────────────────────────────────────────

function _onRowContextMenu(e, node) {
  e.preventDefault();
  e.stopPropagation();

  // If right-clicked node is NOT in the current multi-selection, select just it.
  // If it IS already in multi-selection, keep the multi-selection intact so
  // menu actions apply to all selected nodes.
  const multiIds = state.get('multiSelectedIds') || new Set();
  if (!multiIds.has(node.id)) {
    state.setSelection(node.id, new Set([node.id]));
  }

  renderTree();
  showContextMenu(_buildContextMenuItems(node), e.clientX, e.clientY);
}

function _buildContextMenuItems(node) {
  const root     = state.get('treeData');
  const nodeById = state.get('nodeById');
  const multiIds = state.get('multiSelectedIds') || new Set();
  // Nodes the action applies to (all selected if node is in selection, else just node)
  const targetIds = multiIds.has(node.id) && multiIds.size > 1
    ? Array.from(multiIds)
    : [node.id];

  // ── Note rows: a TIGHT, dedicated menu (no visibility/isolate clutter).
  // Show/Hide • Edit Text… • ↺ Reposition • Delete (with confirm) •
  // Size: Small / Medium / Large.
  if (node.type === 'note') {
    return _buildNoteContextMenuItems(node);
  }

  // ── Archived rows: a TIGHT menu — only Unarchive is available, since
  // archive enforces READ-ONLY at every other action. Showing the full
  // menu would advertise commands that silently no-op, which is more
  // confusing than just hiding them. If the user multi-selected a mix
  // (archived + un-archived), we still hide all but Unarchive so the
  // gesture stays predictable.
  const allArchived = targetIds.every(id => nodeById?.get(id)?.archived === true);
  if (allArchived) {
    const label = targetIds.length > 1
      ? `${targetIds.length} items`
      : `"${(node.name || '').slice(0, 24)}"`;
    return [{
      label: `📤 Unarchive ${label}`,
      action: () => actions.unarchiveNodes(targetIds),
    }];
  }

  // ── RM children (copies inside a Replace-Model): a TIGHT menu —
  // only Remove + Global Transform per the B.2-NEW.2 spec. Everything
  // else (visibility, color, archive, rename, move…) would either
  // conflict with the RM cascade or silently no-op on a node whose
  // entire pose is delegated to its parent wrap-group. RM children are
  // detected by walking up the tree to a replaceModel ancestor.
  const isRMChild = actions.findReplaceModelAncestor(root, node.id) != null;
  if (isRMChild && targetIds.length === 1) {
    return [
      {
        label: '🚫🔄 Remove from replace-model',
        action: () => _confirmRemoveFromReplaceModel(node),
      },
      {
        label: '🌐 Global transform…',
        action: () => showRMChildGlobalTransformDialog(node.id),
      },
    ];
  }

  const items    = [];
  const count    = targetIds.length;
  const label    = count > 1 ? `${count} items` : `"${(node.name || '').slice(0, 24)}"`;

  if (node.missing) {
    items.push({ label: '⚠️ Missing asset — placeholder active', disabled: true });
  }

  // ── Visibility ──────────────────────────────────────────────────────────────
  const allVisible = targetIds.every(id => nodeById?.get(id)?.localVisible !== false);
  items.push({
    label: '👁 Visibility',
    disabled: actions.hasIsolateSnapshot(),   // while isolated, the mask owns hide/show
    submenu: [
      { label: allVisible ? `🚫 Hide ${label} — this step` : `👁 Show ${label} — this step`,
        action: () => actions.toggleVisibility(targetIds) },
      { separator: true },
      { label: '◀ 👁 Show on all previous steps',  action: () => actions.setNodeVisibilityAcrossSteps(targetIds, true,  'previous') },
      { label: '◀ 🚫 Hide on all previous steps',  action: () => actions.setNodeVisibilityAcrossSteps(targetIds, false, 'previous') },
      { separator: true },
      { label: '▶ 👁 Show on all following steps', action: () => actions.setNodeVisibilityAcrossSteps(targetIds, true,  'following') },
      { label: '▶ 🚫 Hide on all following steps', action: () => actions.setNodeVisibilityAcrossSteps(targetIds, false, 'following') },
    ],
  });

  // ── Clean tree — collapse redundant import wrapper folders ────────────
  // STEP/CAD imports create deep chains of empty + single-child folders that
  // group nothing. One-click cleanup, scoped to THIS branch (right-click the
  // model/scene root to clean the whole tree). Only folders that are identity
  // in every step are touched; geometry-bearing, locked and moved folders are
  // left alone. One undo.
  if (count === 1 && (node.type === 'folder' || node.type === 'model' || node.type === 'scene')) {
    items.push({
      label: '🧹 Clean redundant folders',
      action: () => actions.cleanTree(node.id),
    });
  }

  // ── Folder lock (V0.1.92, replaces the old Group menu) ────────────────
  // A locked folder promotes viewport selection to the whole folder and
  // collapses in the tree. To group loose objects: New folder / Move to
  // folder, then lock.
  if (count === 1 && node.type === 'folder' && !node.archived) {
    const locked = node.locked === true;
    items.push({
      label: locked ? '🔓 Unlock folder (children selectable)'
                    : '🔒 Lock folder (select as one unit)',
      action: () => actions.setFolderLocked(node.id, !locked),
    });

    // ── Copy / Paste Transforms (V0.2.20) ────────────────────────────────
    // Folder-only. Captures the per-step deltas of this folder + every
    // transform-bearing descendant; paste restores them onto a (same or
    // different) folder of matching shape. Visibility / Show-Hide / colors
    // are NOT captured.
    items.push({
      label: '📋 Copy Transforms',
      action: () => _copyFolderTransforms(node),
    });
    const clip = _folderXfClipboard;
    items.push({
      label: clip
        ? `📌 Paste Transforms (from "${(clip.rootName || '').slice(0, 24)}")`
        : '📌 Paste Transforms',
      disabled: !clip,
      action: () => _pasteFolderTransforms(node),
    });

    // V0.2.22.32 — 1-point folder align. Pick a source surface on a
    // descendant mesh, then a target surface anywhere else; the folder's
    // per-step localOffset/Quaternion are computed so the source point
    // mates flush against the target. Live preview after the second pick;
    // Enter commits, Esc reverts. Per-step only — baseLocal* untouched.
    items.push({
      label: '🎯 Align folder to surface…',
      action: () => folderAlignPicker.start(node.id),
    });
    // V0.2.22.33 — 3-point concentric folder align. Snap 3 points on a
    // circular feature inside the folder (defines source circle center +
    // axis), then 3 points on a circular feature elsewhere (target).
    // Folder snaps so the two circles share a center + axis. Backspace
    // removes the last point in the current phase.
    items.push({
      label: '🎯 Align folder by 3 points (concentric)…',
      action: () => folderAlign3ptPicker.start(node.id),
    });
  }

  // ── Archive / Unarchive ─────────────────────────────────────────────────
  // Archive = "locked-hidden, preserved": the node stays in the tree with
  // its full per-step history, but is forced invisible regardless of any
  // snapshot. Toggle is r-click only (deliberately not on the eye button)
  // because it's a semi-permanent decision, not a per-step animation.
  // Disallowed on the scene root and on note rows (handled above).
  if (node.type !== 'scene') {
    const anyNotArchived = targetIds.some(id => nodeById?.get(id)?.archived !== true);
    const anyArchived    = targetIds.some(id => nodeById?.get(id)?.archived === true);
    if (anyNotArchived) {
      items.push({
        label: `🗃️ Archive ${label}`,
        action: () => actions.archiveNodes(targetIds),
      });
    }
    if (anyArchived) {
      items.push({
        label: `📤 Unarchive ${label}`,
        action: () => actions.unarchiveNodes(targetIds),
      });
    }
  }

  // ── Per-note Show / Hide list ────────────────────────────────────────────
  // Lists notes that are DIRECT children of THIS specific node — only the
  // ones positioned on him, not anything deeper in the subtree. Practical
  // outcome: right-click a mesh that has notes → see those notes; right-
  // click a model / folder / mesh that doesn't have any notes attached
  // directly → no notes section appears at all.
  const directNotes = (node.children || []).filter(c => c?.type === 'note');
  if (directNotes.length) {
    items.push({ separator: true });
    items.push({
      label: `🗒 Notes on this ${node.type} (${directNotes.length})`,
      disabled: true,
    });
    const tplList = state.get('noteTemplates') || [];
    for (const n of directNotes) {
      const visEff = (nodeById?.get(n.id)?.localVisible !== false);
      let short;
      if (n.templateId) {
        const tpl = tplList.find(t => t.id === n.templateId);
        short = tpl?.name || '(linked template)';
      } else {
        const txt = (n.text || '').replace(/\s+/g, ' ').trim();
        short = txt ? (txt.length > 30 ? txt.slice(0, 30) + '…' : txt) : '(empty note)';
      }
      items.push({
        label:  `   ${visEff ? '👁' : '🚫'}  ${short}`,
        action: () => actions.toggleVisibility([n.id]),
      });
    }
    items.push({ separator: true });
  }

  // ── Add Note (mesh-only, anchored to a face) ────────────────────────────────
  // Promoted to the top of the menu so it's where the user looks first.
  // Click flow: this item arms face-pick mode (state.notePickingMeshId);
  // the next viewport click on the same mesh creates the balloon.
  if (node.type === 'mesh' && !node.missing) {
    items.push({
      label: '💬 Add Note…',
      action: () => actions.startNotePicking(node.id),
    });
  }

  // ── Hardware nut (V0.2.22.78) — bolt-driven child. Transform/gizmo come
  // from the generic transform-node menu; here we add copy-pose + delete.
  if (count === 1 && node.type === 'hardwareNut') {
    items.push({
      label: '📋 Copy step pose',
      action: () => actions.copyInstanceStepPose(node.id),
    });
    items.push({
      label: '📥 Paste step pose',
      disabled: !actions.hasInstancePoseClipboard(),
      action: () => actions.pasteInstanceStepPose(node.id),
    });
    items.push({ separator: true });
    items.push({
      label: '🗑 Delete nut',
      action: () => {
        import('../systems/hardware-actions.js').then(hw => hw.deleteNut(node.id));
      },
    });
    items.push({ separator: true });
  }

  // ── Hardware instance — duplicate, edit template, delete (V0.2.22.38+44)
  if (count === 1 && node.type === 'hardwareInstance') {
    items.push({
      label: '🔩 Duplicate (same template)',
      action: () => {
        import('../systems/hardware-actions.js').then(hw =>
          hw.duplicateInstance(node.id));
      },
    });
    items.push({
      label: '🔩 Edit template (affects all instances)…',
      action: () => editHardwareTemplate(node.templateId),
    });
    // V0.2.22.78 — add a bolt-driven nut (lives from step 0, child of the
    // bolt; position/rotate/hide it manually).
    items.push({
      label: '🔩 Add nut',
      action: () => {
        import('../systems/hardware-actions.js').then(hw => hw.createNutForBolt(node.id));
      },
    });
    // Copy / paste the active step's pose (translation + rotation +
    // visibility) — cross-instance allowed. Same as flatShape/mesh.
    items.push({
      label: '📋 Copy step pose',
      action: () => actions.copyInstanceStepPose(node.id),
    });
    const _hwSelStep = state.get('selectedStepIds')?.size ?? 0;
    items.push({
      label: _hwSelStep >= 2 ? `📥 Paste step pose to ${_hwSelStep} steps` : '📥 Paste step pose',
      disabled: !actions.hasInstancePoseClipboard(),
      action: () => actions.pasteInstanceStepPose(node.id),
    });
    // Insertion animation toggle — binds to the active step.
    const isActor = node.insertAnim?.enabled === true;
    items.push({
      label: isActor
        ? '🎬 Stop insertion animation'
        : '🎬 Animate insertion on this step',
      action: () => {
        import('../systems/hardware-actions.js').then(hw =>
          hw.setInsertActor([node.id], !isActor));
      },
    });
    if (isActor) {
      items.push({
        label: `📏 Adjust insertion animation…`,
        action: () => {
          showInsertAnimDialog(node.insertAnim || {}, (patch) => {
            import('../systems/hardware-actions.js').then(hw =>
              hw.setInsertAnimParams([node.id], patch));
          });
        },
      });
    }
    items.push({ separator: true });
  }
  // True when every selected row is a hardware instance — gates the washer
  // and delete blocks below. Declared here (above first use) to avoid a
  // temporal-dead-zone error. V0.2.22.60.
  const allHardware = count >= 1 &&
    targetIds.every(id => nodeById?.get(id)?.type === 'hardwareInstance');
  // Washer options — multi-aware, applies to all selected hardware
  // instances. V0.2.22.47.
  if (allHardware) {
    // Helper to set washers on the whole selection at once.
    const _setW = (config) => {
      import('../systems/hardware-actions.js').then(hw =>
        hw.setInstanceWashers(targetIds, config));
    };
    const sample = nodeById?.get(targetIds[0]);
    const curr   = sample?.washers || { count: 0, spring: false };
    const _checkmark = (cfg) =>
      (curr.count === cfg.count && !!curr.spring === !!cfg.spring) ? ' ✓' : '';
    items.push({
      label: `⊕ No washers${_checkmark({ count: 0, spring: false })}`,
      action: () => _setW({ count: 0, spring: false }),
    });
    items.push({
      label: `⊕ One washer${_checkmark({ count: 1, spring: false })}`,
      action: () => _setW({ count: 1, spring: false }),
    });
    items.push({
      label: `⊕ Two washers${_checkmark({ count: 2, spring: false })}`,
      action: () => _setW({ count: 2, spring: false }),
    });
    items.push({
      label: `⊕ Spring washer only${_checkmark({ count: 1, spring: true })}`,
      action: () => _setW({ count: 1, spring: true }),
    });
    items.push({
      label: `⊕ Spring + flat washer${_checkmark({ count: 2, spring: true })}`,
      action: () => _setW({ count: 2, spring: true }),
    });
    items.push({ separator: true });
  }
  // Delete — single OR multi-select hardware. Absolute removal (no
  // archive). Multi-aware: works on the whole selection when several
  // screws are selected.
  if (allHardware) {
    items.push({
      label: count > 1
        ? `🗑 Delete ${count} screws`
        : '🗑 Delete screw',
      action: () => {
        import('../systems/hardware-actions.js').then(hw =>
          hw.deleteInstances(targetIds));
      },
    });
    items.push({ separator: true });
  }

  // ── Isolate ─────────────────────────────────────────────────────────────────
  items.push({
    label: '🔍 Isolate',
    action: () => _isolateNodes(new Set(targetIds)),
  });

  // ── Fit To ──────────────────────────────────────────────────────────────────
  items.push({
    label: '🎯 Fit To',
    action: () => _fitToNodes(new Set(targetIds)),
  });

  // ── Show color (single mesh / flatShape only) ──────────────────────────
  // Switches to the Colors tab and expands the preset currently assigned
  // to this node at the active step. Hidden on multi-selection because
  // "which color?" is ambiguous when multiple meshes are selected.
  if (count === 1 && (node.type === 'mesh' || node.type === 'flatShape' || node.type === 'hardwareInstance')) {
    items.push({
      label: '🎨 Show color',
      action: () => showColorForNode(node.id),
    });
  }

  items.push({ separator: true });

  // ── Navigate ────────────────────────────────────────────────────────────────
  const parent = root ? findParent(root, node.id) : null;
  items.push({
    label: '⬆ Select Parent',
    disabled: !parent || parent.type === 'scene',
    action: () => parent && state.setSelection(parent.id, new Set([parent.id])),
  });

  items.push({
    label: '⬇ Select Children',
    disabled: !(node.children?.length),
    action: () => {
      const ids = new Set();
      (node.children || []).forEach(c => _collectAllIds(c, ids));
      if (ids.size) state.setSelection([...ids][0], ids);
    },
  });

  items.push({ separator: true });

  // ── Folder operations ────────────────────────────────────────────────────────
  const isContainer = node.type === 'folder' || node.type === 'model' || node.type === 'scene';

  if (isContainer) {
    items.push({
      label: '📁＋ New Folder Inside',
      action: () => _createFolderInside(node),
    });
  }

  if (node.type === 'folder' || node.type === 'model' || node.type === 'scene') {
    const otherSelected = targetIds.filter(id => id !== node.id);
    if (otherSelected.length > 0 || (multiIds.size > 0 && !multiIds.has(node.id))) {
      items.push({
        label: `⤵ Move Selected Here`,
        action: () => _moveIdsIntoNode(Array.from(multiIds).filter(id => id !== node.id), node),
      });
    }
  }

  if (isContainer && (node.children?.length ?? 0) > 0) {
    items.push({
      label: '⊟ Collapse',
      action: () => _collapseSubtree(node),
    });
  }

  // ── Flat-shape per-row actions (Phase 2 / 2.1 / 2.3) ─────────────────────
  if (node.type === 'flatShape') {
    items.push({ separator: true });

    // Edit polygon — opens the viewport editor seeded at this instance's
    // current world pose. Commit replaces the template's polygon and
    // ripples to every other instance.
    items.push({
      label: '✏ Edit shape…',
      // Edit THIS instance directly — no second "click an instance" step.
      action: () => actions.editShapeInstance(node.id),
    });

    // Global Transform mode — drag handles write base* fields, change
    // ripples to every step. Red cube indicator at the gizmo hub.
    const inMode = state.get('globalEditNodeId') === node.id;
    items.push({
      label: inMode ? '✓ Global Transform (active)' : '🌐 Global Transform',
      action: () => inMode
        ? actions.commitGlobalEdit()
        : actions.enterGlobalEdit(node.id),
    });

    // ── Step-pose clipboard (Phase 2 #3) ─────────────────────────────────
    // Copy captures the ACTIVE step's per-step transform + visibility for
    // this instance; Paste applies it to either every step in
    // state.selectedStepIds (when ≥ 2) or just the active step. Cross-
    // instance paste IS allowed — pose is id-agnostic.
    items.push({
      label: '📋 Copy step pose',
      action: () => actions.copyInstanceStepPose(node.id),
    });
    // V0.2.22.18 — cache selectedStepIds once. The original two reads of
    // state.get('selectedStepIds') would crash on .size in the template
    // literal if state mutated to null between the guarded check and the
    // second read.
    const _selStepCount = state.get('selectedStepIds')?.size ?? 0;
    items.push({
      label: _selStepCount >= 2
        ? `📥 Paste step pose to ${_selStepCount} steps`
        : '📥 Paste step pose',
      disabled: !actions.hasInstancePoseClipboard(),
      action: () => actions.pasteInstanceStepPose(node.id),
    });

    // Delete this instance (template stays in the library).
    items.push({ separator: true });
    items.push({
      label: '🗑 Delete shape',
      action: () => actions.deleteFlatShapeInstance(node.id),
    });
  }

  // ── Parametric primitive — copy / paste / paste-instance / delete (V0.2.22.94) ──
  if (node.type === 'primitive') {
    items.push({ separator: true });
    items.push({ label: '📋 Copy', action: () => actions.copyPrimitive(node.id) });
    items.push({
      label:    '📄 Paste (independent)',
      disabled: !actions.hasPrimitiveClipboard(),
      action:   () => actions.pastePrimitive(),
    });
    items.push({
      label:    '🔗 Paste Instance (linked parameters)',
      disabled: !actions.hasPrimitiveClipboard(),
      action:   () => actions.pastePrimitiveInstance(),
    });
    items.push({ separator: true });
    items.push({ label: '🗑 Delete', action: () => actions.deletePrimitive(node.id) });
  }

  // ── Transform ────────────────────────────────────────────────────────────────
  if (isTransformNode(node)) {
    items.push({ separator: true });
    items.push({
      label: '↺ Reset Move',
      action: () => targetIds.filter(id => isTransformNode(nodeById?.get(id))).forEach(id => actions.resetTransformField(id, 'move')),
    });
    items.push({
      label: '↺ Reset Rotation',
      action: () => targetIds.filter(id => isTransformNode(nodeById?.get(id))).forEach(id => actions.resetTransformField(id, 'rotate')),
    });
    items.push({
      label: '↺ Reset All Transforms',
      action: () => targetIds.filter(id => isTransformNode(nodeById?.get(id))).forEach(id => actions.resetTransformField(id, 'all')),
    });
  }

  // ── Pivot ────────────────────────────────────────────────────────────────
  // Folder-only (model-root has no pivot per the P-P1 fix). Copy / Paste
  // transfer the BLUE pivot value, useful for replicating pivot setups
  // across steps or between similar folders. Snap-to-surface puts the
  // app into a one-shot click-pick mode handled in main.js.
  if (node.type === 'folder') {
    const hasBluePivot = node.pivotEnabled === true && (
      !isNearZero(node.pivotLocalOffset) || !isIdentityQuaternion(node.pivotLocalQuaternion)
    );
    items.push({ separator: true });
    items.push({
      label: '⊕ Copy Pivot',
      disabled: !hasBluePivot,
      action: () => actions.copyPivot(node.id),
    });
    items.push({
      label: '⊕ Paste Pivot',
      disabled: !actions.hasPivotClipboard(),
      action: () => actions.pastePivot(node.id),
    });
    items.push({
      label: '🧲 Snap Pivot to Surface…',
      action: () => actions.startPivotSnapPicking(node.id),
    });
    items.push({
      label: '⊕ Pivot Center via 3 Points…',
      action: () => actions.startPivotCenterPicking(node.id),
    });
  }

  items.push({ separator: true });

  // ── General ──────────────────────────────────────────────────────────────────
  // Rename: nodes whose identity is GLOBAL across steps (mesh / flatShape /
  // replaceModel) cascade their new name into every step's snapshot.tree
  // via actions.renameNodeGlobal. Folders / models keep the legacy per-step
  // rename — their name lives only on the live tree (folders are step-local
  // containers; renaming them across steps is a separate, larger change).
  if (node.type !== 'scene' && node.type !== 'note') {
    const useGlobalRename = node.type === 'mesh' ||
                            node.type === 'flatShape' ||
                            node.type === 'replaceModel';
    items.push({
      label: `✏ Rename "${(node.name || '').slice(0, 24)}"`,
      action: () => _showInputDialog('Rename', node.name || '', name => {
        if (useGlobalRename) {
          actions.renameNodeGlobal(node.id, name);
        } else {
          node.name = name;
          if (node.object3d) node.object3d.name = name;
          state.emit('change:treeData', state.get('treeData'));
          steps.scheduleTransformSync();
        }
      }),
    });
  }

  if (node.type !== 'scene') {
    items.push({
      label: count > 1 ? `📁→ Move ${count} items to Folder…` : '📁→ Move to Folder…',
      action: () => showMoveToFolderDialog(targetIds),
    });
  }

  // ── Make transformable (V0.2.22.79) ───────────────────────────────────
  // Wrap a single node in a locked pivot-folder named after it → instant
  // gizmo, centred on the node, oriented to its parent folder.
  if (count === 1 && !node.archived
      && node.type !== 'scene' && node.type !== 'note' && node.type !== 'hardwareNut') {
    items.push({
      label: '🪄 Make transformable',
      action: () => actions.makeTransformable(node.id),
    });
  }

  // ── Convert to Replace-Model (B.2-NEW.1) ─────────────────────────────
  // Single non-archived mesh / flatShape / model only. Folders are NOT
  // allowed. The action just flips node.type → 'replaceModel' (same id,
  // same transforms, same per-step state).
  if (count === 1
      && (node.type === 'mesh' || node.type === 'flatShape' || node.type === 'model')
      && !node.archived) {
    items.push({
      label: '🔄 Convert to Replace-Model',
      action: () => actions.convertToReplaceModel(node.id),
    });
  }

  // ── RM-only actions (B.2-NEW.2) ───────────────────────────────────────
  // When the user r-clicks the RM itself, expose the RM management menu.
  // "+ Add to replace…" opens the picker → 3-option mode dialog. Other
  // RM-only entries (unarchive original, un-replace) land in .4.
  if (count === 1 && node.type === 'replaceModel' && !node.archived) {
    items.push({
      label: '＋ Add to replace…',
      action: () => showAddToReplaceDialog(node.id),
    });
  }

  // (V0.1.79 reordered: Folder-Group entries moved above Archive — see
  // the Group section earlier in the menu so the two appear in user-
  // preferred order. No actions here.)

  // ── Delete folder ────────────────────────────────────────────────────────────
  if (node.type === 'folder') {
    const childCount = (node.children || []).length;
    if (childCount === 0) {
      items.push({
        label: '🗑 Delete Empty Folder',
        action: () => _deleteEmptyFolder(node),
      });
    } else {
      items.push({
        label: `🗑 Delete Folder (contains ${childCount} item${childCount > 1 ? 's' : ''} — empty first)`,
        disabled: true,
      });
    }
  }

  // ── Delete assembly (top-level model only) ───────────────────────
  // Opens the delete-assembly dialog. If no dependencies, the dialog
  // short-circuits to silent ghost-replace. If dependencies exist, it
  // shows the 4-option modal (break / ghost / cancel / save-as).
  if (node.type === 'model' && !node.missing) {
    items.push({ separator: true });
    items.push({
      label: '🗑 Delete assembly…',
      action: () => _onDeleteAssemblyMenu(node),
    });
  }

  // ── Copy / Paste tree (scene root only) ──────────────────────────
  // Captures the current step's tree spec into a session-scoped buffer
  // and replays it onto another step's tree. Per-step action — base
  // step is intentionally read-only (step 0 sacred).
  if (node.type === 'scene') {
    items.push({ separator: true });
    items.push({
      label: '📋 Copy tree',
      disabled: !state.get('activeStepId'),
      action: () => _onCopyTree(),
    });
    const activeId  = state.get('activeStepId');
    const activeStep = activeId
      ? (state.get('steps') || []).find(s => s.id === activeId)
      : null;
    const canPaste = !!_copiedSnapshot && activeStep && !activeStep.isBaseStep;
    items.push({
      label: activeStep?.isBaseStep
        ? '📥 Paste tree (disabled — base step is read-only)'
        : (_copiedSnapshot
            ? `📥 Paste tree (from "${_copiedFromStepName || 'step'}")`
            : '📥 Paste tree (no copy yet)'),
      disabled: !canPaste,
      action: () => _onPasteTree(),
    });
  }

  return items;
}

// ─── Delete-assembly orchestrator + dialog ────────────────────────────────

/**
 * Entry point from the tree menu. Scans dependencies; if there are
 * none, silently demotes the model to ghosts. If dependencies exist,
 * opens the 4-option modal and routes through the chosen action.
 * Save-as loops back to the dialog so the user can checkpoint and
 * still see the same options.
 */
async function _onDeleteAssemblyMenu(modelNode) {
  const deps = actions.collectAssemblyDependents(modelNode.id);
  const noDeps = deps.cables.length === 0 && deps.notes.length === 0 && deps.shapes.length === 0;

  // Helper — Save As round-trip used by both the no-deps confirm and the
  // 4-option dialog. Returns once save resolves (or fails) so the caller
  // can re-show the dialog.
  const _doSaveAs = async () => {
    try {
      const { saveProject } = await import('../io/project.js');
      await saveProject({ mode: 'saveAs' });
    } catch (err) {
      console.warn('[deleteAssembly] save-as failed:', err);
    }
  };

  if (noDeps) {
    // Last-opportunity confirm — even when there are no cable/note/shape
    // dependencies, give the user a chance to back up before deleting.
    // The dialog also surfaces whether any foreign-object guests exist
    // (they'll be preserved via phantom folders).
    const guestCount = _countForeignGuestsUnderModel(modelNode);
    let choice;
    while (true) {
      choice = await _showSilentDeleteConfirmDialog(modelNode, guestCount);
      if (choice !== 'saveAs') break;
      await _doSaveAs();
    }
    if (choice === 'delete') {
      const name = modelNode.name || 'assembly';
      const ok = actions.deleteTopLevelAssembly(modelNode.id);
      if (ok) {
        setStatus(guestCount
          ? `Deleted "${name}". ${guestCount} object${guestCount === 1 ? '' : 's'} from other models kept.`
          : `Deleted "${name}".`);
      }
    }
    // choice === 'cancel': no-op.
    return;
  }

  let choice;
  while (true) {
    choice = await _showDeleteAssemblyDialog(modelNode, deps);
    if (choice !== 'saveAs') break;
    // Save-as round-trip — re-show the same dialog when done so the
    // user can pick a different option after checkpointing.
    await _doSaveAs();
  }
  if (choice === 'break')        actions.deleteTopLevelAssemblyAndBreak(modelNode.id);
  else if (choice === 'phantom') actions.deleteTopLevelAssembly(modelNode.id);
  // choice === 'cancel': no-op.
}

/**
 * Count foreign-object descendants under a model node. A "foreign" node
 * is anything in the model's subtree that doesn't belong to this model
 * (e.g., a mesh dragged in from another loaded model). Notes don't count
 * (they're a separate global layer that anchors by mesh id). Used by the
 * silent-delete confirm dialog to tell the user how many guests will be
 * preserved on delete.
 */
function _countForeignGuestsUnderModel(modelNode) {
  if (!modelNode) return 0;
  // Identify this model's asset id from the first native mesh.
  let modelAssetId = null;
  (function findAsset(n) {
    if (modelAssetId) return;
    if (n.type === 'mesh' && n.sourceAssetId) { modelAssetId = n.sourceAssetId; return; }
    if (n.children) for (const c of n.children) findAsset(c);
  })(modelNode);
  if (!modelAssetId) return 0;
  let count = 0;
  (function walk(n) {
    if (n === modelNode) {
      if (n.children) for (const c of n.children) walk(c);
      return;
    }
    if (n.type === 'mesh' && n.sourceAssetId && n.sourceAssetId !== modelAssetId) {
      count++;
    }
    if (n.children) for (const c of n.children) walk(c);
  })(modelNode);
  return count;
}

/**
 * Pre-confirm modal for the no-dependency delete path. Three buttons:
 *   'delete' | 'saveAs' | 'cancel'
 * Save As loops back via the caller. Default focus is on Cancel so
 * pressing Enter on a stray middle-click is a no-op, not a delete.
 */
function _showSilentDeleteConfirmDialog(modelNode, guestCount) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const name = esc(modelNode.name || 'assembly');
    const guestLine = guestCount > 0
      ? `<div class="small" style="margin-top:8px;color:#86efac;">
           ${guestCount} object${guestCount === 1 ? '' : 's'} from other models will be preserved in phantom folders.
         </div>`
      : '';
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="max-width:480px;">
        <div class="sbs-dialog__title">Delete "${name}"?</div>
        <div class="small" style="margin-top:8px;line-height:1.55;">
          All native meshes and folders will be removed from every step.
          No cables, notes, or shapes depend on this model.
        </div>
        ${guestLine}
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
          <button class="btn" id="_sdc-saveas">💾 Save As…</button>
          <button class="btn" id="_sdc-cancel">✖ Cancel</button>
          <button class="btn" id="_sdc-delete" style="background:#dc2626;color:#fff;">🗑 Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('#_sdc-delete').addEventListener('click', () => done('delete'));
    dlg.querySelector('#_sdc-saveas').addEventListener('click', () => done('saveAs'));
    dlg.querySelector('#_sdc-cancel').addEventListener('click', () => done('cancel'));
    dlg.addEventListener('cancel', () => done('cancel'));
    dlg.showModal();
    // Default focus on Cancel — Enter on a stray click is a no-op.
    requestAnimationFrame(() => dlg.querySelector('#_sdc-cancel')?.focus());
  });
}

// ─── Copy / Paste tree orchestrator + dialog ─────────────────────────────

function _onCopyTree() {
  const activeId = state.get('activeStepId');
  if (!activeId) { setStatus('No active step to copy tree from.', 'warning'); return; }
  const step = (state.get('steps') || []).find(s => s.id === activeId);
  if (!step?.snapshot?.tree) { setStatus('Active step has no tree to copy.', 'warning'); return; }

  // Capture per-folder baseLocal* fields from the LIVE tree.
  // snapshot.transforms already carries per-step localOffset / pivot, but
  // baseLocal* (project-global, written by Global Transform mode) live
  // only on the live node — they'd be lost if we copied just the spec.
  //
  // SAFETY FILTER (added after the "object stuck out of home" bug):
  // copying baseLocal* from a node that was in active global-edit mode,
  // or whose values look garbage (NaN / Inf / wildly out-of-range), can
  // poison the destination on paste. Reset transform only zeros the
  // delta, leaving the corrupted home in place — the only escape was
  // save+reload (which silently normalised baseLocal* to identity since
  // they aren't persisted). We now skip suspicious values at capture so
  // the destination folder lands at identity (safe default) rather than
  // inheriting drift.
  const _isSafeVec = (v, n) =>
    Array.isArray(v) && v.length === n &&
    v.every(x => Number.isFinite(x) && Math.abs(x) < 1e6);
  const inActiveGlobalEdit = state.get('globalEditNodeId') || null;

  const folderBases = {};
  const nodeById = state.get('nodeById');
  if (nodeById) {
    for (const [id, n] of nodeById) {
      if (n?.type !== 'folder') continue;
      // Skip if the source folder is currently in an unfinalised global
      // edit — its baseLocal* could be half-written.
      if (inActiveGlobalEdit && inActiveGlobalEdit === id) continue;
      const p = n.baseLocalPosition;
      const q = n.baseLocalQuaternion;
      const s = n.baseLocalScale;
      if (!_isSafeVec(p, 3) || !_isSafeVec(q, 4) || !_isSafeVec(s, 3)) continue;
      folderBases[id] = {
        baseLocalPosition:   [...p],
        baseLocalQuaternion: [...q],
        baseLocalScale:      [...s],
      };
    }
  }

  _copiedSnapshot = {
    tree:        JSON.parse(JSON.stringify(step.snapshot.tree)),
    transforms:  JSON.parse(JSON.stringify(step.snapshot.transforms || {})),
    visibility:  JSON.parse(JSON.stringify(step.snapshot.visibility || {})),
    folderBases,
  };
  _copiedFromStepName = step.name || 'step';
  setStatus(`Copied tree from "${_copiedFromStepName}".`);
}

async function _onPasteTree() {
  if (!_copiedSnapshot) { setStatus('Nothing copied yet.', 'warning'); return; }
  const activeId = state.get('activeStepId');
  if (!activeId) { setStatus('No active step to paste into.', 'warning'); return; }
  const step = (state.get('steps') || []).find(s => s.id === activeId);
  if (!step?.snapshot?.tree) { setStatus('Active step has no tree.', 'warning'); return; }
  if (step.isBaseStep) { setStatus('The base step is read-only for paste.', 'warning'); return; }

  const diff = actions.diffTreeSpec(_copiedSnapshot.tree, step.snapshot.tree);

  // Nothing to do?
  if (diff.addedFolders.length === 0
   && diff.movedObjects.length === 0
   && diff.removedFolders.length === 0) {
    setStatus('Trees already match — nothing to paste.');
    return;
  }

  const _doSaveAs = async () => {
    try {
      const { saveProject } = await import('../io/project.js');
      await saveProject({ mode: 'saveAs' });
    } catch (err) { console.warn('[pasteTree] save-as failed:', err); }
  };

  let choice;
  while (true) {
    choice = await _showPasteTreeDialog(diff, _copiedFromStepName, step.name || '');
    if (choice !== 'saveAs') break;
    await _doSaveAs();
  }
  if (choice === 'cancel' || !choice) return;

  const ok = actions.pasteTreeApply(activeId, _copiedSnapshot, choice);
  if (ok) {
    setStatus(`Pasted tree from "${_copiedFromStepName}" onto "${step.name || 'step'}".`);
  } else {
    setStatus('Paste failed.', 'danger');
  }
}

/**
 * Main paste-tree dialog. Buttons are filtered by what the diff actually
 * supports — never shows a no-op option.
 *
 * Resolves with one of: 'addOnly' | 'addAndMove' | 'moveOnly' | 'saveAs' | 'cancel'.
 */
function _showPasteTreeDialog(diff, fromStepName, toStepName) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

    const adds    = diff.addedFolders.length;
    const moves   = diff.movedObjects.length;
    const removes = diff.removedFolders.length;

    const buttons = [];

    // ── Removal cases (B.3 / B.4) ────────────────────────────────────
    // When source's tree is missing folders target has, the remove path
    // drops those (if empty after the move) and reshuffles objects.
    // Adds + moves always tag along when present in the diff.
    if (removes > 0) {
      const addPart    = adds > 0 ? `Add ${adds} folder${adds === 1 ? '' : 's'}, ` : '';
      const removePart = `prune ${removes} empty folder${removes === 1 ? '' : 's'} that source doesn't have`;
      const movePart   = moves > 0 ? `, move ${moves} object${moves === 1 ? '' : 's'} to source-side parents` : '';
      buttons.push({
        id: '_pt-addRemoveCascade',
        value: 'addRemoveMoveCascade',
        title: 'Remove + move (cascade)',
        desc:  `${addPart}${removePart}${movePart}. Local transforms unchanged — world positions shift. Folders with orphan children (not in source) stay safe.`,
        recommended: true,
      });
      buttons.push({
        id: '_pt-addRemovePreserve',
        value: 'addRemoveMovePreserve',
        title: 'Remove + move (preserve world)',
        desc:  `${addPart}${removePart}${movePart}. Wraps each moved item in a "↻ preserved" folder so world positions stay put.`,
      });
    } else if (adds > 0 && moves > 0) {
      // ── Add + move (no removals) ─────────────────────────────────
      buttons.push({
        id: '_pt-addOnly',
        value: 'addOnly',
        title: 'Add folders only',
        desc:  `Add ${adds} folder${adds === 1 ? '' : 's'}. Objects stay where they are now.`,
      });
      buttons.push({
        id: '_pt-addMoveCascade',
        value: 'addAndMoveCascade',
        title: 'Add folders + move objects (cascade)',
        desc:  `Add ${adds} folder${adds === 1 ? '' : 's'} and move ${moves} object${moves === 1 ? '' : 's'} to match the source. Local transforms unchanged — world positions shift with the new parent.`,
        recommended: true,
      });
      buttons.push({
        id: '_pt-addMovePreserve',
        value: 'addAndMovePreserve',
        title: 'Add folders + move objects (preserve world)',
        desc:  `Add ${adds} folder${adds === 1 ? '' : 's'} and move ${moves} object${moves === 1 ? '' : 's'}. Wraps each moved item in a "↻ preserved" folder so world positions stay put.`,
      });
    } else if (adds > 0) {
      buttons.push({
        id: '_pt-addOnly',
        value: 'addOnly',
        title: 'Add folders',
        desc:  `Add ${adds} folder${adds === 1 ? '' : 's'}. (No objects need moving — they're already in their source-side positions.)`,
        recommended: true,
      });
    } else if (moves > 0) {
      buttons.push({
        id: '_pt-moveCascade',
        value: 'moveCascade',
        title: 'Move objects (cascade)',
        desc:  `Trees structurally match — re-parent ${moves} object${moves === 1 ? '' : 's'} to their source-side parents. Local transforms unchanged; world positions shift with the new parent.`,
        recommended: true,
      });
      buttons.push({
        id: '_pt-movePreserve',
        value: 'movePreserve',
        title: 'Move objects (preserve world)',
        desc:  `Re-parent ${moves} object${moves === 1 ? '' : 's'}. Wraps each moved item in a "↻ preserved" folder so world positions stay put.`,
      });
    }

    const optButtons = buttons.map(b => `
      <button class="btn" id="${b.id}" style="text-align:left;padding:10px 12px;">
        <b>${esc(b.title)}</b>${b.recommended ? ' <span class="small muted">— recommended</span>' : ''}<br>
        <span class="small muted">${esc(b.desc)}</span>
      </button>
    `).join('');

    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="max-width:560px;">
        <div class="sbs-dialog__title">Paste tree</div>
        <div class="small" style="margin-top:8px;line-height:1.55;">
          From: <b>${esc(fromStepName)}</b> → To: <b>${esc(toStepName)}</b>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:14px;">
          ${optButtons}
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
          <button class="btn" id="_pt-saveas">💾 Save As…</button>
          <button class="btn" id="_pt-cancel">✖ Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    for (const b of buttons) {
      dlg.querySelector('#' + b.id)?.addEventListener('click', () => done(b.value));
    }
    dlg.querySelector('#_pt-saveas').addEventListener('click', () => done('saveAs'));
    dlg.querySelector('#_pt-cancel').addEventListener('click', () => done('cancel'));
    dlg.addEventListener('cancel', () => done('cancel'));
    dlg.showModal();
    // Focus the recommended option (or cancel if no recommendation).
    requestAnimationFrame(() => {
      const rec = buttons.find(b => b.recommended);
      dlg.querySelector(rec ? '#' + rec.id : '#_pt-cancel')?.focus();
    });
  });
}

/**
 * The 4-option modal. Resolves with one of:
 *   'break' | 'phantom' | 'cancel' | 'saveAs'.
 * Caller handles save-as → re-show flow.
 */
function _showDeleteAssemblyDialog(modelNode, deps) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const cables = deps.cables.length;
    const notes  = deps.notes.length;
    const shapes = deps.shapes.length;
    const lines  = [];
    if (cables) lines.push(`<b>${cables}</b> cable${cables === 1 ? '' : 's'} anchored to its meshes`);
    if (notes)  lines.push(`<b>${notes}</b> note${notes === 1 ? '' : 's'} anchored to its meshes`);
    if (shapes) lines.push(`<b>${shapes}</b> shape${shapes === 1 ? '' : 's'} parented under it (any step)`);
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="max-width:540px;">
        <div class="sbs-dialog__title">Delete "${esc(modelNode.name || 'assembly')}"?</div>
        <div class="small" style="margin-top:8px;line-height:1.55;">
          This assembly is referenced by:
          <ul style="margin:6px 0 0 18px;padding:0;">
            ${lines.map(l => `<li>${l}</li>`).join('')}
          </ul>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:14px;">
          <button class="btn" id="_dad-phantom" style="text-align:left;padding:10px 12px;">
            <b>👻 Replace native dependencies with Bbox</b> <span class="small muted">— recommended</span><br>
            <span class="small muted">Only the meshes anchoring a cable / note / shape become bounding-box phantoms. Folders that hold objects from other models in any step are kept as invisible empty containers. Every other native mesh and folder is fully removed.</span>
          </button>
          <button class="btn" id="_dad-break"   style="text-align:left;padding:10px 12px;">
            <b>✂ Remove &amp; break dependencies</b><br>
            <span class="small muted">Purge the entire model — no Bboxes, no phantom folders. Cables anchored to native meshes detach to a row at world 0; shapes re-parent to scene root in a row;${notes ? ` ${notes} note${notes === 1 ? '' : 's'} are DELETED;` : ''} foreign objects living inside native folders re-parent to scene root. Single undo.</span>
          </button>
          <button class="btn" id="_dad-saveAs"  style="text-align:left;padding:10px 12px;">
            <b>💾 Save as… (then return here)</b><br>
            <span class="small muted">Checkpoint the project to a new file before making a destructive choice. This dialog re-opens after save.</span>
          </button>
          <button class="btn" id="_dad-cancel"  style="text-align:left;padding:10px 12px;">
            <b>✖ Cancel</b>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('#_dad-break')  .addEventListener('click', () => done('break'));
    dlg.querySelector('#_dad-phantom').addEventListener('click', () => done('phantom'));
    dlg.querySelector('#_dad-saveAs') .addEventListener('click', () => done('saveAs'));
    dlg.querySelector('#_dad-cancel') .addEventListener('click', () => done('cancel'));
    dlg.addEventListener('cancel', () => done('cancel'));
    dlg.showModal();
    // Focus the recommended option so Enter performs the safe choice.
    requestAnimationFrame(() => dlg.querySelector('#_dad-phantom')?.focus());
  });
}


// ── Context actions ───────────────────────────────────────────────────────────

function _isolateNodes(targetIds) {
  const nodeById = state.get('nodeById');
  if (!nodeById) return;
  for (const [id, node] of nodeById) {
    if (node.type !== 'mesh') continue;
    node.localVisible = targetIds.has(id);
  }
  applyAllVisibility(state.get('treeData'), steps.object3dById);
  state.emit('change:treeData', state.get('treeData'));
  steps.scheduleSync();
  setStatus(`Isolated ${targetIds.size} item(s).`);
}

function _fitToNodes(targetIds) {
  const THREE = window.THREE;
  if (!THREE) return;
  const box = new THREE.Box3();
  for (const id of targetIds) {
    const obj = steps.object3dById.get(id);
    if (obj) {
      const b = new THREE.Box3().setFromObject(obj);
      if (!b.isEmpty()) box.union(b);
    }
  }
  if (box.isEmpty()) { setStatus('Nothing to fit.'); return; }
  sceneCore.animateCameraTo(sceneCore.fitStateForBox(box, 1.15), 800, 'smooth');
}

function _createFolderInside(parentNode) {
  _showInputDialog('New Folder Inside', 'Group', name => {
    _expanded.add(parentNode.id);
    _intentional.add(parentNode.id);
    // Undoable — creates the folder node + Three.js Group, pushes undo.
    const id = actions.createFolderInNode(parentNode.id, name);
    if (id) setStatus(`Created folder "${name}".`);
  });
}

function _collapseSubtree(node) {
  function walk(n) {
    _expanded.delete(n.id);
    _intentional.delete(n.id);
    (n.children || []).forEach(walk);
  }
  walk(node);
  renderTree();
}

function _deleteEmptyFolder(node) {
  _expanded.delete(node.id);
  _intentional.delete(node.id);
  // Undoable — captures the folder node + parent slot + Three.js Group so
  // undo splices it back and re-adds it to the scene graph.
  if (actions.deleteFolderNode(node.id)) {
    setStatus(`Deleted folder "${node.name}".`);
  }
}

/**
 * V0.2.22 — build a fresh "adjustment folder" tree-spec node.
 *
 * Used by the keep-position branch of _moveIdsIntoNode when moving
 * NON-TRANSFORM items (meshes) across parents: we wrap each source-
 * parent group in one of these folders inside the destination, then
 * set the folder's localOffset/Quaternion to compensate for the
 * source→destination frame change so the items' world poses are
 * preserved.
 *
 * baseLocal* = identity. The wrapper is brand new; it has no "home"
 * to drift from. localOffset/Quaternion alone carries the compensation.
 */
function _makeAdjustmentFolderSpec(id, sourceName) {
  return {
    id,
    type:         'folder',
    name:         `↪ Adj from "${(sourceName || 'folder').slice(0, 32)}"`,
    localVisible: true,
    archived:     false,
    locked:       false,
    children:     [],

    // Identity home anchor — wrapper has no FBX import history.
    baseLocalPosition:    [0, 0, 0],
    baseLocalQuaternion:  [0, 0, 0, 1],
    baseLocalScale:       [1, 1, 1],

    // Per-step deltas — set by the compensation pass after rebuild.
    localOffset:          [0, 0, 0],
    localQuaternion:      [0, 0, 0, 1],
    orientationSteps:     [0, 0, 0],

    // Pivot at origin (no custom pivot for a fresh wrapper).
    pivotLocalOffset:     [0, 0, 0],
    pivotLocalQuaternion: [0, 0, 0, 1],

    moveEnabled:   true,
    rotateEnabled: true,
    pivotEnabled:  true,
  };
}

function _moveIdsIntoNode(ids, targetNode) {
  if (!ids.length) return;
  const root = state.get('treeData');
  if (!root) return;

  // V0.2.18: when an ancestor is ALSO in the move set, the descendant rides
  // along inside it — moving the descendant separately would spill it out
  // of its parent into the destination ("folder A → dest, then folder A's
  // child X → dest, leaving A empty"). Filter out descendants of any
  // included ancestor up front.
  const idSet = new Set(ids);
  const anyAncestorIn = (nodeId) => {
    let pp = findParent(root, nodeId);
    while (pp) {
      if (idSet.has(pp.id)) return true;
      pp = findParent(root, pp.id);
    }
    return false;
  };
  ids = ids.filter(id => !anyAncestorIn(id));
  if (!ids.length) { setStatus('Nothing to move.'); return; }

  // Collect the valid moves first (cycle / self / no-op filtered), capturing
  // each node's ORIGINAL parent + index so the undo can splice it back.
  // V0.2.22: also capture pre-move localOffset/Quaternion/orientationSteps
  // so undo can restore them when keep-position rewrote per-step deltas.
  // We DO NOT capture baseLocal* anymore — the new keep-position path
  // never touches the project-global anchor (the V0.2.19 trap is gone).
  const moves = [];   // { nodeId, fromParentId, fromIdx, beforeXf }
  for (const id of ids) {
    if (id === targetNode.id) continue;                    // can't drop onto self
    const movedNode = findNode(root, id);
    if (movedNode) {
      const movedDescendants = new Set(collectDescendantIds(movedNode) || []);
      movedDescendants.delete(id);                        // exclude self
      if (movedDescendants.has(targetNode.id)) continue;  // target is inside moved node
    }
    const parent = findParent(root, id);
    if (!parent) continue;
    if (parent.id === targetNode.id) continue;            // already a direct child — skip
    const idx = parent.children.findIndex(c => c.id === id);
    if (idx < 0) continue;
    moves.push({
      nodeId: id,
      fromParentId: parent.id,
      fromIdx: idx,
      beforeXf: {
        localOffset:      [...(movedNode?.localOffset      || [0, 0, 0])],
        localQuaternion:  [...(movedNode?.localQuaternion  || [0, 0, 0, 1])],
        orientationSteps: [...(movedNode?.orientationSteps || [0, 0, 0])],
      },
    });
  }
  if (!moves.length) { setStatus('Nothing to move.'); return; }

  // V0.2.22 — UNIFIED REBUILD ARCHITECTURE + ADJUSTMENT FOLDERS
  // ─────────────────────────────────────────────────────────────────────
  // The old V0.2.19 path did `parent.remove(obj) + dest.add(obj)` directly,
  // then called applyAllTransforms. That diverged from the load /
  // step-activation path which uses `cleanupFolderGroups + rebuildFromTreeSpec`
  // to recreate every folder's Three.js Group fresh from the data tree.
  //
  // The divergence let users author per-step deltas (via gizmo) AGAINST a
  // wrong in-app cascade, then save+load applied the CORRECT cascade and
  // those deltas became visible drift — the "double-compensation loop."
  //
  // Now: every structural change goes through `steps.applySnapshotInstant`
  // with just the tree field, producing the byte-identical Three.js graph
  // that load would reproduce from the same spec.
  //
  // keep-position no longer touches baseLocal* (project-global). Two paths:
  //
  //   Rule A — transform-bearing nodes (folder / model / flatShape)
  //     Self-compensate: write per-step localOffset / localQuaternion onto
  //     the moved node itself so its world pose is preserved. No effect on
  //     siblings. Active step only.
  //
  //   Rule B — non-transform nodes (mesh, etc.)
  //     Meshes can't self-compensate (no per-node deltas in SBS — their
  //     pose is the parent chain × baked vertex positions). Compensating
  //     the destination folder would shift every UNRELATED sibling already
  //     in it. The right solution is an "Adjustment Folder" wrapper:
  //       - one new folder per SOURCE PARENT (so each group keeps its own
  //         frame compensation; mixing sources in one wrapper would smear
  //         the math)
  //       - the moved meshes are parented INTO the wrapper
  //       - the wrapper's localOffset/Quaternion = decompose(inv(destWorld)
  //         × sourceWorld), so wrapper.world × mesh.bakedLocal = old world
  //     Wrapper name: `↪ Adj from "<sourceName>"` for easy spotting.
  //
  // Adjustment folder IDs are minted up-front so undo / redo can address
  // them by stable id across both directions of the action.

  // Partition moves into Rule A (transform-bearing) and Rule B (mesh-like).
  // Group Rule B moves by source parent — one adjustment folder per source.
  const transformMoves = [];
  const meshGroups     = new Map();   // sourceParentId → moves[]
  for (const m of moves) {
    const movedNode = findNode(root, m.nodeId);
    if (movedNode && isTransformNode(movedNode)) {
      transformMoves.push(m);
    } else {
      if (!meshGroups.has(m.fromParentId)) meshGroups.set(m.fromParentId, []);
      meshGroups.get(m.fromParentId).push(m);
    }
  }

  // Pre-mint adjustment folder ids + capture source-parent names. Empty if
  // the user picks Cascade; built up-front so doMove/undoMove address them
  // by stable id (redo creates the SAME folder ids the first do created).
  const adjustments = [];   // [{ adjId, sourceParentId, sourceName, items: moves[] }]
  for (const [sourceParentId, items] of meshGroups) {
    const sourceParent = findNode(root, sourceParentId);
    adjustments.push({
      adjId:          generateId('folder'),
      sourceParentId,
      sourceName:     (sourceParent?.name || 'folder').slice(0, 32),
      items,
    });
  }

  _showKeepPositionDialog(moves.length, targetNode.name || 'folder').then((choice) => {
    if (choice === 'cancel') { setStatus('Move cancelled.'); return; }
    const keepPos = choice === 'keep';

    // ── doMove ──────────────────────────────────────────────────────────
    const doMove = () => {
      const r = state.get('treeData');
      const THREE = window.THREE;

      // 1) Capture pre-move world matrices BEFORE we mutate anything.
      //    For Rule A: the moved node's own world.
      //    For Rule B: each source parent's world (the wrapper's
      //                compensation reads this).
      const oldNodeWorlds   = new Map();   // nodeId → Matrix4
      const oldSourceWorlds = new Map();   // sourceParentId → Matrix4
      if (keepPos && THREE) {
        for (const m of transformMoves) {
          const obj = steps.object3dById?.get(m.nodeId);
          if (!obj) continue;
          if (obj.parent) obj.parent.updateMatrixWorld(true);
          obj.updateMatrixWorld(true);
          oldNodeWorlds.set(m.nodeId, obj.matrixWorld.clone());
        }
        for (const a of adjustments) {
          const srcObj = steps.object3dById?.get(a.sourceParentId);
          if (!srcObj) continue;
          srcObj.updateMatrixWorld(true);
          oldSourceWorlds.set(a.sourceParentId, srcObj.matrixWorld.clone());
        }
      }

      // 2) Update the DATA SPEC. NO direct Three.js mutation — rebuild
      //    handles all scene graph changes from the new spec.

      // 2a) Transform-bearing moves go directly into the destination.
      for (const m of transformMoves) {
        const p = findParent(r, m.nodeId);
        const node = findNode(r, m.nodeId);
        const dest = findNode(r, targetNode.id);
        if (!node || !dest) continue;
        if (p) {
          const i = p.children.findIndex(c => c.id === m.nodeId);
          if (i >= 0) p.children.splice(i, 1);
        }
        dest.children = dest.children || [];
        dest.children.push(node);
      }

      // 2b) Non-transform (mesh) moves: keep-position wraps each source-
      //     parent group in a fresh Adjustment folder. Cascade just drops
      //     them directly into the destination — no wrapper needed.
      if (keepPos) {
        const dest = findNode(r, targetNode.id);
        if (dest) {
          dest.children = dest.children || [];
          for (const a of adjustments) {
            const adjNode = _makeAdjustmentFolderSpec(a.adjId, a.sourceName);
            // Splice each item out of its source parent and into the adjustment folder.
            for (const m of a.items) {
              const p = findParent(r, m.nodeId);
              const node = findNode(r, m.nodeId);
              if (!node || !p) continue;
              const i = p.children.findIndex(c => c.id === m.nodeId);
              if (i >= 0) p.children.splice(i, 1);
              adjNode.children.push(node);
            }
            dest.children.push(adjNode);
          }
        }
      } else {
        // Cascade: flat move, no wrappers.
        for (const a of adjustments) {
          for (const m of a.items) {
            const p = findParent(r, m.nodeId);
            const node = findNode(r, m.nodeId);
            const dest = findNode(r, targetNode.id);
            if (!node || !dest) continue;
            if (p) {
              const i = p.children.findIndex(c => c.id === m.nodeId);
              if (i >= 0) p.children.splice(i, 1);
            }
            dest.children = dest.children || [];
            dest.children.push(node);
          }
        }
      }

      // 3) Rebuild Three.js scene via the SAME path load uses.
      steps.applySnapshotInstant({ tree: serializeModelTree(r) });

      // 4) Push folder/model/flatShape transforms onto their fresh Groups.
      //    rebuildFromTreeSpec creates groups at identity; applyAllTransforms
      //    walks the data tree and applies baseLocal+localOffset to each.
      applyAllTransforms(r, steps.object3dById);

      // 5) keep-position compensation pass.
      if (keepPos && THREE) {
        const nodeMap   = state.get('nodeById');
        const invParent = new THREE.Matrix4();
        const localMat  = new THREE.Matrix4();
        const tmpPos    = new THREE.Vector3();
        const tmpQuat   = new THREE.Quaternion();
        const tmpScale  = new THREE.Vector3();
        const baseQuat  = new THREE.Quaternion();
        const localQuat = new THREE.Quaternion();

        // 5a) Rule A — self-compensate each transform-bearing moved node.
        for (const m of transformMoves) {
          const oldWorld = oldNodeWorlds.get(m.nodeId);
          if (!oldWorld) continue;
          const node = nodeMap?.get(m.nodeId);
          if (!node) continue;
          const obj = steps.object3dById?.get(m.nodeId);
          if (!obj?.parent) continue;
          obj.parent.updateMatrixWorld(true);

          // local-needed = inv(newParent.world) × oldWorld
          invParent.copy(obj.parent.matrixWorld).invert();
          localMat.multiplyMatrices(invParent, oldWorld);
          localMat.decompose(tmpPos, tmpQuat, tmpScale);

          const blp = node.baseLocalPosition   || [0, 0, 0];
          const blq = node.baseLocalQuaternion || [0, 0, 0, 1];

          node.localOffset = [
            tmpPos.x - blp[0],
            tmpPos.y - blp[1],
            tmpPos.z - blp[2],
          ];
          baseQuat.set(blq[0], blq[1], blq[2], blq[3]).invert();
          localQuat.copy(baseQuat).multiply(tmpQuat);
          setStoredQuaternion(node, [localQuat.x, localQuat.y, localQuat.z, localQuat.w]);
        }

        // 5b) Rule B — each adjustment folder's local = inv(dest.world)
        //     × sourceParent.world. Adjustment folders are fresh, so their
        //     baseLocal* is identity; localOffset/Quaternion alone carries
        //     the compensation.
        const destObj = steps.object3dById?.get(targetNode.id);
        if (destObj) {
          destObj.updateMatrixWorld(true);
          const invDest = new THREE.Matrix4().copy(destObj.matrixWorld).invert();
          for (const a of adjustments) {
            const srcWorld = oldSourceWorlds.get(a.sourceParentId);
            if (!srcWorld) continue;
            const adjNode = nodeMap?.get(a.adjId);
            if (!adjNode) continue;
            localMat.multiplyMatrices(invDest, srcWorld);
            localMat.decompose(tmpPos, tmpQuat, tmpScale);
            adjNode.localOffset = [tmpPos.x, tmpPos.y, tmpPos.z];
            setStoredQuaternion(adjNode, [tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w]);
          }
        }

        // Re-apply to push the new deltas to Three.js.
        applyAllTransforms(r, steps.object3dById);
      }

      state.emit('change:treeData', r);
      steps.scheduleTransformSync();
      state.markDirty();
    };

    // ── undoMove ────────────────────────────────────────────────────────
    const undoMove = () => {
      const r = state.get('treeData');

      // 1) Restore non-transform moves to their original parents and remove
      //    the adjustment folders. We do this BEFORE the transform-move
      //    restore so dest.children indices for transform moves stay stable.
      const dest = findNode(r, targetNode.id);
      if (dest?.children) {
        for (const a of adjustments) {
          // Find the adjustment folder; lift its children back to original
          // parents at their original indices, then remove the folder.
          const idx = dest.children.findIndex(c => c.id === a.adjId);
          if (idx >= 0) {
            const adjFolder = dest.children[idx];
            // For each item: pull from adj.children, splice into original parent.
            for (const m of [...a.items].reverse()) {
              const itemIdx = adjFolder.children.findIndex(c => c.id === m.nodeId);
              if (itemIdx < 0) continue;
              const [itemNode] = adjFolder.children.splice(itemIdx, 1);
              const orig = findNode(r, m.fromParentId);
              if (orig) {
                orig.children = orig.children || [];
                const insertAt = Math.min(m.fromIdx, orig.children.length);
                orig.children.splice(insertAt, 0, itemNode);
              }
            }
            // Remove the now-empty adjustment folder.
            dest.children.splice(idx, 1);
          } else {
            // Cascade path (no wrapper was created). Items are direct
            // children of dest — restore them straight to original parents.
            for (const m of [...a.items].reverse()) {
              const itemIdx = dest.children.findIndex(c => c.id === m.nodeId);
              if (itemIdx < 0) continue;
              const [itemNode] = dest.children.splice(itemIdx, 1);
              const orig = findNode(r, m.fromParentId);
              if (orig) {
                orig.children = orig.children || [];
                const insertAt = Math.min(m.fromIdx, orig.children.length);
                orig.children.splice(insertAt, 0, itemNode);
              }
            }
          }
        }
      }

      // 2) Restore transform-bearing moves to their original parents AND
      //    restore their pre-move per-step deltas (only meaningful when
      //    keepPos rewrote them).
      for (const m of [...transformMoves].reverse()) {
        const d = findNode(r, targetNode.id);
        const node = findNode(r, m.nodeId);
        const orig = findNode(r, m.fromParentId);
        if (!node) continue;
        if (d?.children) {
          const i = d.children.findIndex(c => c.id === m.nodeId);
          if (i >= 0) d.children.splice(i, 1);
        }
        if (!orig) continue;
        orig.children = orig.children || [];
        const insertAt = Math.min(m.fromIdx, orig.children.length);
        orig.children.splice(insertAt, 0, node);

        if (keepPos) {
          node.localOffset      = [...m.beforeXf.localOffset];
          node.localQuaternion  = [...m.beforeXf.localQuaternion];
          node.orientationSteps = [...m.beforeXf.orientationSteps];
        }
      }

      // Rebuild via the same unified path so undo lands at exactly the
      // scene the user would see if they'd never made the move.
      steps.applySnapshotInstant({ tree: serializeModelTree(r) });
      applyAllTransforms(r, steps.object3dById);
      state.emit('change:treeData', r);
      steps.scheduleTransformSync();
      state.markDirty();
    };

    doMove();
    _expanded.add(targetNode.id);
    _intentional.add(targetNode.id);
    undoManager.push(
      `Move ${moves.length} item(s) into "${targetNode.name}"${keepPos ? ' (keep position)' : ''}`,
      undoMove, doMove,
    );
    setStatus(`Moved ${moves.length} item(s) into "${targetNode.name}"${keepPos ? ' (position preserved).' : '.'}`);
  });
}

/**
 * V0.2.19: 3-option modal asked on every cross-parent move:
 *   Cancel             → abort the move.
 *   Cascade position   → standard reparent; world position SHIFTS to follow
 *                        the new parent (current behaviour, fastest).
 *   keep position      → reparent + recompute local transform so the moved
 *                        items stay where they are in the active step.
 *                        (Per-step animations still ride on the new parent
 *                        — other steps may shift.)
 */
function _showKeepPositionDialog(count, destName, opts = null) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    const esc = s => String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const n = count === 1 ? '1 item' : `${count} items`;
    // V0.2.20: dialog is shared between the cross-parent MOVE flow and the
    // Paste-Transforms flow. opts.title / opts.body override the move copy.
    const title = opts?.title ?? `Move ${esc(n)} → "${esc(destName)}"`;
    const body  = opts?.body  ?? (
      `Keep the moved ${count === 1 ? 'item' : 'items'} at their current ` +
      `world position, or follow the destination folder's transform (the ` +
      `standard tree-rearrange behaviour)?<br><br>` +
      `<span class="muted" style="font-size:11px">` +
      `"keep position" preserves the pose in the <strong>active step</strong>. ` +
      `Per-step animations still ride on the new parent — other steps may shift.` +
      `</span>`
    );
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div class="sbs-dialog__title">${title}</div>
        <div class="small" style="margin-top:8px;line-height:1.45">${body}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap">
          <button class="btn" id="_kp-cancel">Cancel</button>
          <button class="btn" id="_kp-rearrange">Cascade position</button>
          <button class="btn primary" id="_kp-keep">keep position</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const done = (choice) => { dlg.close(); dlg.remove(); resolve(choice); };
    dlg.querySelector('#_kp-cancel').addEventListener('click',    () => done('cancel'));
    dlg.querySelector('#_kp-rearrange').addEventListener('click', () => done('rearrange'));
    dlg.querySelector('#_kp-keep').addEventListener('click',      () => done('keep'));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done('cancel'); });
    dlg.showModal();
    requestAnimationFrame(() => dlg.querySelector('#_kp-keep').focus());
  });
}

// ── Folder Copy / Paste Transforms (V0.2.20) ─────────────────────────────────

/**
 * Walk a folder subtree and capture transform fields (current step's deltas)
 * for the folder itself + every transform-bearing descendant. Keyed by
 * relative name-path from the folder root.
 */
function _captureFolderXfSubtree(folderNode) {
  const entries = [];
  (function walk(node, relPath) {
    if (isTransformNode(node)) {
      entries.push({
        relPath: [...relPath],
        type:    node.type,
        name:    node.name || '',
        xf: {
          localOffset:          [...(node.localOffset          || [0, 0, 0])],
          localQuaternion:      [...(node.localQuaternion      || [0, 0, 0, 1])],
          orientationSteps:     [...(node.orientationSteps     || [0, 0, 0])],
          pivotLocalOffset:     [...(node.pivotLocalOffset     || [0, 0, 0])],
          pivotLocalQuaternion: [...(node.pivotLocalQuaternion || [0, 0, 0, 1])],
        },
      });
    }
    for (const c of (node.children || [])) {
      walk(c, [...relPath, c.name || '']);
    }
  })(folderNode, []);
  return entries;
}

function _copyFolderTransforms(folderNode) {
  if (!folderNode || folderNode.type !== 'folder') return;
  const entries = _captureFolderXfSubtree(folderNode);
  const activeId = state.get('activeStepId');
  const sourceStep = activeId ? (state.get('steps') || []).find(s => s.id === activeId) : null;
  _folderXfClipboard = {
    rootName:        folderNode.name || 'folder',
    sourceStepName:  sourceStep?.name || '(active step)',
    entries,
  };
  setStatus(`Copied transforms from "${folderNode.name}" — ${entries.length} node(s).`);
}

/** Locate a target node by relative name-path from a root folder. */
function _findByRelPath(root, relPath) {
  let cur = root;
  for (const name of relPath) {
    const child = (cur.children || []).find(c => (c.name || '') === name);
    if (!child) return null;
    cur = child;
  }
  return cur;
}

/**
 * Compare the source clipboard's entries to the target folder's actual
 * subtree. Returns:
 *   matches — Map<relPathKey, targetNode>  (only entries that resolve to
 *             a node of the EXPECTED type)
 *   missing — entries that don't resolve in target (or type-mismatched)
 *   extras  — target nodes that have no counterpart in source
 */
function _computeFolderXfMismatch(targetFolder, entries) {
  const matches = new Map();
  const missing = [];
  for (const e of entries) {
    if (e.relPath.length === 0) { matches.set('', targetFolder); continue; }
    const t = _findByRelPath(targetFolder, e.relPath);
    if (t && t.type === e.type) matches.set(e.relPath.join('/'), t);
    else missing.push({ relPath: e.relPath, type: e.type, name: e.name });
  }
  const srcKeys = new Set(entries.map(e => e.relPath.join('/')));
  const extras = [];
  (function walk(node, relPath) {
    if (relPath.length > 0 && isTransformNode(node)) {
      const key = relPath.join('/');
      if (!srcKeys.has(key)) extras.push({ relPath: [...relPath], type: node.type, name: node.name });
    }
    for (const c of (node.children || [])) walk(c, [...relPath, c.name || '']);
  })(targetFolder, []);
  return { matches, missing, extras };
}

/**
 * V0.2.20: warn user when target subtree shape doesn't match source.
 * Returns 'cancel' | 'saveas' | 'proceed'.
 */
function _showFolderXfMismatchDialog(srcName, dstName, missing, extras) {
  return new Promise(resolve => {
    const esc = s => String(s ?? '').replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const list = (arr, kind) => arr.length === 0 ? '' : `
      <div style="margin-top:8px">
        <div class="small muted" style="font-size:11px">${kind} (${arr.length}):</div>
        <ul style="margin:4px 0 0;padding-left:18px;max-height:140px;overflow:auto;font-size:11px;line-height:1.4">
          ${arr.slice(0, 30).map(e =>
            `<li>${esc(e.relPath.join(' / '))} <span class="muted">(${esc(e.type)})</span></li>`
          ).join('')}
          ${arr.length > 30 ? `<li class="muted">… ${arr.length - 30} more</li>` : ''}
        </ul>
      </div>
    `;
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div class="sbs-dialog__title">Structure mismatch</div>
        <div class="small" style="margin-top:8px;line-height:1.45">
          Target folder <strong>"${esc(dstName)}"</strong> doesn't fully match
          the copied subtree <strong>"${esc(srcName)}"</strong>.<br>
          Proceeding will only affect nodes that exist in BOTH subtrees —
          missing entries are skipped, extras are left untouched.<br>
          Consider <em>Copy / Paste Tree</em> instead, or rearrange the tree
          manually. Save As… lets you preserve the current project before
          experimenting.
          ${list(missing, 'Missing in target')}
          ${list(extras, 'Extra in target (will be skipped)')}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap">
          <button class="btn" id="_xf-cancel">Cancel</button>
          <button class="btn" id="_xf-saveas">Save As…</button>
          <button class="btn primary" id="_xf-proceed">Proceed anyway</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const done = (c) => { dlg.close(); dlg.remove(); resolve(c); };
    dlg.querySelector('#_xf-cancel').addEventListener('click',  () => done('cancel'));
    dlg.querySelector('#_xf-saveas').addEventListener('click',  () => done('saveas'));
    dlg.querySelector('#_xf-proceed').addEventListener('click', () => done('proceed'));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done('cancel'); });
    dlg.showModal();
    requestAnimationFrame(() => dlg.querySelector('#_xf-proceed').focus());
  });
}

async function _pasteFolderTransforms(folderNode) {
  if (!folderNode || folderNode.type !== 'folder') return;
  if (!_folderXfClipboard) { setStatus('No transforms in clipboard.'); return; }
  const clip = _folderXfClipboard;

  // ── Structure check ─────────────────────────────────────────────────────
  const { matches, missing, extras } = _computeFolderXfMismatch(folderNode, clip.entries);

  if (missing.length > 0 || extras.length > 0) {
    const choice = await _showFolderXfMismatchDialog(clip.rootName, folderNode.name, missing, extras);
    if (choice === 'cancel') { setStatus('Paste cancelled.'); return; }
    if (choice === 'saveas') {
      try {
        const { saveProject } = await import('../io/project.js');
        const result = await saveProject({ mode: 'saveAs' });
        if (!result?.saved) { setStatus('Paste cancelled (Save As cancelled).'); return; }
        setStatus(`Saved as "${state.get('projectName')}". Continuing paste…`);
      } catch (err) {
        console.error('Save As failed:', err);
        setStatus('Save As failed.', 'danger');
        return;
      }
    }
    // 'proceed' (or after-save) — fall through.
  }

  // ── Cascade vs Keep position ────────────────────────────────────────────
  const mode = await _showKeepPositionDialog(matches.size, folderNode.name, {
    title: `Paste transforms onto "${folderNode.name}"`,
    body: (
      `Apply the captured pose to the folder + every matching descendant ` +
      `(<strong>Cascade position</strong>), or apply only the descendant ` +
      `deltas and leave the target folder's current pose alone ` +
      `(<strong>keep position</strong>)?<br><br>` +
      `<span class="muted" style="font-size:11px">` +
      `Source: "${clip.rootName}" from step "${clip.sourceStepName}". ` +
      `Paste writes the captured deltas into the CURRENT step only.` +
      `</span>`
    ),
  });
  if (mode === 'cancel') { setStatus('Paste cancelled.'); return; }
  const includeRoot = (mode === 'rearrange');

  // ── Build before/after snapshots for undo ───────────────────────────────
  const before = [];
  const after  = [];
  for (const e of clip.entries) {
    if (!includeRoot && e.relPath.length === 0) continue;
    const key = e.relPath.join('/');
    const target = matches.get(key);
    if (!target) continue;
    before.push({ id: target.id, snap: captureTransformSnapshot(target) });
    after.push({
      id: target.id,
      snap: {
        ...e.xf,
        moveEnabled:   target.moveEnabled   !== false,
        rotateEnabled: target.rotateEnabled !== false,
        pivotEnabled:  target.pivotEnabled  !== false,
      },
    });
  }
  if (after.length === 0) { setStatus('Nothing to paste — no matching nodes.'); return; }

  const apply = (entries) => {
    const nb = state.get('nodeById');
    for (const e of entries) {
      const n = nb?.get(e.id);
      if (n) applyTransformSnapshot(n, e.snap);
    }
    const root = state.get('treeData');
    if (root) applyAllTransforms(root, steps.object3dById);
    steps.scheduleTransformSync();
    state.emit('change:treeData', root);
    state.markDirty?.();
  };
  const doApply   = () => apply(after);
  const undoApply = () => apply(before);

  doApply();
  undoManager.push(
    `Paste transforms onto "${folderNode.name}"${mode === 'keep' ? ' (folder pose kept)' : ''}`,
    undoApply, doApply,
  );
  setStatus(`Pasted transforms onto "${folderNode.name}" — ${after.length} node(s)${mode === 'keep' ? ', folder pose preserved.' : '.'}`);
}


// ── Move To Folder dialog ─────────────────────────────────────────────────────

/**
 * Unified "move to folder" dialog. One screen, one primary button.
 *
 * Flow:
 *   • Dropdown listing existing folders + a "+ Create new folder" entry.
 *   • Always-visible "New folder name" input — greyed-out when dropdown
 *     is on an existing folder (text persists for re-edits), white +
 *     editable when on "+ Create new folder".
 *   • Typing into the (greyed) input snaps dropdown to "+ Create new
 *     folder" and re-activates the input.
 *   • Clicking the (greyed) input re-activates it AND flips dropdown.
 *   • Picking an existing folder regreys the input (text stays).
 *   • Primary button text follows the dropdown:
 *       existing folder  → "Move here"
 *       + Create new     → "Create and move here"  (creates folder
 *                           at scene root then moves selection in)
 *   • Cancel / Esc closes without action.
 */
export function showMoveToFolderDialog(nodeIds) {
  if (!nodeIds || !nodeIds.length) return;
  const root = state.get('treeData');
  if (!root) return;

  // ── Excluded destinations: the moved nodes + their descendants (you can't
  // drop a node into itself or one of its own children). ──
  const excluded = new Set(nodeIds);
  for (const id of nodeIds) {
    const n = findNode(root, id);
    if (n) collectDescendantIds(n)?.forEach(d => excluded.add(d));
  }

  // ── Smart default: the common parent of everything being moved. If they
  // all share one parent → pre-select it (so "create new folder" lands
  // right there). Mixed parents → default to Root and let the user pick. ──
  const parentIds = new Set();
  for (const id of nodeIds) {
    const p = findParent(root, id);
    parentIds.add(p ? p.id : root.id);
  }
  const common = parentIds.size === 1 ? [...parentIds][0] : null;
  let selectedId = (common && !excluded.has(common)) ? common : root.id;

  // ── Container-only tree (scene root + folders + models), minus the moved
  // set. Rendered as a real collapsible tree, not a flat dropdown. ──
  const buildTree = (node) => {
    if (excluded.has(node.id)) return null;
    if (!(node.type === 'scene' || node.type === 'folder' || node.type === 'model')) return null;
    const children = (node.children || []).map(buildTree).filter(Boolean);
    return {
      id: node.id, type: node.type,
      name: node.name || (node.type === 'scene' ? 'Root' : 'Folder'),
      children,
    };
  };
  const treeData = buildTree(root);
  if (!treeData) return;

  const collapsed = new Set();   // collapsed node ids

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.style.cssText = 'max-width:460px;';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">Move to Folder</div>
      <p class="small" style="margin:6px 0 10px;color:#94a3b8">
        Moving ${nodeIds.length} item${nodeIds.length > 1 ? 's' : ''} — pick a destination
        ${common ? '' : '<br><span style="color:#fbbf24">Items come from different folders — choose where they go.</span>'}
      </p>
      <div id="mtf-tree" style="max-height:300px;overflow:auto;border:1px solid #334155;border-radius:6px;padding:4px;background:#0b1220;user-select:none;"></div>
      <label class="colorlab" style="margin-top:10px">New sub-folder name (optional)
        <input type="text" id="mtf-new-name" placeholder="leave blank to move into the selected folder" style="margin-top:6px" />
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="btn" id="mtf-cancel">Cancel</button>
        <button class="btn" id="mtf-accept" style="background:#0369a1;color:#f1f5f9;">Move here</button>
      </div>
    </div>
  `;

  const treeEl = dlg.querySelector('#mtf-tree');
  const input  = dlg.querySelector('#mtf-new-name');
  const accept = dlg.querySelector('#mtf-accept');
  const cancel = dlg.querySelector('#mtf-cancel');

  const ICON = { scene: '🌐', folder: '🗂', model: '🧩' };

  const render = () => {
    treeEl.innerHTML = '';
    const walk = (node, depth) => {
      const hasKids     = node.children.length > 0;
      const isCollapsed = collapsed.has(node.id);
      const sel         = node.id === selectedId;

      const row = document.createElement('div');
      row.dataset.id = node.id;
      row.style.cssText = [
        'display:flex', 'align-items:center', 'gap:4px',
        `padding:3px 6px 3px ${6 + depth * 16}px`,
        'border-radius:4px', 'cursor:pointer', 'font-size:13px', 'line-height:1.4',
        sel ? 'background:#1d4ed8;outline:1px solid #60a5fa;color:#fff'
            : 'background:transparent;color:#cbd5e1',
      ].join(';');

      const tog = document.createElement('span');
      tog.style.cssText = 'width:14px;text-align:center;flex:none;color:#64748b;';
      tog.textContent = hasKids ? (isCollapsed ? '▸' : '▾') : '·';
      if (hasKids) tog.dataset.toggle = node.id;
      row.appendChild(tog);

      const ic = document.createElement('span');
      ic.textContent = ICON[node.type] || '🗂';
      ic.style.flex = 'none';
      row.appendChild(ic);

      const nm = document.createElement('span');
      nm.textContent = node.name;
      nm.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      row.appendChild(nm);

      treeEl.appendChild(row);
      if (hasKids && !isCollapsed) for (const c of node.children) walk(c, depth + 1);
    };
    walk(treeData, 0);
  };

  treeEl.addEventListener('click', (e) => {
    const tog = e.target.closest('[data-toggle]');
    if (tog) {
      const id = tog.dataset.toggle;
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      render();
      return;
    }
    const row = e.target.closest('[data-id]');
    if (row) { selectedId = row.dataset.id; render(); }
  });

  const refreshBtn = () => {
    accept.textContent = input.value.trim() ? 'Create & move here' : 'Move here';
  };
  input.addEventListener('input', refreshBtn);
  refreshBtn();
  render();

  cancel.addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.addEventListener('cancel', () => { dlg.remove(); });   // Esc closes

  accept.addEventListener('click', () => {
    const destNode = state.get('nodeById')?.get(selectedId) || findNode(state.get('treeData'), selectedId);
    if (!destNode) return;
    const name = input.value.trim();
    dlg.close(); dlg.remove();
    if (name) {
      // Create the new folder UNDER the highlighted node, then move in.
      const newId   = actions.createFolderInNode(destNode.id, name);
      const newNode = newId
        ? (state.get('nodeById')?.get(newId) || findNode(state.get('treeData'), newId))
        : null;
      if (newNode) _moveIdsIntoNode(nodeIds, newNode);
    } else {
      _moveIdsIntoNode(nodeIds, destNode);
    }
  });

  document.body.appendChild(dlg);
  dlg.showModal();
  // Scroll the smart-default selection into view.
  requestAnimationFrame(() => {
    treeEl.querySelector(`[data-id="${selectedId}"]`)?.scrollIntoView({ block: 'center' });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADD-TO-REPLACE PICKER + MODE DIALOG  (B.2-NEW.2)
// ═══════════════════════════════════════════════════════════════════════════
//
// "+ Add to replace…" flow — opens a TALL picker listing every mesh /
// flatShape currently loaded (filtered: not archived, not the RM, not
// inside the RM, not an RM child, not scene root). User picks origin B;
// a second modal asks "Archive and replace / Copy and replace / Cancel".
// Confirm runs actions.addToReplaceModel.

// ═══════════════════════════════════════════════════════════════════════════
//  RM CHILD HELPERS  (B.2-NEW.3)
// ═══════════════════════════════════════════════════════════════════════════
//
// RM children (copies inside a Replace-Model) have a tight 2-option
// context menu per the user's spec. These helpers detect them and run
// the two actions.

// Tree.js uses actions.findReplaceModelAncestor (exported from actions.js
// alongside the remove + global-transform actions) — single source of
// truth for the ancestor-walk logic, no duplicate helper here.

/**
 * Confirm dialog → actions.removeFromReplaceModel.
 * If origin (sourceNodeId) is archived, offer to un-archive it after
 * removal.
 */
function _confirmRemoveFromReplaceModel(node) {
  if (!node) return;
  const root     = state.get('treeData');
  const nodeById = state.get('nodeById');
  const originId = node.sourceNodeId;
  const origin   = originId ? nodeById?.get(originId) : null;
  const originArchived = origin?.archived === true;

  const lines = [
    `Remove "${node.name || 'copy'}" from its Replace-Model?`,
    '',
    'The copy will be deleted from the scene and the tree.',
  ];
  if (originArchived) {
    lines.push('', 'The original object is currently archived. You will be asked whether to un-archive it after removal.');
  }
  const ok = window.confirm(lines.join('\n'));
  if (!ok) return;

  let unarchiveOrigin = false;
  if (originArchived) {
    unarchiveOrigin = window.confirm(`Un-archive the original "${origin?.name || 'object'}" now?`);
  }
  actions.removeFromReplaceModel(node.id, { unarchiveOrigin });
}

/**
 * Numeric dialog for global transform on an RM child. Translate deltas
 * (X/Y/Z), rotate deltas (Euler XYZ degrees), uniform scale multiplier.
 * Apply → bakes into the child's baseLocal* fields (relative to its
 * wrap-group parent) and pushes a single undo entry. Gizmo is not used
 * here — RM children are not transform nodes globally, so a dialog
 * keeps the surface area small.
 */
export function showRMChildGlobalTransformDialog(nodeId) {
  const nodeById = state.get('nodeById');
  const node     = nodeById?.get(nodeId);
  if (!node) return;

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">Global transform — ${_esc(node.name || 'copy')}</div>
      <p class="small" style="margin:6px 0 12px;color:#94a3b8">
        Transform applies globally (all steps), relative to the
        Replace-Model. Translate / rotate in the wrap-group's local frame.
      </p>
      <div style="display:grid;grid-template-columns:auto 1fr 1fr 1fr;gap:8px;align-items:center">
        <div style="color:#94a3b8">Translate (Δ)</div>
        <input type="number" id="rgt-tx" step="0.01" value="0" />
        <input type="number" id="rgt-ty" step="0.01" value="0" />
        <input type="number" id="rgt-tz" step="0.01" value="0" />

        <div style="color:#94a3b8">Rotate (Δ°)</div>
        <input type="number" id="rgt-rx" step="1" value="0" />
        <input type="number" id="rgt-ry" step="1" value="0" />
        <input type="number" id="rgt-rz" step="1" value="0" />

        <div style="color:#94a3b8">Scale (×)</div>
        <input type="number" id="rgt-sx" step="0.1" value="1" />
        <input type="number" id="rgt-sy" step="0.1" value="1" />
        <input type="number" id="rgt-sz" step="0.1" value="1" />
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="btn" id="rgt-cancel">Cancel</button>
        <button class="btn" id="rgt-accept">Apply</button>
      </div>
    </div>
  `;

  const get = (id) => parseFloat(dlg.querySelector(id).value) || 0;
  dlg.querySelector('#rgt-cancel').addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.querySelector('#rgt-accept').addEventListener('click', () => {
    const params = {
      dx: get('#rgt-tx'), dy: get('#rgt-ty'), dz: get('#rgt-tz'),
      rx: get('#rgt-rx'), ry: get('#rgt-ry'), rz: get('#rgt-rz'),
      sx: parseFloat(dlg.querySelector('#rgt-sx').value) || 1,
      sy: parseFloat(dlg.querySelector('#rgt-sy').value) || 1,
      sz: parseFloat(dlg.querySelector('#rgt-sz').value) || 1,
    };
    dlg.close(); dlg.remove();
    actions.applyRMChildGlobalTransform(nodeId, params);
  });
  dlg.addEventListener('cancel', () => { dlg.remove(); });
  document.body.appendChild(dlg);
  dlg.showModal();
}


/**
 * Open the picker for adding a new child to a Replace-Model. `rmId`
 * is the RM the user r-clicked. Picker is taller than the old V0.1.55
 * dialog (size=14 rows) per the user's request.
 */
export function showAddToReplaceDialog(rmId) {
  const root     = state.get('treeData');
  const nodeById = state.get('nodeById');
  const rmNode   = nodeById?.get(rmId);
  if (!root || !rmNode || rmNode.type !== 'replaceModel') return;

  const candidates = _collectAddToReplaceCandidates(root, rmId);
  if (!candidates.length) {
    setStatus('No mesh or flatShape available to use as a replacement.', 'warning');
    return;
  }

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">Add to Replace-Model</div>
      <p class="small" style="margin:6px 0 12px;color:#94a3b8">
        Pick the object to ADD as a replacement inside
        <b>${_esc(rmNode.name || '(unnamed)')}</b>. A copy of it will be
        parented to the RM at its current world pose. Origin can be left
        in place or archived in the next step.
      </p>
      <label class="colorlab">Replacement source
        <select id="atr-sel" size="18" style="margin-top:6px;min-width:380px;height:auto;min-height:360px;padding:6px">
          ${candidates.map(o =>
            `<option value="${_esc(o.id)}">${_esc(o.label)}</option>`
          ).join('')}
        </select>
      </label>
      <div style="display:flex;gap:8px;justify-content:space-between;margin-top:16px">
        <button class="btn" id="atr-pick-viewport" title="Click an object in the viewport to use it as the replacement source">🎯 Pick from viewport…</button>
        <div style="display:flex;gap:8px">
          <button class="btn" id="atr-cancel">Cancel</button>
          <button class="btn" id="atr-accept">Next…</button>
        </div>
      </div>
    </div>
  `;

  const sel          = dlg.querySelector('#atr-sel');
  const accept       = dlg.querySelector('#atr-accept');
  const cancel       = dlg.querySelector('#atr-cancel');
  const pickViewport = dlg.querySelector('#atr-pick-viewport');

  if (sel.options.length > 0) sel.selectedIndex = 0;
  sel.addEventListener('dblclick', () => accept.click());
  cancel.addEventListener('click', () => { dlg.close(); dlg.remove(); });

  accept.addEventListener('click', () => {
    const sourceBId = sel.value;
    if (!sourceBId) return;
    const sName = nodeById.get(sourceBId)?.name || 'object';
    dlg.close(); dlg.remove();
    showReplaceModeDialog(rmId, sourceBId, sName);
  });

  // Physical viewport picker — closes the dialog and arms a one-shot
  // state flag (state.replaceModelPickingForId). main.js's viewport
  // click handler intercepts the next click and re-opens the mode
  // dialog with the picked node. Esc cancels.
  pickViewport.addEventListener('click', () => {
    dlg.close(); dlg.remove();
    state.setState({ replaceModelPickingForId: rmId });
    setStatus('Click a mesh or flat-shape in the viewport to use as replacement source (Esc to cancel).');
  });

  dlg.addEventListener('cancel', () => { dlg.remove(); });
  document.body.appendChild(dlg);
  dlg.showModal();
}

/**
 * 3-option modal after the user has picked their replacement source.
 * Calls actions.addToReplaceModel with the chosen mode.
 */
export function showReplaceModeDialog(rmId, sourceBId, sourceName) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">Add "${_esc(sourceName)}" — pick mode</div>
      <p class="small" style="margin:6px 0 14px;color:#94a3b8">
        A fresh COPY of <b>${_esc(sourceName)}</b> (its origin geometry)
        will be parented to the Replace-Model at its current world pose.
        The original geometry of the RM gets hidden automatically.
      </p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" id="atr-mode-archive" style="text-align:left;padding:10px 12px">
          <b>🗃️ Archive and replace</b><br>
          <span class="small" style="color:#94a3b8">
            Archive the source in the scene (locked-hidden). The RM
            shows only the copy. Recommended when you're swapping
            parts permanently.
          </span>
        </button>
        <button class="btn" id="atr-mode-copy" style="text-align:left;padding:10px 12px">
          <b>📋 Copy and replace</b><br>
          <span class="small" style="color:#94a3b8">
            Leave the source visible in the scene. The RM still gets a
            copy. Useful when you want to reuse the same shape in
            multiple RMs.
          </span>
        </button>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="btn" id="atr-mode-cancel">Cancel</button>
      </div>
    </div>
  `;

  const btnArchive = dlg.querySelector('#atr-mode-archive');
  const btnCopy    = dlg.querySelector('#atr-mode-copy');
  const btnCancel  = dlg.querySelector('#atr-mode-cancel');

  const run = (mode) => {
    dlg.close(); dlg.remove();
    const ok = actions.addToReplaceModel(rmId, sourceBId, mode);
    if (ok) {
      setStatus(`Added "${sourceName}" to Replace-Model (${mode === 'archiveAndReplace' ? 'archived source' : 'kept source'}).`);
    } else {
      setStatus('Add to Replace-Model failed.', 'warning');
    }
  };

  btnArchive.addEventListener('click', () => run('archiveAndReplace'));
  btnCopy   .addEventListener('click', () => run('copyAndReplace'));
  btnCancel .addEventListener('click', () => { dlg.close(); dlg.remove(); });

  dlg.addEventListener('cancel', () => { dlg.remove(); });
  document.body.appendChild(dlg);
  dlg.showModal();
}

/**
 * Walk the tree and collect every node that's a valid REPLACEMENT
 * source for an RM. Includes:
 *   - mesh or flatShape only (B.2-NEW.2 v1 limit — model deferred)
 *   - not archived
 *   - not the RM itself
 *   - not an ancestor or descendant of the RM
 *   - not a child of any RM (already-cloned copies are skipped; the
 *     user picks the ORIGIN of B, never a copy)
 *   - not the scene root or a note
 */
function _collectAddToReplaceCandidates(root, rmId) {
  const ancestors = new Set();
  (function findAncestors(node, target, path) {
    if (node.id === target) { for (const a of path) ancestors.add(a.id); return true; }
    for (const c of (node.children || [])) {
      if (findAncestors(c, target, [...path, node])) return true;
    }
    return false;
  })(root, rmId, []);

  const descendants = new Set();
  const rmNode = findNode(root, rmId);
  if (rmNode) {
    (function collect(n) {
      for (const c of (n.children || [])) { descendants.add(c.id); collect(c); }
    })(rmNode);
  }

  const items = [];
  function walk(node, depth, insideRM) {
    if (!node) return;
    const id = node.id;
    const isRM = node.type === 'replaceModel';
    const skip =
         id === rmId
      || ancestors.has(id)
      || descendants.has(id)
      || node.type === 'scene'
      || node.type === 'note'
      || node.archived === true
      || insideRM                                   // skip RM children (copies)
      || !(node.type === 'mesh' || node.type === 'flatShape')
      || !steps.object3dById?.get(id);

    if (!skip) {
      const icon = node.type === 'mesh' ? '◼' : '▰';
      items.push({
        id,
        label: `${'  '.repeat(depth)}${icon} ${node.name || '(unnamed)'} [${node.type}]`,
      });
    }
    // Descend — children of an RM are flagged so they get skipped.
    for (const c of (node.children || [])) walk(c, depth + 1, insideRM || isRM);
  }
  walk(root, 0, false);
  return items;
}


// ── Drag and Drop ─────────────────────────────────────────────────────────────

/**
 * Update drop-target highlight WITHOUT rebuilding the tree DOM.
 * Calling renderTree() during a drag destroys the dragged element
 * and cancels the operation — so we only touch CSS classes here.
 */
function _updateDropHighlight(nodeId) {
  if (!_container) return;
  _container.querySelectorAll('.tree-row.dropTarget')
    .forEach(el => el.classList.remove('dropTarget'));
  if (nodeId) {
    const el = _container.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`);
    if (el) el.classList.add('dropTarget');
  }
}

function _onDragStart(e, node) {
  // Archived nodes are READ-ONLY — refuse to start a drag from one of
  // them. The user must unarchive first to reposition.
  if (node.archived) {
    e.preventDefault();
    return;
  }
  // IMPORTANT: Do NOT call state.setSelection here — it triggers renderTree()
  // which destroys the dragged DOM element and cancels the drag.
  const multiIds = state.get('multiSelectedIds') || new Set();
  let ids = multiIds.has(node.id) ? Array.from(multiIds) : [node.id];
  // If the user is dragging a multi-selection that happens to include an
  // archived node, strip it from the drag payload so the rest of the
  // group can still move while the archived node stays put.
  const nodeById = state.get('nodeById');
  if (nodeById) ids = ids.filter(id => nodeById.get(id)?.archived !== true);
  if (!ids.length) {
    e.preventDefault();
    return;
  }
  _dragIds    = ids;
  _isDragging = true;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', JSON.stringify(_dragIds));
}

function _onDragEnd() {
  _isDragging = false;
  _dragIds    = [];
  _dropTarget = null;
  renderTree();
}

function _onDragOver(e, node) {
  // Block drops on leaf nodes (real meshes + flat shapes + notes) — they
  // have no .children to receive moved items. Archived containers are
  // also blocked: their tree shape is frozen and can't accept new items
  // until the user unarchives them.
  if (!_isDragging || (node.type === 'mesh' && !node.missing) ||
      node.type === 'flatShape' || node.type === 'note' ||
      node.archived) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_dropTarget !== node.id) {
    _dropTarget = node.id;
    _updateDropHighlight(node.id);   // NO renderTree — just toggle a class
  }
}

function _onDragLeave(e, node) {
  if (_dropTarget !== node.id) return;
  // relatedTarget is where the pointer is going — if it's still inside this
  // row (moving between child spans), ignore the leave.
  const row = e.currentTarget;
  if (row.contains(e.relatedTarget)) return;
  _dropTarget = null;
  _updateDropHighlight(null);        // NO renderTree
}

function _onDrop(e, targetNode) {
  e.preventDefault();
  _dropTarget = null;

  if ((targetNode.type === 'mesh' && !targetNode.missing) ||
      targetNode.type === 'flatShape' || targetNode.type === 'note') {
    renderTree(); return;
  }

  const ids = _dragIds.filter(id => id !== targetNode.id);
  if (!ids.length) { setStatus('Cannot drop here.'); renderTree(); return; }

  _moveIdsIntoNode(ids, targetNode);
}


// ── Input dialog helper ───────────────────────────────────────────────────────

/**
 * Show a small modal dialog with a single text input.
 * @param {string}   title      - Dialog heading
 * @param {string}   defaultVal - Pre-filled value
 * @param {Function} onConfirm  - Called with trimmed string on confirm (skipped if empty)
 */
export function showInputDialog(title, defaultVal, onConfirm) {
  return _showInputDialog(title, defaultVal, onConfirm);
}

/**
 * Insertion-animation settings dialog (V0.2.22.57). Collects spacing,
 * reposition time, the spec-name tag + its size, and the trajectory
 * line. onConfirm receives the full patch object.
 */
export async function showInsertAnimDialog(cur, onConfirm) {
  const c = cur || {};
  // Effective defaults to show when a row is set to "use default".
  let def = { distance: 20, repositionMs: 300, tagName: false, tagSize: 'medium',
              tagColor: '#ffffff', explodeBefore: false, pauseBefore: true, pauseBeforeMs: 300,
              trajectory: false, lineThickness: 0.5, lineGap: 2, lineColor: '#ffaa00' };
  try { def = (await import('../systems/hardware-defaults.js')).getEffectiveDefaults(); } catch {}

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  // null in `cur` = "use default" (checkbox ticked). A value = custom.
  const ud = (k) => c[k] == null;                        // use-default?
  const val = (k) => (c[k] == null ? def[k] : c[k]);     // shown value
  const sz = val('tagSize') || 'medium';
  dlg.innerHTML = `
    <div class="sbs-dialog__body" style="min-width:320px;">
      <div class="sbs-dialog__title">Insertion animation</div>
      <div class="small muted" style="margin-top:4px;font-size:11px;">
        Tick "default" to inherit the project / system value (Settings → Nuts).
      </div>

      ${_iaRow('x',   'Spacing X (mm)',           `<input type="number" id="_ia-x"  value="${_esc(String(val('distance')))}"     min="1"    step="1"   class="_ia-in" />`, ud('distance'))}
      ${_iaRow('ms',  'Reposition pre-step (ms)', `<input type="number" id="_ia-ms" value="${_esc(String(val('repositionMs')))}" min="0"    step="10"  class="_ia-in" />`, ud('repositionMs'))}

      ${_iaRow('tag', 'Name tag',
        `<label class="small"><input type="checkbox" id="_ia-tag" ${val('tagName') ? 'checked' : ''}/> show</label>
         <select id="_ia-size" style="margin-left:8px;">
           <option value="small"  ${sz==='small' ?'selected':''}>Small</option>
           <option value="medium" ${sz==='medium'?'selected':''}>Medium</option>
           <option value="large"  ${sz==='large' ?'selected':''}>Large</option>
         </select>
         <input type="color" id="_ia-tagcolor" value="${_esc(val('tagColor') || '#ffffff')}" title="text colour" style="width:34px;height:24px;margin-left:6px;padding:1px;vertical-align:middle;" />`,
        ud('tagName'))}
      <div class="small muted" style="margin:2px 0 0 26px;font-size:10px;opacity:0.7;">Sizes use your Note size settings.</div>

      ${_iaRow('explode', 'Display exploded before insertion',
        `<label class="small"><input type="checkbox" id="_ia-explode" ${val('explodeBefore') ? 'checked' : ''}/> show the nut exploded on every step before it's inserted</label>`,
        ud('explodeBefore'))}

      ${_iaRow('pause', 'Pause before insertion',
        `<label class="small"><input type="checkbox" id="_ia-pause" ${val('pauseBefore') ? 'checked' : ''}/> hold</label>
         <input type="number" id="_ia-pausems" value="${_esc(String(val('pauseBeforeMs')))}" min="0" step="50" title="pause (ms)" style="width:96px;margin-left:8px;" /> ms`,
        ud('pauseBefore'))}
      <div class="small muted" style="margin:2px 0 0 26px;font-size:10px;opacity:0.7;">Holds on the exploded nut so the tags are readable, then inserts.</div>

      ${_iaRow('traj', 'Trajectory line',
        `<label class="small"><input type="checkbox" id="_ia-traj" ${val('trajectory') ? 'checked' : ''}/> show</label>
         <input type="number" id="_ia-thick" value="${_esc(String(val('lineThickness')))}" min="0.05" step="0.05" title="thickness (mm)" style="width:56px;margin-left:8px;" />
         <input type="number" id="_ia-gap" value="${_esc(String(val('lineGap')))}" min="0" step="0.25" title="gap scale (gap = thickness × this)" style="width:50px;margin-left:6px;" />
         <input type="color" id="_ia-color" value="${_esc(val('lineColor') || '#ffaa00')}" style="width:34px;height:24px;margin-left:6px;padding:1px;vertical-align:middle;" />`, ud('trajectory'))}

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="btn" id="_ia-cancel">Cancel</button>
        <button class="btn primary" id="_ia-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  // Enable/disable each row's custom controls per its "default" checkbox.
  const sync = () => {
    for (const key of ['x', 'ms', 'tag', 'explode', 'pause', 'traj']) {
      const dflt = dlg.querySelector(`#_ia-def-${key}`).checked;
      dlg.querySelectorAll(`[data-ia-grp="${key}"] input, [data-ia-grp="${key}"] select`)
        .forEach(el => { el.disabled = dflt; el.style.opacity = dflt ? 0.45 : 1; });
    }
  };
  for (const key of ['x', 'ms', 'tag', 'explode', 'pause', 'traj']) {
    dlg.querySelector(`#_ia-def-${key}`).addEventListener('change', sync);
  }
  sync();

  const done = () => {
    const useDef = (k) => dlg.querySelector(`#_ia-def-${k}`).checked;
    const patch = {
      distance:     useDef('x')   ? null : Number(dlg.querySelector('#_ia-x').value),
      repositionMs: useDef('ms')  ? null : Number(dlg.querySelector('#_ia-ms').value),
      tagName:      useDef('tag') ? null : dlg.querySelector('#_ia-tag').checked,
      tagSize:      useDef('tag') ? null : dlg.querySelector('#_ia-size').value,
      tagColor:     useDef('tag')     ? null : dlg.querySelector('#_ia-tagcolor').value,
      explodeBefore:useDef('explode') ? null : dlg.querySelector('#_ia-explode').checked,
      pauseBefore:  useDef('pause')   ? null : dlg.querySelector('#_ia-pause').checked,
      pauseBeforeMs:useDef('pause')   ? null : Number(dlg.querySelector('#_ia-pausems').value),
      trajectory:   useDef('traj')    ? null : dlg.querySelector('#_ia-traj').checked,
      lineThickness:useDef('traj')? null : Number(dlg.querySelector('#_ia-thick').value),
      lineGap:      useDef('traj')? null : Number(dlg.querySelector('#_ia-gap').value),
      lineColor:    useDef('traj')? null : dlg.querySelector('#_ia-color').value,
    };
    dlg.close(); dlg.remove();
    onConfirm(patch);
  };
  dlg.querySelector('#_ia-cancel').addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.querySelector('#_ia-ok').addEventListener('click', done);
  dlg.addEventListener('keydown', e => { if (e.key === 'Escape') { dlg.close(); dlg.remove(); } });
  dlg.showModal();
}

/** One labelled row with a "default" checkbox + custom control group. */
function _iaRow(key, label, controlHtml, useDefault) {
  return `
    <div style="margin-top:10px;">
      <div class="small" style="margin-bottom:3px;font-weight:600;">${_esc(label)}</div>
      <label class="small muted" style="margin-right:10px;cursor:pointer;">
        <input type="checkbox" id="_ia-def-${key}" ${useDefault ? 'checked' : ''}/> default
      </label>
      <span data-ia-grp="${key}">${controlHtml}</span>
    </div>`;
}

/**
 * Two-field numeric dialog (V0.2.22.54) — used by "Adjust insertion
 * animation". onConfirm receives { a, b } as numbers (NaN if blank).
 */
export function showTwoFieldDialog(title, fieldA, valA, fieldB, valB, onConfirm) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">${_esc(title)}</div>
      <label class="small muted" style="display:block;margin-top:10px;">${_esc(fieldA)}
        <input type="number" id="_tfd-a" value="${_esc(String(valA))}" step="1" min="0"
          style="margin-top:3px;width:100%;box-sizing:border-box" />
      </label>
      <label class="small muted" style="display:block;margin-top:10px;">${_esc(fieldB)}
        <input type="number" id="_tfd-b" value="${_esc(String(valB))}" step="10" min="0"
          style="margin-top:3px;width:100%;box-sizing:border-box" />
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="btn" id="_tfd-cancel">Cancel</button>
        <button class="btn primary" id="_tfd-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);
  const inA = dlg.querySelector('#_tfd-a');
  const inB = dlg.querySelector('#_tfd-b');
  const done = () => {
    const a = Number(inA.value), b = Number(inB.value);
    dlg.close(); dlg.remove();
    onConfirm({ a, b });
  };
  dlg.querySelector('#_tfd-cancel').addEventListener('click', () => { dlg.close(); dlg.remove(); });
  dlg.querySelector('#_tfd-ok').addEventListener('click', done);
  dlg.addEventListener('keydown', e => {
    if (e.key === 'Enter') done();
    if (e.key === 'Escape') { dlg.close(); dlg.remove(); }
  });
  dlg.showModal();
  requestAnimationFrame(() => inA.select());
}

function _showInputDialog(title, defaultVal, onConfirm) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">${_esc(title)}</div>
      <input type="text" id="_sid-input" value="${_esc(defaultVal)}"
        style="margin-top:10px;width:100%;box-sizing:border-box" />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button class="btn" id="_sid-cancel">Cancel</button>
        <button class="btn" id="_sid-ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  const input  = dlg.querySelector('#_sid-input');
  const cancel = dlg.querySelector('#_sid-cancel');
  const ok     = dlg.querySelector('#_sid-ok');

  const confirm = () => {
    const val = input.value.trim();
    dlg.close(); dlg.remove();
    if (val) onConfirm(val);
  };

  cancel.addEventListener('click', () => { dlg.close(); dlg.remove(); });
  ok.addEventListener('click', confirm);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') { dlg.close(); dlg.remove(); }
  });

  dlg.showModal();
  // Select all text so user can type immediately
  requestAnimationFrame(() => { input.select(); });
}


/**
 * Tight, dedicated context menu for a NOTE row.
 *
 *   👁 Show / 🚫 Hide
 *   Edit Text…
 *   ↺ Reposition Note…
 *   Delete Note  (asks for confirmation)
 *   ─
 *   ● Size: Small / Medium / Large  (current choice greyed-out)
 *
 * Same payload is reused in notes-render.js for the balloon's
 * right-click menu so the two surfaces stay in lockstep.
 */
function _buildNoteContextMenuItems(node) {
  const isVisible = node.localVisible !== false;
  // Resolve content source for label display + edit redirection.
  // Linked → template owns text + name; standalone → instance's own.
  const tplList = state.get('noteTemplates') || [];
  const tpl     = node.templateId ? tplList.find(t => t.id === node.templateId) : null;
  const editing = tpl
    ? { srcText: tpl.text, label: tpl.name || '(linked template)' }
    : { srcText: node.text, label: (node.text || '').replace(/\s+/g, ' ').trim() };
  const sizeDisabled = !!tpl;
  return [
    {
      label:  isVisible ? `🚫 Hide note` : `👁 Show note`,
      action: () => actions.toggleVisibility([node.id]),
    },
    {
      label:  tpl ? `✏ Edit Template Text… (${tpl.name || 'template'})` : '✏ Edit Text…',
      action: () => _showInputDialog(
        tpl ? `Edit template "${tpl.name || ''}"` : 'Edit note text',
        editing.srcText || '',
        text => {
          if (tpl) actions.updateNoteTemplateText?.(tpl.id, text);
          else     actions.editNoteText(node.id, text);
        },
      ),
    },
    {
      label:  '↺ Reposition Note…',
      action: () => actions.startNoteRepositioning(node.id),
    },
    {
      label:  '🗑 Delete Note',
      action: () => {
        const short = editing.label
          ? (editing.label.length > 40 ? editing.label.slice(0, 40) + '…' : editing.label)
          : '(empty note)';
        showConfirmDialog(
          'Delete note?',
          `This will remove the note "${short}". You can undo with Ctrl+Z.`,
          () => actions.deleteNote(node.id),
        );
      },
    },
    { separator: true },
    {
      label:    '● Size: Small',
      action:   () => actions.setNoteSizePreset(node.id, 'small'),
      disabled: sizeDisabled || (node.sizePresetId === 'small'  && node.customFontSize === null),
    },
    {
      label:    '● Size: Medium',
      action:   () => actions.setNoteSizePreset(node.id, 'medium'),
      disabled: sizeDisabled || (node.sizePresetId === 'medium' && node.customFontSize === null),
    },
    {
      label:    '● Size: Large',
      action:   () => actions.setNoteSizePreset(node.id, 'large'),
      disabled: sizeDisabled || (node.sizePresetId === 'large'  && node.customFontSize === null),
    },
  ];
}

// ── Tree helpers ──────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
