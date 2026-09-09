/**
 * 🎹 SBS — central keymap (V0.3.2.168)
 * =====================================
 *
 * Single source of truth for togglable keyboard shortcuts. Two consumers:
 *
 *   1. The keydown handlers (main.js) ask `matches(action, e)` instead of
 *      hard-coding a key, so a shortcut lives in exactly one place.
 *   2. Any UI that ADVERTISES a shortcut (the "(W)" on the Work-camera
 *      button, the "(O)" on Edit overlay) renders it via `keyLabel(action)`
 *      — so the moment a binding changes, every label follows for free.
 *
 * Keys are physical KeyboardEvent.code values (KeyW, Space…), NOT characters
 * — layout-independent, the same fix undo got for Hebrew keyboards.
 *
 * CUSTOM KEYBINDINGS (planned): a future Settings ▸ Keybindings panel calls
 * `setKeyOverrides({ workCamera: 'KeyC', … })` with values persisted in
 * user-settings, and everything above re-resolves. The override plumbing is
 * live now precisely so that panel only has to write here — nothing else in
 * the app will need touching.
 */

const DEFAULTS = {
  workCamera:  'KeyW',    // 🎥 inspection mode — steps play without moving the camera
  overlayEdit: 'KeyO',    // ✏ toggle overlay editing
  globalMode:  'Space',   // 🌐 transform edits carry across steps
  gizmoSpace:  'KeyL',    // ⤧ gizmo Local ↔ World
};

let _overrides = {};

/** The active code for an action (override first, then default). */
export function keyFor(action) {
  return _overrides[action] || DEFAULTS[action] || null;
}

/** Does this keydown event match the action's binding? (code-based) */
export function matches(action, e) {
  const c = keyFor(action);
  return !!c && e.code === c;
}

/** Human label for a raw code: 'KeyW' → 'W', 'Digit3' → '3', 'Space' → 'Space'. */
export function labelForCode(c) {
  c = c || '';
  if (c.startsWith('Key'))   return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  return c;
}

/** Human label for an action's current binding. */
export function keyLabel(action) {
  return labelForCode(keyFor(action));
}

/** The factory default for an action (the Keybindings panel's "Reset" target). */
export function defaultKeyFor(action) {
  return DEFAULTS[action] || null;
}

/** Replace all overrides (the future Keybindings panel's write entry point). */
export function setKeyOverrides(map) {
  _overrides = { ...(map || {}) };
}

/** Full effective table — for a future Keybindings panel to render. */
export function getBindings() {
  return { ...DEFAULTS, ..._overrides };
}
