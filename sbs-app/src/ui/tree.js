/**
 * SBS Step Browser — Scene Tree Panel
 * ======================================
 * Renders the hierarchical scene tree into a given container element.
 *
 * Features:
 *   - Expand / collapse nodes
 *   - Click to select, Ctrl+Click for multi-select
 *   - Eye button to toggle local visibility
 *   - Transform gizmo state icons (✥ move, ◎ pivot, ⟳ rotate) for model/folder
 *   - Drag-and-drop to reparent nodes
 *   - Right-click context menu
 *   - Double-click folder → select all children
 *   - Subscribes to state changes and re-renders
 */

import { state }                from '../core/state.js';
import { sceneCore }            from '../core/scene.js';
import { steps }                from '../systems/steps.js';
import {
  findNode,
  findParent,
  collectDescendantIds,
  buildNodeMap,
  countMeshNodes,
  getNearestContainerAncestor,
}                               from '../core/nodes.js';
import {
  isTransformNode,
  applyAllTransforms,
  applyAllVisibility,
}                               from '../core/transforms.js';
import { setStatus }            from './status.js';
import { showContextMenu, hideContextMenu } from './context-menu.js';

// ── State ────────────────────────────────────────────────────────────────────

const _expanded  = new Set(['scene_root']);   // expanded node IDs
let   _container = null;
let   _dragIds   = [];
let   _dropTarget= null;

// ── Init ─────────────────────────────────────────────────────────────────────

export function initTree(containerEl) {
  _container = containerEl;
  if (!_container) return;

  state.on('change:treeData',       () => renderTree());
  state.on('selection:change',      () => renderTree());
  state.on('change:activeStepId',   () => renderTree());

  renderTree();
}

// ── Public API ───────────────────────────────────────────────────────────────

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
  _expandAncestors(root, nodeId);
  renderTree();
}

export function collapseAll() {
  _expanded.clear();
  _expanded.add('scene_root');
  renderTree();
}

// ── Tree construction ─────────────────────────────────────────────────────────

function _buildNode(node, depth) {
  const wrap = document.createElement('div');
  // No class needed — POC uses bare divs for node wrappers

  const row = _buildRow(node, depth);
  wrap.appendChild(row);

  const hasChildren = (node.children?.length ?? 0) > 0;

  if (hasChildren && _expanded.has(node.id)) {
    const childList = document.createElement('div');
    childList.className = 'children';   // POC class
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

  // Use POC class names exactly: 'selected' / 'multi' / 'dropTarget'
  const row = document.createElement('div');
  row.className = [
    'tree-row',
    isPrimary                 ? 'selected'   : '',
    isMulti && !isPrimary     ? 'multi'       : '',
    isDropTarget              ? 'dropTarget'  : '',
  ].filter(Boolean).join(' ');
  row.style.paddingLeft = `${6 + depth * 14}px`;
  row.dataset.nodeId = node.id;
  row.dataset.hidden = node.localVisible ? 'false' : 'true';
  row.draggable = node.type !== 'scene';
  if (!node.localVisible) row.style.opacity = '0.45';

  // ── Twisty ──────────────────────────────────────────────────
  const twisty = document.createElement('span');
  twisty.className = 'twisty';   // POC class
  twisty.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : '';
  twisty.addEventListener('click', e => {
    e.stopPropagation();
    if (!hasChildren) return;
    if (isExpanded) _expanded.delete(node.id);
    else            _expanded.add(node.id);
    renderTree();
  });

  // ── Type icon ────────────────────────────────────────────────
  const icon = document.createElement('span');
  icon.className = 'icon';   // POC class
  icon.textContent = _typeIcon(node.type);

  // ── Label ────────────────────────────────────────────────────
  const label = document.createElement('span');
  label.className = 'label';   // POC class
  label.textContent = node.name || '(unnamed)';

  // ── Transform buttons (model / folder only) ──────────────────
  const transformGroup = document.createElement('span');
  transformGroup.style.display = isTransformNode(node) ? 'inline-flex' : 'none';
  transformGroup.style.gap = '1px';

  if (isTransformNode(node)) {
    const moveBtn   = _mkTransformBtn('✥', 'Move', node);
    const pivotBtn  = _mkTransformBtn('◎', 'Pivot', node);
    const rotateBtn = _mkTransformBtn('⟳', 'Rotate', node);
    transformGroup.append(moveBtn, pivotBtn, rotateBtn);
  }

  // ── Eye (visibility) — POC class 'eye', POC characters 👁/🚫 ──
  const eye = document.createElement('button');
  eye.className   = 'eye';   // POC class
  eye.textContent = node.localVisible ? '👁' : '🚫';
  eye.title       = node.localVisible ? 'Visible — click to hide' : 'Hidden — click to show';
  eye.addEventListener('click', e => {
    e.stopPropagation();
    _toggleVisibility(node);
  });

  // ── Assemble row ──────────────────────────────────────────────
  row.append(twisty, icon, label, transformGroup, eye);

  // ── Events ───────────────────────────────────────────────────
  row.addEventListener('click', e => _onRowClick(e, node));
  row.addEventListener('dblclick', e => _onRowDblClick(e, node));
  row.addEventListener('contextmenu', e => _onRowContextMenu(e, node));
  row.addEventListener('dragstart', e => _onDragStart(e, node));
  row.addEventListener('dragend',   () => _onDragEnd());
  row.addEventListener('dragover',  e => _onDragOver(e, node));
  row.addEventListener('dragleave', () => _onDragLeave(node));
  row.addEventListener('drop',      e => _onDrop(e, node));

  return row;
}

// ── Icons ────────────────────────────────────────────────────────────────────

function _typeIcon(type) {
  switch (type) {
    case 'scene':  return '🌐';
    case 'model':  return '🧩';
    case 'folder': return '🗂';
    case 'mesh':   return '◼';
    default:       return '📄';
  }
}

function _mkTransformBtn(icon, title, node) {
  const btn = document.createElement('button');
  btn.className   = 'moveBtn';   // POC class
  btn.textContent = icon;
  btn.title       = title;
  btn.addEventListener('click', e => { e.stopPropagation(); });
  return btn;
}

// ── Selection ─────────────────────────────────────────────────────────────────

function _onRowClick(e, node) {
  e.stopPropagation();
  hideContextMenu();

  const multiIds = new Set(state.get('multiSelectedIds') || []);

  if (e.ctrlKey || e.metaKey) {
    if (multiIds.has(node.id)) multiIds.delete(node.id);
    else multiIds.add(node.id);
    state.setSelection(node.id, multiIds);
  } else {
    state.setSelection(node.id, new Set([node.id]));
  }

  steps.scheduleSync();
}

function _onRowDblClick(e, node) {
  e.preventDefault();
  e.stopPropagation();
  if (node.type === 'mesh' || node.type === 'scene') return;
  // Select all children
  const ids = new Set();
  _collectAllIds(node, ids);
  state.setSelection(node.id, ids);
}

function _collectAllIds(node, out) {
  out.add(node.id);
  (node.children || []).forEach(c => _collectAllIds(c, out));
}

// ── Visibility ───────────────────────────────────────────────────────────────

function _toggleVisibility(node) {
  const multiIds  = state.get('multiSelectedIds') || new Set();
  const nodeById  = state.get('nodeById');
  if (!nodeById) return;

  const ids = multiIds.has(node.id) && multiIds.size > 1
    ? Array.from(multiIds)
    : [node.id];

  const newVis = !node.localVisible;
  for (const id of ids) {
    const n = nodeById.get(id);
    if (n) n.localVisible = newVis;
  }

  applyAllVisibility(state.get('treeData'), steps.object3dById);
  state.emit('change:treeData', state.get('treeData'));
  steps.scheduleSync();
}

// ── Context menu ──────────────────────────────────────────────────────────────

function _onRowContextMenu(e, node) {
  e.preventDefault();
  e.stopPropagation();
  state.setSelection(node.id, new Set([node.id]));
  renderTree();
  showContextMenu(_buildContextMenuItems(node), e.clientX, e.clientY);
}

function _buildContextMenuItems(node) {
  const items = [];
  const nodeById = state.get('nodeById');

  if (node.type !== 'scene') {
    items.push({
      label: `Rename "${(node.name || '').slice(0, 30)}"`,
      action: () => {
        const name = prompt('Rename:', node.name || '');
        if (!name?.trim()) return;
        node.name = name.trim();
        if (node.object3d) node.object3d.name = name.trim();
        state.emit('change:treeData', state.get('treeData'));
        steps.scheduleSync();
      },
    });
  }

  if (node.type === 'mesh' || node.type === 'folder' || node.type === 'model') {
    items.push({
      label: node.localVisible ? 'Hide' : 'Show',
      action: () => _toggleVisibility(node),
    });
  }

  if (node.type === 'folder' || node.type === 'model' || node.type === 'scene') {
    items.push({
      label: 'Select all children',
      action: () => {
        const ids = new Set();
        _collectAllIds(node, ids);
        state.setSelection(node.id, ids);
      },
    });
  }

  if (node.type === 'folder' && (node.children || []).length === 0) {
    items.push({
      label: 'Delete empty folder',
      action: () => _deleteEmptyFolder(node),
    });
  }

  return items;
}

function _deleteEmptyFolder(node) {
  const root = state.get('treeData');
  const parent = root ? findParent(root, node.id) : null;
  if (!parent) return;

  const idx = parent.children.indexOf(node);
  if (idx >= 0) parent.children.splice(idx, 1);

  if (parent.object3d && node.object3d) {
    parent.object3d.remove(node.object3d);
  }

  const nodeById = buildNodeMap(root);
  state.setState({ nodeById });
  renderTree();
  steps.scheduleSync();
  setStatus(`Deleted folder "${node.name}".`);
}

// ── Drag and Drop ─────────────────────────────────────────────────────────────

function _onDragStart(e, node) {
  const multiIds = state.get('multiSelectedIds') || new Set();
  if (!multiIds.has(node.id)) {
    state.setSelection(node.id, new Set([node.id]));
  }
  _dragIds = Array.from(state.get('multiSelectedIds') || []);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', JSON.stringify(_dragIds));
}

function _onDragEnd() {
  _dragIds    = [];
  _dropTarget = null;
  renderTree();
}

function _onDragOver(e, node) {
  if (node.type === 'mesh') return;
  e.preventDefault();
  if (_dropTarget !== node.id) {
    _dropTarget = node.id;
    renderTree();
  }
}

function _onDragLeave(node) {
  if (_dropTarget === node.id) {
    _dropTarget = null;
    renderTree();
  }
}

function _onDrop(e, targetNode) {
  e.preventDefault();
  _dropTarget = null;

  if (targetNode.type === 'mesh') return;

  const root    = state.get('treeData');
  if (!root) return;

  const movingIds = _dragIds.filter(id => {
    if (id === targetNode.id) return false;
    const descendants = new Set(collectDescendantIds(targetNode) || []);
    if (descendants.has(id)) return false;
    return true;
  });

  if (!movingIds.length) {
    setStatus('Cannot move: invalid target.');
    return;
  }

  // Collect actual nodes to move
  const toMove = [];
  for (const id of movingIds) {
    const parent = findParent(root, id);
    if (!parent) continue;
    const idx = parent.children.findIndex(c => c.id === id);
    if (idx >= 0) {
      const [removed] = parent.children.splice(idx, 1);
      toMove.push({ node: removed, oldParent: parent });
    }
  }

  for (const { node: moved, oldParent } of toMove) {
    targetNode.children.push(moved);
    if (oldParent.object3d && moved.object3d) oldParent.object3d.remove(moved.object3d);
    if (targetNode.object3d && moved.object3d) targetNode.object3d.add(moved.object3d);
  }

  const nodeById = buildNodeMap(root);
  state.setState({ nodeById });
  applyAllTransforms(root, steps.object3dById);
  renderTree();
  steps.scheduleSync();
  setStatus(`Moved ${toMove.length} item(s) into "${targetNode.name}".`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _expandAncestors(root, targetId) {
  function _walk(node, path) {
    if (node.id === targetId) {
      path.forEach(id => _expanded.add(id));
      return true;
    }
    for (const child of (node.children || [])) {
      if (_walk(child, [...path, node.id])) return true;
    }
    return false;
  }
  _walk(root, []);
}
