/**
 * 🌍 SBS — Environment import/export (V0.3.2.187)
 * ================================================
 *
 * "Environment" = the project-level LOOK of the scene, everything the
 * Environment tab edits:
 *
 *   backgroundColor      solid background
 *   backgroundGradient   2-colour gradient { enabled, color1, color2, angleDeg }
 *   render               per-project render store — ao / ssr / production
 *                        (Production Render, Ambient Occlusion, Contact
 *                        reflections + lighting rig / HDRI / grade)
 *
 * A .sbsenv file is plain JSON of exactly that. A whole .sbsproj is ALSO a
 * valid source — its settings section carries the same fields — so the user
 * can grab another project's environment directly (same pattern as the
 * header-setup grab, V0.3.2.184).
 *
 * This module is PURE (state read only, no writes): applying is done by the
 * Environment tab through actions.commitStateChange so the replacement is
 * one undoable entry.
 */

import state from '../core/state.js';

/** The state keys that make up the environment (also the undo snapshot set). */
export const ENV_STATE_KEYS = ['backgroundColor', 'backgroundGradient', 'render'];

const BG_DEFAULT   = '#0f172a';
const GRAD_DEFAULT = { enabled: false, color1: '#0f172a', color2: '#1e293b', angleDeg: 180 };

function _grad(g) {
  return {
    enabled:  !!g?.enabled,
    color1:   g?.color1 || GRAD_DEFAULT.color1,
    color2:   g?.color2 || GRAD_DEFAULT.color2,
    angleDeg: Number.isFinite(g?.angleDeg) ? g.angleDeg : GRAD_DEFAULT.angleDeg,
  };
}

/** Current project environment → .sbsenv payload. */
export function exportEnvironment() {
  return {
    _sbsenv: { version: 1, saved: new Date().toISOString() },
    backgroundColor:    state.get('backgroundColor') || BG_DEFAULT,
    backgroundGradient: _grad(state.get('backgroundGradient')),
    render:             JSON.parse(JSON.stringify(state.get('render') || {})),
  };
}

/** A parsed .sbsproj → the same payload (its settings section carries the fields). */
export function environmentFromProject(project) {
  const s = project?.settings || {};
  return {
    _sbsenv: { version: 1, fromProject: true },
    backgroundColor:    s.backgroundColor || BG_DEFAULT,
    backgroundGradient: _grad(s.backgroundGradient),
    render:             JSON.parse(JSON.stringify(s.render || {})),
  };
}

/**
 * Coerce an untrusted payload into the applyable shape, or null when it
 * carries nothing recognisable (wrong file / not an environment).
 */
export function normalizeEnvPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const hasAny = payload.backgroundColor || payload.backgroundGradient || payload.render || payload._sbsenv;
  if (!hasAny) return null;
  return {
    backgroundColor:    typeof payload.backgroundColor === 'string' ? payload.backgroundColor : BG_DEFAULT,
    backgroundGradient: _grad(payload.backgroundGradient),
    render:             (payload.render && typeof payload.render === 'object')
                          ? JSON.parse(JSON.stringify(payload.render)) : {},
  };
}
