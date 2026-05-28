/**
 * SBS Step Browser — Tree Node Operations
 * ==========================================
 * Pure functions that operate on the scene tree data model.
 * These functions work on plain data objects (schema.js TreeNodes).
 * They have ZERO knowledge of Three.js — no import needed.
 *
 * The link between a tree node and its Three.js Object3D is
 * maintained externally through Maps (e.g. `state.nodeById` for data
 * lookups, and a separate meshById Map for Three.js mesh objects).
 *
 * All mutation functions return new/modified nodes so callers can
 * rebuild their Maps after each operation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NODE LOOKUP — TWO APIs, BOTH CORRECT, USE THE RIGHT ONE
 * ─────────────────────────────────────────────────────────────────────────
 * V0.2.22.19 — both lookup paths exist by design. Pick based on what
 * the caller actually needs:
 *
 *   findNode(root, id)               — recursive tree walk, O(N)
 *     Use when you ALSO need tree-shaped operations: walking siblings,
 *     finding the parent (findParent), inspecting subtree shape.
 *     Slow for huge trees if called in a hot loop.
 *
 *   state.get('nodeById')?.get(id)   — Map lookup, O(1)
 *     Use for point lookups by id. Always prefer in:
 *       - per-frame animation hot paths
 *       - large-batch operations (per-mesh-id iteration)
 *       - any callsite that doesn't need sibling/parent context
 *     The map is rebuilt on every change:treeData so values are fresh.
 *
 * Rule of thumb: if you'd reach for tree.walk(), use findNode. If you
 * just have an id, use nodeById. Both return the SAME node reference
 * (the map is built from the tree by buildNodeMap()).
 */


// ═══════════════════════════════════════════════════════════════════════════
//  TRAVERSAL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return all nodes in depth-first order (root first).
 * @param {TreeNode} root
 * @param {TreeNode[]} [out]
 * @returns {TreeNode[]}
 */
export function flatten(root, out = []) {
  if (!root) return out;
  out.push(root);
  root.children.forEach(c => flatten(c, out));
  return out;
}

/**
 * Depth-first search — find the first node with matching id.
 * @param {TreeNode|null} root
 * @param {string}        id
 * @returns {TreeNode|null}
 */
export function findNode(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * Find the parent of the node with the given id.
 * @param {TreeNode|null} root
 * @param {string}        id
 * @param {TreeNode|null} [_parent]
 * @returns {TreeNode|null}  parent node, or null if id is root / not found
 */
export function findParent(root, id, _parent = null) {
  if (!root) return null;
  if (root.id === id) return _parent;
  for (const child of root.children) {
    const found = findParent(child, id, root);
    if (found !== undefined && found !== null) return found;
    // Handle case where id is direct child of root
    if (child.id === id) return root;
  }
  return null;
}

/**
 * More reliable parent finder — iterates flatly using a Map.
 * Preferred when you already have a built nodeById Map.
 * @param {Map<string,TreeNode>} nodeById
 * @param {string}               childId
 * @returns {TreeNode|null}
 */
export function getParentFromMap(nodeById, childId) {
  for (const [, node] of nodeById) {
    if (node.children.some(c => c.id === childId)) return node;
  }
  return null;
}

/**
 * Collect all descendant IDs (including the node itself).
 * @param {TreeNode} node
 * @param {string[]} [out]
 * @returns {string[]}
 */
export function collectDescendantIds(node, out = []) {
  if (!node) return out;
  out.push(node.id);
  node.children.forEach(c => collectDescendantIds(c, out));
  return out;
}

/**
 * Walk the tree and call `visitor(node, depth, parent)` for every node.
 * Traversal stops at a branch if visitor returns false.
 */
export function walk(root, visitor, depth = 0, parent = null) {
  if (!root) return;
  const cont = visitor(root, depth, parent);
  if (cont === false) return;
  root.children.forEach(c => walk(c, visitor, depth + 1, root));
}

/**
 * Build a Map<id, node> from the entire tree.
 * Call after any structural mutation.
 * @param {TreeNode} root
 * @returns {Map<string, TreeNode>}
 */
export function buildNodeMap(root) {
  const map = new Map();
  flatten(root).forEach(n => map.set(n.id, n));
  return map;
}

/**
 * Get the path of node IDs from root to the target node (inclusive).
 * Returns an empty array if the node is not found.
 * @param {TreeNode} root
 * @param {string}   targetId
 * @returns {string[]}
 */
export function getPathToNode(root, targetId) {
  const path = [];

  function walk(node) {
    if (!node) return false;
    path.push(node.id);
    if (node.id === targetId) return true;
    for (const child of node.children) {
      if (walk(child)) return true;
    }
    path.pop();
    return false;
  }

  if (root && walk(root)) return path;
  return [];
}

/**
 * Check whether `ancestorId` is an ancestor of `nodeId` (or equal to it).
 * @param {TreeNode} root
 * @param {string}   ancestorId
 * @param {string}   nodeId
 * @returns {boolean}
 */
export function isDescendantOf(root, ancestorId, nodeId) {
  if (ancestorId === nodeId) return true;
  const ancestor = findNode(root, ancestorId);
  if (!ancestor) return false;
  return collectDescendantIds(ancestor).includes(nodeId);
}


// ═══════════════════════════════════════════════════════════════════════════
//  FILTERED QUERIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return all nodes of a specific type.
 * @param {TreeNode} root
 * @param {string}   type  'mesh' | 'model' | 'folder' | 'scene'
 * @returns {TreeNode[]}
 */
export function getNodesByType(root, type) {
  return flatten(root).filter(n => n.type === type);
}

// V0.2.22.19 — removed three unused exports: getFolderNodes / getMeshNodes
// / getModelNodes. All three were thin filter wrappers over flatten()
// that no callers used. Use getNodesByType(root, type) if you need
// type-filtered enumeration; otherwise flatten(root).filter(predicate)
// directly is just as clear.

/** Count mesh nodes in a subtree */
export function countMeshNodes(node) {
  if (!node) return 0;
  let count = node.type === 'mesh' ? 1 : 0;
  node.children.forEach(c => { count += countMeshNodes(c); });
  return count;
}

/**
 * Get the nearest ancestor that is a 'model' or 'folder' node.
 * Useful for finding the group to select when a mesh is clicked.
 */
export function getNearestContainerAncestor(root, nodeId) {
  const path = getPathToNode(root, nodeId);
  // Walk path in reverse (closest ancestor first), skip the node itself
  for (let i = path.length - 2; i >= 0; i--) {
    const n = findNode(root, path[i]);
    if (n && (n.type === 'folder' || n.type === 'model')) return n;
  }
  return null;
}

/**
 * Collect all nodes that are currently visible (localVisible true on
 * themselves AND all their ancestors).
 * @param {TreeNode} root
 * @returns {Set<string>}  set of visible node ids
 */
export function computeVisibleSet(root) {
  const visible = new Set();

  function walk(node, parentVisible) {
    // Archive trumps localVisible: an archived node is always invisible
    // and propagates that to descendants regardless of their localVisible.
    const isVisible = parentVisible && node.localVisible && !node.archived;
    if (isVisible) visible.add(node.id);
    node.children.forEach(c => walk(c, isVisible));
  }

  if (root) walk(root, true);
  return visible;
}


// ═══════════════════════════════════════════════════════════════════════════
//  STRUCTURAL MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════
// All mutation functions operate IN-PLACE on the node data (since nodes are
// shared mutable objects across state, steps, etc.) and return the mutated
// root for chaining/Map rebuilding.

/**
 * Remove the node with `id` from the tree.
 * @param {TreeNode} root
 * @param {string}   id
 * @returns {{ root: TreeNode, removed: TreeNode|null }}
 */
export function removeNodeById(root, id) {
  if (!root || root.id === id) return { root, removed: null };

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child.id === id) {
      root.children.splice(i, 1);
      return { root, removed: child };
    }
    const nested = removeNodeById(child, id);
    if (nested.removed) return nested;
  }
  return { root, removed: null };
}

/**
 * Append a child node to a parent.
 * @param {TreeNode} parent
 * @param {TreeNode} child
 * @param {number}  [index]  insertion index (undefined = append)
 */
export function insertChildNode(parent, child, index) {
  if (index == null || index >= parent.children.length) {
    parent.children.push(child);
  } else {
    parent.children.splice(Math.max(0, index), 0, child);
  }
}

/**
 * Move a node to a new parent (within the same tree).
 * Safe: will not move a node into its own subtree.
 *
 * @param {TreeNode} root
 * @param {string}   nodeId       node to move
 * @param {string}   newParentId  target parent id
 * @param {number}  [index]       insertion index in new parent (default = append)
 * @returns {boolean}  true if move succeeded
 */
export function moveNode(root, nodeId, newParentId, index) {
  // Guard: can't move a node into itself or its own descendant
  if (isDescendantOf(root, nodeId, newParentId)) return false;
  if (nodeId === newParentId) return false;

  const { root: newRoot, removed } = removeNodeById(root, nodeId);
  if (!removed) return false;

  const newParent = findNode(newRoot, newParentId);
  if (!newParent) {
    // Insertion point disappeared — put it back
    const originalParent = findNode(root, newParentId);
    if (originalParent) originalParent.children.push(removed);
    return false;
  }

  insertChildNode(newParent, removed, index);
  return true;
}

/**
 * Rename a node in the tree (mutation).
 * @param {Map<string,TreeNode>} nodeById
 * @param {string}               id
 * @param {string}               name
 */
export function renameNode(nodeById, id, name) {
  const node = nodeById.get(id);
  if (node) node.name = name;
}

/**
 * Set localVisible on a node (mutation).
 * @param {Map<string,TreeNode>} nodeById
 * @param {string}               id
 * @param {boolean}              visible
 */
export function setNodeVisible(nodeById, id, visible) {
  const node = nodeById.get(id);
  if (node) node.localVisible = visible;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SNAPSHOT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Capture the current visibility state of all nodes into a plain object.
 * Returns { [nodeId]: boolean }
 * @param {TreeNode} root
 * @returns {Object}
 */
export function captureVisibilitySnapshot(root) {
  const vis = {};
  flatten(root).forEach(n => { vis[n.id] = n.localVisible; });
  return vis;
}

/**
 * Compute effective (inherited) visibility for every node in the tree.
 *
 * A node is effectively visible only if IT and every ancestor up to
 * the root are visible. Mirrors what applyAllVisibility does to
 * Three.js Object3Ds, but returns a plain Map so non-Three consumers
 * (e.g. the notes-render DOM overlay) can use it.
 *
 * If `visOverride` is provided, each lookup uses
 *   visOverride[nodeId] !== undefined ? visOverride[nodeId] : node.localVisible
 * so callers can simulate "what would visibility look like under this
 * snapshot.visibility map" without mutating the live tree. This is
 * what step transitions use to compute the TO-side effective state.
 *
 * @param {TreeNode}            root
 * @param {Object<string,bool>} [visOverride]
 * @returns {Map<string, boolean>}
 */
export function computeEffectiveVisibility(root, visOverride) {
  const out = new Map();
  if (!root) return out;
  function walk(node, inheritedVisible) {
    const ownLookup = visOverride && Object.prototype.hasOwnProperty.call(visOverride, node.id)
      ? visOverride[node.id]
      : node.localVisible;
    const own = ownLookup !== false;
    // Archive forces effective=false regardless of localVisible or override —
    // matches computeVisibleSet's contract and the scene-apply path in
    // systems/steps.js (applyAllVisibilityToScene).
    const archived = node.archived === true;
    const eff = inheritedVisible && own && !archived;
    out.set(node.id, eff);
    for (const c of (node.children || [])) walk(c, eff);
  }
  walk(root, true);
  return out;
}


/**
 * Apply a visibility snapshot to the tree (mutation).
 * Nodes in the snapshot that no longer exist are ignored.
 * Nodes not in the snapshot are left unchanged.
 * @param {Map<string,TreeNode>} nodeById
 * @param {Object}               visibility  { [nodeId]: boolean }
 */
export function applyVisibilitySnapshot(nodeById, visibility) {
  for (const [id, visible] of Object.entries(visibility)) {
    const node = nodeById.get(id);
    if (node) node.localVisible = !!visible;
  }
}

/**
 * Collect all nodes that differ in visibility between the current tree
 * and a snapshot. Used to compute what changed for diff/animation.
 * @param {Map<string,TreeNode>} nodeById
 * @param {Object}               visibility  snapshot
 * @returns {Array<{id, from, to}>}
 */
export function diffVisibility(nodeById, visibility) {
  const changes = [];
  for (const [id, snapshotVisible] of Object.entries(visibility)) {
    const node = nodeById.get(id);
    if (node && node.localVisible !== !!snapshotVisible) {
      changes.push({ id, from: node.localVisible, to: !!snapshotVisible });
    }
  }
  return changes;
}


// ═══════════════════════════════════════════════════════════════════════════
//  PARENT MAP  (step-sensitive tree arrangement)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Capture every node's parent ID into a plain object.
 * The root has no entry (it has no parent).
 * { [nodeId]: parentId }
 *
 * @param {TreeNode} root
 * @returns {Object}
 */
export function captureParentMap(root) {
  const map = {};
  function walk(node, parentId) {
    if (parentId !== null) map[node.id] = parentId;
    for (const child of (node.children || [])) walk(child, node.id);
  }
  if (root) walk(root, null);
  return map;
}

/**
 * Re-arrange the tree so every node is under the parent recorded in parentMap.
 * Nodes or parents that no longer exist in the tree are silently skipped.
 * Returns the list of moves performed: [{ nodeId, fromParentId, toParentId }]
 * so the caller can sync Three.js object hierarchy.
 *
 * @param {TreeNode} root
 * @param {Object}   parentMap  { [nodeId]: parentId }
 * @returns {{ nodeId, fromParentId, toParentId }[]}
 */
export function applyParentMap(root, parentMap) {
  if (!root || !parentMap) return [];
  const nodeById = buildNodeMap(root);
  const moves = [];

  // Collect moves first (don't mutate while building the list)
  for (const [nodeId, targetParentId] of Object.entries(parentMap)) {
    const node         = nodeById.get(nodeId);
    const targetParent = nodeById.get(targetParentId);
    if (!node || !targetParent) continue;

    const currentParent = getParentFromMap(nodeById, nodeId);
    if (!currentParent || currentParent.id === targetParentId) continue;

    moves.push({ nodeId, fromParentId: currentParent.id, toParentId: targetParentId });
  }

  // Execute data moves
  for (const { nodeId, fromParentId, toParentId } of moves) {
    const node       = nodeById.get(nodeId);
    const fromParent = nodeById.get(fromParentId);
    const toParent   = nodeById.get(toParentId);
    if (!node || !fromParent || !toParent) continue;

    const idx = fromParent.children.findIndex(c => c.id === nodeId);
    if (idx >= 0) fromParent.children.splice(idx, 1);
    toParent.children.push(node);
  }

  return moves;
}


// ═══════════════════════════════════════════════════════════════════════════
//  TREE SERIALISATION  (for step snapshots — no Three.js)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recursively serialize a tree node to a plain, Three.js-free object.
 * Used to store the full folder/model hierarchy in each step snapshot.
 * Only structure is captured here — transforms are stored in snapshot.transforms.
 *
 * @param {TreeNode} node
 * @returns {object|null}
 */
export function serializeModelTree(node) {
  if (!node) return null;
  // Notes are GLOBAL — they're tree children of meshes for tree-display
  // purposes, but they don't belong in per-step snapshots. The live
  // tree owns them; rebuildFromTreeSpec re-attaches them after each
  // rebuild (see _reattachLiveNoteChildren in steps.js). Filter them
  // out of the serialised spec so step rebuilds don't whisk them away.
  if (node.type === 'note') return null;
  const spec = {
    id:           node.id,
    name:         node.name || '',
    type:         node.type,
    localVisible: node.localVisible !== false,
    // Archive flag rides on the tree section so a node's "locked-hidden"
    // state survives save/reload. Default false on legacy projects.
    archived:     node.archived === true,
    children:     (node.children || []).map(serializeModelTree).filter(Boolean),
  };
  // Replace-Model fields (B.2-NEW). Only emitted when the node IS an RM
  // so non-RM specs stay byte-identical to pre-B.2-NEW projects.
  if (node.type === 'replaceModel') {
    spec.originalType           = node.originalType || null;
    spec.originalGeometryHidden = node.originalGeometryHidden === true;
  }
  // Folder lock (V0.1.92, replaces isGroup/groupLocked). Only emitted when
  // locked so plain folders stay byte-identical.
  if (node.locked === true) {
    spec.locked = true;
  }
  // RM-child marker: the ORIGIN node id this clone was made from.
  // Save preserves it; rebuildReplaceModelChildren on load uses it to
  // re-clone the geometry (since the clone has no standalone geometry
  // — it was a runtime Three.js .clone() of the origin).
  if (node.sourceNodeId) {
    spec.sourceNodeId = node.sourceNodeId;
  }
  // Persist bbox + geometry fingerprint for mesh nodes. Used for:
  //   - bbox: rendering a placeholder box when the asset is missing.
  //   - fingerprint + bbox centre: robust semantic match on reintegration so
  //     duplicates (nuts / bolts) bind to the correct phantom.
  if (node.type === 'mesh') {
    if (node.bbox)        spec.bbox        = node.bbox;
    if (node.fingerprint) spec.fingerprint = node.fingerprint;
    // placeholderTransform — needed so a phantom (Bbox-only) mesh
    // renders at the same local rotation / scale the live mesh had.
    //
    // Two sources:
    //   1. Explicit, set by deleteTopLevelAssembly (delete-to-phantom).
    //   2. Inferred from node.object3d at save time — handles the case
    //      where a live FBX project is saved and later reopened with
    //      the source file missing. Without this, FBX meshes (whose
    //      loader puts per-mesh rotations on each object) rendered
    //      90° off as placeholders even though they bind correctly
    //      when the file is re-located.
    //
    // Identity transforms (typical of OBJ models) are skipped to keep
    // the saved spec lean.
    if (node.placeholderTransform) {
      spec.placeholderTransform = node.placeholderTransform;
    } else if (node.object3d && !_isIdentityTransform(node.object3d)) {
      const o = node.object3d;
      spec.placeholderTransform = {
        position:   [o.position.x,   o.position.y,   o.position.z],
        quaternion: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
        scale:      [o.scale.x,      o.scale.y,      o.scale.z],
      };
    }
  }
  return spec;
}

/** True iff position/quaternion/scale on an Object3D are all identity. */
function _isIdentityTransform(o) {
  const e = 1e-6;
  return Math.abs(o.position.x) < e && Math.abs(o.position.y) < e && Math.abs(o.position.z) < e
      && Math.abs(o.quaternion.x) < e && Math.abs(o.quaternion.y) < e && Math.abs(o.quaternion.z) < e
      && Math.abs(o.quaternion.w - 1) < e
      && Math.abs(o.scale.x - 1) < e && Math.abs(o.scale.y - 1) < e && Math.abs(o.scale.z - 1) < e;
}


// ═══════════════════════════════════════════════════════════════════════════
//  SELECTION UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Given a click on a mesh, return the most appropriate node to select.
 * If the mesh belongs to a folder, select the folder.
 * If the mesh belongs directly to a model, select the model.
 * Ctrl-click always selects the mesh directly for fine-grained control.
 *
 * @param {TreeNode} root
 * @param {string}   meshId
 * @param {boolean}  [fine]  true = always select the mesh node itself
 * @returns {string|null}  node id to select
 */
export function resolveSelectionTarget(root, meshId, fine = false) {
  if (fine) return meshId;
  const container = getNearestContainerAncestor(root, meshId);
  return container ? container.id : meshId;
}

/**
 * Collect all mesh descendant IDs of a node.
 * Used for selection highlighting (expand folder → select all meshes inside).
 * @param {TreeNode} node
 * @returns {string[]}
 */
export function collectMeshIds(node) {
  return flatten(node).filter(n => n.type === 'mesh').map(n => n.id);
}

// V0.2.22.19 — removed unused export `expandSelectionToMeshes`. Selection
// expansion is done inline at call sites using collectMeshIds().
