/**
 * SBS Step Browser — Shape Editor
 * ==================================
 * Viewport-native draw + edit mode for flat-shape templates.
 *
 * STATE MODEL
 * -----------
 * `state.shapeDrawing` holds:
 *   {
 *     phase:               'pickPlane' | 'addVertices' | 'edit',
 *     editingTemplateId:   string | null,
 *     plane:               { origin, normal, qx, qy, worldQuaternion, anchorNodeId },
 *     polygons:            [ { outer:[[x,y]…], holes:[] }, … ],
 *     activePolygonIdx:    int — which polygon is being drawn during
 *                          addVertices, or the most-recent polygon in edit
 *                          mode. -1 when no polygon exists yet.
 *     selection:           { polyIdx, vIdx } | null — edit-mode picked vertex.
 *   }
 *
 * The displayed geometry is the XOR of every entry in `polygons`. So drawing
 * a second rectangle that overlaps the first produces a "+" shape with a
 * cleared centre; a third overlapping rectangle re-fills that centre. See
 * systems/flat-shapes.js#xorPolygonList.
 *
 * PHASES
 * ------
 *   pickPlane    — first viewport click sets the drawing plane.
 *   addVertices  — clicks add vertices to polygons[activePolygonIdx]. A
 *                  rubber-band line previews the next edge. When the
 *                  cursor lands within SNAP_PIXELS of vertex 0 of the
 *                  active polygon the next click closes + commits.
 *                  Right-click in CREATE flow commits with ≥3 points.
 *   edit         — vertices of every polygon are pickable / draggable.
 *                  Click vertex → select + drag in one gesture. Delete
 *                  removes selected. Right-click on an edge → "Add point";
 *                  right-click on the empty grid → "New polygon"
 *                  (appends a fresh polygon and switches to addVertices).
 *
 * The preview group lives in sceneCore.overlayScene — it always draws on
 * top of geometry. Camera nav works during the editor (the editor only
 * intercepts pointerdown / move / up / Esc).
 */

import { sceneCore }     from '../core/scene.js';
import state             from '../core/state.js';
import { xorPolygonList } from './flat-shapes.js';

// ── Tunables ─────────────────────────────────────────────────────────────
const SNAP_PIXELS         = 12;     // close-snap radius (screen-space)
const PLANE_DISTANCE      = 200;    // empty-space pick: fixed dist from camera
const GRID_SIZE           = 800;    // size of the on-plane grid helper
const GRID_DIVISIONS      = 40;
const VERTEX_PIXEL_SIZE   = 6;      // vertex marker size in screen pixels
const VERTEX_PICK_PIXELS  = 12;     // click radius around a vertex (screen-space)
const EDGE_PICK_PIXELS    = 8;      // click radius along an edge (screen-space)

// Per-vertex colours for the screen-space Points cloud.
const COL_V0_IDLE    = [1.0, 0.667, 0.133]; // #ffaa22 — drawing v0 idle
const COL_V0_HOVER   = [0.0, 1.0,   0.4];   // #00ff66 — drawing v0 snap-close
const COL_VN         = [1.0, 1.0,   1.0];   // #ffffff — generic vertex
const COL_VSELECTED  = [0.0, 1.0,   0.4];   // #00ff66 — edit-mode selected

// Outline / fill colours per polygon role.
const COL_OUTLINE_PRIMARY   = 0xfff066;     // active polygon
const COL_OUTLINE_SECONDARY = 0x88aaff;     // older polygons in the same template
const COL_FILL              = 0xfff066;     // XOR fill preview

// ── Module state ─────────────────────────────────────────────────────────
let _previewGroup  = null;          // THREE.Group on overlayScene; positioned at plane pose
let _gridHelper    = null;          // GridHelper inside _previewGroup
let _outlineLines  = [];            // one Line per polygon
let _fillMesh      = null;          // XOR-composed translucent fill mesh
let _rubberLine    = null;          // last-vertex → cursor segment (addVertices preview)
let _vertexPoints  = null;          // single Points cloud across all polygons
// _vertexIndex maps a flat point-cloud index → { polyIdx, vIdx } so the
// vertex picker can recover which polygon's vertex was clicked.
let _vertexIndex   = [];
// Flat polygon-level gizmo (only present when selection.allVertices is true).
let _polyGizmoGroup = null;         // sub-group of _previewGroup, geometry built at unit size
let _polyGizmoMeta  = null;         // { polyIdx, centroid, size } — `size` is the live world-space radius driven by the tick hook
let _gizmoDrag      = null;         // active gizmo-drag descriptor (see _gizmoDragStart)
let _tickUnsub      = null;         // sceneCore tick hook unsubscribe

let _editDragging  = false;         // true while a single-vertex drag is in progress
let _hoverV0       = false;         // snap-close hover state during addVertices

// Gizmo geometry tunables.
//
// The gizmo is built at UNIT size (arrows go from origin to (1,0)/(0,1),
// ring radius = POLY_GIZMO_RING_FRAC, etc.) and the surrounding group is
// rescaled every frame to ~POLY_GIZMO_SCREEN_FRAC of the viewport height.
// That keeps the handles at a stable size on screen regardless of how
// big or small the polygon itself is, or how far the camera is — same
// trick the main 3D gizmo uses.
const POLY_GIZMO_SCREEN_FRAC  = 0.20;  // ≈ 20% of viewport height
const POLY_GIZMO_PICK_PIX     = 14;    // hit-test radius (screen-space)
const POLY_GIZMO_RING_FRAC    = 0.55;  // rotate-ring radius (unit fraction)
const POLY_GIZMO_RING_SAMPLES = 64;    // ring tessellation
const POLY_GIZMO_CUBE_FRAC    = 0.55;  // scale cube placement along (+X,+Y)/2 diagonal
const POLY_GIZMO_CUBE_HALF    = 0.07;  // scale cube half-edge (unit fraction)
const POLY_GIZMO_XY_HALF      = 0.09;  // XY translate square half-edge (unit fraction)
const POLY_GIZMO_XY_OFFSET    = 0.18;  // XY square offset along +X/+Y from origin
const POLY_GIZMO_LINE_THICK   = 0.025; // arrow / ring thickness (unit fraction ≈ 5 px @ 1080 viewport)
const POLY_GIZMO_TIP_LEN      = 0.18;  // arrowhead length (unit fraction)
const POLY_GIZMO_TIP_HALF     = 0.07;  // arrowhead half-width

// Handle palette (matches the main 3D gizmo colour conventions).
const POLY_GIZMO_COL_X     = 0xe05555;
const POLY_GIZMO_COL_Y     = 0x55cc55;
const POLY_GIZMO_COL_RING  = 0x5588e0;
const POLY_GIZMO_COL_SCALE = 0xc0c8d6;
const POLY_GIZMO_COL_XY    = 0xe0c855;


// ─────────────────────────────────────────────────────────────────────────
//  HELPERS — multi-polygon state accessors
// ─────────────────────────────────────────────────────────────────────────

function _polygons(dr) {
  return Array.isArray(dr?.polygons) ? dr.polygons : [];
}
function _activeOuter(dr) {
  const polys = _polygons(dr);
  if (dr.activePolygonIdx < 0 || dr.activePolygonIdx >= polys.length) return [];
  return polys[dr.activePolygonIdx]?.outer ?? [];
}
function _replaceOuter(dr, polyIdx, newOuter) {
  return _polygons(dr).map((p, i) =>
    i === polyIdx ? { ...p, outer: newOuter } : p,
  );
}
function _polygonsForEmit(dr) {
  // Strip polygons whose outer has < 3 vertices — they're non-renderable
  // and would corrupt the saved template. The editor always carries them
  // mid-draw (active polygon may be incomplete) so we filter on emit.
  return _polygons(dr)
    .filter(p => (p?.outer?.length ?? 0) >= 3)
    .map(p => ({
      outer: p.outer.map(pt => [pt[0], pt[1]]),
      holes: (p.holes || []).map(h => h.map(pt => [pt[0], pt[1]])),
    }));
}

function _emitVertexEdit(dr, reason) {
  state.emit('shapeEditor:vertexEdit', {
    templateId: dr.editingTemplateId,
    polygons:   _polygonsForEmit(dr),
    reason,
  });
}


// ─────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────

export function isDrawing() {
  return !!state.get('shapeDrawing');
}

/**
 * Start the editor. Three entry points:
 *
 * 1. `startDrawing()` — fresh CREATE flow. pickPlane → addVertices → commit
 *    (creates a new template + first instance via actions.js).
 *
 * 2. `startDrawing(templateId, { seedPlane, mode: 'edit', seedPolygons })` —
 *    EDIT-EXISTING flow. Vertices of every polygon are pickable / draggable;
 *    each operation writes the template polygons LIVE.
 *
 * 3. `startDrawing(templateId, { seedPlane, seedPolygons })` (no mode) —
 *    fallback redraw flow. Goes to addVertices on the same plane with the
 *    first polygon's points seeded; commit replaces the template's polygons.
 *    Used only if a caller explicitly wants the redraw experience.
 */
export function startDrawing(editingTemplateId = null, opts = {}) {
  if (state.get('shapeDrawing')) return;
  const { seedPlane = null, seedPoints = null, seedPolygons = null, mode = null } = opts;

  // Normalise seed polygons. Either explicit `seedPolygons` (multi) or
  // legacy `seedPoints` (single polygon) — both produce the same shape.
  const polys = Array.isArray(seedPolygons) && seedPolygons.length
    ? seedPolygons.map(p => ({
        outer: (p.outer || []).map(pt => [pt[0], pt[1]]),
        holes: (p.holes || []).map(h => h.map(pt => [pt[0], pt[1]])),
      }))
    : (seedPoints && seedPoints.length
        ? [{ outer: seedPoints.map(p => [p[0], p[1]]), holes: [] }]
        : null);

  if (seedPlane && mode === 'edit') {
    state.setState({
      shapeDrawing: {
        phase:             'edit',
        editingTemplateId,
        plane:             seedPlane,
        polygons:          polys ?? [{ outer: [], holes: [] }],
        activePolygonIdx:  Math.max(0, (polys?.length ?? 1) - 1),
        selection:         null,
      },
    });
    _setupPreview();
    _positionPreviewToPlane(seedPlane);
    _renderGrid();
    _renderAll();
    return;
  }

  if (seedPlane) {
    // Redraw on a known plane — addVertices for a single polygon.
    state.setState({
      shapeDrawing: {
        phase:             'addVertices',
        editingTemplateId,
        plane:             seedPlane,
        polygons:          polys ?? [{ outer: [], holes: [] }],
        activePolygonIdx:  Math.max(0, (polys?.length ?? 1) - 1),
        selection:         null,
      },
    });
    _setupPreview();
    _positionPreviewToPlane(seedPlane);
    _renderGrid();
    _renderAll();
    return;
  }

  // Fresh create — plane is picked by the first viewport click.
  state.setState({
    shapeDrawing: {
      phase:             'pickPlane',
      editingTemplateId,
      plane:             null,
      polygons:          [{ outer: [], holes: [] }],
      activePolygonIdx:  0,
      selection:         null,
    },
  });
  _setupPreview();
}

/** Cancel mid-draw / mid-edit. Discards any in-progress polygon. */
export function cancel() {
  if (!state.get('shapeDrawing')) return;
  state.setState({ shapeDrawing: null });
  _teardownPreview();
}

/**
 * Forward a viewport pointerdown into the editor.
 * Returns true if the editor consumed the event.
 */
export function onPointerDown(clientX, clientY, button = 0) {
  const dr = state.get('shapeDrawing');
  if (!dr) return false;

  // ── EDIT phase: gizmo handle → polygon transform; else vertex pick + drag.
  if (dr.phase === 'edit') {
    if (button !== 0) return true;

    // Polygon gizmo present (selection.allVertices) → handles get first
    // chance at the click. Drag-translate / rotate / scale all dispatch
    // through _gizmoDrag*; clicking off all handles falls through to the
    // standard vertex / deselect path.
    if (_polyGizmoMeta && dr.selection?.allVertices) {
      const handle = _pickPolyGizmoHandle(clientX, clientY, dr);
      if (handle) {
        _gizmoDragStart(handle, clientX, clientY, dr);
        return true;
      }
    }

    const hit = _pickVertex(clientX, clientY, dr);
    if (hit) {
      state.setState({
        shapeDrawing: { ...dr, selection: { polyIdx: hit.polyIdx, vIdx: hit.vIdx } },
      });
      _editDragging = true;
      _renderAll();
      return true;
    }
    if (dr.selection) {
      state.setState({ shapeDrawing: { ...dr, selection: null } });
      _renderAll();
    }
    return true;
  }

  if (button === 2) {
    // Right-click in CREATE flow commits the active polygon if viable.
    if (dr.phase === 'addVertices' && _activeOuter(dr).length >= 3) commit();
    return true;
  }
  if (button !== 0) return false;

  if (dr.phase === 'pickPlane') {
    const plane = _planeFromClick(clientX, clientY);
    if (!plane) return true;
    state.setState({ shapeDrawing: { ...dr, phase: 'addVertices', plane } });
    _positionPreviewToPlane(plane);
    _renderGrid();
    return true;
  }

  if (dr.phase === 'addVertices') {
    const active = _activeOuter(dr);
    // Snap-close has priority over adding a new vertex — closes the
    // ACTIVE polygon and either fully commits (single-polygon create) or
    // returns to edit mode (additional polygon mid-edit).
    if (active.length >= 3 && _isV0Close(dr.plane, active[0], clientX, clientY)) {
      commit();
      return true;
    }
    const planePt = _projectOntoPlane(clientX, clientY, dr.plane);
    if (!planePt) return true;
    const newOuter = [...active, planePt];
    const newPolygons = _replaceOuter(dr, dr.activePolygonIdx, newOuter);
    state.setState({ shapeDrawing: { ...dr, polygons: newPolygons } });
    _renderAll();
    return true;
  }

  return false;
}

/**
 * Double-click on a vertex selects ALL vertices of the polygon containing
 * that vertex. The whole polygon turns green and Delete / Backspace
 * removes it (rather than just the one vertex).
 *
 * Returns true if the editor consumed the event.
 */
export function onDoubleClick(clientX, clientY) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit') return false;
  const hit = _pickVertex(clientX, clientY, dr);
  if (!hit) {
    if (dr.selection?.allVertices) {
      state.setState({ shapeDrawing: { ...dr, selection: null } });
      _renderAll();
    }
    return false;
  }
  state.setState({
    shapeDrawing: {
      ...dr,
      selection: { polyIdx: hit.polyIdx, allVertices: true },
    },
  });
  // Cancel any in-flight single-vertex drag — a polygon-level selection
  // doesn't drag, only deletes.
  _editDragging = false;
  _renderAll();
  return true;
}

/** End vertex / gizmo drag. Pushes the LIVE polygons to the template. */
export function onPointerUp() {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit') return false;
  if (_gizmoDrag) {
    _gizmoDragEnd();
    return true;
  }
  if (_editDragging) {
    _editDragging = false;
    _emitVertexEdit(dr, 'move');
  }
  return true;
}

/** Pointer move — drag selected vertex (edit) OR rubber-band cue (addVertices). */
export function onPointerMove(clientX, clientY) {
  const dr = state.get('shapeDrawing');
  if (!dr) return;

  if (dr.phase === 'edit') {
    // Active gizmo drag takes priority over single-vertex drag.
    if (_gizmoDrag) {
      _gizmoDragUpdate(clientX, clientY, dr);
      return;
    }
    if (!_editDragging || !dr.selection || dr.selection.allVertices) return;
    const planePt = _projectOntoPlane(clientX, clientY, dr.plane);
    if (!planePt) return;
    const { polyIdx, vIdx } = dr.selection;
    const polys = _polygons(dr);
    const target = polys[polyIdx];
    if (!target) return;
    const newOuter = target.outer.map((p, i) =>
      i === vIdx ? [planePt[0], planePt[1]] : p,
    );
    const newPolygons = polys.map((p, i) => i === polyIdx ? { ...p, outer: newOuter } : p);
    state.setState({ shapeDrawing: { ...dr, polygons: newPolygons } });
    _renderAll();
    return;
  }

  if (dr.phase !== 'addVertices') return;
  const planePt = _projectOntoPlane(clientX, clientY, dr.plane);
  if (!planePt) return;
  const active = _activeOuter(dr);
  _hoverV0 = active.length >= 3 && _isV0Close(dr.plane, active[0], clientX, clientY);
  _renderRubberBand(active, planePt);
  _highlightV0(_hoverV0);
}

/**
 * Commit the in-progress polygon.
 *   - In a multi-polygon edit session (more than one polygon present, or
 *     editingTemplateId is set), close the active polygon and switch to
 *     'edit' phase so the user can keep adding / tweaking.
 *   - Otherwise (single polygon, fresh create), tear down the preview
 *     and emit 'shapeEditor:commit' so actions.js creates the template.
 */
export function commit() {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'addVertices') return;
  const active = _activeOuter(dr);
  if (active.length < 3) return;

  const polys = _polygons(dr);
  const isFirstAndOnly = polys.length === 1 && !dr.editingTemplateId;

  if (isFirstAndOnly) {
    // Fresh create — full commit → actions.js creates template + instance.
    const payload = {
      plane:             dr.plane,
      polygons:          _polygonsForEmit(dr),
      points:            polys[0].outer.map(p => [p[0], p[1]]),  // legacy alias
      editingTemplateId: dr.editingTemplateId,
    };
    state.setState({ shapeDrawing: null });
    _teardownPreview();
    state.emit('shapeEditor:commit', payload);
    return;
  }

  // Mid-edit: this polygon was the last one being drawn. Push it to the
  // template (vertexEdit) and switch back to edit mode so the user can
  // add yet another polygon, drag a vertex, etc.
  state.setState({
    shapeDrawing: { ...dr, phase: 'edit', selection: null },
  });
  _renderAll();
  _emitVertexEdit(state.get('shapeDrawing'), 'addPolygon');
}


// ─────────────────────────────────────────────────────────────────────────
//  EDIT-MODE OPERATIONS — exposed for tree menu / Delete key / etc.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Delete whatever is currently selected:
 *   - selection.allVertices = true → remove the entire polygon.
 *   - selection.vIdx       given  → remove just that one vertex.
 * Refuses single-vertex delete that would take the polygon below 3
 * vertices (no triangles allowed). Removing the LAST polygon is allowed
 * — the template ends up with no polygons (mesh disappears), and the
 * user can add a new one via "Add polygon".
 */
export function deleteSelected() {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.selection) return false;
  if (dr.selection.allVertices) return deleteSelectedPolygon();
  return deleteSelectedVertex();
}

/** Delete the single selected vertex. ≥ 3 minimum to keep a renderable polygon. */
export function deleteSelectedVertex() {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.selection || dr.selection.allVertices) return false;
  const { polyIdx, vIdx } = dr.selection;
  const polys = _polygons(dr);
  const target = polys[polyIdx];
  if (!target || target.outer.length <= 3) return false;

  const newOuter = target.outer.filter((_, i) => i !== vIdx);
  const newPolygons = polys.map((p, i) => i === polyIdx ? { ...p, outer: newOuter } : p);
  state.setState({ shapeDrawing: { ...dr, polygons: newPolygons, selection: null } });
  _renderAll();
  _emitVertexEdit(state.get('shapeDrawing'), 'delete');
  return true;
}

/**
 * Delete the entire polygon at `polyIdx` (or the polygon-selected one
 * when no idx is given). Other polygons in the template are preserved
 * and the XOR re-composes immediately.
 */
export function deleteSelectedPolygon(polyIdx = null) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit') return false;
  const idx = polyIdx ?? dr.selection?.polyIdx ?? null;
  if (idx === null) return false;
  const polys = _polygons(dr);
  if (idx < 0 || idx >= polys.length) return false;

  const newPolygons = polys.filter((_, i) => i !== idx);
  // Active polygon idx might shift — clamp to valid range.
  const newActive = Math.min(dr.activePolygonIdx, newPolygons.length - 1);
  state.setState({
    shapeDrawing: {
      ...dr,
      polygons:         newPolygons,
      activePolygonIdx: Math.max(0, newActive),
      selection:        null,
    },
  });
  _renderAll();
  _emitVertexEdit(state.get('shapeDrawing'), 'deletePolygon');
  return true;
}

/**
 * Insert a vertex on the polygon edge under the screen point. If no edge
 * is hit, returns false. Inserts into the polygon containing the edge.
 */
export function addPointOnEdge(clientX, clientY) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit') return false;
  const hit = _pickEdge(clientX, clientY, dr);
  if (!hit) return false;
  const polys = _polygons(dr);
  const target = polys[hit.polyIdx];
  if (!target) return false;

  const newOuter = target.outer.slice();
  newOuter.splice(hit.aIdx + 1, 0, hit.planePt);
  const newPolygons = polys.map((p, i) => i === hit.polyIdx ? { ...p, outer: newOuter } : p);
  state.setState({
    shapeDrawing: {
      ...dr,
      polygons: newPolygons,
      selection: { polyIdx: hit.polyIdx, vIdx: hit.aIdx + 1 },
    },
  });
  _renderAll();
  _emitVertexEdit(state.get('shapeDrawing'), 'addOnEdge');
  return true;
}

/**
 * Append the given 2D loops (in current plane-local coords) as a new
 * polygon. Used by "Add polygon from face" — caller picks a face and
 * projects its cross-section onto the editor's plane. Stays in edit
 * mode; emits a vertex-edit so the template is updated and one undo
 * entry is pushed via the usual addPolygon path.
 */
export function addPolygonFromFace(loops2D) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.plane) return false;
  if (!Array.isArray(loops2D) || loops2D.length === 0) return false;
  const outer = (loops2D[0] || []).map(p => [p[0], p[1]]);
  if (outer.length < 3) return false;
  const holes = loops2D.slice(1)
    .filter(l => Array.isArray(l) && l.length >= 3)
    .map(h => h.map(p => [p[0], p[1]]));
  const polys = _polygons(dr);
  const newPolygons = [...polys, { outer, holes }];
  state.setState({
    shapeDrawing: {
      ...dr,
      polygons:         newPolygons,
      activePolygonIdx: newPolygons.length - 1,
      selection:        null,
    },
  });
  _renderAll();
  _emitVertexEdit(state.get('shapeDrawing'), 'addPolygon');
  return true;
}

/**
 * Append a fresh polygon to the template and drop the editor into
 * addVertices for that polygon. The user clicks to place vertices and
 * snap-close commits — at which point we return to 'edit' phase with
 * BOTH polygons live (XOR composes them in the rendered geometry).
 */
export function newShape() {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.plane) return;
  const polys = _polygons(dr);
  const newPolygons = [...polys, { outer: [], holes: [] }];
  state.setState({
    shapeDrawing: {
      ...dr,
      phase:            'addVertices',
      polygons:         newPolygons,
      activePolygonIdx: newPolygons.length - 1,
      selection:        null,
    },
  });
  _renderAll();
}

/** Edge hit-test wrapper for main.js's contextmenu logic. */
export function pickEdgeForMenu(clientX, clientY) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit') return null;
  return _pickEdge(clientX, clientY, dr);
}

/**
 * Returns true if the screen point hits the polygon-level gizmo (any
 * handle, or the central area enclosed by it). Used by main.js's
 * contextmenu so a right-click on the gizmo opens the transform panel
 * instead of the generic edit menu.
 */
export function pickPolyGizmoForMenu(clientX, clientY) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !_polyGizmoMeta) return false;
  if (!dr.selection?.allVertices) return false;
  // Handle hit?
  if (_pickPolyGizmoHandle(clientX, clientY, dr)) return true;
  // Inside the rotate ring? — a generous catch so the user can right-
  // click anywhere on the gizmo proper to open the panel.
  const { centroid: [cx, cy], size } = _polyGizmoMeta;
  const sCenter = _planePointToScreen(dr.plane, [cx, cy]);
  const sEdge   = _planePointToScreen(dr.plane, [cx + size * POLY_GIZMO_RING_FRAC, cy]);
  if (!sCenter || !sEdge) return false;
  const r = Math.hypot(sEdge.x - sCenter.x, sEdge.y - sCenter.y);
  return Math.hypot(clientX - sCenter.x, clientY - sCenter.y) <= r;
}

/** Centroid of the currently-selected polygon in plane-local 2D, or null. */
export function getSelectedPolygonCentroid() {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.selection?.allVertices) return null;
  const target = _polygons(dr)[dr.selection.polyIdx];
  if (!target || target.outer.length < 3) return null;
  const { cx, cy } = _polyCentroid(target.outer);
  return [cx, cy];
}

/**
 * Apply a translate / rotate / scale to the selected polygon — used by
 * the floating transform panel (see ui/poly-transform-panel.js style
 * popup wired in main.js). Operations are recorded as one undo entry
 * each via _emitVertexEdit. Coordinates are plane-local; rotation is
 * around the polygon's centroid; scale is uniform around the centroid.
 */
export function applyPolyTranslate(dx, dy) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.selection?.allVertices) return false;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return false;
  const { polyIdx } = dr.selection;
  const polys = _polygons(dr);
  const target = polys[polyIdx];
  if (!target) return false;
  const newOuter = target.outer.map(([x, y]) => [x + dx, y + dy]);
  const newPolygons = polys.map((p, i) => i === polyIdx ? { ...p, outer: newOuter } : p);
  state.setState({ shapeDrawing: { ...dr, polygons: newPolygons } });
  _renderAll();
  _emitVertexEdit(state.get('shapeDrawing'), 'transformPolygon');
  return true;
}

export function applyPolyRotate(angleDeg) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.selection?.allVertices) return false;
  if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) < 1e-9) return false;
  const { polyIdx } = dr.selection;
  const polys = _polygons(dr);
  const target = polys[polyIdx];
  if (!target) return false;
  const { cx, cy } = _polyCentroid(target.outer);
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const newOuter = target.outer.map(([x, y]) => {
    const rx = x - cx, ry = y - cy;
    return [cx + rx * c - ry * s, cy + rx * s + ry * c];
  });
  const newPolygons = polys.map((p, i) => i === polyIdx ? { ...p, outer: newOuter } : p);
  state.setState({ shapeDrawing: { ...dr, polygons: newPolygons } });
  _renderAll();
  _emitVertexEdit(state.get('shapeDrawing'), 'transformPolygon');
  return true;
}

export function applyPolyScale(factor) {
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'edit' || !dr.selection?.allVertices) return false;
  if (!Number.isFinite(factor) || factor <= 0) return false;
  if (Math.abs(factor - 1) < 1e-9) return false;
  const { polyIdx } = dr.selection;
  const polys = _polygons(dr);
  const target = polys[polyIdx];
  if (!target) return false;
  const { cx, cy } = _polyCentroid(target.outer);
  const newOuter = target.outer.map(([x, y]) => [
    cx + (x - cx) * factor,
    cy + (y - cy) * factor,
  ]);
  const newPolygons = polys.map((p, i) => i === polyIdx ? { ...p, outer: newOuter } : p);
  state.setState({ shapeDrawing: { ...dr, polygons: newPolygons } });
  _renderAll();
  _emitVertexEdit(state.get('shapeDrawing'), 'transformPolygon');
  return true;
}


// ─────────────────────────────────────────────────────────────────────────
//  PLANE GEOMETRY
// ─────────────────────────────────────────────────────────────────────────

function _planeFromClick(clientX, clientY) {
  const T = window.THREE;
  if (!T) return null;
  const hit = sceneCore.pick(clientX, clientY);
  if (hit && hit.face) {
    const origin = [hit.point.x, hit.point.y, hit.point.z];
    const n = hit.face.normal.clone()
      .transformDirection(hit.object.matrixWorld)
      .normalize();
    const anchorNodeId = hit.object?.userData?.meshNodeId
                      ?? hit.object?.userData?.flatShapeNodeId
                      ?? hit.object?.userData?.nodeId
                      ?? null;
    return _buildPlane(origin, [n.x, n.y, n.z], anchorNodeId);
  }
  const cam = sceneCore.camera;
  const fwd = new T.Vector3();
  cam.getWorldDirection(fwd);
  const target = cam.position.clone().add(fwd.clone().multiplyScalar(PLANE_DISTANCE));
  return _buildPlane(
    [target.x, target.y, target.z],
    [-fwd.x, -fwd.y, -fwd.z],
    null,
  );
}

function _buildPlane(origin, normal, anchorNodeId = null) {
  const T = window.THREE;
  const N = new T.Vector3(...normal).normalize();
  let up = new T.Vector3(0, 1, 0);
  if (Math.abs(up.dot(N)) > 0.99) up = new T.Vector3(1, 0, 0);
  const X = new T.Vector3().crossVectors(up, N).normalize();
  const Y = new T.Vector3().crossVectors(N, X).normalize();
  const m = new T.Matrix4().makeBasis(X, Y, N);
  const q = new T.Quaternion().setFromRotationMatrix(m);
  return {
    origin,
    normal:          [N.x, N.y, N.z],
    qx:              [X.x, X.y, X.z],
    qy:              [Y.x, Y.y, Y.z],
    worldQuaternion: [q.x, q.y, q.z, q.w],
    anchorNodeId,
  };
}

function _projectOntoPlane(clientX, clientY, plane) {
  const T = window.THREE;
  if (!T) return null;
  const cam = sceneCore.camera;
  const dom = sceneCore.renderer.domElement;
  const rect = dom.getBoundingClientRect();
  const ndc = new T.Vector2(
     ((clientX - rect.left) / rect.width)  * 2 - 1,
    -((clientY - rect.top)  / rect.height) * 2 + 1,
  );
  const ray = new T.Raycaster();
  ray.setFromCamera(ndc, cam);
  const N = new T.Vector3(...plane.normal);
  const O = new T.Vector3(...plane.origin);
  const planeObj = new T.Plane(N, -N.dot(O));
  const hit = new T.Vector3();
  if (!ray.ray.intersectPlane(planeObj, hit)) return null;
  const v = hit.sub(O);
  return [
    v.dot(new T.Vector3(...plane.qx)),
    v.dot(new T.Vector3(...plane.qy)),
  ];
}

function _planeToWorld(plane, p2d) {
  const T = window.THREE;
  return new T.Vector3(...plane.origin)
    .add(new T.Vector3(...plane.qx).multiplyScalar(p2d[0]))
    .add(new T.Vector3(...plane.qy).multiplyScalar(p2d[1]));
}

function _isV0Close(plane, planePt, clientX, clientY) {
  const T = window.THREE;
  const cam = sceneCore.camera;
  const dom = sceneCore.renderer.domElement;
  const world = _planeToWorld(plane, planePt);
  const screen = world.project(cam);
  const rect = dom.getBoundingClientRect();
  const px = ((screen.x + 1) / 2) * rect.width  + rect.left;
  const py = ((1 - screen.y) / 2) * rect.height + rect.top;
  return Math.hypot(px - clientX, py - clientY) <= SNAP_PIXELS;
}


// ─────────────────────────────────────────────────────────────────────────
//  PREVIEW RENDERING
// ─────────────────────────────────────────────────────────────────────────

function _setupPreview() {
  const T = window.THREE;
  if (!T) return;
  _previewGroup = new T.Group();
  _previewGroup.name = 'shape-editor-preview';
  sceneCore.overlayScene.add(_previewGroup);
  // Per-frame rescale so the polygon-level gizmo stays a fixed % of the
  // viewport regardless of camera distance — independent of the
  // polygon's own dimensions.
  _tickUnsub = sceneCore.addTickHook(_onTick);
}

function _teardownPreview() {
  if (!_previewGroup) return;
  if (_tickUnsub) { _tickUnsub(); _tickUnsub = null; }
  _previewGroup.parent?.remove(_previewGroup);
  _previewGroup.traverse(o => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose?.());
    else o.material?.dispose?.();
  });
  _previewGroup    = null;
  _gridHelper      = null;
  _outlineLines    = [];
  _fillMesh        = null;
  _rubberLine      = null;
  _vertexPoints    = null;
  _vertexIndex     = [];
  _polyGizmoGroup  = null;
  _polyGizmoMeta   = null;
  _gizmoDrag       = null;
  _editDragging    = false;
  _hoverV0         = false;
}

function _positionPreviewToPlane(plane) {
  if (!_previewGroup) return;
  _previewGroup.position.set(...plane.origin);
  _previewGroup.quaternion.set(...plane.worldQuaternion);
  _previewGroup.updateMatrixWorld(true);
}

function _renderGrid() {
  if (!_previewGroup || _gridHelper) return;
  const T = window.THREE;
  const grid = new T.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x4a8be0, 0x2a4870);
  grid.rotation.x = Math.PI / 2;
  grid.material.transparent = true;
  grid.material.opacity     = 0.35;
  grid.material.depthTest   = false;
  grid.renderOrder          = -1;
  _previewGroup.add(grid);
  _gridHelper = grid;
}

/**
 * Top-level render: rebuilds vertices + outlines + XOR fill + rubber band
 * from the current shapeDrawing state. Cheap to call on every input
 * (≤ a few hundred vertices total in practice).
 */
function _renderAll() {
  if (!_previewGroup) return;
  const dr = state.get('shapeDrawing');
  if (!dr) return;
  const polys = _polygons(dr);
  _renderVertexCloud(polys, dr);
  _renderOutlines(polys, dr);
  _renderFill(polys);
  _renderPolyGizmo(polys, dr);
  // Rubber-band is updated by onPointerMove during addVertices; clear it
  // here so a phase change (e.g. snap-close) doesn't leave a stale segment.
  _clearRubberBand();
}

function _renderVertexCloud(polys, dr) {
  const T = window.THREE;
  if (_vertexPoints) {
    _previewGroup.remove(_vertexPoints);
    _vertexPoints.geometry?.dispose?.();
    _vertexPoints.material?.dispose?.();
    _vertexPoints = null;
  }
  _vertexIndex = [];
  const flat = [];   // [x, y, z, …]
  const cols = [];   // [r, g, b, …]
  const inEdit = dr.phase === 'edit';
  const sel    = dr.selection;
  // Polygon-level selection (double-click): every vertex of the chosen
  // polygon turns green so the user sees the whole shape is armed for
  // delete. Single-vertex selection still highlights just that vertex.
  for (let p = 0; p < polys.length; p++) {
    const outer = polys[p].outer;
    const polySelected = inEdit && sel?.allVertices && sel.polyIdx === p;
    for (let v = 0; v < outer.length; v++) {
      flat.push(outer[v][0], outer[v][1], 0);
      let c;
      if (polySelected)                                          c = COL_VSELECTED;
      else if (inEdit && sel && sel.polyIdx === p && sel.vIdx === v) c = COL_VSELECTED;
      else if (!inEdit && p === dr.activePolygonIdx && v === 0)  c = COL_V0_IDLE;
      else                                                       c = COL_VN;
      cols.push(c[0], c[1], c[2]);
      _vertexIndex.push({ polyIdx: p, vIdx: v });
    }
  }
  if (!flat.length) return;
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(new Float32Array(flat), 3));
  geo.setAttribute('color',    new T.BufferAttribute(new Float32Array(cols), 3));
  const mat = new T.PointsMaterial({
    size:             VERTEX_PIXEL_SIZE,
    sizeAttenuation:  false,
    vertexColors:     true,
    depthTest:        false,
    transparent:      true,
  });
  _vertexPoints = new T.Points(geo, mat);
  _vertexPoints.renderOrder = 2;
  _previewGroup.add(_vertexPoints);
}

function _renderOutlines(polys, dr) {
  const T = window.THREE;
  for (const ln of _outlineLines) {
    ln.parent?.remove(ln);
    ln.geometry?.dispose?.();
    ln.material?.dispose?.();
  }
  _outlineLines = [];
  for (let p = 0; p < polys.length; p++) {
    const outer = polys[p].outer;
    if (outer.length < 2) continue;
    const closed = (dr.phase !== 'addVertices') || p !== dr.activePolygonIdx;
    const positions = [];
    for (const [x, y] of outer) positions.push(x, y, 0);
    if (closed && outer.length >= 3) positions.push(outer[0][0], outer[0][1], 0);
    const geo = new T.BufferGeometry().setAttribute(
      'position', new T.Float32BufferAttribute(positions, 3),
    );
    const isPrimary = (dr.phase === 'addVertices' && p === dr.activePolygonIdx);
    const mat = new T.LineBasicMaterial({
      color:     isPrimary ? COL_OUTLINE_PRIMARY : COL_OUTLINE_SECONDARY,
      depthTest: false,
    });
    const ln = new T.Line(geo, mat);
    ln.renderOrder = 1;
    _previewGroup.add(ln);
    _outlineLines.push(ln);
  }
}

function _renderFill(polys) {
  const T = window.THREE;
  if (_fillMesh) {
    _previewGroup.remove(_fillMesh);
    _fillMesh.geometry?.dispose?.();
    _fillMesh.material?.dispose?.();
    _fillMesh = null;
  }
  // Build the XOR result as a list of THREE.Shape objects (each with its
  // own holes). `xorPolygonList` returns multipolygon rings:
  //   [ poly = [outerRing, holeRing, …], poly = […], … ]
  const composed = xorPolygonList(polys);
  if (!composed.length) return;
  const shapes = [];
  for (const poly of composed) {
    if (!poly?.length) continue;
    const outer = poly[0];
    if (!outer || outer.length < 3) continue;
    const shape = new T.Shape();
    shape.moveTo(outer[0][0], outer[0][1]);
    for (let i = 1; i < outer.length; i++) shape.lineTo(outer[i][0], outer[i][1]);
    shape.closePath();
    for (let h = 1; h < poly.length; h++) {
      const hole = poly[h];
      if (!hole || hole.length < 3) continue;
      const path = new T.Path();
      path.moveTo(hole[0][0], hole[0][1]);
      for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], hole[i][1]);
      path.closePath();
      shape.holes.push(path);
    }
    shapes.push(shape);
  }
  if (!shapes.length) return;
  const geom = new T.ShapeGeometry(shapes);
  const mat  = new T.MeshBasicMaterial({
    color:        COL_FILL,
    transparent:  true,
    opacity:      0.18,
    side:         T.DoubleSide,
    depthTest:    false,
  });
  _fillMesh = new T.Mesh(geom, mat);
  _fillMesh.renderOrder = 0;
  _previewGroup.add(_fillMesh);
}

function _clearRubberBand() {
  if (!_rubberLine) return;
  _rubberLine.parent?.remove(_rubberLine);
  _rubberLine.geometry?.dispose?.();
  _rubberLine.material?.dispose?.();
  _rubberLine = null;
}

function _renderRubberBand(activeOuter, cursorPt) {
  if (!_previewGroup) return;
  const T = window.THREE;
  _clearRubberBand();
  if (!activeOuter.length) return;
  const last = activeOuter[activeOuter.length - 1];
  const positions = [last[0], last[1], 0, cursorPt[0], cursorPt[1], 0];
  const geo = new T.BufferGeometry().setAttribute(
    'position', new T.Float32BufferAttribute(positions, 3),
  );
  const mat = new T.LineDashedMaterial({
    color:     0x88ccff,
    dashSize:  3,
    gapSize:   2,
    depthTest: false,
  });
  _rubberLine = new T.Line(geo, mat);
  _rubberLine.computeLineDistances?.();
  _rubberLine.renderOrder = 1;
  _previewGroup.add(_rubberLine);
}

function _highlightV0(hover) {
  // Only meaningful during addVertices for the active polygon. The vertex
  // cloud carries the active polygon's v0 in its own slot — find it via
  // _vertexIndex and recolour just that one entry.
  if (!_vertexPoints || !_vertexIndex.length) return;
  const dr = state.get('shapeDrawing');
  if (!dr || dr.phase !== 'addVertices') return;
  const colorAttr = _vertexPoints.geometry.getAttribute('color');
  if (!colorAttr) return;
  const target = _vertexIndex.findIndex(
    e => e.polyIdx === dr.activePolygonIdx && e.vIdx === 0,
  );
  if (target < 0) return;
  const c = hover ? COL_V0_HOVER : COL_V0_IDLE;
  colorAttr.array[target * 3 + 0] = c[0];
  colorAttr.array[target * 3 + 1] = c[1];
  colorAttr.array[target * 3 + 2] = c[2];
  colorAttr.needsUpdate = true;
}


// ─────────────────────────────────────────────────────────────────────────
//  PICKING
// ─────────────────────────────────────────────────────────────────────────

/**
 * Find the polygon vertex closest to the screen point, within
 * VERTEX_PICK_PIXELS, across ALL polygons. Returns `{ polyIdx, vIdx }` or null.
 */
function _pickVertex(clientX, clientY, dr) {
  const polys = _polygons(dr);
  let best = null, bestDist = VERTEX_PICK_PIXELS;
  for (let p = 0; p < polys.length; p++) {
    const outer = polys[p].outer;
    for (let v = 0; v < outer.length; v++) {
      const sx = _planePointToScreen(dr.plane, outer[v]);
      if (!sx) continue;
      const d = Math.hypot(sx.x - clientX, sx.y - clientY);
      if (d < bestDist) { bestDist = d; best = { polyIdx: p, vIdx: v }; }
    }
  }
  return best;
}

/**
 * Find the closest polygon edge under the screen point, within
 * EDGE_PICK_PIXELS. Returns `{ polyIdx, aIdx, bIdx, planePt }` (planePt =
 * the projected click in plane-local 2D), or null.
 */
function _pickEdge(clientX, clientY, dr) {
  const polys = _polygons(dr);
  let best = null, bestDist = EDGE_PICK_PIXELS;
  for (let p = 0; p < polys.length; p++) {
    const outer = polys[p].outer;
    const n = outer.length;
    for (let i = 0; i < n; i++) {
      const a = outer[i];
      const b = outer[(i + 1) % n];
      const sa = _planePointToScreen(dr.plane, a);
      const sb = _planePointToScreen(dr.plane, b);
      if (!sa || !sb) continue;
      const seg = _distancePointToSegment(clientX, clientY, sa.x, sa.y, sb.x, sb.y);
      if (seg.dist < bestDist) {
        bestDist = seg.dist;
        const planePt = [
          a[0] + (b[0] - a[0]) * seg.t,
          a[1] + (b[1] - a[1]) * seg.t,
        ];
        best = { polyIdx: p, aIdx: i, bIdx: (i + 1) % n, planePt };
      }
    }
  }
  return best;
}

function _planePointToScreen(plane, p2d) {
  const T = window.THREE;
  if (!T) return null;
  const cam = sceneCore.camera;
  const dom = sceneCore.renderer.domElement;
  const world = _planeToWorld(plane, p2d);
  const proj  = world.project(cam);
  if (proj.z < -1 || proj.z > 1) return null;
  const rect = dom.getBoundingClientRect();
  return {
    x: ((proj.x + 1) / 2) * rect.width  + rect.left,
    y: ((1 - proj.y) / 2) * rect.height + rect.top,
  };
}

function _distancePointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { dist: Math.hypot(px - ax, py - ay), t: 0 };
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}


// ─────────────────────────────────────────────────────────────────────────
//  POLYGON-LEVEL GIZMO  (flat 2D — only when selection.allVertices is true)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Render the flat gizmo at the selected polygon's centroid. Geometry is
 * built at UNIT size (arrows: origin → (1,0)/(0,1)); the surrounding
 * group is rescaled every frame by `_onTick` so the gizmo stays at
 * roughly POLY_GIZMO_SCREEN_FRAC of the viewport height.
 *
 * Handles:
 *   X arrow + arrowhead (red)   — drag translates polygon along plane qx.
 *   Y arrow + arrowhead (green) — drag translates along plane qy.
 *   Rotate ring (blue)          — drag rotates around the centroid.
 *   Uniform-scale square (grey) — drag scales around the centroid.
 *
 * All visuals are flat meshes (PlaneGeometry / RingGeometry / triangle
 * BufferGeometry) — `LineBasicMaterial.linewidth` is ignored on most
 * WebGL drivers so we use thin rectangles to get a true ~5 px stroke.
 */
function _renderPolyGizmo(polys, dr) {
  if (_polyGizmoGroup) {
    _polyGizmoGroup.parent?.remove(_polyGizmoGroup);
    _polyGizmoGroup.traverse(o => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
    _polyGizmoGroup = null;
    _polyGizmoMeta  = null;
  }
  const T = window.THREE;
  if (!T) return;
  if (!dr || dr.phase !== 'edit') return;
  const sel = dr.selection;
  if (!sel?.allVertices) return;
  const target = polys[sel.polyIdx];
  if (!target || target.outer.length < 3) return;

  const { cx, cy } = _polyCentroid(target.outer);
  // size is filled in lazily by _onTick; start at 1 (unit geometry) so
  // hit-tests done before the first tick still produce sensible numbers.
  _polyGizmoMeta = { polyIdx: sel.polyIdx, centroid: [cx, cy], size: 1 };

  const group = new T.Group();
  group.position.set(cx, cy, 0);
  group.renderOrder = 3;
  group.scale.setScalar(1);

  // X arrow body + arrowhead. Body stops short of the tip so the head
  // sits flush at (1, 0).
  group.add(_buildThickSegment(0, 0, 1 - POLY_GIZMO_TIP_LEN, 0, POLY_GIZMO_LINE_THICK, POLY_GIZMO_COL_X));
  group.add(_buildArrowhead(1, 0, 1, 0, POLY_GIZMO_TIP_LEN, POLY_GIZMO_TIP_HALF, POLY_GIZMO_COL_X));

  // Y arrow.
  group.add(_buildThickSegment(0, 0, 0, 1 - POLY_GIZMO_TIP_LEN, POLY_GIZMO_LINE_THICK, POLY_GIZMO_COL_Y));
  group.add(_buildArrowhead(0, 1, 0, 1, POLY_GIZMO_TIP_LEN, POLY_GIZMO_TIP_HALF, POLY_GIZMO_COL_Y));

  // Rotate ring — flat annulus (RingGeometry honours thickness; LineBasic
  // can't on most platforms).
  group.add(_buildRingMesh(POLY_GIZMO_RING_FRAC, POLY_GIZMO_LINE_THICK, POLY_GIZMO_COL_RING));

  // Scale square along the (+X,+Y) diagonal.
  const off = POLY_GIZMO_CUBE_FRAC * Math.SQRT1_2;
  group.add(_buildSquare(off, off, POLY_GIZMO_CUBE_HALF, POLY_GIZMO_COL_SCALE));

  // XY translate handle — small square just off the origin in the
  // (+X,+Y) corner. Drag freely along both plane axes simultaneously.
  group.add(_buildSquare(
    POLY_GIZMO_XY_OFFSET, POLY_GIZMO_XY_OFFSET,
    POLY_GIZMO_XY_HALF, POLY_GIZMO_COL_XY,
  ));

  _previewGroup.add(group);
  _polyGizmoGroup = group;
}

/** Centroid of a polygon's outer ring (simple vertex average). */
function _polyCentroid(outer) {
  let sx = 0, sy = 0;
  for (const [x, y] of outer) { sx += x; sy += y; }
  const n = outer.length || 1;
  return { cx: sx / n, cy: sy / n };
}

/**
 * Thin rectangle from (ax,ay) to (bx,by) with given thickness — a flat
 * plane mesh oriented along the segment. Used for arrow shafts.
 */
function _buildThickSegment(ax, ay, bx, by, thickness, color) {
  const T = window.THREE;
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return new T.Group();
  const angle = Math.atan2(dy, dx);
  const geo = new T.PlaneGeometry(len, thickness);
  const mat = new T.MeshBasicMaterial({
    color, side: T.DoubleSide, transparent: true, opacity: 1.0, depthTest: false,
  });
  const mesh = new T.Mesh(geo, mat);
  mesh.position.set((ax + bx) / 2, (ay + by) / 2, 0);
  mesh.rotation.z = angle;
  mesh.renderOrder = 3;
  return mesh;
}

/** Filled arrowhead triangle. `dir` must be a unit vector. */
function _buildArrowhead(tipX, tipY, dirX, dirY, length, halfWidth, color) {
  const T = window.THREE;
  const px = -dirY, py = dirX;                       // perpendicular unit
  const baseX = tipX - dirX * length;
  const baseY = tipY - dirY * length;
  const positions = new Float32Array([
    tipX, tipY, 0,
    baseX + px * halfWidth, baseY + py * halfWidth, 0,
    baseX - px * halfWidth, baseY - py * halfWidth, 0,
  ]);
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.BufferAttribute(positions, 3));
  geo.setIndex([0, 1, 2]);
  const mat = new T.MeshBasicMaterial({
    color, side: T.DoubleSide, transparent: true, opacity: 1.0, depthTest: false,
  });
  const mesh = new T.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return mesh;
}

/** Flat annulus — visible thickness, unlike LineBasicMaterial. */
function _buildRingMesh(radius, thickness, color) {
  const T = window.THREE;
  const inner = Math.max(0, radius - thickness * 0.5);
  const outer = radius + thickness * 0.5;
  const geo = new T.RingGeometry(inner, outer, POLY_GIZMO_RING_SAMPLES);
  const mat = new T.MeshBasicMaterial({
    color, side: T.DoubleSide, transparent: true, opacity: 1.0, depthTest: false,
  });
  const mesh = new T.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return mesh;
}

/** Filled square at (cx, cy). */
function _buildSquare(cx, cy, halfSize, color) {
  const T = window.THREE;
  const geo = new T.PlaneGeometry(halfSize * 2, halfSize * 2);
  const mat = new T.MeshBasicMaterial({
    color, side: T.DoubleSide, transparent: true, opacity: 0.9, depthTest: false,
  });
  const m = new T.Mesh(geo, mat);
  m.position.set(cx, cy, 0);
  m.renderOrder = 3;
  return m;
}

/**
 * Per-frame rescale: makes the gizmo group ≈ POLY_GIZMO_SCREEN_FRAC of
 * the viewport height regardless of the polygon's size or the camera
 * distance. Same trick as the main 3D gizmo's _tick. Also keeps
 * _polyGizmoMeta.size up to date so hit-testing knows the current scale.
 */
function _onTick() {
  if (!_polyGizmoGroup || !_polyGizmoMeta) return;
  const T = window.THREE;
  if (!T) return;
  const dr = state.get('shapeDrawing');
  if (!dr || !dr.plane) return;
  const cam = sceneCore.camera;
  const center = _planeToWorld(dr.plane, _polyGizmoMeta.centroid);
  const dist = cam.position.distanceTo(center);
  const fovRad = (cam.fov * Math.PI) / 180;
  const viewH = 2 * dist * Math.tan(fovRad / 2);
  const size = Math.max(1e-6, viewH * POLY_GIZMO_SCREEN_FRAC);
  _polyGizmoMeta.size = size;
  _polyGizmoGroup.scale.setScalar(size);
}

/**
 * Hit-test the gizmo handles against a screen-space cursor. Returns the
 * handle name ('tx' | 'ty' | 'rotate' | 'scale') or null if no hit.
 *
 * All math is done in screen-space — handle endpoints are projected via
 * _planePointToScreen so the picker works on tiny shapes (where the
 * gizmo arrows are short in plane-local units but still readable on
 * screen).
 */
function _pickPolyGizmoHandle(clientX, clientY, dr) {
  if (!_polyGizmoMeta) return null;
  const { centroid: [cx, cy], size } = _polyGizmoMeta;
  const plane = dr.plane;
  if (!plane) return null;

  const sCenter = _planePointToScreen(plane, [cx, cy]);
  if (!sCenter) return null;

  // Translate-X — segment from centroid to centroid + (size, 0).
  {
    const sEnd = _planePointToScreen(plane, [cx + size, cy]);
    if (sEnd) {
      const seg = _distancePointToSegment(clientX, clientY, sCenter.x, sCenter.y, sEnd.x, sEnd.y);
      if (seg.dist <= POLY_GIZMO_PICK_PIX) return 'tx';
    }
  }
  // Translate-Y — centroid → centroid + (0, size).
  {
    const sEnd = _planePointToScreen(plane, [cx, cy + size]);
    if (sEnd) {
      const seg = _distancePointToSegment(clientX, clientY, sCenter.x, sCenter.y, sEnd.x, sEnd.y);
      if (seg.dist <= POLY_GIZMO_PICK_PIX) return 'ty';
    }
  }
  // XY square — small handle near the origin in the (+X,+Y) corner.
  // Picked before the scale cube because it sits inside the rotate ring
  // and the user expects a click-near-origin to translate, not scale.
  {
    const off = size * POLY_GIZMO_XY_OFFSET;
    const sXY = _planePointToScreen(plane, [cx + off, cy + off]);
    if (sXY) {
      const d = Math.hypot(sXY.x - clientX, sXY.y - clientY);
      if (d <= POLY_GIZMO_PICK_PIX) return 'txy';
    }
  }
  // Scale cube — placed on the (+X,+Y) diagonal. CUBE_FRAC is along the
  // diagonal length, so split into x/y by SQRT1_2.
  {
    const diag = size * POLY_GIZMO_CUBE_FRAC * Math.SQRT1_2;
    const sCube = _planePointToScreen(plane, [cx + diag, cy + diag]);
    if (sCube) {
      const d = Math.hypot(sCube.x - clientX, sCube.y - clientY);
      if (d <= POLY_GIZMO_PICK_PIX) return 'scale';
    }
  }
  // Rotate ring — sample N points; closest sample distance ≈ ellipse distance.
  {
    const r = size * POLY_GIZMO_RING_FRAC;
    let bestRing = Infinity;
    for (let i = 0; i < POLY_GIZMO_RING_SAMPLES; i++) {
      const t = (i / POLY_GIZMO_RING_SAMPLES) * Math.PI * 2;
      const sp = _planePointToScreen(plane, [cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
      if (!sp) continue;
      const d = Math.hypot(sp.x - clientX, sp.y - clientY);
      if (d < bestRing) bestRing = d;
    }
    if (bestRing <= POLY_GIZMO_PICK_PIX) return 'rotate';
  }
  return null;
}

/**
 * Begin a gizmo-drag gesture. Caches the polygon's start vertices + the
 * cursor's start plane-local position so subsequent pointermoves can
 * compute a delta from a stable origin.
 */
function _gizmoDragStart(handle, clientX, clientY, dr) {
  const target = _polygons(dr)[_polyGizmoMeta.polyIdx];
  if (!target) return;
  const startPlanePt = _projectOntoPlane(clientX, clientY, dr.plane);
  if (!startPlanePt) return;
  _gizmoDrag = {
    handle,
    polyIdx:        _polyGizmoMeta.polyIdx,
    centroid:       [..._polyGizmoMeta.centroid],
    size:           _polyGizmoMeta.size,
    startVertices:  target.outer.map(p => [p[0], p[1]]),
    startPlanePt,
    startClientY:   clientY,
  };
}

/** Apply a gizmo-drag delta from current cursor to a fresh outer ring. */
function _gizmoDragUpdate(clientX, clientY, dr) {
  if (!_gizmoDrag) return false;
  const { handle, centroid, size, startVertices, startPlanePt, startClientY } = _gizmoDrag;
  const planePt = _projectOntoPlane(clientX, clientY, dr.plane);
  if (!planePt) return false;
  const dx = planePt[0] - startPlanePt[0];
  const dy = planePt[1] - startPlanePt[1];
  let newOuter;
  if (handle === 'tx') {
    newOuter = startVertices.map(([x, y]) => [x + dx, y]);
  } else if (handle === 'ty') {
    newOuter = startVertices.map(([x, y]) => [x, y + dy]);
  } else if (handle === 'txy') {
    newOuter = startVertices.map(([x, y]) => [x + dx, y + dy]);
  } else if (handle === 'rotate') {
    // Angle delta around centroid in plane-local 2D.
    const a0 = Math.atan2(startPlanePt[1] - centroid[1], startPlanePt[0] - centroid[0]);
    const a1 = Math.atan2(planePt[1] - centroid[1], planePt[0] - centroid[0]);
    const da = a1 - a0;
    const c = Math.cos(da), s = Math.sin(da);
    newOuter = startVertices.map(([x, y]) => {
      const rx = x - centroid[0], ry = y - centroid[1];
      return [centroid[0] + rx * c - ry * s, centroid[1] + rx * s + ry * c];
    });
  } else if (handle === 'scale') {
    // Screen-space dy → multiplicative factor (200 px = ×2). Same model
    // as the 3D gizmo's scale handle.
    const stops = -(clientY - startClientY) / 200;
    const factor = Math.max(0.05, Math.min(20, Math.pow(2, stops)));
    newOuter = startVertices.map(([x, y]) => [
      centroid[0] + (x - centroid[0]) * factor,
      centroid[1] + (y - centroid[1]) * factor,
    ]);
  } else {
    return false;
  }
  const polys = _polygons(dr);
  const newPolygons = polys.map((p, i) =>
    i === _gizmoDrag.polyIdx ? { ...p, outer: newOuter } : p,
  );
  state.setState({ shapeDrawing: { ...dr, polygons: newPolygons } });
  _renderAll();
  return true;
}

/** Finalise the gizmo drag. Pushes one undo entry via the vertexEdit channel. */
function _gizmoDragEnd() {
  if (!_gizmoDrag) return;
  _gizmoDrag = null;
  _emitVertexEdit(state.get('shapeDrawing'), 'transformPolygon');
}
