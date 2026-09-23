'use strict';

/**
 * 📦 Collect project — the ZIP writer (V0.3.4.101).
 * ───────────────────────────────────────────────
 * Streams files into one .zip for "take this project to another computer"
 * (3ds Max's Archive, After Effects' Collect Files). Written here, in the main
 * process, with Node's fs + zlib.crc32 only: no library (the enterprise SBOM
 * audit), no external exe.
 *
 *   • STORE, no compression. What weighs — mp4 clips, the gzipped .sbsproj,
 *     tessellated models — does not compress usefully, and store is I/O-bound.
 *   • zip64 whenever an entry or the archive itself passes 4 GB, or there are
 *     more than 65 535 entries. A 20 GB collect is a normal day.
 *   • Data descriptors (bit 3): the CRC and size follow each entry, so a file
 *     is read ONCE, streamed. Every mainstream reader (Explorer, 7-Zip, macOS
 *     Archive Utility, bsdtar) handles this.
 *   • UTF-8 names (bit 11), forward slashes, DOS times from mtime.
 *
 * Jobs: begin → addFile / addText (any order, any count) → finish. A failing
 * file (unreadable, vanished, a share that will not let us read) is reported
 * back and the job carries on — the renderer decides what to write into the
 * collected project for it.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const crc32 = typeof zlib.crc32 === 'function'
  ? (buf, prev = 0) => zlib.crc32(buf, prev)
  : (() => {                                   // Node < 22.2 — table fallback
      const T = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c; }
      return (buf, prev = 0) => { let c = ~prev; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return ~c >>> 0; };
    })();

const FOUR_GB = 0xFFFFFFFF;
const jobs = new Map();   // token → job
let _seq = 0;

function _dosTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const y = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((y - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function _u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF, 0); return b; }
function _u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v) >>> 0, 0); return b; }
function _u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }

function _cleanName(dst) {
  return String(dst || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

/** Write a buffer at the job's current offset (awaited; the stream applies back-pressure). */
function _write(job, buf) {
  job.offset += buf.length;
  if (job.out.write(buf)) return Promise.resolve();
  return new Promise((res) => job.out.once('drain', res));
}

async function _localHeader(job, name, mtimeMs, zip64) {
  const nameBuf = Buffer.from(name, 'utf8');
  const { time, date } = _dosTime(mtimeMs);
  const extra = zip64 ? Buffer.concat([_u16(0x0001), _u16(16), _u64(0), _u64(0)]) : Buffer.alloc(0);
  const head = Buffer.concat([
    _u32(0x04034b50), _u16(zip64 ? 45 : 20), _u16(0x0808), _u16(0), _u16(time), _u16(date),
    _u32(0), _u32(zip64 ? FOUR_GB : 0), _u32(zip64 ? FOUR_GB : 0),
    _u16(nameBuf.length), _u16(extra.length), nameBuf, extra,
  ]);
  await _write(job, head);
}

async function _descriptor(job, crc, size, zip64) {
  await _write(job, Buffer.concat([_u32(0x08074b50), _u32(crc), zip64 ? _u64(size) : _u32(size), zip64 ? _u64(size) : _u32(size)]));
}

function _record(job, { name, crc, size, offset, mtimeMs, zip64 }) {
  job.entries.push({ name, crc, size, offset, mtimeMs, zip64 });
}

// ─── API ─────────────────────────────────────────────────────────────────

function begin(zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const out = fs.createWriteStream(zipPath, { flags: 'w' });
  const token = `c${++_seq}_${Date.now().toString(36)}`;
  const job = { token, zipPath, out, offset: 0, entries: [], failed: [], error: null };
  out.on('error', (e) => { job.error = e; });
  jobs.set(token, job);
  return token;
}

/** Stream one file in. Resolves { ok, size } or { ok:false, error } (the job continues). */
async function addFile(token, src, dst, onChunk) {
  const job = jobs.get(token);
  if (!job) return { ok: false, error: 'no such collect job' };
  const name = _cleanName(dst);
  let st;
  try { st = fs.statSync(src); } catch (e) { const r = { ok: false, error: e.code || e.message }; job.failed.push({ src, dst: name, error: r.error }); return r; }
  if (st.isDirectory()) { const r = { ok: false, error: 'is a directory' }; job.failed.push({ src, dst: name, error: r.error }); return r; }
  const zip64 = st.size >= FOUR_GB || job.offset >= FOUR_GB;
  const offset = job.offset;
  // Probe before committing a header: a share that stats but will not read
  // must not leave a headless entry behind.
  try { const fd = fs.openSync(src, 'r'); fs.closeSync(fd); }
  catch (e) { const r = { ok: false, error: e.code || e.message }; job.failed.push({ src, dst: name, error: r.error }); return r; }
  await _localHeader(job, name, st.mtimeMs, zip64);
  let crc = 0, size = 0;
  try {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
      rs.on('error', reject);
      rs.on('data', (chunk) => {
        rs.pause();
        crc = crc32(chunk, crc); size += chunk.length;
        _write(job, chunk).then(() => { try { onChunk?.(chunk.length); } catch {} rs.resume(); }, reject);
      });
      rs.on('end', resolve);
    });
  } catch (e) {
    // Mid-stream failure: the entry cannot be made whole. Mark the job so
    // finish() refuses — a half archive must never look like a good one.
    job.error = e;
    const r = { ok: false, error: e.code || e.message, fatal: true };
    job.failed.push({ src, dst: name, error: r.error });
    return r;
  }
  await _descriptor(job, crc, size, zip64);
  _record(job, { name, crc, size, offset, mtimeMs: st.mtimeMs, zip64 });
  return { ok: true, size };
}

/** Add a text / binary entry from memory (the collected .sbsproj, the report). */
async function addText(token, dst, data) {
  const job = jobs.get(token);
  if (!job) return { ok: false, error: 'no such collect job' };
  const name = _cleanName(dst);
  const buf = Buffer.isBuffer(data) ? data : (data instanceof Uint8Array ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(String(data ?? ''), 'utf8'));
  const zip64 = buf.length >= FOUR_GB || job.offset >= FOUR_GB;
  const offset = job.offset, now = Date.now();
  await _localHeader(job, name, now, zip64);
  await _write(job, buf);
  const crc = crc32(buf, 0);
  await _descriptor(job, crc, buf.length, zip64);
  _record(job, { name, crc, size: buf.length, offset, mtimeMs: now, zip64 });
  return { ok: true, size: buf.length };
}

/** Central directory + end records, close. */
async function finish(token) {
  const job = jobs.get(token);
  if (!job) return { ok: false, error: 'no such collect job' };
  jobs.delete(token);
  if (job.error) {
    try { job.out.destroy(); } catch {}
    try { fs.unlinkSync(job.zipPath); } catch {}
    return { ok: false, error: `archive write failed: ${job.error.code || job.error.message}` };
  }
  const cdStart = job.offset;
  for (const e of job.entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = _dosTime(e.mtimeMs);
    const needSize = e.size >= FOUR_GB, needOff = e.offset >= FOUR_GB;
    const z64 = needSize || needOff || e.zip64;
    let extra = Buffer.alloc(0);
    if (z64) {
      const parts = [];
      if (needSize || e.zip64) { parts.push(_u64(e.size), _u64(e.size)); }
      if (needOff) parts.push(_u64(e.offset));
      const body = Buffer.concat(parts);
      extra = Buffer.concat([_u16(0x0001), _u16(body.length), body]);
    }
    await _write(job, Buffer.concat([
      _u32(0x02014b50), _u16(45), _u16(z64 ? 45 : 20), _u16(0x0808), _u16(0), _u16(time), _u16(date),
      _u32(e.crc), _u32((needSize || e.zip64) ? FOUR_GB : e.size), _u32((needSize || e.zip64) ? FOUR_GB : e.size),
      _u16(nameBuf.length), _u16(extra.length), _u16(0), _u16(0), _u16(0), _u32(0), _u32(needOff ? FOUR_GB : e.offset),
      nameBuf, extra,
    ]));
  }
  const cdSize = job.offset - cdStart;
  const n = job.entries.length;
  const big = n >= 0xFFFF || cdStart >= FOUR_GB || cdSize >= FOUR_GB;
  if (big) {
    const eocd64At = job.offset;
    await _write(job, Buffer.concat([
      _u32(0x06064b50), _u64(44), _u16(45), _u16(45), _u32(0), _u32(0), _u64(n), _u64(n), _u64(cdSize), _u64(cdStart),
    ]));
    await _write(job, Buffer.concat([_u32(0x07064b50), _u32(0), _u64(eocd64At), _u32(1)]));
  }
  await _write(job, Buffer.concat([
    _u32(0x06054b50), _u16(0), _u16(0), _u16(big ? 0xFFFF : n), _u16(big ? 0xFFFF : n),
    _u32(big ? FOUR_GB : cdSize), _u32(big ? FOUR_GB : cdStart), _u16(0),
  ]));
  await new Promise((res, rej) => { job.out.once('error', rej); job.out.end(res); });
  if (job.error) { try { fs.unlinkSync(job.zipPath); } catch {} return { ok: false, error: `archive write failed: ${job.error.code || job.error.message}` }; }
  return { ok: true, bytes: job.offset, count: n, failed: job.failed, zip64: big || job.entries.some(e => e.zip64) };
}

function abort(token) {
  const job = jobs.get(token);
  if (!job) return false;
  jobs.delete(token);
  try { job.out.destroy(); } catch {}
  try { fs.unlinkSync(job.zipPath); } catch {}
  return true;
}

module.exports = { begin, addFile, addText, finish, abort };
