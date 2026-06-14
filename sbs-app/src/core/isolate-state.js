/**
 * SBS — Isolate overlay state
 * ===========================
 * A NON-DESTRUCTIVE, global visibility mask layered ON TOP of every step's own
 * visibility. While engaged:
 *   - only the keep-set (selected ids + their ancestors + descendants) renders;
 *   - everything else is forced hidden, on EVERY step, until un-isolate;
 *   - per-step `localVisible` / snapshots are NEVER touched, so un-isolate is
 *     simply "drop the mask + re-stage" — there is nothing to restore.
 *
 * The mask overrides ONLY visibility. Transforms, colours and camera still flow
 * from each step's own snapshot, so isolated objects keep moving / recolouring
 * as you step through. Because the visible SET is constant across steps while
 * isolated, step-transition show/hide fades naturally collapse to no-ops.
 *
 * Two visibility-application paths consult this module (they MUST agree):
 *   - core/transforms.js    applyAllVisibility
 *   - systems/steps.js      applyAllVisibilityToScene
 *
 * Leaf module — imports nothing — so both `core` and `systems` can read it with
 * no circular-dependency risk.
 */

let _keepSet   = null;   // Set<nodeId> | null   (null ⇒ isolate OFF)
let _suspended = false;  // export temporarily ignores the mask (renders real steps)

/** Engage the mask with the given keep-set (selected + ancestors + descendants). */
export function setIsolateKeepSet(keepSet) { _keepSet = keepSet; }

/** Drop the mask entirely (also clears any suspension). */
export function clearIsolate() { _keepSet = null; _suspended = false; }

/** The current keep-set, or null when isolate is off. */
export function getIsolateKeepSet() { return _keepSet; }

/**
 * TRUE when the mask is engaged AND not suspended — i.e. visibility code should
 * currently render the isolated view. This is the predicate the two
 * applyAllVisibility paths check on every node.
 */
export function isIsolateActive() { return !!_keepSet && !_suspended; }

/**
 * TRUE when the user has an isolate engaged, regardless of suspension. UI gating
 * (grey-out hide/show, Isolate ↔ Un-isolate toggle) uses THIS so the menu stays
 * stable even while an export has temporarily suspended the mask.
 */
export function isIsolateEngaged() { return !!_keepSet; }

/** Temporarily ignore the mask so an export renders the true per-step scene. */
export function suspendIsolate() { _suspended = true; }

/** Re-enable the mask after a suspend. */
export function resumeIsolate() { _suspended = false; }
