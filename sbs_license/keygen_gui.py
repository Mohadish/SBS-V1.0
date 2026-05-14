"""
SBS License Issuer — GUI
=========================
Friendly desktop form for issuing licenses to customers. Tabbed UI:

  • Authoring tab  → license for SBS Step Browser
                     (machine-bound, 3-factor: email + password + key,
                      payload v=2)

  • Viewer tab     → license for SBS Viewer
                     (company-bound, 2-factor for station: email + key;
                      3-factor for manager: + machine ID,
                      payload v=10)

Run:
    python keygen_gui.py

Requires (already required by keygen.py):
    pip install cryptography

Output:
  Pre-formatted message with EMAIL / PASSWORD / KEY (authoring) or
  EMAIL / KEY (viewer) laid out, ready to copy.
  Every issued license is also written to issued_licenses/ as an audit
  log, same as the CLI keygen.
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
    PAYLOAD_VERSION,         # authoring payload version (= 2)
    canonical_signed_string, # authoring canonical
    encode_key_blob,
)
from keygen import (         # noqa: E402
    LOG_DIR,
    _generate_password,
    _load_private_key,
)


# ─────────────────────────────────────────────────────────────────────────────
#  Authoring license (SBS Step Browser) — payload v2
# ─────────────────────────────────────────────────────────────────────────────

def issue_license(name: str, email: str, machine_id: str, days: int) -> dict:
    """
    Sign + log an authoring license. Returns a dict for the GUI to render
    the customer message. Raises ValueError on bad input.
    """
    email = (email or "").strip().lower()
    machine_id = (machine_id or "").strip().upper()
    machine_id = "".join(machine_id.split())

    if not email or "@" not in email or "." not in email.split("@")[-1]:
        raise ValueError("Email must look like a real address (name@host.tld).")
    if len(machine_id) < 8:
        raise ValueError(
            "Machine ID looks too short — expected 32 hex chars.\n"
            "Ask the customer to copy it from the read-only field in the\n"
            "SBS activation dialog (📋 Copy button)."
        )
    try:
        days = int(days)
    except (TypeError, ValueError):
        raise ValueError("Days must be a whole number.")
    if days < 1:        raise ValueError("Days must be at least 1.")
    if days > 3650:     raise ValueError("Days > 10 years — almost certainly a typo. Aborting.")

    expiry   = (date.today() + timedelta(days=days)).isoformat()
    password = _generate_password()

    payload = {"v": PAYLOAD_VERSION, "email": email, "mid": machine_id, "exp": expiry}
    private_key = _load_private_key()
    signed_data = canonical_signed_string(email, machine_id, expiry, password).encode("utf-8")
    signature   = private_key.sign(signed_data)
    key         = encode_key_blob(payload, signature)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "issued":     date.today().isoformat(),
        "kind":       "authoring",
        "name":       (name or "").strip(),
        "email":      email,
        "machine_id": machine_id,
        "expiry":     expiry,
        "days":       days,
        "password":   password,
        "key":        key,
    }
    log_name = f"{date.today().isoformat()}_authoring_{email.replace('@', '_at_')}_{machine_id[:8]}.json"
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
    """Authoring customer message."""
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
#  Viewer license (SBS Viewer) — payload v10
# ─────────────────────────────────────────────────────────────────────────────

VIEWER_PAYLOAD_VERSION = 10


def _canonical_viewer(company_id: str, email: str, expiry: str,
                      mode: str, machine_id: str) -> str:
    """
    Canonical signed string for the viewer payload. MUST match the verifier
    in sbs-viewer/license/verify.js exactly (byte-for-byte).
    """
    return f"{VIEWER_PAYLOAD_VERSION}|{company_id}|{email}|{expiry}|{mode}|{machine_id or ''}"


def issue_viewer_license(name: str, email: str, company_id: str,
                         mode: str, machine_id: str, days: int) -> dict:
    """
    Sign + log a viewer license.
    Station mode: machine_id ignored.
    Manager mode: machine_id REQUIRED (license is bound to the machine).
    """
    email     = (email or "").strip().lower()
    company   = (company_id or "").strip()
    mode      = (mode or "station").strip().lower()
    if mode not in ("station", "manager"): mode = "station"
    mid_raw   = (machine_id or "").strip().upper()
    mid       = "".join(mid_raw.split())   # strip embedded whitespace

    if not company:
        raise ValueError("Company ID required (free-form; matches the value baked into the customer's installer).")
    if not email or "@" not in email or "." not in email.split("@")[-1]:
        raise ValueError("Email must look like a real address (name@host.tld).")
    if mode == "manager" and len(mid) < 8:
        raise ValueError(
            "Manager license requires a Machine ID (32 hex chars).\n"
            "Ask the customer to copy it from the read-only field in the\n"
            "viewer activation dialog (📋 Copy button)."
        )
    try:
        days = int(days)
    except (TypeError, ValueError):
        raise ValueError("Days must be a whole number.")
    if days < 1:       raise ValueError("Days must be at least 1.")
    if days > 3650:    raise ValueError("Days > 10 years — almost certainly a typo. Aborting.")

    expiry = (date.today() + timedelta(days=days)).isoformat()

    payload = {
        "v":          VIEWER_PAYLOAD_VERSION,
        "company_id": company,
        "email":      email,
        "exp":        expiry,
        "mode":       mode,
        "machine_id": mid if mode == "manager" else "",
    }
    private_key = _load_private_key()
    signed_data = _canonical_viewer(company, email, expiry, mode,
                                    mid if mode == "manager" else "").encode("utf-8")
    signature   = private_key.sign(signed_data)
    key         = encode_key_blob(payload, signature)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    record = {
        "issued":     date.today().isoformat(),
        "kind":       "viewer",
        "name":       (name or "").strip(),
        "email":      email,
        "company_id": company,
        "mode":       mode,
        "machine_id": payload["machine_id"],
        "expiry":     expiry,
        "days":       days,
        "key":        key,
    }
    mid_tag = (payload["machine_id"] or "anymachine")[:8]
    log_name = (
        f"{date.today().isoformat()}_viewer-{mode}_"
        f"{email.replace('@', '_at_')}_{company[:8]}_{mid_tag}.json"
    )
    (LOG_DIR / log_name).write_text(json.dumps(record, indent=2), encoding="utf-8")

    return {
        "name":       (name or "").strip(),
        "email":      email,
        "company_id": company,
        "mode":       mode,
        "machine_id": payload["machine_id"],
        "key":        key,
        "expiry":     expiry,
        "days":       days,
        "log_path":   str(LOG_DIR / log_name),
    }


def format_viewer_customer_message(r: dict) -> str:
    """Viewer customer message — no password (single key carries everything)."""
    greeting = f"Hi {r['name']}," if r["name"] else "Hi,"
    mode_line = (
        f"This is a MANAGER license — bound to the machine ID you sent.\n"
        if r["mode"] == "manager"
        else f"This is a STATION license — runs on any PC in your company.\n"
    )
    return (
        f"{greeting}\n"
        f"\n"
        f"Your SBS Viewer license is ready. Open SBS Viewer — the activation\n"
        f"dialog will appear automatically. Paste these two values:\n"
        f"\n"
        f"  EMAIL:    {r['email']}\n"
        f"\n"
        f"  KEY (paste the entire long string below):\n"
        f"{r['key']}\n"
        f"\n"
        f"This license is valid for {r['days']} days and expires on {r['expiry']}.\n"
        f"{mode_line}"
        f"SBS Viewer will show a warning the last 7 days before expiry — contact\n"
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
        self.geometry("820x740")
        self.minsize(700, 600)

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

        # Notebook with two tabs.
        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=self.PAD, pady=self.PAD)

        tab_authoring = ttk.Frame(nb)
        nb.add(tab_authoring, text="  Authoring  (SBS Step Browser)  ")
        self._build_authoring_tab(tab_authoring)

        tab_viewer = ttk.Frame(nb)
        nb.add(tab_viewer, text="  Viewer  (SBS Viewer)  ")
        self._build_viewer_tab(tab_viewer)

    # ── Authoring tab ────────────────────────────────────────────────────
    def _build_authoring_tab(self, parent):
        # State
        self.a_name_var  = tk.StringVar()
        self.a_email_var = tk.StringVar()
        self.a_mid_var   = tk.StringVar()
        self.a_days_var  = tk.StringVar(value="30")
        self.a_status_var = tk.StringVar(value="")

        form = ttk.LabelFrame(parent, text="Customer details", padding=self.PAD)
        form.pack(fill="x", padx=self.PAD, pady=(self.PAD, 6))

        rows = [
            ("Name (for greeting):",        self.a_name_var,  None),
            ("Email:",                       self.a_email_var, None),
            ("Machine ID (32 hex chars):",   self.a_mid_var,   ("Consolas", 10)),
            ("Valid for (days):",            self.a_days_var,  None),
        ]
        for r, (label, var, font) in enumerate(rows):
            ttk.Label(form, text=label).grid(row=r, column=0, sticky="w", pady=4)
            kw = {"textvariable": var, "width": 60}
            if font: kw["font"] = font
            ttk.Entry(form, **kw).grid(row=r, column=1, sticky="ew", pady=4, padx=(8, 0))
        form.columnconfigure(1, weight=1)

        actions = ttk.Frame(parent, padding=(self.PAD, 0))
        actions.pack(fill="x")
        ttk.Button(actions, text="🔑 Issue Authoring License",
                   command=self._on_issue_authoring).pack(side="left")
        ttk.Button(actions, text="Clear form",
                   command=self._on_clear_authoring).pack(side="left", padx=8)

        out_frame = ttk.LabelFrame(parent, text="Ready-to-send message", padding=8)
        out_frame.pack(fill="both", expand=True, padx=self.PAD, pady=8)
        self.a_output = tk.Text(out_frame, wrap="word", font=("Consolas", 10),
                                height=18, background="#1e293b",
                                foreground="#e2e8f0", insertbackground="#e2e8f0")
        self.a_output.pack(fill="both", expand=True)

        footer = ttk.Frame(parent, padding=(self.PAD, 0, self.PAD, self.PAD))
        footer.pack(fill="x")
        ttk.Button(footer, text="📋 Copy message",
                   command=lambda: self._copy_text(self.a_output, self.a_status_var)).pack(side="left")
        ttk.Label(footer, textvariable=self.a_status_var,
                  foreground="#16a34a").pack(side="left", padx=10)

    # ── Viewer tab ───────────────────────────────────────────────────────
    def _build_viewer_tab(self, parent):
        self.v_name_var    = tk.StringVar()
        self.v_email_var   = tk.StringVar()
        self.v_company_var = tk.StringVar()
        self.v_mode_var    = tk.StringVar(value="station")
        self.v_mid_var     = tk.StringVar()
        self.v_days_var    = tk.StringVar(value="365")    # viewer default = 1 year
        self.v_status_var  = tk.StringVar(value="")

        form = ttk.LabelFrame(parent, text="Customer details", padding=self.PAD)
        form.pack(fill="x", padx=self.PAD, pady=(self.PAD, 6))

        ttk.Label(form, text="Name (for greeting):").grid(row=0, column=0, sticky="w", pady=4)
        ttk.Entry(form, textvariable=self.v_name_var, width=60).grid(row=0, column=1, sticky="ew", pady=4, padx=(8, 0))

        ttk.Label(form, text="Email:").grid(row=1, column=0, sticky="w", pady=4)
        ttk.Entry(form, textvariable=self.v_email_var, width=60).grid(row=1, column=1, sticky="ew", pady=4, padx=(8, 0))

        ttk.Label(form, text="Company ID:").grid(row=2, column=0, sticky="w", pady=4)
        ttk.Entry(form, textvariable=self.v_company_var, width=60,
                  font=("Consolas", 10)).grid(row=2, column=1, sticky="ew", pady=4, padx=(8, 0))
        ttk.Label(form, text="(must match the value baked into the customer's installer)",
                  foreground="#64748b").grid(row=3, column=1, sticky="w", padx=(8, 0))

        ttk.Label(form, text="Mode:").grid(row=4, column=0, sticky="w", pady=4)
        mode_frame = ttk.Frame(form)
        mode_frame.grid(row=4, column=1, sticky="w", pady=4, padx=(8, 0))
        ttk.Radiobutton(mode_frame, text="Station (any PC in the company)",
                        variable=self.v_mode_var, value="station",
                        command=self._on_viewer_mode_change).pack(side="left")
        ttk.Radiobutton(mode_frame, text="Manager (one specific PC)",
                        variable=self.v_mode_var, value="manager",
                        command=self._on_viewer_mode_change).pack(side="left", padx=(12, 0))

        ttk.Label(form, text="Machine ID:").grid(row=5, column=0, sticky="w", pady=4)
        self.v_mid_entry = ttk.Entry(form, textvariable=self.v_mid_var, width=60,
                                      font=("Consolas", 10))
        self.v_mid_entry.grid(row=5, column=1, sticky="ew", pady=4, padx=(8, 0))
        self.v_mid_hint = ttk.Label(form, text="(required only for Manager mode)",
                                     foreground="#64748b")
        self.v_mid_hint.grid(row=6, column=1, sticky="w", padx=(8, 0))

        ttk.Label(form, text="Valid for (days):").grid(row=7, column=0, sticky="w", pady=4)
        ttk.Entry(form, textvariable=self.v_days_var, width=60).grid(row=7, column=1, sticky="ew", pady=4, padx=(8, 0))

        form.columnconfigure(1, weight=1)
        self._on_viewer_mode_change()   # set initial enabled-state of mid_entry

        actions = ttk.Frame(parent, padding=(self.PAD, 0))
        actions.pack(fill="x")
        ttk.Button(actions, text="🔑 Issue Viewer License",
                   command=self._on_issue_viewer).pack(side="left")
        ttk.Button(actions, text="Clear form",
                   command=self._on_clear_viewer).pack(side="left", padx=8)

        out_frame = ttk.LabelFrame(parent, text="Ready-to-send message", padding=8)
        out_frame.pack(fill="both", expand=True, padx=self.PAD, pady=8)
        self.v_output = tk.Text(out_frame, wrap="word", font=("Consolas", 10),
                                height=16, background="#1e293b",
                                foreground="#e2e8f0", insertbackground="#e2e8f0")
        self.v_output.pack(fill="both", expand=True)

        footer = ttk.Frame(parent, padding=(self.PAD, 0, self.PAD, self.PAD))
        footer.pack(fill="x")
        ttk.Button(footer, text="📋 Copy message",
                   command=lambda: self._copy_text(self.v_output, self.v_status_var)).pack(side="left")
        ttk.Label(footer, textvariable=self.v_status_var,
                  foreground="#16a34a").pack(side="left", padx=10)

    # ── shared handlers ──────────────────────────────────────────────────
    def _on_viewer_mode_change(self):
        is_manager = (self.v_mode_var.get() == "manager")
        self.v_mid_entry.configure(state="normal" if is_manager else "disabled")
        self.v_mid_hint.configure(
            text="(required — paste the customer's machine ID)"
                 if is_manager else
                 "(not used — station licenses run on any PC in the company)"
        )

    def _on_issue_authoring(self):
        try:
            result = issue_license(self.a_name_var.get(), self.a_email_var.get(),
                                   self.a_mid_var.get(),
                                   self.a_days_var.get().strip() or "30")
        except ValueError as e:
            messagebox.showerror("Cannot issue license", str(e))
            self.a_status_var.set("")
            return
        except Exception as e:
            messagebox.showerror("Issue failed", f"Unexpected error:\n{e}")
            self.a_status_var.set("")
            return
        msg = format_customer_message(result)
        self.a_output.delete("1.0", "end")
        self.a_output.insert("1.0", msg)
        self.a_status_var.set(
            f"Issued. Expires {result['expiry']} — log: {Path(result['log_path']).name}"
        )

    def _on_issue_viewer(self):
        try:
            result = issue_viewer_license(
                self.v_name_var.get(), self.v_email_var.get(),
                self.v_company_var.get(), self.v_mode_var.get(),
                self.v_mid_var.get(),
                self.v_days_var.get().strip() or "365",
            )
        except ValueError as e:
            messagebox.showerror("Cannot issue viewer license", str(e))
            self.v_status_var.set("")
            return
        except Exception as e:
            messagebox.showerror("Issue failed", f"Unexpected error:\n{e}")
            self.v_status_var.set("")
            return
        msg = format_viewer_customer_message(result)
        self.v_output.delete("1.0", "end")
        self.v_output.insert("1.0", msg)
        self.v_status_var.set(
            f"Issued ({result['mode']}). Expires {result['expiry']} — "
            f"log: {Path(result['log_path']).name}"
        )

    def _on_clear_authoring(self):
        self.a_name_var.set(""); self.a_email_var.set("")
        self.a_mid_var.set("");  self.a_days_var.set("30")
        self.a_output.delete("1.0", "end")
        self.a_status_var.set("")

    def _on_clear_viewer(self):
        self.v_name_var.set("");    self.v_email_var.set("")
        self.v_company_var.set(""); self.v_mode_var.set("station")
        self.v_mid_var.set("");     self.v_days_var.set("365")
        self.v_output.delete("1.0", "end")
        self.v_status_var.set("")
        self._on_viewer_mode_change()

    def _copy_text(self, text_widget, status_var):
        text = text_widget.get("1.0", "end-1c")
        if not text.strip():
            status_var.set("Nothing to copy yet — issue a license first.")
            return
        self.clipboard_clear()
        self.clipboard_append(text)
        self.update()
        status_var.set("Copied to clipboard ✓")


if __name__ == "__main__":
    KeygenApp().mainloop()
