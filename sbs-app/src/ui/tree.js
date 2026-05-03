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
import {
  findNode,
  findParent,
  collectDescendantIds,
  buildNodeMap,
}                               from '../core/nodes.js';
import {
  isTransformNode,
  applyAllTransforms,
  applyAllVisibility,
  applyNodeTransformToObject3D,
  isNearZero,
  isIdentityQuaternion,
}                               from '../core/transforms.js';
import { generateId }           from '../core/schema.js';
import { setStatus }            from './status.js';
import { showContextMenu, hideContextMenu } from './context-menu.js';

// ── State ────────────────────────────────────────────────────────────────────

// _intentional: nodes the user explicitly clicked open (persist until collapsed)
// _expanded:    superset — includes _intentional + auto-expanded ancestors of selection
const _intentional = new Set(['scene_root']);
const _expanded    = new Set(['scene_root']);

let _container  = null;
let _dragIds    = [];
let _dropTarget = null;
let _isDragging = false;


// ── Init ─────────────────────────────────────────────────────────────────────

export function initTree(containerEl) {
  _container = containerEl;
  if (!_container) return;

  state.on('change:treeData', () => { _syncExpanded(); renderTree(); });
  state.on('selection:change', () => { _syncExpanded(); renderTree(); });
  state.on('change:activeStepId', () => renderTree());
  // step:applied fires AFTER applyVisibilitySnapshot has mutated each
  // node.localVisible. change:activeStepId above fires too early — at
  // that point the per-node localVisible flags are still from the
  // previous step, so the eye icons would show stale visibility for the
  // duration of the animation (or forever, on instant apply).
  state.on('step:applied', () => renderTree());
  // P-P1: pivot button color reflects active edit. Re-render when the
  // edit session opens / closes so the button repaints in real time.
  state.on('change:pivotEditNodeId', () => renderTree());

  renderTree();
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

  if ((node.children?.length ?? 0) > 0 && _expanded.has(node.id)) {
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
  row.draggable = node.type !== 'scene';

  // Twisty
  const twisty = document.createElement('span');
  twisty.className   = 'twisty';
  twisty.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : '';
  twisty.addEventListener('click', e => {
    e.stopPropagation();
    if (!hasChildren) return;
    if (isExpanded) {
      _expanded.delete(node.id);
      _intentional.delete(node.id);
    } else {
      _expanded.add(node.id);
      _intentional.add(node.id);   // user explicitly opened — remember it
    }
    renderTree();
  });

  // Icon
  const icon = document.createElement('span');
  icon.className   = 'icon';
  icon.textContent = _typeIcon(node.type);

  // Label — notes show their (truncated) text instead of name
  const label = document.createElement('span');
  label.className   = 'label';
  if (node.type === 'note') {
    const t = (node.text || '').replace(/\s+/g, ' ').trim();
    label.textContent = t ? (t.length > 40 ? t.slice(0, 40) + '…' : t) : '(empty note)';
    label.style.fontStyle = 'italic';
  } else {
    label.textContent = node.name || '(unnamed)';
  }

  // Transform buttons (model / folder only)
  const transformGroup = document.createElement('span');
  transformGroup.style.display = isTransformNode(node) ? 'inline-flex' : 'none';
  transformGroup.style.gap = '1px';
  if (isTransformNode(node)) {
    transformGroup.append(
      _mkTransformBtn('✥', 'Move',   'moveEnabled',   node),
      // Pivot only on folders — the root model node carries the
      // imported asset's reference frame and shouldn't have its pivot
      // relocated (the user can't visually verify what that means).
      ...(node.type === 'folder' ? [_mkPivotBtn(node)] : []),
      _mkTransformBtn('⟳', 'Rotate', 'rotateEnabled', node),
    );
  }

  // Eye
  const eye = document.createElement('button');
  eye.className   = 'eye';
  eye.textContent = node.localVisible ? '👁' : '🚫';
  eye.title       = node.localVisible ? 'Visible' : 'Hidden';
  eye.addEventListener('click', e => { e.stopPropagation(); _toggleVisibility(node); });

  row.append(twisty, icon, label, transformGroup, eye);

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
    case 'scene':  return '🌐';
    case 'model':  return '🧩';
    case 'folder': return '🗂';
    case 'mesh':   return '◼';
    case 'note':   return '💬';
    default:       return '📄';
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

function _onRowClick(e, node) {
  e.stopPropagation();
  hideContextMenu();
  const multiIds = new Set(state.get('multiSelectedIds') || []);
  if (e.ctrlKey || e.metaKey) {
    if (multiIds.has(node.id)) multiIds.delete(node.id);
    else                        multiIds.add(node.id);
    actions.setSelection(node.id, multiIds);
  } else {
    actions.setSelection(node.id, new Set([node.id]));
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
  const items    = [];
  const root     = state.get('treeData');
  const nodeById = state.get('nodeById');
  const multiIds = state.get('multiSelectedIds') || new Set();
  // Nodes the action applies to (all selected if node is in selection, else just node)
  const targetIds = multiIds.has(node.id) && multiIds.size > 1
    ? Array.from(multiIds)
    : [node.id];
  const count    = targetIds.length;
  const label    = count > 1 ? `${count} items` : `"${(node.name || '').slice(0, 24)}"`;

  if (node.missing) {
    items.push({ label: '⚠️ Missing asset — placeholder active', disabled: true });
  }

  // ── Visibility ──────────────────────────────────────────────────────────────
  const allVisible = targetIds.every(id => nodeById?.get(id)?.localVisible !== false);
  items.push({
    label: allVisible ? `Hide ${label}` : `Show ${label}`,
    action: () => actions.toggleVisibility(targetIds),
  });

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

  // ── Isolate ─────────────────────────────────────────────────────────────────
  items.push({
    label: 'Isolate',
    action: () => _isolateNodes(new Set(targetIds)),
  });

  // ── Fit To ──────────────────────────────────────────────────────────────────
  items.push({
    label: 'Fit To',
    action: () => _fitToNodes(new Set(targetIds)),
  });

  items.push({ separator: true });

  // ── Navigate ────────────────────────────────────────────────────────────────
  const parent = root ? findParent(root, node.id) : null;
  items.push({
    label: 'Select Parent',
    disabled: !parent || parent.type === 'scene',
    action: () => parent && state.setSelection(parent.id, new Set([parent.id])),
  });

  items.push({
    label: 'Select Children',
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
      label: 'New Folder Inside',
      action: () => _createFolderInside(node),
    });
  }

  if (node.type === 'folder' || node.type === 'model' || node.type === 'scene') {
    const otherSelected = targetIds.filter(id => id !== node.id);
    if (otherSelected.length > 0 || (multiIds.size > 0 && !multiIds.has(node.id))) {
      items.push({
        label: `Move Selected Here`,
        action: () => _moveIdsIntoNode(Array.from(multiIds).filter(id => id !== node.id), node),
      });
    }
  }

  if (isContainer && (node.children?.length ?? 0) > 0) {
    items.push({
      label: 'Collapse',
      action: () => _collapseSubtree(node),
    });
  }

  // ── Transform ────────────────────────────────────────────────────────────────
  if (isTransformNode(node)) {
    items.push({ separator: true });
    items.push({
      label: 'Reset Move',
      action: () => targetIds.filter(id => isTransformNode(nodeById?.get(id))).forEach(id => actions.resetTransformField(id, 'move')),
    });
    items.push({
      label: 'Reset Rotation',
      action: () => targetIds.filter(id => isTransformNode(nodeById?.get(id))).forEach(id => actions.resetTransformField(id, 'rotate')),
    });
    items.push({
      label: 'Reset All Transforms',
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
      label: 'Copy Pivot',
      disabled: !hasBluePivot,
      action: () => actions.copyPivot(node.id),
    });
    items.push({
      label: 'Paste Pivot',
      disabled: !actions.hasPivotClipboard(),
      action: () => actions.pastePivot(node.id),
    });
    items.push({
      label: 'Snap Pivot to Surface…',
      action: () => actions.startPivotSnapPicking(node.id),
    });
    items.push({
      label: 'Pivot Center via 3 Points…',
      action: () => actions.startPivotCenterPicking(node.id),
    });
  }

  items.push({ separator: true });

  // ── Note-row specific actions ────────────────────────────────────────────────
  if (node.type === 'note') {
    items.push({
      label: 'Edit Text…',
      action: () => _showInputDialog('Edit note text', node.text || '', text => {
        actions.editNoteText(node.id, text);
      }),
    });
    items.push({
      label: 'Delete Note',
      action: () => actions.deleteNote(node.id),
    });
    items.push({ separator: true });
    items.push({
      label: '— Size: Small',
      action: () => actions.setNoteSizePreset(node.id, 'small'),
      disabled: node.sizePresetId === 'small' && node.customFontSize === null,
    });
    items.push({
      label: '— Size: Medium',
      action: () => actions.setNoteSizePreset(node.id, 'medium'),
      disabled: node.sizePresetId === 'medium' && node.customFontSize === null,
    });
    items.push({
      label: '— Size: Large',
      action: () => actions.setNoteSizePreset(node.id, 'large'),
      disabled: node.sizePresetId === 'large' && node.customFontSize === null,
    });
    items.push({ separator: true });
  }

  // ── General ──────────────────────────────────────────────────────────────────
  if (node.type !== 'scene' && node.type !== 'note') {
    items.push({
      label: `Rename "${(node.name || '').slice(0, 24)}"`,
      action: () => _showInputDialog('Rename', node.name || '', name => {
        node.name = name;
        if (node.object3d) node.object3d.name = name;
        state.emit('change:treeData', state.get('treeData'));
        steps.scheduleTransformSync();
      }),
    });
  }

  if (node.type !== 'scene') {
    items.push({
      label: count > 1 ? `Move ${count} items to Folder…` : 'Move to Folder…',
      action: () => showMoveToFolderDialog(targetIds),
    });
  }

  // ── Delete folder ────────────────────────────────────────────────────────────
  if (node.type === 'folder') {
    const childCount = (node.children || []).length;
    if (childCount === 0) {
      items.push({
        label: 'Delete Empty Folder',
        action: () => _deleteEmptyFolder(node),
      });
    } else {
      items.push({
        label: `Delete Folder (contains ${childCount} item${childCount > 1 ? 's' : ''} — empty first)`,
        disabled: true,
      });
    }
  }

  return items;
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
    const THREE = window.THREE;
    if (!THREE) return;

    const group = new THREE.Group();
    group.name  = name;
    group.userData.isCustomFolder = true;

    const folderNode = {
      id: generateId('folder'), name, type: 'folder',
      localVisible: true, object3d: group, children: [],
      localOffset: [0,0,0], localQuaternion: [0,0,0,1],
      pivotLocalOffset: [0,0,0], pivotLocalQuaternion: [0,0,0,1],
      baseLocalPosition: [0,0,0], baseLocalQuaternion: [0,0,0,1], baseLocalScale: [1,1,1],
      moveEnabled: true, rotateEnabled: true, pivotEnabled: true,
    };

    parentNode.children.push(folderNode);
    if (parentNode.object3d) parentNode.object3d.add(group);
    steps.object3dById.set(folderNode.id, group);  // register so gizmo can attach

    _expanded.add(parentNode.id);
    _intentional.add(parentNode.id);

    const root   = state.get('treeData');
    const nodeById = buildNodeMap(root);
    state.setState({ nodeById });
    state.setSelection(folderNode.id, new Set([folderNode.id]));
    steps.scheduleTransformSync();
    setStatus(`Created folder "${folderNode.name}".`);
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
  const root   = state.get('treeData');
  const parent = root ? findParent(root, node.id) : null;
  if (!parent) return;

  const idx = parent.children.indexOf(node);
  if (idx >= 0) parent.children.splice(idx, 1);
  if (parent.object3d && node.object3d) parent.object3d.remove(node.object3d);

  _expanded.delete(node.id);
  _intentional.delete(node.id);

  const nodeById = buildNodeMap(root);
  state.setState({ nodeById });
  renderTree();
  steps.scheduleTransformSync();
  setStatus(`Deleted folder "${node.name}".`);
}

function _moveIdsIntoNode(ids, targetNode) {
  if (!ids.length) return;
  const root = state.get('treeData');
  if (!root) return;

  const toMove = [];
  for (const id of ids) {
    if (id === targetNode.id) continue;                    // can't drop onto self
    // Can't drop INTO one of the moved node's own descendants (cycle).
    // Note: we check targetNode against the moved node's subtree — NOT the other
    // way round. Checking targetNode's descendants would wrongly block moving a
    // node UP to any ancestor (e.g. lifting a subfolder back to model root).
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
    if (idx >= 0) {
      const [removed] = parent.children.splice(idx, 1);
      toMove.push(removed);
    }
  }

  if (!toMove.length) { setStatus('Nothing to move.'); return; }

  for (const moved of toMove) {
    targetNode.children.push(moved);

    if (moved.object3d) {
      // Simple remove + add — DO NOT use attach() or storeBaseTransform.
      // baseLocalPosition is the home anchor: set once on load, never changes.
      // The Three.js hierarchy chain handles final world position automatically:
      //   final = baseLocalPos + localOffset + parentFolder.delta + grandparent.delta + …
      // Reparenting just changes which folder deltas are in the chain.
      if (moved.object3d.parent) moved.object3d.parent.remove(moved.object3d);
      if (targetNode.object3d)   targetNode.object3d.add(moved.object3d);
    }
  }

  _expanded.add(targetNode.id);
  _intentional.add(targetNode.id);

  const nodeById = buildNodeMap(root);
  state.setState({ nodeById });
  applyAllTransforms(root, steps.object3dById);
  steps.scheduleTransformSync();
  setStatus(`Moved ${toMove.length} item(s) into "${targetNode.name}".`);
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
  const options = _collectFolderOptions(root, nodeIds);

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">Move to Folder</div>
      <p class="small" style="margin:6px 0 12px;color:#94a3b8">
        Moving ${nodeIds.length} item${nodeIds.length > 1 ? 's' : ''}
      </p>
      <label class="colorlab">Destination
        <select id="mtf-sel" style="margin-top:6px">
          ${options.map(o =>
            `<option value="${_esc(o.id)}">${_esc(o.label)}</option>`
          ).join('')}
          <option value="__new__">＋ Create new folder…</option>
        </select>
      </label>
      <label class="colorlab" style="margin-top:10px">New folder name
        <input type="text" id="mtf-new-name" placeholder="Folder name" style="margin-top:6px" />
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="btn" id="mtf-cancel">Cancel</button>
        <button class="btn" id="mtf-accept">Move here</button>
      </div>
    </div>
  `;

  const sel     = dlg.querySelector('#mtf-sel');
  const input   = dlg.querySelector('#mtf-new-name');
  const accept  = dlg.querySelector('#mtf-accept');
  const cancel  = dlg.querySelector('#mtf-cancel');

  // Greyed-out style for input when dropdown is an existing folder.
  const greyStyle  = () => { input.style.color = '#64748b'; input.style.opacity = '0.6'; };
  const whiteStyle = () => { input.style.color = ''; input.style.opacity = ''; };
  const refresh = () => {
    if (sel.value === '__new__') {
      whiteStyle();
      accept.textContent = 'Create and move here';
    } else {
      greyStyle();
      accept.textContent = 'Move here';
    }
  };
  refresh();   // initial state

  sel.addEventListener('change', refresh);
  // Typing into the (possibly greyed) input snaps to "+ Create new".
  input.addEventListener('input', () => {
    if (sel.value !== '__new__' && input.value.trim()) {
      sel.value = '__new__';
    }
    refresh();
  });
  // Clicking a greyed-out input also flips to "+ Create new".
  input.addEventListener('focus', () => {
    if (sel.value !== '__new__') {
      sel.value = '__new__';
      refresh();
    }
  });

  cancel.addEventListener('click', () => { dlg.close(); dlg.remove(); });

  accept.addEventListener('click', () => {
    if (sel.value === '__new__') {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      // Create folder at scene root, then move selection into it.
      const folderNode = _createFolderAtRoot(name, root);
      if (!folderNode) return;
      dlg.close(); dlg.remove();
      _moveIdsIntoNode(nodeIds, folderNode);
    } else {
      const targetNode = state.get('nodeById')?.get(sel.value) || findNode(root, sel.value);
      if (!targetNode) return;
      dlg.close(); dlg.remove();
      _moveIdsIntoNode(nodeIds, targetNode);
    }
  });

  // Esc on the dialog itself closes (dialog default behaviour).
  dlg.addEventListener('cancel', () => { dlg.remove(); });

  document.body.appendChild(dlg);
  dlg.showModal();
}

function _createFolderAtRoot(name, root) {
  const THREE = window.THREE;
  const group = THREE ? new THREE.Group() : null;
  if (group) { group.name = name; group.userData.isCustomFolder = true; }
  const folderNode = {
    id: generateId('folder'), name, type: 'folder',
    localVisible: true, object3d: group, children: [],
    localOffset: [0,0,0], localQuaternion: [0,0,0,1],
    pivotLocalOffset: [0,0,0], pivotLocalQuaternion: [0,0,0,1],
    baseLocalPosition: [0,0,0], baseLocalQuaternion: [0,0,0,1], baseLocalScale: [1,1,1],
    moveEnabled: true, rotateEnabled: true, pivotEnabled: true,
  };
  root.children.push(folderNode);
  if (root.object3d && group) root.object3d.add(group);
  if (group) steps.object3dById.set(folderNode.id, group);
  state.setState({ nodeById: buildNodeMap(root) });
  return folderNode;
}

/**
 * Build list of valid destination folders for "Move To Folder" dialog.
 * Excludes the nodes being moved and their descendants.
 */
function _collectFolderOptions(root, excludeIds) {
  const excluded = new Set(excludeIds);
  // Also exclude descendants of excluded nodes
  for (const id of excludeIds) {
    const node = findNode(root, id);
    if (node) collectDescendantIds(node)?.forEach(d => excluded.add(d));
  }

  const options = [];

  function walk(node, depth) {
    if (excluded.has(node.id)) return;
    if (node.type === 'scene' || node.type === 'folder' || node.type === 'model') {
      const prefix = depth === 0 ? '' : '  '.repeat(depth - 1) + '  ';
      const icon   = node.type === 'scene' ? '🌐' : node.type === 'model' ? '🧩' : '🗂';
      options.push({ id: node.id, label: `${prefix}${icon} ${node.name || 'Root'}` });
      for (const child of (node.children || [])) walk(child, depth + 1);
    }
  }

  walk(root, 0);
  return options;
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
  // IMPORTANT: Do NOT call state.setSelection here — it triggers renderTree()
  // which destroys the dragged DOM element and cancels the drag.
  const multiIds = state.get('multiSelectedIds') || new Set();
  _dragIds    = multiIds.has(node.id) ? Array.from(multiIds) : [node.id];
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
  if (!_isDragging || (node.type === 'mesh' && !node.missing)) return;
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

  if (targetNode.type === 'mesh' && !targetNode.missing) { renderTree(); return; }

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


// ── Tree helpers ──────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
