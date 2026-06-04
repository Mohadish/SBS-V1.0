/**
 * SBS — Hardware actions LEGACY (V0.2.22.37 compat).
 *
 * V0.2.22.37 stored each procedural screw as its own asset (assetEntry
 * .type='hardware', assetEntry.hardware = {kind, params}). V0.2.22.38
 * replaced that with a template+instance system, but any test project
 * saved during the 37 window still references the old asset shape.
 *
 * This module is the single survivor of the old approach: just enough
 * code to regenerate the mesh + insert it as a standalone model node
 * so old projects open cleanly.  New code uses hardware-actions.js's
 * placeInstance() instead.
 */

import { generateScrewMesh, describeScrew } from './hardware-generator.js';
import {
  buildNodeFromThreeObject,
  finalizeModelImport,
} from '../io/importers.js';

/**
 * V0.2.22.37 legacy load-path hook. Called by sidebar-left.js
 * _onOpenProject when an assetEntry has type='hardware' and a hardware
 * field. Re-generates the mesh and inserts as a model node tagged with
 * the saved assetEntry.id so step snapshots match.
 */
export function regenerateHardwareAsset(assetEntry) {
  if (!assetEntry?.hardware) return null;
  const { kind, params } = assetEntry.hardware;
  let mesh, label;
  if (kind === 'screw') {
    mesh  = generateScrewMesh(params);
    label = describeScrew(params);
  } else {
    console.warn(`[hardware-legacy] unknown kind "${kind}" on assetEntry ${assetEntry.id} — skipping regen`);
    return null;
  }

  const T = window.THREE;
  mesh.name = label;
  const group3d = new T.Group();
  group3d.name  = label;
  group3d.add(mesh);

  const obj3dMap  = new Map();
  const innerRoot = buildNodeFromThreeObject(mesh, obj3dMap);

  return finalizeModelImport(
    group3d,
    innerRoot,
    label,
    {
      id:           assetEntry.id,
      type:         'hardware',
      originalPath: '',
      relativePath: '',
      fileSize:     null,
      lastModified: null,
      hardware:     { kind, params: { ...params } },
    },
    obj3dMap,
    /* extractColors */ false,
  );
}
