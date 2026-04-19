SBS LICENSE SYSTEM
==================
Version 1.0  |  For SBS Step Browser


HOW IT WORKS
------------
Every client installation needs a license file (.lic) to run.
You (Nadav) are the only person who can create valid license files.
Even if someone copies the app, it won't run without a license for their machine.


FILES IN THIS FOLDER
--------------------
  license_core.py       Core logic — used by the app and keygen. Don't edit.
  keygen.py             YOUR private tool to create licenses. Keep this private.
  get_machine_id.py     Clients run this to find out their machine ID.

  01_setup.bat          Run this FIRST — installs required Python package.
  02_init_keys.bat      Run this ONCE — generates your signing keys.
  03_issue_license.bat  Issue a standard client license.
  04_issue_master_license.bat  Issue a master license for your team.
  05_get_my_machine_id.bat  Get the machine ID of the current computer.
  06_inspect_license.bat   Inspect or verify any .lic file.

  keys/                 YOUR PRIVATE KEYS — keep this backed up and secret!
  issued_licenses/      All licenses you've generated — for your records.


FIRST-TIME SETUP (DO ONCE)
--------------------------
1. Double-click  01_setup.bat
   - This installs the 'cryptography' package.

2. Double-click  02_init_keys.bat
   - This generates your private/public key pair.
   - Copy the PUBLIC_KEY_B64 line it prints.
   - Paste it into license_core.py  (replace the REPLACE_WITH_YOUR_PUBLIC_KEY line).

3. Back up the  keys/  folder somewhere safe (USB, secure cloud, etc.)
   If you lose the private key, you cannot issue new licenses that work
   with existing app installations.


HOW TO ISSUE A LICENSE TO A CLIENT
-----------------------------------
Step 1: Send the client  05_get_my_machine_id.bat  (or get_machine_id.py)
        They run it, and it prints/saves a 32-character ID like:
            A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4

Step 2: You run  03_issue_license.bat
        Enter the client name and their machine ID.
        A .lic file is created in the  issued_licenses/  folder.

Step 3: Send the .lic file to the client.
        They drop it in the root of their SBS installation folder
        (same folder as the SBS launcher).

That's it — the app will find and validate it automatically.


HOW TO ISSUE A MASTER LICENSE (FOR YOUR TEAM)
----------------------------------------------
Run  04_issue_master_license.bat
Enter a name like "SBS Internal".
The resulting .lic file works on ANY machine with NO expiry.
Keep it somewhere safe — treat it like a password.


LICENSE FILE FORMAT
-------------------
A .lic file is a simple JSON file, cryptographically signed.
It contains: client name, machine ID, issue date, expiry date, license type.
The signature means any change to the file (even one character) makes it invalid.
Clients cannot forge or extend a license — only you can, with your private key.


SECURITY NOTES
--------------
- The private key (keys/sbs_private.key) NEVER leaves your machine.
- The public key is embedded in the app and is safe to distribute.
- License files are signed with Ed25519 — the same algorithm used by SSH.
- Even if someone reverse-engineers the app, they cannot create valid licenses.
- You can revoke a client by simply not renewing their license when it expires.


TROUBLESHOOTING
---------------
"License file not found"
  → Client hasn't placed the .lic file in the right folder.
  → It should be in the same folder as the SBS launcher .exe / .bat

"License is locked to a different machine"
  → The .lic was issued for a different computer.
  → If the client got a new PC, they need to run get_machine_id again
    and you need to issue a new license for the new machine ID.

"This license expired"
  → Issue a new license with a new expiry date.

"Piper import error" / "cryptography not installed"
  → Run 01_setup.bat on that machine.
