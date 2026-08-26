/**
 * SBS Step Browser — Project Save / Load
 * ========================================
 * Serialises and deserialises the full application state to/from a
 * .sbsproj file (JSON).
 *
 * FILE I/O STRATEGY (three paths in priority order):
 *   1. Electron  — window.sbsNative.saveFile / openFile (IPC bridge)
 *   2. Web FSA   — window.showSaveFilePicker / showOpenFilePicker
 *   3. Fallback  — <a download> for save, <input type=file> for open
 *
 * LOAD FLOW:
 *   loadProject(file)           → parse + migrate JSON, apply state
 *   buildIdRemapFromSpec(...)   → match freshly-loaded nodes to saved IDs
 *   applyIdRemap(...)           → stamp saved IDs onto live nodes
 *   applySpecFieldsToNodes(...) → restore names, transforms, vis from spec
 *
 * The caller (main.js) owns the model-loading loop and calls these
 * helpers once per loaded model so step snapshots reference the right IDs.
 */

import { state }                      from '../core/state.js';
import {
  createEmptyProject,
  APP_VERSION,
  migrateSection,
  generateId,
  createCameraBinding,
  createAnimationPreset,
  DEFAULT_ANIMATION_PRESET_STRING,
}                                     from '../core/schema.js';
import { materials }                  from '../systems/materials.js';
import { steps, seedPrimitiveDefsFromTree, notePrimitiveDef } from '../systems/steps.js';
import { internAllStepOverlays, resetInternPool } from '../core/intern.js';   // 🧵 V0.3.2.77 image-string dedupe
import * as narrationCache           from '../systems/narration-cache.js';
import { flattenCablesToCascade, ensureSocketBaselines } from '../systems/cables.js';   // V0.3.0.151 cascade migration; V0.3.0.167 socket State-0 backfill
import { rebuildPrimitive }          from '../systems/primitives.js';   // V0.3.2.6 param-sync on load
import { cloneShareStrings }         from '../core/clone.js';            // V0.3.2.17 string-limit-proof serialize
import { clearIsolate }              from '../core/isolate-state.js';
import { buildNodeMap }              from '../core/nodes.js';            // V0.3.2.62 tree reconcile

/**
 * H1 migration: append `cable(500)` / `overlay(500)` slots to legacy
 * animation preset strings so projects saved before these phases
 * existed pick them up automatically. Idempotent — re-running on a
 * preset that already mentions a slot leaves it untouched.
 */
// Visual editor invariant (see ui/animation-tab.js): every preset must
// expose ALL action capsules — the user can only REDISTRIBUTE them
// across phases, never add/remove. When the engine grows a new channel,
// this migration back-fills it into the FIRST phase of every existing
// preset so the visual editor never has to invent capsules out of thin
// air. Additive only — original phasing is preserved.
//
// `overlay` / `overlays` are treated as ONE conceptual channel for the
// purpose of "is this capsule present" — either string token counts.
// The visual editor exposes a per-capsule mode toggle.
const _CHANNELS_REQUIRED = [
  'camera', 'visibility', 'obj', 'color',
  'cable', 'narration', 'notes', 'shape',
  'insert',   // V0.2.22.52.1 — hardware explode→assemble; back-filled so
              // the 🔩 chip is always present + movable in the Anim editor.
              // Inert (no dwell, no effect) on steps with no flagged actor.
];
function _migrateAnimationPresets(items) {
  // Bootstrap: new project (or loaded project with empty presets array)
  // gets a "Default" preset auto-created, set as the project default.
  // Mirrors the way every project has at least one chapter / one step.
  if (!Array.isArray(items) || items.length === 0) {
    return [createAnimationPreset({
      name:      'Default',
      animation: DEFAULT_ANIMATION_PRESET_STRING,
      isDefault: true,
    })];
  }
  return items.map(p => {
    if (!p?.animation || typeof p.animation !== 'string') return p;
    let str = p.animation.trim();
    const hasOverlayCapsule = /\boverlay(s)?\b/.test(str);

    // Find missing required channels.
    const missing = _CHANNELS_REQUIRED.filter(ch => {
      const re = new RegExp(`\\b${ch}\\b`);
      return !re.test(str);
    });
    if (!hasOverlayCapsule) missing.push('overlays');   // default to sustained variant

    if (missing.length === 0) return p;

    // Inject the missing channels into the FIRST phase. Find the first
    // type-group in the string (everything up to the first `(durMs)`)
    // and append the missing tokens to it. The duration is preserved.
    // e.g. "camera(AL1), obj(500)" + missing [color, visibility] →
    //      "camera+color+visibility(AL1), obj(500)"
    const m = str.match(/^([a-zA-Z+]+)\(/);
    if (m) {
      const firstTypes = m[1];
      const newTypes   = firstTypes + '+' + missing.join('+');
      str = str.replace(/^[a-zA-Z+]+\(/, newTypes + '(');
    } else {
      // No parseable phase — fall back to wholesale replacement with the
      // canonical default. Caller's data was broken; this restores it.
      // (Rare: would only hit if someone hand-edited the file to garbage.)
      str = 'camera+visibility+obj+color+overlays+cable+narration+notes+shape(AL1)';
    }
    return { ...p, animation: str };
  });
}

/**
 * Selection-group migration: legacy projects (and the original v0.266
 * format) stored groups as `{name, ids[]}`. We add a stable `id` and a
 * `color` swatch so groups can be referenced by id in undo entries and
 * cross-step ops, and so the UI has a per-group accent. Idempotent.
 */
const SEL_GROUP_PALETTE = [
  '#ef4444', '#22c55e', '#3b82f6', '#eab308',
  '#a855f7', '#14b8a6', '#f97316', '#ec4899',
];
function _migrateSelectionGroups(items) {
  if (!Array.isArray(items)) return [];
  return items.map((g, i) => ({
    id:    g?.id    || `selgrp_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
    name:  g?.name  || `Group ${i + 1}`,
    ids:   Array.isArray(g?.ids) ? g.ids.filter(s => typeof s === 'string') : [],
    color: typeof g?.color === 'string' ? g.color : SEL_GROUP_PALETTE[i % SEL_GROUP_PALETTE.length],
  }));
}


// ═══════════════════════════════════════════════════════════════════════════
//  SERIALISE (state → JSON)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recursively clone a tree node, stripping the non-serialisable
 * `object3d` runtime reference (and any other transient fields).
 */
function stripNode(node) {
  if (!node) return null;
  // _paramsUserEdited is SESSION-scoped (V0.3.2.67 re-assert shield for
  // edits made between load and the repair timers) — persisting it would
  // permanently exempt the node from every future load repair.
  // eslint-disable-next-line no-unused-vars
  const { object3d, _transient, _paramsUserEdited, ...rest } = node;
  return {
    ...rest,
    children: (rest.children || []).map(stripNode),
  };
}

/**
 * Build the full project JSON from current app state.
 * Returns a plain object ready to be JSON.stringify'd.
 *
 * @returns {object}  complete project in createEmptyProject() shape
 */
export function serialize() {
  const project = createEmptyProject();

  // ── _sbs metadata ────────────────────────────────────────────────────────
  project._sbs.app_version = APP_VERSION;
  project._sbs.saved       = new Date().toISOString();

  // ── Assets ───────────────────────────────────────────────────────────────
  project.assets.items = (state.get('assets') || []).map(a => ({ ...a }));

  // ── Tree (strip object3d) ─────────────────────────────────────────────────
  const treeData = state.get('treeData');
  project.tree.root = treeData ? stripNode(treeData) : null;

  // ── Steps ────────────────────────────────────────────────────────────────
  project.steps.items = cloneShareStrings((state.get('steps') || []));

  // When narration audio is cached on disk (dataFile present), drop the
  // bulky inline base64 dataUrl from the saved file — the WAV lives in
  // <projectDir>/<audioCacheFolder>/ and is loaded lazily on play / export.
  for (const stp of project.steps.items) {
    if (stp.narration?.dataFile && stp.narration?.dataUrl) {
      delete stp.narration.dataUrl;
    }
  }

  // ── Chapters ─────────────────────────────────────────────────────────────
  project.chapters.items = cloneShareStrings((state.get('chapters') || []));

  // ── Camera views ─────────────────────────────────────────────────────────
  project.cameras.items = cloneShareStrings((state.get('cameraViews') || []));

  // ── Color presets + mesh assignments ─────────────────────────────────────
  project.colors.items       = cloneShareStrings((state.get('colorPresets') || []));
  project.colors.assignments = { ...materials.meshColorAssignments };
  project.colors.defaults    = { ...materials.meshDefaultColors };

  // ── Notes ─────────────────────────────────────────────────────────────────
  project.notes.templates = cloneShareStrings((state.get('noteTemplates') || []));
  project.notes.presets   = { ...(state.get('notePresets') || {}) };

  // ── Selections ────────────────────────────────────────────────────────────
  project.selections.groups       = cloneShareStrings((state.get('selectionGroups') || []));
  project.selections.outlineColor = state.get('selectionOutlineColor') || '#00ffff';

  // ── Animation presets ──────────────────────────────────────────────────────
  project.animationPresets.items = cloneShareStrings((state.get('animationPresets') || []));

  // ── Headers (project-level overlay) ────────────────────────────────────────
  project.headers = project.headers || { schema_version: 1, items: [] };
  project.headers.items   = cloneShareStrings((state.get('headerItems')   || []));
  project.headers.locked  = !!state.get('headersLocked');
  project.headers.hidden  = !!state.get('headersHidden');
  project.headers.default = cloneShareStrings((state.get('headerDefault') || {}));
  project.headers.stepNumberPerChapter = !!state.get('headerStepNumberPerChapter');

  // Text style templates — same shape as header items, lives in its
  // own project section so it can be saved/loaded independently and
  // bundled into the unified preset file alongside header items.
  project.styles = project.styles || { schema_version: 1, items: [] };
  project.styles.items = cloneShareStrings((state.get('styleTemplates') || []));

  // Flat-shape templates — project-level polygon library. Instances live
  // as regular tree nodes (type='flatShape', templateId pointer) and
  // round-trip via stripNode like every other tree node.
  project.shapes = project.shapes || { schema_version: 1, items: [] };
  project.shapes.items  = cloneShareStrings((state.get('shapeTemplates')      || []));
  // V0.1.85: shape-tab groupings. Tab-only, doesn't touch the tree, so
  // it lives alongside templates in the shapes section. Older files
  // without `groups` load as [] via the default below.
  project.shapes.groups = cloneShareStrings((state.get('shapeTemplateGroups') || []));

  // V0.2.22.38 — Hardware templates. Procedural fastener library; each
  // template carries kind ('screw' for now) + params. Instances live as
  // tree nodes (type='hardwareInstance', templateId pointer) and round-
  // trip via stripNode like every other tree node. Older files lacking
  // this section load with hardwareTemplates=[] which is correct: there
  // are no instances to orphan.
  project.hardware = project.hardware || { schema_version: 1, templates: [] };
  project.hardware.templates = cloneShareStrings((state.get('hardwareTemplates') || []));

  // Cables — 3D wires routed between mesh anchors and free points.
  // The cable list is project-global (topology-hoisted); per-step
  // variable overrides ride inside step.snapshot.cables, captured by
  // steps.js. Project-level visual globals (scale + highlight colour)
  // travel here too so they restore in one shot. See systems/cables.js.
  project.cables = project.cables || { schema_version: 2, items: [] };
  project.cables.schema_version = 2;   // V0.3.0.165 — absolute mm sizing (see MIGRATIONS.cable)
  project.cables.items          = cloneShareStrings((state.get('cables') || []));
  project.cables.globalScale    = state.get('cableGlobalScale')    ?? 1.0;
  project.cables.globalRadius   = state.get('cableGlobalRadius')   ?? 1.0;   // V0.3.0.161 (legacy; kept for migration)
  project.cables.defaultDiameter = state.get('cableDefaultDiameter') ?? 2.0; // V0.3.0.165 — default for NEW cables
  project.cables.filletReach    = state.get('cableFilletReach')    ?? 40;    // V0.3.0.161
  project.cables.highlightColor = state.get('cableHighlightColor') ?? '#22d3ee';

  // ── Settings ──────────────────────────────────────────────────────────────
  const cfg = project.settings;
  cfg.backgroundColor      = state.get('backgroundColor')      ?? '#0f172a';
  cfg.backgroundGradient   = JSON.parse(JSON.stringify(
    state.get('backgroundGradient') ?? { enabled: false, color1: '#0f172a', color2: '#1e293b', angleDeg: 180 }
  ));
  cfg.render               = cloneShareStrings((state.get('render') ?? {}));   // V0.3.0.162 — per-project AO + SSR
  cfg.solidOverride        = state.get('solidOverride')        ?? false;
  cfg.gridVisible          = state.get('gridVisible')          ?? false;
  cfg.cameraAnimDurationMs = state.get('cameraAnimDurationMs') ?? 1500;
  cfg.objectAnimDurationMs = state.get('objectAnimDurationMs') ?? 1500;
  cfg.cameraFillLight      = { ...(state.get('cameraFillLight') || {}) };
  cfg.geometryOutline      = { ...(state.get('geometryOutline') || {}) };
  cfg.export               = { ...(state.get('export')         || {}) };
  cfg.audioCacheFolder     = state.get('audioCacheFolder')      ?? null;
  // Interface overlay: the SHARED default pose + library folder were runtime-only
  // and lost on load — so on reload interfaces drifted to their per-step saved
  // pose ("multiple positions") and "reset/at-default" broke. Persist them.
  cfg.interfaceDefaultPose   = state.get('interfaceDefaultPose')   ?? null;
  cfg.interfaceLibraryFolder = state.get('interfaceLibraryFolder') ?? null;
  // V0.2.22.58 — per-project hardware insertion-animation default
  // (null = none → fall back to the system "Nuts" defaults on load).
  cfg.hardwareDefaults     = state.get('hardwareDefaults')      ?? null;

  return project;
}


// ═══════════════════════════════════════════════════════════════════════════
//  FILE-TYPE CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const FILE_TYPES = [
  { description: 'SBS Step Browser Project', accept: { 'application/json': ['.sbsproj', '.json'] } },
];


// ═══════════════════════════════════════════════════════════════════════════
//  PROJECT (DE)COMPRESSION  — runs in the RENDERER
// ═══════════════════════════════════════════════════════════════════════════
//
// .sbsproj is gzipped minified JSON. Compression lives HERE (CompressionStream)
// rather than in the Electron main process on purpose: the renderer hot-reloads
// but the main process only reloads on a full app restart, so a main-process
// handler can silently lag behind. The byte path goes through the long-standing
// fs:writeFile / fs:readFile('buffer') handlers, present in every build.
//
// Backward compatible: old plain-JSON .sbsproj files are detected by the gzip
// magic (1f 8b) on load and decoded as text. CompressionStream is feature-
// detected; without it we save plain UTF-8 (still a valid .sbsproj).

const _hasCompression =
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

function _isGzipBytes(bytes) {
  return !!bytes && bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function _gzipString(str, onProgress = null) {
  const cs = new CompressionStream('gzip');
  const w  = cs.writable.getWriter();
  // Start draining BEFORE writing — with chunked awaited writes, the stream
  // backpressures and would deadlock if nothing consumed the readable side.
  const outP = new Response(cs.readable).arrayBuffer();
  const data = new TextEncoder().encode(str);   // encode once (byte-safe to slice)
  const CHUNK = 8 * 1024 * 1024;                // 8 MB per write → UI can breathe + report progress
  for (let off = 0; off < data.length; off += CHUNK) {
    await w.write(data.subarray(off, Math.min(data.length, off + CHUNK)));
    onProgress?.(Math.min(data.length, off + CHUNK), data.length);
  }
  await w.close();
  return new Uint8Array(await outP);
}

async function _gunzipToString(bytes) {
  const ds = new DecompressionStream('gzip');
  const w  = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}

/** Project JSON string → bytes to write (gzipped if supported, else plain UTF-8). */
async function _encodeProjectBytes(jsonString, onProgress = null) {
  return _hasCompression ? await _gzipString(jsonString, onProgress) : new TextEncoder().encode(jsonString);
}

/**
 * AUTO-BACKUP (V0.3.2.18) — write the full current project to a rolling
 * <name>.autosave.sbsproj next to the real file (openable like any project;
 * NEVER touches the main file or the dirty flag). Born from a renderer crash
 * that cost three hours of unsaved work. Uses the streaming encoder — safe at
 * any project size.
 */
export async function autosaveBackup({ path: pathOverride } = {}) {
  const pp = state.get('projectPath');
  if (!pp || !window.sbsNative?.writeFile) return { skipped: true };
  // Announce it (V0.3.2.36). This used to run silently with onProgress=null,
  // so on a big project the UI just froze mid-action for several seconds with
  // no explanation. Same overlay as a manual save, labelled as a backup.
  const t0 = Date.now();
  state.emit('save:progress', { stage: 'serialize', autosave: true });
  steps.flushSync();
  const project = serialize();
  const { bytes, rawBytes } = await _encodeProjectStream(project,
    (done, total) => state.emit('save:progress', { stage: 'compress', done, total, unit: 'steps', autosave: true }));
  // Fallback base also strips any .autosaveN suffix (V0.3.2.56) so an
  // autosave-of-an-autosave can never stack when no path override is passed.
  const path = pathOverride
    || (pp.replace(/\.sbsproj$/i, '').replace(/(\.autosave\d*)+$/i, '') + '.autosave.sbsproj');
  state.emit('save:progress', { stage: 'write', bytes: bytes.length, autosave: true });
  const r = await window.sbsNative.writeFile(path, bytes, null);
  state.emit('save:progress', r?.ok
    ? { stage: 'done', bytes: bytes.length, rawBytes, ms: Date.now() - t0, autosave: true }
    : { stage: 'error', message: r?.error || 'write failed', autosave: true });
  // 🧵 V0.3.2.77 — autosave read every overlay rope (flattening them); put
  // the sharing back so the every-few-minutes backup doesn't slowly grow
  // the heap toward the cage between manual saves.
  if (r?.ok) _reinternAfterWholesaleRead('autosave');
  return { saved: !!r?.ok, path, mb: (bytes.length / 1e6).toFixed(1), error: r?.error };
}

// ─── 🧵 Overlay string interning hooks (V0.3.2.77) ──────────────────────────

/** Load-time entry: fresh pool for the incoming project, then intern. */
function _internOnLoad(stepsArr) {
  try {
    resetInternPool();
    const t0 = performance.now();
    const r = internAllStepOverlays(stepsArr);
    if (r.interned) {
      console.log(`[intern] ${r.interned} overlay(s) deduped on load — image pool ${r.poolImages} unique (${r.poolMB} MB), ~${r.sharedMB} MB now shared (${Math.round(performance.now() - t0)}ms)`);
    }
  } catch (e) { console.warn('[intern] load-time dedupe failed (project unaffected):', e?.message); }
  return stepsArr;
}

/** Post-save/autosave/cache-plan entry — re-share what the read flattened. */
export function _reinternAfterWholesaleRead(tag) {
  try {
    const t0 = performance.now();
    const r = internAllStepOverlays(state.get('steps') || []);
    if (r.interned) console.log(`[intern] re-deduped after ${tag}: ${r.interned} overlay(s), ~${r.sharedMB} MB re-shared (${Math.round(performance.now() - t0)}ms)`);
  } catch (e) { console.warn('[intern] re-dedupe failed:', e?.message); }
}

/**
 * STREAMING project encoder (V0.3.2.17). Serializes the project INTO the gzip
 * stream piece by piece — per top-level section, and per-STEP for the heavy
 * steps array — so no single giant JSON string is ever built. V8 caps any one
 * string at ~512MB; a large project's stringify crossed it ("RangeError:
 * Invalid string length") and saving became impossible. Byte-identical output
 * to JSON.stringify(project). Returns { bytes, rawBytes }.
 */
async function _encodeProjectStream(project, onProgress = null) {
  if (!_hasCompression) {
    const s = JSON.stringify(project);          // legacy no-gzip envs only (small projects)
    const b = new TextEncoder().encode(s);
    return { bytes: b, rawBytes: b.length };
  }
  const cs   = new CompressionStream('gzip');
  const w    = cs.writable.getWriter();
  const outP = new Response(cs.readable).arrayBuffer();
  const enc  = new TextEncoder();
  let rawBytes = 0;
  const push = async (s) => { const b = enc.encode(s); rawBytes += b.length; await w.write(b); };
  const keys = Object.keys(project);
  await push('{');
  for (let ki = 0; ki < keys.length; ki++) {
    const k = keys[ki];
    await push(`${JSON.stringify(k)}:`);
    const v = project[k];
    if (k === 'steps' && v && Array.isArray(v.items)) {
      await push(`{"schema_version":${JSON.stringify(v.schema_version ?? 1)},"items":[`);
      for (let i = 0; i < v.items.length; i++) {
        await push((i ? ',' : '') + JSON.stringify(v.items[i]));
        onProgress?.(i + 1, v.items.length);
      }
      await push(']}');
    } else {
      await push(JSON.stringify(v));
    }
    if (ki < keys.length - 1) await push(',');
  }
  await push('}');
  await w.close();
  return { bytes: new Uint8Array(await outP), rawBytes };
}

/** Bytes read from disk → project JSON string, auto-detecting gzip vs plain. */
async function _decodeProjectBytes(bytes) {
  if (_isGzipBytes(bytes)) {
    if (!_hasCompression) throw new Error('Project is gzip-compressed but this build lacks DecompressionStream.');
    return _gunzipToString(bytes);
  }
  return new TextDecoder().decode(bytes);
}


// ═══════════════════════════════════════════════════════════════════════════
//  SAVE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Save the current project.
 *
 * @param {object}  [options]
 * @param {'auto'|'saveAs'|'overwrite'} [options.mode='auto']
 * @param {FileSystemFileHandle} [options.handle]   — FSA handle to overwrite
 * @param {string}  [options.suggestedName]         — filename hint
 * @param {string}  [options.electronPath]          — Electron: path to overwrite
 *
 * @returns {Promise<{saved:boolean, path?:string, handle?:FileSystemFileHandle, cancelled?:boolean, downloaded?:boolean}>}
 */
export async function saveProject(options = {}) {
  const {
    mode          = 'auto',
    handle        = null,
    suggestedName = getSuggestedFilename(),
    electronPath  = null,
  } = options;

  // Save-progress overlay (V0.3.1.83): a big project serializes to 1GB+ of JSON
  // before compressing back down — seconds of "nothing visibly happening".
  // Emit staged progress (main.js renders the overlay); double-rAF so the
  // overlay actually PAINTS before the blocking serialize+stringify starts.
  const _t0 = performance.now();
  state.emit('save:progress', { stage: 'serialize' });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  steps.flushSync();       // ensure active step snapshot is current
  steps.upsertBaseStep();  // capture scene into hidden Step 0 staging area

  const project  = serialize();
  // Minified (no pretty-print). Whitespace was ~70% of large files; gzip on the
  // Electron path then crushes the cross-step redundancy (~30-40x total). The
  // file stays valid JSON, so older app builds without gzip still open it.
  // V0.3.2.17 — streamed: no whole-project JSON string is ever built (V8 max
  // string ~512MB made big-project saves impossible). Progress = steps written.
  const { bytes, rawBytes } = await _encodeProjectStream(project,
    (done, total) => state.emit('save:progress', { stage: 'compress', done, total, unit: 'steps' }));
  const filename = suggestedName.endsWith('.sbsproj')
    ? suggestedName
    : `${suggestedName.replace(/\.(json|sbsproj)$/i, '')}.sbsproj`;

  // ── Path 1: Electron IPC ─────────────────────────────────────────────────
  // 'auto'   → overwrite existing path silently; open dialog only if unsaved
  // 'saveAs' → always open dialog
  if (window.sbsNative?.saveProject) {
    const existingPath = state.get('projectPath');
    let savePath;
    if (mode === 'auto' && existingPath) {
      savePath = existingPath;          // silent overwrite — no dialog
    } else {
      savePath = electronPath || await window.sbsNative.saveProject(filename);
      if (!savePath) { state.emit('save:progress', { stage: 'cancelled' }); return { saved: false, cancelled: true }; }
    }
    // Write the gzipped bytes via the always-present binary fs:writeFile
    // handler (no dependency on a freshly-restarted main process).
    state.emit('save:progress', { stage: 'write', bytes: bytes.length });
    const writeResult = await window.sbsNative.writeFile(savePath, bytes, null);
    if (!writeResult?.ok) { state.emit('save:progress', { stage: 'error', message: writeResult?.error || 'Write failed' }); throw new Error(writeResult?.error || 'Write failed'); }
    _setProjectMeta(savePath);
    state.markClean();
    state.emit('save:progress', { stage: 'done', bytes: bytes.length, rawBytes, ms: performance.now() - _t0 });
    state.emit('project:saved', { path: savePath });
    // 🧵 V0.3.2.77 — serializing the overlays FLATTENED their ropes in
    // place (reading a cons string un-shares it), so a save quietly grows
    // the heap back by the deduped ~150MB. Re-intern now that it's done.
    _reinternAfterWholesaleRead('save');
    return { saved: true, path: savePath };
  }

  // ── Path 2: File System Access API ───────────────────────────────────────
  // 'auto'   → reuse stored handle silently; open picker only if no handle yet
  // 'saveAs' → always open picker
  if (window.showSaveFilePicker) {
    try {
      const storedHandle = state.get('fsaFileHandle');
      const saveHandle = (mode === 'auto' && storedHandle)
        ? storedHandle
        : await window.showSaveFilePicker({ suggestedName: filename, types: FILE_TYPES });
      state.emit('save:progress', { stage: 'write', bytes: bytes.length });
      await _writeToHandle(saveHandle, bytes);
      state.setState({ fsaFileHandle: saveHandle });   // persist for next auto-save
      _setProjectMeta(saveHandle.name);
      state.markClean();
      state.emit('save:progress', { stage: 'done', bytes: bytes.length, rawBytes, ms: performance.now() - _t0 });
      return { saved: true, handle: saveHandle };
    } catch (err) {
      state.emit('save:progress', { stage: err.name === 'AbortError' ? 'cancelled' : 'error', message: err?.message });
      if (err.name === 'AbortError') return { saved: false, cancelled: true };
      throw err;
    }
  }

  // ── Path 3: <a download> fallback ────────────────────────────────────────
  _triggerDownload(filename, bytes, 'application/gzip');
  state.markClean();
  state.emit('save:progress', { stage: 'done', bytes: bytes.length, rawBytes, ms: performance.now() - _t0 });
  return { saved: true, downloaded: true };
}


/**
 * Write a string to a FileSystemFileHandle.
 */
async function _writeToHandle(handle, content) {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

/**
 * Trigger a browser download of a text file.
 */
function _triggerDownload(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Update state with the current project file name/path.
 */
function _setProjectMeta(pathOrName) {
  const name = String(pathOrName || 'project.sbsproj').split(/[\\/]/).pop();
  state.setState({ projectPath: pathOrName, projectName: name });
}


// ═══════════════════════════════════════════════════════════════════════════
//  OPEN FILE PICKER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Show a file-open dialog for .sbsproj files.
 *
 * @returns {Promise<{file:File, handle?:FileSystemFileHandle, path?:string}|null>}
 */
export async function pickProjectFile() {
  // Electron — preload exposes sbsNative.openProject() → path | null
  //            and sbsNative.readFile(path, encoding) → { ok, data }
  if (window.sbsNative?.openProject) {
    const filePath = await window.sbsNative.openProject();
    if (!filePath) return null;
    // Read RAW bytes (gzipped new files OR legacy plain JSON). loadProject()
    // detects the gzip magic and decodes. Uses the long-standing binary
    // fs:readFile('buffer') handler, so opening never depends on a freshly
    // restarted main process.
    const readResult = await window.sbsNative.readFile(filePath, 'buffer');
    if (!readResult?.ok) throw new Error(readResult?.error || 'Read failed');
    const bytes = readResult.data instanceof Uint8Array ? readResult.data : new Uint8Array(readResult.data);
    const file = new File([bytes], filePath.split(/[\\/]/).pop(), { type: 'application/octet-stream' });
    return { file, path: filePath };
  }

  // File System Access API
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: FILE_TYPES,
        multiple: false,
      });
      const file = await handle.getFile();
      return { file, handle };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }

  // input[type=file] fallback
  return new Promise(resolve => {
    const input    = document.createElement('input');
    input.type     = 'file';
    input.accept   = '.sbsproj,.json';
    input.onchange = () => {
      const file = input.files?.[0] || null;
      resolve(file ? { file } : null);
    };
    input.click();
  });
}


// ═══════════════════════════════════════════════════════════════════════════
//  PARSE & MIGRATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse raw JSON text into a migrated project object.
 * Handles both the new format and the legacy POC v0.2xx format.
 *
 * @param {string} text  raw file text
 * @returns {object}     project in createEmptyProject() shape
 */
export function parseProjectFile(text) {
  return _migrateParsedProject(JSON.parse(text));
}

/** Shared migration tail (used by both the normal and the streaming parser). */
function _migrateParsedProject(raw) {
  // Legacy POC format (has projectFormat:'sbsproj' at root)
  if (raw.projectFormat === 'sbsproj') {
    return _migrateLegacyPoc(raw);
  }

  // New format — run per-section migrations.
  //
  // V0.3.2.70 — THE MIGRATION SYSTEM WAS DEAD. This loop passed PLURAL
  // section names ('colors', 'cables', 'steps'…) while MIGRATIONS and
  // SCHEMA_VERSIONS are keyed SINGULAR ('color', 'cable', 'step'). Every
  // lookup missed, so `migrations` was always [] and `currentVersion`
  // always 1 — meaning the color v1→v2→v3 chain and the cable v1→v2
  // absolute-mm conversion had NEVER RUN on a single legacy project.
  // ('tree' matched by luck; its migration list is empty.)
  const MIGRATION_KEY = {
    assets: 'asset', tree: 'tree', steps: 'step', cameras: 'camera',
    colors: 'color', notes: 'note', cables: 'cable', screens: 'screen',
    // chapters / selections / settings have no registered migrations
  };
  const project = { ...raw };
  const sections = ['assets', 'tree', 'steps', 'chapters', 'cameras', 'colors', 'notes', 'selections', 'settings', 'cables'];
  for (const sectionName of sections) {
    if (!project[sectionName]) continue;
    const key = MIGRATION_KEY[sectionName] || sectionName;
    project[sectionName] = migrateSection(key, project[sectionName], sectionName);
  }
  return project;
}

/** gunzip → BYTES (no string — see the streaming parser below). */
async function _gunzipToBytes(bytes) {
  const ds = new DecompressionStream('gzip');
  const w  = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/**
 * STREAMING PARSER (V0.3.2.19) — parse a project too big for JSON.parse.
 * V8 caps any one string at ~512MB; a 546MB project saved fine (streamed
 * save, V0.3.2.17) and then COULD NOT OPEN. This scanner walks the UTF-8
 * bytes (string/escape-aware depth tracking), extracts each top-level
 * section — and each STEP individually — as a byte range, and JSON.parses
 * every piece on its own. No string ever approaches the limit. Validated
 * against the real 546MB file offline (228 steps, 9.7s) before shipping.
 */
function _parseProjectBytesStreaming(s) {
  const dec = new TextDecoder();
  let i = 0;
  const err = (m) => { throw new Error(`stream-parse: ${m} @ byte ${i}`); };
  const ws = () => { while (i < s.length && (s[i] === 0x20 || s[i] === 0x09 || s[i] === 0x0A || s[i] === 0x0D)) i++; };
  const scanString = () => {
    i++;
    while (i < s.length) {
      const c = s[i];
      if (c === 0x5C) { i += 2; continue; }
      if (c === 0x22) { i++; return; }
      i++;
    }
    err('unterminated string');
  };
  const scanValue = () => {
    ws();
    const start = i;
    const c = s[i];
    if (c === 0x22) { scanString(); return [start, i]; }
    if (c === 0x7B || c === 0x5B) {
      let depth = 0;
      while (i < s.length) {
        const b = s[i];
        if (b === 0x22) { scanString(); continue; }
        if (b === 0x7B || b === 0x5B) { depth++; i++; continue; }
        if (b === 0x7D || b === 0x5D) { depth--; i++; if (!depth) return [start, i]; continue; }
        i++;
      }
      err('unterminated object/array');
    }
    while (i < s.length && s[i] !== 0x2C && s[i] !== 0x7D && s[i] !== 0x5D && s[i] > 0x20) i++;
    return [start, i];
  };
  const parseRange = (r) => JSON.parse(dec.decode(s.subarray(r[0], r[1])));

  ws();
  if (s[i] !== 0x7B) err('project must start with {');
  i++;
  const project = {};
  for (;;) {
    ws();
    if (s[i] === 0x7D) { i++; break; }
    if (s[i] === 0x2C) { i++; continue; }
    if (s[i] !== 0x22) err('expected key');
    const k0 = i; scanString();
    const key = JSON.parse(dec.decode(s.subarray(k0, i)));
    ws(); if (s[i] !== 0x3A) err('expected :'); i++;
    ws();
    if (key === 'steps' && s[i] === 0x7B) {
      i++;
      const stepsObj = {};
      for (;;) {
        ws();
        if (s[i] === 0x7D) { i++; break; }
        if (s[i] === 0x2C) { i++; continue; }
        const sk0 = i; scanString();
        const sk = JSON.parse(dec.decode(s.subarray(sk0, i)));
        ws(); if (s[i] !== 0x3A) err('expected : in steps'); i++;
        ws();
        if (sk === 'items' && s[i] === 0x5B) {
          i++;
          const items = [];
          for (;;) {
            ws();
            if (s[i] === 0x5D) { i++; break; }
            if (s[i] === 0x2C) { i++; continue; }
            items.push(parseRange(scanValue()));
          }
          stepsObj.items = items;
        } else {
          stepsObj[sk] = parseRange(scanValue());
        }
      }
      project.steps = stepsObj;
    } else {
      project[key] = parseRange(scanValue());
    }
  }
  return project;
}

/**
 * Convert a legacy POC v0.2xx project to the new format.
 */
function _migrateLegacyPoc(raw) {
  const project = createEmptyProject();
  project._sbs.saved = raw.savedAt || new Date().toISOString();

  const scene = raw.scene || {};
  const cs    = scene.currentState || {};

  // Steps
  if (Array.isArray(scene.steps))        project.steps.items         = scene.steps;
  if (Array.isArray(scene.cameraViews))  project.cameras.items       = scene.cameraViews;
  if (Array.isArray(scene.noteTemplates))project.notes.templates     = scene.noteTemplates;
  if (Array.isArray(scene.selectionGroups)) project.selections.groups = scene.selectionGroups;

  // Color presets
  if (Array.isArray(cs.colorPresets))    project.colors.items = cs.colorPresets;

  // Settings
  if (cs.backgroundColor)               project.settings.backgroundColor      = cs.backgroundColor;
  if (cs.showGrid !== undefined)         project.settings.gridVisible          = cs.showGrid;
  if (cs.overrideMode !== undefined)     project.settings.solidOverride        = !!cs.overrideMode;
  if (cs.selectionOutlineColor)          project.selections.outlineColor       = cs.selectionOutlineColor;
  if (cs.cameraAnimDuration != null)     project.settings.cameraAnimDurationMs = cs.cameraAnimDuration;
  if (cs.objectAnimDuration != null)     project.settings.objectAnimDurationMs = cs.objectAnimDuration;

  project.settings.cameraFillLight = {
    enabled:   !!cs.cameraFillLightEnabled,
    color:     _hexOrDefault(cs.cameraFillLightColor,  '#ffffff'),
    intensity: _clamp(cs.cameraFillLightIntensity, 0, 20, 1.1),
    distance:  _clamp(cs.cameraFillLightDistance,  0, 1e6, 0),
    decay:     _clamp(cs.cameraFillLightDecay,     0, 8, 2),
    offsetX:   _clamp(cs.cameraFillLightOffsetX,   -1e5, 1e5, -120),
    offsetY:   _clamp(cs.cameraFillLightOffsetY,   -1e5, 1e5, 70),
    offsetZ:   _clamp(cs.cameraFillLightOffsetZ,   -1e5, 1e5, 140),
  };

  project.settings.geometryOutline = {
    enabled:     !!cs.globalGeometryOutlineEnabled,
    color:       _hexOrDefault(cs.globalGeometryOutlineColor, '#000000'),
    opacity:     _clamp(cs.globalGeometryOutlineOpacity, 0, 1, 0.9),
    creaseAngle: _clamp(cs.globalGeometryOutlineAngle, 1, 180, 35),
  };

  project.settings.export = {
    ...project.settings.export,
    fileName:        'sbs_export',
    outputFormat:    cs.exportOutputFormat    || 'webm_vp8',
    formatPreset:    cs.exportFormatPreset    || 'hdtv_1080',
    width:           cs.exportWidth           ?? 1920,
    height:          cs.exportHeight          ?? 1080,
    fps:             cs.exportFps             ?? 30,
    stepHoldMs:      cs.exportStepHoldDuration ?? 100,
    // Drop legacy voice ids that don't belong to a current backend (os:/kokoro:).
    narrationVoice:  (/^(os|kokoro):/.test(cs.exportNarrationVoice || '') ? cs.exportNarrationVoice : ''),
    narrationSpeed:  cs.exportNarrationSpeed  ?? 1.0,
    narrationHelperUrl:        cs.exportNarrationHelperUrl        || 'http://127.0.0.1:8765',
    deterministicHelperUrl:    cs.exportDeterministicHelperUrl    || 'http://127.0.0.1:8766',
  };

  // Asset entries — derived from model specs
  // We stash the saved treeSpec on each asset so the caller can do ID remapping.
  if (Array.isArray(scene.models)) {
    project.assets.items = scene.models.map(m => ({
      id:           m.slotId || m.id || generateId('asset'),
      name:         m.name || 'Unnamed Model',
      type:         'model',
      originalPath: m.stepSource?.absolutePath || '',
      relativePath: m.stepSource?.relativePath || m.stepSource?.fileName || '',
      fileHash:     null,
      fileSize:     m.stepSource?.fileSize || null,
      importedAt:   new Date().toISOString(),
      // Non-standard field — preserved for ID-remap during load, stripped on re-save
      _legacyTreeSpec: m.tree || null,
    }));
  }

  return project;
}

// ── Small helpers for migration ────────────────────────────────────────────

function _clamp(v, lo, hi, def) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

function _hexOrDefault(v, def) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '')) ? v : def;
}


// ═══════════════════════════════════════════════════════════════════════════
//  APPLY TO STATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply all non-geometry sections of a loaded project to app state.
 * Geometry (tree, object3d links) is handled separately by the model-loader.
 *
 * @param {object} project  migrated project from parseProjectFile()
 */
// Stashed on every load: the SAVED project tree spec — full-fidelity node specs
// (incl. base pose, follow, RM fields) for the tree-reconcile pass below.
let _lastLoadedTreeSpecRoot = null;

export function applyProjectToState(project) {
  const s = project.settings || {};
  _lastLoadedTreeSpecRoot = project.tree?.root || null;

  // 🔩 V0.3.2.67 — warm the primitive definition registry from the saved
  // tree BEFORE any rebuild runs. Without this the first activation of a
  // loaded project recreated late-parented primitives from STEP-SNAPSHOT
  // time capsules (often creation-time defaults), and the next save baked
  // those stale dimensions in permanently.
  try { seedPrimitiveDefsFromTree(_lastLoadedTreeSpecRoot); }
  catch (e) { console.warn('[load] primitive definition seed failed:', e?.message); }

  // ── Settings ──────────────────────────────────────────────────────────────
  state.setState({
    backgroundColor:      s.backgroundColor        ?? '#0f172a',
    backgroundGradient:   {
      enabled:  !!s.backgroundGradient?.enabled,
      color1:   s.backgroundGradient?.color1   ?? '#0f172a',
      color2:   s.backgroundGradient?.color2   ?? '#1e293b',
      angleDeg: Number.isFinite(s.backgroundGradient?.angleDeg) ? s.backgroundGradient.angleDeg : 180,
    },
    // V0.3.0.162 — per-project AO + SSR. Merge the saved render over the current
    // (seeded-from-user-default) values so a legacy project with no render block
    // keeps the user default, and a partial block fills its gaps. change:render
    // (main.js) re-applies it to the viewport.
    render: (() => {
      // Per-section merge of the saved render over the seeded default — every
      // section (ao, ssr, production, and anything added later) round-trips.
      // V0.3.2.52: was a hardcoded {ao, ssr} that SILENTLY DROPPED production
      // on load, so lighting/HDRI settings saved but vanished on reopen.
      const cur = state.get('render') || {};
      const r   = s.render || {};
      const out = {};
      for (const k of new Set([...Object.keys(cur), ...Object.keys(r)])) {
        out[k] = (cur[k] && typeof cur[k] === 'object' && r[k] && typeof r[k] === 'object')
          ? { ...cur[k], ...r[k] } : (r[k] ?? cur[k]);
      }
      return out;
    })(),
    solidOverride:        s.solidOverride           ?? false,
    gridVisible:          s.gridVisible             ?? false,
    cameraAnimDurationMs: s.cameraAnimDurationMs    ?? 1500,
    objectAnimDurationMs: s.objectAnimDurationMs    ?? 1500,
    cameraFillLight:      s.cameraFillLight
                            ? { ...state.get('cameraFillLight'), ...s.cameraFillLight }
                            : state.get('cameraFillLight'),
    geometryOutline:      s.geometryOutline
                            ? { ...state.get('geometryOutline'), ...s.geometryOutline }
                            : state.get('geometryOutline'),
    export:               s.export
                            ? { ...state.get('export'), ...s.export }
                            : state.get('export'),
    audioCacheFolder:     s.audioCacheFolder ?? null,
    // Interface shared default pose + library folder (missing on legacy files
    // → null → falls back to per-interface behavior, no crash).
    interfaceDefaultPose:   s.interfaceDefaultPose   ?? null,
    interfaceLibraryFolder: s.interfaceLibraryFolder ?? null,
    // V0.2.22.58 — per-project hardware-animation default (missing on
    // legacy files → null → system defaults apply).
    hardwareDefaults:     s.hardwareDefaults ?? null,
  });

  // ── Content arrays ────────────────────────────────────────────────────────
  state.setState({
    steps:                _internOnLoad(project.steps?.items || []),
    chapters:             project.chapters?.items           || [],
    cameraViews:          project.cameras?.items            || [],
    colorPresets:         project.colors?.items             || [],
    animationPresets:     _migrateAnimationPresets(project.animationPresets?.items || []),
    noteTemplates:        project.notes?.templates          || [],
    notePresets:          project.notes?.presets            || state.get('notePresets'),
    selectionGroups:      _migrateSelectionGroups(project.selections?.groups || []),
    selectionOutlineColor:project.selections?.outlineColor  || '#00ffff',
    assets:               project.assets?.items             || [],
    headerItems:          project.headers?.items            || [],
    headersLocked:        !!project.headers?.locked,
    headersHidden:        !!project.headers?.hidden,
    // P4: project-level default styling. Falls back to current state default
    // when missing (so older .sbsproj files without this field load cleanly).
    headerDefault:        project.headers?.default           || state.get('headerDefault'),
    headerStepNumberPerChapter: !!project.headers?.stepNumberPerChapter,
    styleTemplates:       project.styles?.items              || [],
    shapeTemplates:       project.shapes?.items              || [],
    // V0.2.22.38 — hardware template library, see core/schema.js
    // createHardwareTemplate. Missing on legacy files → empty list, no
    // breakage; the only way to get instances is via the Hardware tab
    // creating templates first.
    hardwareTemplates:    project.hardware?.templates         || [],
    // V0.1.85: shape-tab groupings. Default to [] for older files.
    shapeTemplateGroups:  project.shapes?.groups             || [],
    // Reset session-local tab state on load.
    selectedShapeTemplateIds:       new Set(),
    selectedShapeTemplateGroupIds:  new Set(),
    selectedColorPresetIds:         new Set(),
    // Cables — older .sbsproj files don't have this section; default
    // to empty + factory globals so the load is clean. The 3-tier
    // anchor resolver gracefully handles missing meshes via cached
    // worldPos / worldQuat baked into each cable node by the saver.
    cables:               project.cables?.items              || [],
    cableGlobalScale:     project.cables?.globalScale        ?? 1.0,
    cableGlobalRadius:    project.cables?.globalRadius        ?? 1.0,   // V0.3.0.161 — was not restored
    // V0.3.0.165 — default-new-cable diameter (mm). Migrated projects with no
    // explicit value inherit old globalRadius × 2 so new cables match their look.
    cableDefaultDiameter: project.cables?.defaultDiameter ?? ((project.cables?.globalRadius ?? 1.0) * 2),
    cableFilletReach:     project.cables?.filletReach         ?? 40,    // V0.3.0.161 — fillet mode
    cableHighlightColor:  project.cables?.highlightColor     ?? '#22d3ee',
  });

  // Restore project-level color state. Both maps keyed by mesh id; the
  // defaults persist across step activations (that's the point), the
  // assignments are immediately overwritten by the first activateStep,
  // but seeding them here keeps any "before any step" view consistent.
  materials.meshDefaultColors    = { ...(project.colors?.defaults    || {}) };
  materials.meshColorAssignments = { ...(project.colors?.assignments || {}) };

  // Legacy migration: pre-fix snapshots stamped meshDefaultColors values
  // into step.snapshot.materials, so default changes never propagated.
  // One-time pass strips every default-tracking entry; the lookup chain
  // in materials.applyAll then resolves those meshes through the current
  // default automatically.
  _migrateLegacyDefaultStamps();

  // Camera-binding migration: legacy steps had no cameraBinding field —
  // default each missing one to free-camera so step.snapshot.camera keeps
  // driving the view (today's behaviour). Templates land in cameraViews
  // already; users opt steps into them via the per-step camera dropdown.
  _migrateStepCameraBindings();

  // Step-group fields migration (Phase A of "step groups"): legacy steps
  // had no groupHead / groupId fields — default groupHead=false and
  // groupId=null so every loaded step is treated as a normal top-level
  // step. Files written before this migration was added round-trip
  // identically; new files written after it carry the fields.
  _migrateStepGroupFields();

  // Drop stale narration.dataFile pointers — pre voice-subfolder format
  // (top-level "<40hex>.wav") and any fast OS voice that earlier versions
  // mistakenly disk-cached. Without this, ensurePlayable hits ENOENT on
  // every play of a touched step until it self-heals via re-synth.
  const cleanedDataFiles = narrationCache.cleanStaleDataFiles(state.get('steps') || []);
  if (cleanedDataFiles) {
    console.log(`[project] dropped ${cleanedDataFiles} stale narration.dataFile pointer(s)`);
  }

  // Background-cache every narration clip the project carries text for
  // but no fresh audio. Runs serially; never blocks the UI. By the time
  // the user starts navigating steps, most clips are already synthesized.
  state.emit('project:loaded');

  state.markClean();
}

function _migrateStepCameraBindings() {
  const stepsArr = state.get('steps') || [];
  let migrated = 0;
  for (const step of stepsArr) {
    if (!step.cameraBinding || typeof step.cameraBinding !== 'object') {
      step.cameraBinding = createCameraBinding();
      migrated++;
    } else {
      // Sanity: if mode is missing/unknown, force 'free' (snapshot-driven).
      if (step.cameraBinding.mode !== 'template' && step.cameraBinding.mode !== 'free') {
        step.cameraBinding.mode = 'free';
        migrated++;
      }
      if (step.cameraBinding.templateId === undefined) {
        step.cameraBinding.templateId = null;
      }
    }
  }
  if (migrated) {
    console.log(`[migrate] Defaulted cameraBinding on ${migrated} legacy step(s) to free-camera.`);
    state.setState({ steps: [...stepsArr] });
  }
}

function _migrateStepGroupFields() {
  const stepsArr = state.get('steps') || [];
  let migrated = 0;
  const validIds = new Set(stepsArr.map(s => s?.id));
  for (const step of stepsArr) {
    if (typeof step.groupHead !== 'boolean')   { step.groupHead   = false; migrated++; }
    if (step.groupId === undefined)            { step.groupId     = null;  migrated++; }
    if (typeof step.groupLocked !== 'boolean') { step.groupLocked = false; migrated++; }
    // Sanity: if groupId points at a non-existent step, drop the link
    // (defensive — shouldn't happen in well-formed files but cheap to
    // check). Same for the rare case of a step claiming to be both head
    // and sub-step at once: head wins, link is cleared.
    if (step.groupId && !validIds.has(step.groupId)) {
      step.groupId = null;
      migrated++;
    }
    if (step.groupHead === true && step.groupId !== null) {
      step.groupId = null;
      migrated++;
    }
  }
  if (migrated) {
    console.log(`[migrate] Defaulted/repaired step-group fields on ${migrated} legacy step record(s).`);
    state.setState({ steps: [...stepsArr] });
  }
  _repairGroupContiguity();
}

/**
 * GROUP CONTIGUITY REPAIR (V0.3.2.44). A step group is a CONTIGUOUS run:
 * one head followed immediately by its members. Before this version, pasting
 * copied steps kept the ORIGINAL group identity — a pasted copy 50 steps away
 * claimed membership in the distant group, and every group-aware system
 * followed the chain to the wrong place: arrow-key navigation jumped steps,
 * playback/export folded the copies into a group head that wasn't there (new
 * steps silently missing from exports). The paste is fixed at the source;
 * this repairs files that already carry the damage. Rules, walking in order:
 *   - a run of members whose head is NOT the step right where the run
 *     expects it (head absent / seen in an earlier run / mid-timeline ghost)
 *     is re-headed: first step of the run becomes a fresh head, the rest its
 *     members. Single-step ghosts just lose their grouping.
 * Runs on every load; logs what it changed. Also: window.sbsFix.stepGroups().
 */
export function _repairGroupContiguity() {
  const stepsArr = state.get('steps') || [];
  const keyOf = (s) => (s.groupHead ? s.id : (s.groupId || null));
  // Partition into contiguous runs by group key.
  const runs = [];
  for (let i = 0; i < stepsArr.length; i++) {
    const k = keyOf(stepsArr[i]);
    const last = runs[runs.length - 1];
    if (k !== null && last && last.key === k) { last.steps.push(stepsArr[i]); continue; }
    runs.push({ key: k, steps: [stepsArr[i]] });
  }
  const claimed = new Set();
  let repairedRuns = 0, touched = 0;
  for (const run of runs) {
    if (run.key === null) continue;
    const headInRun = run.steps.some(s => s.id === run.key);
    const duplicate = claimed.has(run.key);
    claimed.add(run.key);
    if (headInRun && !duplicate) continue;             // healthy group
    // Ghost or orphaned run — give it a fresh, self-contained identity.
    repairedRuns++;
    if (run.steps.length === 1) {
      const s = run.steps[0];
      if (s.groupHead || s.groupId) { s.groupHead = false; s.groupId = null; touched++; }
      continue;
    }
    const head = run.steps[0];
    if (!head.groupHead || head.groupId) { head.groupHead = true; head.groupId = null; touched++; }
    for (const s of run.steps.slice(1)) {
      if (s.groupId !== head.id || s.groupHead) { s.groupHead = false; s.groupId = head.id; touched++; }
    }
  }
  if (touched) {
    console.warn(`[migrate] GROUP REPAIR: ${repairedRuns} broken group run(s) re-headed/cleared (${touched} step record(s) fixed) — pasted copies used to keep the original group's identity.`);
    state.setState({ steps: [...stepsArr] });
    state.markDirty();
  }
  return { repairedRuns, touched };
}

function _migrateLegacyDefaultStamps() {
  const stepsArr = state.get('steps') || [];
  const defaults = materials.meshDefaultColors || {};
  let stripped = 0;
  for (const step of stepsArr) {
    const m = step.snapshot?.materials;
    if (!m) continue;
    for (const [id, presetId] of Object.entries(m)) {
      if (defaults[id] === presetId) { delete m[id]; stripped++; }
    }
  }
  if (stripped) {
    console.log(`[migrate] Stripped ${stripped} default-tracking color stamp(s) from legacy snapshots.`);
    state.setState({ steps: [...stepsArr] });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  ID REMAP — reconnect saved IDs to freshly-loaded geometry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a Map<newId → savedId> by walking `liveNode` and `specNode`
 * in parallel DFS order.
 *
 * Strategy:
 *   - Nodes are matched by type + position in children array.
 *   - Mesh nodes are additionally matched by meshIndex (deterministic
 *     OCCT tessellation order ensures same file → same mesh order).
 *
 * @param {TreeNode} liveNode  freshly loaded node (new IDs)
 * @param {object}   specNode  saved tree spec (saved IDs)
 * @param {Map<string,string>} [idMap]
 * @returns {Map<string,string>}
 */
export function buildIdRemapFromSpec(liveNode, specNode, idMap = new Map()) {
  if (!liveNode || !specNode) return idMap;
  if (liveNode.type !== (specNode.type === 'group' ? 'folder' : specNode.type)) return idMap;

  idMap.set(liveNode.id, specNode.id);

  const liveChildren = liveNode.children || [];
  const specChildren = specNode.children || [];

  // ── Mesh match — semantic identity first, then legacy fallbacks ───────────
  //   1. fingerprint + bbox centre   (robust against re-export, disambiguates duplicates)
  //   2. meshIndex                   (stable within a single file export)
  //   3. positional                  (last resort)
  //
  // EXCLUDE live displaced meshes from the spec side. A phantom subtree
  // (relink path) may contain children that were moved into it by step-
  // snapshot reparenting from OTHER models — those are LIVE (`missing` is
  // explicit `false`) and have nothing to do with the asset being relinked.
  // Without this filter, an FBX relink could fingerprint-match one of its
  // fresh meshes onto a displaced live OBJ mesh and steal its id, breaking
  // the tree's access to that mesh. Saved specs from disk have no missing
  // flag at all (undefined) and pass through unchanged.
  const specMeshes = specChildren.filter(c => c.type === 'mesh' && c.missing !== false);
  const liveMeshes = liveChildren.filter(c => c.type === 'mesh');
  const takenLive  = new Set();

  for (const specMesh of specMeshes) {
    let liveMesh = _matchBySemantic(specMesh, liveMeshes, takenLive);
    if (!liveMesh && specMesh.meshIndex != null) {
      liveMesh = liveMeshes.find(m => !takenLive.has(m) && m.meshIndex === specMesh.meshIndex) ?? null;
    }
    if (!liveMesh) {
      const idx = specMeshes.indexOf(specMesh);
      const candidate = liveMeshes[idx];
      if (candidate && !takenLive.has(candidate)) liveMesh = candidate;
    }
    if (liveMesh) {
      takenLive.add(liveMesh);
      buildIdRemapFromSpec(liveMesh, specMesh, idMap);
    }
  }

  // Match non-mesh children (folders) by position
  const specFolders = specChildren.filter(c => c.type !== 'mesh');
  const liveFolders = liveChildren.filter(c => c.type !== 'mesh');
  specFolders.forEach((specChild, i) => {
    if (liveFolders[i]) buildIdRemapFromSpec(liveFolders[i], specChild, idMap);
  });

  return idMap;
}

// Round bbox centre to 2 decimal places — absorbs re-export float noise.
function _bboxCentreKey(bbox) {
  if (!bbox) return null;
  const r = v => Math.round(v * 100);
  return `${r((bbox.min[0] + bbox.max[0]) / 2)},${r((bbox.min[1] + bbox.max[1]) / 2)},${r((bbox.min[2] + bbox.max[2]) / 2)}`;
}

// Match a spec mesh to an unused live mesh by (fingerprint + bbox centre).
// Both must agree. Duplicate identical parts (nuts/bolts) are disambiguated
// by bbox centre because each sits at a different location in the model.
function _matchBySemantic(specMesh, liveMeshes, taken) {
  if (!specMesh.fingerprint) return null;
  const specCentre = _bboxCentreKey(specMesh.bbox);
  if (!specCentre) return null;
  for (const live of liveMeshes) {
    if (taken.has(live)) continue;
    if (live.fingerprint !== specMesh.fingerprint) continue;
    if (_bboxCentreKey(live.bbox) !== specCentre) continue;
    return live;
  }
  return null;
}

/**
 * Apply an ID remap to a live node tree IN PLACE.
 * - Rewrites node.id
 * - Updates object3d.userData.meshNodeId on mesh nodes
 *
 * @param {TreeNode}             node
 * @param {Map<string,string>}   idMap   new → saved
 */
export function applyIdRemap(node, idMap) {
  if (!node) return;
  const savedId = idMap.get(node.id);
  if (savedId) {
    if (node.object3d) node.object3d.userData.meshNodeId = savedId;
    node.id = savedId;
  }
  (node.children || []).forEach(c => applyIdRemap(c, idMap));
}

/**
 * Collect every mesh spec node from an entire saved scene tree into a flat array.
 * Includes displaced meshes that live in custom folders outside their native model.
 * The returned spec objects retain all saved properties (meshIndex, sourceAssetId, …).
 *
 * @param {object|null} specRoot  saved scene root (project.tree.root)
 * @returns {object[]}  flat array of all mesh spec nodes in the tree
 */
export function collectAllMeshSpecs(specRoot) {
  const specs = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'mesh') specs.push(node);
    for (const child of (node.children || [])) walk(child);
  }
  walk(specRoot);
  return specs;
}

/**
 * Extend an existing ID remap map with entries for "displaced" meshes — meshes
 * that were moved out of their native model subtree (e.g. into a scene-root custom
 * folder) before the project was saved.
 *
 * Standard buildIdRemapFromSpec() only walks the model's own saved spec subtree and
 * therefore misses displaced meshes (they were removed from that subtree when the
 * user moved them).  This function finds those meshes in the FULL saved tree and
 * matches them to live mesh nodes by meshIndex + sourceAssetId.
 *
 * @param {TreeNode}  liveModelNode      freshly-loaded model node (pre-applyIdRemap)
 * @param {object[]}  allSavedMeshSpecs  from collectAllMeshSpecs(savedSceneRoot)
 * @param {string}    assetId            stable asset ID of the model being remapped
 * @param {Map}       idMap              Map<newId, savedId> from buildIdRemapFromSpec (mutated)
 * @returns {Map}  idMap, now including displaced-mesh entries
 */
export function buildDisplacedMeshIdRemap(liveModelNode, allSavedMeshSpecs, assetId, idMap) {
  if (!liveModelNode || !allSavedMeshSpecs?.length) return idMap;

  // Collect live mesh nodes from this model that were NOT remapped by the standard path.
  const unmappedLive = [];
  function collectUnmapped(node) {
    if (node.type === 'mesh' && !idMap.has(node.id)) unmappedLive.push(node);
    (node.children || []).forEach(collectUnmapped);
  }
  collectUnmapped(liveModelNode);
  if (!unmappedLive.length) return idMap;

  // Saved mesh IDs that are already claimed — don't double-match.
  const claimedSavedIds = new Set(idMap.values());

  // Filter saved mesh specs to candidates for this model's displaced meshes:
  //   1. Not already matched by a previous remap.
  //   2. Tagged with this model's assetId (via sourceAssetId set during load).
  //   3. Legacy fallback: accept untagged specs (old project files — may be
  //      ambiguous in multi-model projects but correct for single-model ones).
  const candidates = allSavedMeshSpecs.filter(spec => {
    if (claimedSavedIds.has(spec.id)) return false;
    // sourceAssetId required — meshIndex values overlap across models so we
    // cannot safely match without knowing which model a displaced spec belongs to.
    // Old project files without sourceAssetId simply skip displaced remap (they
    // load correctly via the standard in-subtree remap path).
    return spec.sourceAssetId === assetId;
  });
  if (!candidates.length) return idMap;

  // Match by meshIndex (deterministic OCCT tessellation order).
  for (const live of unmappedLive) {
    if (live.meshIndex == null) continue; // non-OCCT mesh — no reliable index
    const idx = candidates.findIndex(spec => spec.meshIndex === live.meshIndex);
    if (idx < 0) continue;
    const match = candidates[idx];
    idMap.set(live.id, match.id);
    claimedSavedIds.add(match.id);
    candidates.splice(idx, 1); // prevent double-claiming the same saved spec
  }

  return idMap;
}

/**
 * After remapping, apply saved fields from a spec back onto the live nodes:
 * names, transforms, visibility, colorPresetId.
 *
 * @param {object}               specNode  saved node (with saved IDs)
 * @param {Map<string,TreeNode>} nodeById  live map (already has remapped IDs)
 */
// Node types whose HOME base pose IS their placement (not derived from
// imported geometry) — so it must be restored from the saved tree on load.
// mesh/model/scene are excluded: their base comes from the geometry bake.
const PROCEDURAL_BASE_TYPES = new Set(['flatShape', 'primitive', 'hardwareInstance', 'hardwareNut', 'folder']);

/**
 * TREE RECONCILE (V0.3.2.62) — the productized field-repair ritual. The load's
 * async reattach is a RACE: on any given load, some nodes (custom folders /
 * Replace-Model wrappers under models, and the shapes bonded to them) can lose
 * the race and silently DROP from the live tree while every step snapshot
 * still references them. Symptoms in the field: object in the scene but not
 * in the tree, shapes gone null, counts varying per load, saves of that state
 * permanently corrupted (this destroyed a client-machine project on 0.3.2-45).
 *
 * This pass runs AFTER the load settles: any node referenced by a step
 * snapshot but missing from the live tree is re-inserted — preferring its
 * FULL spec from the saved project tree (base pose, follow, RM fields), with
 * the snapshot spec as fallback — and its live children are moved back inside.
 * Idempotent; logs loudly; also exposed as window.sbsFix.treeNodes().
 */
export function reconcileSnapshotTreeNodes() {
  const root = state.get('treeData');
  if (!root) return { repaired: 0 };
  const liveIds = new Set();
  (function w(n) { if (!n) return; liveIds.add(n.id); (n.children || []).forEach(w); })(root);

  // Collect missing ids (first occurrence wins) from every step snapshot.
  const missing = new Map();   // id → { snapSpec, snapParentId }
  for (const s of (state.get('steps') || [])) {
    (function w(n, parent) {
      if (!n) return;
      if (!liveIds.has(n.id) && !missing.has(n.id)) missing.set(n.id, { snapSpec: n, snapParentId: parent?.id || null });
      (n.children || []).forEach(c => w(c, n));
    })(s.snapshot?.tree, null);
  }
  if (!missing.size) return { repaired: 0 };

  // Index the SAVED project tree for full-fidelity specs + parents.
  const savedSpec = new Map(), savedParent = new Map();
  (function w(n, parent) {
    if (!n) return;
    savedSpec.set(n.id, n);
    savedParent.set(n.id, parent?.id || null);
    (n.children || []).forEach(c => w(c, n));
  })(_lastLoadedTreeSpecRoot, null);

  const byId = new Map();
  (function w(n) { if (!n) return; byId.set(n.id, n); (n.children || []).forEach(w); })(root);

  const repairedIds = [];
  for (const [id, info] of missing) {
    const spec     = savedSpec.get(id) || info.snapSpec;             // prefer full saved spec
    const parentId = savedParent.get(id) ?? info.snapParentId;
    const parentLive = byId.get(parentId) || root;
    const nodeLive = { ...spec, object3d: null, children: [] };
    for (const c of (spec.children || [])) {
      const childLive = byId.get(c.id);
      if (!childLive) continue;
      (function detach(n) {
        if (!n?.children) return;
        const i = n.children.findIndex(x => x.id === c.id);
        if (i >= 0) { n.children.splice(i, 1); return; }
        n.children.forEach(detach);
      })(root);
      nodeLive.children.push(childLive);
    }
    parentLive.children = [...(parentLive.children || []), nodeLive];
    byId.set(id, nodeLive);
    repairedIds.push(`${id} (${nodeLive.type})`);
  }

  state.setState({ treeData: root, nodeById: buildNodeMap(root) });
  state.emit('change:treeData', root);
  state.markDirty();
  console.warn(`[load] TREE RECONCILE: re-inserted ${repairedIds.length} node(s) the load dropped from the tree (step snapshots still referenced them): ${repairedIds.join(', ')}`);
  return { repaired: repairedIds.length, ids: repairedIds };
}

/**
 * 🔩 Late primitive-definition re-assert (V0.3.2.67) — the second half of
 * the "primitives reset to default dimensions" fix. Runs with the tree
 * reconcile timers (project:loaded +1200ms/+4000ms), AFTER the async
 * rebuild passes settle. Any live primitive whose definition drifted from
 * the saved project tree (because a step-snapshot time capsule created it)
 * is restored to the saved truth and its mesh rebuilt.
 *
 * A primitive the user ALREADY resized this session (_paramsUserEdited,
 * stamped by actions.setPrimitiveParams) is never touched — a late timer
 * must not revert a fresh edit. New primitives absent from the saved tree
 * are skipped (nothing to assert).
 */
export function reassertPrimitiveDefs() {
  const nodeById = state.get('nodeById');
  let fixed = 0;
  if (!_lastLoadedTreeSpecRoot || !nodeById) return { fixed };
  (function walk(spec) {
    if (!spec) return;
    if (spec.type === 'primitive' && spec.primParams && Object.keys(spec.primParams).length) {
      const live = nodeById.get(spec.id);
      if (live && live.type === 'primitive' && !live._paramsUserEdited) {
        const a = JSON.stringify([live.primKind, live.primParams, live.primQuality, live.baseAtOrigin]);
        const b = JSON.stringify([spec.primKind, spec.primParams, spec.primQuality, spec.baseAtOrigin]);
        if (a !== b) {
          live.primKind    = spec.primKind ?? live.primKind;
          live.primParams  = { ...spec.primParams };
          live.primQuality = spec.primQuality ?? live.primQuality;
          if (spec.baseAtOrigin !== undefined) live.baseAtOrigin = spec.baseAtOrigin;
          try { rebuildPrimitive(live); } catch (e) { console.warn('[load] primitive re-assert rebuild failed:', e?.message); }
          notePrimitiveDef(live);
          console.warn(`[load] primitive "${spec.name || spec.id}" — params re-asserted from the saved tree (a historical step-snapshot copy had won the load race)`);
          fixed++;
        }
      }
    }
    (spec.children || []).forEach(walk);
  })(_lastLoadedTreeSpecRoot);
  if (fixed) state.emit('change:treeData', state.get('treeData'));
  return { fixed };
}

/** Restore a node's authoritative HOME base pose from the saved spec onto the
 *  live node (V0.3.2.60). Only the three base arrays; copied by value. */
function _restoreBaseFromSpec(live, specNode) {
  if (!live || !specNode) return;
  if (Array.isArray(specNode.baseLocalPosition)   && specNode.baseLocalPosition.length   === 3) live.baseLocalPosition   = specNode.baseLocalPosition.slice();
  if (Array.isArray(specNode.baseLocalQuaternion) && specNode.baseLocalQuaternion.length === 4) live.baseLocalQuaternion = specNode.baseLocalQuaternion.slice();
  if (Array.isArray(specNode.baseLocalScale)      && specNode.baseLocalScale.length      === 3) live.baseLocalScale      = specNode.baseLocalScale.slice();
}

export function applySpecFieldsToNodes(specNode, nodeById, parentSpec = null) {
  if (!specNode) return;

  // ── Notes — restore as live tree children of the anchor mesh ─────
  // Fresh imports never create note nodes (they live in the saved
  // tree only), so a saved note's id won't resolve in nodeById. The
  // recursion below skips it, but then the note is lost on every
  // load. Detect note specs here and re-attach to the live anchor
  // mesh, preserving every note field verbatim.
  if (specNode.type === 'note') {
    const meshId = specNode.anchorMeshId
                || (parentSpec?.type === 'mesh' ? parentSpec.id : null);
    const meshLive = meshId ? nodeById.get(meshId) : null;
    if (meshLive && meshLive.type === 'mesh') {
      const exists = (meshLive.children || []).some(c => c.id === specNode.id);
      if (!exists) {
        const noteLive = {
          ...specNode,
          missing:  false,
          object3d: null,
          children: [],
        };
        meshLive.children = [...(meshLive.children || []), noteLive];
        nodeById.set(noteLive.id, noteLive);
      }
    }
    return;
  }

  // ── Replace-Model child mesh — create a fresh live node if needed.
  //
  // RM children (B / C / ...) are runtime clones of an origin mesh; their
  // geometry has no asset-import path. The standard load doesn't create
  // a live node for them. We materialise the node here (with object3d=
  // null) so it appears in nodeById. The geometry is re-cloned post-load
  // by actions.rebuildReplaceModelChildren via sourceNodeId.
  if (specNode.type === 'mesh' &&
      specNode.sourceNodeId &&
      parentSpec?.type === 'replaceModel') {
    const parentLive = parentSpec.id ? nodeById.get(parentSpec.id) : null;
    if (parentLive && parentLive.type === 'replaceModel') {
      if (!nodeById.has(specNode.id)) {
        const childLive = {
          ...specNode,
          object3d: null,
          children: [],
        };
        parentLive.children = [...(parentLive.children || []), childLive];
        nodeById.set(childLive.id, childLive);
      }
    }
    return;
  }

  // ── Flat shapes — same story: parented under a mesh / folder / model
  // and never produced by the fresh-asset import path. Re-attach under
  // the parent recorded in the saved spec so save/load round-trips keep
  // the instance in the tree (and thus on screen).
  // The mount lifecycle in steps.js's rebuildFromTreeSpec rebuilds the
  // THREE.Mesh from the templated polygon on the next step activation.
  if (specNode.type === 'flatShape') {
    const parentId  = parentSpec?.id ?? null;
    const parentLive = parentId ? nodeById.get(parentId) : null;
    if (parentLive) {
      const exists = (parentLive.children || []).some(c => c.id === specNode.id);
      if (!exists) {
        const shapeLive = {
          ...specNode,
          object3d: null,                  // rebuilt by ensureFlatShapeObject3D
          children: [],
        };
        parentLive.children = [...(parentLive.children || []), shapeLive];
        nodeById.set(shapeLive.id, shapeLive);
      }
    } else {
      // V0.3.0.95 diag — the shape's saved parent didn't resolve in the live
      // map, so it would be SILENTLY DROPPED here. Surface it so the cause
      // (parent id not remapped / parent outside the walked subtree) is visible.
      console.warn('[load] flatShape NOT reattached — parent missing in live map',
        { id: specNode.id, name: specNode.name, parentId, templateId: specNode.templateId });
    }
    return;
  }

  // V0.3.0.50 — parametric primitives (box/cylinder/sphere/...): procedural, no
  // asset-import path, so the fresh load never creates a live node and the part was
  // silently dropped on reload. Re-attach from the saved spec (primParams /
  // primQuality / primLinkId ride along via the spread); steps.js rebuildFromTreeSpec
  // rebuilds the THREE.Mesh on the next step activation (ensurePrimitiveObject3D).
  if (specNode.type === 'primitive') {
    const parentId  = parentSpec?.id ?? null;
    const parentLive = parentId ? nodeById.get(parentId) : null;
    if (parentLive) {
      const existing = (parentLive.children || []).find(c => c.id === specNode.id);
      if (!existing) {
        const primLive = { ...specNode, object3d: null, children: [] };
        parentLive.children = [...(parentLive.children || []), primLive];
        nodeById.set(primLive.id, primLive);
      } else {
        // V0.3.2.6 — PARAM-PERSISTENCE FIX. If the live node already exists at
        // load (the active step's snapshot.tree rebuilt it FIRST, with the
        // params frozen at that step's capture time), the create-only path
        // silently kept the STALE params — user-edited parameters reverted on
        // every save+reload. The PROJECT tree is the saved truth for primitive
        // definitions: sync kind/params/quality onto the live node and rebuild
        // the mesh if one was already built. (Old primitives predating params-
        // in-step-snapshots never hit this — why the bug looked generational.)
        const before = JSON.stringify([existing.primKind, existing.primParams, existing.primQuality, existing.baseAtOrigin]);
        const after  = JSON.stringify([specNode.primKind, specNode.primParams, specNode.primQuality, specNode.baseAtOrigin]);
        if (before !== after) {
          existing.primKind    = specNode.primKind    ?? existing.primKind;
          existing.primParams  = specNode.primParams ? { ...specNode.primParams } : existing.primParams;
          existing.primQuality = specNode.primQuality ?? existing.primQuality;
          if (specNode.baseAtOrigin !== undefined) existing.baseAtOrigin = specNode.baseAtOrigin;
          try { rebuildPrimitive(existing); } catch (e) { console.warn('[load] primitive rebuild after param-sync failed:', e?.message); }
          console.log(`[load] primitive "${specNode.name}" — params synced from saved project (stale step-snapshot copy overridden)`);
        }
        // BASE POSE RECONCILE (V0.3.2.60) — this early-return branch skipped
        // the base restore in the generic path below, so a primitive rebuilt
        // from a step snapshot (base zeroed) stayed at the wrong home. Restore
        // the authoritative base from the saved project tree.
        _restoreBaseFromSpec(existing, specNode);
      }
    }
    return;
  }

  // V0.2.22.38 — hardware instances: same story as flat shapes. The
  // saved spec lives in the project's scene tree (under whatever folder
  // the user organised them into); ensureHardwareInstanceObject3D builds
  // the THREE.Mesh on the next step activation from the matching template.
  if (specNode.type === 'hardwareInstance') {
    const parentId  = parentSpec?.id ?? null;
    const parentLive = parentId ? nodeById.get(parentId) : null;
    if (parentLive) {
      const exists = (parentLive.children || []).some(c => c.id === specNode.id);
      if (!exists) {
        const live = {
          ...specNode,
          object3d: null,                  // rebuilt lazily
          children: [],
        };
        parentLive.children = [...(parentLive.children || []), live];
        nodeById.set(live.id, live);
      }
    }
    return;
  }

  // V0.2.22.78 — hardware nuts: a child of their bolt (hardwareInstance).
  // Same re-attach story; the THREE.Mesh is rebuilt by steps.js's
  // rebuildFromTreeSpec (ensureHardwareNutObject3D) on the next activation.
  if (specNode.type === 'hardwareNut') {
    const parentId  = parentSpec?.id ?? null;
    const parentLive = parentId ? nodeById.get(parentId) : null;
    if (parentLive) {
      const exists = (parentLive.children || []).some(c => c.id === specNode.id);
      if (!exists) {
        const live = {
          ...specNode,
          object3d: null,                  // rebuilt lazily
          children: [],
        };
        parentLive.children = [...(parentLive.children || []), live];
        nodeById.set(live.id, live);
      }
    }
    return;
  }

  const live = nodeById.get(specNode.id);
  if (live) {
    live.name         = specNode.name        || live.name;
    live.localVisible = specNode.localVisible !== false;
    // Archive flag — legacy projects without this key default to false
    // (not archived). Explicit true survives the round-trip.
    live.archived     = specNode.archived === true;
    // Replace-Model fields (B.2-NEW). Apply only if the spec says this
    // node is an RM; otherwise leave the live values alone so a node
    // that's been converted in-session doesn't get reset on reload.
    if (specNode.type === 'replaceModel') {
      live.type                   = 'replaceModel';
      if (specNode.originalType) live.originalType = specNode.originalType;
      live.originalGeometryHidden = specNode.originalGeometryHidden === true;
    }
    // Folder lock (V0.1.92, replaces isGroup/groupLocked). A folder is
    // locked if the new `locked` flag is set, OR — for legacy projects —
    // it was a group that wasn't explicitly unlocked. This migrates old
    // "Group" folders into locked folders transparently.
    live.locked = specNode.locked === true
      || (specNode.isGroup === true && specNode.groupLocked !== false);
    // RM-child marker: sourceNodeId points to the ORIGIN node the
    // copy was cloned from. Surviving the save means we can re-build
    // the geometry post-load via rebuildReplaceModelChildren.
    if (specNode.sourceNodeId) {
      live.sourceNodeId = specNode.sourceNodeId;
    }
    // Follow-Object relationship (V0.3.0.62). Lives on the follower node; stripNode
    // keeps it on save, but this whitelist patch would otherwise drop it for
    // model/mesh followers. The re-attach branches (hardwareInstance/flatShape/
    // primitive) already keep it via the {...specNode} spread.
    if (specNode.follow) live.follow = specNode.follow;

    if (Array.isArray(specNode.localOffset))          live.localOffset          = specNode.localOffset;
    if (Array.isArray(specNode.localQuaternion))       live.localQuaternion       = specNode.localQuaternion;
    if (Array.isArray(specNode.orientationSteps))      live.orientationSteps      = specNode.orientationSteps;
    if (Array.isArray(specNode.pivotLocalOffset))      live.pivotLocalOffset      = specNode.pivotLocalOffset;
    if (Array.isArray(specNode.pivotLocalQuaternion))  live.pivotLocalQuaternion  = specNode.pivotLocalQuaternion;
    if (specNode.moveEnabled   !== undefined)          live.moveEnabled           = !!specNode.moveEnabled;
    if (specNode.rotateEnabled !== undefined)          live.rotateEnabled         = !!specNode.rotateEnabled;
    if (specNode.pivotEnabled  !== undefined)          live.pivotEnabled          = !!specNode.pivotEnabled;
    // Source transform — restored verbatim. The geometry bake re-runs after
    // load (see sidebar-left's post-load source re-bake) so freshly-imported
    // unbaked geometry picks up the saved source matrix.
    if (Array.isArray(specNode.sourceLocalPosition))   live.sourceLocalPosition   = specNode.sourceLocalPosition;
    if (Array.isArray(specNode.sourceLocalQuaternion)) live.sourceLocalQuaternion = specNode.sourceLocalQuaternion;
    if (Array.isArray(specNode.sourceLocalScale))      live.sourceLocalScale      = specNode.sourceLocalScale;
    // BASE POSE RECONCILE (V0.3.2.60) — the keystone fix for "primitives/shapes
    // snap to reset on load" and the "nut correction applied twice" bug. A
    // node's home pose (baseLocalPosition/Quaternion/Scale) is the AUTHORITATIVE
    // placement for PROCEDURAL objects (flat shapes bake their point into base;
    // bolt-nuts sit at [0,-L,0]; global-edit writes base on any of these). It
    // is saved in the project tree (stripNode keeps it) but this "existing
    // node" branch never restored it — so a procedural node already live with a
    // stale/zeroed base kept the wrong home, the next save baked it in, and no
    // load healed it. Restore it here from the authoritative spec.
    //   GATED to procedural types: mesh/model base is re-derived from geometry
    //   on import (storeBaseTransformFromObject3D) — leave that path alone.
    if (PROCEDURAL_BASE_TYPES.has(specNode.type)) _restoreBaseFromSpec(live, specNode);
    live.colorPresetId = specNode.colorPresetId || null;
  }
  (specNode.children || []).forEach(sc => applySpecFieldsToNodes(sc, nodeById, specNode));
}


// ═══════════════════════════════════════════════════════════════════════════
//  MAIN LOAD ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load a project from a File object or raw JSON text.
 *
 * WHAT THIS DOES:
 *   1. Parses + migrates the project JSON.
 *   2. Applies non-geometry state (steps, settings, colors …) to app state.
 *   3. Returns the project data + a resolved-asset list for the caller to
 *      use when loading geometry.
 *
 * WHAT THE CALLER (main.js) MUST DO AFTER:
 *   For each asset in `result.assets`:
 *     a) Read the file from `resolvedPath`
 *     b) Call importers.loadModelBuffer(buffer, name, assetEntry)
 *     c) After load, call buildIdRemapFromSpec + applyIdRemap + applySpecFieldsToNodes
 *        using `assetEntry._legacyTreeSpec` (legacy) or the saved tree.root (new format)
 *     d) Rebuild state.nodeById
 *
 * @param {File|string} fileOrText
 * @param {string}      [filePath]  absolute path (Electron) for relative-path resolution
 * @returns {Promise<{project:object, assets:Array<{assetEntry:object, resolvedPath:string|null}>}>}
 */
export async function loadProject(fileOrText, filePath = null) {
  // A File/Blob may be gzipped (new) or plain JSON (legacy) — read its bytes and
  // auto-detect. A raw string is already decoded text. Projects whose JSON
  // exceeds ~400MB take the STREAMING parser (V0.3.2.19) — beyond ~512MB a
  // single JS string is impossible, so the old decode-then-JSON.parse path
  // simply cannot open large files.
  let project;
  if (typeof fileOrText === 'string') {
    project = parseProjectFile(fileOrText);
  } else {
    const fileBytes = new Uint8Array(await fileOrText.arrayBuffer());
    const raw = _isGzipBytes(fileBytes) ? await _gunzipToBytes(fileBytes) : fileBytes;
    if (raw.length > 400_000_000) {
      console.log(`[load] large project (${(raw.length / 1e6).toFixed(0)} MB JSON) — streaming parse`);
      project = _migrateParsedProject(_parseProjectBytesStreaming(raw));
    } else {
      project = parseProjectFile(new TextDecoder().decode(raw));
    }
  }

  clearIsolate();   // isolate is runtime-only — a freshly-loaded project starts un-isolated
  applyProjectToState(project);

  // V0.3.0.151 — migrate existing per-step cable data into the cascade model
  // (arrangement only on state-defining steps). In-memory; the file is untouched
  // until the user saves. Guarded so a migration hiccup never blocks the load.
  try {
    const removed = flattenCablesToCascade();
    if (removed) console.log(`[cables] flattened ${removed} redundant per-step entr${removed === 1 ? 'y' : 'ies'} → cascade (state-defining steps only). Save to persist.`);
    // V0.3.0.167 — give every socketed-but-never-stated cable its State-0 unplugged baseline.
    const seeded = ensureSocketBaselines();
    if (seeded) console.log(`[cables] registered State-0 unplugged baseline for ${seeded} socketed cable(s). Save to persist.`);
  } catch (e) { console.warn('[cables] cascade flatten skipped:', e); }

  if (filePath) _setProjectMeta(filePath);

  // Build resolved-asset list for caller
  const assets = (project.assets?.items || []).map(assetEntry => ({
    assetEntry,
    resolvedPath: resolveAssetPath(assetEntry, filePath),
  }));

  // Emit so the app can show "loading models…" UI
  state.emit('project:loaded', { project, assets });

  return { project, assets };
}


// ═══════════════════════════════════════════════════════════════════════════
//  ASSET PATH RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve an asset's file path to an absolute path.
 *
 * Resolution order:
 *   1. relativePath relative to the project file's directory
 *   2. originalPath (absolute, may have moved)
 *
 * @param {object}      asset
 * @param {string|null} projectFilePath
 * @returns {string|null}
 */
export function resolveAssetPath(asset, projectFilePath = null) {
  if (!projectFilePath) return asset.originalPath || null;

  // Directory containing the .sbsproj file
  const projectDir = projectFilePath.replace(/[\\/][^\\/]*$/, '');

  if (asset.relativePath) {
    const rel = asset.relativePath.replace(/\\/g, '/');
    // Simple join — keep the platform separator the OS prefers
    const sep = projectFilePath.includes('\\') ? '\\' : '/';
    return projectDir + sep + rel.replace(/\//g, sep);
  }

  return asset.originalPath || null;
}

/**
 * Compute the relative path of `assetPath` from `projectFilePath`'s directory.
 *
 * @param {string} assetPath       absolute path to the asset
 * @param {string} projectFilePath absolute path to the .sbsproj file
 * @returns {string}  relative path using forward slashes
 */
export function makeRelativePath(assetPath, projectFilePath) {
  if (!assetPath || !projectFilePath) return assetPath || '';

  const normalize = p => p.replace(/\\/g, '/').replace(/\/+/g, '/');
  const projDir   = normalize(projectFilePath).replace(/\/[^/]*$/, '');
  const asset     = normalize(assetPath);

  // Find common prefix
  const projParts  = projDir.split('/');
  const assetParts = asset.split('/');
  let common = 0;
  while (common < projParts.length && common < assetParts.length
         && projParts[common].toLowerCase() === assetParts[common].toLowerCase()) {
    common++;
  }

  const ups  = projParts.length - common;
  const down = assetParts.slice(common);
  return [...Array(ups).fill('..'), ...down].join('/') || '.';
}


// ═══════════════════════════════════════════════════════════════════════════
//  SUGGESTED FILENAME
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a suggested save filename from current state.
 *
 * @returns {string}  e.g. 'motor_assembly.sbsproj'
 */
export function getSuggestedFilename() {
  const name = state.get('projectName');
  if (name && name !== 'Untitled') {
    return name.endsWith('.sbsproj') ? name : `${name.replace(/\.sbsproj$/i, '')}.sbsproj`;
  }
  const assets = state.get('assets') || [];
  if (assets.length > 0) {
    const base = (assets[0].name || 'project')
      .replace(/\.(step|stp|iges|igs|brep|obj|stl|gltf|glb|fbx)$/i, '');
    return `${base}.sbsproj`;
  }
  return 'project.sbsproj';
}


// ═══════════════════════════════════════════════════════════════════════════
//  SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export const project = {
  serialize,
  saveProject,
  loadProject,
  pickProjectFile,
  parseProjectFile,
  applyProjectToState,
  buildIdRemapFromSpec,
  collectAllMeshSpecs,
  buildDisplacedMeshIdRemap,
  applyIdRemap,
  applySpecFieldsToNodes,
  resolveAssetPath,
  makeRelativePath,
  getSuggestedFilename,
};

export default project;
