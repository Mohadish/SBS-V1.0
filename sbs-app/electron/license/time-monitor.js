'use strict';

/**
 * SBS — System-clock tampering monitor
 * ====================================
 * Defends against the simplest license-bypass: the user sets the system clock
 * back to make an expired license look valid again. Nobody can STOP that —
 * anyone with admin rights can lie to the OS — so the app keeps its own memory
 * of the latest date it has ever seen (a HIGH-WATER MARK) and does its expiry
 * maths against max(system date, mark). Rolling the clock back then buys
 * nothing: the app still remembers today.
 *
 * ── WHAT CHANGED IN V0.3.4.63, AND WHY ─────────────────────────────────────
 * The mark used to live in ONE unsigned file, userData/last-seen.json. Delete
 * it in Notepad, roll the clock back, done: the defence was one keystroke deep,
 * and deleting it cost the attacker nothing.
 *
 *   1. THE MARK NOW LIVES INSIDE license.json — the file that MUST exist for
 *      the app to run at all. "Delete the tamper file" now means "delete your
 *      licence": it sends you back to the activation dialog. Deletion stops
 *      being free. (Mohadish's design.)
 *
 *   2. IT IS SIGNED, WITH A KEY NOBODY SHIPS. An HMAC keyed by
 *      HKDF(licence key, machine ID). The licence key is per-customer, so there
 *      is no single secret baked into the app to extract: breaking your own
 *      file teaches you nothing about anyone else's. And a mark copied from
 *      another machine, or from before activation, fails its MAC. It is a MAC
 *      and not encryption on purpose — nobody cares who READS the date, only
 *      that it cannot be CHANGED unnoticed.
 *
 *   3. A SECOND COPY in the registry (HKCU\Software\SBS Step Browser). The
 *      answer is always the MAX of every copy that verifies, so removing one
 *      heals from the other.
 *
 * ── THE RULE THAT MATTERS MORE THAN THE CRYPTO ─────────────────────────────
 * A missing, unreadable or forged mark is IGNORED — never punished. It counts
 * as "no mark here" and the other copies decide. The people who lose a mark in
 * real life are paying customers: a reinstall, a new Windows profile, IT
 * wiping AppData, a restored backup, a registry the policy will not let us
 * write. A defence that strands one of them is worse than the hole it closes.
 * For the same reason every copy can only ever push the date FORWARD (we take
 * the max), so the unsigned legacy file is harmless: editing it can only hurt
 * the person editing it.
 *
 * ── THREAT MODEL, HONESTLY ─────────────────────────────────────────────────
 *   Stops     : rolling the clock back; deleting or editing last-seen.json;
 *               editing the mark inside license.json; pasting in a mark from
 *               elsewhere.
 *   Costs more: deleting license.json (you must re-activate — and the registry
 *               copy puts the mark straight back).
 *   Does NOT stop: someone who learns there are two copies, removes both, and
 *               re-activates; or who snapshots both on day one and restores
 *               them later. Only an online check closes that. It is deliberate
 *               that no copy is hidden anywhere obscure — that is how malware
 *               behaves, and on an audited enterprise machine it is a worse
 *               look than the hole.
 *
 *   A clock set far FORWARD by mistake, with SBS launched before it is fixed,
 *   burns the licence: the mark is now in the future and will not come back.
 *   (That was already true.) The cure is a re-issued key — a new key makes a
 *   new MAC key, and marks signed under the old one stop verifying.
 */

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { app } = require('electron');

const LEGACY_FILE  = 'last-seen.json';
const LICENSE_FILE = 'license.json';
const REG_KEY      = 'HKCU\\Software\\SBS Step Browser';
const REG_VALUE    = 'State';
const REG_TIMEOUT  = 4000;

let _tamperedThisRun = false;

const _userData = () => app.getPath('userData');

function _dateStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── the signing key: derived, never stored, never shipped ─────────────────

/** { email, password, key } as saved, or null. Read directly (not through
 *  store.js) so this module depends on nothing but the file. */
function _readLicenseFile() {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(_userData(), LICENSE_FILE), 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

function _macKey(licenseKey) {
  if (!licenseKey) return null;
  let machineId = '';
  try { machineId = require('./machine-id').getMachineIdCached(); } catch { /* keyed by the licence alone */ }
  try {
    return Buffer.from(crypto.hkdfSync('sha256',
      Buffer.from(String(licenseKey).replace(/\s+/g, ''), 'utf8'),
      Buffer.from(String(machineId), 'utf8'),
      Buffer.from('sbs-hwm-v1', 'utf8'), 32));
  } catch { return null; }
}

const _mac = (key, ms) => crypto.createHmac('sha256', key).update(`hwm|${ms}`).digest('hex');

/** A signed record → its ms, or 0 if it does not verify under this key. */
function _verified(rec, key) {
  if (!rec || !key) return 0;
  const ms = Number(rec.ms);
  if (!Number.isFinite(ms) || ms <= 0 || typeof rec.mac !== 'string') return 0;
  const want = Buffer.from(_mac(key, ms), 'hex');
  let got; try { got = Buffer.from(rec.mac, 'hex'); } catch { return 0; }
  if (got.length !== want.length) return 0;
  return crypto.timingSafeEqual(got, want) ? ms : 0;
}

// ── the three places a mark can be ────────────────────────────────────────

function _readLegacy() {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(_userData(), LEGACY_FILE), 'utf8'));
    const ms = Number(obj?.monoMs);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch { return 0; }
}

function _writeLegacy(ms) {
  const target = path.join(_userData(), LEGACY_FILE);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target + '.tmp', JSON.stringify({ date: _dateStr(ms), monoMs: ms }, null, 2), 'utf8');
    fs.renameSync(target + '.tmp', target);
  } catch (err) { console.warn('[time-monitor] could not persist last-seen:', err.message); }
}

function _readRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', REG_VALUE],
      { encoding: 'utf8', timeout: REG_TIMEOUT, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /REG_SZ\s+(\S+)/.exec(out || '');
    return m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null;
  } catch { return null; }          // no key yet, or a policy that forbids it: simply no copy here
}

function _writeRegistry(rec) {
  if (process.platform !== 'win32') return;
  try {
    const b64 = Buffer.from(JSON.stringify(rec), 'utf8').toString('base64');
    execFileSync('reg', ['add', REG_KEY, '/v', REG_VALUE, '/t', 'REG_SZ', '/d', b64, '/f'],
      { timeout: REG_TIMEOUT, windowsHide: true, stdio: 'ignore' });
  } catch { /* a locked-down machine keeps the file copy; that is enough */ }
}

/** Write the mark into license.json WITHOUT disturbing anything else in it. */
function _writeIntoLicense(rec) {
  const target = path.join(_userData(), LICENSE_FILE);
  try {
    const obj = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!obj || typeof obj !== 'object') return;
    obj.hwm = rec;
    fs.writeFileSync(target + '.tmp', JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(target + '.tmp', target);
  } catch { /* no licence on disk: nothing to carry it */ }
}

// ── the mark ──────────────────────────────────────────────────────────────

/**
 * The latest moment any trustworthy copy remembers (0 = none). `licenseKey`
 * names the key to verify the signed copies under; by default, the licence on
 * disk. The unsigned legacy file always counts — it can only push forward.
 */
function currentMark(licenseKey) {
  const lic = _readLicenseFile();
  const key = _macKey(licenseKey ?? lic?.key);
  return Math.max(
    _readLegacy(),
    _verified(lic?.hwm, key),
    _verified(_readRegistry(), key),
  );
}

/** Persist `ms` to every place, signed under the licence now on disk. */
function writeMark(ms) {
  if (!(ms > 0)) return;
  _writeLegacy(ms);
  const key = _macKey(_readLicenseFile()?.key);
  if (!key) return;                                   // not activated: nothing to sign with
  const rec = { ms, mac: _mac(key, ms) };
  _writeIntoLicense(rec);
  _writeRegistry(rec);
}

/**
 * Run ONCE at app boot (called from main.js), and again whenever the licence
 * is re-checked. Flags a rollback, then moves the mark forward — it only ever
 * moves forward.
 */
function recordLaunch() {
  const nowMs = Date.now();
  const mark  = currentMark();
  if (mark && nowMs < mark - 60_000) {                // 60s slack for NTP drift, suspend/resume etc.
    _tamperedThisRun = true;
    console.warn('[time-monitor] system clock rolled back. Was:',
                 new Date(mark).toISOString(), 'now:', new Date(nowMs).toISOString());
  }
  writeMark(Math.max(nowMs, mark));
}

/**
 * Returns YYYY-MM-DD for whichever is later: the system date, or the mark.
 * The verifier uses this for expiry maths so a rollback can't make an expired
 * license look valid. Read from disk on every call — cheap, and never stale.
 */
function safeToday() {
  const sys = _dateStr(Date.now());
  const mark = currentMark();
  if (!mark) return sys;
  const seen = _dateStr(mark);
  return sys > seen ? sys : seen;                     // lexical compare works for YYYY-MM-DD
}

function tampered() { return _tamperedThisRun; }

module.exports = { recordLaunch, safeToday, tampered, currentMark, writeMark };
