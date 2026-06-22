/**
 * SBS — Cables render
 * ====================
 * Three.js visualisation for the data layer in `cables.js`. Owns one
 * `THREE.Group` named CableRoot mounted directly on `sceneCore.scene`
 * (NOT under rootGroup — cables shouldn't be torn down by tree
 * cleanup) and rebuilds per-cable subgroups whenever state.cables
 * changes.
 *
 * C2 scope:
 *   • Cylinder segments between consecutive cable nodes (straight
 *     only — `style.type === 'straight'`. catenary/bezier slot in C9).
 *   • Sphere visual at each node.
 *   • Per-frame tick refreshes mesh-anchored world positions and
 *     re-poses segments without rebuilding geometry (unit-length
 *     cylinders stretched via scale.y → cheap).
 *   • Cache write-through every tick the mesh is alive (seeds the
 *     3-tier resolver's cache so model removal hands off cleanly).
 *
 * NOT in C2 (later phases):
 *   • Sockets (C4)
 *   • Selection / hover visuals (C5)
 *   • Right-click / re-anchor / branching UI (C6, C7)
 *   • Highlight colour, global scale UI (C9 — globalScale already
 *     read from state but the slider is wired in C9)
 *
 * Data flow:
 *   state.cables changes → _refreshAll rebuilds geometry
 *   sceneCore tick → _tickAnchorRefresh updates positions in place
 */

import state    from '../core/state.js';
import sceneCore from '../core/scene.js';
import * as clock from '../core/clock.js';
import { resolveNodeWorldPosition, listCables } from './cables.js';
import { socketActualSize, cableEffectiveRadius } from './actions.js';
import steps from './steps.js';   // for object3dById fallback in anchor resolution

// ─── Module state ────────────────────────────────────────────────────────

let _cableRoot       = null;        // THREE.Group on sceneCore.scene
let _cableSubgroups  = new Map();   // cableId → { group, points: [meshes], segments: [meshes] }
let _tickUnsub       = null;
let _initialised     = false;

// Geometry templates (created once, reused via clone)
let _UNIT_CYLINDER   = null;        // CylinderGeometry(1, 1, 1, 12) — scaled per-segment
let _UNIT_SPHERE     = null;        // SphereGeometry(1, 16, 16)     — scaled per-point
let _UNIT_BOX        = null;        // BoxGeometry(1, 1, 1)          — scaled per-socket

// ─── Init ────────────────────────────────────────────────────────────────

/**
 * Mount CableRoot on the scene and start the per-frame ticker.
 * Idempotent. Called from main.js after sceneCore is up.
 */
export function initCableRender() {
  if (_initialised) return;
  if (typeof window === 'undefined' || !window.THREE) {
    console.warn('[cables-render] THREE not available — render disabled.');
    return;
  }
  if (!sceneCore?.scene) {
    console.warn('[cables-render] sceneCore.scene missing — call sceneCore.init first.');
    return;
  }

  _UNIT_CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false);
  _UNIT_SPHERE   = new THREE.SphereGeometry(1, 16, 16);
  _UNIT_BOX      = new THREE.BoxGeometry(1, 1, 1);

  _cableRoot = new THREE.Group();
  _cableRoot.name = 'CableRoot';
  sceneCore.scene.add(_cableRoot);

  // Rebuild on data changes — covers create / delete / property edits.
  state.on('change:cables',              _refreshAll);
  state.on('change:cableGlobalScale',    _refreshAll);
  state.on('change:cableGlobalRadius',   _refreshAll);
  state.on('change:cableHighlightColor', _refreshAll);

  // Phase A: re-apply per-point selection highlight on selection change.
  // Cheap — no geometry rebuild, just material emissive flips.
  state.on('change:selectedCablePoint',  _applySelectionHighlight);
  state.on('change:selectedCablePoints', _applySelectionHighlight);   // V0.3.0.119 multi
  // V0.3.0.120 — selected-cable node markers (emissive + on-top now; the per-frame
  // tick rescales them via _pointScaleFor, so request a render to kick it).
  state.on('change:selectedCableId', () => { _applySelectionHighlight(); sceneCore.requestRender?.(); });
  // E2: same for socket selection.
  state.on('change:selectedCableSocket', _applySelectionHighlight);

  // Per-frame anchor sync — folds into existing render loop, no new rAF.
  _tickUnsub = sceneCore.addTickHook(_tickAnchorRefresh);

  _initialised = true;
  _refreshAll();
}

/**
 * Phase A: returns every cable-point sphere mesh as a flat array, for
 * use as a raycast target list in main.js. Empty when render isn't
 * initialised or no cables exist. Mesh `userData` carries `{ cableId,
 * nodeId }` set by `_rebuildCable`.
 */
export function getCablePointMeshes() {
  const out = [];
  for (const entry of _cableSubgroups.values()) {
    for (const m of entry.points) out.push(m);
  }
  return out;
}

/**
 * Phase D: returns every cable-segment cylinder mesh as a flat array.
 * Mesh `userData` carries `{ cableId, fromNodeId, toNodeId }`. Used
 * by main.js to drive a "Insert point here" right-click on a segment.
 */
export function getCableSegmentMeshes() {
  const out = [];
  for (const entry of _cableSubgroups.values()) {
    for (const m of entry.segments) out.push(m);
  }
  return out;
}

/**
 * E2: returns every cable-socket box mesh as a flat array. Mesh
 * `userData` carries `{ cableId, nodeId, kind:'socket' }`. Used for
 * socket-pick raycasting in main.js.
 */
export function getCableSocketMeshes() {
  const out = [];
  for (const entry of _cableSubgroups.values()) {
    for (const m of (entry.sockets || [])) out.push(m);
  }
  return out;
}

// ─── Cable phase animation (H1) ──────────────────────────────────────────
//
// Per-step transitions for cable visibility (opacity fade) and colour
// (lerp). Driven by steps.js' phase runner — at the start of the
// 'cable' phase it calls beginCableTransitions(toSnap, durationMs,
// easeFn, onDone). The runner awaits onDone to know when to move on.
//
// During the transition we override material opacity + colour
// directly. _refreshAll on completion (or via state.cables update)
// resyncs to the cable's final state.

let _cableTransitions = new Map();    // cableId → transition record
let _cableTransitionDoneCb = null;

// Diagnostic (V0.3.0.139) — window.sbsDiag.cableTrace = true logs the plug/unplug
// travel timeline: BEGIN (from/to pos + facing), per-frame rendered box pose,
// applyStepSnapshot timing, DONE. Record one plug/unplug cycle and read it back.
const _CT = () => (typeof window !== 'undefined' && !!window.sbsDiag?.cableTrace);
function _ctrace(msg) { if (_CT()) console.log(`[cableTrace] ${msg}`); }
const _fmtV = (v) => v ? `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}` : 'null';
const _fmtQ = (q) => q ? `${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)},${q.w.toFixed(2)}` : 'null';
let _ctTail = 0, _ctFrame = 0;   // log a tail of frames AFTER the transition (catches end-snap)

export function beginCableTransitions(toCablesSnap, durationMs, easeFn, onDone) {
  // Resolve any in-flight transition so a prior phase await unblocks.
  if (_cableTransitionDoneCb) {
    const prev = _cableTransitionDoneCb;
    _cableTransitionDoneCb = null;
    prev();
  }
  _cableTransitions.clear();

  const startMs = clock.now();
  const cables  = listCables();
  const highlightColor = state.get('cableHighlightColor') ?? '#22d3ee';

  for (const cable of cables) {
    const fromVisible   = cable.visible !== false;
    const toEntry       = toCablesSnap?.[cable.id];
    const toVisible     = toEntry?.visible   !== undefined ? !!toEntry.visible   : fromVisible;
    const fromHighlight = !!cable.highlight;
    const toHighlight   = toEntry?.highlight !== undefined ? !!toEntry.highlight : fromHighlight;
    const baseColor     = cable.style?.color ?? '#ffb24a';
    const fromColorHex  = fromHighlight ? highlightColor : baseColor;
    const toColorHex    = toHighlight   ? highlightColor : baseColor;

    // Cable morph — per-node POSE lerp. FROM = live node values (captured now,
    // before applyStepSnapshot sets TO on step:applied); TO = snapshot. Only nodes
    // that actually change are kept. pos=free world pos (V0.3.0.126); anc=mesh
    // anchored offset; sq=socket facing (V0.3.0.128).
    let fromPos = null, toPos = null, hasPos = false;
    let fromAnc = null, toAnc = null, hasAnc = false;
    let fromSQ  = null, toSQ  = null, hasSQ  = false;
    let conn    = null, hasConn = false;   // V0.3.0.134 — socket plug travel paths
    const near = (a, b, n) => { for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) >= 1e-4) return false; return true; };
    const _resCtx = { makeVec3: (x, y, z) => new THREE.Vector3(x, y, z), object3dById: steps.object3dById };
    const toNodes = toEntry?.nodes;
    if (toNodes && typeof toNodes === 'object') {
      for (const n of (cable.nodes || [])) {
        const o = toNodes[n.id];
        if (!o) continue;
        const pose = Array.isArray(o) ? { pos: o } : o;   // legacy array = free position
        if (n.anchorType === 'free' && Array.isArray(n.position) && Array.isArray(pose.pos)
            && !near(n.position, pose.pos, 3)) {
          if (!fromPos) { fromPos = new Map(); toPos = new Map(); }
          fromPos.set(n.id, n.position.slice()); toPos.set(n.id, pose.pos.slice()); hasPos = true;
        }
        if (n.anchorType === 'mesh' && Array.isArray(n.anchorLocal) && Array.isArray(pose.anc)
            && !near(n.anchorLocal, pose.anc, 3)) {
          if (!fromAnc) { fromAnc = new Map(); toAnc = new Map(); }
          fromAnc.set(n.id, n.anchorLocal.slice()); toAnc.set(n.id, pose.anc.slice()); hasAnc = true;
        }
        const cq = n.anchorType === 'mesh' ? n.socket?.localQuaternion : n.socket?.quaternion;
        if (n.socket && Array.isArray(cq) && cq.length === 4 && Array.isArray(pose.sq) && pose.sq.length === 4
            && !near(cq, pose.sq, 4)) {
          if (!fromSQ) { fromSQ = new Map(); toSQ = new Map(); }
          fromSQ.set(n.id, cq.slice()); toSQ.set(n.id, pose.sq.slice()); hasSQ = true;
        }
        // Socket PLUG transition (V0.3.0.134) — the connector TRAVELS to/from its
        // plugged position (reposition→pause→assemble), overriding the jump. FROM =
        // live plug state (before applyStepSnapshot sets TO); resolve both states.
        if (n.socket?.connectTarget) {
          const toPlugged   = (typeof pose.pl === 'boolean') ? pose.pl : !!n.socket.plugged;
          const fromPlugged = !!n.socket.plugged;
          if (fromPlugged !== toPlugged) {
            const fromR  = resolveNodeWorldPosition(n, _resCtx);
            const fromWQ = _socketWorldQuat(n);                 // FROM-state facing
            // Commit the plug state EARLY (don't restore) so when the travel override
            // clears at the end the socket is already in its TO state — no end snap
            // (was: snap to state-0 then state-1). V0.3.0.137.
            n.socket.plugged = toPlugged;
            const toR  = resolveNodeWorldPosition(n, _resCtx);
            const toWQ = _socketWorldQuat(n);                   // TO-state facing
            if (fromR.pos && toR.pos) {
              const fromV = new THREE.Vector3(fromR.pos[0], fromR.pos[1], fromR.pos[2]);
              const toV   = new THREE.Vector3(toR.pos[0],   toR.pos[1],   toR.pos[2]);
              const d = socketActualSize(cable, n.socket).d * (state.get('cableGlobalScale') ?? 1);
              const normal  = toWQ ? new THREE.Vector3(0, 0, 1).applyQuaternion(toWQ).normalize()
                                   : new THREE.Vector3(0, 1, 0);
              const seated  = toPlugged ? toV : fromV;                     // the connected end
              const approach = seated.clone().addScaledVector(normal, Math.max(d, 1));   // back off by ~1 depth
              if (!conn) conn = new Map();
              conn.set(n.id, {
                from: fromV, to: toV, approach,
                fromQ: fromWQ ? [fromWQ.x, fromWQ.y, fromWQ.z, fromWQ.w] : null,
                toQ:   toWQ   ? [toWQ.x,   toWQ.y,   toWQ.z,   toWQ.w]   : null,   // animate the rotation too
              });
              hasConn = true;
              _ctrace(`BEGIN cable=${cable.id} node=${n.id} ${fromPlugged}->${toPlugged} `
                + `from=(${_fmtV(fromV)}) to=(${_fmtV(toV)}) approach=(${_fmtV(approach)}) `
                + `fromQ=(${fromWQ ? _fmtQ(fromWQ) : '-'}) toQ=(${toWQ ? _fmtQ(toWQ) : '-'}) dur=${durationMs}`);
            }
          }
        }
      }
    }

    if (fromVisible === toVisible && fromColorHex === toColorHex && !hasPos && !hasAnc && !hasSQ && !hasConn) continue;

    _cableTransitions.set(cable.id, {
      fromOpacity: fromVisible ? 1 : 0,
      toOpacity:   toVisible   ? 1 : 0,
      fromColor:   new THREE.Color(fromColorHex),
      toColor:     new THREE.Color(toColorHex),
      fromPos, toPos, hasPos,
      fromAnc, toAnc, hasAnc,
      fromSQ,  toSQ,  hasSQ,
      conn,    hasConn,
      startMs, durationMs, easeFn,
    });
  }

  // Seed initial material state so frame 0 of the lerp is correct.
  // Materials are born transparent in _rebuildCable so we just nudge
  // opacity / colour here.
  for (const [cableId, t] of _cableTransitions) {
    const entry = _cableSubgroups.get(cableId);
    if (!entry) continue;
    entry.group.visible = true;   // force on for the fade window
    for (const m of entry.points)   { m.material.opacity = t.fromOpacity; m.material.color.copy(t.fromColor); }
    for (const m of entry.segments) { m.material.opacity = t.fromOpacity; m.material.color.copy(t.fromColor); }
    for (const m of (entry.sockets || [])) { m.material.opacity = t.fromOpacity; }
  }

  if (_cableTransitions.size === 0) {
    if (onDone) onDone();
    return;
  }
  _cableTransitionDoneCb = onDone || null;
}

/**
 * H1 snap: for snapCurrentToFinal — fast-forward all in-flight cable
 * transitions to their target state and resolve the done callback.
 */
export function snapCableTransitionsToFinal() {
  if (!_cableTransitions.size) {
    if (_cableTransitionDoneCb) {
      const cb = _cableTransitionDoneCb;
      _cableTransitionDoneCb = null;
      cb();
    }
    return;
  }
  for (const [cableId, t] of _cableTransitions) {
    const entry = _cableSubgroups.get(cableId);
    if (!entry) continue;
    for (const m of entry.points)   { m.material.opacity = t.toOpacity; m.material.color.copy(t.toColor); }
    for (const m of entry.segments) { m.material.opacity = t.toOpacity; m.material.color.copy(t.toColor); }
    for (const m of (entry.sockets || [])) { m.material.opacity = t.toOpacity; }
    entry._morphPos = null; entry._morphAnchor = null; entry._morphSockQuat = null; entry._morphConnect = null; entry._morphConnQuat = null;   // drop morph; pose is now TO
  }
  _cableTransitions.clear();
  if (_cableTransitionDoneCb) {
    const cb = _cableTransitionDoneCb;
    _cableTransitionDoneCb = null;
    cb();
  }
}

function _advanceCableTransitions(nowMs) {
  if (!_cableTransitions.size) return;
  if (_CT()) _ctTail = 14;   // keep tracing ~14 frames past completion
  let allDone = true;
  for (const [cableId, t] of _cableTransitions) {
    const elapsed = nowMs - t.startMs;
    const raw     = Math.min(1, Math.max(0, elapsed / t.durationMs));
    const u       = t.easeFn ? t.easeFn(raw) : raw;
    const opacity = t.fromOpacity + (t.toOpacity - t.fromOpacity) * u;
    const color   = t.fromColor.clone().lerp(t.toColor, u);
    const entry   = _cableSubgroups.get(cableId);
    if (entry) {
      for (const m of entry.points)   { m.material.opacity = opacity; m.material.color.copy(color); }
      for (const m of entry.segments) { m.material.opacity = opacity; m.material.color.copy(color); }
      for (const m of (entry.sockets || [])) { m.material.opacity = opacity; }
      // Lerped poses for _tickAnchorRefresh to render (runs right after this in
      // the same tick). _morphPos = free-node WORLD positions (V0.3.0.126).
      // _morphAnchor = mesh-anchored OFFSETS (mesh-local; the tick still composes
      // them with the host's live matrix → morph AND auto-follow). _morphSockQuat =
      // socket facing. Nodes not listed resolve live (V0.3.0.128).
      if (t.hasPos && t.fromPos) {
        let mp = entry._morphPos; if (!mp) { mp = new Map(); entry._morphPos = mp; }
        for (const [nodeId, fp] of t.fromPos) {
          const tp = t.toPos.get(nodeId);
          mp.set(nodeId, new THREE.Vector3(
            fp[0] + (tp[0] - fp[0]) * u, fp[1] + (tp[1] - fp[1]) * u, fp[2] + (tp[2] - fp[2]) * u));
        }
      }
      if (t.hasAnc && t.fromAnc) {
        let ma = entry._morphAnchor; if (!ma) { ma = new Map(); entry._morphAnchor = ma; }
        for (const [nodeId, fa] of t.fromAnc) {
          const ta = t.toAnc.get(nodeId);
          ma.set(nodeId, [fa[0] + (ta[0] - fa[0]) * u, fa[1] + (ta[1] - fa[1]) * u, fa[2] + (ta[2] - fa[2]) * u]);
        }
      }
      if (t.hasSQ && t.fromSQ) {
        let mq = entry._morphSockQuat; if (!mq) { mq = new Map(); entry._morphSockQuat = mq; }
        for (const [nodeId, fq] of t.fromSQ) {
          const tq = t.toSQ.get(nodeId);
          const q = new THREE.Quaternion(fq[0], fq[1], fq[2], fq[3])
            .slerp(new THREE.Quaternion(tq[0], tq[1], tq[2], tq[3]), u);
          mq.set(nodeId, [q.x, q.y, q.z, q.w]);
        }
      }
      // V0.3.0.134 — socket plug TRAVEL: reposition (from→approach) → pause →
      // assemble (approach→to). Parks a world pos in _morphConnect, which the tick
      // honours FIRST (overriding the plugged jump). Linear segments, eased overall.
      if (t.hasConn && t.conn) {
        let mc = entry._morphConnect; if (!mc) { mc = new Map(); entry._morphConnect = mc; }
        let mq = entry._morphConnQuat;
        for (const [nodeId, c] of t.conn) {
          let p;
          if (u <= 0.6)      p = c.from.clone().lerp(c.approach, u / 0.6);
          else if (u <= 0.75) p = c.approach.clone();                       // pause at approach
          else                p = c.approach.clone().lerp(c.to, (u - 0.75) / 0.25);
          mc.set(nodeId, p);
          // Rotate the connector as it travels (FROM-facing → TO-facing). V0.3.0.137.
          if (c.fromQ && c.toQ) {
            if (!mq) { mq = new Map(); entry._morphConnQuat = mq; }
            const q = new THREE.Quaternion(c.fromQ[0], c.fromQ[1], c.fromQ[2], c.fromQ[3])
              .slerp(new THREE.Quaternion(c.toQ[0], c.toQ[1], c.toQ[2], c.toQ[3]), u);
            mq.set(nodeId, [q.x, q.y, q.z, q.w]);
          }
        }
      }
    }
    if (raw < 1) allDone = false;
  }
  if (allDone) {
    const _cablesNow = listCables();
    for (const [cableId, t] of _cableTransitions) {
      const entry = _cableSubgroups.get(cableId);
      // V0.3.0.140 — COMMIT the TO node poses to the live cable the instant the morph
      // releases, so the tick resolves the final state immediately. Without this the
      // non-socket nodes briefly resolve their OLD (state-0) positions until
      // applyStepSnapshot fires a frame or two later — the "snap to 0 then 1" at the
      // end (the socket already avoided this via the early plug commit).
      const c = _cablesNow.find(x => x.id === cableId);
      if (c) {
        if (t.hasPos && t.toPos) for (const [nid, tp] of t.toPos) { const nd = c.nodes?.find(n => n.id === nid); if (nd && Array.isArray(nd.position))    nd.position    = tp.slice(); }
        if (t.hasAnc && t.toAnc) for (const [nid, ta] of t.toAnc) { const nd = c.nodes?.find(n => n.id === nid); if (nd && Array.isArray(nd.anchorLocal)) nd.anchorLocal = ta.slice(); }
        if (t.hasSQ  && t.toSQ)  for (const [nid, tq] of t.toSQ)  { const nd = c.nodes?.find(n => n.id === nid); if (nd?.socket) { if (nd.anchorType === 'mesh') nd.socket.localQuaternion = tq.slice(); else nd.socket.quaternion = tq.slice(); } }
      }
      if (t.hasConn) _ctrace(`DONE cable=${cableId} — committed TO poses → tick resolves final state`);
      if (entry) { entry._morphPos = null; entry._morphAnchor = null; entry._morphSockQuat = null; entry._morphConnect = null; entry._morphConnQuat = null; }   // done → tick resolves live (now = TO)
    }
    _cableTransitions.clear();
    if (_cableTransitionDoneCb) {
      const cb = _cableTransitionDoneCb;
      _cableTransitionDoneCb = null;
      cb();
    }
  }
}

// ─── Insert-point ghost preview (Phase D follow-up) ──────────────────────
//
// During cable insert-pick mode, main.js calls setInsertHoverPosition
// with the current cursor's world raycast hit so the user sees where
// the new point would land. Yellow, semi-transparent, depthTest off
// so it's always visible. Sized from the target cable's radius.

let _insertHoverSphere = null;

export function setInsertHoverPosition(worldPos) {
  if (!_cableRoot || !window.THREE) return;
  if (!_insertHoverSphere) {
    _insertHoverSphere = new THREE.Mesh(
      _UNIT_SPHERE,
      new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        emissive: 0xfacc15,
        emissiveIntensity: 0.7,
        transparent: true,
        opacity: 0.75,
        depthTest: false,
      }),
    );
    _insertHoverSphere.renderOrder = 999;
    _insertHoverSphere.visible = false;
    _cableRoot.add(_insertHoverSphere);
  }
  if (!worldPos) {
    _insertHoverSphere.visible = false;
    return;
  }
  _insertHoverSphere.visible = true;
  _insertHoverSphere.position.copy(worldPos);
  // Size from the active insert target's cable so it visually matches
  // the host cable's points.
  const target = state.get('cableInsertPickingTarget');
  let radius = 3;
  if (target) {
    const c = listCables().find(x => x.id === target.cableId);
    radius = c?.style?.radius ?? 3;
  }
  _insertHoverSphere.scale.setScalar(radius * 1.4);
}

// ─── Full rebuild ────────────────────────────────────────────────────────

function _refreshAll() {
  if (!_cableRoot) return;
  // H1 guard: while a cable phase animation is in flight, defer the
  // full rebuild — _refreshAll tears down + recreates materials,
  // which would reset transparent/opacity in the middle of a fade.
  if (_cableTransitions.size > 0) return;
  const cables = listCables();
  const liveIds = new Set(cables.map(c => c.id));

  // Drop subgroups for cables that no longer exist.
  for (const [id, entry] of _cableSubgroups) {
    if (!liveIds.has(id)) {
      _disposeSubgroup(entry);
      _cableRoot.remove(entry.group);
      _cableSubgroups.delete(id);
    }
  }

  // Build / rebuild per-cable groups.
  for (const cable of cables) {
    let entry = _cableSubgroups.get(cable.id);
    if (!entry) {
      entry = { group: new THREE.Group(), points: [], segments: [], sockets: [] };
      entry.group.name = `Cable_${cable.id}`;
      _cableRoot.add(entry.group);
      _cableSubgroups.set(cable.id, entry);
    }
    _rebuildCable(cable, entry);
    entry.group.visible = cable.visible !== false;
  }

  // Phase A: re-apply emissive on the (possibly new) point materials.
  _applySelectionHighlight();
}

function _rebuildCable(cable, entry) {
  // Tear down existing geometry. The unit geometries are shared but
  // each mesh has a per-instance material to honour the cable's
  // colour / highlight; dispose materials only.
  for (const m of entry.points)   { m.material?.dispose?.(); entry.group.remove(m); }
  for (const m of entry.segments) { m.material?.dispose?.(); if (m.geometry && m.geometry !== _UNIT_CYLINDER) m.geometry.dispose?.(); entry.group.remove(m); }
  for (const m of (entry.sockets || [])) { m.material?.dispose?.(); entry.group.remove(m); }
  entry.points   = [];
  entry.segments = [];
  entry.sockets  = [];

  // ctx.object3dById = fallback lookup map for the cable resolver.
  // When node.object3d on a data-tree node is stale (e.g. after a relink
  // or model-source-bake desync), the resolver falls back to this map
  // before giving up to the cached worldPos.
  const ctx = {
    makeVec3:     (x, y, z) => new THREE.Vector3(x, y, z),
    object3dById: steps.object3dById,
  };
  const globalScale = state.get('cableGlobalScale') ?? 1.0;
  // Phase G: effective radius = cableGlobalRadius × per-cable size %.
  const radius      = cableEffectiveRadius(cable) * globalScale;
  const colorHex    = cable.highlight
    ? (state.get('cableHighlightColor') ?? '#22d3ee')
    : (cable.style?.color ?? '#ffb24a');
  const color = new THREE.Color(colorHex);
  entry._color = color;   // remembered for per-tick flexible-tube rebuilds

  // Resolve every node's current world position once. Side effect:
  // refreshes cachedWorldPos on the data so future step-jumps + missing
  // mesh handoffs are smooth.
  const positions = (cable.nodes || []).map(n => {
    const r = resolveNodeWorldPosition(n, ctx);
    return r.pos ? new THREE.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
  });

  // Point spheres — one per resolvable node. Unresolvable nodes
  // (anchorless + no cache) get skipped silently.
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (!p) continue;
    const sphere = new THREE.Mesh(
      _UNIT_SPHERE,
      new THREE.MeshStandardMaterial({
        color: color.clone(), metalness: 0.2, roughness: 0.6,
        // H1: born transparent so opacity tweens during the cable phase
        // engage the alpha pipeline immediately (flipping `transparent`
        // at runtime didn't take consistently in MeshStandardMaterial).
        transparent: true, opacity: 1,
      }),
    );
    sphere.position.copy(p);
    sphere.userData.cableId = cable.id;
    sphere.userData.nodeId  = cable.nodes[i].id;
    sphere.scale.setScalar(_pointScaleFor(cable.id, cable.nodes[i].id, radius));
    entry.group.add(sphere);
    entry.points.push(sphere);
  }

  // Cable body — one spline tube when flexible, else cheap cylinder segments.
  _buildSegments(cable, entry, positions, radius, color);

  // C5-E1: socket boxes — one per node that carries a socket. Sized
  // by socket.size, coloured by socket.color (independent of cable
  // colour / highlight), oriented by the host mesh's world quat
  // composed with socket.localQuaternion. Position offset by half-
  // depth along socket-local +Z so the back face touches the cable
  // point (matches schema doc + persistSocketFromVisual inverse math).
  for (let i = 0; i < (cable.nodes || []).length; i++) {
    const node = cable.nodes[i];
    if (!node?.socket) continue;
    const p = positions[i];
    if (!p) continue;
    const wq = _socketWorldQuat(node);
    if (!wq) continue;
    // Size = cable-radius * BASE_* * (percent / 100), with global scale.
    const actual = socketActualSize(cable, node.socket);
    const w = actual.w * globalScale;
    const h = actual.h * globalScale;
    const d = actual.d * globalScale;
    const sockColor = new THREE.Color(node.socket.color || '#ff9d57');
    const box = new THREE.Mesh(
      _UNIT_BOX,
      new THREE.MeshStandardMaterial({
        color: sockColor, metalness: 0.3, roughness: 0.5,
        transparent: true, opacity: 1,
      }),
    );
    box.scale.set(w, h, d);
    box.quaternion.copy(wq);
    // Centre offset: +d/2 along the socket's world +Z so the BACK face
    // (-Z in box-local) touches the cable point.
    // Front face touches the cable point; the box extends the other
     // way along its local +Z. With the IK shift on socket creation
     // (addCableSocket lifts the anchor by d along the normal), the
     // back face lands at the original anchored surface — the
     // "plugged in" look. Without that shift, the box renders inside
     // the surface, signalling that the user should move the point.
    const zWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(wq);
    box.position.copy(p).addScaledVector(zWorld, -d / 2);
    box.userData.cableId   = cable.id;
    box.userData.nodeId    = node.id;
    box.userData.kind      = 'socket';
    entry.group.add(box);
    entry.sockets.push(box);
  }
}

/**
 * Compute a socket's world-space quaternion. Mesh-anchored hosts
 * compose the mesh's world quat with socket.localQuaternion (or fall
 * back to a quaternion derived from node.normalLocal so a freshly-
 * added socket sits flush on the surface). Branch / free hosts use
 * socket.quaternion directly. Returns null when nothing is available
 * — caller skips that socket's render.
 */
function _socketWorldQuat(node) {
  const T = window.THREE;
  const sock = node.socket;
  if (!sock) return null;

  // V0.3.0.130 — PLUGGED socket: orient to the connection TARGET's surface, the
  // same way default placement aligns to its own host (local +Z → surface normal).
  // So a plugged socket seats flush + facing the destination, not its old host.
  const ct = sock.plugged ? sock.connectTarget : null;
  if (ct?.nodeId) {
    const tObj = state.get('nodeById')?.get?.(ct.nodeId)?.object3d;
    if (tObj) {
      const tQ = new T.Quaternion();
      tObj.getWorldQuaternion(tQ);
      // Editable plugged orientation (target-local), user-adjustable via rotate.
      if (Array.isArray(ct.localQuaternion) && ct.localQuaternion.length === 4) {
        return tQ.multiply(new T.Quaternion(
          ct.localQuaternion[0], ct.localQuaternion[1], ct.localQuaternion[2], ct.localQuaternion[3]));
      }
      if (Array.isArray(ct.normalLocal) && ct.normalLocal.length === 3) {   // legacy default
        const wn = new T.Vector3(ct.normalLocal[0], ct.normalLocal[1], ct.normalLocal[2])
          .applyQuaternion(tQ).normalize();
        return new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), wn);
      }
      return tQ;
    }
  }

  // Mesh-anchored: compose meshWorldQuat * (sock.localQuaternion or
  // a normal-derived default).
  if (node.anchorType === 'mesh' && node.nodeId) {
    const sceneNode = state.get('nodeById')?.get?.(node.nodeId);
    const obj = sceneNode?.object3d;
    if (!obj) return null;
    const meshQ = new T.Quaternion();
    obj.getWorldQuaternion(meshQ);
    if (Array.isArray(sock.localQuaternion) && sock.localQuaternion.length === 4) {
      const local = new T.Quaternion(
        sock.localQuaternion[0], sock.localQuaternion[1],
        sock.localQuaternion[2], sock.localQuaternion[3],
      );
      return meshQ.clone().multiply(local);
    }
    if (Array.isArray(node.normalLocal) && node.normalLocal.length === 3) {
      // Default: orient socket's local +Z to the surface normal so the
      // box "stands proud" of the face.
      const normalLocal = new T.Vector3(
        node.normalLocal[0], node.normalLocal[1], node.normalLocal[2],
      );
      const worldNormal = normalLocal.applyQuaternion(meshQ);
      const q = new T.Quaternion();
      q.setFromUnitVectors(new T.Vector3(0, 0, 1), worldNormal.clone().normalize());
      return q;
    }
    return meshQ;
  }

  // Branch / free hosts.
  if (Array.isArray(sock.quaternion) && sock.quaternion.length === 4) {
    return new T.Quaternion(
      sock.quaternion[0], sock.quaternion[1], sock.quaternion[2], sock.quaternion[3],
    );
  }
  return new T.Quaternion();   // identity fallback
}

/**
 * Position + orient a unit-length cylinder mesh between world-space
 * points a and b, stretched to length and scaled by radius. Centre
 * the cylinder on the midpoint; rotate so its native Y axis points
 * from a to b.
 */
function _poseCylinder(mesh, a, b, radius) {
  const dir  = new THREE.Vector3().subVectors(b, a);
  const len  = dir.length();
  if (len < 1e-6) {
    mesh.visible = false;   // degenerate — coincident endpoints
    return;
  }
  mesh.visible = true;
  const mid  = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  mesh.position.copy(mid);
  // Cylinder native is along Y; rotate Y → dir.
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  );
  mesh.scale.set(radius, len, radius);
}

// ── Flexible cables (V0.3.0.24): smooth spline tube through the nodes ────────

/** Socket emergence axis (world +Z) for a node, or null if it has no socket. */
function _socketAxis(node) {
  if (!node?.socket) return null;
  const wq = _socketWorldQuat(node);
  if (!wq) return null;
  return new THREE.Vector3(0, 0, 1).applyQuaternion(wq).normalize();
}

/**
 * CatmullRom curve through the resolvable node positions. A socketed ENDPOINT
 * gets a phantom control point a short way along its socket axis, so the cable
 * emerges/arrives straight out of the socket (plugged-in) before curving.
 */
function _buildFlexCurve(cable, positions) {
  const pts = [], idxs = [];
  for (let i = 0; i < positions.length; i++) {
    if (positions[i]) { pts.push(positions[i]); idxs.push(i); }
  }
  if (pts.length < 2) return null;
  const nodes = cable.nodes || [];
  const handleFrac = state.get('cableFlexHandle') ?? 0.4;
  const last = pts.length - 1;

  const ctrl = [pts[0]];
  const startAxis = _socketAxis(nodes[idxs[0]]);
  if (startAxis) ctrl.push(pts[0].clone().addScaledVector(startAxis, handleFrac * pts[0].distanceTo(pts[1])));
  for (let k = 1; k < last; k++) ctrl.push(pts[k]);
  const endAxis = _socketAxis(nodes[idxs[last]]);
  if (endAxis) ctrl.push(pts[last].clone().addScaledVector(endAxis, handleFrac * pts[last].distanceTo(pts[last - 1])));
  ctrl.push(pts[last]);

  return new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.5);
}

/** Tube mesh skinned along the flexible curve. */
function _makeFlexTube(curve, radius, color, cableId) {
  const segs = Math.min(240, Math.max(24, curve.points.length * 24));
  const mesh = new THREE.Mesh(
    new THREE.TubeGeometry(curve, segs, radius, 8, false),
    new THREE.MeshStandardMaterial({
      color: color.clone(), metalness: 0.2, roughness: 0.6, transparent: true, opacity: 1,
    }),
  );
  mesh.userData.cableId = cableId;
  mesh.userData.kind    = 'cableTube';
  return mesh;
}

/** Cheap change-detector for the per-tick: flexible flag + quantized positions. */
function _posHash(cable, positions) {
  let s = cable.flexible ? 'F' : 'S';
  for (const p of positions) s += p ? `|${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}` : '|x';
  return s;
}

/** Build the cable BODY: one spline tube when flexible, else cylinder segments. */
function _buildSegments(cable, entry, positions, radius, color) {
  for (const m of entry.segments) {
    m.material?.dispose?.();
    if (m.geometry && m.geometry !== _UNIT_CYLINDER) m.geometry.dispose?.();
    entry.group.remove(m);
  }
  entry.segments   = [];
  entry._isFlexible = !!cable.flexible;
  if (cable.flexible) {
    const curve = _buildFlexCurve(cable, positions);
    if (curve) {
      const tube = _makeFlexTube(curve, radius, color, cable.id);
      entry.group.add(tube);
      entry.segments.push(tube);
    }
    entry._posHash = _posHash(cable, positions);
  } else {
    for (let i = 0; i < positions.length - 1; i++) {
      const a = positions[i], b = positions[i + 1];
      if (!a || !b) continue;
      const seg = new THREE.Mesh(_UNIT_CYLINDER, new THREE.MeshStandardMaterial({
        color: color.clone(), metalness: 0.2, roughness: 0.6, transparent: true, opacity: 1,
      }));
      _poseCylinder(seg, a, b, radius);
      seg.userData.cableId    = cable.id;
      seg.userData.fromNodeId = cable.nodes[i].id;
      seg.userData.toNodeId   = cable.nodes[i + 1].id;
      entry.group.add(seg);
      entry.segments.push(seg);
    }
  }
}

/**
 * Phase A: walk every point mesh and apply selection highlight —
 * emissive on the selected sphere, zero on the rest. Fires on
 * change:selectedCablePoint and at the end of _refreshAll. Scale
 * boost is applied by _tickAnchorRefresh (which also handles per-
 * frame radius rewrites) so we don't fight it here.
 */
const _SELECT_EMISSIVE = new THREE.Color('#22d3ee');
const _MARKER_EMISSIVE = new THREE.Color('#0ea5e9');   // V0.3.0.120 — node pick markers
function _applySelectionHighlight() {
  const selPt   = state.get('selectedCablePoint');
  const selSock = state.get('selectedCableSocket');
  // V0.3.0.119 — highlight EVERY multi-selected point, not just the primary.
  const selSet  = new Set((state.get('selectedCablePoints') || []).map(p => `${p.cableId}:${p.nodeId}`));
  // V0.3.0.120 — the selected cable's nodes ALL get a visible, always-on-top
  // marker so they're easy to see + pick (cable nodes are otherwise tiny).
  const markerCableId = state.get('selectedCableId');
  for (const entry of _cableSubgroups.values()) {
    for (const m of entry.points) {
      const mat = m.material;
      if (!mat?.emissive) continue;
      const isPicked = selSet.has(`${m.userData.cableId}:${m.userData.nodeId}`)
        || (selPt && m.userData.cableId === selPt.cableId && m.userData.nodeId === selPt.nodeId);
      const isMarker = markerCableId && m.userData.cableId === markerCableId;
      if (isPicked) {
        mat.emissive.copy(_SELECT_EMISSIVE);
        mat.emissiveIntensity = 0.9;
      } else if (isMarker) {
        mat.emissive.copy(_MARKER_EMISSIVE);
        mat.emissiveIntensity = 0.55;
      } else {
        mat.emissive.setRGB(0, 0, 0);
        mat.emissiveIntensity = 0;
      }
      // Markers + picked nodes render ON TOP (depthTest off) so they show through
      // the model and are always clickable; others render normally.
      const onTop = isPicked || isMarker;
      mat.depthTest = !onTop;
      m.renderOrder = onTop ? 9000 : 0;
    }
    for (const m of (entry.sockets || [])) {
      const mat = m.material;
      if (!mat?.emissive) continue;
      const isSel = selSock && m.userData.cableId === selSock.cableId && m.userData.nodeId === selSock.nodeId;
      if (isSel) {
        mat.emissive.copy(_SELECT_EMISSIVE);
        mat.emissiveIntensity = 0.6;
      } else {
        mat.emissive.setRGB(0, 0, 0);
        mat.emissiveIntensity = 0;
      }
    }
  }
}

/** Multiplier for the selected point's sphere — applied in tick + rebuild. */
function _pointScaleFor(cableId, nodeId, baseRadius) {
  const sel = state.get('selectedCablePoint');
  const inMulti = (state.get('selectedCablePoints') || [])
    .some(p => p.cableId === cableId && p.nodeId === nodeId);   // V0.3.0.119
  const isSel = inMulti || (sel && sel.cableId === cableId && sel.nodeId === nodeId);
  // V0.3.0.120 — every node of the SELECTED cable inflates into a pick marker so
  // it's easy to see/grab; the picked node(s) inflate the most. Use a floor so the
  // marker is visible even on a very thin cable.
  const isMarker = state.get('selectedCableId') === cableId;
  if (isSel)     return Math.max(baseRadius * 1.8, baseRadius + 6);
  if (isMarker)  return Math.max(baseRadius * 1.5, baseRadius + 4);
  return baseRadius;  // unselected = exactly the cable radius
}

function _disposeSubgroup(entry) {
  for (const m of entry.points)   m.material?.dispose?.();
  for (const m of entry.segments) m.material?.dispose?.();
  for (const m of (entry.sockets || [])) m.material?.dispose?.();
  entry.points   = [];
  entry.segments = [];
  entry.sockets  = [];
}

// ─── Per-frame anchor refresh ────────────────────────────────────────────

/**
 * On every tick, walk mesh-anchored nodes (and branch-start nodes
 * that recurse onto them) and update their visuals in place. We
 * skip the heavy geometry rebuild path — just reposition / scale
 * the existing meshes. If a cable has no mesh-anchored nodes (all
 * free), the work is essentially a couple of map lookups per cable.
 *
 * Optimisation seam for later: a matrixWorld signature check per
 * anchor mesh would skip the work entirely when nothing moved.
 * Today it's cheap enough not to matter at typical cable counts.
 */
function _tickAnchorRefresh() {
  // H1: drive any in-flight cable phase animations first so they advance
  // even when no cables exist yet (e.g. brand-new project) wouldn't
  // matter, but the size check below would skip — keep it ahead.
  _advanceCableTransitions(clock.now());
  if (_CT()) { _ctFrame++; if (_cableTransitions.size === 0 && _ctTail > 0) _ctTail--; }

  if (!_cableRoot || _cableSubgroups.size === 0) return;
  const cables = listCables();
  if (!cables.length) return;
  // ctx.object3dById = fallback for anchor resolution when node.object3d
  // is stale; see cables.js resolveNodeWorldPosition for the failover.
  const ctx = {
    makeVec3:     (x, y, z) => new THREE.Vector3(x, y, z),
    object3dById: steps.object3dById,
  };
  const globalScale = state.get('cableGlobalScale') ?? 1.0;

  for (const cable of cables) {
    const entry = _cableSubgroups.get(cable.id);
    if (!entry) continue;
    if (!entry.group.visible) continue;   // skip hidden cables

    const radius = cableEffectiveRadius(cable) * globalScale;
    // During a cable-shape transition, _advanceCableTransitions (run at the top of
    // this tick) parks lerped poses on entry. Free nodes → world pos in _morphPos
    // (V0.3.0.126). Mesh nodes → lerped OFFSET in _morphAnchor: we temporarily swap
    // the node's anchorLocal and resolve through the host's LIVE matrix, so the
    // point both morphs AND rides the moving part (V0.3.0.128). Unlisted nodes
    // resolve live (auto-follow).
    const morph     = entry._morphPos;
    const morphAnc  = entry._morphAnchor;
    const morphConn = entry._morphConnect;
    const positions = (cable.nodes || []).map(n => {
      // V0.3.0.134 — socket plug TRAVEL wins over everything (incl. the plugged jump).
      if (morphConn && morphConn.has(n.id)) return morphConn.get(n.id).clone();
      if (morph && n.anchorType === 'free' && morph.has(n.id)) return morph.get(n.id).clone();
      if (morphAnc && n.anchorType === 'mesh' && morphAnc.has(n.id)) {
        const saved = n.anchorLocal;
        n.anchorLocal = morphAnc.get(n.id);
        const r = resolveNodeWorldPosition(n, ctx);
        n.anchorLocal = saved;
        return r.pos ? new THREE.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
      }
      const r = resolveNodeWorldPosition(n, ctx);
      return r.pos ? new THREE.Vector3(r.pos[0], r.pos[1], r.pos[2]) : null;
    });

    // V0.3.0.140 — trace the whole cable's node positions (not just the socket) so
    // the OTHER animated nodes' snap/recall (#1/#4) is visible.
    if (_CT() && (_cableTransitions.size > 0 || _ctTail > 0) && (_ctFrame % 3 === 0)) {
      const samp = positions.slice(0, 6).map((p, i) => `${i}:${p ? _fmtV(p) : '-'}`).join(' ');
      _ctrace(`nodes cable=${cable.id} [${samp}]`);
    }

    // Reposition point spheres in lock-step with the resolver output.
    // (Geometry stays — only transforms change.)
    for (let i = 0; i < entry.points.length && i < positions.length; i++) {
      const p = positions[i];
      const sphere = entry.points[i];
      if (!p) { sphere.visible = false; continue; }
      sphere.visible = true;
      sphere.position.copy(p);
      sphere.scale.setScalar(_pointScaleFor(sphere.userData.cableId, sphere.userData.nodeId, radius));
    }

    // Cable body. Flexible: rebuild the spline tube when the flexible flag flips
    // or the path moves (cheap hash gate avoids per-frame rebuilds when static).
    // Straight: just re-pose the cheap cylinders.
    if (cable.flexible || entry._isFlexible) {
      const hash = _posHash(cable, positions);
      if (cable.flexible !== entry._isFlexible || hash !== entry._posHash) {
        _buildSegments(cable, entry, positions, radius, entry._color || new THREE.Color('#ffb24a'));
      }
    } else {
      for (let i = 0; i < entry.segments.length; i++) {
        const a = positions[i];
        const b = positions[i + 1];
        const seg = entry.segments[i];
        if (!a || !b) { seg.visible = false; continue; }
        _poseCylinder(seg, a, b, radius);
      }
    }

    // C5-E1: re-pose socket boxes so they ride the host mesh as it
    // animates. Lookup by userData.nodeId since sockets aren't 1:1
    // indexed against entry.points (only nodes with a socket exist).
    if (entry.sockets && entry.sockets.length) {
      const T = window.THREE;
      const morphSQ   = entry._morphSockQuat;   // V0.3.0.128 — lerped socket facing
      const morphCQ   = entry._morphConnQuat;   // V0.3.0.137 — connect-travel facing (world quat)
      for (const box of entry.sockets) {
        const idx = (cable.nodes || []).findIndex(n => n.id === box.userData.nodeId);
        if (idx < 0) { box.visible = false; continue; }
        const node = cable.nodes[idx];
        const p    = positions[idx];
        if (!p || !node?.socket) { box.visible = false; continue; }
        let wq;
        if (morphCQ && morphCQ.has(node.id)) {
          // Connect travel — use the slerped WORLD facing directly (rotates as it goes).
          const q = morphCQ.get(node.id);
          wq = new T.Quaternion(q[0], q[1], q[2], q[3]);
        } else {
          // Temporarily swap the socket's facing to the morphed value, resolve its
          // WORLD quat through the host's live matrix, then restore.
          const sqKey = node.anchorType === 'mesh' ? 'localQuaternion' : 'quaternion';
          let savedSQ; const hasMorphSQ = morphSQ && morphSQ.has(node.id);
          if (hasMorphSQ) { savedSQ = node.socket[sqKey]; node.socket[sqKey] = morphSQ.get(node.id); }
          wq = _socketWorldQuat(node);
          if (hasMorphSQ) node.socket[sqKey] = savedSQ;
        }
        if (!wq) { box.visible = false; continue; }
        const actual = socketActualSize(cable, node.socket);
        const w = actual.w * globalScale;
        const h = actual.h * globalScale;
        const d = actual.d * globalScale;
        box.visible = true;
        box.scale.set(w, h, d);
        box.quaternion.copy(wq);
        const zWorld = new T.Vector3(0, 0, 1).applyQuaternion(wq);
        box.position.copy(p).addScaledVector(zWorld, -d / 2);
        // Per-frame trace of the connecting socket (during + ~14 frames past the
        // transition) so a recorded cycle shows glide-vs-snap. V0.3.0.139.
        if (_CT() && node.socket.connectTarget && (_cableTransitions.size > 0 || _ctTail > 0) && (_ctFrame % 3 === 0)) {
          _ctrace(`f node=${node.id} boxPos=(${_fmtV(box.position)}) boxQ=(${_fmtQ(box.quaternion)}) `
            + `plug=${node.socket.plugged} mc=${entry._morphConnect?.has(node.id) ? 'Y' : 'n'} `
            + `mcq=${entry._morphConnQuat?.has(node.id) ? 'Y' : 'n'}`);
        }
      }
    }
  }
}

// ─── Teardown (called on scene reset; rarely used) ───────────────────────

export function disposeCableRender() {
  if (_tickUnsub) { _tickUnsub(); _tickUnsub = null; }
  for (const entry of _cableSubgroups.values()) {
    _disposeSubgroup(entry);
    _cableRoot?.remove(entry.group);
  }
  _cableSubgroups.clear();
  if (_cableRoot) {
    sceneCore.scene?.remove(_cableRoot);
    _cableRoot = null;
  }
  _UNIT_CYLINDER?.dispose?.(); _UNIT_CYLINDER = null;
  _UNIT_SPHERE?.dispose?.();   _UNIT_SPHERE   = null;
  _UNIT_BOX?.dispose?.();      _UNIT_BOX      = null;
  _initialised = false;
}
