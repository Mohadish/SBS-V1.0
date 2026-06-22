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

// ─── Step snapshot — visibility-only model ────────────────────────────────
//
// Per design (Phase B): cable identity AND geometry are project-global.
// Only cable-level on/off + highlight vary per step. Everything else
// (style, anchors, socket pose, free-node positions if they exist for
// legacy data) is global — moving a cable point or recolouring a cable
// affects every step. This avoids the "step 5 has yellow, step 6 has
// blue" surprise and matches user mental model: cables are wired into
// the assembly once, then animation rides on the host meshes.

/**
 * Extract the per-step variable state from every cable in
 * state.cables. Returned object is keyed by cable id; absent
 * keys mean "use the cable's current values" on apply.
 */
// Capture ONE cable's arrangement (visible/highlight + per-node pose). Per node:
//   pos = free node world position        (V0.3.0.126)
//   anc = mesh-anchored offset anchorLocal (V0.3.0.128 — combined with the host's
//         own animated transform this lets an anchored point ride the part)
//   sq  = socket facing (localQuaternion for a mesh host, quaternion for free)
//   pl  = per-step plug state (V0.3.0.129)
// A mesh node's WORLD position still auto-follows its host every frame; `anc`
// only varies the offset. Branch nodes follow their parent cable (not stored).
export function captureCableArrangement(cableOrId) {
  const cable = typeof cableOrId === 'string'
    ? listCables().find(c => c.id === cableOrId) : cableOrId;
  if (!cable) return null;
  const nodes = {};
  for (const n of (cable.nodes || [])) {
    const pose = {};
    if (n.anchorType === 'free' && Array.isArray(n.position))    pose.pos = n.position.slice();
    if (n.anchorType === 'mesh' && Array.isArray(n.anchorLocal)) pose.anc = n.anchorLocal.slice();
    const sq = n.anchorType === 'mesh' ? n.socket?.localQuaternion : n.socket?.quaternion;
    if (n.socket && Array.isArray(sq) && sq.length === 4)         pose.sq  = sq.slice();
    if (n.socket)                                                 pose.pl  = !!n.socket.plugged;
    if (Object.keys(pose).length) nodes[n.id] = pose;
  }
  return { visible: !!cable.visible, highlight: !!cable.highlight, nodes };
}

export function captureStepSnapshot() {
  const out = {};
  for (const cable of listCables()) out[cable.id] = captureCableArrangement(cable);
  return out;
}

// ─── Cascade model (V0.3.0.151) ───────────────────────────────────────────
// A cable's arrangement lives ONLY on "state-defining" steps (the step that
// holds a plug/unplug action, plus the first step's initial state). Every other
// step inherits it by cascade. So a cable's truth at any step = the nearest
// stored entry at a step ≤ this one.

/**
 * Resolve the full cable snapshot AT a step by cascading: for each cable, take
 * the nearest stored entry at a step ≤ stepId (walk forward, nearest wins).
 * Returns a {cableId: {visible,highlight,nodes}} map ready for applyStepSnapshot.
 */
export function resolveCableSnapshotAtStep(stepId) {
  const steps = state.get('steps') || [];
  const idx = steps.findIndex(s => s.id === stepId);
  if (idx < 0) return {};
  const merged = {};
  for (let i = 0; i <= idx; i++) {
    const c = steps[i]?.snapshot?.cables;
    if (!c) continue;
    for (const cid of Object.keys(c)) merged[cid] = c[cid];   // nearest (later) wins
  }
  return merged;
}

/**
 * Find the index of the state-defining step for a cable as seen from a given
 * step — the nearest step ≤ fromIdx that already holds an entry for that cable.
 * Falls back to 0 (the first step = the initial state) when none exists yet.
 */
export function definingStepIndexForCable(cableId, fromIdx) {
  const steps = state.get('steps') || [];
  for (let i = Math.min(fromIdx, steps.length - 1); i >= 0; i--) {
    if (steps[i]?.snapshot?.cables?.[cableId]) return i;
  }
  return 0;
}

/**
 * Cascade WRITE: push each live cable's current arrangement onto its STATE-
 * DEFINING step (not the active step). This is what makes an edit anywhere in a
 * state fill the whole state — the state's one stored entry is updated, and every
 * step in the span inherits it. Idempotent when nothing changed (re-writes the
 * same resolved arrangement). Callers must skip this during any cable animation.
 */
export function commitLiveCablesToDefiningSteps(activeStepId) {
  const steps = state.get('steps') || [];
  const activeIdx = steps.findIndex(s => s.id === activeStepId);
  if (activeIdx < 0) return;
  for (const cable of listCables()) {
    const defIdx  = definingStepIndexForCable(cable.id, activeIdx);
    const defStep = steps[defIdx];
    if (!defStep) continue;
    if (!defStep.snapshot)        defStep.snapshot = {};
    if (!defStep.snapshot.cables) defStep.snapshot.cables = {};
    defStep.snapshot.cables[cable.id] = captureCableArrangement(cable);
  }
}

/** Per-step plug-config signature for a cable (carry-forward resolved). */
function _cablePlugSig(entry, socketIds) {
  return socketIds.map((sid) => {
    const p = entry?.nodes?.[sid];
    return (p && !Array.isArray(p) && typeof p.pl === 'boolean') ? (p.pl ? '1' : '0') : '?';
  }).join(',');
}

/**
 * Step ids that hold a plug/unplug ACTION = where some cable's plug config
 * changes vs the previous step (the first step is the initial state, not an
 * action). Used for the 🔌 step marker. One pass, carry-forward resolved.
 */
export function getPlugActionStepIds() {
  const steps  = state.get('steps') || [];
  const cables = state.get('cables') || [];
  const result = new Set();
  // Match getStepCableActions EXACTLY (icon iff the manager has an action): per
  // socket, mark a step where the resolved plug state changes to a non-null value
  // vs the previous step (step 0 = initial state, never an action). V0.3.0.154.
  const plOf = (entry, nodeId) => {
    const p = entry?.nodes?.[nodeId];
    return (p && !Array.isArray(p) && typeof p.pl === 'boolean') ? p.pl : null;
  };
  for (const cable of cables) {
    const socketIds = (cable.nodes || []).filter(n => n.socket).map(n => n.id);
    if (!socketIds.length) continue;
    let carried = null;
    const prev = new Map();   // nodeId → previous resolved pl
    for (let i = 0; i < steps.length; i++) {
      const own = steps[i]?.snapshot?.cables?.[cable.id];
      if (own) carried = own;
      for (const sid of socketIds) {
        const pl = plOf(carried, sid);
        const pp = prev.has(sid) ? prev.get(sid) : null;
        if (i > 0 && pl !== null && pl !== pp) result.add(steps[i].id);
        prev.set(sid, pl);
      }
    }
  }
  return result;
}

/**
 * The plug/unplug ACTIONS at a given step — each cable socket whose plug config
 * changes vs the previous step. Returns [{cableId, cableName, nodeId, socketLabel,
 * action:'plug'|'unplug'}]. Used by the 🔌 step right-click manager (V0.3.0.153).
 */
export function getStepCableActions(stepId) {
  const steps = state.get('steps') || [];
  const idx = steps.findIndex(s => s.id === stepId);
  if (idx <= 0) return [];   // first step = initial state, not an action
  const cables = state.get('cables') || [];
  const plOf = (snap, nodeId) => {
    const p = snap?.nodes?.[nodeId];
    return (p && !Array.isArray(p) && typeof p.pl === 'boolean') ? p.pl : null;
  };
  const cur  = resolveCableSnapshotAtStep(steps[idx].id);
  const prev = resolveCableSnapshotAtStep(steps[idx - 1].id);
  const out = [];
  for (const cable of cables) {
    const socketNodes = (cable.nodes || []).filter(n => n.socket);
    for (const sn of socketNodes) {
      const a = plOf(cur[cable.id],  sn.id);
      const b = plOf(prev[cable.id], sn.id);
      if (a !== null && a !== b) {
        out.push({
          cableId:     cable.id,
          cableName:   cable.name || 'Cable',
          nodeId:      sn.id,
          socketLabel: `pt ${cable.nodes.indexOf(sn) + 1}`,
          action:      a ? 'plug' : 'unplug',
        });
      }
    }
  }
  return out;
}

/**
 * FLATTEN existing per-step cable data into the cascade form (V0.3.0.151): for
 * each cable, split the timeline into plug-config spans; take each span's SETTLED
 * arrangement from the LAST step of the span, write it onto the span's FIRST
 * (state-defining) step, and clear the cable from every other step. Idempotent.
 * In-memory only — the project file is untouched until the user saves. Returns the
 * number of step entries removed (a measure of how much was collapsed).
 */
export function flattenCablesToCascade() {
  const steps  = state.get('steps') || [];
  const cables = state.get('cables') || [];
  if (!steps.length) return 0;
  let removed = 0;
  for (const cable of cables) {
    const cid = cable.id;
    const socketIds = (cable.nodes || []).filter(n => n.socket).map(n => n.id);
    // Resolve each step's entry (own or carried-forward) + plug signature.
    let carried = null;
    const perStep = steps.map((s) => {
      const own = s?.snapshot?.cables?.[cid];
      if (own) carried = own;
      return { entry: carried, sig: _cablePlugSig(carried, socketIds) };
    });
    // State spans: a new span starts wherever the signature changes (step 0 always).
    const boundaries = [];
    let prevSig = null;
    for (let i = 0; i < perStep.length; i++) {
      if (perStep[i].sig !== prevSig) { boundaries.push(i); prevSig = perStep[i].sig; }
    }
    // Write each span's settled (last-step) arrangement to its boundary; clear the rest.
    for (let bi = 0; bi < boundaries.length; bi++) {
      const b      = boundaries[bi];
      const nextB  = (bi + 1 < boundaries.length) ? boundaries[bi + 1] : steps.length;
      const settled = perStep[nextB - 1]?.entry;
      if (settled) {
        if (!steps[b].snapshot)        steps[b].snapshot = {};
        if (!steps[b].snapshot.cables) steps[b].snapshot.cables = {};
        steps[b].snapshot.cables[cid] = JSON.parse(JSON.stringify(settled));
      }
      for (let i = b + 1; i < nextB; i++) {
        if (steps[i]?.snapshot?.cables?.[cid]) { delete steps[i].snapshot.cables[cid]; removed++; }
      }
    }
  }
  return removed;
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
  if (typeof window !== 'undefined' && window.sbsDiag?.cableTrace) {   // V0.3.0.139
    const pls = [];
    for (const ov of Object.values(snap)) {
      if (ov?.nodes) for (const [nid, pose] of Object.entries(ov.nodes)) {
        if (pose && typeof pose === 'object' && typeof pose.pl === 'boolean') pls.push(`${String(nid).slice(-5)}=${pose.pl}`);
      }
    }
    console.log(`[cableTrace] >> applyStepSnapshot — plug states applied: ${pls.join(' ') || '(none)'}`);
  }
  const cables = (state.get('cables') || []).map(cable => {
    const override = snap[cable.id];
    if (!override) return cable;
    const next = { ...cable };
    if (override.visible   !== undefined) next.visible   = !!override.visible;
    if (override.highlight !== undefined) next.highlight = !!override.highlight;
    // Per-step node pose (cable morph). Non-destructive: a snapshot WITHOUT `nodes`
    // (old projects) leaves every pose as-is. Legacy V0.3.0.126 stored a bare
    // position array; V0.3.0.128 stores { pos, anc, sq } — both handled.
    if (override.nodes && typeof override.nodes === 'object') {
      next.nodes = (cable.nodes || []).map(n => {
        const o = override.nodes[n.id];
        if (!o) return n;
        const pose = Array.isArray(o) ? { pos: o } : o;   // legacy array = free position
        const nn = { ...n };
        if (n.anchorType === 'free' && Array.isArray(pose.pos)) nn.position    = pose.pos.slice();
        if (n.anchorType === 'mesh' && Array.isArray(pose.anc)) nn.anchorLocal = pose.anc.slice();
        if (n.socket && (typeof pose.pl === 'boolean' || (Array.isArray(pose.sq) && pose.sq.length === 4))) {
          const sock = { ...n.socket };
          if (Array.isArray(pose.sq) && pose.sq.length === 4) {
            if (n.anchorType === 'mesh') sock.localQuaternion = pose.sq.slice();
            else                          sock.quaternion      = pose.sq.slice();
          }
          if (typeof pose.pl === 'boolean') sock.plugged = pose.pl;   // V0.3.0.129 — per-step plug state
          nn.socket = sock;
        }
        return nn;
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

  // Tier 0 (V0.3.0.129) — a PLUGGED socket resolves onto its connection target
  // (destination mesh.matrixWorld * connectTarget.anchorLocal), so the node jumps
  // onto the thing it plugs into. This is the per-step "jump to final position".
  // Overrides the node's own anchor; the cable body follows. The connect ANIMATION
  // (Phase 2) drives this same position along an offset-approach path instead.
  const ct = node.socket?.plugged ? node.socket.connectTarget : null;
  if (ct?.nodeId && Array.isArray(ct.anchorLocal)) {
    const T = window.THREE;
    const tNode = (ctx.nodeById || state.get('nodeById'))?.get?.(ct.nodeId);
    const tObj  = tNode?.object3d || ctx.object3dById?.get?.(ct.nodeId);
    if (tObj && T) {
      tObj.updateMatrixWorld?.();
      const p = new T.Vector3(ct.anchorLocal[0], ct.anchorLocal[1], ct.anchorLocal[2]);
      tObj.localToWorld(p);
      return { pos: [p.x, p.y, p.z], tier: 'live' };
    }
  }

  // Tier 1: free node has its own world `position` directly.
  if (node.anchorType === 'free' && Array.isArray(node.position)) {
    return { pos: node.position.slice(), tier: 'live' };
  }

  // Tier 1 (mesh-anchored): live mesh in nodeById → derive from
  // mesh.matrixWorld * anchorLocal. Refresh cache as a side effect.
  //
  // Robustness: we look up the Three.js object via BOTH `nodeById` (data
  // tree, authoritative) AND `object3dById` (steps.object3dById) and use
  // whichever is present + live. After certain tree alterations (relink,
  // model-source-bake, move) the two maps can drift apart for a node —
  // taking either path keeps the cable bound. Without the fallback the
  // resolver silently fell through to the cached worldPos forever, and
  // the cable point appeared "stuck" while its host moved.
  if (node.anchorType === 'mesh' && node.nodeId && Array.isArray(node.anchorLocal)) {
    const sceneNode = (ctx.nodeById || state.get('nodeById'))?.get?.(node.nodeId);
    let obj = sceneNode?.object3d;
    // Fallback: steps.object3dById often holds the live object even when
    // the data-tree node's `.object3d` field is stale (or vice-versa).
    if (!obj && ctx.object3dById?.get) {
      obj = ctx.object3dById.get(node.nodeId);
    }
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

/** Patch the cable's `style` sub-object (color / radius / type). */
export function updateCableStyle(id, stylePatch) {
  if (!id || !stylePatch) return;
  const cables = listCables().map(c =>
    c.id === id ? { ...c, style: { ...(c.style || {}), ...stylePatch } } : c,
  );
  state.setState({ cables });
  state.markDirty();
}

/**
 * Append a node to a cable's nodes list (or prepend when
 * opts.atStart is true). Returns the new node. Caller is responsible
 * for picking the right `anchorType` + accompanying fields:
 *   - 'mesh': nodeId + anchorLocal + normalLocal + cachedWorldPos
 *   - 'free': position + cachedWorldPos
 *   - 'branch': sourceCableId + sourceNodeId + branchCableIds[]
 */
export function addCablePoint(cableId, nodePartial = {}, opts = {}) {
  const cable = getCable(cableId);
  if (!cable) return null;
  const node = createCableNode(nodePartial);
  const atStart = !!opts.atStart;
  const cables = listCables().map(c => {
    if (c.id !== cableId) return c;
    const nodes = atStart
      ? [node, ...(c.nodes || [])]
      : [...(c.nodes || []), node];
    return { ...c, nodes };
  });
  state.setState({ cables });
  state.markDirty();
  return node;
}

/** Remove a node from a cable by node id. Returns true if it was found. */
export function removeCablePoint(cableId, nodeId) {
  const cable = getCable(cableId);
  if (!cable) return false;
  const before = cable.nodes?.length ?? 0;
  const nodes  = (cable.nodes || []).filter(n => n.id !== nodeId);
  if (nodes.length === before) return false;
  const cables = listCables().map(c => c.id === cableId ? { ...c, nodes } : c);
  state.setState({ cables });
  state.markDirty();
  return true;
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
    if (!step) return;
    // Cascade resolution (V0.3.0.151): a cable's arrangement at this step is the
    // nearest state-defining entry ≤ this step, not the step's own (which is empty
    // for non-defining steps). Handles jumps + within-state nav uniformly.
    applyStepSnapshot(resolveCableSnapshotAtStep(step.id));
  });
}

// Re-export schema factories so UI / tests can build records without
// reaching back into core/schema.js directly.
export { createCable, createCableNode, createCableSocket, generateId };
