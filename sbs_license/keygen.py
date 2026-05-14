"""
SBS License Key Generator (v2)  —  NADAV'S PRIVATE TOOL
=======================================================
Keep this file and keys/ folder PRIVATE. Never give them to clients.

Usage
-----
  First-time setup (run once — generates Ed25519 key pair):
      python keygen.py --init-keys
      (Paste the printed PUBLIC_KEY_B64 into license_core.py AND
       sbs-app/electron/license/verify.js.)

  Issue a client license:
      python keygen.py --issue ^
        --email alice@example.com ^
        --machine-id ABCD1234ABCD1234ABCD1234ABCD1234 ^
        --days 30

  → Outputs a password + key.  Email BOTH to the client.

  Self-test a (email, password, key, machine_id) tuple:
      python keygen.py --verify ^
        --email alice@example.com ^
        --password "ABCD-1234" ^
        --key  "..." ^
        --machine-id ABCD1234ABCD1234ABCD1234ABCD1234

  Show this dev machine's ID (for testing on your own box):
      python keygen.py --show-machine-id

Requires:  pip install cryptography
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import string
import sys
from datetime import date, timedelta
from pathlib import Path

# Keys live OUTSIDE the repo so worktree cleanup / repo moves don't destroy
# them. Override with the SBS_LICENSE_KEYS_DIR env var if you want them
# somewhere else (e.g. an encrypted volume).
_DEFAULT_KEYS_DIR = Path.home() / ".sbs_license" / "keys"
KEYS_DIR = Path(os.environ.get("SBS_LICENSE_KEYS_DIR", _DEFAULT_KEYS_DIR))
PRIVATE_KEY_PATH = KEYS_DIR / "sbs_private.key"
PUBLIC_KEY_PATH  = KEYS_DIR / "sbs_public.key"
# Audit log stays next to the script — it's per-license, fine to live in the repo
# if you commit it, or you can move it out the same way as the keys.
LOG_DIR = Path(os.environ.get("SBS_LICENSE_LOG_DIR", Path(__file__).resolve().parent / "issued_licenses"))

# Match license_core.py — keep in sync.
PAYLOAD_VERSION = 2


def _require_cryptography():
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: F401
    except ImportError:
        print("ERROR: 'cryptography' package is not installed.")
        print("Run:  pip install cryptography")
        sys.exit(1)


def cmd_init_keys(args):
    """Generate a new Ed25519 key pair (run once)."""
    _require_cryptography()
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding, PrivateFormat, PublicFormat, NoEncryption,
    )

    if PRIVATE_KEY_PATH.exists():
        print(f"Keys already exist at {KEYS_DIR}")
        print("Delete them manually if you really want to regenerate "
              "(this will INVALIDATE every license you've ever issued).")
        sys.exit(1)

    KEYS_DIR.mkdir(parents=True, exist_ok=True)

    private_key = Ed25519PrivateKey.generate()
    pub_key = private_key.public_key()

    priv_der = private_key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())
    pub_der  = pub_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)

    PRIVATE_KEY_PATH.write_bytes(priv_der)
    PUBLIC_KEY_PATH.write_bytes(pub_der)

    pub_b64 = base64.b64encode(pub_der).decode()

    print("=" * 64)
    print("Keys generated successfully!")
    print(f"  Private key: {PRIVATE_KEY_PATH}  (KEEP PRIVATE, back up)")
    print(f"  Public key:  {PUBLIC_KEY_PATH}")
    print()
    print("PASTE this PUBLIC_KEY_B64 into BOTH:")
    print("  sbs_license/license_core.py")
    print("  sbs-app/electron/license/verify.js")
    print()
    print(f'  PUBLIC_KEY_B64 = "{pub_b64}"')
    print()
    print("=" * 64)


def _load_private_key():
    from cryptography.hazmat.primitives.serialization import load_der_private_key
    if not PRIVATE_KEY_PATH.exists():
        print("ERROR: Private key not found. Run:  python keygen.py --init-keys")
        sys.exit(1)
    return load_der_private_key(PRIVATE_KEY_PATH.read_bytes(), password=None)


def _generate_password() -> str:
    """
    8-character human-readable password.
    Format: XXXX-XXXX where each X is uppercase A-Z or 0-9 (no easily-confused
    chars like 0/O/1/I/L). Total entropy: 32^8 ≈ 2^40 (1 trillion).
    User-facing — short enough to type, long enough to deter brute force
    when combined with the 3 other binding factors.
    """
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no I, O, 0, 1
    return "{}-{}".format(
        "".join(secrets.choice(alphabet) for _ in range(4)),
        "".join(secrets.choice(alphabet) for _ in range(4)),
    )


def cmd_issue(args):
    """Generate a (password, key) pair for a client."""
    _require_cryptography()
    # Lazy import so --init-keys works on a fresh checkout that hasn't
    # paste-in the public key yet.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from license_core import canonical_signed_string, encode_key_blob

    email      = args.email.strip().lower()
    machine_id = args.machine_id.strip().upper()
    days       = int(args.days) if args.days else 30

    if not email or "@" not in email:
        print("ERROR: --email must be a real email address.")
        sys.exit(1)
    if len(machine_id) < 8:
        print("ERROR: --machine-id looks too short (expected 32 hex chars).")
        sys.exit(1)

    expiry = (date.today() + timedelta(days=days)).isoformat()
    password = _generate_password()

    payload = {
        "v":     PAYLOAD_VERSION,
        "email": email,
        "mid":   machine_id,
        "exp":   expiry,
    }

    # Sign the canonical "email|mid|exp|password" string.
    private_key = _load_private_key()
    signed_data = canonical_signed_string(email, machine_id, expiry, password).encode("utf-8")
    signature   = private_key.sign(signed_data)

    key = encode_key_blob(payload, signature)

    # Log to issued_licenses/ so you can keep an audit trail of who got what.
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_record = {
        "issued":     date.today().isoformat(),
        "email":      email,
        "machine_id": machine_id,
        "expiry":     expiry,
        "days":       days,
        "password":   password,   # log it — you control this folder, never ship it.
        "key":        key,
    }
    log_filename = f"{date.today().isoformat()}_{email.replace('@', '_at_')}_{machine_id[:8]}.json"
    (LOG_DIR / log_filename).write_text(
        json.dumps(log_record, indent=2),
        encoding="utf-8",
    )

    # ── Output for the client ─────────────────────────────────────────────
    print()
    print("=" * 64)
    print("  SBS LICENSE — issued successfully")
    print("=" * 64)
    print(f"  Email      :  {email}")
    print(f"  Machine ID :  {machine_id}")
    print(f"  Valid for  :  {days} days")
    print(f"  Expires on :  {expiry}")
    print()
    print("  PASSWORD (send to client — short, user types this):")
    print(f"    {password}")
    print()
    print("  KEY (send to client — long, user pastes this):")
    print(f"    {key}")
    print()
    print(f"  Audit log  :  {LOG_DIR / log_filename}")
    print("=" * 64)
    print()


def cmd_verify(args):
    """Self-test a (email, password, key, machine_id) tuple — same logic the app uses."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from license_core import validate_license

    result = validate_license(
        email=args.email.strip().lower(),
        password=args.password.strip(),
        key=args.key.strip(),
        machine_id=args.machine_id.strip().upper(),
    )

    print(json.dumps(result, indent=2, default=str))
    sys.exit(0 if result.get("valid") else 1)


def cmd_show_machine_id(args):
    """Print this machine's ID."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from license_core import get_machine_id
    mid = get_machine_id()
    print("=" * 64)
    print("This machine's ID:")
    print(f"  {mid}")
    print("=" * 64)


# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="SBS License Key Generator — Nadav's private tool (v2)",
    )

    # Support both subcommand style AND --flag style for batch-script
    # convenience.
    sub = parser.add_subparsers(dest="command")

    p_init = sub.add_parser("init-keys", help="Generate a new Ed25519 key pair")

    p_issue = sub.add_parser("issue", help="Issue a new license (password + key)")
    p_issue.add_argument("--email",      required=True)
    p_issue.add_argument("--machine-id", required=True)
    p_issue.add_argument("--days", type=int, default=30, help="License duration in days (default 30)")

    p_verify = sub.add_parser("verify", help="Self-test a license tuple")
    p_verify.add_argument("--email",      required=True)
    p_verify.add_argument("--password",   required=True)
    p_verify.add_argument("--key",        required=True)
    p_verify.add_argument("--machine-id", required=True)

    p_mid = sub.add_parser("show-machine-id", help="Show this machine's hardware ID")

    # Top-level flag aliases
    parser.add_argument("--init-keys",       action="store_true", dest="flag_init")
    parser.add_argument("--issue",           action="store_true", dest="flag_issue")
    parser.add_argument("--verify",          action="store_true", dest="flag_verify")
    parser.add_argument("--show-machine-id", action="store_true", dest="flag_show_mid")
    parser.add_argument("--email",      dest="flag_email")
    parser.add_argument("--machine-id", dest="flag_machine_id")
    parser.add_argument("--password",   dest="flag_password")
    parser.add_argument("--key",        dest="flag_key")
    parser.add_argument("--days", type=int, dest="flag_days")

    args = parser.parse_args()

    if args.flag_init or args.command == "init-keys":
        cmd_init_keys(args)
    elif args.flag_show_mid or args.command == "show-machine-id":
        cmd_show_machine_id(args)
    elif args.flag_issue or args.command == "issue":
        if args.flag_issue:
            args.email      = args.flag_email
            args.machine_id = args.flag_machine_id
            args.days       = args.flag_days
        cmd_issue(args)
    elif args.flag_verify or args.command == "verify":
        if args.flag_verify:
            args.email      = args.flag_email
            args.machine_id = args.flag_machine_id
            args.password   = args.flag_password
            args.key        = args.flag_key
        cmd_verify(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
