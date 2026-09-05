/**
 * SBS — Step render cache (V0.3.2.x): SEGMENT PLANNER.
 *
 * Divides the playable timeline into render segments and computes a
 * CONTENT-ADDRESSED cache key per segment. The key IS the invalidation:
 * any change that affects a segment's pixels changes its key, so a cached
 * file either matches exactly or is never used — no dirty-flag wiring.
 *
 * Segment = one step, except STEP-GROUPS which collapse to ONE segment
 * (user design: audio overflow lives inside groups, so group edges are the
 * only safe cut points).
 *
 * Key inputs (all pixel-affecting). Segments are rendered WITHOUT the header
 * layer (the ENTIRE header — logos, step/chapter names+numbers, progress bar —
 * composites at assembly, per the user's design), so keys are POSITION-
 * INDEPENDENT: moving steps / reordering chapters / narration-timing tweaks
 * elsewhere all keep a segment's key stable. What's in:
 *   • the PREVIOUS step's snapshot (the transition's FROM state)
 *   • every step in the span (minus volatile fields: thumbnails, cached
 *     audio bodies, measured durations; narration text+durationMs stay —
 *     hold LENGTH is part of the segment's pixels)
 *   • render settings (size/fps/bitrate/background/AO/anim durations/hold)
 *   • RENDER_CACHE_EPOCH — bump when render code changes pixels
 *
 * Proof-of-seam (V0.3.2.1, user-validated): separately-rendered segments
 * concat seamlessly; transition paths may vary marginally vs a monolithic
 * render (planner reads live state) — accepted, coherent within any one
 * assembled video.
 */

import { state } from '../core/state.js';
import * as projectPaths from '../core/project-paths.js';   // 📁 folder layout
import { steps } from './steps.js';
import { resolveAnimationString } from './animation.js';   // V0.3.2.73 — preset content must reach the segment key

/** Bump when renderer/exporter changes make previously-cached pixels stale. */
export const RENDER_CACHE_EPOCH = 5;   // 2: canonical hashing (V0.3.2.22); 3: scoped defs (.32); 4: pruned object roster (.33); 5: overlay defs — shape AND text — reach the span key (.156/.158); anything cached before that was keyed without them

const _groupKeyOf = (s) => s.groupHead ? s.id : (s.groupId || null);

/** Canonical form for hashing (V0.3.2.22): object keys sorted, numbers
 *  rounded to 1e-4. Several subsystems rewrite step data with identical
 *  visual content but different bytes — overlay re-serialization shuffles
 *  Konva attr insertion order, bonded-shape sync re-derives floats, synth
 *  passes replace whole narration objects. None of that noise may ever
 *  change a fingerprint; only content that changes pixels should. */
function _canon(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v;
  if (Array.isArray(v)) return v.map(_canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = _canon(v[k]);
    return o;
  }
  return v;
}

const _pick = (obj, keep) => { const o = {}; for (const k in obj) if (keep.has(k)) o[k] = obj[k]; return o; };

/** Keep a node if it (or any descendant) contributes pixels — ancestors are
 *  retained because a visible node's world transform depends on them. */
function _pruneTree(n, keep) {
  if (!n) return null;
  const kids = (n.children || []).map(c => _pruneTree(c, keep)).filter(Boolean);
  if (kids.length || keep.has(n.id)) return { ...n, children: kids };
  return null;
}

/** Step as it matters to pixels: strip volatile / non-rendered fields, and
 *  (V0.3.2.33) prune the PROJECT-WIDE OBJECT ROSTER down to `keep`. */
function _stepKeyView(s, keep, animStr) {
  const c = { ...s };
  // 🎬 V0.3.2.73 — the RESOLVED animation string. A step stores only
  // `transition.animPresetId`; the choreography itself lives in the preset.
  // So editing a preset (or switching which one is default) left every key
  // identical and the cache served the OLD choreography — while the audio
  // mix, which is rebuilt at assembly time, moved to the NEW timings. Stale
  // pixels against fresh audio. Keying on the resolved string makes the
  // dependency explicit, and keeps it SCOPED: only spans whose steps
  // actually resolve to a changed string re-render.
  if (animStr !== undefined) c._animResolved = String(animStr || '');
  delete c.thumbnail;
  delete c.renderedDurationMs;      // measurement, not content (durations enter via the chapter vector)
  delete c.subtitles;               // 🌐 V0.3.2.63: subtitle overrides/translations composite at
                                    // ASSEMBLY (header layer) — editing a caption must never
                                    // re-key or re-render a 3D segment
  if (c.narration) {
    // Fixed-shape view: the narration object is wholesale-replaced by the
    // synth/precache passes (audio body, property order, re-measured
    // duration) without the audible content changing. Only what affects
    // pixels/timing keys: the spoken text + hold duration.
    c.narration = {
      text: String(c.narration.text || '').trim(),
      voiceId: c.narration.voiceId ?? null,
      speed: c.narration.speed ?? 1,
      durationMs: Math.round(c.narration.durationMs || 0),
    };
  }
  // Overlay is a serialized Konva-stage string — parse it so canonicalization
  // reaches inside (activation-time reflow/heal/sync rewrites reorder attrs
  // and nudge floats on visually identical overlays).
  if (typeof c.overlay === 'string' && c.overlay) {
    try { c.overlay = JSON.parse(c.overlay); } catch { /* unparseable → keys as raw string */ }
  }
  // ROSTER PRUNE (V0.3.2.33). Every step freezes a record for EVERY object in
  // the project — a visibility flag, a transform, a tree entry — including
  // objects HIDDEN in that step. So adding / deleting / unarchiving ONE object
  // rewrote all ~200 step records at once and re-keyed every segment, for
  // pixels that never changed. Keep only the objects that actually appear in
  // this segment (its steps + the prev step it animates from); everything
  // hidden throughout contributes nothing and must not touch the fingerprint.
  if (keep && c.snapshot) {
    const sn = { ...c.snapshot };
    if (sn.visibility) sn.visibility = _pick(sn.visibility, keep);
    if (sn.transforms) sn.transforms = _pick(sn.transforms, keep);
    if (sn.materials)  sn.materials  = _pick(sn.materials,  keep);
    if (sn.tree)       sn.tree       = _pruneTree(sn.tree, keep);
    c.snapshot = sn;
  }
  return _canon(c);
}

async function _sha1hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * 🔊 Decode the audio of every unmuted video clip across the playable steps
 * (V0.3.2.88). Returns segments in the narration-mix shape:
 * [{ stepId, samples: monoFloat32@rate, offsetMs }]. Decode is cached per
 * (path, window) so a clip reused on several steps decodes once.
 */
async function _decodeVideoClipAudio(playable, sampleRate, onProgress) {
  const vo = await import('./video-overlay.js');
  const nt = await import('./narration-timeline.js');
  const { resampleToMonoFloat32 } = await import('./audio-bridge.js');
  const out = [];
  const cache = new Map();   // `${abs}|${inMs}|${outMs}` -> Float32Array (unit volume)
  for (const step of playable) {
    const clips = vo.stepVideoClips(step);
    for (const clip of clips) {
      if (clip.muted) continue;
      const key = `${clip.abs}|${clip.inMs}|${clip.outMs}`;
      let samples = cache.get(key);
      if (samples === undefined) {
        samples = null;
        try {
          onProgress?.({ stepName: `decoding clip audio: ${clip.abs.split(/[\\/]/).pop()}…` });
          const resp = await fetch(vo.fileUrlFor(clip.abs));
          if (!resp.ok) throw new Error(`read failed (${resp.status})`);
          const bytes = await resp.arrayBuffer();
          const actx = new AudioContext({ sampleRate });
          let buf;
          try { buf = await actx.decodeAudioData(bytes); }
          finally { actx.close().catch(() => {}); }
          const mono = await resampleToMonoFloat32(buf, sampleRate);
          const a = Math.max(0, Math.round(clip.inMs  / 1000 * sampleRate));
          const b = Math.min(mono.length, Math.round(clip.outMs / 1000 * sampleRate));
          samples = (b > a) ? mono.slice(a, b) : null;   // slice = fresh buffer; the full decode is released
        } catch (e) {
          console.warn(`[assembly] clip audio skipped (${clip.abs.split(/[\\/]/).pop()}):`, e?.message);
        }
        cache.set(key, samples);
      }
      if (!samples) continue;
      let s = samples;
      if (clip.volume !== 1) {
        s = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) s[i] = samples[i] * clip.volume;
      }
      out.push({ stepId: step.id, samples: s, offsetMs: nt.videoAudioStartOffsetMs(step) });
    }
  }
  return out;
}

/** Divide the playable timeline into segments + compute cache keys. */
export async function computeSegmentPlan() {
  const playable = (state.get('steps') || []).filter(s => steps._isPlayable(s));

  // Spans: contiguous same-group steps collapse to one segment.
  const spans = [];
  for (let i = 0; i < playable.length; i++) {
    const gk = _groupKeyOf(playable[i]);
    const last = spans[spans.length - 1];
    if (gk !== null && last && last.groupKey === gk) { last.to = i; last.steps.push(playable[i]); continue; }
    spans.push({ from: i, to: i, groupKey: gk, steps: [playable[i]] });
  }

  // DEFINITION-level state, PER-SEGMENT SCOPED (V0.3.2.32). Primitives and
  // flat-shape templates are node-INSTANCE-scoped: a segment's pixels depend
  // only on the ones its VISIBLE nodes reference. Keying every segment on the
  // WHOLE definition set (the old blunt rule) meant adding/editing ONE
  // primitive re-rendered the entire movie — even for a shape shown only at
  // the end. Now each span keys on just the defs it actually contains, so
  // "add things at the end" reuses everything before it. (colors + cables stay
  // global below: a preset/style edit is cross-cutting and rarer — safe to
  // keep conservative than risk a stale colour.)
  const primById       = new Map();   // primitive node id → def
  const shapeTplOfNode = new Map();   // flatShape node id → templateId
  (function walk(n) {
    if (!n) return;
    if (n.type === 'primitive') primById.set(n.id, { id: n.id, k: n.primKind, p: n.primParams, q: n.primQuality, b: n.baseAtOrigin });
    else if (n.type === 'flatShape' && n.templateId) shapeTplOfNode.set(n.id, n.templateId);
    (n.children || []).forEach(walk);
  })(state.get('treeData'));
  const _byId = (a, b) => String(a.id).localeCompare(String(b.id));
  const tplById   = new Map((state.get('shapeTemplates') || []).map(t => [t.id, t]));
  const allPrims  = [...primById.values()].sort(_byId);                 // conservative fallback (missing vis map)
  const allShapes = (state.get('shapeTemplates') || []).slice().sort(_byId);
  // V0.3.2.150 — OVERLAY-side project definitions. These were absent, so a
  // cached segment could be re-used after the definition that draws its
  // overlay changed: edit a linked shape's size, export, and the cached
  // spans still carry the old geometry.
  //
  // Deliberately coarse. The 3D defs above are scoped per span by the nodes
  // that span actually shows; the equivalent for overlay defs would mean
  // parsing each span's overlay JSON to learn which ids it references. Until
  // that exists, any change to an overlay definition invalidates every
  // cached segment — slower re-exports, but never a stale frame. Correct and
  // slow beats fast and wrong for a deliverable the user ships.
  const _overlayDefs = {
    shapeStyles: (state.get('shapeStyles') || []).slice().sort(_byId),
    constShapes: (state.get('constShapes') || []).slice().sort(_byId),
    shapeLinks:  (state.get('shapeLinks')  || []).slice().sort(_byId),
    // V0.3.2.158 — TEXT-side definitions, missing since text styles shipped.
    // A text box stores textHtml + styleId and resolves the template at LOAD
    // time (overlay.js _reflowTextBox), exactly like a shape style: editing a
    // text style leaves every stored overlay string byte-identical, so the
    // cache saw no change and re-used segments drawn with the OLD font,
    // colour, fill and — since .145 — drop shadow and outline.
    // constTextBoxes owns pinned text position + style binding, same story.
    styleTemplates: (state.get('styleTemplates') || []).slice().sort(_byId),
    constTextBoxes: (state.get('constTextBoxes') || []).slice().sort(_byId),
  };

  const _defScope = {
    primById, shapeTplOfNode, tplById, allPrims, allShapes, byId: _byId,
    // V0.3.2.156 — overlay-side definitions belong on the SPAN key, not just
    // the drift report. See _scopedDefs.
    overlay: _overlayDefs,
    colors: (state.get('colorPresets') || []).slice().sort(_byId),
    cables: (state.get('cables') || []).map(c => ({ id: c.id, style: c.style })).sort(_byId),
  };
  // Coarse global roster — for the drift report / _keyinputs only, NOT per-span keys.
  const defsKey = {
    prims: allPrims, shapes: allShapes, colors: _defScope.colors, cables: _defScope.cables,
    overlay: _overlayDefs,
  };

  // Pixel-affecting global settings. NO header config, NO positions, NO
  // sibling durations — segments are header-less (assembly composites the
  // header layer), so keys stay stable across moves/reorders/timing tweaks.
  const exp = state.get('export') || {};
  const settingsKey = {
    w: exp.width, h: exp.height, fps: exp.fps, bitrate: exp.videoBitrate,
    stepHold: exp.stepHoldMs,
    bg: state.get('backgroundColor'), bgGrad: state.get('backgroundGradient'),
    render: state.get('render'),
    camMs: state.get('cameraAnimDurationMs'), objMs: state.get('objectAnimDurationMs'),
    // B5/M8 (V0.3.2.109): boundary boxes change every rendered pixel but
    // weren't keyed — toggling the option happily reused clips showing the
    // previous state. Spread-only-when-ON so the default-off case keeps
    // every existing cache key valid (no mass re-render for anyone).
    ...(exp.exportBoundaryBoxes ? { bboxes: true } : {}),
    epoch: RENDER_CACHE_EPOCH,
  };

  // Resolver for the per-step choreography (V0.3.2.73) — computed once per
  // plan so _stepKeyView can fold the RESOLVED animation string into each
  // step's fingerprint (see the note there).
  const _animPresets = state.get('animationPresets') || [];
  // 🧵 V0.3.2.77 — keying parses every step's overlay, which FLATTENS the
  // interned ropes (un-shares ~150MB on the big project). Re-share once the
  // plan is computed; fire-and-forget, order irrelevant.
  setTimeout(() => import('../io/project.js').then(m => m._reinternAfterWholesaleRead('cache-plan')).catch(() => {}), 0);
  const plan = { spans, playableCount: playable.length, settingsKey, defsKey, _defScope,
    _animOf: (st) => {
      try { return resolveAnimationString(st?.transition || {}, _animPresets) || ''; }
      catch { return ''; }
    },
  };
  for (const span of spans) {
    span._prevRef = span.from > 0 ? playable[span.from - 1] : null;
    span.name  = span.steps[0].name || '(step)';
    span.count = span.steps.length;
    await _keySpan(span, plan);
  }
  return plan;
}

/** THE VISIBLE SET — the one source of truth for this segment's fingerprint.
 *  Node ids that contribute pixels anywhere in the span: its own steps PLUS
 *  the prev step (the transition animates FROM it, so a node fading out there
 *  still paints). Hidden (localVisible === false) and archived nodes paint
 *  nothing. Returns null when a step lacks the tree/visibility data → caller
 *  keys EVERYTHING (never scope on missing data → never serve stale pixels).
 *
 *  Deliberately does NOT propagate a hidden parent down to its children: that
 *  would only shrink the set further, and over-including is the safe direction
 *  (a harmless extra re-render, never a stale frame). */
function _spanVisible(span) {
  const ids = new Set();
  const forVis = span._prevRef ? [span._prevRef, ...span.steps] : span.steps;
  for (const st of forVis) {
    const snap = st?.snapshot;
    const tree = snap?.tree, vis = snap?.visibility;
    if (!tree || !vis) return null;
    (function walk(n) {
      if (!n) return;
      const hidden = vis[n.id] === false || n.localVisible === false || n.archived === true;
      if (!hidden) ids.add(n.id);
      (n.children || []).forEach(walk);
    })(tree);
  }
  return ids;
}

/** Per-segment scoped definitions, from the span's visible set. colors/cables
 *  stay global (cross-cutting). Safe under every edit:
 *   - ADD a primitive/shape hidden here → not in V → key unchanged → reused.
 *   - EDIT params → only spans whose visible nodes reference it re-key.
 *   - DELETE → it WAS present+visible (so it was in the list) → drops out →
 *     key changes → re-render. No stale.
 *   - V null (missing data) → full defs (conservative). */
function _scopedDefs(V, plan) {
  const sc = plan._defScope;
  // Overlay defs are NOT scoped by visible 3D nodes — a shape style or a
  // linked shape has nothing to do with which meshes a span shows — so they
  // ride on every span unconditionally. Any edit to one therefore changes
  // every span key and invalidates the whole cache.
  //
  // V0.3.2.156 — this is where they were MISSING. .150 added them to defsKey,
  // which its own comment two lines above declares is "for the drift report /
  // _keyinputs only, NOT per-span keys". The commit message claimed the cache
  // invalidated on overlay-def changes; it did not. Because styles, links and
  // pinned positions resolve at step LOAD time, editing one leaves every
  // unopened step's stored overlay string byte-identical — so every span was a
  // cache HIT and an incremental export silently shipped the OLD paint,
  // geometry and positions.
  if (!V) return { prims: sc.allPrims, shapes: sc.allShapes, colors: sc.colors, cables: sc.cables, overlay: sc.overlay };
  const prims = [];
  for (const id of V) { const d = sc.primById.get(id); if (d) prims.push(d); }
  prims.sort(sc.byId);
  const tplIds = new Set();
  for (const id of V) { const t = sc.shapeTplOfNode.get(id); if (t) tplIds.add(t); }
  const shapes = [...tplIds].map(t => sc.tplById.get(t) || { id: t, gone: true }).sort(sc.byId);
  return { prims, shapes, colors: sc.colors, cables: sc.cables, overlay: sc.overlay };
}

/** (Re)compute a span's key + part-hashes from the CURRENT live objects.
 *  Called at plan time AND again right after a span renders (V0.3.2.21):
 *  step activation during rendering self-heals/rewrites step data, so the
 *  settled post-render state is the only stable thing to file the cache
 *  under — keying at plan time wrote files under fingerprints that were
 *  obsolete by the next run (the back-to-back full-re-render bug). */
async function _keySpan(span, plan) {
  // ONE visible set drives both halves of the fingerprint (V0.3.2.33):
  // which definitions this segment depends on, and which objects' step
  // records it keys on.
  span._keep     = _spanVisible(span);                                  // null → key everything (conservative)
  span._defsJson = JSON.stringify(_canon(_scopedDefs(span._keep, plan)));
  const p = _spanPayload(span, plan);
  span._prevH  = await _sha1hex(p.prevJson);
  span._stepsH = await _sha1hex(p.stepsJson);
  span.key = await _sha1hex(p.full);
  return span.key;
}

/** Step views are SPAN-SCOPED now (each span prunes to its own visible set),
 *  so the old cross-span memo is gone — a step is viewed at most twice per
 *  pass (as a member, and as the next span's lead). Pruning shrinks the data
 *  dramatically, so this is cheaper than the unpruned single-pass was. */
function _spanPayload(span, plan) {
  const keep = span._keep;
  const view = (st) => JSON.stringify(_stepKeyView(st, keep, plan._animOf?.(st)));
  const prevJson  = span._prevRef ? view(span._prevRef) : 'null';
  const stepsJson = '[' + span.steps.map(view).join(',') + ']';
  plan._settingsJson ||= JSON.stringify(_canon(plan.settingsKey));
  return { prevJson, stepsJson,
    full: `{"prev":${prevJson},"steps":${stepsJson},"settings":${plan._settingsJson},"defs":${span._defsJson}}` };
}

/** Drift forensics (V0.3.2.21): compare this plan against the previous one
 *  (_rendercache/_lastplan.json) and NAME what changed — which spans, which
 *  part (step data vs prev-step vs defs vs settings), and for the first
 *  drifted span a field-by-field payload diff down to the first differing
 *  character. This is how we catch fields that silently rewrite themselves
 *  between runs and churn the cache. */
async function _reportPlanDrift(out, dir) {
  const lastPath = `${dir}/_lastplan.json`;
  let old = null;
  try {
    const r = await window.sbsNative.readFile(lastPath, 'utf8');
    if (r?.ok) old = JSON.parse(r.data);
  } catch { /* first run */ }

  if (old && out.misses > 0) {
    try {
      const defsChanged     = JSON.stringify(old.defs)     !== JSON.stringify(out.defsKey);
      const settingsChanged = JSON.stringify(old.settings) !== JSON.stringify(out.settingsKey);
      let stepsDrift = 0, prevDrift = 0, comparable = old.spans?.length === out.spans.length;
      if (comparable) {
        for (let i = 0; i < out.spans.length; i++) {
          if (old.spans[i].stepsH !== out.spans[i]._stepsH) stepsDrift++;
          else if (old.spans[i].prevH !== out.spans[i]._prevH) prevDrift++;
        }
      }
      console.warn(`[render-cache] plan drift vs previous plan: ` +
        (comparable ? `${stepsDrift} span(s) with changed STEP data, ${prevDrift} with changed PREV-step only, ` : `span count ${old.spans?.length} → ${out.spans.length}, `) +
        `defs ${defsChanged ? 'CHANGED' : 'same'}, settings ${settingsChanged ? 'CHANGED' : 'same'}`);

      // Field-level diff of the first drifted span's payload.
      if (comparable && old.sample) {
        const i = out.spans.findIndex((s, j) => old.spans[j].stepsH !== s._stepsH || old.spans[j].prevH !== s._prevH);
        if (i === old.sample.index) {
          const cur = JSON.parse(_spanPayload(out.spans[i], out).full);
          const prev = JSON.parse(old.sample.payload);
          const diffs = [];
          const strCtx = (a, b) => {
            let k = 0; while (k < a.length && a[k] === b[k]) k++;
            return `…${a.slice(Math.max(0, k - 50), k + 50)}… → …${b.slice(Math.max(0, k - 50), k + 50)}…`;
          };
          const cmp = (pa, pb, pfx) => {
            if (diffs.length >= 12) return;
            if (JSON.stringify(pa) === JSON.stringify(pb)) return;
            if (typeof pa === 'string' && typeof pb === 'string') { diffs.push(`${pfx}: ${strCtx(pa, pb)}`); return; }
            if (typeof pa !== 'object' || typeof pb !== 'object' || !pa || !pb) { diffs.push(`${pfx}: ${JSON.stringify(pa)?.slice(0, 80)} → ${JSON.stringify(pb)?.slice(0, 80)}`); return; }
            for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) cmp(pa[k], pb[k], `${pfx}.${k}`);
          };
          cmp(prev, cur, `span${i}("${out.spans[i].name.slice(0, 20)}")`);
          if (diffs.length) console.warn('[render-cache] first drifted span, field diff (previous → current):\n' + diffs.join('\n'));
        }
      }
      out.driftReport = { defsChanged, settingsChanged, stepsDrift, prevDrift, comparable };
    } catch (e) { console.warn('[render-cache] drift report failed:', e?.message); }
  }

  // Record THIS plan for the next comparison. Sample = payload of the first
  // span that currently misses (most likely to drift again), else span 0.
  try {
    const si = Math.max(0, out.spans.findIndex(s => !s.cached));
    await window.sbsNative.writeFile(lastPath, JSON.stringify({
      when: new Date().toISOString(),
      settings: out.settingsKey, defs: out.defsKey,
      spans: out.spans.map(s => ({ name: s.name, key: s.key, prevH: s._prevH, stepsH: s._stepsH })),
      sample: out.spans.length ? { index: si, payload: _spanPayload(out.spans[si], out).full } : null,
    }), 'utf8');
  } catch { /* best-effort */ }
}

/**
 * Render every MISSING segment into <project>/_rendercache/ (V0.3.2.3).
 * Each miss renders via the proven segment machinery: span [from-1 … to] with
 * the lead step instant-applied + zero frames (the very first segment has no
 * prev — it starts with its own hold, no transition). Segments are HEADER-LESS
 * and SILENT but narration-TIMED. Beside each seg-<key>.mp4 a seg-<key>.json
 * sidecar records its exact duration + within-segment step offsets — the
 * assembly pass uses those to place audio + compute global markers.
 * Returns { rendered, reused, failed, dir }.
 */
/** CSS color → ffmpeg color syntax ('#rrggbb'→'0xrrggbb', 'rgba(r,g,b,a)'→'0xrrggbb@a'). */
function _ffColor(c, fallback) {
  const s = String(c || fallback || 'white').trim();
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m) {
    const hex = [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('');
    return `0x${hex}${m[4] != null ? `@${m[4]}` : ''}`;
  }
  if (s.startsWith('#')) return '0x' + s.slice(1);
  return s;
}

/** Float32 mono PCM → 16-bit WAV bytes (for ffmpeg to mux). */
function _wavFromFloat32(pcm, rate) {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/**
 * ASSEMBLE the final video from the cache (V0.3.2.5 — slices 3a+3b).
 *   1. Render any missing segments (reuses everything cached).
 *   2. Read every sidecar → global step markers (cumulative) + total length.
 *   3. ffmpeg concat (stream copy — lossless, seconds).
 *   4. Decode narration clips → mix ONE master track at the global markers
 *      (the export's own machinery) → WAV → ffmpeg mux (video copied, AAC audio).
 * NOT YET: header layer / progress bar composite (slice 3c) — the output is
 * header-less for now. Returns { path, totalMs, segments, reused, rendered }.
 */
export async function assembleFromCache({ onProgress, signal, output, force = false } = {}) {
  const ve = await import('./video-export.js');
  const timings = [];
  let renderedCount = 0;
  let _t = performance.now();
  const _mark = (label) => { timings.push([label, performance.now() - _t]); _t = performance.now(); };

  const _checkFill = (fill) => {
    if (fill.failed) throw new Error(`${fill.failed} segment(s) failed to render — aborting assembly`);
    const missing = fill.plan.spans.filter(s => !s.cached).length;
    if (missing) throw new Error(`${missing} segment(s) unaccounted for after fill`);
    return fill.plan;   // ONE plan per run — never re-plan mid-flight
  };

  // Sidecars → global markers + each span's assembled-time window.
  const readTimeline = async (plan) => {
    let cum = 0;
    const markersByStepId = new Map();
    const files = [];
    for (const span of plan.spans) {
      const sj = await window.sbsNative.readFile(`${plan.dir}/seg-${span.key}.json`, 'utf8');
      if (!sj?.ok) throw new Error(`sidecar missing for "${span.name}" — clear _rendercache and refill`);
      const sc = JSON.parse(sj.data);
      for (const st of (sc.steps || [])) markersByStepId.set(st.stepId, cum + st.ms);
      files.push(`${plan.dir}/seg-${span.key}.mp4`);
      span._startMs = cum;
      // PHANTOM-FRAME CORRECTION (V0.3.2.28): the muxer declares each
      // segment ONE FRAME shorter than the encoder counted (ffprobe-verified
      // on a real 160-segment assembly: every file exactly -1 frame vs its
      // sidecar). The concat demuxer stacks the DECLARED durations, so the
      // real timeline runs 1 frame/segment shorter than the model — audio,
      // TOC and header switches all landed cumulatively LATE (−6.7s over
      // 18.5min at 24fps). Place everything on the declared timeline.
      const fpsUsed = Number(sc.fps) || Number(state.get('export')?.fps) || 50;
      span._durMs   = Math.max(0, (sc.durationMs || 0) - 1000 / fpsUsed);
      cum += span._durMs;
    }
    return { markersByStepId, files, totalMs: cum };
  };

  const fill1 = await renderMissingSegments({ onProgress, signal, force });
  let plan = _checkFill(fill1);
  renderedCount += fill1.rendered;
  _mark('render segments');

  let TL = await readTimeline(plan);

  // EXACT TOC (V0.3.2.13): chapter times read off THE ASSEMBLED TIMELINE
  // ITSELF — not the measured-duration estimate, which accumulates ~1 frame of
  // rounding per segment and drifted seconds by the late chapters. Stamp the
  // true times into the TOC boxes; if any box actually changed, only its host
  // segment re-renders (overlay text never affects durations → the timeline is
  // stable → no circularity).
  {
    const chapItems = state.get('chapters')?.items || state.get('chapters') || [];
    const chapName  = new Map(chapItems.map(c => [c.id, c.name]));
    const chaptersExact = [];
    let lastCh;
    for (const span of plan.spans) {
      const ch = span.steps[0].chapterId ?? null;
      if (ch !== lastCh) {
        chaptersExact.push({ chapterId: ch, name: ch ? (chapName.get(ch) || '(chapter)') : '(no chapter)', startMs: Math.round(span._startMs) });
        lastCh = ch;
      }
    }
    try {
      const ov = await import('./overlay.js');
      await ov.waitForOverlayStable?.();
      const touched = await ov.refreshAllTocBoxesData?.({ chapters: chaptersExact });
      if (touched) {
        onProgress?.({ stepName: `TOC stamped with exact times (${touched} step(s)) — re-rendering host segment(s)…` });
        const fill2 = await renderMissingSegments({ onProgress, signal });
        plan = _checkFill(fill2);
        renderedCount += fill2.rendered;
        TL = await readTimeline(plan);
      }
    } catch (e) { console.warn('[assemble] exact-TOC stamp failed:', e?.message); }
  }
  _mark('timeline + exact TOC');
  const { markersByStepId, files } = TL;
  const totalMs = TL.totalMs;

  // Lossless video concat (same codec/params by construction).
  onProgress?.({ stepName: 'stitching video (lossless concat)…' });
  const listPath = `${plan.dir}/_list.txt`;
  // B5/M10 (V0.3.2.109): escape single quotes for ffmpeg's concat list
  // ('…' → '\'' close-escape-reopen) — a project path like O'Brien made
  // every assembly die with "concat failed".
  await window.sbsNative.writeFile(listPath, files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const vPath = `${plan.dir}/_assembly-video.mp4`;
  let r = await window.sbsNative.ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', vPath]);
  if (!r?.ok) throw new Error('concat failed: ' + (r?.stderrTail || '').slice(-300));
  _mark('stitch (lossless concat)');

  // ── Header track (V0.3.2.8, slice 3c) ──────────────────────────────────────
  // One static PNG per span (dynamic text resolved against the span's HEAD step
  // — matches the live header's treat-group-as-one-step rule), played as a
  // concat image sequence and overlaid in the final pass. The progress bar
  // animates via per-chapter ffmpeg drawbox width expressions (same linear fill
  // as the live bar; square corners — cosmetic difference only).
  const exp  = state.get('export') || {};
  const expW = (Number.isFinite(exp.width)  && exp.width  > 0) ? exp.width  : 1920;
  const expH = (Number.isFinite(exp.height) && exp.height > 0) ? exp.height : 1080;
  const header = await import('./header.js');
  const allHdrItems = (state.get('headerItems') || []).filter(i => i.visible !== false);
  const headersOn = !state.get('headersHidden') && allHdrItems.length > 0;
  let hdrListPath = null;
  const boxFilters = [];    // static track boxes (drawbox is fine for constants)
  const fillChains = [];    // animated fills: color source → time-cropped → overlaid
  if (headersOn) {
    const staticItems = allHdrItems.filter(i => i.kind !== 'chapterProgress');
    if (staticItems.length) {
      onProgress?.({ stepName: 'rendering header track…' });
      const lines = [];
      let lastPng = null;
      outer:
      for (let i = 0; i < plan.spans.length; i++) {
        const span = plan.spans[i];
        // 🌐 V0.3.2.64: PER-STEP caption windows inside a span. A sub-step
        // that speaks its own narration takes the subtitle over mid-group,
        // so the header track must switch inside the span's clip. Window
        // starts come from the sidecar step markers (the SAME clock the
        // narration mix uses) → captions land exactly with their audio.
        // Consecutive windows whose caption OWNER doesn't change are merged
        // — spans with no speaking sub-steps collapse back to the old one-
        // PNG-per-span (dynamic kinds all resolve via the head, so only the
        // subtitle owner can differ inside a span).
        const wins = [];   // { stepId, startMs }
        for (const s of span.steps) {
          const sctx    = header.buildRenderContext(s.id);
          const ownerId = sctx.subtitleStep?.id || sctx.step?.id || null;
          const abs     = markersByStepId.get(s.id);
          const startMs = Math.max(0, (Number.isFinite(abs) ? abs : span._startMs) - span._startMs);
          const last    = wins[wins.length - 1];
          if (last && last.ownerId === ownerId) continue;   // same caption → extend
          wins.push({ stepId: s.id, ownerId, startMs });
        }
        for (let k = 0; k < wins.length; k++) {
          const endMs = (k + 1 < wins.length) ? wins[k + 1].startMs : span._durMs;
          const durMs = Math.max(40, endMs - wins[k].startMs);
          const ctx = header.buildRenderContext(wins[k].stepId);
          const cnv = await header.rasterizeHeaderDataToCanvas(ctx, { width: expW, height: expH });
          if (!cnv) { lines.length = 0; break outer; }
          const blob  = await new Promise(res => cnv.toBlob(res, 'image/png'));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const png   = `_hdr/span-${i}-${k}.png`;
          const w = await window.sbsNative.writeFile(`${plan.dir}/${png}`, bytes, null);
          if (!w?.ok) throw new Error('header png write failed: ' + w?.error);
          lines.push(`file '${png}'`, `duration ${(durMs / 1000).toFixed(3)}`);
          lastPng = png;
        }
      }
      if (lines.length) {
        lines.push(`file '${lastPng}'`);   // concat-demuxer quirk: repeat the last entry
        hdrListPath = `${plan.dir}/_hdrlist.txt`;
        const w = await window.sbsNative.writeFile(hdrListPath, lines.join('\n'), 'utf8');
        if (!w?.ok) throw new Error('header list write failed');
      }
    }
    // Progress bars: track = constant box; fill = width grows linearly across
    // each chapter's assembled-time window.
    const progItems = allHdrItems.filter(i => i.kind === 'chapterProgress');
    if (progItems.length) {
      const wins = [];
      for (const span of plan.spans) {
        const ch = span.steps[0].chapterId ?? null;
        const last = wins[wins.length - 1];
        if (last && last.ch === ch) last.end = span._startMs + span._durMs;
        else wins.push({ ch, start: span._startMs, end: span._startMs + span._durMs });
      }
      // NOTE (V0.3.2.10): drawbox CANNOT animate — in its expressions `t` is
      // the THICKNESS, not time (the stuck-full-bar bug). The fill is instead a
      // solid color source CROPPED to a growing width (crop DOES evaluate `t`
      // as timestamp per frame) and overlaid during its chapter's window.
      for (const item of progItems) {
        const x = Math.round(item.x), y = Math.round(item.y), w = Math.round(item.w), h = Math.round(item.h);
        boxFilters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${_ffColor(item.trackColor, 'white@0.4')}:t=fill`);
        for (const win of wins) {
          if (!win.ch) continue;                       // outside chapters the bar stays empty
          fillChains.push({
            color: _ffColor(item.fillColor, '0x3b82f6'),
            w, h, x, y,
            cs: (win.start / 1000).toFixed(3),
            ce: (win.end   / 1000).toFixed(3),
            cd: Math.max(0.001, (win.end - win.start) / 1000).toFixed(3),
          });
        }
      }
    }
  }

  _mark('header track');

  // Global audio master at the assembled markers.
  const playable = (state.get('steps') || []).filter(s => steps._isPlayable(s));
  onProgress?.({ stepName: 'decoding narration clips…' });
  const audio = await ve.decodeNarrationSegments(playable, 48000);

  // 🔊 VIDEO CLIP AUDIO (V0.3.2.88 — Phase 3). Unmuted clips join the mix
  // as one more "place PCM at the step marker" input, offset to the moment
  // playback actually triggers (overlay fade-in completion — the same
  // clock the visuals use, so lips stay on faces). The file's audio is
  // decoded once per unique (path, window), sliced to the trimmed window,
  // scaled by the clip's volume. Failures skip the clip with a warning —
  // a missing/unreadable file must never sink the whole assembly.
  try {
    const vseg = await _decodeVideoClipAudio(playable, 48000, onProgress);
    if (vseg.length) {
      audio.segments = [...(audio.segments || []), ...vseg];
      audio.hasAudio = true;
      console.log(`[assembly] video audio: ${vseg.length} clip(s) mixed in`);
    }
  } catch (e) { console.warn('[assembly] video audio skipped:', e?.message); }
  let aPath = null;
  if (audio.hasAudio) {
    const pcm = ve.mixPcmFromMarkers(audio, markersByStepId, totalMs, 48000);
    aPath = `${plan.dir}/_assembly-audio.wav`;
    const w = await window.sbsNative.writeFile(aPath, _wavFromFloat32(pcm, 48000), null);
    if (!w?.ok) throw new Error('audio master write failed: ' + w?.error);
  }

  _mark('audio master');

  // ── Final pass: composite headers + bar (re-encode) OR plain mux (copy) ────
  const projDir = (state.get('projectPath') || '').replace(/[\\/][^\\/]*$/, '');
  const outPath = output || `${projDir}/${(state.get('export')?.fileName) || 'sbs_export'}-assembled.mp4`;
  onProgress?.({ stepName: 'compositing + muxing final video…' });
  const args = ['-y', '-i', vPath];
  let aInIdx = 1;
  if (hdrListPath) { args.push('-f', 'concat', '-safe', '0', '-i', hdrListPath); aInIdx = 2; }
  if (aPath) args.push('-i', aPath);
  const chains = [];
  let vLabel = '[0:v]';
  if (hdrListPath)      { chains.push(`[0:v][1:v]overlay=0:0:eof_action=pass[vh]`); vLabel = '[vh]'; }
  if (boxFilters.length) { chains.push(`${vLabel}${boxFilters.join(',')}[vb]`); vLabel = '[vb]'; }
  // Animated fill (V0.3.2.11): the canonical ffmpeg progress-bar idiom. A
  // solid strip SLIDES right inside a transparent bar-sized canvas (the canvas
  // clips the spill), then the canvas overlays at the bar's position during
  // its chapter window. overlay x-expressions evaluate per frame — no dynamic
  // crop sizes (which starved the graph → "received no packets").
  const dTot = (totalMs / 1000 + 1).toFixed(3);
  fillChains.forEach((f, i) => {
    chains.push(`color=c=${f.color}:s=${f.w}x${f.h}:r=25:d=${dTot}[pf${i}]`);
    chains.push(`color=c=black@0.0:s=${f.w}x${f.h}:r=25:d=${dTot},format=rgba[pc${i}]`);
    chains.push(`[pc${i}][pf${i}]overlay=x='-${f.w}+${f.w}*clip((t-${f.cs})/${f.cd},0,1)':y=0[pm${i}]`);
    chains.push(`${vLabel}[pm${i}]overlay=x=${f.x}:y=${f.y}:eof_action=pass:enable='between(t,${f.cs},${f.ce})'[vf${i}]`);
    vLabel = `[vf${i}]`;
  });
  if (chains.length) {
    // Script file instead of an argv-inlined graph: debuggable (persists next
    // to the cache) and immune to Windows command-line length limits.
    const fgPath = `${plan.dir}/_filtergraph.txt`;
    const wfg = await window.sbsNative.writeFile(fgPath, chains.join(';\n'), 'utf8');
    if (!wfg?.ok) throw new Error('filtergraph write failed');
    // FFmpeg 8+ removed -filter_complex_script; the modern equivalent is the
    // generic read-option-from-file form: -/filter_complex <path>.
    args.push('-/filter_complex', fgPath, '-map', vLabel);
    if (aPath) args.push('-map', `${aInIdx}:a:0`);
    args.push('-c:v', 'libx264', '-preset', 'fast', '-b:v', String(exp.videoBitrate || 4_000_000), '-pix_fmt', 'yuv420p');
  } else {
    args.push('-map', '0:v:0');
    if (aPath) args.push('-map', `${aInIdx}:a:0`);
    args.push('-c:v', 'copy');
  }
  if (aPath) args.push('-c:a', 'aac', '-b:a', '192k');
  args.push(outPath);
  r = await window.sbsNative.ffmpeg(args);
  if (!r?.ok) throw new Error('composite/mux failed: ' + (r?.stderrTail || '').slice(-300));
  _mark('composite + mux');
  const totalS = timings.reduce((a, [, ms]) => a + ms, 0) / 1000;
  console.log('%c[assemble] stage timing:', 'font-weight:bold;color:#38bdf8');
  for (const [label, ms] of timings) console.log(`   ${label.padEnd(26)} ${(ms / 1000).toFixed(1)}s`);
  console.log(`   ${'TOTAL'.padEnd(26)} ${totalS.toFixed(1)}s  (${(totalS / 60).toFixed(1)} min)`);
  // Step markers in playable order — the .sbsproc manifest consumes these.
  const stepMarkers = plan.spans.flatMap(span =>
    span.steps.map(s => ({ stepId: s.id, timeInMs: Math.round(markersByStepId.get(s.id) ?? 0) })));
  // Janitor (V0.3.2.26): the export succeeded, the plan is the truth — sweep
  // segment files no plan references anymore. Best-effort, never fatal.
  try { await purgeOrphans(plan); } catch (e) { console.warn('[render-cache] purge failed:', e?.message); }
  return { path: outPath, totalMs, segments: plan.spans.length,
           reused: plan.spans.length - renderedCount, rendered: renderedCount,
           headers: !!(hdrListPath || boxFilters.length), timings, stepMarkers };
}

/**
 * Delete dead segment files (V0.3.2.34 — precise, replaces the blunt refusals).
 *
 * The old janitor refused to run whenever ANY step/chapter was hidden, or
 * whenever the plan matched nothing on disk. Both are normal working states,
 * so it never ran: 1146 files / 2.5 GB accumulated across four cache
 * generations. It now deletes only what is PROVABLY dead:
 *
 *   1. Wrong generation — the cache epoch is baked into every key, so a
 *      segment stamped with a different epoch (or with no sidecar at all,
 *      i.e. pre-dating the stamp) can NEVER be referenced again. Always safe,
 *      hidden content or not.
 *   2. Superseded fingerprints — same epoch but unreferenced. Only swept when
 *      NOTHING is hidden, because then the plan covers the whole project and
 *      is authoritative. With hidden chapters these are kept: they are very
 *      likely the hidden content's own segments. ({force:true} sweeps them
 *      anyway — costs a re-render if you unhide.)
 *
 * Runs automatically after each successful assembly. Manual:
 *   await window.sbsCachePurge()      // or ({force:true})
 */
export async function purgeOrphans(plan, { force = false } = {}) {
  if (!plan?.dir || !window.sbsNative?.listDir || !window.sbsNative?.deletePath) return { skipped: 'unavailable' };
  const entries = await window.sbsNative.listDir(plan.dir);
  if (!Array.isArray(entries)) return { skipped: 'listDir failed' };

  const anyHiddenStep = (state.get('steps') || []).some(s => s && !s.isBaseStep && s.hidden);
  const chapItems = state.get('chapters')?.items || state.get('chapters') || [];
  const anyHiddenChapter = Array.isArray(chapItems) && chapItems.some(c => c?.hidden);
  const sweepSuperseded = force || !(anyHiddenStep || anyHiddenChapter);

  const live = new Set(plan.spans.map(s => s.key));                 // referenced by the current plan
  const haveSidecar = new Set(entries.filter(f => /^seg-[0-9a-f]{16}\.json$/.test(f.name)).map(f => f.name.slice(4, 20)));
  const segKeys = [...new Set(entries.filter(f => /^seg-[0-9a-f]{16}\.mp4$/.test(f.name)).map(f => f.name.slice(4, 20)))];
  const sizeOf = new Map(entries.map(f => [f.name, f.size || 0]));

  let deadEpoch = 0, deadSuper = 0, kept = 0, bytes = 0;
  for (const key of segKeys) {
    if (live.has(key)) { kept++; continue; }
    let reason = null;
    if (!haveSidecar.has(key)) {
      reason = 'epoch';                                              // no sidecar → unusable by assembly anyway
    } else {
      let epoch = null;
      try {
        const sj = await window.sbsNative.readFile(`${plan.dir}/seg-${key}.json`, 'utf8');
        if (sj?.ok) epoch = JSON.parse(sj.data)?.epoch ?? null;
      } catch { /* unreadable → treat as old generation */ }
      if (epoch !== RENDER_CACHE_EPOCH) reason = 'epoch';
      else if (sweepSuperseded) reason = 'superseded';
    }
    if (!reason) { kept++; continue; }
    for (const ext of ['mp4', 'json']) {
      const name = `seg-${key}.${ext}`;
      if (!sizeOf.has(name)) continue;
      const r = await window.sbsNative.deletePath(`${plan.dir}/${name}`);
      if (r?.ok) bytes += sizeOf.get(name);
    }
    if (reason === 'epoch') deadEpoch++; else deadSuper++;
  }
  const mb = +(bytes / 1e6).toFixed(1);
  const held = (!sweepSuperseded && (anyHiddenStep || anyHiddenChapter))
    ? ' · same-generation orphans KEPT (hidden steps/chapters present — likely theirs; {force:true} to sweep)' : '';
  console.log(`[render-cache] purge: ${deadEpoch} old-generation + ${deadSuper} superseded segment(s) removed, ${mb} MB freed · ${kept} kept${held}`);
  return { deleted: deadEpoch + deadSuper, deadEpoch, deadSuper, kept, mb };
}

/**
 * Incremental .sbsproc export (V0.3.2.14): assemble the mp4 from the cache,
 * then pack it with a manifest built from the assembly's OWN exact markers —
 * the same numbers the audio and TOC use, so the viewer's step windows match
 * the video by construction.
 */
export async function assembleToSbsProc(opts = {}) {
  const ve = await import('./video-export.js');
  const r = await assembleFromCache(opts);
  const rf = await window.sbsNative.readFile(r.path, 'buffer');
  if (!rf?.ok) throw new Error('assembled mp4 read failed: ' + rf?.error);
  const bytes = rf.data instanceof Uint8Array ? rf.data : new Uint8Array(rf.data);
  const manifest = ve.buildSbsProcManifest({ stepMarkers: r.stepMarkers, totalDurationMs: r.totalMs });
  const blob = ve.packSbsProcBlob(manifest, bytes);
  return { ...r, blob, manifest, extension: 'sbsproc', totalDurationMs: r.totalMs };
}

export async function renderMissingSegments({ onProgress, signal, force = false, forceStepIds = null } = {}) {
  const { exportTimelineVideo } = await import('./video-export.js');
  onProgress?.({ stepName: 'fingerprinting steps… (a few seconds on big projects)' });
  const plan = await planWithCacheStatus();
  if (!plan.dir) throw new Error('Save the project first — the cache lives next to the .sbsproj.');
  if (force) { for (const s of plan.spans) s.cached = false; plan.hits = 0; }   // human override: re-render everything
  else if (forceStepIds?.size) {
    // Surgical override (user design): re-render the segments CONTAINING the
    // selected steps. A step inside a group forces its whole group's segment
    // (a group IS one segment); the previous step is the render's starting
    // pose automatically; the following segment needs nothing (end states are
    // identical by construction).
    for (const s of plan.spans) if (s.steps.some(st => forceStepIds.has(st.id))) s.cached = false;
    plan.hits = plan.spans.filter(s => s.cached).length;
  }
  const misses = plan.spans.filter(s => !s.cached);
  let done = 0, failed = 0;
  for (const span of misses) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    onProgress?.({ current: done + 1, total: misses.length, stepName: span.name });
    try {
      const isFirst = span.from === 0;
      // Honor the project's export settings (V0.3.2.22) — without these the
      // segments silently rendered at the built-in defaults (50fps/400ms/8M)
      // while the cache key claimed the configured values.
      const exp = state.get('export') || {};
      const res = await exportTimelineVideo({
        format: 'mp4', offline: true,
        fps:        Number.isFinite(Number(exp.fps))          ? Number(exp.fps)          : 50,
        stepHoldMs: Number.isFinite(Number(exp.stepHoldMs))   ? Number(exp.stepHoldMs)   : 800,
        bitrate:    Number.isFinite(Number(exp.videoBitrate)) ? Number(exp.videoBitrate) : 4_000_000,
        includeNarration: true,           // narration-TIMED holds…
        _noAudioTrack: true,              // …but no audio in the file
        _noHeader: true,                  // header layer composites at assembly
        _stepsRange: [isFirst ? 0 : span.from - 1, span.to],
        _zeroLeadHold: !isFirst,          // first segment = its own hold, no lead
        _noAutoSync: true,
      });
      const bytes = new Uint8Array(await res.blob.arrayBuffer());
      let w = await window.sbsNative.writeFile(`${plan.dir}/seg-${span.key}.mp4`, bytes, null);
      if (!w?.ok) throw new Error(w?.error || 'mp4 write failed');
      // Sidecar: duration + step offsets INSIDE the segment (assembly needs
      // these for audio placement + global markers). Marker times are already
      // encoded-frame times relative to the segment's own t=0.
      const inSpan = new Set(span.steps.map(s => s.id));
      const sidecar = {
        key: span.key, durationMs: res.totalDurationMs,
        epoch: RENDER_CACHE_EPOCH,   // cache generation — the purge deletes anything not from the current one
        fps: Number.isFinite(Number(exp.fps)) ? Number(exp.fps) : 50,   // for the phantom-frame correction at assembly
        steps: (res.stepMarkers || [])
          .filter(m => inSpan.has(m.stepId))          // drop the zero-frame lead step's marker
          .map(m => ({ stepId: m.stepId, ms: m.timeInMs })),
      };
      w = await window.sbsNative.writeFile(`${plan.dir}/seg-${span.key}.json`, JSON.stringify(sidecar), 'utf8');
      if (!w?.ok) throw new Error(w?.error || 'sidecar write failed');
      span.cached = true;          // this run's plan now knows the file exists
      done++;
    } catch (e) {
      console.warn(`[render-cache] segment "${span.name}" failed:`, e?.message);
      failed++;
      if (e?.name === 'AbortError') throw e;
    }
  }
  // FINAL SETTLE PASS (V0.3.2.22): playback is over — every step has been
  // activated and the data is as settled as this session gets. A span's steps
  // can still be mutated AFTER its own render (the lead step belongs to the
  // previous span; cable arrangements write back onto earlier defining
  // steps), so keying any earlier is too early. Re-key EVERY cached span now
  // and re-file any segment whose fingerprint moved — disk ends up keyed
  // exactly as the next plan will compute, so the next export HITS.
  let rekeyed = 0;
  // (step views are computed fresh per span — nothing cached to invalidate)
  for (const span of plan.spans) {
    if (!span.cached) continue;
    const oldKey = span.key;
    await _keySpan(span, plan);
    if (span.key === oldKey) continue;
    try {
      const mp4 = await window.sbsNative.readFile(`${plan.dir}/seg-${oldKey}.mp4`, 'buffer');
      const sj  = await window.sbsNative.readFile(`${plan.dir}/seg-${oldKey}.json`, 'utf8');
      if (!mp4?.ok || !sj?.ok) throw new Error('source segment unreadable');
      const sc = JSON.parse(sj.data); sc.key = span.key;
      const b = mp4.data instanceof Uint8Array ? mp4.data : new Uint8Array(mp4.data);
      let w = await window.sbsNative.writeFile(`${plan.dir}/seg-${span.key}.mp4`, b, null);
      if (!w?.ok) throw new Error(w?.error || 'mp4 copy failed');
      w = await window.sbsNative.writeFile(`${plan.dir}/seg-${span.key}.json`, JSON.stringify(sc), 'utf8');
      if (!w?.ok) throw new Error(w?.error || 'sidecar copy failed');
      span.file = `${plan.dir}/seg-${span.key}.mp4`;
      rekeyed++;
    } catch (e) {
      // Copy failed → keep pointing at the file that DOES exist so this
      // run's assembly still works; the next plan will just miss this span.
      console.warn(`[render-cache] settle re-file of "${span.name}" failed:`, e?.message);
      span.key = oldKey;
      span.file = `${plan.dir}/seg-${oldKey}.mp4`;
    }
  }
  if (rekeyed) console.log(`[render-cache] settle pass: ${rekeyed} segment(s) re-filed under settled fingerprints`);

  // Record this fill's key inputs so the next plan can NAME the cause of any
  // mass invalidation (V0.3.2.20).
  if (done > 0 && !failed) {
    try {
      await window.sbsNative.writeFile(`${plan.dir}/_keyinputs.json`,
        JSON.stringify({ settings: plan.settingsKey, defs: plan.defsKey }), 'utf8');
    } catch { /* best-effort */ }
  }

  // Return THE PLAN too (V0.3.2.9): rendering mutates project data mid-run
  // (overlay self-heals, narration stamps on step activation), so fingerprints
  // recomputed AFTER the fill can differ from the ones the files were written
  // under. One run = one plan — the assembly must consume THIS plan, never
  // re-derive it.
  return { rendered: done, reused: plan.hits, failed, dir: plan.dir, total: plan.spans.length, plan };
}

/** Plan + check which segments already exist in <project>/_rendercache/. */
export async function planWithCacheStatus() {
  const plan = await computeSegmentPlan();
  // 🌍 Each language renders into its own cache folder, so two languages of
  // the same project stay warm side by side instead of evicting each other
  // (segment keys already differ by content; this keeps the PURGE passes from
  // treating the inactive language's segments as orphans).
  // V0.3.2.124 — now <project>/render/<lang>/, part of the project folder
  // layout. A project whose segments were rendered under the older
  // _rendercache path keeps using it, so nobody loses a warm cache to the
  // rename; new projects (and any language rendered from now on) use the
  // layout path.
  const _rc = projectPaths.renderCacheDir();
  let dir = _rc.dir;
  if (dir && _rc.legacy && window.sbsNative?.fileExists) {
    // Prefer whichever already holds this language's segments.
    const modernSeen = await window.sbsNative.fileExists(dir);
    if (!modernSeen && await window.sbsNative.fileExists(_rc.legacy)) dir = _rc.legacy;
  }
  let hits = 0;
  for (const span of plan.spans) {
    span.file   = dir ? `${dir}/seg-${span.key}.mp4` : null;
    span.cached = false;
    if (span.file && window.sbsNative?.fileExists) {
      // B5/M7 (V0.3.2.109): a hit requires the .mp4 AND its seg-<key>.json
      // timing sidecar. A crash mid-render leaves the mp4 without the
      // sidecar; treating that orphan as cached made readTimeline fail and
      // assembly wedge FOREVER (purgeOrphans skips plan-referenced keys, and
      // it only runs after a successful assembly, which never came). As a
      // plain miss it re-renders and rewrites both files — self-healing.
      try {
        span.cached = !!(await window.sbsNative.fileExists(span.file))
                   && !!(await window.sbsNative.fileExists(`${dir}/seg-${span.key}.json`));
      } catch { /* treat as miss */ }
    }
    if (span.cached) hits++;
  }
  const out = { ...plan, dir, hits, misses: plan.spans.length - hits };
  if (dir) await _reportPlanDrift(out, dir);

  // WHY-INVALIDATED report (V0.3.2.20): when most of the cache missed, diff
  // the current key inputs against the ones recorded at the last successful
  // fill and NAME the cause — no more silent full re-renders.
  if (dir && out.misses > plan.spans.length / 2) {
    try {
      const prev = await window.sbsNative.readFile(`${dir}/_keyinputs.json`, 'utf8');
      if (prev?.ok) {
        const old = JSON.parse(prev.data);
        const parts = [];
        // V0.3.2.157 — 'overlay' included. Without it, a full re-render caused
        // by editing a shape style, a linked shape or a pinned position was
        // reported with no cause at all, which is how .150's broken keying
        // stayed invisible: the one report that exists to explain a mass
        // invalidation could not name the input that triggered it.
        const _label = { prims: 'primitives', overlay: 'overlay definitions (shape styles / links / pinned positions)' };
        for (const k of ['prims', 'shapes', 'colors', 'cables', 'overlay']) {
          if (JSON.stringify(old.defs?.[k]) !== JSON.stringify(plan.defsKey[k])) parts.push(_label[k] || k);
        }
        if (JSON.stringify(old.settings) !== JSON.stringify(plan.settingsKey)) parts.push('render settings');
        if (parts.length) {
          out.invalidationHint = `cache mass-invalidated because DEFINITIONS changed: ${parts.join(', ')} (your rule: project-wide change → render everything)`;
          console.warn('[render-cache] ' + out.invalidationHint);
        }
      }
    } catch { /* report is best-effort */ }
  }
  return out;
}
