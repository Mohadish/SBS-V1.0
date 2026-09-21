"""
Issue ONE licence through the REAL keygen code path — with a THROWAWAY key.

Called by license-roundtrip.js. It runs sbs_license/keygen.py's own cmd_issue(),
so what comes out is exactly what a real issued licence looks like: the real
payload, the real canonical string, the real signing call, the real blob
encoding. Two things are swapped, and only for this process:

  * keygen._load_private_key  ->  a key generated right here, in memory.
    THE REAL PRIVATE KEY IS NEVER OPENED. This script does not read
    ~/.sbs_license/, and nothing signed here could pass the app's verifier
    (it checks against the production public key).
  * keygen.LOG_DIR            ->  a temp folder, so no fake customer lands in
    issued_licenses/.

Prints one JSON object on stdout.
"""
import argparse
import base64
import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LICENSE_DIR = (HERE / ".." / ".." / "sbs_license").resolve()
sys.path.insert(0, str(LICENSE_DIR))

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    import keygen
    import license_core
except Exception as exc:                      # no cryptography / no tooling here
    print(json.dumps({"skip": f"{type(exc).__name__}: {exc}"}))
    sys.exit(0)

EMAIL = "Round.Trip@Example.COM"              # mixed case on purpose: both sides must lower it
MACHINE_ID = "abcdef0123456789abcdef0123456789"  # lower case on purpose: both sides must upper it
DAYS = 45

throwaway = Ed25519PrivateKey.generate()
keygen._load_private_key = lambda: throwaway

with tempfile.TemporaryDirectory() as tmp:
    keygen.LOG_DIR = Path(tmp)
    with contextlib.redirect_stdout(io.StringIO()):
        keygen.cmd_issue(argparse.Namespace(email=EMAIL, machine_id=MACHINE_ID, days=DAYS))
    records = sorted(Path(tmp).glob("*.json"))
    if len(records) != 1:
        print(json.dumps({"error": f"cmd_issue wrote {len(records)} log records, expected 1"}))
        sys.exit(0)
    issued = json.loads(records[0].read_text(encoding="utf-8"))

pub_der = throwaway.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)

try:
    here_mid = license_core.get_machine_id()
except Exception:
    here_mid = ""

print(json.dumps({
    "throwaway_public_key_b64": base64.b64encode(pub_der).decode("ascii"),
    "email_typed":      EMAIL,
    "machine_id_typed": MACHINE_ID,
    "email":            issued["email"],
    "machine_id":       issued["machine_id"],
    "expiry":           issued["expiry"],
    "password":         issued["password"],
    "key":              issued["key"],
    "canonical":        license_core.canonical_signed_string(issued["email"], issued["machine_id"], issued["expiry"], issued["password"]),
    "core_public_key_b64":  license_core.PUBLIC_KEY_B64,
    "core_payload_version": license_core.PAYLOAD_VERSION,
    "keygen_payload_version": keygen.PAYLOAD_VERSION,
    "machine_id_here":  here_mid,
}))
