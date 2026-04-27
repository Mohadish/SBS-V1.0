/**
 * SBS — Cables system
 * ====================
 * 3D wires / conduits routed between mesh anchor points and free
 * floor positions. Cables can branch off other cables, carry sockets
 * (BoxGeometry connectors) at their nodes, and survive missing
 * meshes via a 3-tier anchor fallback.
 *
 * C1 (this file): data + IO + step-snapshot wiring + the 3-tier
 *                 anchor resolver. NO rendering, NO UI.
 * C2: render module + per-frame anchor ticker.
 * C3: sidebar tab + create flow + undo wiring.
 * C4: sockets.
 * C5: gizmo + selection.
 * C6: re-anchor + context menu + anchor health panel.
 * C7: branching.
 * C8: per-step apply for the variable-fields-only model.
 * C9: polish (globalScale, highlightColor, catenary/bezier slots).
 *
 * Topology-hoisted step model
 * ───────────────────────────
 * The IDENTITY of a cable (id + mesh anchor links + branch chain +
 * socket existence) is project-global — it lives in `state.cables`.
 * The VARIABLE state per cable (visibility, highlight, style, free-
 * node positions, socket pose & colour) can vary per step, captured
 * by `captureStepSnapshot()` and re-applied by `applyStepSnapshot()`.
 *
 * That split avoids the overlay-style "cable I created on step 5
 * disappears on step 1" surprise — the cable's identity persists
 * across all steps and the user just configures appearance per step.
 *
 * 3-tier anchor resolution
 * ────────────────────────
 * Each anchored point (and each socket) carries a cached world
 * position + quaternion alongside its `nodeId`+`anchorLocal`. World
 * position resolves in this order:
 *
 *   1. Live mesh         — derive from mesh.matrixWorld * anchorLocal.
 *                          Refresh the cache as a side-effect.
 *   2. Phantom placeholder — if the mesh died but a placeholder node
 *                            with a transform survives in the tree,
 *                            derive from that.
 *   3. Cache             — last-known good. Mark anchor `broken`.
 *
 * Everything anchored to a mesh therefore survives:
 *   - asset-missing warnings (live tree keeps a phantom)
 *   - intentional model removal (cache holds last position)
 *   - re-import of the same model (anchor re-binds by id)
 */

import state from '../core/state.js';
import {
  createCable, createCableNode, createCableSocket,
  generateId,
} from '../core/schema.js';

// ─── Public API stubs (filled in across phases) ───────────────────────────

/** All cables currently in state. Read-only. */
export function listCables() {
  return state.get('cables') || [];
}

/** Look up a cable by id. */
export function getCable(id) {
  if (!id) return null;
  return listCables().find(c => c.id === id) || null;
}

// ─── Step snapshot — capture/apply variable fields per cable ──────────────
//
// What's TOPOLOGY (project-global, never per-step):
//   - cable.id, branchSource
//   - node.id, type, anchorType, nodeId (mesh ref), anchorLocal,
//     normalLocal, sourceCableId, sourceNodeId, branchCableIds
//   - socket existence (yes / no), socket.id, socket.size
// What's VARIABLE (captured per step):
//   - cable.visible, cable.highlight, cable.style.{color,radius,type}
//   - free-node `position`
//   - socket.color, socket.name, socket.localQuaternion / quaternion
//   - cachedWorldPos / cachedWorldQuat (refreshed at apply too)

/**
 * Extract the per-step variable state from every cable in
 * state.cables. Returned object is keyed by cable id; absent
 * keys mean "use the cable's current values" on apply.
 */
export function captureStepSnapshot() {
  const cables = listCables();
  const out = {};
  for (const cable of cables) {
    out[cable.id] = {
      visible:   !!cable.visible,
      highlight: !!cable.highlight,
      style:     cable.style ? {
        color:  cable.style.color,
        radius: cable.style.radius,
        type:   cable.style.type,
      } : null,
      nodes: {},
    };
    for (const node of cable.nodes || []) {
      const nodeOut = {};
      // Free nodes carry world `position`; mesh-anchored nodes derive
      // from their host mesh, so capturing `position` here is just for
      // free-node per-step variation.
      if (node.anchorType === 'free' && Array.isArray(node.position)) {
        nodeOut.position = node.position.slice();
      }
      // Cache fields ride along — on apply they re-seed the live cache
      // so step-jumps into a step where the mesh is dead still place
      // the node where it was at capture time.
      if (Array.isArray(node.cachedWorldPos))  nodeOut.cachedWorldPos  = node.cachedWorldPos.slice();
      if (Array.isArray(node.cachedWorldQuat)) nodeOut.cachedWorldQuat = node.cachedWorldQuat.slice();
      // Socket fields — only the variable bits.
      if (node.socket) {
        nodeOut.socket = {
          color: node.socket.color,
          name:  node.socket.name,
        };
        if (Array.isArray(node.socket.localQuaternion)) nodeOut.socket.localQuaternion = node.socket.localQuaternion.slice();
        if (Array.isArray(node.socket.quaternion))      nodeOut.socket.quaternion      = node.socket.quaternion.slice();
      }
      if (Object.keys(nodeOut).length) out[cable.id].nodes[node.id] = nodeOut;
    }
  }
  return out;
}

/**
 * Merge a step's snapshot of variable fields back into state.cables.
 * Cables in state without an entry in `snap` are left untouched —
 * their current values stay (so a freshly-created cable carries
 * forward across past steps until the user explicitly varies it).
 *
 * Caller is responsible for triggering a render refresh after this
 * (C2's render module subscribes to the appropriate state event).
 */
export function applyStepSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return;
  const cables = (state.get('cables') || []).map(cable => {
    const override = snap[cable.id];
    if (!override) return cable;
    const next = { ...cable };
    if (override.visible   !== undefined) next.visible   = !!override.visible;
    if (override.highlight !== undefined) next.highlight = !!override.highlight;
    if (override.style) next.style = { ...(cable.style || {}), ...override.style };
    if (override.nodes) {
      next.nodes = (cable.nodes || []).map(node => {
        const nOver = override.nodes[node.id];
        if (!nOver) return node;
        const nnext = { ...node };
        if (nOver.position)        nnext.position        = nOver.position.slice();
        if (nOver.cachedWorldPos)  nnext.cachedWorldPos  = nOver.cachedWorldPos.slice();
        if (nOver.cachedWorldQuat) nnext.cachedWorldQuat = nOver.cachedWorldQuat.slice();
        if (nOver.socket && node.socket) {
          nnext.socket = { ...node.socket };
          if (nOver.socket.color !== undefined)        nnext.socket.color           = nOver.socket.color;
          if (nOver.socket.name  !== undefined)        nnext.socket.name            = nOver.socket.name;
          if (nOver.socket.localQuaternion)            nnext.socket.localQuaternion = nOver.socket.localQuaternion.slice();
          if (nOver.socket.quaternion)                 nnext.socket.quaternion      = nOver.socket.quaternion.slice();
        }
        return nnext;
      });
    }
    return next;
  });
  state.setState({ cables });
}

// ─── 3-tier anchor resolver ───────────────────────────────────────────────

/**
 * Resolve a cable node's world position. Returns { pos:[x,y,z], tier }
 * where tier ∈ 'live' | 'phantom' | 'cache' | 'unresolved' so callers
 * (UI, health panel) can flag broken anchors. `pos` is null only when
 * tier === 'unresolved' (no mesh, no phantom, and no cache — fresh
 * unanchored node that hasn't been positioned yet).
 *
 * Side effect: when tier === 'live', the cache is refreshed on the
 * passed `node` object so a later mesh death falls through to the
 * most-recent good position.
 */
export function resolveNodeWorldPosition(node, ctx = {}) {
  if (!node) return { pos: null, tier: 'unresolved' };

  // Tier 1: free node has its own world `position` directly.
  if (node.anchorType === 'free' && Array.isArray(node.position)) {
    return { pos: node.position.slice(), tier: 'live' };
  }

  // Tier 1 (mesh-anchored): live mesh in nodeById → derive from
  // mesh.matrixWorld * anchorLocal. Refresh cache as a side effect.
  if (node.anchorType === 'mesh' && node.nodeId && Array.isArray(node.anchorLocal)) {
    const sceneNode = (ctx.nodeById || state.get('nodeById'))?.get?.(node.nodeId);
    const obj = sceneNode?.object3d;
    if (obj && typeof obj.localToWorld === 'function') {
      // Three.js path — caller should pass a Three.Vector3 factory
      // or use this only from C2 onwards where Three is loaded.
      // Keep a vanilla [x,y,z] return; conversion is at the call site.
      try {
        const tmp = ctx.makeVec3 ? ctx.makeVec3(node.anchorLocal[0], node.anchorLocal[1], node.anchorLocal[2]) : null;
        if (tmp) {
          obj.updateMatrixWorld?.(true);
          obj.localToWorld(tmp);
          const out = [tmp.x, tmp.y, tmp.z];
          node.cachedWorldPos = out.slice();   // refresh cache
          return { pos: out, tier: 'live' };
        }
      } catch { /* fall through to cache */ }
    }
  }

  // Tier 1 (branch-start): recurse through source cable + node.
  if (node.anchorType === 'branch' && node.sourceCableId && node.sourceNodeId) {
    const src = getCable(node.sourceCableId);
    const srcNode = src?.nodes?.find(n => n.id === node.sourceNodeId);
    if (srcNode) {
      const r = resolveNodeWorldPosition(srcNode, ctx);
      if (r.pos) {
        node.cachedWorldPos = r.pos.slice();
        return { pos: r.pos, tier: r.tier };
      }
    }
  }

  // Tier 2: phantom placeholder — TODO C-Z when remove-model lands.
  // Phantom nodes will surface here via state.nodeById with a flag;
  // for now we fall straight through to cache.

  // Tier 3: cached last-known-good.
  if (Array.isArray(node.cachedWorldPos)) {
    return { pos: node.cachedWorldPos.slice(), tier: 'cache' };
  }
  return { pos: null, tier: 'unresolved' };
}

/**
 * Health check: walk all cables and return a list of {cable, node,
 * tier} for any anchor not currently resolving via 'live'. Drives
 * the Anchor Health panel in C6 — empty list means everything's
 * pinned to a real mesh / free position; non-empty means user has
 * drifting anchors to reconcile.
 */
export function findBrokenAnchors(ctx = {}) {
  const out = [];
  for (const cable of listCables()) {
    for (const node of cable.nodes || []) {
      // Free nodes can't be 'broken' — they store world position directly.
      if (node.anchorType === 'free') continue;
      const r = resolveNodeWorldPosition(node, ctx);
      if (r.tier !== 'live') out.push({ cable, node, tier: r.tier });
    }
  }
  return out;
}

// ─── Mutators (thin wrappers; future undo wiring lives in actions.js) ─────

/** Add a fresh cable to the project. Returns the new cable record. */
export function addCable(overrides = {}) {
  const cable = createCable(overrides);
  state.setState({ cables: [...listCables(), cable] });
  state.markDirty();
  return cable;
}

/** Patch a cable in place. */
export function updateCable(id, patch) {
  if (!id || !patch) return;
  const cables = listCables().map(c => c.id === id ? { ...c, ...patch } : c);
  state.setState({ cables });
  state.markDirty();
}

/** Remove a cable + cascade-clean its branch references. */
export function removeCable(id) {
  if (!id) return;
  // Strip references to this cable from any other cable's branchSource
  // / branchCableIds — orphaned branch-start nodes get cleaned up by
  // their own removal (caller can run findBrokenAnchors after).
  const cables = listCables()
    .filter(c => c.id !== id)
    .map(c => {
      let changed = false;
      const nodes = (c.nodes || []).map(n => {
        if (Array.isArray(n.branchCableIds) && n.branchCableIds.includes(id)) {
          changed = true;
          return { ...n, branchCableIds: n.branchCableIds.filter(x => x !== id) };
        }
        return n;
      });
      return changed ? { ...c, nodes } : c;
    });
  state.setState({ cables });
  state.markDirty();
}

// ─── Step lifecycle integration ───────────────────────────────────────────

/**
 * Hook into step:applied so cables re-merge per-step variable
 * overrides whenever a step activates. Idempotent — called from
 * main.js initialisation.
 */
export function initCables() {
  state.on('step:applied', (step) => {
    if (!step || !step.snapshot) return;
    applyStepSnapshot(step.snapshot.cables);
  });
}

// Re-export schema factories so UI / tests can build records without
// reaching back into core/schema.js directly.
export { createCable, createCableNode, createCableSocket, generateId };
