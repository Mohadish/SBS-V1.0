SBS LICENSE SYSTEM
==================
Version 2.0  |  For SBS Step Browser

The v2 model replaces the old .lic file with a (PASSWORD, KEY) pair.
The client never gets a file — they receive two strings (one short
"password", one long "key") and type/paste them into the SBS
activation dialog on first launch.

3-factor binding: machine_id + email + password → unlocks the key →
extracts the embedded expiry date. All four must match the keygen
output, or validation fails.


FILES IN THIS FOLDER
--------------------
  license_core.py       Core crypto + validation. JS port lives in
                        sbs-app/electron/license/verify.js — keep them in sync.
  keygen.py             YOUR private tool. Issues passwords + keys.
                        NEVER ship this or the keys/ folder.
  get_machine_id.py     Stand-alone helper to print THIS machine's ID.

  01_setup.bat                  Install the 'cryptography' Python package.
  02_init_keys.bat              Generate your Ed25519 signing keys (run once).
  03_issue_license.bat          Issue a new (password, key) for a client.
  05_get_my_machine_id.bat      Print this machine's ID (for testing).
  06_inspect_license.bat        Verify a (email, password, key, mid) tuple
                                — same logic the SBS app runs at boot.

  keys/                 YOUR PRIVATE KEYS — keep backed up + secret.
  issued_licenses/      Audit log of every license issued. Plain JSON;
                        the password + key are recorded here so you can
                        re-send to a client who lost them.


FIRST-TIME SETUP (DO ONCE)
--------------------------
1. Double-click  01_setup.bat
   - Installs the 'cryptography' Python package.

2. Double-click  02_init_keys.bat
   - Generates your private/public key pair into keys/.
   - It prints a PUBLIC_KEY_B64 line.
   - Paste that line into TWO files:
       sbs_license/license_core.py
       sbs-app/electron/license/verify.js
     Replace the placeholder string in both. They MUST match.

3. Back up the keys/ folder somewhere safe. If you lose
   sbs_private.key, you cannot issue new licenses that work with
   existing installs.


ISSUING A LICENSE TO A CLIENT
-----------------------------
Step 1: Client runs the SBS installer + launches the app once.
        On first launch, the activation dialog shows:
            "Your machine ID: ABC123..."
        Client emails you their EMAIL + this machine ID.

Step 2: You run  03_issue_license.bat
        Enter: client email, machine ID, license duration (days).
        Output:
            PASSWORD :  XYZ4-A2BC   (short — user types)
            KEY      :  <long base64 string>   (long — user pastes)

Step 3: Email BOTH the password AND the key to the client.

Step 4: Client returns to the SBS activation dialog, types email +
        password + pastes the key.  App validates and unlocks for
        the duration you set.


GRACE PERIOD
------------
Within 3 days of expiry, the app shows a warning toast at boot but
still runs. After expiry, the app hard-locks (refuses to launch
until a new license is entered).


LICENSE FORMAT (FYI)
--------------------
The "key" is base64-encoded:
    payload + b"|" + signature
where payload = { v: 2, email, mid, exp } (compact JSON) and
signature = Ed25519 over "{email}|{mid}|{exp}|{password}".

The password is NOT in the payload — it's input to the signature
function. The verifier re-computes the signed string from
(email, mid, exp_from_key, password) and checks the signature in
the key. If any input is wrong, signature fails.


SECURITY NOTES
--------------
- Private key NEVER leaves your machine.
- Public key is embedded in the app — safe to distribute.
- Ed25519 signatures: cryptographically infeasible to forge without
  the private key.
- 3-factor binding means a leaked key alone is useless — attacker
  also needs the matching email + password + a machine that matches
  the embedded machine ID.
- Time-limited keys auto-expire — no revocation server needed.


TROUBLESHOOTING
---------------
"Invalid signature"
  → One of: wrong password / wrong key / wrong email / wrong machine ID.
    Make sure the client is typing the exact strings you sent.

"Machine mismatch"
  → Client's hardware ID does not match the key's embedded ID.
    Did they reinstall on a different machine? Issue a new key.

"Expired"
  → Issue a new license with a longer duration.

"Malformed key"
  → The base64 key string was probably truncated in email — wrap it
    in <pre> tags or send as an attachment to preserve every character.
