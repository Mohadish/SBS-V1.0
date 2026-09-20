/**
 * SBS Machine ID extractor (JS)
 * =============================
 * Mirrors sbs_license/license_core.py — same hardware sources, same
 * canonicalisation, same SHA-256 truncation. Output MUST match the
 * Python helper byte-for-byte on the same hardware (the license is
 * signed against this exact string).
 *
 * Cross-platform sources (priority order):
 *   Windows  : baseboard SerialNumber | cpu ProcessorId | first diskdrive SerialNumber
 *              — read through wmic, and through CIM where wmic is gone (below)
 *   macOS    : system_profiler SPHardwareDataType (Hardware UUID + Serial Number)
 *   Linux    : /etc/machine-id, then /sys/class/dmi/id/product_uuid, then board_serial
 *
 * ── WHY THERE IS MORE THAN ONE WAY TO ASK (V0.3.4.60) ─────────────────────
 * wmic is deprecated, and Windows 11 24H2 no longer installs it by default.
 * On those machines every query came back empty and the ID silently fell
 * through to the last resort — hostname|platform|arch|RELEASE — and
 * os.release() CHANGES with a Windows feature update. So a customer would
 * update Windows, their machine ID would change underneath them, and a paid
 * licence would stop validating with no hardware having changed at all.
 *
 * The same three values are therefore also read through PowerShell's
 * Get-CimInstance. It queries the very same WMI classes (Win32_BaseBoard,
 * Win32_Processor, Win32_DiskDrive), and the result was checked to be
 * BYTE-IDENTICAL to wmic's on real hardware — same values, same order, same
 * trimming — so the hash is the same and every licence already issued keeps
 * validating. wmic is still asked first where it exists: it answers in about
 * half a second against PowerShell's two, and this runs at every boot.
 *
 * If neither answers (PowerShell blocked by policy), Windows' own MachineGuid
 * is used before the hostname string: it is not hardware — an OS reinstall
 * changes it — but it survives feature updates, which the hostname string
 * does not.
 *
 * ── ONE MACHINE, SEVERAL HONEST NAMES ──────────────────────────────────────
 * Fixing the above CHANGES the ID of any machine that was living on the
 * fallback: it now gets a real hardware ID. A licence issued against its old
 * fallback ID must not die because we got better at reading the hardware. So
 * getMachineIdCandidates() returns every ID this machine can truthfully
 * answer to — strongest first — and a saved licence is good if it matches any
 * of them. The activation dialog always SHOWS the strongest, so new licences
 * are issued against that.
 *
 * This weakens nothing already issued: a licence bound to a hardware ID can
 * only be matched by that hash. The weaker names (MachineGuid, hostname) can
 * be imitated on another machine — but only a licence that was ISSUED against
 * one is exposed by that, exactly as it was before.
 *
 * NOTE for the Python twin: license_core.get_machine_id() still asks wmic
 * only. It matches this file wherever wmic exists; on a machine without it,
 * trust the ID the app shows.
 *
 * Runs ONLY in the main process (shells out to the OS). Renderer reaches it
 * via IPC.
 */

const { execSync, execFileSync } = require('node:child_process');
const fs               = require('node:fs');
const os               = require('node:os');
const crypto           = require('node:crypto');

// 8-second cap per shell command — matches the Python timeout. wmic can
// be slow on first boot under heavy AV but never this slow in practice.
const SHELL_TIMEOUT_MS = 8_000;
// PowerShell pays a cold start on top of the queries themselves.
const PS_TIMEOUT_MS    = 20_000;

// Values a board vendor never filled in. Compared lower-cased.
const JUNK = ['to be filled by o.e.m.', 'none', ''];

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

/** board values + cpu values + the FIRST non-empty disk serial → the raw string. */
function _joinHardware(board, cpu, disks) {
  const firstDisk = (disks || []).find(v => v);
  const parts = [...(board || []), ...(cpu || []), ...(firstDisk ? [firstDisk] : [])];
  return parts
    .filter(p => p && !JUNK.includes(p.toLowerCase()))
    .join('|');
}

/** `Name=Value` lines, as `wmic … /value` prints them → the values, trimmed. */
function _wmicValues(out) {
  const vals = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx >= 0) vals.push(line.slice(idx + 1).trim());
  }
  return vals;
}

function _windowsHardwareViaWmic() {
  return _joinHardware(
    _wmicValues(_run('wmic', ['baseboard', 'get', 'SerialNumber', '/value'])),
    _wmicValues(_run('wmic', ['cpu',       'get', 'ProcessorId',  '/value'])),
    _wmicValues(_run('wmic', ['diskdrive', 'get', 'SerialNumber', '/value'])),
  );
}

/**
 * The same three WMI properties through CIM — one PowerShell start, not three.
 * Each value is tagged on its own line so the parse cannot confuse a board
 * serial with a disk's. -Command is not subject to the script execution
 * policy, and Get-CimInstance works in Constrained Language mode.
 */
function _windowsHardwareViaCim() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_BaseBoard | ForEach-Object { 'B=' + $_.SerialNumber }",
    "Get-CimInstance Win32_Processor | ForEach-Object { 'C=' + $_.ProcessorId }",
    "Get-CimInstance Win32_DiskDrive | ForEach-Object { 'D=' + $_.SerialNumber }",
  ].join('; ');
  let out = '';
  try {
    // execFile, not a shell string: the script is passed as ONE argument, so
    // nothing in it is re-parsed by cmd.exe.
    out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', timeout: PS_TIMEOUT_MS, windowsHide: true }) || '';
  } catch {
    return '';
  }
  const got = { B: [], C: [], D: [] };
  for (const line of out.split(/\r?\n/)) {
    const m = /^([BCD])=(.*)$/.exec(line.trim());
    if (m) got[m[1]].push(m[2].trim());
  }
  return _joinHardware(got.B, got.C, got.D);
}

/** Windows' own per-install GUID. Not hardware; stable across feature updates. */
function _windowsMachineGuid() {
  const out = _run('reg', ['query', '"HKLM\\SOFTWARE\\Microsoft\\Cryptography"', '/v', 'MachineGuid', '/reg:64']);
  const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/.exec(out);
  return m ? `MG:${m[1].toLowerCase()}` : '';
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

const _hash = (raw) => crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32).toUpperCase();

/** The last resort, exactly as it has always been built — kept byte-for-byte,
 *  because licences were issued against it on machines where nothing else
 *  answered. (Its os.release() is what a Windows feature update changes.) */
function _hostnameRaw() {
  return `${os.hostname()}|${os.platform()}|${os.arch()}|${os.release()}`;
}

/** The strongest raw string this machine can give, or '' if none. */
function _primaryRaw() {
  switch (process.platform) {
    case 'win32':  return _windowsHardwareViaWmic() || _windowsHardwareViaCim() || _windowsMachineGuid();
    case 'darwin': return _macId();
    default:       return _linuxId();
  }
}

/**
 * Returns a 32-char uppercase hex string — the same value the Python
 * helper produces on this machine. Stable across reboots, changes ONLY
 * when hardware changes (motherboard / disk swap on Win/Linux, machine
 * replacement on Mac). This is the ID the activation dialog shows.
 */
function getMachineId() {
  return _hash(_primaryRaw() || _hostnameRaw());
}

// Cache the result for the lifetime of the process. Hardware doesn't
// change while the app is running, and the shell calls are expensive
// enough on Windows to warrant a single-shot read.
let _cached = null;
function getMachineIdCached() {
  if (_cached == null) _cached = getMachineId();
  return _cached;
}

/**
 * Every ID this machine can truthfully answer to, strongest first; [0] is
 * always getMachineIdCached(). The rest are the names it may have gone by
 * when a licence was issued: the MachineGuid one, and the old hostname one.
 * Computed once, and only when asked — the ordinary boot, where the saved
 * licence matches the primary ID, never pays for it.
 */
let _candidates = null;
function getMachineIdCandidates() {
  if (_candidates) return _candidates;
  const ids = [getMachineIdCached()];
  const add = (raw) => { if (!raw) return; const id = _hash(raw); if (!ids.includes(id)) ids.push(id); };
  if (process.platform === 'win32') add(_windowsMachineGuid());
  add(_hostnameRaw());
  _candidates = ids;
  return ids;
}

module.exports = { getMachineId, getMachineIdCached, getMachineIdCandidates };
