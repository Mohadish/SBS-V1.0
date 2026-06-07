/**
 * SBS Step Browser — Hardware Templates (V0.2.22.38)
 * ===================================================
 * Library + instance pipeline for procedural fasteners. Mirrors
 * systems/flat-shapes.js exactly so the gizmo, step snapshots, save/load,
 * selection, and color presets all work with zero special-casing.
 *
 *   HardwareTemplate            (state.hardwareTemplates)
 *                               — { id, name, kind, params }
 *   HardwareInstance tree node  (type='hardwareInstance')
 *                               — { templateId, transforms, ... }
 *
 * Geometry is built from the TEMPLATE's spec and cached on the instance's
 * `object3d.userData.hwBuildKey`. Editing a template ripples to every
 * instance via rebuildHardwareInstancesOfTemplate().
 */

import { state }                        from '../core/state.js';
import { applyNodeTransformToObject3D } from '../core/transforms.js';
import { materials }                    from './materials.js';
import { generateScrewMesh, generateNutMesh } from './hardware-generator.js';

// ─── Template lookup ────────────────────────────────────────────────────────

function _lookupTemplate(templateId) {
  if (!templateId) return null;
  const tpls = state.get('hardwareTemplates') || [];
  return tpls.find(t => t.id === templateId) || null;
}

/**
 * Cache key for a hardware mesh. Rebuilds happen only when the key
 * changes between the cached one (stored on object3d.userData) and the
 * key derived from the live template + per-instance washers (V0.2.22.47).
 */
function _buildKey(tpl, washers) {
  if (!tpl) return '';
  const p = tpl.params || {};
  const w = washers || {};
  return `${tpl.kind}|${p.diameter}|${p.length}|${p.headType}|${p.driveStyle}`
       + `|w:${w.count || 0}|s:${w.spring ? 1 : 0}`;
}

// ─── Geometry build per kind ────────────────────────────────────────────────

function _generateForTemplate(tpl, washers) {
  if (!tpl) return null;
  switch (tpl.kind) {
    case 'screw':
      return generateScrewMesh(tpl.params || {}, washers);
    // Future kinds (washer / nut) land here; same shape — return a Mesh.
    default:
      console.warn(`[hardware] unknown template kind: ${tpl.kind}`);
      return null;
  }
}

// ─── Public API — mirrors flat-shapes.js ────────────────────────────────────

/**
 * Build or reuse the THREE.Mesh for a hardware-instance node. Lazy:
 * returns the cached mesh when the template hasn't changed; rebuilds
 * when the spec has shifted; returns null if the template is missing.
 *
 * Called from systems/steps.js during scene rebuild, and from
 * rebuildHardwareInstancesOfTemplate after a template edit.
 */
export function ensureHardwareInstanceObject3D(node) {
  if (!node) return null;
  if (node.type !== 'hardwareInstance') return null;
  if (!node.templateId) return null;

  const tpl = _lookupTemplate(node.templateId);
  if (!tpl) {
    // Orphaned instance — template was deleted but the instance survived.
    // Returning null keeps it out of the scene; the user can pick a new
    // template via right-click or delete the node.
    return null;
  }

  // Default empty washer config so legacy instances (saved before
  // V0.2.22.47) load without the washers field defined.
  const washers = node.washers || { count: 0, spring: false };
  const sig = _buildKey(tpl, washers);
  const existing = node.object3d;
  if (existing && existing.userData?.hwBuildKey === sig) {
    materials?.registerMesh?.(node.id, existing);
    return existing;
  }

  // Stale or missing — rebuild.
  if (existing) {
    if (existing.parent) existing.parent.remove(existing);
    existing.geometry?.dispose?.();
    existing.material?.dispose?.();
    node.object3d = null;
  }

  const mesh = _generateForTemplate(tpl, washers);
  if (!mesh) return null;
  mesh.name = node.name || tpl.name || 'Hardware';
  // The mesh is the registration point for selection / picking / materials.
  // Same userData fields a regular mesh node carries so existing systems
  // (raycaster, color presets, gizmo) treat it uniformly.
  mesh.userData.meshNodeId         = node.id;
  mesh.userData.nodeId             = node.id;
  mesh.userData.hardwareInstanceId = node.id;
  mesh.userData.hwBuildKey         = sig;
  node.object3d = mesh;

  // Register with materials so color presets apply and visibility
  // transitions see this node.
  materials?.registerMesh?.(node.id, mesh);
  return mesh;
}

/**
 * Build or reuse the THREE.Mesh for a hardware NUT node (V0.2.22.78). The
 * nut's geometry is derived from its bolt template's diameter, so editing
 * the bolt re-keys and rebuilds the nut. Returns null if the bolt template
 * is missing. Mirrors ensureHardwareInstanceObject3D.
 */
export function ensureHardwareNutObject3D(node) {
  if (!node || node.type !== 'hardwareNut') return null;
  const tpl = _lookupTemplate(node.boltTemplateId);
  if (!tpl) return null;
  const D   = Number(tpl.params?.diameter) || 4;
  const sig = `nut|${D}`;

  const existing = node.object3d;
  if (existing && existing.userData?.hwBuildKey === sig) {
    materials?.registerMesh?.(node.id, existing);
    return existing;
  }
  if (existing) {
    if (existing.parent) existing.parent.remove(existing);
    existing.geometry?.dispose?.();
    existing.material?.dispose?.();
    node.object3d = null;
  }

  let mesh;
  try { mesh = generateNutMesh({ diameter: D }); }
  catch (e) { console.warn('[hardware] nut build failed:', e?.message); return null; }
  if (!mesh) return null;
  mesh.name = node.name || 'Nut';
  mesh.userData.meshNodeId         = node.id;
  mesh.userData.nodeId             = node.id;
  mesh.userData.hardwareInstanceId = node.id;
  mesh.userData.hwBuildKey         = sig;
  node.object3d = mesh;
  materials?.registerMesh?.(node.id, mesh);
  return mesh;
}

/**
 * Walk the tree and force-rebuild every instance of a given template.
 * Call after the user edits the template (changes diameter, length,
 * head type, drive style, etc).
 */
export function rebuildHardwareInstancesOfTemplate(root, object3dById, templateId) {
  if (!root || !templateId) return;

  // Pre-index parents so we can reparent freshly-built meshes even when
  // the previous one was already detached (e.g. template was just
  // edited mid-rebuild).
  const parentById = new Map();
  (function walk(node, parentId) {
    if (parentId !== null) parentById.set(node.id, parentId);
    for (const c of (node.children || [])) walk(c, node.id);
  })(root, null);

  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'hardwareInstance' && n.templateId === templateId) {
      const oldMesh = n.object3d;
      let parent = oldMesh?.parent ?? null;
      if (!parent) {
        const pid = parentById.get(n.id);
        if (pid && object3dById) parent = object3dById.get(pid) ?? null;
      }
      if (oldMesh) {
        if (oldMesh.parent) oldMesh.parent.remove(oldMesh);
        oldMesh.geometry?.dispose?.();
        oldMesh.material?.dispose?.();
        n.object3d = null;
      }
      const newMesh = ensureHardwareInstanceObject3D(n);
      if (newMesh) {
        if (parent) parent.add(newMesh);
        if (object3dById) object3dById.set(n.id, newMesh);
        // Re-apply the instance's pose onto the fresh mesh — otherwise
        // the rebuild snaps it to parent-local origin until the next
        // applyAllTransformsToScene pass.
        applyNodeTransformToObject3D(n, newMesh, true);
      }
    }
    if (n.children) for (const c of n.children) stack.push(c);
  }
}

/**
 * Dispose the geometry/material of a hardware instance's mesh and
 * detach it from its Three.js parent. Used on tree-node deletion.
 */
export function disposeHardwareInstance(node) {
  if (!node) return;
  const mesh = node.object3d;
  if (!mesh) return;
  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.geometry?.dispose?.();
  mesh.material?.dispose?.();
  node.object3d = null;
}
