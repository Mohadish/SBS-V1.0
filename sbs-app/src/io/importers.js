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
import { storeBaseTransformFromObject3D } from '../core/transforms.js';

// Three.js add-on loaders — imported as ES modules from the local vendor bundles.
// These bundles import from three.module.proxy.mjs which wraps window.THREE,
// so three.min.js must have been loaded as a script tag before this module runs.
import { OBJLoader }  from '../../vendor/OBJLoader.bundle.mjs';
import { STLLoader }  from '../../vendor/STLLoader.bundle.mjs';
import { GLTFLoader } from '../../vendor/GLTFLoader.bundle.mjs';

// ── OCCT tessellation parameters (match POC) ──────────────────────────────
const OCCT_PARAMS = {
  linearUnit:            'millimeter',
  linearDeflectionType:  'bounding_box_ratio',
  linearDeflection:      0.0025,
  angularDeflection:     0.5,
};

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

  if (pos)  geom.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(pos), 3));
  if (norm) geom.setAttribute('normal',   new THREE.Float32BufferAttribute(Array.from(norm), 3));
  if (uv)   geom.setAttribute('uv',       new THREE.Float32BufferAttribute(Array.from(uv), 2));
  if (idx)  geom.setIndex(Array.from(idx));

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

    const meshNode = createNode('mesh', {
      id:         meshId,
      name:       threeMesh.name,
      meshIndex:  meshIndex,
    });
    meshNode.object3d = threeMesh;  // runtime only
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
 * Used for OBJ / STL / GLTF / FBX.
 */
function buildNodeFromThreeObject(obj, obj3dMap) {
  const isMesh = !!obj.isMesh;
  const name   = obj.name || (isMesh ? 'Mesh' : 'Node');

  if (isMesh) {
    const meshId = generateId('mesh');
    obj.userData.meshNodeId = meshId;

    // Normalize material
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map(m => normalizeMaterial(m));
    } else {
      obj.material = normalizeMaterial(obj.material);
    }

    const meshNode = createNode('mesh', { id: meshId, name });
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
function finalizeModelImport(group3d, innerRoot, name, assetInfo, obj3dMap, extractColors = true, colorOpts = {}) {
  const modelId = generateId('model');

  // Ensure this asset is tracked in state.assets (needed for save/load)
  const assetId = assetInfo?.id || generateId('asset');
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
 * Load a STEP / IGES / BREP file via occt-import-js.
 */
async function loadOcctFile(file, format, assetEntry = null) {
  state.emit('status', `Initializing ${format.toUpperCase()} importer…`);
  const occt = await ensureOCCT();

  const buffer = await file.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  state.emit('status', `Tessellating ${format.toUpperCase()} geometry…`);

  let result;
  if (format === 'step') result = occt.ReadStepFile(bytes, OCCT_PARAMS);
  else if (format === 'iges') result = occt.ReadIgesFile(bytes, OCCT_PARAMS);
  else if (format === 'brep') result = occt.ReadBrepFile(bytes, OCCT_PARAMS);

  if (!result?.success) {
    throw new Error(`${format.toUpperCase()} import failed.`);
  }

  const group3d  = new THREE.Group();
  group3d.name   = file.name;
  const obj3dMap = new Map();

  const innerRoot = buildNodeFromOcct(
    result.root,
    result.meshes,
    group3d,
    file.name,
    obj3dMap,
  );

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
    if (['step', 'stp'].includes(ext))   return await loadOcctFile(file, 'step', assetEntry);
    if (['iges', 'igs'].includes(ext))   return await loadOcctFile(file, 'iges', assetEntry);
    if (['brep', 'brp'].includes(ext))   return await loadOcctFile(file, 'brep', assetEntry);
    if (ext === 'obj')                   return await loadObjFile(file, assetEntry);
    if (ext === 'stl')                   return await loadStlFile(file, assetEntry);
    if (['gltf', 'glb'].includes(ext))   return await loadGltfFile(file, assetEntry);

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
 * Load a model file from an ArrayBuffer + metadata.
 * Used when re-loading assets from saved projects.
 *
 * @param {ArrayBuffer} buffer
 * @param {string}      name      filename (used to determine format)
 * @param {object}      assetInfo asset metadata from project file
 */
export async function loadModelBuffer(buffer, name, assetInfo = {}) {
  const file = new File([buffer], name);
  return loadModelFile(file);
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

  // Remove Three.js group
  const group3d = steps.object3dById.get(modelId);
  if (group3d?.parent) group3d.parent.remove(group3d);

  // Unregister all mesh nodes
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

  // Remove model from scene tree
  const treeData = state.get('treeData');
  if (treeData) {
    treeData.children = treeData.children.filter(c => c.id !== modelId);
  }

  state.setState({ treeData, nodeById });
  state.markDirty();
  state.emit('model:removed', modelId);
}

export default { loadModelFile, loadModelBuffer, removeModel, getFileExt };
