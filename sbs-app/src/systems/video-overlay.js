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

import { state } from '../core/state.js';
import * as clock from '../core/clock.js';   // synthetic during export, wall live — anchors playback
// NOTE: core/scene.js is imported LAZILY (inside _wireTick) — it drags the
// whole Three.js module graph with it, which would make this module's pure
// helpers (stepVideoWindowMs, trim math) untestable outside the app.

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

// ─── Transcode-on-demand (V0.3.2.91) ────────────────────────────────────────
//
// Chromium decodes H.264/VP9/AV1 — not HEVC or ProRes. Editors export HEVC
// .mp4 by default these days, and the failure is maximally confusing: the
// AAC audio decodes fine while the picture silently falls back to the
// poster. We ship ffmpeg, so convert instead of erroring: the transcoded
// copy lands NEXT TO the source as <name>.sbs-h264.mp4 and is reused on
// every later load (re-transcoded only if the source is newer).

const _transcoding = new Map();   // abs -> Promise<string|null> (dedupe concurrent requests)

export async function transcodeToPlayable(absPath, onStatus) {
  const out = absPath.replace(/\.[^.\\/]+$/, '') + '.sbs-h264.mp4';
  if (_transcoding.has(absPath)) return _transcoding.get(absPath);
  const job = (async () => {
    try {
      const [src, dst] = await Promise.all([
        window.sbsNative.statFile?.(absPath), window.sbsNative.statFile?.(out),
      ]);
      if (dst && (!src || dst.mtimeMs >= src.mtimeMs)) return out;   // fresh cached conversion
      onStatus?.(`Converting video to H.264 (one-time): ${absPath.split(/[\\/]/).pop()}…`);
      const r = await window.sbsNative.ffmpeg([
        '-y', '-i', absPath,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        out,
      ]);
      if (!r?.ok) throw new Error(r?.stderrTail?.slice(-200) || 'ffmpeg failed');
      return out;
    } catch (e) {
      console.warn('[video] transcode failed:', e?.message);
      return null;
    } finally { _transcoding.delete(absPath); }
  })();
  _transcoding.set(absPath, job);
  return job;
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
  if (existing && existing.path === path) {
    // Same clip, NEW Konva node (step revisit recreates nodes): rebind the
    // element to the fresh node — the old binding pointed at a destroyed
    // node, which left the new one on its poster and orphaned the audio.
    existing.node = node;
    node.image(existing.video);
    return existing.video;
  }
  if (existing) detachVideo(existing.node || node);
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

  // Register in the pool BEFORE awaiting readiness (V0.3.2.83). A 13-minute
  // file can take seconds to open; if the user left the step mid-load, the
  // element used to be invisible to detachAll — an ORPHAN that finished
  // loading later and played its audio forever. In the pool from birth,
  // every cleanup path can reach it.
  _players.set(id, { node, video, path });

  // 🔊 Element-level trim clamp (V0.3.2.83): the tick-driven clamp only
  // runs while the render loop draws — but AUDIO plays straight from the
  // element, canvas or no canvas. 'timeupdate' fires from the media stack
  // itself (~4Hz), so the clip can never sound past its OUT point even if
  // no frame is being drawn anywhere.
  video.addEventListener('timeupdate', () => {
    const entry = _players.get(id);
    const n = entry?.node;
    if (!n || n.isDestroyed?.()) { try { video.pause(); } catch { /* gone */ } return; }
    const outMs = _trimOut(n);
    if (outMs > 0 && video.currentTime * 1000 >= outMs && !video.paused && !_isExporting()) {
      try { video.pause(); video.currentTime = outMs / 1000; } catch { /* ignore */ }
    }
  });

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

  try { await ready; }
  catch (e) {
    _players.delete(id);
    video.src = '';
    // 🎞 AUTO-TRANSCODE (V0.3.2.91). An undecodable video track (HEVC is the
    // common case — its AAC audio decodes, so it half-works confusingly)
    // gets one shot at conversion via the bundled ffmpeg, then the node is
    // re-pointed at the H.264 copy and the attach retried once.
    if (!/\.sbs-h264\.mp4$/i.test(path)) {
      const { setStatus } = await import('../ui/status.js').catch(() => ({ setStatus: null }));
      const converted = await transcodeToPlayable(path, (m) => setStatus?.(m, 'info', 0));
      if (converted && !node.isDestroyed?.()) {
        const { abs, rel } = describeVideoPath(converted);
        node.setAttr('videoPath', abs);
        node.setAttr('videoRel',  rel);
        setStatus?.('Video converted to H.264 — loading…', 'success', 5000);
        import('./overlay.js').then(m => m.scheduleSave?.()).catch(() => {});
        return attachVideoElement(node);
      }
    }
    throw e;
  }
  // The step may have changed while the file was opening — a slow load must
  // never end with an invisible element playing audio into the wrong step.
  if (node.isDestroyed?.()) { detachVideo(node); throw new Error('step changed while the video was loading'); }

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
  _players.set(id, { node, video, path });   // refresh (registered pre-ready; node may be newer)
  _wireTick();
  _wireStepGuard();
  return video;
}

// ─── 🔇 Step-change safety net (V0.3.2.83) ──────────────────────────────────
// Overlay content can be torn down by MORE than one path (normal reload,
// the H2 fade pre-load which SKIPS the reload, edit-mode rebuilds). Rather
// than trusting every path to release players, react to the step change
// itself: the moment the active step moves, SILENCE everything; a beat
// later, drop any player whose node is gone. startVideos() then restarts
// whatever the incoming step legitimately owns. This is what ends the
// "revisit stacks another audio track" acapella.
let _stepGuardWired = false;
function _wireStepGuard() {
  if (_stepGuardWired) return;
  _stepGuardWired = true;
  state.on?.('change:activeStepId', () => {
    for (const p of _players.values()) {
      // 🎬 V0.3.2.84 — FREEZE the last shown frame onto a canvas before
      // anything else. The outgoing overlay fades on the ghost layer; with
      // the node still bound to the <video> element, releasing the element
      // snapped the clip to black mid-fade (the reported "clips off
      // sharply"). A canvas copy fades out like any image, and the element
      // can then be silenced/released with zero visual consequence.
      try {
        const { node, video } = p;
        if (node && !node.isDestroyed?.() && video.readyState >= 2 && video.videoWidth) {
          const c = document.createElement('canvas');
          c.width = video.videoWidth; c.height = video.videoHeight;
          c.getContext('2d').drawImage(video, 0, 0);
          node.image(c);
          node.getLayer()?.batchDraw();
        }
      } catch { /* freeze is cosmetic — never block the silence below */ }
      try { p.video.pause(); } catch { /* gone */ }
    }
    setTimeout(() => {
      for (const [id, p] of [..._players.entries()]) {
        if (!p.node || p.node.isDestroyed?.()) { detachVideo(p.node); _players.delete(id); }
      }
    }, 50);
  });
}

/** Stop + release a node's element. Safe to call twice. */
export function detachVideo(node) {
  const id = node?.getAttr?.('videoId') || node?._id;
  const p = id != null ? _players.get(id) : null;
  if (!p) return;
  // 🧊 FREEZE BEFORE RELEASE (V0.3.2.87). Releasing an element blanks it
  // instantly — and if the node is mid-fade on the ghost layer, that reads
  // as the clip vanishing at the fade threshold. The step-change event
  // already freezes, but the export's activation order can reach THIS
  // release first — so the freeze lives here too, making it ordering-proof:
  // no path can blank a still-visible node.
  try {
    const { node: n, video: v } = p;
    const eligible = n && !n.isDestroyed?.() && n.image() === v && v.readyState >= 2 && v.videoWidth;
    if (window.sbsDiag?.videoExportTrace) {
      console.log(`[vtrace] detachVideo: freeze=${eligible ? 'YES' : 'no'} destroyed=${!!n?.isDestroyed?.()} imageIsElement=${n?.image?.() === v} rs=${v?.readyState} t=${v?.currentTime?.toFixed?.(2)}`);
    }
    if (eligible) {
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      n.image(c);
      n.getLayer()?.batchDraw();
    }
  } catch (e) { if (window.sbsDiag?.videoExportTrace) console.log('[vtrace] detach freeze THREW:', e?.message); }
  try { p.video.pause(); } catch { /* already gone */ }
  p.video.removeAttribute('src');
  try { p.video.load(); } catch { /* best-effort release */ }
  _players.delete(id);
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

/**
 * Re-capture the node's poster AT ITS TRIM-IN FRAME (V0.3.2.85). The poster
 * used to be grabbed at second 0 of the source at insert time — trim to
 * 20s→25s and every fade-in seeded from a frame the clip never shows (the
 * export's frame-exact capture made it visible; live replaced it too fast
 * to notice). Seek → wait for the decoder → capture → restore position.
 */
export async function refreshPoster(node) {
  const p = _players.get(node?.getAttr?.('videoId') || node?._id);
  if (!p || p.video.readyState < 2 || !p.video.videoWidth) return false;
  const { video } = p;
  const inMs = _trimIn(node);
  const prev = video.currentTime;
  const seekTo = (t) => new Promise((res) => {
    if (Math.abs(video.currentTime - t) < 0.01) return res();
    const ok = () => res();
    video.addEventListener('seeked', ok, { once: true });
    setTimeout(ok, 400);
    try { video.currentTime = t; } catch { res(); }
  });
  try {
    await seekTo(inMs / 1000);
    const scale = Math.min(1, 480 / video.videoWidth);
    const c = document.createElement('canvas');
    c.width  = Math.max(1, Math.round(video.videoWidth * scale));
    c.height = Math.max(1, Math.round(video.videoHeight * scale));
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    node.setAttr('posterSrc', c.toDataURL('image/jpeg', 0.7));
    await seekTo(prev);
    return true;
  } catch { return false; }
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

// ─── Step duration contribution (V0.3.2.82) ─────────────────────────────────
//
// "Longest feature wins": a step hosting a video must last at least the
// video's trimmed window, exactly like it must last at least its narration.
// Unlike narration, a video NEVER overflows into the next step — it freezes
// on its last frame (the trim clamp) and the step is stretched to fit it.
// Consumed by BOTH duration paths (narration-timeline estimate + the
// exporter's perStepHold) so the TOC and the encoded video can't drift.

const _winMemo = new Map();   // stepId -> { ref: overlayString, ms }

/**
 * The longest trimmed video window on a step's overlay, in ms (0 = none).
 * Parses the overlay string once per unique string (memoized by reference).
 */
export function stepVideoWindowMs(step) {
  const ov = step?.overlay;
  if (typeof ov !== 'string' || !ov || ov.indexOf('"isVideo":true') === -1) return 0;
  const memo = _winMemo.get(step.id);
  if (memo && memo.ref === ov) return memo.ms;
  let ms = 0;
  try {
    const spec = JSON.parse(ov);
    (function walk(n) {
      if (!n) return;
      const a = n.attrs;
      if (a?.isVideo) {
        const dur = Number(a.videoDurationMs ?? 0);
        const inMs  = Math.max(0, Number(a.trimInMs ?? 0));
        let outMs = Number(a.trimOutMs ?? 0) || dur;
        if (dur > 0) outMs = Math.min(outMs, dur);
        ms = Math.max(ms, Math.max(0, outMs - inMs));
      }
      (n.children || []).forEach(walk);
    })(spec);
  } catch { /* unparseable overlay → contributes nothing */ }
  _winMemo.set(step.id, { ref: ov, ms });
  return ms;
}

// ─── Export mode (V0.3.2.82 — Phase 2: deterministic seek-per-frame) ────────
//
// The exporter runs a SYNTHETIC clock, frame by frame; a <video> playing at
// wall-clock speed lands random frames in the capture — the "blinking".
// In export mode clips never .play(): every encoded frame SEEKS the element
// to an exact timestamp derived from the synthetic clock and awaits the
// decoder before capture. Deterministic → cache-safe. The trim clamp gives
// the freeze-frame ends for free (fade-in/out play over a still frame).

function _isExporting() { try { return !!state.get('_exporting'); } catch { return false; } }

export function hasActiveVideos() { return _players.size > 0; }

/**
 * Seek every live clip to the synthetic clock and resolve when their frames
 * are decoded. `synthMs` anchors each player on first sight — a clip plays
 * its window [trimIn..trimOut] from the moment its step's overlay loaded,
 * frozen at both ends by the clamp.
 */
export async function seekAllToClock(synthMs) {
  if (!_players.size) return;
  const waits = [];
  for (const p of _players.values()) {
    const { node, video } = p;
    if (node?.isDestroyed?.() || video.readyState < 1) continue;
    // V0.3.2.84 — no anchor yet means playback hasn't been TRIGGERED
    // (beginPlayback fires when the overlay fade-in completes): hold the
    // frozen first frame. The fade lands on a still, exactly per spec.
    const inMs  = _trimIn(node);
    const outMs = _trimOut(node) || Number(node.getAttr('videoDurationMs') ?? 0);
    const target = (p.anchorMs == null)
      ? inMs / 1000
      : Math.min(Math.max(inMs + (synthMs - p.anchorMs), inMs), outMs) / 1000;
    if (Math.abs(video.currentTime - target) < 0.012) continue;   // within ~1/4 frame — keep
    waits.push(new Promise((resolve) => {
      let done = false;
      const ok = () => { if (!done) { done = true; video.removeEventListener('seeked', ok); resolve(); } };
      video.addEventListener('seeked', ok, { once: true });
      // A dead decoder must never stall the export — cap the wait; the
      // capture then reuses the previous decoded frame (visually a held
      // frame, never a blink).
      setTimeout(ok, 250);
      try { video.currentTime = target; } catch { ok(); }
    }));
  }
  if (waits.length) await Promise.all(waits);
}

/**
 * 🧊 Park every live clip on its TRIM-OUT frame (V0.3.2.88). Used when a
 * step is staged as a segment's zero-hold LEAD: the clip finished during
 * its own segment, so the crossfade out of it must show the LAST frame of
 * the selected window. The far-past anchor makes every later synthetic
 * seek clamp to trim-out.
 */
export async function parkAtEnd() {
  if (window.sbsDiag?.videoExportTrace) {
    console.log(`[vtrace] parkAtEnd: ${_players.size} player(s)`);
  }
  for (const p of _players.values()) {
    const { node, video } = p;
    if (!node || node.isDestroyed?.() || video.readyState < 1) continue;
    const outMs = _trimOut(node) || Number(node.getAttr('videoDurationMs') ?? 0);
    p.anchorMs = -1e12;
    await new Promise((res) => {
      if (Math.abs(video.currentTime * 1000 - outMs) < 12) return res();
      const ok = () => res();
      video.addEventListener('seeked', ok, { once: true });
      setTimeout(ok, 400);
      try { video.currentTime = outMs / 1000; } catch { ok(); }
    });
  }
}

/**
 * 🔊 The video clips on a step's overlay, as data (V0.3.2.88) — feeds the
 * export audio mix. Returns [{ abs, inMs, outMs, muted, volume }].
 */
export function stepVideoClips(step) {
  const ov = step?.overlay;
  if (typeof ov !== 'string' || !ov || ov.indexOf('"isVideo":true') === -1) return [];
  const out = [];
  try {
    const dir = _projectDir();
    (function walk(n) {
      if (!n) return;
      const a = n.attrs;
      if (a?.isVideo) {
        const abs = (a.videoRel && dir) ? _norm(dir) + '/' + _norm(a.videoRel) : _norm(a.videoPath || '');
        const dur = Number(a.videoDurationMs ?? 0);
        const inMs  = Math.max(0, Number(a.trimInMs ?? 0));
        let outMs = Number(a.trimOutMs ?? 0) || dur;
        if (dur > 0) outMs = Math.min(outMs, dur);
        if (abs && outMs > inMs) {
          out.push({ abs, inMs, outMs, muted: a.muted !== false, volume: Math.max(0, Math.min(1, Number(a.volume ?? 1))) });
        }
      }
      (n.children || []).forEach(walk);
    })(JSON.parse(ov));
  } catch { /* unparseable overlay → no clips */ }
  return out;
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
    // The await above can outlive the step (rapid navigation) — never start
    // audio for a node that no longer exists.
    if (node.isDestroyed?.()) { detachVideo(node); continue; }
    const p = _players.get(node.getAttr('videoId') || node._id);
    if (p) p.anchorMs = null;                      // parked until beginPlayback() triggers
    // V0.3.2.84 — clips no longer auto-play at overlay load. They PARK on
    // their trim-in frame; the overlay fade-in plays over that still, and
    // beginPlayback() (fired when the fade completes — or immediately when
    // the step's animation has no overlay slot) starts them. Live and
    // export share the trigger; export additionally drives time via
    // seekAllToClock instead of play().
    try { v.currentTime = _trimIn(node) / 1000; } catch { /* pre-metadata */ }
  }
}

/**
 * 🎬 Start playback for every parked clip (V0.3.2.84). Called by the phase
 * engine when the overlay fade-in COMPLETES — the fade lands on the frozen
 * first frame, then motion starts. Anchors export seeking to the synthetic
 * clock at this exact moment; plays the elements live.
 */
export function beginPlayback() {
  const nowMs = clock.now();
  for (const p of _players.values()) {
    const { node, video } = p;
    if (!node || node.isDestroyed?.()) continue;
    if (p.anchorMs != null) continue;              // already running
    p.anchorMs = nowMs;
    if (!_isExporting()) {
      try { video.play().catch(() => {}); } catch { /* parked */ }
    }
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
  import('../core/scene.js')
    .then(m => m.sceneCore.addTickHook(_advanceVideos))
    .catch(e => { _tickWired = false; console.warn('[video] tick hook not wired:', e?.message); });
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
  if (_isExporting()) return;   // export: seekAllToClock() owns time — wall-clock logic would fight it
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
