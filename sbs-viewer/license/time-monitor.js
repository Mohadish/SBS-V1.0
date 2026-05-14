'use strict';

/**
 * SBS — System-clock tampering monitor
 * ====================================
 * Defends against the simplest license-bypass: user sets their system
 * clock to last week (or last year) to make an expired license appear
 * valid again. We can't STOP that (anyone with admin rights can lie to
 * the OS), but we can SLOW IT DOWN — and that's enough for casual abuse.
 *
 * STRATEGY
 *   On every launch, write `userData/last-seen.json` with:
 *     - `date`     YYYY-MM-DD (today, per current system clock)
 *     - `monoMs`   Date.now() at write time
 *   On subsequent launches:
 *     - If current Date.now() is LESS than stored monoMs → clock rolled back.
 *     - Otherwise update to current.
 *
 *   The verifier consults `safeToday()` instead of raw `new Date()` —
 *   it returns the MAX of (system date, stored last-seen date), so a user
 *   who rolls their clock back still sees the most-recent date we ever
 *   observed. This means rolling back doesn't reduce daysRemaining
 *   either (i.e. doesn't extend the license).
 *
 *   `tampered()` returns true on a launch where rollback was detected.
 *   The renderer can surface a warning toast — informational, not a
 *   hard-lock (we don't want to brick legitimate users whose CMOS battery
 *   died and reset their clock to 2000).
 *
 * THREAT MODEL
 *   - Stops: casual "set clock back to renew" attempts.
 *   - Does NOT stop: deleting last-seen.json (we recreate it cleanly).
 *   - Does NOT stop: editing last-seen.json to a future date (the file is
 *                    not signed — encrypting it would buy nothing because
 *                    the decryption key would have to ship with the app).
 *
 *   Determined attackers will bypass this. Casual users won't.
 */

const fs   = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const FILENAME = 'last-seen.json';

let _tamperedThisRun = false;

function _filePath() {
  return path.join(app.getPath('userData'), FILENAME);
}

function _todayDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _readSeen() {
  try {
    const raw = fs.readFileSync(_filePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.date === 'string' && typeof obj.monoMs === 'number') return obj;
  } catch {}
  return null;
}

function _writeSeen(date, monoMs) {
  const target = _filePath();
  const tmp    = target + '.tmp';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ date, monoMs }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn('[time-monitor] could not persist last-seen:', err.message);
  }
}

/**
 * Run ONCE at app boot (called from main.js). Compares the stored
 * "last seen" timestamp to current system time, sets the in-process
 * tampered flag if rollback is detected, then advances the stored value
 * to whichever is later (so the high-water mark only moves forward).
 */
function recordLaunch() {
  const nowMs = Date.now();
  const seen  = _readSeen();
  if (seen) {
    if (nowMs < seen.monoMs - 60_000) {   // 60s slack for NTP drift, suspend/resume etc.
      _tamperedThisRun = true;
      console.warn('[time-monitor] system clock rolled back. Was:',
                   new Date(seen.monoMs).toISOString(),
                   'now:', new Date(nowMs).toISOString());
    }
  }
  // Always advance the high-water mark.
  const wallDate = _todayDateStr(new Date(Math.max(nowMs, seen?.monoMs ?? 0)));
  const wallMs   = Math.max(nowMs, seen?.monoMs ?? 0);
  _writeSeen(wallDate, wallMs);
}

/**
 * Returns YYYY-MM-DD for whichever is later:
 *   - the current system date
 *   - the stored last-seen date
 *
 * The verifier uses this for expiry math so a rollback can't make an
 * expired license look valid. Computes from disk on every call — cheap
 * and ensures the value isn't stale if the renderer holds an old IPC
 * response across mid-session date changes.
 */
function safeToday() {
  const now = new Date();
  const sysStr = _todayDateStr(now);
  const seen = _readSeen();
  if (!seen?.date) return sysStr;
  // Lexical compare works for YYYY-MM-DD.
  return sysStr > seen.date ? sysStr : seen.date;
}

function tampered() { return _tamperedThisRun; }

module.exports = { recordLaunch, safeToday, tampered };
