/**
 * SBS Step Browser — Notes Render
 * ==================================
 * 3D-anchored balloon notes. Each note is a TREE NODE child of its
 * anchor mesh; this module finds every such node, projects its
 * anchor point to screen pixels, and draws a comic-style balloon
 * (HTML div for text, SVG path for the tail).
 *
 * Per-frame work
 * --------------
 * For each note:
 *   1. Resolve anchor mesh in object3dById.
 *   2. World point = mesh.localToWorld(anchorLocal).
 *      Fallback if mesh missing / phantom: use anchorBboxRelative
 *      against the saved mesh bbox so the note keeps a meaningful
 *      position even when the asset is unavailable.
 *   3. Project to canvas pixels via camera.
 *   4. Position balloon DIV at anchorScreen + panelOffset.
 *   5. Draw SVG path from anchorScreen to the balloon edge.
 *   6. Pool DOM nodes — keep one DIV / PATH per note id, reuse them
 *      across frames so we don't thrash the DOM on every frame.
 *
 * The CSS for .sbsNoteBalloon / .sbsNoteTail lives in components.css.
 *
 * Three.js is window.THREE.
 */

import { state }                    from '../core/state.js';
import { sceneCore }                from '../core/scene.js';
import { steps }                    from '../systems/steps.js';
import { computeEffectiveVisibility } from '../core/nodes.js';
import { showContextMenu }          from '../ui/context-menu.js';

let _labelsEl   = null;
let _svgEl      = null;
let _initialized = false;

// Pools, keyed by note id. Each entry is { div, path }.
const _pool = new Map();

// Drag state — set by the balloon's pointerdown listener, cleared on up.
let _drag = null;
//   { noteId, startClientX, startClientY, startOffset:{x,y},
//     beforeOffset:{x,y} } — used for undo entry on commit.

// Edit-text state — when set, rendering keeps the contenteditable alive.
let _editingNoteId = null;

// ─── Init ─────────────────────────────────────────────────────────────────

export function initNotesRender() {
  if (_initialized) return;
  _labelsEl = document.getElementById('notes-overlay-labels');
  _svgEl    = document.getElementById('notes-overlay-svg');
  if (!_labelsEl || !_svgEl) return;
  // Fill the SVG to viewport size — sizing is handled via CSS, but we
  // also need a viewBox that matches pixel coordinates so paths use
  // pixel-space x/y.
  _svgEl.setAttribute('preserveAspectRatio', 'none');
  _initialized = true;
  sceneCore.addTickHook(_renderTick);
  // No state-change subscriptions on purpose. We used to re-render on
  // change:treeData for snappy feedback when notes were added / edited,
  // but that subscription fired DURING applySnapshotInstant — right
  // after rebuildFromTreeSpec (which creates fresh folder Groups with
  // identity matrices) but BEFORE applyAllTransformsToScene wrote the
  // step's transforms back onto those Groups. For one frame the mesh
  // inherited an identity-matrix parent and the note projected to its
  // "home" position, then snapped back on the next rAF tick — exactly
  // the flicker the user reported. The rAF tick (≤ 16 ms) is plenty
  // fast for "instant feedback" on note CRUD too.
}

// ─── Tree walk ────────────────────────────────────────────────────────────

function _collectNotes(node, out = []) {
  if (!node) return out;
  if (node.type === 'note') out.push(node);
  for (const c of (node.children || [])) _collectNotes(c, out);
  return out;
}

// ─── Per-frame render ─────────────────────────────────────────────────────

function _renderTick() {
  if (!_initialized || !_labelsEl || !_svgEl) return;
  if (!sceneCore?.camera || !sceneCore.renderer) return;

  const T = window.THREE;
  if (!T) return;

  const treeData = state.get('treeData');
  const notes    = _collectNotes(treeData);
  const presets  = state.get('notePresets') || { small: 18, medium: 36, large: 48 };

  // ── Align overlay containers EXACTLY to the canvas's page rect ────
  // The SVG (tails) and labels container (balloons) are positioned
  // absolute inside #notes-overlay (inset:0 of #viewport-surface). The
  // canvas (renderer.domElement) lives inside #viewer (also inset:0)
  // — but Three.js can size the canvas independently of its parent
  // div, leaving empty bars top/bottom (or sides) when the renderer's
  // internal viewport doesn't fill the wrapper exactly. Without
  // accounting for that, our projected pixels (which are CANVAS-
  // relative) get rendered at the wrong place inside the OVERLAY
  // (which is wrapper-relative) and the tail floats above / below
  // the actual face.
  //
  // Shift the SVG and labels boxes onto the canvas's exact rect each
  // frame so internal coords (0..canvas.width × 0..canvas.height)
  // line up 1:1 with what the renderer drew.
  const canvasRect  = sceneCore.renderer.domElement.getBoundingClientRect();
  const overlayHost = _labelsEl.parentElement;            // #notes-overlay
  const overlayRect = overlayHost.getBoundingClientRect();
  const offX = canvasRect.left - overlayRect.left;
  const offY = canvasRect.top  - overlayRect.top;
  for (const el of [_svgEl, _labelsEl]) {
    el.style.left   = `${offX}px`;
    el.style.top    = `${offY}px`;
    el.style.width  = `${canvasRect.width}px`;
    el.style.height = `${canvasRect.height}px`;
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
  }
  _svgEl.setAttribute('viewBox', `0 0 ${canvasRect.width} ${canvasRect.height}`);

  const rect = canvasRect;   // legacy alias for the rest of the function

  // ── Camera matrices fresh ─────────────────────────────────────────
  // Three.js's Vector3.project() reads camera.matrixWorldInverse.
  // The renderer refreshes it inside renderer.render() — but our hook
  // runs BEFORE that, so without an explicit refresh we project
  // through the PREVIOUS frame's camera pose. That manifests as
  // lag / jitter while the camera moves and the tail anchor landing
  // on last-frame's face position.
  sceneCore.camera.updateMatrixWorld(true);
  sceneCore.camera.matrixWorldInverse.copy(sceneCore.camera.matrixWorld).invert();

  // Force the WHOLE scene's matrixWorld fresh — not just the camera.
  // Otherwise the per-mesh matrixWorld used by _resolveAnchorWorld can
  // be stale right at the END of a step transition: the animation
  // system writes the final transform onto the node, but the world
  // matrices propagate down on the NEXT updateMatrixWorld pass. With
  // this line the tick always reads the freshest hierarchy state, so
  // notes don't flicker back to "home pose" for one frame after an
  // animation completes.
  sceneCore.scene.updateMatrixWorld(true);

  // Track which entries we've used this frame.
  const seen = new Set();

  const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Inherited visibility: a note is visible only if IT and every
  // ancestor up to root are visible. Hiding the anchor mesh hides the
  // note alongside it; the note's own localVisible is preserved so
  // showing the mesh again restores whatever the note was set to.
  const effVisMap = computeEffectiveVisibility(treeData);

  for (const note of notes) {
    // ── Effective panelOffset + visibility (with in-flight transition lerp).
    // note._anim is set by steps.js when a step transition starts; we lerp
    // panelOffset + opacity here, then clear _anim once alpha hits 1.
    let effOffset  = note.panelOffset || { x: 90, y: -70 };
    let effOpacity = effVisMap.get(note.id) ? 1 : 0;
    if (note._anim) {
      const a = note._anim;
      const raw = (nowMs - a.startMs) / Math.max(1, a.durationMs);
      const t   = raw >= 1 ? 1 : (raw <= 0 ? 0 : a.easeFn(raw));
      effOffset = {
        x: a.fromOffset.x + (a.toOffset.x - a.fromOffset.x) * t,
        y: a.fromOffset.y + (a.toOffset.y - a.fromOffset.y) * t,
      };
      const fromOpacity = a.fromVisible ? 1 : 0;
      const toOpacity   = a.toVisible   ? 1 : 0;
      effOpacity = fromOpacity + (toOpacity - fromOpacity) * t;
      if (raw >= 1) {
        // Snap final state into the note + clear the transition.
        note.panelOffset = { x: a.toOffset.x, y: a.toOffset.y };
        delete note._anim;
      }
    }

    // Skip render if fully transparent — but keep the DOM around so
    // a fade-in next transition can re-use it without flicker.
    if (effOpacity <= 0.001) {
      const old = _pool.get(note.id);
      if (old) {
        old.div.style.opacity  = '0';
        old.path.style.opacity = '0';
        seen.add(note.id);
      }
      continue;
    }
    const meshId = note.anchorMeshId;
    if (!meshId) continue;

    // Anchor world position — prefer live mesh transform, fall back to
    // saved bbox info on the phantom node when the asset is missing.
    const anchorWorld = _resolveAnchorWorld(meshId, note);
    if (!anchorWorld) continue;

    // Project to canvas pixels.
    const ndc = anchorWorld.clone().project(sceneCore.camera);
    if (ndc.z > 1 || ndc.z < -1) continue;
    const ax = ( ndc.x + 1) * rect.width  * 0.5;
    const ay = (-ndc.y + 1) * rect.height * 0.5;

    const fontSize = note.customFontSize ??
                     presets[note.sizePresetId] ??
                     presets.medium ?? 16;

    const offset = effOffset;
    const px = ax + (offset.x ?? 0);
    const py = ay + (offset.y ?? 0);

    // ── DOM div (balloon) ─────────────────────────────────────────────
    let entry = _pool.get(note.id);
    if (!entry) {
      entry = _createEntry(note);
      _pool.set(note.id, entry);
    }
    const { div, path } = entry;

    // Sync content + style.
    if (_editingNoteId !== note.id) {
      const text = note.text || '(empty note)';
      if (div.dataset.lastText !== text) {
        div.textContent = text;
        div.dataset.lastText = text;
      }
    }
    div.style.fontSize = `${fontSize}px`;
    div.style.opacity  = String(effOpacity);
    path.style.opacity = String(effOpacity);
    // Position balloon by its TOP-LEFT corner. CSS will translate(-50%, -100%)
    // so the bottom-center sits at (px, py)? Simpler: just use absolute
    // top-left with no translate — panelOffset is from the anchor.
    div.style.left = `${Math.round(px)}px`;
    div.style.top  = `${Math.round(py)}px`;

    // ── SVG tail ──────────────────────────────────────────────────────
    // The balloon's pixel rect:
    const bw = div.offsetWidth  || 80;
    const bh = div.offsetHeight || 24;
    // Pick the tail-end point on the BALLOON's nearest edge to the anchor.
    const tail = _balloonTailPoint(px, py, bw, bh, ax, ay);
    // Bezier from anchor → tail with a gentle curve (mid-point pulled
    // perpendicular to the line by ~20% of the segment length).
    const dx = tail.x - ax, dy = tail.y - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx  = -dy / len, ny = dx / len;     // perpendicular
    const cx  = (ax + tail.x) / 2 + nx * len * 0.15;
    const cy  = (ay + tail.y) / 2 + ny * len * 0.15;
    path.setAttribute('d',
      `M ${ax.toFixed(1)} ${ay.toFixed(1)} ` +
      `Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${tail.x.toFixed(1)} ${tail.y.toFixed(1)}`,
    );

    seen.add(note.id);
  }

  // Garbage-collect entries whose notes no longer exist or are hidden.
  for (const [id, entry] of _pool) {
    if (seen.has(id)) continue;
    entry.div.remove();
    entry.path.remove();
    _pool.delete(id);
  }
}

// ─── Anchor resolution ────────────────────────────────────────────────────

function _resolveAnchorWorld(meshId, note) {
  const T = window.THREE;
  const obj = steps.object3dById?.get(meshId);
  if (obj?.matrixWorld && obj.parent !== null) {
    obj.updateMatrixWorld();
    const local = note.anchorLocal || [0, 0, 0];
    const v = new T.Vector3(local[0], local[1], local[2]);
    return v.applyMatrix4(obj.matrixWorld);
  }
  // Fallback — phantom / missing mesh. Reconstruct an approximate world
  // position from the saved bbox + the bbox-relative anchor.
  const nodeById = state.get('nodeById');
  const meshNode = nodeById?.get(meshId);
  const bbox = meshNode?.bbox;
  if (!bbox) return null;
  const u = note.anchorBboxRelative || [0.5, 0.5, 0.5];
  const lx = bbox.min[0] + (bbox.max[0] - bbox.min[0]) * u[0];
  const ly = bbox.min[1] + (bbox.max[1] - bbox.min[1]) * u[1];
  const lz = bbox.min[2] + (bbox.max[2] - bbox.min[2]) * u[2];
  // Phantom Object3D might exist — if so, transform through it.
  const ph = meshNode?.object3d;
  const v = new T.Vector3(lx, ly, lz);
  if (ph?.matrixWorld) {
    ph.updateMatrixWorld();
    return v.applyMatrix4(ph.matrixWorld);
  }
  return v;
}

// ─── Tail geometry ────────────────────────────────────────────────────────

/**
 * Given a balloon rect (top-left at panelX/panelY, size w/h) and an
 * anchor point (ax, ay) somewhere outside (or near) the rect, return
 * the point on the balloon's nearest edge that the tail should connect
 * to. Clamp to a small inset from the corner so the tail never sits
 * exactly on a corner pixel.
 */
function _balloonTailPoint(panelX, panelY, w, h, ax, ay) {
  const cx = panelX + w * 0.5, cy = panelY + h * 0.5;
  const dx = cx - ax, dy = cy - ay;
  // Normalise into half-rect frame.
  const halfW = Math.max(w * 0.5, 1);
  const halfH = Math.max(h * 0.5, 1);
  const sx = dx / halfW, sy = dy / halfH;
  // Decide which edge the line from the anchor hits first.
  let tx, ty;
  if (Math.abs(sx) > Math.abs(sy)) {
    // Hits left or right edge.
    tx = panelX + (sx < 0 ? 0 : w);
    const k = (tx - ax) / (cx - ax || 1);
    ty = ay + (cy - ay) * k;
  } else {
    // Hits top or bottom edge.
    ty = panelY + (sy < 0 ? 0 : h);
    const k = (ty - ay) / (cy - ay || 1);
    tx = ax + (cx - ax) * k;
  }
  // Clamp away from corners so tail roots near edge midpoint.
  const inset = 12;
  tx = Math.max(panelX + inset, Math.min(panelX + w - inset, tx));
  ty = Math.max(panelY + inset, Math.min(panelY + h - inset, ty));
  return { x: tx, y: ty };
}

// ─── Per-balloon DOM creation ────────────────────────────────────────────

function _createEntry(note) {
  const div = document.createElement('div');
  div.className = 'sbsNoteBalloon';
  div.dataset.noteId = note.id;
  div.style.position = 'absolute';
  _labelsEl.appendChild(div);

  // SVG path (tail)
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'sbsNoteTail');
  path.dataset.noteId = note.id;
  _svgEl.appendChild(path);

  // Drag balloon → live update panelOffset. Also: a left-click on a
  // balloon SELECTS the note (mirrors clicking it in the tree) and
  // expands the tree path so the user can find it among the children.
  div.addEventListener('pointerdown', e => {
    if (e.target.closest('[contenteditable="true"]')) return;
    if (e.button !== 0) return;
    const liveNode = _findNote(note.id);
    if (!liveNode) return;
    // Select the note in the global selection — same as a tree row click.
    state.setSelection(note.id, new Set([note.id]));
    // Reveal in the tree panel by expanding the ancestor chain.
    import('../ui/tree.js').then(({ expandPathToNode }) => {
      try { expandPathToNode?.(note.id); } catch (_) { /* tree may not be active */ }
    });
    _drag = {
      noteId: note.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startOffset:  { ...liveNode.panelOffset },
      beforeOffset: { ...liveNode.panelOffset },
    };
    div.setPointerCapture?.(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  });

  // Right-click → contextmenu with the same items as the tree's note
  // row: Edit Text / Delete / Size: Small | Medium | Large.
  div.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    const liveNode = _findNote(note.id);
    if (!liveNode) return;
    state.setSelection(note.id, new Set([note.id]));
    import('./actions.js').then(actions => {
      showContextMenu([
        { label: 'Edit Text…',
          action: () => _enterEdit(note.id, div) },
        { label: '↺ Reposition Note…',
          action: () => actions.startNoteRepositioning(note.id) },
        { label: 'Delete Note',
          action: () => actions.deleteNote(note.id) },
        { separator: true },
        { label: '— Size: Small',
          action: () => actions.setNoteSizePreset(note.id, 'small'),
          disabled: liveNode.sizePresetId === 'small'  && liveNode.customFontSize === null },
        { label: '— Size: Medium',
          action: () => actions.setNoteSizePreset(note.id, 'medium'),
          disabled: liveNode.sizePresetId === 'medium' && liveNode.customFontSize === null },
        { label: '— Size: Large',
          action: () => actions.setNoteSizePreset(note.id, 'large'),
          disabled: liveNode.sizePresetId === 'large'  && liveNode.customFontSize === null },
      ], e.clientX, e.clientY);
    });
  });
  div.addEventListener('pointermove', e => {
    if (!_drag || _drag.noteId !== note.id) return;
    const liveNode = _findNote(note.id);
    if (!liveNode) return;
    liveNode.panelOffset = {
      x: _drag.startOffset.x + (e.clientX - _drag.startClientX),
      y: _drag.startOffset.y + (e.clientY - _drag.startClientY),
    };
    // Don't render here — the next sceneCore tick will pick up the
    // mutation and project through the same camera state the renderer
    // is about to use. Calling _renderTick() inline pulls the balloon
    // forward by ~one frame relative to the canvas paint, producing
    // visible jitter while dragging.
  });
  const finishDrag = (e) => {
    if (!_drag || _drag.noteId !== note.id) return;
    div.releasePointerCapture?.(e.pointerId);
    const before = _drag.beforeOffset;
    const after  = _findNote(note.id)?.panelOffset;
    _drag = null;
    if (after && (before.x !== after.x || before.y !== after.y)) {
      // Lazy import to avoid circular dep at module load.
      import('./actions.js').then(actions => {
        actions._commitNotePanelOffset?.(note.id, before, after);
      });
    }
  };
  div.addEventListener('pointerup',     finishDrag);
  div.addEventListener('pointercancel', finishDrag);

  // Double-click → inline edit mode.
  div.addEventListener('dblclick', e => {
    e.stopPropagation();
    _enterEdit(note.id, div);
  });

  return { div, path };
}

function _findNote(id) {
  const nodeById = state.get('nodeById');
  return nodeById?.get(id) ?? null;
}

function _enterEdit(noteId, div) {
  _editingNoteId = noteId;
  const liveNode = _findNote(noteId);
  if (!liveNode) return;
  const before = liveNode.text || '';
  div.contentEditable = 'true';
  div.textContent = before;
  div.focus();
  // Place caret at end.
  const sel = window.getSelection?.();
  if (sel) {
    const r = document.createRange();
    r.selectNodeContents(div);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const finish = (commit) => {
    if (_editingNoteId !== noteId) return;
    _editingNoteId = null;
    div.contentEditable = 'false';
    const after = (div.textContent || '').trim();
    div.dataset.lastText = '';
    if (commit && after !== before) {
      import('./actions.js').then(actions => {
        actions.editNoteText?.(noteId, after);
      });
    } else {
      // Roll back DOM text to live model so render syncs cleanly.
      div.textContent = liveNode.text || '';
    }
  };
  div.addEventListener('blur',    () => finish(true),  { once: true });
  div.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); finish(false); div.blur(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); div.blur();
    }
  });
}

// ─── Public helpers ──────────────────────────────────────────────────────

/** Force a render — call after any data mutation that affects notes. */
export function refreshNotes() { _renderTick(); }
