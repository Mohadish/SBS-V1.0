"""
SBS License Core
================
Shared logic for machine ID generation and license validation.
Used by both the keygen tool (Nadav's side) and the app launcher (client side).

Requires:  pip install cryptography
"""
from __future__ import annotations

import base64
import hashlib
import json
import platform
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Optional

# ── Public key embedded in the app ───────────────────────────────────────────
# This is safe to distribute.  The private key (in keygen.py) NEVER leaves Nadav.
# After running keygen.py --init-keys for the first time, paste the printed
# PUBLIC_KEY_B64 value here and in keygen.py.
PUBLIC_KEY_B64: str = "REPLACE_WITH_YOUR_PUBLIC_KEY"   # filled in after first keygen run


# ─────────────────────────────────────────────────────────────────────────────
#  Machine ID
# ─────────────────────────────────────────────────────────────────────────────

def _run(cmd: list[str]) -> str:
    """Run a shell command and return stdout, empty string on failure."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=8
        )
        return result.stdout.strip()
    except Exception:
        return ""


def _get_machine_id_windows() -> str:
    parts = []
    # Motherboard serial
    out = _run(["wmic", "baseboard", "get", "SerialNumber", "/value"])
    for line in out.splitlines():
        if "=" in line:
            parts.append(line.split("=", 1)[1].strip())
    # CPU ID
    out = _run(["wmic", "cpu", "get", "ProcessorId", "/value"])
    for line in out.splitlines():
        if "=" in line:
            parts.append(line.split("=", 1)[1].strip())
    # Disk serial of first physical drive
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
    # /etc/machine-id is stable across reboots and unique per install
    mid = Path("/etc/machine-id")
    if mid.exists():
        val = mid.read_text().strip()
        if val:
            return val
    # Fallback: DMI product UUID (needs root on some systems)
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
        # Last-resort fallback: node name + python platform string
        raw = platform.node() + platform.platform()

    # SHA-256 → first 32 hex chars  (short enough to read aloud / email)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32].upper()
    return digest


# ─────────────────────────────────────────────────────────────────────────────
#  License validation
# ─────────────────────────────────────────────────────────────────────────────

def _canonical_payload(data: dict) -> bytes:
    """Build the exact byte string that was signed."""
    fields = [
        str(data.get("version", 1)),
        str(data.get("client", "")),
        str(data.get("machine_id", "") or ""),
        str(data.get("issued", "")),
        str(data.get("expiry", "") or ""),
        str(data.get("type", "standard")),
    ]
    return "|".join(fields).encode("utf-8")


class LicenseError(Exception):
    pass


def validate_license(license_path: Path) -> dict:
    """
    Load and validate a .lic file.

    Returns the license dict on success.
    Raises LicenseError with a human-readable message on any failure.
    """
    if PUBLIC_KEY_B64 == "REPLACE_WITH_YOUR_PUBLIC_KEY":
        raise LicenseError(
            "App is not configured yet: public key missing.\n"
            "Run keygen.py --init-keys and paste the public key into license_core.py."
        )

    # ── Load ──────────────────────────────────────────────────────────────
    if not license_path.exists():
        raise LicenseError(f"License file not found:\n{license_path}")

    try:
        data = json.loads(license_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise LicenseError(f"License file is unreadable or corrupted:\n{e}")

    # ── Signature ─────────────────────────────────────────────────────────
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.hazmat.primitives.serialization import load_der_public_key
        from cryptography.exceptions import InvalidSignature

        pub_bytes = base64.b64decode(PUBLIC_KEY_B64)
        pub_key = load_der_public_key(pub_bytes)

        sig_bytes = base64.b64decode(data.get("signature", ""))
        payload = _canonical_payload(data)
        pub_key.verify(sig_bytes, payload)

    except InvalidSignature:
        raise LicenseError(
            "License signature is invalid.\n"
            "This file was not issued by a valid key, or has been tampered with."
        )
    except ImportError:
        raise LicenseError(
            "The 'cryptography' package is not installed.\n"
            "Run setup.bat to install it."
        )
    except Exception as e:
        raise LicenseError(f"License signature check failed: {e}")

    # ── Machine lock ───────────────────────────────────────────────────────
    license_type = data.get("type", "standard")
    licensed_machine = data.get("machine_id") or None

    if license_type != "master" and licensed_machine:
        this_machine = get_machine_id()
        if this_machine.upper() != licensed_machine.upper():
            raise LicenseError(
                f"This license is locked to a different machine.\n"
                f"Licensed ID : {licensed_machine}\n"
                f"This machine: {this_machine}\n\n"
                f"Contact your SBS administrator to obtain a new license for this machine."
            )

    # ── Expiry ─────────────────────────────────────────────────────────────
    expiry_str = data.get("expiry") or None
    if license_type != "master" and expiry_str:
        try:
            expiry_date = date.fromisoformat(expiry_str)
        except ValueError:
            raise LicenseError(f"License has an invalid expiry date: {expiry_str!r}")
        today = date.today()
        if today > expiry_date:
            raise LicenseError(
                f"This license expired on {expiry_str}.\n"
                f"Contact your SBS administrator to renew."
            )

    return data


def find_license_file(start_dir: Optional[Path] = None) -> Optional[Path]:
    """
    Search for a .lic file next to the app, or in a few standard locations.
    Returns the first one found, or None.
    """
    search_roots = []
    if start_dir:
        search_roots.append(start_dir)

    # Folder containing this script
    search_roots.append(Path(__file__).resolve().parent)

    # One level up (root of the SBS install)
    search_roots.append(Path(__file__).resolve().parent.parent)

    seen = set()
    for root in search_roots:
        root = root.resolve()
        if root in seen:
            continue
        seen.add(root)
        for lic in sorted(root.glob("*.lic")):
            return lic

    return None
