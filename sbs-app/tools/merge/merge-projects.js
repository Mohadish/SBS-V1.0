#!/usr/bin/env node
/*
 * Merge two SAME-SOURCE .sbsproj halves into one, and externalize narration
 * audio to a disk-cache folder so the reunited project stays light.
 *
 *   node --max-old-space-size=4096 merge-projects.js <base.sbsproj> <add.sbsproj> <out.sbsproj> [--audio <folderName>]
 *
 * SAME-SOURCE means the two files share the model/tree node IDs (verify first
 * with merge-check.js — tree-id overlap must be ~100%). Then merging is safe:
 *   • keep ALL of BASE (tree, model, shapes, cables, hardware, colors, header,
 *     settings) — its shared definitions are identical to ADD's;
 *   • union every definition list by id (so any item ADD has that BASE lacks
 *     still comes across — styles/presets/cameras a pasted step might reference);
 *   • append ADD's steps + chapters that BASE doesn't already have (dedup by id
 *     — the shared base/setup steps are kept once, from BASE);
 *   • keep BASE's header + settings (the "into" project wins);
 *   • --audio: move every inline kokoro clip to <out-dir>/<folder>/<voiceSlug>/
 *     <stepSlug>__<hash>.wav (the app's exact scheme) and stamp step.narration
 *     .dataFile, dropping the base64 → file shrinks ~10x.
 */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');

const args = process.argv.slice(2), flags = {}, pos = [];
for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith('--')) flags[a.slice(2)] = args[++i]; else pos.push(a); }
const [BASE, ADD, OUT] = pos;
const AUDIO_FOLDER = flags.audio || null;
if (!BASE || !ADD || !OUT) { console.error('usage: merge-projects.js <base> <add> <out> [--audio <folder>]'); process.exit(2); }

const load = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
const P = load(BASE);   // base — everything is kept from here
const Q = load(ADD);    // add — only its unique steps/chapters + any new defs come across

const stepsOf    = (o) => (o.steps?.items || o.steps || []);
const chaptersOf = (o) => (o.chapters?.items || o.chapters || []);

// ── Union every definition list by id (base wins on collisions) ──────────────
const LIST_KEYS = ['items', 'templates', 'presets', 'groups'];
function unionSection(pSec, qSec) {
  if (!qSec) return pSec;
  if (Array.isArray(pSec) && Array.isArray(qSec)) {
    const seen = new Set(pSec.map(x => x && x.id).filter(Boolean));
    return [...pSec, ...qSec.filter(x => x && x.id && !seen.has(x.id))];
  }
  if (pSec && qSec && typeof pSec === 'object') {
    const out = { ...pSec };
    for (const k of LIST_KEYS) {
      if (Array.isArray(pSec[k]) || Array.isArray(qSec[k])) {
        const pa = pSec[k] || [], qa = qSec[k] || [];
        const seen = new Set(pa.map(x => x && x.id).filter(Boolean));
        out[k] = [...pa, ...qa.filter(x => x && x.id && !seen.has(x.id))];
      }
    }
    return out;
  }
  return pSec;
}

const report = {};
// Union the definition sections (shapes/cables/hardware are identical here; styles/
// presets/cameras/notes unioned so a step from ADD never references a missing def).
for (const key of ['shapes', 'cables', 'hardware', 'cameras', 'colors', 'notes', 'animationPresets', 'styles']) {
  if (P[key] || Q[key]) P[key] = unionSection(P[key], Q[key]);
}

// ── Append ADD's unique steps + chapters (dedup by id) ───────────────────────
const pStepIds = new Set(stepsOf(P).map(s => s.id));
const addSteps = stepsOf(Q).filter(s => !pStepIds.has(s.id));
const pChapIds = new Set(chaptersOf(P).map(c => c.id));
const addChaps = chaptersOf(Q).filter(c => !pChapIds.has(c.id));

if (P.steps?.items) P.steps.items = [...P.steps.items, ...addSteps]; else P.steps = [...stepsOf(P), ...addSteps];
if (P.chapters?.items) P.chapters.items = [...P.chapters.items, ...addChaps]; else P.chapters = [...chaptersOf(P), ...addChaps];
report.baseSteps = pStepIds.size; report.addedSteps = addSteps.length; report.sharedStepsSkipped = stepsOf(Q).length - addSteps.length;
report.addedChapters = addChaps.length;

// ── Externalize narration audio (the app's exact disk-cache scheme) ──────────
const slugify = (s, max = 40) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
const voiceSource = (v) => { const m = /^os:([^|]+)\|/.exec(v || ''); if (m) return m[1].toLowerCase(); const k = /^([a-z0-9_-]+):/i.exec(v || ''); return k ? k[1].toLowerCase() : ''; };
const voiceName   = (v) => { const m = /^os:[^|]+\|(.+)$/.exec(v || ''); if (m) return m[1]; const k = /^[a-z0-9_-]+:(.+)$/i.exec(v || ''); return k ? k[1] : (v || ''); };
const voiceSlug   = (v) => { const s = voiceSource(v), n = voiceName(v); return (s && n) ? (slugify(`${s}-${n}`, 60) || 'voice') : (slugify(v, 60) || 'voice'); };
const isFast      = (v) => { const s = voiceSource(v); return s === 'sapi5' || s === 'onecore'; };
const shortHash   = (text, speed) => crypto.createHash('sha1').update(Buffer.from(`${text}|${Number(speed) || 1}`, 'utf8')).digest().slice(0, 4).toString('hex');
const relPathOf   = (n, step) => `${voiceSlug(n.voiceId)}/${slugify(step.name, 40) || (step.id ? String(step.id).slice(0, 8) : 'step')}__${shortHash(n.text, n.speed)}.wav`;

if (AUDIO_FOLDER) {
  const outDir = path.dirname(path.resolve(OUT));
  const cacheAbs = path.join(outDir, AUDIO_FOLDER);
  let externalized = 0, skippedFast = 0, bytes = 0;
  const written = new Set();
  for (const step of stepsOf(P)) {
    const n = step.narration;
    if (!n?.dataUrl || n.dataFile || !n.text || !n.voiceId) continue;
    if (isFast(n.voiceId)) { skippedFast++; continue; }
    const rel = relPathOf(n, step);
    const full = path.join(cacheAbs, rel);
    if (!written.has(full)) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const b64 = n.dataUrl.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(full, buf);
      written.add(full); bytes += buf.length;
    }
    n.dataFile = rel; delete n.dataUrl;
    externalized++;
  }
  if (!P.settings) P.settings = {};
  P.settings.audioCacheFolder = AUDIO_FOLDER;
  report.audioExternalized = externalized; report.audioFiles = written.size; report.audioSkippedFast = skippedFast; report.audioMB = (bytes / 1e6).toFixed(1);
}

// ── Write merged project ─────────────────────────────────────────────────────
const json = JSON.stringify(P);
const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
fs.writeFileSync(OUT, gz);
report.mergedSteps = stepsOf(P).length; report.mergedChapters = chaptersOf(P).length;
report.outGzMB = (gz.length / 1e6).toFixed(1); report.outJsonMB = (json.length / 1e6).toFixed(1);
console.log(JSON.stringify(report, null, 2));
console.log(`\nwrote ${OUT}`);
