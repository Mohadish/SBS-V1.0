/**
 * SBS Step Browser — Gizmo numeric input + live drag readout.
 * ============================================================
 *
 * Two responsibilities, both attached to the gizmo's drag lifecycle:
 *
 *   1) LIVE READOUT (always on while dragging)
 *      Mirrors the active drag's amount(s) in #status-bar.
 *      9 cases prefab'd:
 *        translate X / Y / Z         → "X: +12.50 mm"
 *        translate XY / YZ / XZ      → "X: +12.50  Y: −3.20 mm"
 *        rotate    X / Y / Z         → "Rot Y: +45.20°"
 *
 *   2) NUMERIC INPUT (single-axis translate + rotate only — planes off)
 *      While the user holds an axis handle, typing digits / `.` / `-`
 *      / math operators / letters enters numeric mode:
 *        - Mouse-driven drag is suspended (gizmo.setNumericLock(true))
 *        - Each keystroke applies the current expression as an ABSOLUTE
 *          axis value from the pre-drag origin (live preview).
 *        - Backspace edits; deleting the last char releases the lock
 *          and resumes mouse-driven drag.
 *        - Enter → commit (drag's commitTransformEdit pushes one undo
 *          entry). Mouse release while typing is IGNORED — only Enter
 *          or Esc end the drag (lets the user type two-handed).
 *        - Esc → revert to pre-drag transform AND release the gizmo.
 *      Every input is parsed as a math expression (no prefix needed) —
 *      `12.5`, `-3`, `sin(pi/4)*100`, `180/2`, `2+3*4` all work. Eval
 *      runs in the Math namespace via a whitelisted Function call so
 *      no DOM / global access is reachable.
 *      Esc also reverts during pure mouse-drive drags (no typing).
 */

import { setStickyStatus, clearStickyStatus } from './status.js';

let _gizmo  = null;
let _input  = '';      // typed string ('' = no numeric mode)
let _frozen = false;   // true while numeric input has hijacked the drag
let _active = null;    // { type, axis, node } — captured at drag start

const ALLOWED_RX = /^[\d\s+\-*/().,a-zA-Z]+$/;

// ── Expression eval ─────────────────────────────────────────────────────────

function _safeEval(src) {
  if (!ALLOWED_RX.test(src)) return NaN;
  try {
    // `with` is BANNED in strict mode — function bodies created via
    // Function() default to non-strict, which is what we want here.
    // `with(Math)` makes `sin`, `cos`, `sqrt`, `PI`, `E`, etc. resolve
    // to Math.* without exposing the global scope. We additionally
    // bind lowercase `pi` and `e` as params for natural input.
    // Whitelist regex above prevents any DOM / global access.
    return Function('pi', 'e', 'with(Math){return ' + src + '}')(Math.PI, Math.E);
  } catch {
    return NaN;
  }
}

/**
 * Parse a value string. Always tries math eval first — plain numbers
 * (`12.5`, `-3`) work because `Function('return 12.5')()` returns 12.5.
 * Math expressions (`sin(pi/4)*100`, `180/2`, `2+3*4`) work too.
 * Returns NaN for invalid / incomplete input. Exported so the gizmo
 * right-click panel can use the same parser. */
export function parseExpression(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  if (!s) return NaN;
  if (s === '-' || s === '.' || s === '-.' || s === '+') return NaN;
  const n = _safeEval(s);
  return Number.isFinite(n) ? n : NaN;
}

function _parseInput(s) { return parseExpression(s); }

// ── Readout strings ─────────────────────────────────────────────────────────

const SIGN = (n) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2);

function _readout(payload, suffix) {
  if (!payload) return '';
  const { type, axis, value } = payload;
  if (type === 'plane' && value && typeof value === 'object') {
    return `${value.axisA.toUpperCase()}: ${SIGN(value.a)}  ${value.axisB.toUpperCase()}: ${SIGN(value.b)} mm${suffix || ''}`;
  }
  if (type === 'translate') {
    return `${axis.toUpperCase()}: ${SIGN(value)} mm${suffix || ''}`;
  }
  if (type === 'rotate') {
    return `Rot ${axis.toUpperCase()}: ${SIGN(value)}°${suffix || ''}`;
  }
  return '';
}

// ── Numeric mode logic ──────────────────────────────────────────────────────

function _enterNumeric() {
  if (_frozen) return;
  if (!_active) return;
  if (_active.type === 'plane') return;   // typing on planes is disabled
  _frozen = true;
  _gizmo.setNumericLock(true);
}

function _exitNumericReleaseLock() {
  _frozen = false;
  _input  = '';
  _gizmo.setNumericLock(false);
}

function _applyTyped() {
  if (!_active || _active.type === 'plane') return;
  const n = _parseInput(_input);
  if (Number.isFinite(n)) _gizmo.applyNumericAmount(n);
  // Live readout while typing — show what they're typing PLUS the
  // resolved numeric value (or "?" if the expression is incomplete).
  const valTxt = Number.isFinite(n) ? SIGN(n) : '?';
  const unit   = _active.type === 'rotate' ? '°' : ' mm';
  const label  = _active.type === 'rotate'
    ? `Rot ${_active.axis.toUpperCase()}`
    : _active.axis.toUpperCase();
  setStickyStatus(`${label}: typing «${_input}» → ${valTxt}${unit}`);
}

function _onKey(e) {
  if (!_active) return;
  if (_active.type === 'plane') return;
  // Don't intercept keystrokes when focus is in a real text input.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  // Don't intercept modifier-key combos (Ctrl+Z, Ctrl+S, Alt+Tab, …) —
  // those are app/system shortcuts, never gizmo input.
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const k = e.key;

  // Enter — commit. Triggers the gizmo's regular pointerup commit flow.
  // Must release numericLock BEFORE onPointerUp, otherwise our own
  // "ignore mouse release while numeric-locked" guard would block it.
  if (k === 'Enter') {
    if (!_frozen) return;            // not in numeric mode → ignore
    e.preventDefault();
    _gizmo.setNumericLock(false);
    _gizmo.onPointerUp();
    return;
  }

  // Esc — revert + release the drag entirely. Works in BOTH modes:
  //   - Numeric typing → revert any typed value, exit numeric, end drag
  //   - Mouse-only drag → revert mouse-driven motion, end drag
  if (k === 'Escape') {
    if (!_active) return;            // no drag at all
    e.preventDefault();
    _gizmo.revertToDragStart();
    _exitNumericReleaseLock();
    _gizmo.onPointerUp();            // closes drag — transform == start ⇒ no undo entry
    return;
  }

  // Backspace — edit current input, exit numeric if emptied.
  if (k === 'Backspace') {
    if (!_input) return;
    e.preventDefault();
    _input = _input.slice(0, -1);
    if (!_input) {
      _exitNumericReleaseLock();
      // No revert — let the user keep dragging by mouse from current pose.
      // To match user spec ("revert to mouse listener active"), the drag
      // continues from wherever it currently is; the next mouse move
      // will compute amount from start as usual.
      return;
    }
    _applyTyped();
    return;
  }

  // Single-char input. Accept digits, `.`, `-`, math operators, and
  // letters (so `sin(pi/4)*100` works). Ignore everything else.
  if (k.length !== 1) return;
  if (!/[\d.\-+*/()a-zA-Z]/.test(k)) return;

  e.preventDefault();
  if (!_frozen) _enterNumeric();
  _input += k;
  _applyTyped();
}

// ── Drag-event bridge ───────────────────────────────────────────────────────

function _onDragEvent(kind, payload) {
  if (kind === 'start') {
    _active = { type: payload.type, axis: payload.axis, node: payload.node };
    _input  = '';
    _frozen = false;
    setStickyStatus(_readout({ type: payload.type, axis: payload.axis, value: 0 }) || 'Drag…');
    return;
  }
  if (kind === 'move') {
    if (_frozen) return;     // typing owns the readout while locked
    setStickyStatus(_readout(payload));
    return;
  }
  if (kind === 'end') {
    _active = null;
    _input  = '';
    _frozen = false;
    clearStickyStatus();
    return;
  }
}

// While numeric mode (or click-armed mode) keeps a drag alive past
// mouse release, a click on anything OTHER than another gizmo handle
// must commit the pending value. The gizmo's own onPointerDown already
// handles the "click another handle" case (commits prior drag, starts
// new). This handler covers everything else: clicking the canvas to
// deselect, clicking a sidebar item, etc. Capture-phase + delay via
// raycast check would be brittle — instead we just skip if the click
// hits the gizmo (it'll route through onPointerDown's own finaliser).
function _onWindowPointerDown(e) {
  if (!_active) return;
  if (!_gizmo._dragging) return;
  // Heuristic: if the click is on the 3D viewport canvas, the gizmo's
  // own pointerdown will run via main.js — don't pre-empt it. For
  // anything else (sidebar, toolbar, status bar, …) commit now.
  const t = e.target;
  const onCanvas = t && (t.tagName === 'CANVAS' || t.id === 'viewer' || (t.closest && t.closest('#viewport-surface')));
  if (onCanvas) return;
  _gizmo._numericLock = false;
  _gizmo._dragMoved = true;
  _gizmo.onPointerUp();
}

// ── Public init ─────────────────────────────────────────────────────────────

export function initGizmoNumeric(gizmo) {
  if (!gizmo) return;
  _gizmo = gizmo;
  gizmo.setDragListener(_onDragEvent);
  // Capture-phase keydown so we see keys before form widgets and other
  // listeners. Filter inside _onKey so we don't steal typing in inputs.
  window.addEventListener('keydown', _onKey, { capture: true });
  window.addEventListener('pointerdown', _onWindowPointerDown, { capture: true });
}
