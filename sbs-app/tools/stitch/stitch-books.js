#!/usr/bin/env node
/*
 * SBS BOOK STITCHER (Road B) — combine per-book video exports into ONE video
 * with a table-of-contents intro, computing chapter timecodes from the REAL
 * renders (each book's .sbsproc marker manifest + measured duration — never the
 * fragile animation-timing estimate). Incremental: books whose source .sbsproj
 * hasn't changed since the last stitch are flagged so you only re-export what
 * actually changed.
 *
 *   node stitch-books.js <manifest.json>          # PLAN: which books changed + the TOC (no ffmpeg)
 *   node stitch-books.js <manifest.json> --run     # BUILD the final video
 *
 * manifest.json (paths relative to the manifest file):
 * {
 *   "output": "final-stitched.mp4",
 *   "toc": { "title": "GEN.9 Multi-Jig Calibration", "durationSec": 6 },
 *   "books": [
 *     { "title": "Part 1 — Setup",       "export": "part-1.sbsproc", "sbsproj": "part-1.sbsproj" },
 *     { "title": "Part 2 — Calibration", "export": "part-2.sbsproc", "sbsproj": "part-2.sbsproj" }
 *   ]
 * }
 *   export  = the app's per-book export (.sbsproc preferred → carries chapter markers;
 *             a plain .mp4 also works but gives a book-level TOC only).
 *   sbsproj = optional, only for change-detection (skip-unchanged reporting).
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { execFileSync } = require('child_process');

const FFMPEG  = path.join(__dirname, 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(__dirname, 'bin', 'ffprobe.exe');

const MAN = process.argv[2];
const RUN = process.argv.includes('--run');
if (!MAN) { console.error('usage: node stitch-books.js <manifest.json> [--run]'); process.exit(2); }
const manDir = path.dirname(path.resolve(MAN));
const man = JSON.parse(fs.readFileSync(MAN, 'utf8'));
const rel = (p) => path.isAbsolute(p) ? p : path.join(manDir, p);
const statePath = MAN + '.state.json';
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { hashes: {} };

const fmtTime = (ms) => { const s = Math.round(ms / 1000); const m = Math.floor(s / 60), r = s % 60; return `${m}:${String(r).padStart(2, '0')}`; };
const hashFile = (p) => { try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12); } catch { return null; } };

function unpackSbsproc(buf) {
  if (buf.slice(0, 8).toString('ascii') !== 'SBSPROC1') return null;
  const mlen = buf.readUInt32LE(8);
  return { manifest: JSON.parse(buf.slice(12, 12 + mlen).toString('utf8')), mp4: buf.slice(12 + mlen) };
}
function probeDurationMs(mp4Path) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mp4Path], { encoding: 'utf8' });
  return Math.round((JSON.parse(out).format?.duration || 0) * 1000);
}
function probeVideoParams(mp4Path) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,pix_fmt', '-of', 'json', mp4Path], { encoding: 'utf8' });
  const s = JSON.parse(out).streams[0];
  return { w: s.width, h: s.height, fps: s.r_frame_rate, pix: s.pix_fmt };
}
// Pull TOC entries (name + time_in_ms) out of a .sbsproc manifest. Handles the
// common shapes; falls back to a single book-level entry if none found.
function tocEntriesFromManifest(m) {
  const src = m.entries || m.chapters || m.steps || m.markers || [];
  const out = [];
  for (const e of src) {
    const t = e.time_in_ms ?? e.timeInMs ?? e.time ?? null;
    const name = e.title || e.name || e.label || null;
    if (t != null && name) out.push({ ms: t, name });
  }
  return out;
}

// ── Gather each book: extract mp4 (if .sbsproc), duration, TOC entries, change ──
const books = [];
const tmpDir = path.join(manDir, '_stitch-tmp');
if (RUN && !fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
for (let i = 0; i < man.books.length; i++) {
  const b = man.books[i];
  const exportPath = rel(b.export);
  const isProc = exportPath.toLowerCase().endsWith('.sbsproc');
  let mp4Path = exportPath, manifest = null;
  if (isProc) {
    const parsed = unpackSbsproc(fs.readFileSync(exportPath));
    if (!parsed) throw new Error(`${b.export} is not a valid .sbsproc`);
    manifest = parsed.manifest;
    mp4Path = path.join(tmpDir, `book${i}.mp4`);
    if (RUN) fs.writeFileSync(mp4Path, parsed.mp4);
  }
  const srcHash = b.sbsproj ? hashFile(rel(b.sbsproj)) : null;
  const changed = b.sbsproj ? (state.hashes[b.sbsproj] !== srcHash) : null;
  const durationMs = manifest?.total_duration_ms ?? (RUN ? probeDurationMs(mp4Path) : null);
  const toc = manifest ? tocEntriesFromManifest(manifest) : [];
  books.push({ ...b, i, exportPath, mp4Path, isProc, manifest, srcHash, changed, durationMs, toc });
}

// ── Compute the unified TOC (offset each book by the sum of prior durations) ──
// Sequence = [intro books] → [TOC card] → [content books]. A book marked
// "role":"intro" is an opener (title/disclaimers/safety) — it plays FIRST and is
// NOT listed as a chapter in the TOC. The TOC card is rebuilt every run and lists
// the content parts at their REAL positions (after the intro + the card), so
// changing a later book never forces re-rendering the intro.
const tocSec  = man.toc?.durationSec || 6;
const intros  = books.filter(b => b.role === 'intro');
const content = books.filter(b => b.role !== 'intro');
const introMs = intros.reduce((s, b) => s + (b.durationMs || 0), 0);

console.log('=== BOOKS ===');
for (const b of books) {
  const changeTag = b.changed === null ? '' : (b.changed ? '  ⚠ CHANGED since last stitch → re-export' : '  ✓ unchanged');
  const roleTag = b.role === 'intro' ? ' [intro/opener]' : '';
  console.log(`  [${b.i}] ${b.title || b.export}${roleTag}  dur=${b.durationMs != null ? fmtTime(b.durationMs) : '?'}${changeTag}`);
}
// TOC lists CONTENT parts, offset by the intro + the TOC-card duration.
let offset = introMs + tocSec * 1000; const flatToc = [];
for (const b of content) {
  flatToc.push({ ms: offset, name: b.title || `Book ${b.i + 1}`, book: true });
  for (const e of b.toc) flatToc.push({ ms: offset + e.ms, name: e.name, book: false });
  if (b.durationMs != null) offset += b.durationMs;
}
console.log('\n=== TABLE OF CONTENTS (measured from the real renders) ===');
if (intros.length) console.log(`  ${fmtTime(0).padStart(6)}  · intro (${fmtTime(introMs)})`);
for (const e of flatToc) console.log(`  ${fmtTime(e.ms).padStart(6)}  ${e.book ? '▶ ' : '   '}${e.name}`);
console.log(`\n  total: ${fmtTime(offset)}`);

if (!RUN) { console.log('\n(plan only — re-run with --run to build the video)'); process.exit(0); }

// ── Build the TOC intro card matching the books' video params ────────────────
const params = probeVideoParams(books[0].mp4Path);
const esc = (s) => String(s).replace(/[\\:']/g, m => '\\' + m).replace(/%/g, '\\%');
const lines = [{ y: 'h*0.10', size: 64, text: man.toc?.title || 'Contents' }];
flatToc.filter(e => e.book).forEach((e, idx) => lines.push({ y: `h*0.28+${idx}*70`, size: 40, text: `${fmtTime(e.ms)}   ${e.name}` }));
const draw = lines.map(l => `drawtext=text='${esc(l.text)}':fontcolor=white:fontsize=${l.size}:x=(w-text_w)/2:y=${l.y}`).join(',');
const tocMp4 = path.join(tmpDir, '_toc.mp4');
console.log('\nbuilding TOC card...');
execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=black:s=${params.w}x${params.h}:d=${tocSec}:r=${params.fps}`,
  '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', String(tocSec),
  '-vf', draw, '-c:v', 'libx264', '-pix_fmt', params.pix, '-c:a', 'aac', '-shortest', tocMp4], { stdio: 'inherit' });

// ── Concat: TOC + every book (re-encode filter = robust to any param drift) ──
const inputs = [...intros.map(b => b.mp4Path), tocMp4, ...content.map(b => b.mp4Path)];
const outPath = rel(man.output || 'final-stitched.mp4');
const args = [];
inputs.forEach(f => args.push('-i', f));
const n = inputs.length;
const filter = inputs.map((_, k) => `[${k}:v:0][${k}:a:0]`).join('') + `concat=n=${n}:v=1:a=1[v][a]`;
console.log('stitching final video...');
execFileSync(FFMPEG, ['-y', ...args, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', params.pix, '-c:a', 'aac', outPath], { stdio: 'inherit' });

// ── Save state (source hashes) so next run knows which books changed ─────────
for (const b of books) if (b.sbsproj) state.hashes[b.sbsproj] = b.srcHash;
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(`\n✓ wrote ${outPath}`);
