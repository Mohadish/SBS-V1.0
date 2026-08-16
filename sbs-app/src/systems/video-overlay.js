/**
 * 🎬 Video overlay — Phase 1 (V0.3.2.75)
 *
 * A video clip placed on the overlay layer of a step, played back live in
 * the app, trimmed to an in/out window, with its own audio mutable so it
 * doesn't fight the voice-over.
 *
 * THE ONE ARCHITECTURAL RULE: the video file is NEVER inlined.
 * Overlay images are stored as base64 data URLs inside the project file,
 * which is already the memory baseline that put the renderer near its
 * ~3.5GB heap ceiling — and a 50MB clip becomes a ~67MB string, which also
 * threatens V8's ~512MB max-string on save. So a video node stores only:
 *   • a PATH on disk (project-relative when possible, for portability),
 *   • a small POSTER frame (one JPEG, inline) so the node shows something
 *     before the file loads or when the file is missing,
 *   • the trim window + mute flag.
 * Consequence the user must know: the project is no longer a single
 * portable file — the same trade the narration audio cache already makes.
 *
 * PLAYBACK MODEL (Phase 1 = live only)
 * Redraw is driven by sceneCore.addTickHook, exactly like the image-sequence
 * flipbooks: the hook receives the SYNTHETIC clock during export and the wall
 * clock live, so the same code path can later serve a deterministic export
 * (Phase 2 = seek-per-frame). Today we let the <video> element play itself
 * and simply repaint the Konva layer each tick.
 *
 * FREEZE-FRAME PADDING (the user's design note, honoured here)
 * The overlay animation's fade-in / fade-out slots must NOT eat the clip.
 * A video holds its FIRST frame while the overlay fades in, plays the
 * trimmed window at full opacity, then holds its LAST frame while the
 * overlay fades out. In Phase 1 that falls out naturally: we clamp
 * currentTime to [in,out] and pause at the ends rather than looping or
 * running past, so the node shows a still frame during the fades.
 *
 * NOT in Phase 1: export rendering, video length driving step duration,
 * video audio in the exported mix. Those are Phases 2-4.
 */

import { state }     from '../core/state.js';
import { sceneCore } from '../core/scene.js';

// Live playback registry: nodeId → { node, video, path }
const _players = new Map();
let _tickWired = false;

/** Extensions Chromium can actually decode. Anything else needs a transcode. */
export const PLAYABLE_VIDEO_EXT = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov'];

/** True for a Konva node that is one of our video nodes. */
export function isVideoNode(node) {
  return !!(node && node.getAttr && node.getAttr('isVideo'));
}

// ─── Path handling (project-relative when possible) ─────────────────────────

function _projectDir() {
  const p = state.get('projectPath');
  if (!p) return null;
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : null;
}

function _norm(p) { return String(p || '').replace(/\\/g, '/'); }

/**
 * Store a path relative to the project folder when the file lives inside it
 * (so moving the project folder keeps the link), else absolute.
 * Returns { abs, rel } — rel is '' when the file is outside the project dir.
 */
export function describeVideoPath(absPath) {
  const abs = _norm(absPath);
  const dir = _norm(_projectDir() || '');
  if (dir && abs.toLowerCase().startsWith(dir.toLowerCase() + '/')) {
    return { abs, rel: abs.slice(dir.length + 1) };
  }
  return { abs, rel: '' };
}

/** Resolve a node's stored path back to something loadable. */
export function resolveVideoPath(node) {
  const rel = node?.getAttr?.('videoRel');
  const dir = _projectDir();
  if (rel && dir) return _norm(dir) + '/' + _norm(rel);
  return _norm(node?.getAttr?.('videoPath') || '');
}

/** file:// URL for a Windows or POSIX absolute path. */
export function fileUrlFor(absPath) {
  const p = _norm(absPath);
  if (!p) return '';
  if (/^[a-zA-Z]:\//.test(p)) return 'file:///' + encodeURI(p);
  return 'file://' + encodeURI(p);
}

// ─── Element lifecycle ──────────────────────────────────────────────────────

/**
 * Create (or reuse) the <video> element backing a node and bind it to the
 * Konva.Image. Resolves once the first frame is decodable, so the node never
 * draws a 0×0 image.
 */
export async function attachVideoElement(node) {
  if (!isVideoNode(node)) return null;
  const id = node.getAttr('videoId') || node._id;
  const existing = _players.get(id);
  const path = resolveVideoPath(node);
  if (existing && existing.path === path) return existing.video;
  if (existing) detachVideo(node);
  if (!path) return null;

  const video = document.createElement('video');
  video.src         = fileUrlFor(path);
  video.muted       = node.getAttr('muted') !== false;   // default muted — voice-over wins
  video.volume      = Number(node.getAttr('volume') ?? 1);
  video.playsInline = true;
  video.preload     = 'auto';
  video.loop        = false;
  // Never let the element drive layout; it lives off-DOM and is only a
  // pixel source for Konva.
  video.style.display = 'none';

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => { if (!settled) { settled = true; resolve(video); } };
    const bad = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`Cannot decode this video (${path.split(/[\\/]/).pop()}). Chromium plays H.264 / VP9 / AV1 — ProRes and HEVC need converting first.`));
    };
    video.addEventListener('loadeddata', ok,  { once: true });
    video.addEventListener('error',      bad, { once: true });
    setTimeout(() => { if (!settled) bad(); }, 15000);
  });

  try { await ready; } catch (e) { video.src = ''; throw e; }

  // Natural size — used for fit-on-insert and the Reset action.
  if (video.videoWidth)  node.setAttr('naturalW', video.videoWidth);
  if (video.videoHeight) node.setAttr('naturalH', video.videoHeight);
  if (Number.isFinite(video.duration) && video.duration > 0) {
    node.setAttr('videoDurationMs', Math.round(video.duration * 1000));
  }

  // Seek to the trim start so the node shows the right first frame at rest.
  const inMs = _trimIn(node);
  try { video.currentTime = inMs / 1000; } catch { /* pre-metadata seek */ }

  node.image(video);
  _players.set(id, { node, video, path });
  _wireTick();
  return video;
}

/** Stop + release a node's element. Safe to call twice. */
export function detachVideo(node) {
  const id = node?.getAttr?.('videoId') || node?._id;
  const p = id != null ? _players.get(id) : null;
  if (!p) return;
  try { p.video.pause(); } catch { /* already gone */ }
  p.video.removeAttribute('src');
  try { p.video.load(); } catch { /* best-effort release */ }
  _players.delete(id);
  // Leave node.image() alone — a destroyed Konva node doesn't care, and a
  // live one keeps showing its last frame until re-attached.
}

/** Release everything (step change / project close). */
export function detachAll() {
  for (const { node } of [..._players.values()]) detachVideo(node);
  _players.clear();
}

// ─── Trim window ────────────────────────────────────────────────────────────

function _trimIn(node)  { return Math.max(0, Number(node.getAttr('trimInMs') ?? 0)); }
function _trimOut(node) {
  const dur = Number(node.getAttr('videoDurationMs') ?? 0);
  const out = Number(node.getAttr('trimOutMs') ?? 0);
  if (out > 0) return dur > 0 ? Math.min(out, dur) : out;
  return dur;
}

/** Trimmed window length in ms — what Phase 3 will feed into step duration. */
export function trimmedDurationMs(node) {
  return Math.max(0, _trimOut(node) - _trimIn(node));
}

/** Apply a trim/mute patch to a node and re-sync the live element. */
export function setVideoOptions(node, patch = {}) {
  if (!isVideoNode(node)) return;
  if (patch.trimInMs  !== undefined) node.setAttr('trimInMs',  Math.max(0, Math.round(patch.trimInMs)));
  if (patch.trimOutMs !== undefined) node.setAttr('trimOutMs', Math.max(0, Math.round(patch.trimOutMs)));
  if (patch.muted     !== undefined) node.setAttr('muted', !!patch.muted);
  if (patch.volume    !== undefined) node.setAttr('volume', Math.max(0, Math.min(1, Number(patch.volume))));

  // Keep in <= out with at least one frame of window.
  const dur = Number(node.getAttr('videoDurationMs') ?? 0);
  let a = _trimIn(node), b = _trimOut(node);
  if (dur > 0) { a = Math.min(a, Math.max(0, dur - 40)); b = Math.min(b, dur); }
  if (b - a < 40) b = Math.min(dur || a + 40, a + 40);
  node.setAttr('trimInMs', a);
  node.setAttr('trimOutMs', b);

  const p = _players.get(node.getAttr('videoId') || node._id);
  if (p) {
    p.video.muted  = node.getAttr('muted') !== false;
    p.video.volume = Number(node.getAttr('volume') ?? 1);
    const t = p.video.currentTime * 1000;
    if (t < a || t > b) { try { p.video.currentTime = a / 1000; } catch { /* ignore */ } }
  }
}

// ─── Playback control ───────────────────────────────────────────────────────

/**
 * Start every video on the layer from its trim-in point. Called when a step
 * becomes active. Videos are paused-and-parked otherwise, so a step that
 * isn't on screen never decodes.
 */
export async function startVideos(nodes) {
  for (const node of nodes || []) {
    if (!isVideoNode(node)) continue;
    let v = null;
    try { v = await attachVideoElement(node); } catch { continue; }
    if (!v) continue;
    try {
      v.currentTime = _trimIn(node) / 1000;
      // play() rejects when the tab has no user gesture; muted playback is
      // always allowed, which is our default.
      await v.play().catch(() => {});
    } catch { /* leave parked on the first frame */ }
  }
}

/** Pause everything and park each clip on its trim-in frame. */
export function stopVideos() {
  for (const { node, video } of _players.values()) {
    try { video.pause(); video.currentTime = _trimIn(node) / 1000; } catch { /* ignore */ }
  }
}

// ─── Tick driver ────────────────────────────────────────────────────────────

function _wireTick() {
  if (_tickWired) return;
  _tickWired = true;
  sceneCore.addTickHook(_advanceVideos);
}

/**
 * Repaint the layer while any clip is playing, and enforce the trim window.
 *
 * The clamp is what produces the freeze-frame behaviour the fades need: at
 * the OUT point we pause on the last frame instead of looping or running on,
 * so the overlay's fade-out plays over a still image. Same at the start.
 */
function _advanceVideos(/* nowMs */) {
  if (!_players.size) return;
  let draw = false;
  for (const [id, p] of [..._players.entries()]) {
    const { node, video } = p;
    if (node?.isDestroyed?.()) { detachVideo(node); _players.delete(id); continue; }
    if (video.readyState < 2) continue;              // nothing decodable yet
    const tMs   = video.currentTime * 1000;
    const outMs = _trimOut(node);
    const inMs  = _trimIn(node);
    if (outMs > 0 && tMs >= outMs) {
      if (!video.paused) { try { video.pause(); } catch { /* ignore */ } }
      // Hold exactly on the last frame of the window.
      if (tMs > outMs + 5) { try { video.currentTime = outMs / 1000; } catch { /* ignore */ } }
      draw = true;
      continue;
    }
    if (tMs < inMs - 5) { try { video.currentTime = inMs / 1000; } catch { /* ignore */ } }
    if (!video.paused) draw = true;
  }
  if (draw) node_layerBatchDraw();
}

function node_layerBatchDraw() {
  for (const { node } of _players.values()) {
    const layer = node?.getLayer?.();
    if (layer) { layer.batchDraw(); return; }        // one draw covers the whole layer
  }
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/** window.sbsDiag.videos() — what's loaded, playing, trimmed to what. */
export function diagVideos() {
  const rows = [];
  for (const { node, video, path } of _players.values()) {
    rows.push({
      name: (path.split(/[\\/]/).pop()) || '(none)',
      playing: !video.paused,
      muted: video.muted,
      atMs: Math.round(video.currentTime * 1000),
      inMs: _trimIn(node),
      outMs: _trimOut(node),
      durMs: Number(node.getAttr('videoDurationMs') ?? 0),
      readyState: video.readyState,
      missing: video.error ? 'ERROR' : '',
    });
  }
  console.table(rows);
  return rows;
}
