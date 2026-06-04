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
import { generateScrewMesh }            from './hardware-generator.js';

// ─── Template lookup ────────────────────────────────────────────────────────

function _lookupTemplate(templateId) {
  if (!templateId) return null;
  const tpls = state.get('hardwareTemplates') || [];
  return tpls.find(t => t.id === templateId) || null;
}

/**
 * Cache key for a hardware mesh. Rebuilds happen only when the key
 * changes between the cached one (stored on object3d.userData) and the
 * key derived from the live template.
 */
function _buildKey(tpl) {
  if (!tpl) return '';
  const p = tpl.params || {};
  return `${tpl.kind}|${p.diameter}|${p.length}|${p.headType}|${p.driveStyle}`;
}

// ─── Geometry build per kind ────────────────────────────────────────────────

function _generateForTemplate(tpl) {
  if (!tpl) return null;
  switch (tpl.kind) {
    case 'screw':
      return generateScrewMesh(tpl.params || {});
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

  const sig = _buildKey(tpl);
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

  const mesh = _generateForTemplate(tpl);
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
