/**
 * SBS Step Browser — Combined Silhouette Outline Pass
 * ====================================================
 * Renders a SINGLE silhouette outline around the COMBINED screen-space
 * shape of the currently-selected meshes.
 *
 * V0.2.22.21 — fills a gap V0.2.18's outlineOnly mode left:
 *   - V0.2.18 made locked-folder selections render as per-mesh edge
 *     outlines only (no surface tint). Looked correct but visually
 *     noisy — hundreds of individual mesh outlines.
 *   - User wanted "an outline all around the perimeter of the model
 *     mass" — one silhouette wrapping the combined shape.
 *
 * Technique: screen-space stencil + edge detect.
 *   1. Pass 1 — render selected meshes to an offscreen WebGLRenderTarget
 *      using an override MeshBasicMaterial(white, depthTest:false).
 *      Hides all OTHER meshes for this pass so the target receives the
 *      union mask of the selection.
 *   2. Pass 2 — render a fullscreen quad with a Sobel-style fragment
 *      shader that samples the mask at 4 neighbours and emits the
 *      outline color anywhere the mask transitions black↔white.
 *      depthTest:false on the composite means the outline always sits
 *      on top of the scene.
 *
 * Self-contained: subscribes to selection:change directly. No call
 * sites in materials.js / main.js. scene.js needs three hooks:
 *   - init: createOutlinePass(renderer, width, height)
 *   - resize: outlinePass.resize(width, height)
 *   - render: outlinePass.render(scene, camera) AFTER the main render
 *
 * Performance: when nothing is selected, render() is a one-line early
 * exit. When something IS selected, cost = one extra scene render
 * (with most meshes invisible) + one fullscreen quad.
 */

import { state } from '../core/state.js';
import { materials } from './materials.js';

let _renderer        = null;
let _maskTarget      = null;
let _maskOverrideMat = null;
let _fsScene         = null;
let _fsCamera        = null;
let _fsQuad          = null;
let _edgeMat         = null;
let _outlinedMeshes  = new Set();   // Three.js Object3D references (selection)
let _previewMeshes   = new Set();   // ray-select cycle preview (V0.2.22.21.4)
let _previewColor    = '#ff8c00';
let _initialized     = false;

const _EDGE_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const _EDGE_FRAGMENT = `
  uniform sampler2D uMask;
  uniform vec3      uColor;
  uniform vec2      uResolution;
  uniform float     uThickness;
  varying vec2      vUv;

  void main() {
    vec2 t = (uThickness / uResolution);
    float c = texture2D(uMask, vUv).r;
    float n = texture2D(uMask, vUv + vec2(0.0,  t.y)).r;
    float s = texture2D(uMask, vUv + vec2(0.0, -t.y)).r;
    float e = texture2D(uMask, vUv + vec2( t.x, 0.0)).r;
    float w = texture2D(uMask, vUv + vec2(-t.x, 0.0)).r;
    // Edge wherever the center differs from any neighbour.
    float edge = step(0.5,
      abs(c - n) + abs(c - s) + abs(c - e) + abs(c - w));
    if (edge < 0.5) discard;
    gl_FragColor = vec4(uColor, 1.0);
  }
`;

/**
 * Initialise the outline pass. Call AFTER sceneCore has constructed
 * its WebGLRenderer. Idempotent — safe to call again on hot-reload.
 */
export function initOutlinePass(renderer, width, height) {
  if (_initialized) return;
  const THREE = window.THREE;
  if (!THREE || !renderer) return;
  _renderer = renderer;

  _maskTarget = new THREE.WebGLRenderTarget(
    Math.max(1, width),
    Math.max(1, height),
    {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format:    THREE.RGBAFormat,
      depthBuffer: true,
    },
  );

  _maskOverrideMat = new THREE.MeshBasicMaterial({
    color:      0xffffff,
    // X-ray: outlines appear even when occluded by other objects.
    // Matches Three.js OutlinePass convention. Without this, a hidden
    // half of the selection silhouette would be missing from the outline.
    depthTest:  false,
    depthWrite: false,
    side:       THREE.DoubleSide,
  });

  _fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _fsScene  = new THREE.Scene();
  _edgeMat  = new THREE.ShaderMaterial({
    uniforms: {
      uMask:       { value: _maskTarget.texture },
      uColor:      { value: new THREE.Color(state.get('selectionOutlineColor') ?? '#00ffff') },
      uResolution: { value: new THREE.Vector2(width, height) },
      uThickness:  { value: 1.5 },
    },
    vertexShader:   _EDGE_VERTEX,
    fragmentShader: _EDGE_FRAGMENT,
    transparent:    true,
    depthTest:      false,
    depthWrite:     false,
  });
  _fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), _edgeMat);
  _fsScene.add(_fsQuad);

  _initialized = true;

  // Update outlined-mesh set on every selection change. The actual
  // dereferencing (id → Object3D) happens here because the materials
  // system owns meshById (we read it lazily on event).
  state.on('selection:change', _refreshFromSelection);
  // Also retune the outline color when the selection palette changes.
  state.on('change:selectionOutlineColor', _refreshFromState);

  _refreshFromSelection();
  _refreshFromState();
}

export function resizeOutlinePass(width, height) {
  if (!_initialized) return;
  _maskTarget.setSize(Math.max(1, width), Math.max(1, height));
  _edgeMat.uniforms.uResolution.value.set(width, height);
}

/**
 * Render the outline pass. Call AFTER the main scene render. Composites
 * onto the canvas in additive mode (won't clear what's already drawn).
 * No-op when nothing is selected AND no preview is active.
 *
 * Two channels:
 *   1. Selection outline — selection color, set of meshes from current
 *      multiSelectedIds (via _refreshFromSelection).
 *   2. Preview outline (V0.2.22.21.4) — preview color, set of meshes
 *      from the active ray-select cycle entity. Lets locked folders
 *      (which carry just the folder id in their entity meshIds) show
 *      a silhouette during the cycle in the hue-shifted preview color.
 */
export function renderOutlinePass(scene, camera) {
  if (!_initialized || !_renderer) return;
  const hasSelection = _outlinedMeshes && _outlinedMeshes.size > 0;
  const hasPreview   = _previewMeshes  && _previewMeshes.size  > 0;
  if (!hasSelection && !hasPreview) return;

  if (hasSelection) {
    _runOutlinePass(scene, camera, _outlinedMeshes,
      state.get('selectionOutlineColor') ?? '#00ffff');
  }
  if (hasPreview) {
    _runOutlinePass(scene, camera, _previewMeshes, _previewColor);
  }
}

/**
 * Internal — one mask-and-composite cycle for a given mesh set + color.
 */
function _runOutlinePass(scene, camera, meshSet, hexColor) {
  const THREE = window.THREE;

  // Temporarily hide non-set meshes (preserving original hidden state).
  // Override material flattens everything to flat white in the mask.
  const visBackup = [];
  scene.traverse(obj => {
    if (obj.isMesh) {
      visBackup.push([obj, obj.visible]);
      obj.visible = obj.visible && meshSet.has(obj);
    }
  });
  const prevOverride = scene.overrideMaterial;
  scene.overrideMaterial = _maskOverrideMat;

  const prevTarget     = _renderer.getRenderTarget();
  const prevClearCol   = _renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = _renderer.getClearAlpha();

  _renderer.setRenderTarget(_maskTarget);
  _renderer.setClearColor(0x000000, 1);
  _renderer.clear();
  _renderer.render(scene, camera);

  // Restore renderer state and scene visibility / override.
  _renderer.setRenderTarget(prevTarget);
  _renderer.setClearColor(prevClearCol, prevClearAlpha);
  scene.overrideMaterial = prevOverride;
  for (const [obj, v] of visBackup) obj.visible = v;

  // Composite outline onto canvas with this pass's color.
  _edgeMat.uniforms.uColor.value = new THREE.Color(hexColor);
  const prevAutoClear = _renderer.autoClear;
  _renderer.autoClear = false;
  _renderer.render(_fsScene, _fsCamera);
  _renderer.autoClear = prevAutoClear;
}

/**
 * V0.2.22.21.4 — set the PREVIEW silhouette to wrap the descendant
 * meshes of `nodeId` in `hexColor`. Used by the ray-select cycle so
 * locked folder entities (which carry only the folder id in their
 * meshIds) still get visible feedback when highlighted in the picker.
 * Pair with clearOutlinePreview() on confirm / cancel / close.
 */
export function setOutlinePreview(nodeId, hexColor) {
  if (!_initialized) return;
  if (!materials?.meshById || !nodeId) {
    _previewMeshes = new Set();
    return;
  }
  const nodeById = state.get('nodeById') || new Map();
  const out = new Set();
  const collectMeshes = (n) => {
    if (!n) return;
    if (n.type === 'mesh') {
      const m = materials.meshById.get(n.id);
      if (m) out.add(m);
    }
    for (const c of (n.children || [])) collectMeshes(c);
  };
  collectMeshes(nodeById.get(nodeId));
  _previewMeshes = out;
  _previewColor  = hexColor || '#ff8c00';
}

export function clearOutlinePreview() {
  _previewMeshes = new Set();
}

/**
 * Internal — recompute the outlined-mesh set from current selection state.
 * Walks every selected node id (state.multiSelectedIds) and collects
 * mesh Three.js Objects via materials.meshById. Skips ids that don't
 * resolve to a mesh (folders, models — their geometry comes from their
 * descendant meshes which ARE in multi).
 */
function _refreshFromSelection() {
  // materials owns meshById (the id → Three.js Mesh registry). We just
  // read it; no need to push state from materials side.
  if (!materials?.meshById) {
    _outlinedMeshes = new Set();
    return;
  }
  // V0.2.22.21.1 — walk DESCENDANTS of every selected node, not just
  // the selected ids themselves. Reason: a folder click puts only the
  // folder id in multiSelectedIds (the user's new progressive-click
  // semantics from V0.2.22.20, and also the locked-folder promotion
  // fix below). Folders aren't in meshById, so without walking we'd
  // get an empty outlined set for any container selection.
  const ids = state.get('multiSelectedIds') || new Set();
  const nodeById = state.get('nodeById') || new Map();
  const out = new Set();
  const collectMeshes = (node) => {
    if (!node) return;
    if (node.type === 'mesh') {
      const m = materials.meshById.get(node.id);
      if (m) out.add(m);
    }
    for (const child of (node.children || [])) collectMeshes(child);
  };
  for (const id of ids) {
    const node = nodeById.get(id);
    if (node) collectMeshes(node);
  }
  _outlinedMeshes = out;
}

function _refreshFromState() {
  if (!_edgeMat) return;
  const THREE = window.THREE;
  const hex = state.get('selectionOutlineColor') ?? '#00ffff';
  _edgeMat.uniforms.uColor.value = new THREE.Color(hex);
}

/**
 * Debug / introspection — returns the current outlined-mesh count.
 * Used by the V0.2.22.21 commit to verify the pass actually has work.
 */
export function _outlinePassDebugCount() {
  return _outlinedMeshes.size;
}
