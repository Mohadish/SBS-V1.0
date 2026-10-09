/**
 * ↻ Repeat the last right-click menu action (V0.3.6.8 — his ask: "press R and it does the same thing to
 * what I'm on now").
 *
 * WHAT IS RECORDED: the menu entry the user picked, by its IDENTITY — the labels down the menu
 * (parent row ▸ entry), never the mouse path or the row position. Every context menu in the app goes
 * through showContextMenu, which wraps each entry's action with recordMenuAction().
 *
 * HOW IT IS REPLAYED: the menu that a right-click WOULD open where the pointer stands now is built
 * again — a synthetic `contextmenu` event at the pointer, with showContextMenu in capture mode (it
 * hands the items back instead of drawing them) — and the entry whose labels match is run. The same
 * function therefore lands on the new target even when it sits elsewhere in that target's menu; a
 * target whose menu has no such entry is left alone and the status bar says so.
 *
 * Matching is tolerant of what varies between targets: a leading ✓ / ✗ / ☑ tick, a `[hotkey]` hint,
 * counts ("Unarchive 3 items" ≈ "Unarchive") and plurals. A quoted name (a pinned position, a mask, a
 * cell) is part of the identity — "Pin to position ▸ 📌 Photo" repeats with THAT position.
 */
import { setStatus } from './status.js';

let _last = null;            // { path: [label, …], at }
let _capture = null;         // while non-null, showContextMenu pushes its items here instead of drawing
let _pointer = { x: 0, y: 0, at: 0 };

/** Record the entry just picked (called by the context menu's wrapped actions). */
export function recordMenuAction(path) {
  const p = (path || []).map(s => String(s ?? '')).filter(Boolean);
  if (!p.length) return;
  _last = { path: p, at: Date.now() };
}
export function lastMenuAction() { return _last ? { ...(_last), path: [..._last.path] } : null; }
export function clearLastMenuAction() { _last = null; }

/** Run `fn` with the context menu in capture mode: whatever it would show comes back as items. */
export function captureMenu(fn) {
  const prev = _capture;
  _capture = [];
  try { fn(); return _capture; } finally { _capture = prev; }
}
/** showContextMenu asks: am I capturing? (then it pushes and returns true) */
export function captureIfActive(items) {
  if (!_capture) return false;
  _capture.push(...(items || []));
  return true;
}

// ── label identity ───────────────────────────────────────────────────────────
/** A label without what varies between targets: ticks, hotkey hints, spacing. */
export function normalizeLabel(label) {
  return String(label ?? '')
    .replace(/^\s*[✓✗☑☐•◦]\s*/u, '')          // a state tick in front
    .replace(/\s*\[[^\]]*\]\s*$/u, '')          // "[Enter]" / "[Esc]" hints at the end
    .replace(/\s*\(([A-Z][a-z]+\+)*[A-Z0-9]+\)\s*$/u, '')   // "(Ctrl+Z)"-style hints at the end
    .replace(/\s+/g, ' ')
    .trim();
}
/** Looser still: numbers and plurals out ("Unarchive 3 items" → "Unarchive # item"). */
export function looseLabel(label) {
  return normalizeLabel(label)
    .replace(/\d+([.,]\d+)?/g, '#')
    .replace(/\s*#\s*(items?|steps?|nodes?|pictures?|rows?|points?|cells?)\b/g, '')   // "Unarchive 3 items" → "Unarchive"
    .replace(/\bitems\b/g, 'item').replace(/\bsteps\b/g, 'step')
    .replace(/\s+/g, ' ').trim();
}

/** Every runnable entry of a menu tree, flattened: { path:[labels], item }. */
export function flattenMenu(items, parent = []) {
  const out = [];
  for (const it of items || []) {
    if (!it || it.separator || !it.label || it.label === '─') continue;
    const path = [...parent, it.label];
    if (typeof it.action === 'function') out.push({ path, item: it });
    if (Array.isArray(it.submenu)) out.push(...flattenMenu(it.submenu, path));
  }
  return out;
}

/** The entry of `items` that is the same action as `path`, or null. Exact labels first, then the looser forms. */
export function findMenuItem(items, path) {
  const flat = flattenMenu(items);
  if (!flat.length || !path?.length) return null;
  const want = path.map(normalizeLabel), wantLast = want[want.length - 1], wantLoose = looseLabel(path[path.length - 1]);
  const samePath = (e, f) => e.path.length === want.length && e.path.every((l, i) => f(l) === (f === normalizeLabel ? want[i] : looseLabel(path[i])));
  return flat.find(e => samePath(e, normalizeLabel))
      || flat.find(e => normalizeLabel(e.path[e.path.length - 1]) === wantLast)
      || flat.find(e => samePath(e, looseLabel))
      || flat.find(e => looseLabel(e.path[e.path.length - 1]) === wantLoose)
      || null;
}

// ── replay ───────────────────────────────────────────────────────────────────
function _trackPointer(e) { _pointer = { x: e.clientX, y: e.clientY, at: Date.now() }; }
let _installed = false;
export function installMenuRepeat() {
  if (_installed) return;
  _installed = true;
  window.addEventListener('pointermove', _trackPointer, true);
  window.addEventListener('pointerdown', _trackPointer, true);
}

/** The menu a right-click would open under the pointer, as items — without drawing it. */
function _menuUnderPointer() {
  const { x, y } = _pointer;
  const target = document.elementFromPoint(x, y);
  if (!target) return { items: [], target: null };
  const items = captureMenu(() => {
    try {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 2, buttons: 2, view: window }));
    } catch (err) { console.warn('[menu-repeat] could not build the menu here:', err); }
  });
  return { items, target };
}

/**
 * ↻ Do the last menu action again on what is under the pointer. Returns true when something ran
 * (or was deliberately refused with a message), false when there is nothing to repeat.
 */
export function repeatLastMenuAction() {
  if (!_last) { setStatus('↻ Nothing to repeat yet — pick something from a right-click menu first.', 'info', 3500); return false; }
  const name = _last.path.map(normalizeLabel).join(' ▸ ');
  const { items } = _menuUnderPointer();
  if (!items.length) { setStatus(`↻ No right-click menu where the pointer is — put it on the item and press the key again.`, 'warn', 4000); return true; }
  const hit = findMenuItem(items, _last.path);
  if (!hit) { setStatus(`↻ "${name}" is not offered here.`, 'warn', 4000); return true; }
  if (hit.item.disabled) { setStatus(`↻ "${name}" is greyed out here.`, 'warn', 4000); return true; }
  try {
    hit.item.action({ ctrl: false, meta: false, shift: false, alt: false });
    setStatus(`↻ ${hit.path.map(normalizeLabel).join(' ▸ ')}`, 'success', 3000);
  } catch (err) {
    console.error('[menu-repeat] the action failed:', err);
    setStatus(`↻ "${name}" failed here — see the console.`, 'danger', 5000);
  }
  return true;
}
