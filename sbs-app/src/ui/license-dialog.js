/**
 * SBS license activation dialog
 * =============================
 * Renderer-side UI for first-launch activation + expired-license
 * recovery. Talks to the main process via window.sbsNative.license.*
 * — no validation logic lives in the renderer.
 *
 * Three entry points:
 *   showActivationDialog()       Modal, blocking. Resolves when the user
 *                                successfully activates (or quits via Esc).
 *   showHardLockDialog(status)   Terminal screen — user can't dismiss
 *                                except by entering a fresh activation.
 *   showGraceWarning(status)     One-shot toast: "License expires in N days".
 *
 * Status comes from sbsNative.license.status():
 *   { state: 'unactivated' | 'valid' | 'grace' | 'expired',
 *     machineId, email?, expiry?, daysRemaining?, reason? }
 */

import { setStatus } from './status.js';

const REASON_HUMAN = {
  EXPIRED:           'License has expired. Contact your distributor.',
  EMAIL_MISMATCH:    'Email does not match the one this key was issued for.',
  MACHINE_MISMATCH:  'This key was issued for a different machine.',
  INVALID_SIGNATURE: 'Password or key is incorrect — try again, or contact your distributor.',
  MALFORMED_KEY:     'Key is malformed. Make sure you copied the entire string.',
  MISSING_INPUT:     'Please fill in all four fields.',
  VERSION_MISMATCH:  'This key is from an incompatible SBS version.',
  NOT_CONFIGURED:    'This SBS build has no public key configured. Contact your distributor.',
  BAD_PUBLIC_KEY:    'Internal: the embedded public key is invalid. Contact your distributor.',
};

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

let _activeDialog = null;

/**
 * First-launch / re-activation modal. Returns a Promise that resolves
 * with the final status object on success, or rejects with 'cancelled'
 * if the user closes the dialog via Esc/close button.
 */
export function showActivationDialog({ initialEmail = '', reason = null } = {}) {
  return new Promise((resolve, reject) => {
    _closeActive();

    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.style.cssText = 'max-width:520px;';
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div class="sbs-dialog__title">Activate SBS</div>
        <div class="small" style="margin-top:8px;line-height:1.55;">
          To use SBS, send your distributor your <b>email</b> and your
          <b>machine ID</b> (shown below). They will reply with a
          <b>password</b> and a <b>key</b>. Paste both here.
        </div>

        <div style="margin-top:14px;">
          <label class="small muted" style="display:block;margin-bottom:4px;">Your machine ID (read-only — send this to your distributor)</label>
          <div style="display:flex;gap:6px;align-items:center;">
            <input id="lic-mid" readonly value="loading…"
                   style="flex:1;font-family:monospace;font-size:13px;" />
            <button class="btn" id="lic-copy-mid" type="button">📋 Copy</button>
          </div>
        </div>

        <div style="margin-top:12px;">
          <label class="small muted" style="display:block;margin-bottom:4px;">Email</label>
          <input id="lic-email" type="email" autocomplete="email"
                 value="${_esc(initialEmail)}"
                 placeholder="you@example.com"
                 style="width:100%;" />
        </div>

        <div style="margin-top:10px;">
          <label class="small muted" style="display:block;margin-bottom:4px;">Password (from distributor)</label>
          <input id="lic-password" type="text" autocomplete="off"
                 placeholder="XXXX-XXXX"
                 style="width:100%;font-family:monospace;letter-spacing:1px;" />
        </div>

        <div style="margin-top:10px;">
          <label class="small muted" style="display:block;margin-bottom:4px;">Key (paste the long string)</label>
          <textarea id="lic-key" rows="4" autocomplete="off"
                    placeholder="Paste the long base64 key here…"
                    style="width:100%;font-family:monospace;font-size:11px;resize:vertical;"></textarea>
        </div>

        <div id="lic-error" class="small" style="display:none;margin-top:10px;padding:8px;background:rgba(220,38,38,0.12);border:1px solid rgba(220,38,38,0.4);border-radius:4px;color:#fca5a5;"></div>

        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
          <button class="btn" id="lic-quit" type="button">Quit SBS</button>
          <button class="btn" id="lic-activate" type="button" style="background:#0369a1;color:#f1f5f9;">🔑 Activate</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    _activeDialog = dlg;

    const $mid    = dlg.querySelector('#lic-mid');
    const $email  = dlg.querySelector('#lic-email');
    const $pwd    = dlg.querySelector('#lic-password');
    const $key    = dlg.querySelector('#lic-key');
    const $error  = dlg.querySelector('#lic-error');
    const $btn    = dlg.querySelector('#lic-activate');
    const $copy   = dlg.querySelector('#lic-copy-mid');
    const $quit   = dlg.querySelector('#lic-quit');

    if (reason) {
      $error.textContent = REASON_HUMAN[reason] || `Activation failed: ${reason}`;
      $error.style.display = 'block';
    }

    // Fetch machine ID and populate the read-only field
    window.sbsNative?.license?.getMachineId?.().then(mid => {
      $mid.value = mid || '(unavailable)';
    }).catch(() => { $mid.value = '(unavailable)'; });

    $copy.addEventListener('click', () => {
      $mid.select();
      navigator.clipboard.writeText($mid.value).then(
        () => setStatus('Machine ID copied to clipboard.'),
        () => setStatus('Copy failed — select + Ctrl-C manually.', 'warn'),
      );
    });

    const _attemptActivate = async () => {
      $error.style.display = 'none';
      $btn.disabled = true;
      try {
        const result = await window.sbsNative.license.activate({
          email:    $email.value,
          password: $pwd.value,
          key:      $key.value,
        });
        if (result?.valid) {
          dlg.close();
          dlg.remove();
          _activeDialog = null;
          resolve(result);
        } else {
          const msg = REASON_HUMAN[result?.reason] || `Activation failed: ${result?.reason || 'unknown'}`;
          $error.textContent = msg;
          $error.style.display = 'block';
        }
      } catch (err) {
        $error.textContent = `Activation failed: ${err?.message || err}`;
        $error.style.display = 'block';
      } finally {
        $btn.disabled = false;
      }
    };

    $btn.addEventListener('click', _attemptActivate);
    $key.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) _attemptActivate();
    });

    $quit.addEventListener('click', () => {
      dlg.close();
      dlg.remove();
      _activeDialog = null;
      reject(new Error('cancelled'));
    });

    // Esc closes via the same path (will quit the app — see boot wiring)
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();   // prevent native Esc auto-close
      dlg.close();
      dlg.remove();
      _activeDialog = null;
      reject(new Error('cancelled'));
    });

    dlg.showModal();
    requestAnimationFrame(() => $email.focus());
  });
}

/**
 * Terminal screen when the license is hard-locked (expired beyond
 * grace, signature broken, etc.). User can only "Re-activate" (opens
 * the activation dialog) or quit.
 */
export function showHardLockDialog(status) {
  return new Promise(resolve => {
    _closeActive();
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.style.cssText = 'max-width:480px;';
    const reasonMsg = REASON_HUMAN[status?.reason] || 'License is no longer valid.';
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="text-align:center;">
        <div class="sbs-dialog__title" style="color:#fca5a5;">🔒 SBS is locked</div>
        <div class="small" style="margin-top:14px;line-height:1.55;">
          ${_esc(reasonMsg)}
          ${status?.expiry ? `<br><br>License expired on: <b>${_esc(status.expiry)}</b>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-top:18px;justify-content:center;">
          <button class="btn" id="lock-quit" type="button">Quit</button>
          <button class="btn" id="lock-reactivate" type="button" style="background:#0369a1;color:#f1f5f9;">🔑 Re-activate</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    _activeDialog = dlg;

    dlg.querySelector('#lock-reactivate').addEventListener('click', () => {
      dlg.close(); dlg.remove(); _activeDialog = null;
      resolve('reactivate');
    });
    dlg.querySelector('#lock-quit').addEventListener('click', () => {
      dlg.close(); dlg.remove(); _activeDialog = null;
      resolve('quit');
    });
    dlg.addEventListener('cancel', (e) => e.preventDefault());   // can't close with Esc

    dlg.showModal();
  });
}

/**
 * One-shot informational toast: "Your license expires in N days".
 * Non-blocking — shown at boot when status.state === 'grace'.
 */
export function showGraceWarning(status) {
  const days = Math.max(0, Number(status?.daysRemaining) || 0);
  const msg  = days === 0
    ? 'Your SBS license expires TODAY. Contact your distributor to renew.'
    : `Your SBS license expires in ${days} day${days === 1 ? '' : 's'}. Contact your distributor to renew.`;
  setStatus(msg, 'warning', 8000);
}

function _closeActive() {
  if (_activeDialog) {
    try { _activeDialog.close(); _activeDialog.remove(); } catch {}
    _activeDialog = null;
  }
}
