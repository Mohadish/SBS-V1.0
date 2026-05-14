/**
 * SBS Machine ID extractor (JS)
 * =============================
 * Mirrors sbs_license/license_core.py — same hardware sources, same
 * canonicalisation, same SHA-256 truncation. Output MUST match the
 * Python helper byte-for-byte on the same hardware (the license is
 * signed against this exact string).
 *
 * Cross-platform sources (priority order):
 *   Windows  : wmic baseboard SerialNumber | wmic cpu ProcessorId | wmic diskdrive SerialNumber (first)
 *   macOS    : system_profiler SPHardwareDataType (Hardware UUID + Serial Number)
 *   Linux    : /etc/machine-id, then /sys/class/dmi/id/product_uuid, then board_serial
 *
 * Falls back to os.hostname() + os.platform() + os.arch() if nothing
 * else works — better than failing outright on exotic platforms.
 *
 * Runs ONLY in the main process (uses execSync on the OS shell).
 * Renderer reaches it via IPC.
 */

const { execSync }     = require('node:child_process');
const fs               = require('node:fs');
const os               = require('node:os');
const crypto           = require('node:crypto');

// 8-second cap per shell command — matches the Python timeout. wmic can
// be slow on first boot under heavy AV but never this slow in practice.
const SHELL_TIMEOUT_MS = 8_000;

function _run(cmd, args) {
  try {
    const out = execSync([cmd, ...args].join(' '), {
      encoding: 'utf8',
      timeout: SHELL_TIMEOUT_MS,
      windowsHide: true,
    });
    return (out || '').trim();
  } catch {
    return '';
  }
}

function _windowsId() {
  const parts = [];
  // Motherboard serial
  const board = _run('wmic', ['baseboard', 'get', 'SerialNumber', '/value']);
  for (const line of board.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx >= 0) parts.push(line.slice(idx + 1).trim());
  }
  // CPU ID
  const cpu = _run('wmic', ['cpu', 'get', 'ProcessorId', '/value']);
  for (const line of cpu.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx >= 0) parts.push(line.slice(idx + 1).trim());
  }
  // First disk's serial
  const disk = _run('wmic', ['diskdrive', 'get', 'SerialNumber', '/value']);
  for (const line of disk.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const val = line.slice(idx + 1).trim();
    if (val) { parts.push(val); break; }
  }
  return parts
    .filter(p => p && !['to be filled by o.e.m.', 'none', ''].includes(p.toLowerCase()))
    .join('|');
}

function _macId() {
  const out = _run('system_profiler', ['SPHardwareDataType']);
  const parts = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.includes('Hardware UUID') || line.includes('Serial Number')) {
      const idx = line.indexOf(':');
      if (idx >= 0) {
        const val = line.slice(idx + 1).trim();
        if (val) parts.push(val);
      }
    }
  }
  return parts.join('|');
}

function _linuxId() {
  // /etc/machine-id is stable across reboots and unique per install
  try {
    const val = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (val) return val;
  } catch {}
  for (const path of ['/sys/class/dmi/id/product_uuid', '/sys/class/dmi/id/board_serial']) {
    try {
      const val = fs.readFileSync(path, 'utf8').trim();
      if (val) return val;
    } catch {}
  }
  return '';
}

/**
 * Returns a 32-char uppercase hex string — the same value the Python
 * helper produces on this machine. Stable across reboots, changes ONLY
 * when hardware changes (motherboard / disk swap on Win/Linux, machine
 * replacement on Mac).
 */
function getMachineId() {
  let raw = '';
  switch (process.platform) {
    case 'win32':  raw = _windowsId(); break;
    case 'darwin': raw = _macId();     break;
    default:       raw = _linuxId();   break;
  }
  if (!raw) {
    // Last-resort fallback — better than throwing.
    raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.release()}`;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32).toUpperCase();
}

// Cache the result for the lifetime of the process. Hardware doesn't
// change while the app is running, and the shell calls are expensive
// enough on Windows (wmic is sluggish) to warrant a single-shot read.
let _cached = null;
function getMachineIdCached() {
  if (_cached == null) _cached = getMachineId();
  return _cached;
}

module.exports = { getMachineId, getMachineIdCached };
