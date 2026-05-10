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
import { showContextMenu, showConfirmDialog } from '../ui/context-menu.js';
import { computeSafeFrameRect, getCanonicalSize } from '../core/safe-frame.js';
import * as clock                   from '../core/clock.js';

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

  // Use the project clock — `performance.now()` previously, but that
  // diverges from synthMs in offline export. Note._anim.startMs is set
  // via clock.now() in steps.js, so reading from clock.now() here keeps
  // the lerp coherent across both modes. Fixes notes "threshold-jumping"
  // in offline export (large elapsed → instant snap → _anim cleared
  // before rasterizeNotesLayer can read it).
  const nowMs = clock.now();

  // Inherited visibility: a note is visible only if IT and every
  // ancestor up to root are visible. Hiding the anchor mesh hides the
  // note alongside it; the note's own localVisible is preserved so
  // showing the mesh again restores whatever the note was set to.
  const effVisMap = computeEffectiveVisibility(treeData);

  // Safe frame inside the canvas — used to convert note.framePosition
  // (frame-relative %) into canvas-relative pixels and to scale font.
  const sfRect = computeSafeFrameRect({
    width:  canvasRect.width,
    height: canvasRect.height,
  });
  const canonical = getCanonicalSize();   // for legacy panelOffset migration

  for (const note of notes) {
    // ── Effective panelOffset + visibility (with in-flight transition lerp).
    // note._anim is set by steps.js when a step transition starts; we lerp
    // panelOffset + opacity here, then clear _anim once alpha hits 1.
    // panelOffset = LEGACY field (viewport-px from anchor). framePosition
    // is the new canonical model (0..1 of the safe frame).
    let effOffset  = note.panelOffset || { x: 90, y: -70 };
    let effFP      = (note.framePosition && Number.isFinite(note.framePosition.x))
                     ? { x: note.framePosition.x, y: note.framePosition.y }
                     : null;
    let effOpacity = effVisMap.get(note.id) ? 1 : 0;
    if (note._anim) {
      const a = note._anim;
      const raw = (nowMs - a.startMs) / Math.max(1, a.durationMs);
      const t   = raw >= 1 ? 1 : (raw <= 0 ? 0 : a.easeFn(raw));
      effOffset = {
        x: a.fromOffset.x + (a.toOffset.x - a.fromOffset.x) * t,
        y: a.fromOffset.y + (a.toOffset.y - a.fromOffset.y) * t,
      };
      // Frame-position lerp — only when both endpoints exist on the
      // _anim. Render below prefers effFP over effOffset when set.
      if (a.fromFP && a.toFP) {
        effFP = {
          x: a.fromFP.x + (a.toFP.x - a.fromFP.x) * t,
          y: a.fromFP.y + (a.toFP.y - a.fromFP.y) * t,
        };
      }
      const fromOpacity = a.fromVisible ? 1 : 0;
      const toOpacity   = a.toVisible   ? 1 : 0;
      effOpacity = fromOpacity + (toOpacity - fromOpacity) * t;
      if (raw >= 1) {
        // Snap final state into the note + clear the transition.
        note.panelOffset = { x: a.toOffset.x, y: a.toOffset.y };
        if (a.toFP) note.framePosition = { x: a.toFP.x, y: a.toFP.y };
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

    // Resolve content source. If note.templateId references an existing
    // template, the template owns text + size (shared across all instances).
    // Otherwise the instance's own text + size apply (legacy / standalone).
    let srcText = note.text || '';
    let srcSizePresetId   = note.sizePresetId;
    let srcCustomFontSize = note.customFontSize;
    if (note.templateId) {
      const tpls = state.get('noteTemplates') || [];
      const tpl  = tpls.find(t => t.id === note.templateId);
      if (tpl) {
        srcText           = tpl.text || '';
        srcSizePresetId   = tpl.sizePresetId;
        srcCustomFontSize = tpl.customFontSize;
      }
    }

    // Font size in canonical pixels (relative to canonical export size).
    // Multiply by sf.scale to get viewport pixels — so the text grows with
    // the safe frame.
    const fontCanonical = srcCustomFontSize ??
                          presets[srcSizePresetId] ??
                          presets.medium ?? 16;
    const fontSize = fontCanonical * (sfRect.scale || 1);

    // Balloon position. New model: framePosition.{x,y} is 0..1 of the
    // safe-frame rect (its top-left). effFP is the LERPED value during
    // step transitions (or just note.framePosition when no _anim).
    // Legacy: panelOffset is a viewport-pixel offset from the projected
    // anchor — used as fallback and migrated to framePosition lazily on
    // first render.
    let px, py;
    if (effFP) {
      px = sfRect.x + effFP.x * sfRect.width;
      py = sfRect.y + effFP.y * sfRect.height;
    } else {
      // Legacy migration. Compute viewport position from anchor + old
      // panelOffset, then back-solve to framePosition. Persist on the
      // node so subsequent renders use the new model directly.
      const offset = effOffset;
      px = ax + (offset.x ?? 0);
      py = ay + (offset.y ?? 0);
      if (sfRect.width > 0 && sfRect.height > 0) {
        note.framePosition = {
          x: (px - sfRect.x) / sfRect.width,
          y: (py - sfRect.y) / sfRect.height,
        };
      }
    }

    // ── DOM div (balloon) ─────────────────────────────────────────────
    let entry = _pool.get(note.id);
    if (!entry) {
      entry = _createEntry(note);
      _pool.set(note.id, entry);
    }
    const { div, path } = entry;

    // Sync content + style.
    if (_editingNoteId !== note.id) {
      const text = srcText || '(empty note)';
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

// ─── Template picker (mini submenu) ──────────────────────────────────────

function _showTemplatePicker(noteId, clientX, clientY) {
  const tplList = state.get('noteTemplates') || [];
  if (!tplList.length) return;
  import('./actions.js').then(actions => {
    showContextMenu(
      tplList.map(t => ({
        label: `📝 ${t.name || '(unnamed)'}`,
        action: () => actions.linkNoteToTemplate(noteId, t.id),
      })),
      clientX,
      clientY,
    );
  });
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
    // Snapshot the framePosition at drag start. If the note hasn't been
    // migrated yet (no framePosition), the next _renderTick will set
    // it lazily — but for the duration of this drag we operate on the
    // current value or fall back to a centred default.
    const startFP = (liveNode.framePosition && Number.isFinite(liveNode.framePosition.x))
      ? { x: liveNode.framePosition.x, y: liveNode.framePosition.y }
      : { x: 0.5, y: 0.5 };
    _drag = {
      noteId: note.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startFP,
      beforeFP: { ...startFP },
    };
    div.setPointerCapture?.(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  });

  // Right-click → contextmenu mirroring the tree's note-row menu:
  //   Show/Hide • Edit Text • Reposition • Delete (with confirm) •
  //   Size: Small/Medium/Large.
  div.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    const liveNode = _findNote(note.id);
    if (!liveNode) return;
    state.setSelection(note.id, new Set([note.id]));
    import('./actions.js').then(actions => {
      const isVisible  = liveNode.localVisible !== false;
      const tplLinked  = !!liveNode.templateId;
      const tplList    = state.get('noteTemplates') || [];
      const linkedTpl  = tplLinked ? tplList.find(t => t.id === liveNode.templateId) : null;
      const tplLabel   = linkedTpl ? (linkedTpl.name || 'template') : 'template';
      const sizeDisabled = tplLinked;   // size is owned by template when linked

      // Selected steps (for "paste position") — used to show count in label.
      const selSteps = state.get('selectedStepIds');
      const selCount = (selSteps instanceof Set) ? selSteps.size : 0;
      const clip     = actions.getNotePositionClipboard?.();
      const pasteOk  = !!clip && selCount > 0;

      const items = [
        { label:  isVisible ? '🚫 Hide note' : '👁 Show note',
          action: () => actions.toggleVisibility([note.id]) },
        { label:  'Edit Text…',
          action: () => _enterEdit(note.id, div) },
        { label:  '↺ Reposition Note…',
          action: () => actions.startNoteRepositioning(note.id) },
        { separator: true },
        { label:  '📋 Copy position',
          action: () => {
            actions.copyNotePosition(note.id);
            // Re-import status to keep this lazy
            import('../ui/status.js').then(({ setStatus }) => setStatus('Note position copied — paste into selected steps.'));
          },
          disabled: !liveNode.framePosition },
        { label:  pasteOk
                    ? `📌 Paste position to ${selCount} selected step${selCount === 1 ? '' : 's'}`
                    : '📌 Paste position (select steps first)',
          disabled: !pasteOk,
          action: () => {
            const n = actions.pasteNotePositionToSelectedSteps();
            import('../ui/status.js').then(({ setStatus }) => setStatus(`Pasted position to ${n} step${n === 1 ? '' : 's'}.`));
          } },
        { separator: true },
        { label:  'Delete Note',
          action: () => {
            // Display name = template name when linked, else trimmed text.
            const linkedTplDel = linkedTpl;
            const raw   = linkedTplDel
              ? (linkedTplDel.name || '(linked template)')
              : (liveNode.text || '').replace(/\s+/g, ' ').trim();
            const short = raw ? (raw.length > 40 ? raw.slice(0, 40) + '…' : raw) : '(empty note)';
            showConfirmDialog(
              'Delete note?',
              `This will remove the note "${short}". You can undo with Ctrl+Z.`,
              () => actions.deleteNote(note.id),
            );
          } },
        { separator: true },
      ];

      // Template link ops. Always offer "Swap with template…" when there's
      // any template in the library (works for both linked and standalone
      // notes — picks a new template and updates templateId). Linked notes
      // additionally get a Detach entry to convert to standalone.
      if (tplList.length > 0) {
        items.push({
          label: tplLinked
            ? `🔗 Swap with template… (currently "${tplLabel}")`
            : '🔗 Swap with template…',
          action: () => _showTemplatePicker(note.id, e.clientX, e.clientY),
        });
      }
      if (tplLinked) {
        items.push({
          label: `🔓 Detach from "${tplLabel}"`,
          action: () => actions.detachNoteFromTemplate(note.id),
        });
      }

      items.push(
        { separator: true },
        { label:    '● Size: Small',
          action:   () => actions.setNoteSizePreset(note.id, 'small'),
          disabled: sizeDisabled || (liveNode.sizePresetId === 'small'  && liveNode.customFontSize === null) },
        { label:    '● Size: Medium',
          action:   () => actions.setNoteSizePreset(note.id, 'medium'),
          disabled: sizeDisabled || (liveNode.sizePresetId === 'medium' && liveNode.customFontSize === null) },
        { label:    '● Size: Large',
          action:   () => actions.setNoteSizePreset(note.id, 'large'),
          disabled: sizeDisabled || (liveNode.sizePresetId === 'large'  && liveNode.customFontSize === null) },
      );

      showContextMenu(items, e.clientX, e.clientY);
    });
  });
  div.addEventListener('pointermove', e => {
    if (!_drag || _drag.noteId !== note.id) return;
    const liveNode = _findNote(note.id);
    if (!liveNode) return;
    // Convert client-pixel delta to frame-% delta. We need the current
    // safe-frame size — read it from the canvas at this moment.
    const cv = sceneCore?.renderer?.domElement?.getBoundingClientRect();
    if (!cv || cv.width <= 0 || cv.height <= 0) return;
    const sf = computeSafeFrameRect({ width: cv.width, height: cv.height });
    if (sf.width <= 0 || sf.height <= 0) return;
    const dxFrame = (e.clientX - _drag.startClientX) / sf.width;
    const dyFrame = (e.clientY - _drag.startClientY) / sf.height;
    liveNode.framePosition = {
      x: _drag.startFP.x + dxFrame,
      y: _drag.startFP.y + dyFrame,
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
    const before = _drag.beforeFP;
    const after  = _findNote(note.id)?.framePosition;
    _drag = null;
    if (after && (before.x !== after.x || before.y !== after.y)) {
      // Lazy import to avoid circular dep at module load.
      import('./actions.js').then(actions => {
        actions._commitNoteFramePosition?.(note.id, before, after);
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
  // If the note is template-linked, the edit operates on the TEMPLATE
  // (so all instances update). Otherwise the instance's own text is
  // edited.
  const tplList   = state.get('noteTemplates') || [];
  const tpl       = liveNode.templateId ? tplList.find(t => t.id === liveNode.templateId) : null;
  const editTpl   = !!tpl;
  const before    = (editTpl ? tpl.text : liveNode.text) || '';
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
        if (editTpl) {
          actions.updateNoteTemplateText?.(tpl.id, after);
        } else {
          actions.editNoteText?.(noteId, after);
        }
      });
    } else {
      // Roll back DOM text to live model so render syncs cleanly.
      div.textContent = (editTpl ? tpl.text : liveNode.text) || '';
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


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORT-TIME RASTERIZER
// ═══════════════════════════════════════════════════════════════════════════
//
// The live note overlay is HTML/SVG (a div per balloon, an SVG path per
// tail). Canvas-based exports (video-export.js, single-frame thumbnail)
// composite the 3D canvas + Konva overlay + header layer — none of
// which capture DOM/SVG. Result: notes were missing from every exported
// MP4 / .sbsproc.
//
// `rasterizeNotesLayer({width,height})` returns a 2D canvas with every
// currently-visible note painted on it: tail (quadratic curve, amber)
// + balloon (rounded rect, light yellow + amber border) + text. The
// math mirrors the DOM tick — anchor world → NDC → output pixels —
// but parameterised on the OUTPUT dimensions (canonical export size,
// not viewport rect) so notes land in the correct screen position even
// when the viewport's aspect ratio differs from the canonical W×H.
// Returns null when there are no visible notes (caller can skip the
// composite step entirely).

const NOTE_BALLOON_FILL    = '#fffbeb';   // matches .sbsNoteBalloon background
const NOTE_BALLOON_STROKE  = '#facc15';   // amber border
const NOTE_TEXT_COLOR      = '#1f2937';
const NOTE_TAIL_COLOR      = '#facc15';
const NOTE_BALLOON_RADIUS  = 10;
const NOTE_PADDING_X       = 10;
const NOTE_PADDING_Y       = 6;
const NOTE_LINE_HEIGHT     = 1.35;
const NOTE_MAX_WIDTH_PX    = 340;
const NOTE_MIN_WIDTH_PX    = 48;
const NOTE_FONT            = 'Arial, Helvetica, sans-serif';

export function rasterizeNotesLayer({ width, height }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return null;
  }
  const T = window.THREE;
  if (!T || !sceneCore?.camera) return null;

  const treeData = state.get('treeData');
  const notes    = _collectNotes(treeData);
  if (!notes.length) return null;

  const presets  = state.get('notePresets') || { small: 18, medium: 36, large: 48 };
  const effVis   = computeEffectiveVisibility(treeData);
  // Drop notes that are fully hidden upstream; they wouldn't draw anyway,
  // and skipping early avoids matrix math for nothing.
  const visible  = notes.filter(n => effVis.get(n.id));
  if (!visible.length) return null;

  // Refresh world matrices the same way _renderTick does — projection
  // reads camera.matrixWorldInverse, which the renderer normally
  // maintains during render(). Export composites BEFORE the next
  // render(), so we update once here.
  sceneCore.camera.updateMatrixWorld(true);
  sceneCore.camera.matrixWorldInverse.copy(sceneCore.camera.matrixWorld).invert();
  sceneCore.scene.updateMatrixWorld(true);

  // Output canvas. OffscreenCanvas has the same 2D API as a regular
  // canvas; falls back to a regular <canvas> when OffscreenCanvas is
  // unavailable (older browsers). The 2D context is requested with
  // alpha:true so the composite step can drawImage without pulling
  // a black background.
  const out = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = out.getContext('2d', { alpha: true });
  if (!ctx) return null;

  // Output pixels for the safe-frame rect — note framePosition is
  // expressed as 0..1 of the safe-frame top-left, so the safe-frame
  // computation must use the OUTPUT size (not the viewport rect).
  const sfRect = computeSafeFrameRect({ width, height });

  // Time source for in-flight transition lerp. Uses clock.now() so
  // offline export (synthetic clock) and realtime (performance.now)
  // both produce correct elapsed values. The _anim record on a note
  // is set by steps.applyAllNotesTransition with startMs in the same
  // clock — see steps.js. Without this, a transition mid-export sees
  // the START position the whole time and the note "threshold-jumps"
  // to the END position only after t≥1.
  const nowMs = clock.now();

  for (const note of visible) {
    if (!note.anchorMeshId) continue;
    const anchorWorld = _resolveAnchorWorld(note.anchorMeshId, note);
    if (!anchorWorld) continue;

    // Project to NDC, then to output pixels.
    const ndc = anchorWorld.clone().project(sceneCore.camera);
    if (ndc.z > 1 || ndc.z < -1) continue;
    const ax = ( ndc.x + 1) * width  * 0.5;
    const ay = (-ndc.y + 1) * height * 0.5;

    // Resolve text + size — template overrides instance fields when linked.
    let srcText = note.text || '';
    let srcSizePresetId   = note.sizePresetId;
    let srcCustomFontSize = note.customFontSize;
    if (note.templateId) {
      const tpl = (state.get('noteTemplates') || []).find(t => t.id === note.templateId);
      if (tpl) {
        srcText           = tpl.text || '';
        srcSizePresetId   = tpl.sizePresetId;
        srcCustomFontSize = tpl.customFontSize;
      }
    }
    const fontCanonical = srcCustomFontSize ?? presets[srcSizePresetId] ?? presets.medium ?? 16;
    const fontSize = fontCanonical * (sfRect.scale || 1);

    const text = (srcText && srcText.length) ? srcText : '(empty note)';

    // Wrap text to NOTE_MAX_WIDTH_PX (in output pixels). The text wrapper
    // returns an array of lines; balloon dimensions follow.
    ctx.font = `${fontSize}px ${NOTE_FONT}`;
    const lines      = _wrapText(ctx, text, NOTE_MAX_WIDTH_PX - NOTE_PADDING_X * 2);
    const textWidth  = Math.max(NOTE_MIN_WIDTH_PX,
                                ...lines.map(l => Math.ceil(ctx.measureText(l).width)));
    const balloonW   = Math.min(NOTE_MAX_WIDTH_PX, textWidth + NOTE_PADDING_X * 2);
    const lineHeight = Math.round(fontSize * NOTE_LINE_HEIGHT);
    const balloonH   = lineHeight * lines.length + NOTE_PADDING_Y * 2;

    // ── Resolve effective framePosition + offset + opacity (lerped).
    // If the note is mid-transition, note._anim carries from / to /
    // startMs / durationMs / easeFn. Same lerp formula as the live
    // tick — keep them identical so editor preview and exported video
    // match frame-for-frame. Without this, offline export rendered the
    // START position throughout the transition and snapped at the end
    // ("threshold-move").
    let effOffset  = note.panelOffset || { x: 90, y: -70 };
    let effFP      = (note.framePosition && Number.isFinite(note.framePosition.x))
                     ? { x: note.framePosition.x, y: note.framePosition.y }
                     : null;
    let effOpacity = 1;
    if (note._anim) {
      const a = note._anim;
      const raw = (nowMs - a.startMs) / Math.max(1, a.durationMs);
      const t   = raw >= 1 ? 1 : (raw <= 0 ? 0 : (a.easeFn ? a.easeFn(raw) : raw));
      if (a.fromOffset && a.toOffset) {
        effOffset = {
          x: a.fromOffset.x + (a.toOffset.x - a.fromOffset.x) * t,
          y: a.fromOffset.y + (a.toOffset.y - a.fromOffset.y) * t,
        };
      }
      if (a.fromFP && a.toFP) {
        effFP = {
          x: a.fromFP.x + (a.toFP.x - a.fromFP.x) * t,
          y: a.fromFP.y + (a.toFP.y - a.fromFP.y) * t,
        };
      }
      const fromOpacity = a.fromVisible ? 1 : 0;
      const toOpacity   = a.toVisible   ? 1 : 0;
      effOpacity = fromOpacity + (toOpacity - fromOpacity) * t;
    }
    if (effOpacity <= 0.001) continue;   // fully faded — skip draw entirely

    // Balloon top-left in output pixels. Prefer framePosition (0..1 of
    // safe-frame) over the legacy panelOffset (viewport-px from anchor).
    let px, py;
    if (effFP) {
      px = sfRect.x + effFP.x * sfRect.width;
      py = sfRect.y + effFP.y * sfRect.height;
    } else {
      px = ax + (effOffset.x ?? 0);
      py = ay + (effOffset.y ?? 0);
    }

    // Tail end-point on the nearest balloon edge (same math as live).
    const tail = _balloonTailPoint(px, py, balloonW, balloonH, ax, ay);

    // Draw tail (quadratic Bezier) — anchor → tail with a perpendicular
    // mid-point pulled by ~15% of segment length. Same formula as the
    // SVG path in the DOM tick.
    const dx = tail.x - ax, dy = tail.y - ay;
    const segLen = Math.hypot(dx, dy) || 1;
    const nx = -dy / segLen, ny = dx / segLen;
    const cx = (ax + tail.x) / 2 + nx * segLen * 0.15;
    const cy = (ay + tail.y) / 2 + ny * segLen * 0.15;
    ctx.save();
    ctx.globalAlpha   = 0.9 * effOpacity;
    ctx.strokeStyle   = NOTE_TAIL_COLOR;
    ctx.lineWidth     = 2;
    ctx.lineCap       = 'round';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(cx, cy, tail.x, tail.y);
    ctx.stroke();
    ctx.restore();

    // Draw balloon — drop shadow + rounded rect + border.
    ctx.save();
    ctx.globalAlpha   = effOpacity;
    ctx.shadowColor   = 'rgba(0,0,0,0.32)';
    ctx.shadowBlur    = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle     = NOTE_BALLOON_FILL;
    _roundRectPath(ctx, px, py, balloonW, balloonH, NOTE_BALLOON_RADIUS);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = effOpacity;
    ctx.strokeStyle = NOTE_BALLOON_STROKE;
    ctx.lineWidth   = 1;
    _roundRectPath(ctx, px + 0.5, py + 0.5, balloonW - 1, balloonH - 1, NOTE_BALLOON_RADIUS);
    ctx.stroke();
    ctx.restore();

    // Draw text — left-aligned, vertically packed by line height.
    ctx.save();
    ctx.globalAlpha  = effOpacity;
    ctx.fillStyle    = NOTE_TEXT_COLOR;
    ctx.font         = `${fontSize}px ${NOTE_FONT}`;
    ctx.textBaseline = 'top';
    const textX = px + NOTE_PADDING_X;
    let   textY = py + NOTE_PADDING_Y;
    for (const line of lines) {
      ctx.fillText(line, textX, textY);
      textY += lineHeight;
    }
    ctx.restore();
  }

  return out;
}

/** Word-wrap `text` so each line fits in `maxWidth` pixels (ctx.font set by caller). */
function _wrapText(ctx, text, maxWidth) {
  const out = [];
  // Preserve explicit newlines — split first on \n, then word-wrap each.
  for (const para of String(text).split(/\r?\n/)) {
    if (!para.length) { out.push(''); continue; }
    const words = para.split(/(\s+)/);   // keep separators so spacing survives
    let cur = '';
    for (const w of words) {
      const trial = cur + w;
      if (ctx.measureText(trial).width <= maxWidth) {
        cur = trial;
      } else {
        if (cur.length) out.push(cur);
        // Token wider than maxWidth on its own — break it character-wise so it doesn't render off-balloon.
        if (ctx.measureText(w).width > maxWidth) {
          let frag = '';
          for (const ch of w) {
            if (ctx.measureText(frag + ch).width > maxWidth) {
              if (frag.length) out.push(frag);
              frag = ch;
            } else {
              frag += ch;
            }
          }
          cur = frag;
        } else {
          cur = w.trimStart();
        }
      }
    }
    if (cur.length) out.push(cur);
  }
  return out.length ? out : [''];
}

/** Build a rounded-rectangle path on `ctx` (no draw — caller fills/strokes). */
function _roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo (x + w,      y,        x + w,     y + rr,    rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo (x + w,      y + h,    x + w - rr, y + h,    rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo (x,          y + h,    x,           y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo (x,          y,        x + rr,      y,         rr);
  ctx.closePath();
}
