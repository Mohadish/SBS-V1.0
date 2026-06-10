/**
 * SBS Step Browser — Model Importers
 * =====================================
 * Load CAD and mesh files into the scene tree.
 *
 * Supported formats:
 *   CAD (via occt-import-js WASM):  .step / .stp / .iges / .igs / .brep
 *   Mesh (via Three.js loaders):    .obj / .stl / .gltf / .glb
 *
 * Architecture:
 *   Each loaded model produces:
 *     1. A Three.js Group hierarchy added to sceneCore.rootGroup
 *     2. A data tree (TreeNode hierarchy) added to state.treeData
 *     3. mesh registrations in materials.meshById + originalMaterials
 *     4. node registrations in state.nodeById (Map<id, TreeNode>)
 *
 *   Data nodes have an `object3d` runtime property (never serialized)
 *   that links them to their Three.js counterpart for convenience.
 *
 * Three.js is a global script (window.THREE).
 */

import state      from '../core/state.js';
import sceneCore  from '../core/scene.js';
import materials  from '../systems/materials.js';
import steps      from '../systems/steps.js';
import { createNode, generateId } from '../core/schema.js';
import { buildNodeMap } from '../core/nodes.js';
import { storeBaseTransformFromObject3D, captureMeshModelLocalMatrices } from '../core/transforms.js';
import * as modelCache  from './model-cache.js';            // V0.2.22.80 — CAD fast-load tail cache
import * as userSettings from '../core/user-settings.js';   // remembered bake preference

// Three.js add-on loaders — imported as ES modules from the local vendor bundles.
// These bundles import from three.module.proxy.mjs which wraps window.THREE,
// so three.min.js must have been loaded as a script tag before this module runs.
import { OBJLoader }   from '../../vendor/OBJLoader.bundle.mjs';
import { STLLoader }   from '../../vendor/STLLoader.bundle.mjs';
import { GLTFLoader }  from '../../vendor/GLTFLoader.bundle.mjs';
import { FBXLoader }   from '../../vendor/FBXLoader.bundle.mjs';
import { DRACOLoader } from '../../vendor/DRACOLoader.module.mjs';

// ── DRACO singleton ────────────────────────────────────────────────────────
// glTF files with DRACO mesh compression require a DRACOLoader instance
// wired into the GLTFLoader. The decoder itself is a small WASM blob
// (vendor/draco/draco_decoder.wasm + draco_wasm_wrapper.js + draco_decoder.js).
// We construct a single DRACOLoader for the renderer and reuse it across
// every GLTF load; the worker spins up lazily on first compressed-mesh
// encounter. setDecoderPath resolves against the document's base URL —
// `index.html` lives in `src/`, so `../vendor/draco/` lands in the right
// place under Electron's file:// renderer context.
let _dracoLoader = null;
function _getDracoLoader() {
  if (_dracoLoader) return _dracoLoader;
  _dracoLoader = new DRACOLoader();
  _dracoLoader.setDecoderPath('../vendor/draco/');
  // Prefer the WASM build (smaller + faster than the JS-only fallback).
  // setDecoderConfig({type:'js'}) would force the pure-JS decoder if
  // wasm-unsafe-eval ever gets removed from our CSP.
  _dracoLoader.setDecoderConfig({ type: 'wasm' });
  return _dracoLoader;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STABLE-ID HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Deterministic string hash (djb2 variant).
 * Same input always produces the same 7-char base-36 output.
 * Used to build stable node IDs so that reloading the same file always
 * produces the same IDs — meaning phantom nodes match without heuristics.
 */
function _stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/**
 * Compute a geometry fingerprint string from a THREE.BufferGeometry.
 * Combines vertex count, face count, and rounded bounding-box extents.
 * These values are intrinsic to the mesh — they are the same every time
 * the identical file is loaded, regardless of tree position or load order.
 *
 * Used as the primary component of a mesh node's stable ID so that
 * phantom placeholders can be matched to reloaded geometry by content,
 * not by position.
 *
 * @param {THREE.BufferGeometry} geom
 * @returns {string}
 */
function _geomFingerprint(geom) {
  if (!geom) return 'empty';

  const pos   = geom.attributes?.position;
  const idx   = geom.index;
  const verts = pos?.count ?? 0;
  const faces = idx ? Math.floor(idx.count / 3) : Math.floor(verts / 3);

  // Bounding box — rounded to 2 decimal places to absorb float noise.
  // computeBoundingBox() is already called by buildGeometry for OCCT;
  // for Three.js loaders we compute it on demand.
  if (!geom.boundingBox) geom.computeBoundingBox();
  const bb = geom.boundingBox;
  let bbStr = 'x';
  if (bb) {
    const r = v => Math.round(v * 100);
    bbStr = `${r(bb.min.x)},${r(bb.min.y)},${r(bb.min.z)},${r(bb.max.x)},${r(bb.max.y)},${r(bb.max.z)}`;
  }

  return `v${verts}:f${faces}:${bbStr}`;
}

/**
 * Replace random generateId() IDs on an innerRoot node tree with
 * deterministic stable hashes derived from mesh geometry content.
 *
 * Strategy for MESH nodes:
 *   Primary key  — geometry fingerprint (vertex count + face count + bounding box).
 *                  Intrinsic to the mesh. Same file → same fingerprint → same ID.
 *   Tiebreaker   — meshIndex (OCCT) or DFS counter (non-OCCT).
 *                  Handles the edge case of two geometrically identical parts
 *                  in the same assembly (e.g. duplicate bolts).
 *
 * Strategy for FOLDER/GROUP nodes:
 *   DFS counter — stable for the identical file; changes only if the internal
 *                 node structure changes (user said folders are assumed stable).
 *
 * The geometry fingerprint makes IDs independently verifiable: scanning the
 * reloaded model and hashing the same properties reproduces the exact same ID,
 * so phantom placeholder reassignment is absolute — no positional guessing.
 *
 * Mutates node.id in-place. Updates obj3dMap and object3d.userData accordingly.
 * Call BEFORE building nodeById or committing to state.
 *
 * @param {TreeNode} innerRoot  model content root (NOT the model wrapper node)
 * @param {string}   assetId   stable asset ID (scope for all hashes)
 * @param {Map}      obj3dMap  nodeId → Object3D  (updated in-place)
 */
function _remapToStableIds(innerRoot, assetId, obj3dMap) {
  let _dfsCounter = 0;

  function visit(node) {
    const oldId = node.id;
    let newId;

    if (node.type === 'mesh') {
      // ── Geometry-content hash (primary identity) ──────────────────────
      const obj3d = obj3dMap.get(oldId);
      const fp    = _geomFingerprint(obj3d?.geometry);

      if (node.meshIndex != null) {
        // OCCT: meshIndex is the tiebreaker — deterministic tessellation order.
        // Even two geometrically identical parts get distinct IDs via meshIndex.
        newId = `ms_${_stableHash(assetId + ':' + fp + ':m' + node.meshIndex)}`;
      } else {
        // OBJ / STL / GLTF: use DFS counter as tiebreaker.
        // Stable for the same file; unique within the model.
        newId = `ms_${_stableHash(assetId + ':' + fp + ':n' + _dfsCounter)}`;
        _dfsCounter++;
      }
    } else {
      // ── Folder / group node ───────────────────────────────────────────
      // No geometry to hash. DFS counter is sufficient — folder structure
      // is stable for the same file, and the user has confirmed folders
      // are assumed to be unaffected during relink.
      newId = `fd_${_stableHash(assetId + ':f' + _dfsCounter)}`;
      _dfsCounter++;
    }

    // Update obj3dMap: old random key → new stable key
    if (obj3dMap.has(oldId)) {
      const obj3d = obj3dMap.get(oldId);
      obj3dMap.delete(oldId);
      obj3dMap.set(newId, obj3d);
      if (obj3d?.userData) {
        if (obj3d.userData.meshNodeId === oldId) obj3d.userData.meshNodeId = newId;
        if (obj3d.userData.nodeId     === oldId) obj3d.userData.nodeId     = newId;
      }
    }

    node.id = newId;

    for (const child of (node.children || [])) visit(child);
  }

  visit(innerRoot);
}

/**
 * Re-register all mesh nodes in a subtree with the materials system.
 * Must be called AFTER _remapToStableIds so stable IDs are used.
 * (buildNodeFromOcct/buildNodeFromThreeObject registered with random IDs.)
 */
function _reregisterMeshes(node) {
  if (node.type === 'mesh' && node.object3d) {
    materials.registerMesh(node.id, node.object3d);
    node.object3d.userData.meshNodeId = node.id;
  }
  for (const child of (node.children || [])) _reregisterMeshes(child);
}

// ── OCCT tessellation quality presets ─────────────────────────────────────
// linearDeflection (bounding_box_ratio) is the dominant triangle-count driver
// for CAD: a bigger value = fewer triangles = faster tessellation AND faster
// geometry build / upload / render. The old hardcoded 0.0025 ('fine') is the
// slowest. Default is now 'normal' (≈2× looser) — measurably faster to open
// with negligible visual loss at assembly scale. 'draft' is for huge ones.
const OCCT_QUALITY_PRESETS = {
  draft:  { linearDeflection: 0.02,   angularDeflection: 1.0 },
  normal: { linearDeflection: 0.005,  angularDeflection: 0.5 },
  fine:   { linearDeflection: 0.0025, angularDeflection: 0.5 },
};
let _cadQuality = 'normal';
/** Set CAD (STEP/IGES/BREP) tessellation quality: 'draft' | 'normal' | 'fine'. */
export function setCadImportQuality(q) { if (OCCT_QUALITY_PRESETS[q]) _cadQuality = q; }
export function getCadImportQuality() { return _cadQuality; }
// Dev convenience: flip quality from the DevTools console to A/B test load
// times — e.g. `sbsCadQuality('fine')` then re-open the same STEP and compare
// the [import] timing log.
if (typeof window !== 'undefined') window.sbsCadQuality = setCadImportQuality;
function _occtParams() {
  const p = OCCT_QUALITY_PRESETS[_cadQuality] || OCCT_QUALITY_PRESETS.normal;
  return {
    linearUnit:           'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection:     p.linearDeflection,
    angularDeflection:    p.angularDeflection,
  };
}

// ── File extension helper ─────────────────────────────────────────────────
export function getFileExt(name) {
  const parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

// ── Module-level flag: skip color extraction when loading a saved project ─
let _loadingFromProject = false;

// ── Singleton OCCT instance ───────────────────────────────────────────────
let _occt = null;
async function ensureOCCT() {
  if (!window.occtimportjs) {
    throw new Error('occt-import-js script not loaded.');
  }
  if (!_occt) {
    _occt = await window.occtimportjs();
  }
  return _occt;
}


// ═══════════════════════════════════════════════════════════════════════════
//  GEOMETRY BUILDER
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Build a Three.js BufferGeometry from an OCCT meshData object.
 */
function buildGeometry(meshData) {
  const geom = new THREE.BufferGeometry();

  const pos  = meshData?.attributes?.position?.array ?? meshData?.attributes?.position;
  const norm = meshData?.attributes?.normal?.array   ?? meshData?.attributes?.normal;
  const uv   = meshData?.attributes?.uv?.array       ?? meshData?.attributes?.uv;
  const idx  = meshData?.index?.array                ?? meshData?.index;

  // Feed the OCCT arrays STRAIGHT into the BufferAttributes. The old code did
  // Array.from(...) first, which boxed each typed array into a plain JS Array
  // and then Three re-packed it back into a Float32Array — a needless double
  // copy + GC churn on every vertex buffer (painful on big assemblies).
  // Float32BufferAttribute already performs the single necessary copy.
  if (pos)  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (norm) geom.setAttribute('normal',   new THREE.Float32BufferAttribute(norm, 3));
  if (uv)   geom.setAttribute('uv',       new THREE.Float32BufferAttribute(uv, 2));
  if (idx) {
    const vertCount = pos ? (pos.length / 3) : 0;
    const IndexAttr = vertCount > 65535 ? THREE.Uint32BufferAttribute : THREE.Uint16BufferAttribute;
    geom.setIndex(new IndexAttr(idx, 1));
  }

  if (!norm && pos) geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Extract the dominant color from a Three.js material as a hex string.
 */
function materialToHexColor(mat) {
  if (!mat) return '#bfcad4';
  const src = Array.isArray(mat) ? mat.find(m => m?.color?.isColor) : mat;
  if (src?.color?.isColor) return '#' + src.color.getHexString();
  return '#bfcad4';
}

/**
 * Create a normalised MeshStandardMaterial from any imported material.
 * Preserves maps, opacity, etc. Converts roughness/metalness from other models.
 */
function normalizeMaterial(mat) {
  if (!mat) return new THREE.MeshStandardMaterial({ color: '#bfcad4', roughness: 0.55, metalness: 0.05 });
  if (mat.isShaderMaterial) return mat.clone();

  const roughness =
    Number.isFinite(mat.roughness)  ? THREE.MathUtils.clamp(mat.roughness,  0, 1) :
    Number.isFinite(mat.shininess)  ? THREE.MathUtils.clamp(1 - mat.shininess / 140, 0.08, 0.95) :
    mat.isMeshBasicMaterial         ? 0.92 :
    mat.isMeshLambertMaterial       ? 0.82 :
    mat.isMeshPhongMaterial         ? 0.38 : 0.55;

  const metalness =
    Number.isFinite(mat.metalness) ? THREE.MathUtils.clamp(mat.metalness, 0, 1) :
    mat.isMeshPhongMaterial        ? 0.12 : 0.05;

  const normalized = new THREE.MeshStandardMaterial({
    color:             mat.color?.isColor ? ('#' + mat.color.getHexString()) : '#bfcad4',
    side:              mat.side           ?? THREE.FrontSide,
    transparent:       !!mat.transparent,
    opacity:           Number.isFinite(mat.opacity) ? mat.opacity : 1,
    alphaTest:         mat.alphaTest      ?? 0,
    map:               mat.map            ?? null,
    alphaMap:          mat.alphaMap       ?? null,
    aoMap:             mat.aoMap          ?? null,
    aoMapIntensity:    mat.aoMapIntensity  ?? 1,
    emissive:          mat.emissive?.isColor ? mat.emissive.clone() : new THREE.Color(0x000000),
    emissiveIntensity: mat.emissiveIntensity ?? 1,
    normalMap:         mat.normalMap      ?? null,
    bumpMap:           mat.bumpMap        ?? null,
    bumpScale:         mat.bumpScale      ?? 1,
    flatShading:       !!mat.flatShading,
    vertexColors:      !!mat.vertexColors,
    roughness,
    metalness,
    envMap:            materials.metalEnvMap,
    envMapIntensity:   mat.envMapIntensity ?? 0.01,
  });

  normalized.name      = mat.name      ?? '';
  normalized.depthTest  = mat.depthTest  ?? true;
  normalized.depthWrite = mat.depthWrite ?? true;
  normalized.needsUpdate = true;
  return normalized;
}


// ═══════════════════════════════════════════════════════════════════════════
//  NODE BUILDERS
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Build a data tree node + Three.js Group from an OCCT node recursively.
 *
 * @param {object}          occtNode  OCCT node (name, meshes[], children[])
 * @param {object[]}        meshes    OCCT mesh array
 * @param {THREE.Group}     parent3d  parent Three.js group
 * @param {string}          prefix    id prefix
 * @param {Map<id, Object3D>} obj3dMap  filled in as we go
 * @returns {TreeNode}
 */
function buildNodeFromOcct(occtNode, meshes, parent3d, prefix, obj3dMap) {
  const nodeId  = generateId('node');
  const group   = new THREE.Group();
  group.name    = occtNode.name || 'Node';
  parent3d.add(group);

  // Data node (runtime object3d reference — not serialized)
  const node = createNode('folder', {
    id:   nodeId,
    name: occtNode.name || 'Node',
  });
  node.object3d = group;  // runtime only
  obj3dMap.set(nodeId, group);

  storeBaseTransformFromObject3D(node, group);

  // Mesh children
  (occtNode.meshes ?? []).forEach((meshIndex, i) => {
    const meshData = meshes[meshIndex];
    const meshId   = generateId('mesh');
    const geom     = buildGeometry(meshData);
    // OCCT color channels are 0.0–1.0 floats; CSS rgb() expects 0–255 integers.
    const color    = meshData?.color
      ? `rgb(${meshData.color.map(c => Math.round(c * 255)).join(',')})`
      : '#bfcad4';
    const mat      = new THREE.MeshStandardMaterial({
      color, roughness: 0.55, metalness: 0.05,
    });

    const threeMesh  = new THREE.Mesh(geom, mat);
    threeMesh.name   = occtNode.name ?? `Mesh ${i + 1}`;
    threeMesh.userData.nodeId = meshId;
    group.add(threeMesh);

    // Store bounding box for placeholder visualisation when this asset is missing.
    // buildGeometry() already calls computeBoundingBox(), so geom.boundingBox is ready.
    const _bb = geom.boundingBox;
    const meshBbox = _bb ? {
      min: [_bb.min.x, _bb.min.y, _bb.min.z],
      max: [_bb.max.x, _bb.max.y, _bb.max.z],
    } : null;

    const meshNode = createNode('mesh', {
      id:         meshId,
      name:       threeMesh.name,
      meshIndex:  meshIndex,
    });
    meshNode.bbox        = meshBbox;
    meshNode.fingerprint = _geomFingerprint(geom);
    meshNode.object3d    = threeMesh;  // runtime only
    obj3dMap.set(meshId, threeMesh);

    node.children.push(meshNode);

    // Register with materials system
    materials.registerMesh(meshId, threeMesh);
    // Link Three.js uuid → nodeId for picking
    threeMesh.userData.meshNodeId = meshId;
  });

  // Folder children
  (occtNode.children ?? []).forEach(child => {
    const childNode = buildNodeFromOcct(child, meshes, group, prefix, obj3dMap);
    node.children.push(childNode);
  });

  return node;
}

/**
 * Build a data tree node from an existing Three.js object tree.
 * Used for OBJ / STL / GLTF / FBX — and the hardware generator
 * (V0.2.22.37) which produces a single procedural Mesh that we wrap
 * the same way an STL import does.
 */
export function buildNodeFromThreeObject(obj, obj3dMap) {
  const isMesh = !!obj.isMesh;
  const name   = obj.name || (isMesh ? 'Mesh' : 'Node');

  if (isMesh) {
    const meshId = generateId('mesh');
    obj.userData.meshNodeId = meshId;

    // Normalize material — always collapse to a single MeshStandardMaterial.
    // Multi-material arrays (OBJ with multiple usemtl groups per mesh) must be
    // merged: we take the first valid material.  Keeping an array would crash
    // materials.registerMesh (which calls .clone() on the stored material) and
    // cause extractBaseColors to silently skip the mesh (Array.isArray guard).
    if (Array.isArray(obj.material)) {
      const mats   = obj.material.map(m => normalizeMaterial(m));
      obj.material = mats.find(m => m) ?? normalizeMaterial(null);
    } else {
      obj.material = normalizeMaterial(obj.material);
    }

    // Store bounding box for placeholder visualisation when this asset is missing.
    const meshNode = createNode('mesh', { id: meshId, name });
    if (obj.geometry) {
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      const _bb2 = obj.geometry.boundingBox;
      if (_bb2 && isFinite(_bb2.min.x) && isFinite(_bb2.max.x)) {
        meshNode.bbox = {
          min: [_bb2.min.x, _bb2.min.y, _bb2.min.z],
          max: [_bb2.max.x, _bb2.max.y, _bb2.max.z],
        };
      }
      meshNode.fingerprint = _geomFingerprint(obj.geometry);
    }
    meshNode.object3d = obj;
    obj3dMap.set(meshId, obj);
    materials.registerMesh(meshId, obj);
    return meshNode;
  }

  // Group / Object3D
  const nodeId = generateId('node');
  obj.userData.nodeId = nodeId;

  const node = createNode('folder', { id: nodeId, name });
  node.object3d = obj;
  obj3dMap.set(nodeId, obj);
  storeBaseTransformFromObject3D(node, obj);

  // Recurse into children (skip cameras and lights)
  obj.children.forEach(child => {
    if (child.isCamera || child.isLight) return;
    const childNode = buildNodeFromThreeObject(child, obj3dMap);
    if (childNode) node.children.push(childNode);
  });

  return node;
}


// ═══════════════════════════════════════════════════════════════════════════
//  BAKE & FLATTEN  (V0.1.65 — see project notes "GLB envelope" discussion)
// ═══════════════════════════════════════════════════════════════════════════
//
// Why this exists:
//   GLB / FBX exporters from CAD tools (Inventor, Solidworks, Blender CAD
//   add-ons) emit deeply nested scene graphs — 5+ levels of Group nodes
//   that each carry their own position / rotation / scale. The most common
//   killer is a 0.001 scale on the root group (mm→m bandaid). When the
//   user yanks a leaf mesh out of one of these groups, it loses the
//   group's contribution to its world matrix and "goes all over the
//   place" — wrong scale, wrong rotation, wrong position.
//
// What this fixes:
//   At IMPORT time, before the model lands in the scene:
//     1. Walk every mesh in the loaded Three.js scene.
//     2. Compute each mesh's matrix RELATIVE to the model root (this
//        accumulates the entire nested transform chain into one matrix).
//     3. Bake that matrix into the mesh's vertex positions (geometry.
//        applyMatrix4). Reset mesh.position/quaternion/scale to identity.
//     4. Reparent the mesh as a direct child of the model root, so the
//        nested groups are gone from the Three.js scene-graph.
//     5. Prune the now-empty intermediate Group nodes.
//     6. Flatten the SBS data tree to mirror: every mesh node becomes a
//        direct child of the model node; intermediate folder nodes go
//        away.
//
//   Result: a "clean" model with single-level hierarchy. Every leaf is
//   independent — moving one to another folder doesn't disturb the
//   others. Source transforms on the model node now apply uniformly to
//   all leaves with no nested transform-stack to fight.
//
// What this preserves:
//   - Mesh count + names + materials (Three.js .clone() on the geometry
//     only; materials shared by reference, as before).
//   - World pose of every mesh visually identical to the un-baked import.
//   - Per-mesh bounding boxes (recomputed from baked geometry).
//   - The model root's own pose stays as-imported — source-transform
//     edits compose on top.
//
// What this loses:
//   - The semantic "this group represents Engine_Subassembly" grouping.
//     v1 collapses everything into one level. A future v2 could preserve
//     named subassemblies via a heuristic ("group has a meaningful name
//     and >1 child"), but for now it's flat-everything.
//
// Limitations:
//   - Skinned meshes / morph-target meshes baked naively will look wrong.
//     CAD GLBs almost never use these so we accept the trade-off.
//   - Shared geometries are cloned per-mesh so each can be transformed
//     independently — slight memory cost.

/**
 * Bake transforms into vertex positions + flatten model hierarchy.
 *
 * @param {TreeNode} innerRoot  the data-tree root for this model
 *                              (its object3d is the Three.js group we work on)
 * @param {Map<string,Object3D>} obj3dMap  nodeId → object3d map (kept in
 *                              sync with the SBS data tree)
 */
function bakeAndFlattenImport(innerRoot, obj3dMap) {
  const T = window.THREE;
  if (!T || !innerRoot?.object3d) return;
  const root = innerRoot.object3d;

  // Single-Mesh GLBs are already "flat" — nothing to bake. STL is the
  // common case here.
  if (root.isMesh) return;

  // Fresh world matrices for the read pass.
  root.updateMatrixWorld(true);
  const rootWorldInverse = new T.Matrix4().copy(root.matrixWorld).invert();

  // Phase 1 — collect every descendant Mesh with its root-local matrix.
  // (Cameras + lights are filtered out same as buildNodeFromThreeObject.)
  const meshesToBake = [];
  (function collect(obj) {
    if (!obj || obj.isCamera || obj.isLight) return;
    if (obj.isMesh && obj.geometry) {
      const localToRoot = new T.Matrix4()
        .multiplyMatrices(rootWorldInverse, obj.matrixWorld);
      meshesToBake.push({ mesh: obj, localToRoot });
    }
    if (obj.children) for (const c of obj.children) collect(c);
  })(root);

  if (!meshesToBake.length) return;

  // Phase 2 — bake matrix into geometry, reset local, reparent to root.
  // Shared geometries get cloned-per-mesh so baking one doesn't poison
  // siblings that referenced the same source geometry.
  const seenGeoms = new WeakSet();
  for (const { mesh, localToRoot } of meshesToBake) {
    if (seenGeoms.has(mesh.geometry)) {
      mesh.geometry = mesh.geometry.clone();
    }
    seenGeoms.add(mesh.geometry);
    mesh.geometry.applyMatrix4(localToRoot);
    mesh.geometry.computeBoundingBox?.();
    mesh.geometry.computeBoundingSphere?.();

    if (mesh.parent !== root) {
      if (mesh.parent) mesh.parent.remove(mesh);
      root.add(mesh);
    }
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
  }

  // Phase 3 — prune empty intermediate groups (now-detached after the
  // mesh reparenting). Walk depth-first; remove any non-mesh node with
  // no remaining children.
  (function prune(obj) {
    if (obj === root) {
      for (const c of [...obj.children]) prune(c);
      return;
    }
    if (obj.children) for (const c of [...obj.children]) prune(c);
    if (!obj.isMesh && (!obj.children || obj.children.length === 0)) {
      if (obj.parent) obj.parent.remove(obj);
    }
  })(root);

  // Phase 4 — flatten the SBS data tree. Collect every mesh-type node,
  // re-stamp the bbox from the baked geometry (vertices changed), and
  // make them direct children of innerRoot. Intermediate folder nodes
  // are dropped from innerRoot.children — they served no further purpose.
  // We also collect the SET OF DROPPED node ids so the obj3dMap can be
  // pruned (Phase 5) — otherwise every imported model leaks one
  // object3dById entry per intermediate group it had, forever.
  const meshNodes = [];
  const droppedNodeIds = new Set();
  (function collectMeshNodes(node) {
    if (!node) return;
    if (node.type === 'mesh') {
      const bb = node.object3d?.geometry?.boundingBox;
      if (bb && isFinite(bb.min.x) && isFinite(bb.max.x)) {
        node.bbox = {
          min: [bb.min.x, bb.min.y, bb.min.z],
          max: [bb.max.x, bb.max.y, bb.max.z],
        };
      }
      meshNodes.push(node);
    } else if (node !== innerRoot) {
      // Non-mesh, non-root → an intermediate group node that will be
      // dropped from the data tree. Mark its id for obj3dMap cleanup.
      droppedNodeIds.add(node.id);
    }
    for (const c of (node.children || [])) collectMeshNodes(c);
  })(innerRoot);

  innerRoot.children = meshNodes;

  // Phase 5 — prune obj3dMap of dropped intermediate-group ids. The
  // map gets passed to finalizeModelImport which copies into
  // steps.object3dById; without this prune, every flattened-away
  // folder lingers in the global registry forever (sbsDiag.rmHealth
  // flagged 63 such orphans after a single GLB import).
  if (obj3dMap && droppedNodeIds.size) {
    for (const id of droppedNodeIds) obj3dMap.delete(id);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  FINALIZE (shared by all loaders)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * After building the Three.js group and data tree, integrate them
 * into the app state and scene.
 *
 * @param {THREE.Group}  group3d    the loaded Three.js root group
 * @param {TreeNode}     innerRoot  the root data node of the model's contents
 * @param {string}       name       display name (filename)
 * @param {object}       assetInfo  { originalPath, relativePath, type, fileSize }
 * @param {Map}          obj3dMap      nodeId → Object3D
 * @param {boolean}      extractColors true  = auto-create ColorPresets + enable solidOverride.
 * @param {object}       colorOpts     Options forwarded to materials.extractBaseColors().
 *                                     { globalDedup: false } → don't share presets across
 *                                     model loads (use for GLTF/GLB/FBX).
 */
export function finalizeModelImport(group3d, innerRoot, name, assetInfo, obj3dMap, extractColors = true, colorOpts = {}) {
  // ── assetId first — it seeds all stable node IDs ─────────────────────────
  const assetId = assetInfo?.id || generateId('asset');

  // Stable model node ID — deterministic from assetId.
  // Reloading the same file with the same assetEntry always produces this exact ID,
  // so phantom nodes in step snapshots match without any positional heuristics.
  const modelId = `m_${_stableHash(assetId)}`;

  // Ensure this asset is tracked in state.assets (needed for save/load)
  const currentAssets = state.get('assets') || [];
  if (!currentAssets.some(a => a.id === assetId)) {
    state.setState({
      assets: [...currentAssets, {
        id:           assetId,
        name:         name,
        type:         assetInfo?.type || 'model',
        originalPath: assetInfo?.originalPath || '',
        relativePath: assetInfo?.relativePath || '',
        fileHash:      null,
        fileSize:      assetInfo?.fileSize      ?? null,
        lastModified:  assetInfo?.lastModified  ?? null,
        importedAt:    new Date().toISOString(),
      }],
    });
  }

  // Tag every mesh node with this asset's ID so displaced-mesh ID remapping can
  // trace meshes back to their source model when they've been moved to custom folders.
  // Preserved by stripNode() on save; used by buildDisplacedMeshIdRemap() on load.
  function _tagMeshNodes(node, aid) {
    if (node.type === 'mesh') node.sourceAssetId = aid;
    (node.children || []).forEach(c => _tagMeshNodes(c, aid));
  }
  _tagMeshNodes(innerRoot, assetId);

  // ── Stable ID remap ──────────────────────────────────────────────────────
  // Replace random generateId() IDs with deterministic hashes.
  // buildNodeFromOcct/buildNodeFromThreeObject registered meshes with random IDs —
  // unregister those and re-register with stable IDs after the remap.
  const preRemapMeshIds = [];
  for (const [id, obj] of obj3dMap) {
    if (obj?.isMesh) preRemapMeshIds.push(id);
  }
  _remapToStableIds(innerRoot, assetId, obj3dMap);
  for (const oldId of preRemapMeshIds) materials.unregisterMesh(oldId);
  _reregisterMeshes(innerRoot);

  // Create the model node (wraps the entire loaded file)
  const modelNode = createNode('model', {
    id:   modelId,
    name: name,
  });
  modelNode.object3d = group3d;
  modelNode.children = [innerRoot];
  modelNode.assetId  = assetId;
  obj3dMap.set(modelId, group3d);
  storeBaseTransformFromObject3D(modelNode, group3d);

  // Capture each mesh's import-time pose in model-local space (and tag
  // it with the model's assetId). The Edit → Model source transform
  // feature uses these matrices to bake the source transform into the
  // mesh geometry vertices themselves — equivalent to reloading a
  // pre-edited model file. Must run BEFORE the group is added to the
  // scene root, so matrixWorld reflects only the import-time hierarchy.
  captureMeshModelLocalMatrices(group3d, assetId);

  // Add Three.js group to scene
  sceneCore.rootGroup.add(group3d);

  // Build / update the scene tree
  const existingTree = state.get('treeData');
  let sceneRoot;

  if (!existingTree || existingTree.type !== 'scene') {
    // Create scene root
    sceneRoot = createNode('scene', { id: 'scene_root', name: 'Scene' });
    sceneRoot.object3d = sceneCore.rootGroup;
    sceneRoot.children = [];
    obj3dMap.set('scene_root', sceneCore.rootGroup);
  } else {
    sceneRoot = existingTree;
  }

  sceneRoot.children.push(modelNode);

  // Build nodeById map from entire tree
  const nodeById = buildNodeMap(sceneRoot);

  // Also merge in any existing entries (other models already loaded)
  const existingMap = state.get('nodeById') ?? new Map();
  for (const [k, v] of existingMap) {
    if (!nodeById.has(k)) nodeById.set(k, v);
  }
  // Merge the obj3dMap into steps.object3dById
  for (const [k, v] of obj3dMap) {
    steps.object3dById.set(k, v);
  }

  state.setState({
    treeData: sceneRoot,
    nodeById,
    selectedId:       modelId,
    multiSelectedIds: new Set([modelId]),
  });

  state.markDirty();

  // Fit camera to new model
  const box = sceneCore.computeBoundingBox([group3d]);
  if (!box.isEmpty()) {
    const fitState = sceneCore.fitStateForBox(box);
    sceneCore.applyCameraState(fitState);
    sceneCore.controls.pivot.set(...fitState.pivot);
    sceneCore.controls.syncSpherical();
  }

  // ── Base color extraction ─────────────────────────────────────────────
  // Only for "flat geometry" formats (STEP/IGES/BREP/STL/OBJ) that carry
  // simple per-mesh colors with no texture maps.
  // GLTF/GLB/FBX skip this — their materials already have texture maps,
  // normal maps, PBR values, etc., and solidOverride would destroy them.
  // Also skipped when loading from a saved project (presets already restored).
  if (extractColors && !_loadingFromProject) {
    const newMeshIds = [];
    for (const [nodeId, obj] of obj3dMap) {
      if (obj?.isMesh) newMeshIds.push(nodeId);
    }
    materials.extractBaseColors(newMeshIds, colorOpts);
  }

  // Update materials (applies presets when solidOverride is on,
  // or restores originals when it is off)
  materials.applyAll();

  // When a new model is added (not loading from a saved project), propagate
  // the new mesh default color assignments into ALL existing step snapshots.
  // This simulates the object having been present since step 1 — every step
  // inherits the defaults and can override them independently.
  if (!_loadingFromProject) {
    const newDefaults = { ...materials.meshDefaultColors };
    const allSteps = state.get('steps');
    if (Array.isArray(allSteps) && allSteps.length) {
      let changed = false;
      for (const step of allSteps) {
        if (!step?.snapshot) continue;
        if (!step.snapshot.materials) step.snapshot.materials = {};
        for (const [meshId, presetId] of Object.entries(newDefaults)) {
          // Only inject if this step doesn't already have an assignment for this mesh
          if (!(meshId in step.snapshot.materials)) {
            step.snapshot.materials[meshId] = presetId;
            changed = true;
          }
        }
      }
      if (changed) state.setState({ steps: [...allSteps] });
    }
    // Immediately sync the active step so it reflects the new scene state
    steps.syncActiveStepNow();
  }

  // Notify
  state.emit('model:loaded', { modelNode, name, assetInfo });
  state.emit('status', `Loaded "${name}". Meshes: ${materials.meshById.size}. Colors: ${state.get('colorPresets').length}.`);

  return modelNode;
}


// ═══════════════════════════════════════════════════════════════════════════
//  LOADERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the SBS model (Three.js group + data tree) from an OCCT result and
 * finalize it. Shared by the fresh-parse path and the cache fast-path, so a
 * cached load produces a byte-identical model to the original parse.
 */
function _buildOcctModel(result, file, format, assetEntry) {
  const group3d  = new THREE.Group();
  group3d.name   = file.name;
  const obj3dMap = new Map();
  const innerRoot = buildNodeFromOcct(result.root, result.meshes, group3d, file.name, obj3dMap);
  return finalizeModelImport(group3d, innerRoot, file.name, {
    id:           assetEntry?.id,
    type:         format,
    fileSize:     file.size,
    lastModified: file.lastModified ?? null,
    originalPath: assetEntry?.originalPath || file.path || '',
    relativePath: assetEntry?.relativePath || '',
  }, obj3dMap);
}

/**
 * Load a .sbsmesh — the native converter's output for a big STEP that exceeds
 * the in-app WASM reader's ~2 GB cap. It IS the model-cache blob ({root,meshes}),
 * replayed through buildNodeFromOcct — the SAME path the WASM reader uses — so
 * the result matches: separated per-solid parts, OCC-native orientation, colours.
 */
async function loadSbsMeshFile(file, assetEntry = null) {
  state.emit('status', `Loading ${file.name} . . .`);
  const buffer = await file.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  const result = modelCache.deserializeOcctBlob(bytes);
  return _buildOcctModel(result, file, 'step', assetEntry);
}

/**
 * Load a STEP / IGES / BREP file via occt-import-js — with the fast-load tail
 * cache (V0.2.22.80). If the file carries a valid SBS cache tail we replay the
 * stored OCCT result (~1–2s, no kernel). Otherwise we parse the kernel (slow)
 * and, for an un-cached "original", offer to bake a fast-load copy.
 */
async function loadOcctFile(file, format, assetEntry = null, opts = {}) {
  const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const _t0  = _now();

  const buffer = await file.arrayBuffer();
  const bytes  = new Uint8Array(buffer);

  // ── FAST PATH: file has a baked SBS cache tail ──────────────────────────
  const footer = modelCache.readFooter(bytes);
  if (footer) {
    let ok = false;
    const head = bytes.subarray(0, footer.headLength);
    // A zero head-hash = "trusted": the native converter writes it so the app
    // doesn't re-hash a huge embedded STEP head on every open. Otherwise verify.
    const trusted = /^0+$/.test(footer.headHashHex);
    try { ok = trusted || await modelCache.verifyHead(head, footer.headHashHex); } catch { ok = false; }
    if (ok) {
      try {
        const payload = bytes.subarray(footer.payloadStart, footer.payloadStart + footer.payloadLength);
        const cached  = modelCache.deserializeOcctBlob(payload);
        const node    = _buildOcctModel(cached, file, format, assetEntry);
        const took    = Math.round(_now() - _t0);
        const parts   = (cached.meshes || []).length;
        console.log(`[import] ${file.name} — FAST cache load=${took}ms (parts=${parts})`);
        state.emit('status', `Loaded ${file.name} from cache in ${(took / 1000).toFixed(1)}s — ${parts} part(s) ⚡`);
        return node;
      } catch (err) {
        console.warn('[import] cache replay failed — re-parsing from source:', err);
        // fall through to the slow path using the clean head
      }
    }
  }

  // ── SLOW PATH: parse the kernel (clean head only — never the tail) ──────
  state.emit('status', `Initializing ${format.toUpperCase()} importer…`);
  const occt   = await ensureOCCT();
  const head   = footer ? bytes.subarray(0, footer.headLength) : bytes;
  const _tRead = _now();
  const params = _occtParams();
  state.emit('status', `Tessellating ${format.toUpperCase()} geometry (${_cadQuality})… first open of this file`);

  let result;
  if (format === 'step') result = occt.ReadStepFile(head, params);
  else if (format === 'iges') result = occt.ReadIgesFile(head, params);
  else if (format === 'brep') result = occt.ReadBrepFile(head, params);
  const _tParse = _now();
  if (!result?.success) throw new Error(`${format.toUpperCase()} import failed.`);

  const node       = _buildOcctModel(result, file, format, assetEntry);
  const _tBuild    = _now();
  const _meshCount = (result.meshes || []).length;
  const ms = (a, b) => Math.round(b - a);
  console.log(
    `[import] ${file.name} — read=${ms(_t0, _tRead)}ms  parse+tess=${ms(_tRead, _tParse)}ms  ` +
    `build=${ms(_tParse, _tBuild)}ms  TOTAL=${ms(_t0, _tBuild)}ms  (quality=${_cadQuality}, parts=${_meshCount})`,
  );
  state.emit('status',
    `Loaded ${file.name} in ${(ms(_t0, _tBuild) / 1000).toFixed(1)}s — ${_meshCount} part(s), quality=${_cadQuality}`);

  // ── BAKE: first open of an un-cached original → offer a fast-load copy ──
  // Skipped while restoring a project (no prompts) or when no path to write to.
  if (!footer && !opts.skipBake && !_loadingFromProject) {
    const srcPath = opts.sourcePath || file.path || assetEntry?.originalPath || assetEntry?.resolvedPath || '';
    if (srcPath && format === 'step') {
      _maybeBakeCache(srcPath, head, result, node?.assetId)
        .catch(err => console.warn('[import] bake skipped:', err?.message || err));
    }
  }

  return node;
}

// ── Fast-load cache: bake helpers ───────────────────────────────────────────
function _basename(p) { return String(p || '').replace(/^.*[\\/]/, ''); }
function _swapExt(p, ext) { return String(p || '').replace(/\.[^.\\/]+$/, '') + '.' + ext; }

/** Resolve the bake mode: remembered preference, else prompt the user. */
async function _resolveCacheMode(srcPath) {
  let remembered = null;
  try { remembered = userSettings.get()?.cad?.cacheMode || null; } catch { /* ignore */ }
  if (remembered && remembered !== 'ask') return remembered;
  return await _promptCacheMode(srcPath);
}

/**
 * Bake a fast-load copy of an un-cached original. Writes:
 *   'sbsobj'  → <name>.sbsobj   (original untouched, single combined file)
 *   'inplace' → the source file  (tail appended in place)
 *   'off'/'once' → nothing
 */
async function _maybeBakeCache(srcPath, headBytes, occtResult, assetId = null) {
  const mode = await _resolveCacheMode(srcPath);
  if (!mode || mode === 'off' || mode === 'once') return;

  state.emit('status', 'Baking fast-load cache…');
  const baked  = await modelCache.buildBakedFile(headBytes, occtResult);
  const target = mode === 'sbsobj' ? _swapExt(srcPath, 'sbsobj') : srcPath;
  const res    = await window.sbsNative?.writeFile?.(target, baked);
  if (res?.ok) {
    // For 'sbsobj' (a NEW file), repoint the live asset → the .sbsobj so the
    // project saves THAT reference and every later open / project reload hits
    // the cache. 'inplace' already keeps the same path (now cached), so no
    // repoint needed there.
    if (mode === 'sbsobj' && assetId) _repointAsset(assetId, target, baked.length);
    state.emit('status', `⚡ Fast-load cache saved → ${_basename(target)} — now using it for this model.`);
    console.log(`[import] baked cache (${mode}) → ${target}  (${(baked.length / 1e6).toFixed(1)} MB)`);
  } else {
    console.warn('[import] cache write failed:', res?.error);
    state.emit('status', `Could not write fast-load cache: ${res?.error || 'unknown error'}`);
  }
}

/**
 * Repoint a loaded asset's source reference to the baked .sbsobj file. The
 * assetId is unchanged (so all node IDs / step snapshots stay valid) — only
 * the on-disk file the project will reload from is swapped. Result: saving the
 * project records the .sbsobj, and reopening it fast-loads from the cache.
 */
function _repointAsset(assetId, newPath, sizeBytes) {
  const assets = state.get('assets') || [];
  const idx = assets.findIndex(a => a.id === assetId);
  if (idx < 0) return;
  const newExt = getFileExt(newPath);
  const next = assets.slice();
  const prev = next[idx];
  next[idx] = {
    ...prev,
    name:         _basename(newPath),
    originalPath: newPath,
    relativePath: prev.relativePath ? _swapExt(prev.relativePath, newExt) : '',
    fileSize:     sizeBytes ?? prev.fileSize,
    fileHash:     null,
    lastModified: Date.now(),
  };
  state.setState({ assets: next });
  state.markDirty?.();
  console.log(`[import] asset ${assetId} repointed → ${newPath}`);
}

// ── Native CAD converter routing (V0.2.22.81) ───────────────────────────────
// Big STEP/IGES blow past the 32-bit WASM reader's ~2 GB heap. When the native
// 64-bit OpenCascade sidecar is installed, route large files through it →
// produces a .glb (no cap, faster), loaded via the existing glТF path and the
// asset repointed so the project rides on the .glb. Returns the model node on
// success, or null to fall back to the in-app WASM reader.
const NATIVE_CAD_THRESHOLD = 120 * 1024 * 1024;   // 120 MB

async function _tryNativeCad(file, ext, assetEntry, opts) {
  if ((file.size || 0) <= NATIVE_CAD_THRESHOLD) return null;   // small → in-app reader + cache
  const srcPath = opts.sourcePath || file.path || assetEntry?.originalPath || assetEntry?.resolvedPath || '';
  if (!srcPath) return null;                                   // need a real path to convert

  let available = false;
  try { available = await window.sbsNative?.cad?.available?.(); } catch { available = false; }
  if (!available) {
    state.emit('status',
      `"${file.name}" is ${((file.size / 1e6) | 0)} MB — beyond the in-app CAD reader's ~2 GB limit. ` +
      `Install the native converter or export glTF. Trying the in-app reader anyway…`);
    console.warn('[import] big CAD file but native converter not installed — falling back to WASM (may OOM).');
    return null;
  }

  const preset   = OCCT_QUALITY_PRESETS[_cadQuality] || OCCT_QUALITY_PRESETS.normal;
  const linRatio = preset.linearDeflection;
  const angDeg   = preset.angularDeflection * 180 / Math.PI;
  const outPath  = _swapExt(srcPath, 'sbsobj');

  state.emit('status', `Converting ${file.name} with the native 64-bit CAD engine — no size limit. This can take a few minutes…`);
  const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const _t0  = _now();

  let res;
  try { res = await window.sbsNative.cad.convert(srcPath, outPath, linRatio, angDeg); }
  catch (err) { res = { ok: false, error: err?.message || String(err) }; }
  if (!res?.ok) {
    state.emit('status', `Native CAD conversion failed (${res?.error || 'unknown'}) — falling back to in-app reader.`);
    console.warn('[import] native convert failed:', res?.error);
    return null;
  }

  const rd = await window.sbsNative.readFile(outPath, 'buffer');
  if (!rd?.ok) { console.warn('[import] could not read converted file:', rd?.error); return null; }
  const bytes   = rd.data;
  const sbsFile = new File([bytes], _basename(outPath));
  const node    = await loadOcctFile(sbsFile, 'step', assetEntry, { skipBake: true });
  if (node?.assetId) _repointAsset(node.assetId, outPath, bytes.byteLength ?? bytes.length ?? null);

  const took = Math.round(_now() - _t0);
  state.emit('status', `Loaded ${file.name} via native CAD engine in ${(took / 1000).toFixed(1)}s → ${_basename(outPath)} ⚡`);
  console.log(`[import] native CAD convert+load ${took}ms → ${outPath}`);
  return node;
}

/** One-time-per-original modal asking where to store the fast-load cache. */
function _promptCacheMode(srcPath) {
  return new Promise((resolve) => {
    const base = _basename(srcPath);
    const dlg  = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.style.cssText = 'max-width:480px;';
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div class="sbs-dialog__title">⚡ Make this file load instantly?</div>
        <p class="small" style="margin:8px 0 12px;color:#94a3b8;line-height:1.5">
          <b>${base}</b> took a while to parse. SBS can stash the result so the
          <b>next open is ~1–2s</b> instead of re-parsing. Where should it go?
        </p>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;cursor:pointer">
          <input type="radio" name="cm" value="sbsobj" checked />
          <span class="small"><b>New <code>.sbsobj</code> file</b> — original STEP untouched, one combined file. Rename to <code>.step</code> still opens in CAD. <i>(recommended)</i></span>
        </label>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;cursor:pointer">
          <input type="radio" name="cm" value="inplace" />
          <span class="small"><b>Into this <code>.step</code> in place</b> — one file, but rewrites your original.</span>
        </label>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;cursor:pointer">
          <input type="radio" name="cm" value="once" />
          <span class="small"><b>Just load it this time</b> — don't cache (you'll be asked again next time).</span>
        </label>
        <label style="display:flex;gap:8px;align-items:center;margin:12px 0 0;cursor:pointer">
          <input type="checkbox" id="cm-remember" />
          <span class="small" style="color:#cbd5e1">Do this for all files — stop asking</span>
        </label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button class="btn" id="cm-ok" style="background:#0369a1;color:#f1f5f9">OK</button>
        </div>
      </div>
    `;
    const finish = async (val) => {
      const remember = dlg.querySelector('#cm-remember')?.checked;
      if (remember && val !== 'once') {
        try { await userSettings.patch({ cad: { cacheMode: val } }); } catch { /* ignore */ }
      }
      try { dlg.close(); dlg.remove(); } catch { /* ignore */ }
      resolve(val);
    };
    dlg.querySelector('#cm-ok').addEventListener('click', () => {
      const val = dlg.querySelector('input[name="cm"]:checked')?.value || 'once';
      finish(val);
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish('once'); });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

/**
 * Load an OBJ file.
 */
async function loadObjFile(file, assetEntry = null) {
  state.emit('status', 'Reading OBJ file…');
  const text   = await file.text();
  const loader = new OBJLoader();
  const obj    = loader.parse(text);
  obj.name = obj.name || file.name;

  const group3d  = new THREE.Group();
  group3d.name   = file.name;
  group3d.add(obj);
  const obj3dMap = new Map();
  const innerRoot = buildNodeFromThreeObject(obj, obj3dMap);

  return finalizeModelImport(group3d, innerRoot, file.name, {
    id:           assetEntry?.id,
    type:         'obj',
    fileSize:     file.size,
    lastModified: file.lastModified ?? null,
    originalPath: assetEntry?.originalPath || file.path || '',
    relativePath: assetEntry?.relativePath || '',
  }, obj3dMap);
}

/**
 * Load an STL file.
 */
async function loadStlFile(file, assetEntry = null) {
  state.emit('status', 'Reading STL file…');
  const buffer = await file.arrayBuffer();
  const loader = new STLLoader();
  const geom   = loader.parse(buffer);
  const mat    = new THREE.MeshStandardMaterial({ color: '#bfcad4', roughness: 0.55, metalness: 0.05 });
  const mesh   = new THREE.Mesh(geom, mat);
  mesh.name = file.name.replace(/\.[^.]+$/, '') || file.name;

  const group3d = new THREE.Group();
  group3d.name  = file.name;
  group3d.add(mesh);
  const obj3dMap = new Map();
  const innerRoot = buildNodeFromThreeObject(mesh, obj3dMap);

  return finalizeModelImport(group3d, innerRoot, file.name, {
    id:           assetEntry?.id,
    type:         'stl',
    fileSize:     file.size,
    lastModified: file.lastModified ?? null,
    originalPath: assetEntry?.originalPath || file.path || '',
    relativePath: assetEntry?.relativePath || '',
  }, obj3dMap);
}

/**
 * Load a GLTF / GLB file.
 */
async function loadGltfFile(file, assetEntry = null) {
  const ext  = getFileExt(file.name);
  state.emit('status', `Reading ${ext.toUpperCase()} file…`);

  return new Promise(async (resolve, reject) => {
    const loader = new GLTFLoader();
    // Required for any .gltf / .glb that uses KHR_draco_mesh_compression —
    // without it the parser throws "No DRACOLoader instance provided".
    // The singleton lazily-loads the WASM decoder on first compressed mesh.
    loader.setDRACOLoader(_getDracoLoader());
    const data   = ext === 'glb' ? await file.arrayBuffer() : await file.text();

    loader.parse(data, '', (gltf) => {
      try {
        const root = gltf.scene ?? gltf.scenes?.[0];
        if (!root) { reject(new Error('glTF import: no scene found.')); return; }
        root.name = root.name || file.name;

        const group3d = new THREE.Group();
        group3d.name  = file.name;
        group3d.add(root);
        const obj3dMap = new Map();
        const innerRoot = buildNodeFromThreeObject(root, obj3dMap);

        // Bake & flatten — fold every intermediate group's transforms
        // into vertex coordinates, then collapse the hierarchy so every
        // mesh sits as a direct child of the model root. Stabilises the
        // model against the "yank a leaf, everything explodes" failure
        // mode that nested GLBs trigger today. See helper comment.
        bakeAndFlattenImport(innerRoot, obj3dMap);

        // globalDedup:false — GLTF/GLB presets deduplicate only within this
        // model load, not globally.  Two unrelated GLBs that both happen to
        // have white (#ffffff) meshes won't share the same preset, so tinting
        // one model won't accidentally affect the other.
        resolve(finalizeModelImport(group3d, innerRoot, file.name, {
          id:           assetEntry?.id,
          type:         ext,
          fileSize:     file.size,
    lastModified: file.lastModified ?? null,
          originalPath: assetEntry?.originalPath || file.path || '',
          relativePath: assetEntry?.relativePath || '',
        }, obj3dMap, true, { globalDedup: false }));
      } catch (err) { reject(err); }
    }, reject);
  });
}


/**
 * Load an FBX file.
 * FBXLoader returns a THREE.Group containing the full scene graph.
 * Materials are normalised; color extraction + solid-override are disabled
 * (FBX files carry their own PBR materials and textures).
 */
async function loadFbxFile(file, assetEntry = null) {
  state.emit('status', 'Reading FBX file…');
  const buffer = await file.arrayBuffer();

  // FBXLoader.parse() is synchronous — returns the scene group directly.
  const loader = new FBXLoader();
  const group  = loader.parse(buffer, '');
  group.name   = group.name || file.name.replace(/\.[^.]+$/, '');

  const group3d  = new THREE.Group();
  group3d.name   = file.name;
  group3d.add(group);
  const obj3dMap = new Map();
  const innerRoot = buildNodeFromThreeObject(group, obj3dMap);

  // Bake & flatten — same rationale as the GLB path. FBXLoader emits
  // similarly deep node trees with per-bone matrices on intermediate
  // groups.
  bakeAndFlattenImport(innerRoot, obj3dMap);

  // globalDedup: false — FBX presets are per-model, same as GLTF.
  return finalizeModelImport(group3d, innerRoot, file.name, {
    id:           assetEntry?.id,
    type:         'fbx',
    fileSize:     file.size,
    lastModified: file.lastModified ?? null,
    originalPath: assetEntry?.originalPath || file.path || '',
    relativePath: assetEntry?.relativePath || '',
  }, obj3dMap, true, { globalDedup: false });
}


// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Load any supported model file.
 * Dispatches to the appropriate loader based on file extension.
 *
 * @param {File}    file    The File object (from file input or drag-drop)
 * @param {object}  opts    { append: boolean }  append=false clears scene first
 * @returns {Promise<TreeNode>}  the created model node
 */
export async function loadModelFile(file, opts = {}) {
  if (!file) return null;
  const ext          = getFileExt(file.name);
  const assetEntry   = opts.assetEntry ?? null;

  _loadingFromProject = !!opts.skipColorExtraction;
  try {
    // Large STEP/IGES → native 64-bit converter when available (skips the 2 GB
    // WASM wall). Returns the model on success, null to fall back to WASM.
    if (!_loadingFromProject && ['step', 'stp', 'iges', 'igs'].includes(ext)) {
      const native = await _tryNativeCad(file, ext, assetEntry, opts);
      if (native) return native;
    }
    // .sbsmesh = native converter output (model-cache blob) for huge STEPs.
    if (ext === 'sbsmesh') return await loadSbsMeshFile(file, assetEntry);
    // .sbsobj = a STEP with our fast-load cache tail (head is STEP bytes).
    if (['step', 'stp', 'sbsobj'].includes(ext)) return await loadOcctFile(file, 'step', assetEntry, opts);
    if (['iges', 'igs'].includes(ext))   return await loadOcctFile(file, 'iges', assetEntry, opts);
    if (['brep', 'brp'].includes(ext))   return await loadOcctFile(file, 'brep', assetEntry, opts);
    if (ext === 'obj')                   return await loadObjFile(file, assetEntry);
    if (ext === 'stl')                   return await loadStlFile(file, assetEntry);
    if (['gltf', 'glb'].includes(ext))   return await loadGltfFile(file, assetEntry);
    if (ext === 'fbx')                   return await loadFbxFile(file, assetEntry);

    state.emit('status', `Unsupported file type: .${ext || 'unknown'}.`);
    return null;
  } catch (err) {
    console.error('[importers] Load failed:', err);
    state.emit('status', `Failed to load "${file.name}": ${err.message}`);
    return null;
  } finally {
    _loadingFromProject = false;
  }
}

/**
 * Remove a model from the scene by modelId.
 * Cleans up Three.js objects, data nodes, and material registrations.
 *
 * @param {string} modelId  the model node ID
 */
export function removeModel(modelId) {
  const nodeById   = state.get('nodeById');
  const modelNode  = nodeById?.get(modelId);
  if (!modelNode) return;

  // Remove Three.js group + DISPOSE all geometry/material under it. Without
  // this, repeated load → delete → load cycles inflate GPU + heap until OOM
  // (each Mesh holds its own BufferGeometry buffers + Material textures).
  const group3d = steps.object3dById.get(modelId);
  if (group3d) {
    _disposeSceneSubtree(group3d);
    if (group3d.parent) group3d.parent.remove(group3d);
  }

  // Unregister all mesh nodes (also disposes the stored ORIGINAL material
  // via materials.unregisterMesh → see materials.js).
  const allNodes = [];
  const walk = (n) => { allNodes.push(n); n.children.forEach(walk); };
  walk(modelNode);
  const meshIds = allNodes.filter(n => n.type === 'mesh').map(n => n.id);
  materials.unregisterMeshes(meshIds);

  // Remove all nodes from nodeById and object3dById
  allNodes.forEach(n => {
    nodeById.delete(n.id);
    steps.object3dById.delete(n.id);
  });

  // Remove model from scene tree — produce a NEW children array so
  // setState's identity-aware diffs see the change. Mutating the array
  // in place was visible to subscribers but bypassed setState's contract.
  let treeData = state.get('treeData');
  if (treeData) {
    treeData = { ...treeData, children: treeData.children.filter(c => c.id !== modelId) };
  }

  state.setState({ treeData, nodeById });
  state.markDirty();
  state.emit('model:removed', modelId);
}

/**
 * Recursively dispose every Three.js geometry + material under `root`.
 * Safe to call on any Object3D — non-Mesh nodes are walked but skip the
 * dispose calls (they have nothing to free). Materials are deduped via
 * a Set so a shared material isn't disposed twice (would throw).
 */
function _disposeSceneSubtree(root) {
  if (!root) return;
  const seenMaterials = new Set();
  root.traverse(obj => {
    if (!obj) return;
    if (obj.geometry?.dispose) { try { obj.geometry.dispose(); } catch {} }
    const mat = obj.material;
    if (mat) {
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        if (!m || seenMaterials.has(m)) continue;
        seenMaterials.add(m);
        // Dispose any textures held on the material — they own GPU memory.
        for (const key of Object.keys(m)) {
          const v = m[key];
          if (v?.isTexture && v.dispose) { try { v.dispose(); } catch {} }
        }
        try { m.dispose?.(); } catch {}
      }
    }
  });
}

export default { loadModelFile, removeModel, getFileExt };
