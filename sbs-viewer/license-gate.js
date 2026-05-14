/* SBS Viewer — License Gate
 * =========================
 * Runs BEFORE viewer.js. Decides whether to show the activation dialog
 * or get out of the way.
 *
 *   - Electron mode (window.sbsViewer present)  → real gate, may block UI
 *   - Web mode      (no window.sbsViewer)       → skip — file-server access
 *                                                 is the gate
 *
 * Self-contained: builds its own DOM, no markup needed in viewer.html.
 *
 * Activation flow:
 *   - On load, ask main for status (license.status()).
 *   - state === 'valid'        → dismiss silently.
 *   - state === 'grace'        → toast "expires in N days", continue.
 *   - state === 'expired'      → hard-lock screen + Re-activate button.
 *   - state === 'unactivated'  → activation form.
 *
 * Once activation succeeds, the renderer reloads — simplest way to bring
 * viewer.js back up in a known clean state (no half-mounted UI).
 */

(function () {
  'use strict';

  // ── Web mode short-circuit ────────────────────────────────────────────
  // The viewer is also packaged as a static web page (served via plain
  // HTTP). In that case window.sbsViewer is undefined — there's no IPC,
  // no license check, and access is gated by whoever hosts the files.
  if (!window.sbsViewer?.license?.status) return;

  const REASON_HUMAN = {
    EXPIRED:          'License expired. Contact your distributor.',
    EMAIL_MISMATCH:   'Email does not match the one this key was issued for.',
    COMPANY_MISMATCH: 'This key was issued for a different company.',
    MACHINE_MISMATCH: 'This manager license is bound to a different machine.',
    INVALID_SIGNATURE:'Password or key is incorrect — try again, or contact your distributor.',
    MALFORMED_KEY:    'Key is malformed. Make sure you copied the entire string.',
    MISSING_INPUT:    'Please fill in both fields.',
    VERSION_MISMATCH: 'This key is from an incompatible SBS Viewer version.',
    NOT_CONFIGURED:   'This SBS Viewer build is not configured (missing company ID). Contact your distributor.',
    BAD_PUBLIC_KEY:   'Internal: the embedded public key is invalid. Contact your distributor.',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

  // ── Boot ───────────────────────────────────────────────────────────────
  window.sbsViewer.license.status().then(routeOnStatus).catch(err => {
    console.error('[license-gate] status check failed:', err);
    _showHardLock({ reason: 'NOT_CONFIGURED', err: err?.message || String(err) });
  });

  function routeOnStatus(status) {
    switch (status.state) {
      case 'valid':       return;                       // silent pass
      case 'grace':       return _toastGrace(status);   // warn + continue
      case 'expired':     return _showHardLock(status); // terminal — re-activate or quit
      default:            return _showActivation(status);
    }
  }

  // ── Toast (grace period) ──────────────────────────────────────────────
  function _toastGrace(status) {
    const days = Math.max(0, Number(status.daysRemaining) || 0);
    const msg  = days === 0
      ? 'Your SBS Viewer license expires TODAY. Contact your distributor to renew.'
      : `Your SBS Viewer license expires in ${days} day${days === 1 ? '' : 's'}.`;
    const toast = _el('div', {
      style:
        'position:fixed;top:14px;left:50%;transform:translateX(-50%);' +
        'background:#7c2d12;color:#fef3c7;padding:10px 16px;border-radius:6px;' +
        'font-size:13px;font-family:system-ui,sans-serif;z-index:99999;' +
        'box-shadow:0 4px 16px rgba(0,0,0,0.4);',
      textContent: '⚠ ' + msg,
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 9000);
  }

  // ── Activation dialog ─────────────────────────────────────────────────
  function _showActivation(status) {
    const company = status.company || { id: '', name: '' };
    const reason  = status.reason || null;

    const overlay = _overlay();
    const dlg = _el('div', { className: 'lic-dialog' });
    dlg.innerHTML = `
      <h2 style="margin:0 0 6px;font-size:18px;color:#f1f5f9;">Activate SBS Viewer</h2>
      <p style="margin:0 0 14px;color:#94a3b8;font-size:13px;line-height:1.5;">
        ${esc(company.name) ? `For <b style="color:#e2e8f0;">${esc(company.name)}</b>.` : ''}
        Send your distributor your <b>email</b> and (if asked) your
        <b>machine ID</b> shown below. They will reply with a long
        <b>key</b> — paste it below.
      </p>

      <div style="margin-bottom:10px;">
        <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:3px;">
          Your machine ID (only needed for manager licenses)
        </label>
        <div style="display:flex;gap:6px;">
          <input id="lic-mid" type="text" readonly
                 style="flex:1;background:#1e293b;color:#cbd5e1;border:1px solid #334155;
                        border-radius:4px;padding:6px 8px;font-family:monospace;font-size:12px;" />
          <button id="lic-copy" type="button"
                  style="background:#334155;color:#e2e8f0;border:none;border-radius:4px;
                         padding:6px 10px;font-size:12px;cursor:pointer;">📋 Copy</button>
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:3px;">Email</label>
        <input id="lic-email" type="email" autocomplete="email"
               placeholder="you@example.com"
               value="${esc(status.email || '')}"
               style="width:100%;background:#1e293b;color:#f1f5f9;border:1px solid #334155;
                      border-radius:4px;padding:8px 10px;font-size:13px;" />
      </div>

      <div style="margin-bottom:10px;">
        <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:3px;">
          Key (paste the long string)
        </label>
        <textarea id="lic-key" rows="5"
                  placeholder="Paste the long base64 key here…"
                  style="width:100%;background:#1e293b;color:#cbd5e1;border:1px solid #334155;
                         border-radius:4px;padding:8px 10px;font-size:11px;font-family:monospace;
                         resize:vertical;"></textarea>
      </div>

      <div id="lic-error" class="lic-error"
           style="display:${reason ? 'block' : 'none'};margin-bottom:10px;padding:8px 10px;
                  background:rgba(220,38,38,0.12);border:1px solid rgba(220,38,38,0.4);
                  border-radius:4px;color:#fca5a5;font-size:12px;">
        ${reason ? esc(REASON_HUMAN[reason] || `Activation failed: ${reason}`) : ''}
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="lic-quit" type="button"
                style="background:#1e293b;color:#cbd5e1;border:1px solid #334155;
                       border-radius:4px;padding:8px 16px;font-size:13px;cursor:pointer;">
          Quit
        </button>
        <button id="lic-activate" type="button"
                style="background:#0369a1;color:#f1f5f9;border:none;
                       border-radius:4px;padding:8px 18px;font-size:13px;cursor:pointer;font-weight:600;">
          🔑 Activate
        </button>
      </div>
    `;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    const $mid    = dlg.querySelector('#lic-mid');
    const $copy   = dlg.querySelector('#lic-copy');
    const $email  = dlg.querySelector('#lic-email');
    const $key    = dlg.querySelector('#lic-key');
    const $error  = dlg.querySelector('#lic-error');
    const $btn    = dlg.querySelector('#lic-activate');
    const $quit   = dlg.querySelector('#lic-quit');

    $mid.value = 'loading…';
    window.sbsViewer.license.getMachineId().then(id => { $mid.value = id || '(unavailable)'; })
      .catch(() => { $mid.value = '(unavailable)'; });

    $copy.addEventListener('click', () => {
      $mid.select();
      navigator.clipboard.writeText($mid.value).catch(() => {});
    });

    const attempt = async () => {
      $error.style.display = 'none';
      $btn.disabled = true;
      try {
        const result = await window.sbsViewer.license.activate({
          email: $email.value, key: $key.value,
        });
        if (result?.valid) {
          // Reload the renderer so viewer.js boots in a known clean
          // state — simpler than trying to surgically initialise it now.
          location.reload();
        } else {
          const r = result?.reason || 'unknown';
          $error.textContent = REASON_HUMAN[r] || `Activation failed: ${r}`;
          $error.style.display = 'block';
        }
      } catch (err) {
        $error.textContent = `Activation failed: ${err?.message || err}`;
        $error.style.display = 'block';
      } finally {
        $btn.disabled = false;
      }
    };

    $btn.addEventListener('click', attempt);
    $key.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) attempt();
    });
    $quit.addEventListener('click', () => window.close());

    setTimeout(() => $email.focus(), 0);
  }

  // ── Hard-lock screen ──────────────────────────────────────────────────
  function _showHardLock(status) {
    const overlay = _overlay();
    const dlg = _el('div', { className: 'lic-dialog' });
    const reason = status?.reason
      ? (REASON_HUMAN[status.reason] || `License is no longer valid (${status.reason}).`)
      : 'License is no longer valid.';
    dlg.innerHTML = `
      <h2 style="margin:0 0 14px;font-size:18px;color:#fca5a5;text-align:center;">🔒 SBS Viewer is locked</h2>
      <p style="margin:0 0 18px;color:#cbd5e1;font-size:13px;line-height:1.5;text-align:center;">
        ${esc(reason)}
        ${status?.expiry ? `<br><br>Expired on <b>${esc(status.expiry)}</b>.` : ''}
      </p>
      <div style="display:flex;gap:8px;justify-content:center;">
        <button id="lock-quit" type="button"
                style="background:#1e293b;color:#cbd5e1;border:1px solid #334155;
                       border-radius:4px;padding:8px 18px;font-size:13px;cursor:pointer;">
          Quit
        </button>
        <button id="lock-reactivate" type="button"
                style="background:#0369a1;color:#f1f5f9;border:none;
                       border-radius:4px;padding:8px 18px;font-size:13px;cursor:pointer;font-weight:600;">
          🔑 Re-activate
        </button>
      </div>
    `;
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    dlg.querySelector('#lock-quit').addEventListener('click', () => window.close());
    dlg.querySelector('#lock-reactivate').addEventListener('click', () => {
      overlay.remove();
      _showActivation({ company: status.company, email: status.email });
    });
  }

  // ── DOM helpers ───────────────────────────────────────────────────────
  function _overlay() {
    return _el('div', {
      style:
        'position:fixed;inset:0;background:rgba(15,23,42,0.92);' +
        'display:flex;align-items:center;justify-content:center;z-index:99998;' +
        'font-family:system-ui,sans-serif;',
    });
  }
  function _el(tag, props) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'style')         el.style.cssText  = v;
      else if (k === 'className') el.className     = v;
      else if (k === 'textContent') el.textContent = v;
      else                       el[k] = v;
    }
    return el;
  }
  // Inject ONE rule for the dialog box — everything else is inline.
  const styleTag = document.createElement('style');
  styleTag.textContent = `.lic-dialog {
    background:#0f172a;border:1px solid #334155;border-radius:8px;
    padding:24px;width:460px;max-width:90vw;color:#f1f5f9;
    box-shadow:0 12px 48px rgba(0,0,0,0.6);
  }`;
  document.head.appendChild(styleTag);
})();
