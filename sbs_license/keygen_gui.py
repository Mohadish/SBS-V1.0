"""
SBS License Issuer — GUI
=========================
Friendly desktop form for issuing licenses to customers. Wraps the same
signing logic as `keygen.py --issue` and renders a ready-to-paste message
the operator (Nadav) can drop straight into email / WhatsApp / etc.

Run:
    python keygen_gui.py

Requires (already required by keygen.py):
    pip install cryptography

The GUI uses tkinter (ships with Python on Windows / macOS / most Linux
distros — no extra install).

Fields:
  Customer name      — used only for the "Hi <name>," greeting.
  Customer email     — becomes the licensed email (lowercased internally).
  Customer machine ID — 32-hex string the customer pastes from the SBS
                        activation dialog's read-only field.
  Valid for (days)   — license lifetime, default 30.

Output:
  Pre-formatted message with EMAIL / PASSWORD / KEY laid out, ready to copy.
  Every issued license is also written to issued_licenses/ as an audit log,
  same as the CLI keygen.
"""
from __future__ import annotations

import json
import sys
import tkinter as tk
from datetime import date, timedelta
from pathlib import Path
from tkinter import messagebox, ttk

# Make sibling modules importable when launched from anywhere.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from license_core import (   # noqa: E402
    PAYLOAD_VERSION,
    canonical_signed_string,
    encode_key_blob,
)
from keygen import (         # noqa: E402
    LOG_DIR,
    _generate_password,
    _load_private_key,
)


# ─────────────────────────────────────────────────────────────────────────────
#  Core: issue a license (same as keygen.py --issue, factored for GUI use)
# ─────────────────────────────────────────────────────────────────────────────

def issue_license(name: str, email: str, machine_id: str, days: int) -> dict:
    """
    Sign + log a license. Returns a dict with everything the GUI needs to
    render the customer message. Raises ValueError on bad input.
    """
    email = (email or "").strip().lower()
    machine_id = (machine_id or "").strip().upper()
    # Strip spaces inside the machine ID in case it was copied with formatting.
    machine_id = "".join(machine_id.split())

    if not email or "@" not in email or "." not in email.split("@")[-1]:
        raise ValueError("Email must look like a real address (name@host.tld).")
    if len(machine_id) < 8:
        raise ValueError(
            "Machine ID looks too short — expected 32 hex chars.\n"
            "Ask the customer to copy it from the read-only field in the SBS\n"
            "activation dialog (📋 Copy button)."
        )
    try:
        days = int(days)
    except (TypeError, ValueError):
        raise ValueError("Days must be a whole number.")
    if days < 1:
        raise ValueError("Days must be at least 1.")
    if days > 3650:
        raise ValueError("Days > 10 years — almost certainly a typo. Aborting.")

    expiry = (date.today() + timedelta(days=days)).isoformat()
    password = _generate_password()

    payload = {
        "v":     PAYLOAD_VERSION,
        "email": email,
        "mid":   machine_id,
        "exp":   expiry,
    }
    private_key = _load_private_key()
    signed_data = canonical_signed_string(email, machine_id, expiry, password).encode("utf-8")
    signature = private_key.sign(signed_data)
    key = encode_key_blob(payload, signature)

    # Audit log — same shape as CLI keygen, plus the operator-supplied name.
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "issued":     date.today().isoformat(),
        "name":       (name or "").strip(),
        "email":      email,
        "machine_id": machine_id,
        "expiry":     expiry,
        "days":       days,
        "password":   password,
        "key":        key,
    }
    log_name = f"{date.today().isoformat()}_{email.replace('@', '_at_')}_{machine_id[:8]}.json"
    (LOG_DIR / log_name).write_text(json.dumps(record, indent=2), encoding="utf-8")

    return {
        "name":       (name or "").strip(),
        "email":      email,
        "machine_id": machine_id,
        "password":   password,
        "key":        key,
        "expiry":     expiry,
        "days":       days,
        "log_path":   str(LOG_DIR / log_name),
    }


def format_customer_message(r: dict) -> str:
    """Pre-formatted text ready to paste into email / chat."""
    greeting = f"Hi {r['name']}," if r["name"] else "Hi,"
    return (
        f"{greeting}\n"
        f"\n"
        f"Your SBS license is ready. Open SBS — the activation dialog\n"
        f"will appear automatically. Paste these three values:\n"
        f"\n"
        f"  EMAIL:    {r['email']}\n"
        f"  PASSWORD: {r['password']}\n"
        f"\n"
        f"  KEY (paste the entire long string below):\n"
        f"{r['key']}\n"
        f"\n"
        f"This license is valid for {r['days']} days and expires on {r['expiry']}.\n"
        f"SBS will show a warning for the last 3 days before expiry — contact\n"
        f"me to renew.\n"
        f"\n"
        f"— Nadav\n"
    )


# ─────────────────────────────────────────────────────────────────────────────
#  GUI
# ─────────────────────────────────────────────────────────────────────────────

class KeygenApp(tk.Tk):
    PAD = 12

    def __init__(self):
        super().__init__()
        self.title("SBS License Issuer")
        self.geometry("760x680")
        self.minsize(640, 520)

        self._build_form()
        self._build_actions()
        self._build_output()
        self._build_footer()

        # Sanity: warn early if the keypair isn't set up yet.
        try:
            _load_private_key()
        except SystemExit:
            messagebox.showerror(
                "Private key missing",
                "No private key found.\n\n"
                "Run `python keygen.py --init-keys` once on this machine\n"
                "to generate it, then relaunch this app.",
            )
            self.destroy()
            sys.exit(1)

    # ── widget construction ──────────────────────────────────────────────
    def _build_form(self):
        frame = ttk.LabelFrame(self, text="Customer details", padding=self.PAD)
        frame.pack(fill="x", padx=self.PAD, pady=(self.PAD, 6))

        self.name_var  = tk.StringVar()
        self.email_var = tk.StringVar()
        self.mid_var   = tk.StringVar()
        self.days_var  = tk.StringVar(value="30")

        rows = [
            ("Name (for greeting):",       self.name_var,  None),
            ("Email:",                     self.email_var, None),
            ("Machine ID (32 hex chars):", self.mid_var,   ("Consolas", 10)),
            ("Valid for (days):",          self.days_var,  None),
        ]
        for r, (label, var, font) in enumerate(rows):
            ttk.Label(frame, text=label).grid(row=r, column=0, sticky="w", pady=4)
            kwargs = {"textvariable": var, "width": 60}
            if font:
                kwargs["font"] = font
            e = ttk.Entry(frame, **kwargs)
            e.grid(row=r, column=1, sticky="ew", pady=4, padx=(8, 0))
            if r == 0:
                e.focus_set()

        frame.columnconfigure(1, weight=1)

    def _build_actions(self):
        frame = ttk.Frame(self, padding=(self.PAD, 0))
        frame.pack(fill="x")
        ttk.Button(frame, text="🔑 Issue License", command=self._on_issue).pack(side="left")
        ttk.Button(frame, text="Clear form", command=self._on_clear).pack(side="left", padx=8)

    def _build_output(self):
        frame = ttk.LabelFrame(self, text="Ready-to-send message", padding=8)
        frame.pack(fill="both", expand=True, padx=self.PAD, pady=8)

        self.output = tk.Text(
            frame,
            wrap="word",
            font=("Consolas", 10),
            height=20,
            background="#1e293b",
            foreground="#e2e8f0",
            insertbackground="#e2e8f0",
        )
        self.output.pack(fill="both", expand=True)

    def _build_footer(self):
        frame = ttk.Frame(self, padding=(self.PAD, 0, self.PAD, self.PAD))
        frame.pack(fill="x")

        ttk.Button(frame, text="📋 Copy message", command=self._on_copy).pack(side="left")

        self.status_var = tk.StringVar(value="")
        ttk.Label(frame, textvariable=self.status_var, foreground="#16a34a").pack(side="left", padx=10)

    # ── handlers ─────────────────────────────────────────────────────────
    def _on_issue(self):
        try:
            result = issue_license(
                self.name_var.get(),
                self.email_var.get(),
                self.mid_var.get(),
                self.days_var.get().strip() or "30",
            )
        except ValueError as e:
            messagebox.showerror("Cannot issue license", str(e))
            self.status_var.set("")
            return
        except Exception as e:
            messagebox.showerror("Issue failed", f"Unexpected error:\n{e}")
            self.status_var.set("")
            return

        msg = format_customer_message(result)
        self.output.delete("1.0", "end")
        self.output.insert("1.0", msg)
        self.status_var.set(
            f"Issued. Expires {result['expiry']} — log: {Path(result['log_path']).name}"
        )

    def _on_copy(self):
        text = self.output.get("1.0", "end-1c")
        if not text.strip():
            self.status_var.set("Nothing to copy yet — issue a license first.")
            return
        self.clipboard_clear()
        self.clipboard_append(text)
        # update() ensures clipboard persists after the window closes.
        self.update()
        self.status_var.set("Copied to clipboard ✓")

    def _on_clear(self):
        self.name_var.set("")
        self.email_var.set("")
        self.mid_var.set("")
        self.days_var.set("30")
        self.output.delete("1.0", "end")
        self.status_var.set("")


if __name__ == "__main__":
    KeygenApp().mainloop()
