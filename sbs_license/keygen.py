"""
SBS License Key Generator  —  NADAV'S PRIVATE TOOL
====================================================
Keep this file and keys/ folder PRIVATE. Never give them to clients.

Usage
-----
  First-time setup (run once):
      python keygen.py --init-keys

  Get a client's machine ID displayed nicely:
      python keygen.py --show-machine-id

  Issue a standard client license:
      python keygen.py --issue --client "Acme Engineering" --machine-id ABCD1234ABCD1234ABCD1234ABCD1234 --days 365

  Issue a master license (no machine lock, no expiry — for your team):
      python keygen.py --issue --master --client "SBS Internal"

  Issue a license from a specific date range:
      python keygen.py --issue --client "Acme Engineering" --machine-id ABCD1234... --expiry 2027-12-31

  Inspect / verify any .lic file:
      python keygen.py --inspect license.lic

Requires:  pip install cryptography
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import date, timedelta
from pathlib import Path

KEYS_DIR = Path(__file__).resolve().parent / "keys"
PRIVATE_KEY_PATH = KEYS_DIR / "sbs_private.key"
PUBLIC_KEY_PATH  = KEYS_DIR / "sbs_public.key"
OUTPUT_DIR = Path(__file__).resolve().parent / "issued_licenses"

# ─────────────────────────────────────────────────────────────────────────────

def _require_cryptography():
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        return Ed25519PrivateKey
    except ImportError:
        print("ERROR: 'cryptography' package is not installed.")
        print("Run:  pip install cryptography")
        sys.exit(1)


def cmd_init_keys(args):
    """Generate a new Ed25519 key pair (run once)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding, PrivateFormat, PublicFormat, NoEncryption
    )

    if PRIVATE_KEY_PATH.exists():
        print(f"Keys already exist at {KEYS_DIR}")
        print("Delete them manually if you really want to regenerate (this will invalidate ALL existing licenses).")
        sys.exit(1)

    KEYS_DIR.mkdir(parents=True, exist_ok=True)

    private_key = Ed25519PrivateKey.generate()
    pub_key = private_key.public_key()

    priv_der = private_key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption())
    pub_der  = pub_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)

    PRIVATE_KEY_PATH.write_bytes(priv_der)
    PUBLIC_KEY_PATH.write_bytes(pub_der)

    pub_b64 = base64.b64encode(pub_der).decode()

    print("=" * 60)
    print("Keys generated successfully!")
    print(f"  Private key: {PRIVATE_KEY_PATH}")
    print(f"  Public key:  {PUBLIC_KEY_PATH}")
    print()
    print("NEXT STEP — paste this PUBLIC_KEY_B64 into license_core.py:")
    print()
    print(f"PUBLIC_KEY_B64 = \"{pub_b64}\"")
    print()
    print("Keep the keys/ folder PRIVATE and back it up securely.")
    print("=" * 60)


def _load_private_key():
    from cryptography.hazmat.primitives.serialization import load_der_private_key
    if not PRIVATE_KEY_PATH.exists():
        print("ERROR: Private key not found. Run:  python keygen.py --init-keys")
        sys.exit(1)
    return load_der_private_key(PRIVATE_KEY_PATH.read_bytes(), password=None)


def _canonical_payload(data: dict) -> bytes:
    """Must match license_core.py exactly."""
    fields = [
        str(data.get("version", 1)),
        str(data.get("client", "")),
        str(data.get("machine_id", "") or ""),
        str(data.get("issued", "")),
        str(data.get("expiry", "") or ""),
        str(data.get("type", "standard")),
    ]
    return "|".join(fields).encode("utf-8")


def cmd_issue(args):
    """Create and sign a new license file."""
    _require_cryptography()
    private_key = _load_private_key()

    issued = date.today().isoformat()

    if args.master:
        license_type = "master"
        machine_id   = None
        expiry        = None
        filename_tag  = "master"
    else:
        license_type = "standard"
        if not args.machine_id:
            print("ERROR: --machine-id is required for standard licenses.")
            print("Ask the client to run:  python get_machine_id.py")
            sys.exit(1)
        machine_id = args.machine_id.upper().strip()
        if args.expiry:
            expiry = args.expiry
        else:
            days = int(args.days) if args.days else 365
            expiry = (date.today() + timedelta(days=days)).isoformat()
        filename_tag = machine_id[:8]

    client = args.client or "Unknown Client"

    data = {
        "version":    1,
        "client":     client,
        "machine_id": machine_id,
        "issued":     issued,
        "expiry":     expiry,
        "type":       license_type,
    }

    payload = _canonical_payload(data)
    sig_bytes = private_key.sign(payload)
    data["signature"] = base64.b64encode(sig_bytes).decode()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    safe_client = "".join(c if c.isalnum() or c in " _-" else "_" for c in client).strip().replace(" ", "_")
    filename = f"sbs_{safe_client}_{filename_tag}_{issued}.lic"
    out_path = OUTPUT_DIR / filename

    out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    print("=" * 60)
    print("License issued successfully!")
    print(f"  File    : {out_path}")
    print(f"  Client  : {client}")
    print(f"  Type    : {license_type}")
    if machine_id:
        print(f"  Machine : {machine_id}")
    print(f"  Issued  : {issued}")
    print(f"  Expiry  : {expiry or 'Never'}")
    print()
    print(f"Send this file to the client:  {out_path.name}")
    print("They drop it in the SBS root folder next to the launcher.")
    print("=" * 60)


def cmd_inspect(args):
    """Print and verify a .lic file."""
    _require_cryptography()
    from cryptography.hazmat.primitives.serialization import load_der_public_key
    from cryptography.exceptions import InvalidSignature

    lic_path = Path(args.file)
    if not lic_path.exists():
        print(f"ERROR: File not found: {lic_path}")
        sys.exit(1)

    data = json.loads(lic_path.read_text(encoding="utf-8"))
    print(json.dumps({k: v for k, v in data.items() if k != "signature"}, indent=2))

    # Verify signature using our public key
    if PUBLIC_KEY_PATH.exists():
        pub_key = load_der_public_key(PUBLIC_KEY_PATH.read_bytes())
        try:
            sig_bytes = base64.b64decode(data.get("signature", ""))
            payload = _canonical_payload(data)
            pub_key.verify(sig_bytes, payload)
            print("\nSignature: VALID ✓")
        except InvalidSignature:
            print("\nSignature: INVALID ✗  (file may have been tampered with)")
    else:
        print("\n(Public key not found — skipping signature check)")


def cmd_show_machine_id(args):
    """Print this machine's ID — useful for testing."""
    # Import from the sibling module
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from license_core import get_machine_id
    mid = get_machine_id()
    print("=" * 60)
    print("This machine's ID:")
    print()
    print(f"  {mid}")
    print()
    print("Give this ID to Nadav to generate your license.")
    print("=" * 60)


# ─────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="SBS License Key Generator — Nadav's private tool"
    )
    sub = parser.add_subparsers(dest="command")

    # --init-keys
    p_init = sub.add_parser("init-keys", help="Generate a new Ed25519 key pair (run once)")

    # --issue
    p_issue = sub.add_parser("issue", help="Issue a new license")
    p_issue.add_argument("--client", required=True, help="Client or company name")
    p_issue.add_argument("--machine-id", help="32-char machine ID from the client")
    p_issue.add_argument("--master", action="store_true", help="Master license (no machine lock, no expiry)")
    p_issue.add_argument("--days", type=int, default=365, help="License duration in days (default 365)")
    p_issue.add_argument("--expiry", help="Exact expiry date (YYYY-MM-DD), overrides --days")

    # --inspect
    p_inspect = sub.add_parser("inspect", help="Inspect and verify a .lic file")
    p_inspect.add_argument("file", help="Path to the .lic file")

    # --show-machine-id
    p_mid = sub.add_parser("show-machine-id", help="Show this machine's hardware ID")

    # Also support old-style --flags for convenience
    parser.add_argument("--init-keys", action="store_true", dest="flag_init")
    parser.add_argument("--issue", action="store_true", dest="flag_issue")
    parser.add_argument("--client", dest="flag_client")
    parser.add_argument("--machine-id", dest="flag_machine_id")
    parser.add_argument("--master", action="store_true", dest="flag_master")
    parser.add_argument("--days", type=int, dest="flag_days")
    parser.add_argument("--expiry", dest="flag_expiry")
    parser.add_argument("--inspect", dest="flag_inspect")
    parser.add_argument("--show-machine-id", action="store_true", dest="flag_show_mid")

    args = parser.parse_args()

    # Handle flag-style invocation
    if args.flag_init or args.command == "init-keys":
        cmd_init_keys(args)
    elif args.flag_show_mid or args.command == "show-machine-id":
        cmd_show_machine_id(args)
    elif args.flag_issue or args.command == "issue":
        # Map flag style to args namespace
        if args.flag_issue:
            args.client     = args.flag_client
            args.machine_id = args.flag_machine_id
            args.master     = args.flag_master
            args.days       = args.flag_days
            args.expiry     = args.flag_expiry
        cmd_issue(args)
    elif args.flag_inspect or args.command == "inspect":
        if args.flag_inspect:
            args.file = args.flag_inspect
        cmd_inspect(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
