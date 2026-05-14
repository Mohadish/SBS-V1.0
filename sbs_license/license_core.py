"""
SBS License Core (v2)
=====================
Shared logic for machine ID generation and license validation.
Used by keygen.py (Nadav's side) and the JS port that lives inside the
Electron app (electron/license/verify.js — keep the two in sync).

v2 model (current):
  Inputs from the client:    email, machine_id (extracted from hardware)
  Outputs from the keygen:   password (8 chars, user-facing), key (long b64)
  Payload (signed):          { v: 2, email, mid, exp }
  Signing: Ed25519 over `f"{email}|{mid}|{exp}|{password}"`.
  Key blob: urlsafe-base64(canonical_json(payload) + b"|" + signature)

The PASSWORD is a separate string the user types alongside the key.
Both must match the keygen output for verification to pass — this is the
3-factor binding (machine_id + email + password → unlocks key → extracts expiry).

Requires:  pip install cryptography
"""
from __future__ import annotations

import base64
import hashlib
import json
import platform
import subprocess
from datetime import date
from pathlib import Path

# ── Public key embedded in the app ───────────────────────────────────────────
# This is safe to distribute.  The private key (in keygen.py) NEVER leaves Nadav.
# After running keygen.py --init-keys for the first time, paste the printed
# PUBLIC_KEY_B64 value here AND into electron/license/verify.js (same string).
PUBLIC_KEY_B64: str = "MCowBQYDK2VwAyEAaY0FkCBVq4fpJuRvVoz2kLP6hU5obvFlvZ+t6/D/9Bc="   # filled in after first keygen run

PAYLOAD_VERSION = 2


# ─────────────────────────────────────────────────────────────────────────────
#  Machine ID
# ─────────────────────────────────────────────────────────────────────────────

def _run(cmd: list[str]) -> str:
    """Run a shell command and return stdout, empty string on failure."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        return result.stdout.strip()
    except Exception:
        return ""


def _get_machine_id_windows() -> str:
    parts = []
    out = _run(["wmic", "baseboard", "get", "SerialNumber", "/value"])
    for line in out.splitlines():
        if "=" in line:
            parts.append(line.split("=", 1)[1].strip())
    out = _run(["wmic", "cpu", "get", "ProcessorId", "/value"])
    for line in out.splitlines():
        if "=" in line:
            parts.append(line.split("=", 1)[1].strip())
    out = _run(["wmic", "diskdrive", "get", "SerialNumber", "/value"])
    for line in out.splitlines():
        if "=" in line:
            val = line.split("=", 1)[1].strip()
            if val:
                parts.append(val)
                break
    return "|".join(p for p in parts if p and p.lower() not in ("", "to be filled by o.e.m.", "none"))


def _get_machine_id_mac() -> str:
    parts = []
    out = _run(["system_profiler", "SPHardwareDataType"])
    for line in out.splitlines():
        if "Hardware UUID" in line or "Serial Number" in line:
            val = line.split(":", 1)[-1].strip()
            if val:
                parts.append(val)
    return "|".join(p for p in parts if p)


def _get_machine_id_linux() -> str:
    mid = Path("/etc/machine-id")
    if mid.exists():
        val = mid.read_text().strip()
        if val:
            return val
    for path in ["/sys/class/dmi/id/product_uuid", "/sys/class/dmi/id/board_serial"]:
        try:
            val = Path(path).read_text().strip()
            if val:
                return val
        except Exception:
            pass
    return ""


def get_machine_id() -> str:
    """
    Returns a stable, hardware-based machine fingerprint.
    The raw string is hashed so clients only ever see an opaque token.
    """
    system = platform.system()
    if system == "Windows":
        raw = _get_machine_id_windows()
    elif system == "Darwin":
        raw = _get_machine_id_mac()
    else:
        raw = _get_machine_id_linux()

    if not raw:
        raw = platform.node() + platform.platform()

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32].upper()


# ─────────────────────────────────────────────────────────────────────────────
#  License canonical form (must match JS verify.js exactly)
# ─────────────────────────────────────────────────────────────────────────────

def canonical_signed_string(email: str, machine_id: str, expiry: str, password: str) -> str:
    """
    The exact string that gets signed. Both the keygen (Python) and the
    app-side verifier (JS) build this identically — any change breaks
    every issued license.
    """
    return f"{email}|{machine_id}|{expiry}|{password}"


def encode_key_blob(payload: dict, signature: bytes) -> str:
    """
    Pack { payload, signature } into the user-facing 'key' string.
    Format: urlsafe-base64(  canonical_payload_json + b"|" + signature  )
    """
    payload_json = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode("utf-8")
    blob = payload_json + b"|" + signature
    return base64.urlsafe_b64encode(blob).decode("ascii").rstrip("=")


def decode_key_blob(key: str) -> tuple[dict, bytes]:
    """
    Inverse of encode_key_blob. Returns (payload_dict, signature_bytes).
    Raises ValueError on malformed input.

    The v2 payload is a flat JSON object whose string values never contain
    '}' (email/date/hex/int only), so the FIRST '}' is unambiguously the
    end of the JSON. We can't split on '|' because the raw 64-byte Ed25519
    signature that follows can contain '|' bytes (0x7c) — using rpartition
    would land inside the signature.
    """
    # Re-pad — urlsafe base64 may have stripped trailing '=' characters.
    pad = "=" * (-len(key) % 4)
    raw = base64.urlsafe_b64decode(key + pad)
    json_end = raw.find(b"}")
    if json_end < 0:
        raise ValueError("Malformed key: no JSON terminator")
    if raw[json_end + 1:json_end + 2] != b"|":
        raise ValueError("Malformed key: missing separator after JSON")
    payload_json = raw[:json_end + 1]
    signature    = raw[json_end + 2:]
    payload = json.loads(payload_json.decode("utf-8"))
    return payload, signature


# ─────────────────────────────────────────────────────────────────────────────
#  License validation (Python side — for keygen self-test)
# ─────────────────────────────────────────────────────────────────────────────

class LicenseError(Exception):
    pass


def validate_license(*, email: str, password: str, key: str, machine_id: str) -> dict:
    """
    Verify a (email, password, key, machine_id) tuple.

    Returns on success:
      {
        "valid": True,
        "email": "...",
        "machine_id": "...",
        "expiry": "YYYY-MM-DD",
        "days_remaining": int,
        "grace_period_active": bool,   # True if within 3 days of expiry
        "hard_locked": False,
      }

    Returns on failure (does NOT raise — caller decides how to surface):
      {
        "valid": False,
        "reason": "EXPIRED" | "MACHINE_MISMATCH" | "EMAIL_MISMATCH" |
                  "INVALID_SIGNATURE" | "MALFORMED_KEY" | "VERSION_MISMATCH",
        "hard_locked": True,
      }

    The 3-day grace window is INFORMATIONAL ONLY — keeps the app running
    AFTER expiry for 3 days with a warning. The app enforces the hard-lock
    only after expiry + 3 days. (Negotiable; v1 spec says hard lock at
    expiry, soft warn 3 days BEFORE — implemented that way below.)
    """
    if PUBLIC_KEY_B64 == "REPLACE_WITH_YOUR_PUBLIC_KEY":
        raise LicenseError(
            "App is not configured yet: public key missing.\n"
            "Run keygen.py --init-keys and paste the public key into license_core.py and verify.js."
        )

    # ── Decode key ────────────────────────────────────────────────────────
    # Strip all whitespace — terminals may wrap long keys on copy, embedding
    # stray spaces/newlines that break base64 decode.
    key = "".join(key.split()) if key else ""
    try:
        payload, signature = decode_key_blob(key)
    except Exception as e:
        return {"valid": False, "reason": "MALFORMED_KEY", "hard_locked": True}

    if payload.get("v") != PAYLOAD_VERSION:
        return {"valid": False, "reason": "VERSION_MISMATCH", "hard_locked": True}

    p_email = payload.get("email", "")
    p_mid   = payload.get("mid", "")
    p_exp   = payload.get("exp", "")

    # ── Check identifier matches ──────────────────────────────────────────
    if p_email.lower() != email.lower():
        return {"valid": False, "reason": "EMAIL_MISMATCH", "hard_locked": True}
    if p_mid.upper() != machine_id.upper():
        return {"valid": False, "reason": "MACHINE_MISMATCH", "hard_locked": True}

    # ── Verify signature ──────────────────────────────────────────────────
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.hazmat.primitives.serialization import load_der_public_key
        from cryptography.exceptions import InvalidSignature

        pub_bytes = base64.b64decode(PUBLIC_KEY_B64)
        pub_key = load_der_public_key(pub_bytes)

        signed = canonical_signed_string(p_email, p_mid, p_exp, password).encode("utf-8")
        pub_key.verify(signature, signed)
    except InvalidSignature:
        return {"valid": False, "reason": "INVALID_SIGNATURE", "hard_locked": True}
    except ImportError:
        raise LicenseError("The 'cryptography' package is not installed. Run: pip install cryptography")

    # ── Check expiry ──────────────────────────────────────────────────────
    try:
        expiry_date = date.fromisoformat(p_exp)
    except ValueError:
        return {"valid": False, "reason": "MALFORMED_KEY", "hard_locked": True}

    today = date.today()
    delta_days = (expiry_date - today).days

    if delta_days < 0:
        return {
            "valid": False,
            "reason": "EXPIRED",
            "hard_locked": True,
            "expiry": p_exp,
            "days_remaining": delta_days,
        }

    return {
        "valid": True,
        "email": p_email,
        "machine_id": p_mid,
        "expiry": p_exp,
        "days_remaining": delta_days,
        # Grace period: 3 days BEFORE expiry → warn but still run.
        "grace_period_active": 0 <= delta_days <= 3,
        "hard_locked": False,
    }
