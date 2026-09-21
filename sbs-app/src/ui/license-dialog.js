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
/**
 * @param {object} [o]
 * @param {string} [o.initialEmail]
 * @param {string} [o.reason]        a verifier reason to show straight away
 * @param {'activate'|'renew'} [o.mode]  'renew' = opened from Help ▸ Licence…
 *        on a computer that is ALREADY licensed: Cancel goes back, it does not
 *        quit, and a key that would SHORTEN the licence asks before replacing.
 * @param {string} [o.currentExpiry]  YYYY-MM-DD of the licence in place (renew)
 */
export function showActivationDialog({ initialEmail = '', reason = null, mode = 'activate', currentExpiry = '' } = {}) {
  const renew = mode === 'renew';
  return new Promise((resolve, reject) => {
    _closeActive();

    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.style.cssText = 'max-width:520px;';
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div class="sbs-dialog__title">${renew ? 'Enter a new key' : 'Activate SBS'}</div>
        <div class="small" style="margin-top:8px;line-height:1.55;">
          ${renew
            ? `Paste the <b>password</b> and <b>key</b> your distributor sent. The licence on this computer is replaced only if the new one is valid — until then nothing changes.`
            : `To use SBS, send your distributor your <b>email</b> and your
          <b>machine ID</b> (shown below). They will reply with a
          <b>password</b> and a <b>key</b>. Paste both here.`}
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
          <button class="btn" id="lic-quit" type="button">${renew ? 'Cancel' : 'Quit SBS'}</button>
          <button class="btn" id="lic-activate" type="button" style="background:#0369a1;color:#f1f5f9;">🔑 ${renew ? 'Use this key' : 'Activate'}</button>
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

    let shorterOk = false;     // the user has been warned once and pressed again
    const _attemptActivate = async () => {
      $error.style.display = 'none';
      $btn.disabled = true;
      try {
        // RENEWING: never let a slip of the clipboard cost the user days. An
        // older key is perfectly VALID, so activate would happily replace a
        // longer licence with a shorter one. Look first (validate persists
        // nothing), and ask before going backwards.
        if (renew && currentExpiry && !shorterOk) {
          const peek = await window.sbsNative.license.validate({ email: $email.value, password: $pwd.value, key: $key.value });
          if (peek?.valid && peek.expiry && peek.expiry < currentExpiry) {
            shorterOk = true;
            $error.textContent = `This key runs until ${peek.expiry} — EARLIER than the licence you already have (${currentExpiry}). It may be an older key. Press "Use this key" again to replace it anyway.`;
            $error.style.display = 'block';
            return;
          }
        }
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
 * 🔑 HELP ▸ LICENCE… — the licence, where a licensed user can reach it.
 *
 * Until this existed the only licence UI was the activation dialog, and that
 * only ever appears when the app is NOT licensed. So a customer with a working
 * copy could not:
 *   • see when their licence runs out, or copy their machine ID;
 *   • ENTER A RENEWAL EARLY — a new key could only be typed in after the old
 *     one had expired and locked the app, i.e. in the middle of their work;
 *   • take the licence off a computer they are handing on. The IPC for that
 *     existed; nothing called it, and the only route was being talked through
 *     deleting a file in AppData.
 *
 * WHAT DEACTIVATE IS — AND IS NOT. There is no server, so deactivating frees
 * nothing anywhere: a key is bound to a machine, and a DIFFERENT computer
 * needs a new key issued for ITS machine ID. Deactivate simply removes the
 * licence from this one. The panel says exactly that, because the natural
 * guess ("this moves my licence") is wrong and would strand someone.
 *
 * @param {object} [o]
 * @param {() => boolean} [o.isDirty]  unsaved work? Deactivating would leave a
 *        project that cannot be saved, so it is refused until it is.
 */
export async function showLicensePanel({ isDirty = () => false } = {}) {
  _closeActive();
  let status;
  try { status = await window.sbsNative.license.status(); }
  catch (err) { setStatus(`Could not read the licence: ${err?.message || err}`, 'danger', 6000); return; }

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.style.cssText = 'max-width:520px;';
  const days = Number(status?.daysRemaining);
  const when = status?.expiry
    ? `valid until <b>${_esc(status.expiry)}</b>` + (Number.isFinite(days) ? ` — ${days} day${days === 1 ? '' : 's'} left` : '')
    : 'no expiry date on record';
  const tone = status?.state === 'grace' ? '#fbbf24' : '#4ade80';
  dlg.innerHTML = `
    <div class="sbs-dialog__body">
      <div class="sbs-dialog__title">Licence</div>
      <div class="small" style="margin-top:10px;line-height:1.6;">
        <span style="color:${tone};">●</span>
        Licensed to <b>${_esc(status?.email || '—')}</b><br>${when}
        ${status?.legacyBinding ? '<br><span style="color:#fbbf24;">Tied to an older fingerprint of this PC — ask your distributor for an updated key.</span>' : ''}
      </div>

      <div style="margin-top:14px;">
        <label class="small muted" style="display:block;margin-bottom:4px;">This computer's machine ID</label>
        <div style="display:flex;gap:6px;align-items:center;">
          <input id="lp-mid" readonly value="${_esc(status?.machineId || '')}" style="flex:1;font-family:monospace;font-size:13px;" />
          <button class="btn" id="lp-copy" type="button">📋 Copy</button>
        </div>
      </div>

      <div id="lp-confirm" class="small" style="display:none;margin-top:14px;padding:10px;line-height:1.55;background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.45);border-radius:4px;">
        <b>Take the licence off this computer?</b><br>
        SBS will ask for a key the next time it starts. Your key is not destroyed —
        entering it again <b>on this same computer</b> re-activates it.<br>
        This does <b>not</b> move the licence: to use SBS on a <b>different</b> computer,
        send your distributor <b>that</b> computer's machine ID for a new key.
        <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
          <button class="btn" id="lp-no" type="button">Keep it</button>
          <button class="btn" id="lp-yes" type="button" style="background:#b91c1c;color:#fff;">Deactivate and restart</button>
        </div>
      </div>
      <div id="lp-msg" class="small" style="display:none;margin-top:10px;padding:8px;background:rgba(220,38,38,0.12);border:1px solid rgba(220,38,38,0.4);border-radius:4px;color:#fca5a5;"></div>

      <div id="lp-actions" style="display:flex;gap:8px;margin-top:16px;justify-content:space-between;">
        <button class="btn" id="lp-deact" type="button">Deactivate this computer…</button>
        <span style="display:flex;gap:8px;">
          <button class="btn" id="lp-renew" type="button" style="background:#0369a1;color:#f1f5f9;">🔑 Enter a new key…</button>
          <button class="btn" id="lp-close" type="button">Close</button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  _activeDialog = dlg;
  const $ = (id) => dlg.querySelector(id);
  const done = () => { try { dlg.close(); } catch { /* already closed */ } dlg.remove(); if (_activeDialog === dlg) _activeDialog = null; };

  $('#lp-copy').addEventListener('click', () => {
    $('#lp-mid').select();
    navigator.clipboard.writeText($('#lp-mid').value).then(
      () => setStatus('Machine ID copied to clipboard.'),
      () => setStatus('Copy failed — select + Ctrl-C manually.', 'warn'),
    );
  });
  $('#lp-close').addEventListener('click', done);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(); });

  $('#lp-renew').addEventListener('click', async () => {
    done();
    try {
      const r = await showActivationDialog({ initialEmail: status?.email || '', mode: 'renew', currentExpiry: status?.expiry || '' });
      if (r?.valid) setStatus(`New key accepted — valid until ${r.expiry}.`, 'success', 6000);
    } catch { /* cancelled: the licence in place stands */ }
    showLicensePanel({ isDirty });            // back to the panel, with whatever is true now
  });

  $('#lp-deact').addEventListener('click', () => {
    const $msg = $('#lp-msg');
    if (isDirty()) {
      $msg.textContent = 'This project has unsaved changes. Save it first — once the licence is off this computer, SBS cannot save anything.';
      $msg.style.display = 'block';
      return;
    }
    $msg.style.display = 'none';
    $('#lp-actions').style.display = 'none';
    $('#lp-confirm').style.display = 'block';
  });
  $('#lp-no').addEventListener('click', () => { $('#lp-confirm').style.display = 'none'; $('#lp-actions').style.display = 'flex'; });
  $('#lp-yes').addEventListener('click', async () => {
    if (isDirty()) { $('#lp-no').click(); $('#lp-deact').click(); return; }   // it became dirty while the question was up
    try {
      await window.sbsNative.license.deactivate();
      window.location.reload();               // boot again: the gate now shows the activation dialog
    } catch (err) {
      const $msg = $('#lp-msg');
      $msg.textContent = `Could not deactivate: ${err?.message || err}`;
      $msg.style.display = 'block';
    }
  });

  dlg.showModal();
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
/**
 * The licence is good, but it is bound to an OLDER fingerprint of this machine
 * — one the app used before it could read the hardware properly. That older
 * fingerprint is the fragile one (a Windows feature update can change it), so
 * say so now, while everything still works, rather than let it turn into a
 * lockout later. Logged with the ID to send, so it can be copied from the
 * console; the status line just asks.
 */
export function showLegacyBindingNotice(status) {
  console.warn('[license] valid, but bound to an older machine fingerprint. Ask your distributor to re-issue the key for machine ID:', status?.machineId);
  setStatus('Your SBS licence is tied to an older fingerprint of this PC — please ask your distributor for an updated key (no rush; it keeps working).', 'warning', 12000);
}

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
