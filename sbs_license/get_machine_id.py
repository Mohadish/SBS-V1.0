"""
SBS — Get My Machine ID
=======================
Clients run this ONCE to find out their machine ID.
They then send that ID to Nadav, who uses keygen.py to issue them a license.

No installation required — uses only Python standard library.
"""
import sys
import os

# Make sure we can find license_core.py in the same folder
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from license_core import get_machine_id

def main():
    print()
    print("=" * 60)
    print("  SBS Step Browser — Machine ID")
    print("=" * 60)
    print()

    machine_id = get_machine_id()

    print(f"  Your Machine ID is:")
    print()
    print(f"       {machine_id}")
    print()
    print("  Please send this ID to your SBS administrator.")
    print("  They will generate a license file for your machine.")
    print()
    print("  Once you receive the .lic file, place it in the")
    print("  same folder as the SBS launcher.")
    print()
    print("=" * 60)
    print()

    # Also write it to a text file so the user can easily copy/paste or email it
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "my_machine_id.txt")
    try:
        with open(out_path, "w") as f:
            f.write(f"SBS Machine ID\n")
            f.write(f"==============\n")
            f.write(f"{machine_id}\n\n")
            f.write(f"Send this file or the ID above to your SBS administrator.\n")
        print(f"  Also saved to: {out_path}")
        print()
    except Exception:
        pass

    input("  Press Enter to close...")

if __name__ == "__main__":
    main()
