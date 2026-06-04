/**
 * SBS — Hardware actions (V0.2.22.37).
 *
 * Bridges the procedural geometry generator (systems/hardware-generator.js)
 * to the scene-tree import machinery (io/importers.js). The user picks
 * parameters in the Hardware tab → this module generates a mesh →
 * finalizeModelImport wraps it in a model node and inserts into the tree.
 *
 * Persistence: the asset entry carries `hardware: {kind, ...params}`
 * which survives save round-trip via the generic object spread in
 * io/project.js. On reload the project loader sees `assetEntry.type ===
 * 'hardware'` and calls regenerateHardwareAsset() instead of trying to
 * read a file from disk — see sidebar-left.js _onOpenProject.
 *
 * Naming: each generated hardware asset gets a stable id derived from
 * its parameters. Generating the same screw twice produces two distinct
 * assets (each with its own id), because the user expects two separate
 * tree entries they can position independently.
 */

import { generateScrewMesh, describeScrew } from './hardware-generator.js';
import {
  buildNodeFromThreeObject,
  finalizeModelImport,
} from '../io/importers.js';
import { generateId } from '../core/schema.js';

/**
 * Build + insert a screw into the scene. Returns the new model node.
 *
 * @param {object} params {diameter, length, headType, driveStyle}
 * @returns {TreeNode}
 */
export function addScrew(params) {
  return _insertHardwareMesh({
    kind:    'screw',
    label:   describeScrew(params),
    mesh:    generateScrewMesh(params),
    params,
  });
}

/**
 * Project-load path. Called for asset entries whose type='hardware' —
 * regenerates the mesh from the saved params and inserts via the same
 * pipeline as the live "add" path, but pinned to the saved assetEntry.id
 * so step snapshots and ID-remap match.
 *
 * @param {object} assetEntry  saved asset, must have .hardware {kind, params}
 * @returns {TreeNode|null}
 */
export function regenerateHardwareAsset(assetEntry) {
  if (!assetEntry?.hardware) return null;
  const { kind, params } = assetEntry.hardware;
  let mesh, label;
  if (kind === 'screw') {
    mesh  = generateScrewMesh(params);
    label = describeScrew(params);
  } else {
    console.warn(`[hardware] unknown kind "${kind}" on assetEntry ${assetEntry.id} — skipping regen`);
    return null;
  }
  return _insertHardwareMesh({
    kind, label, mesh, params,
    presetAssetId: assetEntry.id,
  });
}

// ─── Internal ──────────────────────────────────────────────────────────────

function _insertHardwareMesh({ kind, label, mesh, params, presetAssetId = null }) {
  const T = window.THREE;
  if (!T) throw new Error('THREE not loaded');
  if (!mesh) throw new Error('hardware: generator returned no mesh');

  mesh.name = label;

  // Wrap in an outer Group so finalizeModelImport's "model = outer group
  // around inner content" expectation holds. The inner is buildNode-
  // FromThreeObject(mesh, ...), same shape as the STL import path uses.
  const group3d = new T.Group();
  group3d.name  = label;
  group3d.add(mesh);

  const obj3dMap  = new Map();
  const innerRoot = buildNodeFromThreeObject(mesh, obj3dMap);

  // Reuse the standard model-import pipeline. extractColors=false because
  // the hardware mesh ships with a deliberately-chosen brushed-metal
  // material; we don't want the auto-color-preset extractor to override
  // it with a "grey" preset on first insert.
  return finalizeModelImport(
    group3d,
    innerRoot,
    label,
    {
      id:           presetAssetId || generateId('asset'),
      type:         'hardware',
      originalPath: '',
      relativePath: '',
      fileSize:     null,
      lastModified: null,
      // V0.2.22.37 — hardware-specific tag. Preserved through save by the
      // generic spread in io/project.js serialize() and consumed by the
      // load path to regenerate the mesh on reload.
      hardware:     { kind, params: { ...params } },
    },
    obj3dMap,
    /* extractColors */ false,
  );
}
