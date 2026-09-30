/**
 * 📣 PROGRESS BANNER (V0.3.4.182) — a big, top-of-screen notice for a long job.
 *
 * The status bar is one quiet line at the bottom; a transparent clip import
 * (libvpx alpha encode, minutes per clip) used to sit there as a single grey
 * sentence and looked like nothing was happening. This banner is the opposite:
 * fixed at the top centre, above every panel, with a headline, the item in
 * progress, a real progress bar, elapsed time and an ETA, and a Stop button.
 *
 * It is NOT modal — the app stays usable underneath (the job runs in the main
 * process anyway). Several jobs stack. Pure DOM; no app state.
 *
 *   const b = openProgressBanner({ title, note, onCancel });
 *   b.update({ headline, detail, frac, elapsedMs, etaMs });   // frac null = indeterminate
 *   b.finish(text, 'success' | 'warn', autoCloseMs);
 *   b.fail(text);
 *   b.cancelled                                                // true after Stop
 */

let _stack = null;

function _stackEl() {
  if (_stack && _stack.isConnected) return _stack;
  _stack = document.getElementById('sbs-progress-stack');
  if (!_stack) {
    _stack = document.createElement('div');
    _stack.id = 'sbs-progress-stack';
    _stack.className = 'sbs-progress-stack';
    document.body.appendChild(_stack);
  }
  return _stack;
}

/** "1m 05s", "48s", "2h 03m". */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '…';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * @param {object} o
 * @param {string}   o.title       big line ("Importing 6 steps from …")
 * @param {string}  [o.note]       small grey line under the bar
 * @param {string}  [o.cancelLabel]
 * @param {Function}[o.onCancel]   Stop pressed (the banner flips to "stopping…")
 */
export function openProgressBanner({ title, note = '', cancelLabel = 'Stop', onCancel = null } = {}) {
  const el = document.createElement('div');
  el.className = 'sbs-progress-banner sbs-progress-banner--busy';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="sbs-pb-row">
      <div class="sbs-pb-spin" aria-hidden="true"></div>
      <div class="sbs-pb-text">
        <div class="sbs-pb-title"></div>
        <div class="sbs-pb-headline"></div>
        <div class="sbs-pb-detail"></div>
      </div>
      <div class="sbs-pb-times">
        <div class="sbs-pb-elapsed" title="Elapsed"></div>
        <div class="sbs-pb-eta" title="Estimated time left"></div>
      </div>
      <button type="button" class="btn sbs-pb-cancel"></button>
      <button type="button" class="sbs-pb-close" title="Dismiss" aria-label="Dismiss">✕</button>
    </div>
    <div class="sbs-pb-bar"><div class="sbs-pb-fill"></div></div>
    <div class="sbs-pb-note"></div>`;
  const q = (s) => el.querySelector(s);
  q('.sbs-pb-title').textContent = title || '';
  q('.sbs-pb-note').textContent = note || '';
  q('.sbs-pb-note').style.display = note ? '' : 'none';
  const cancelBtn = q('.sbs-pb-cancel');
  cancelBtn.textContent = cancelLabel;
  cancelBtn.style.display = onCancel ? '' : 'none';
  const closeBtn = q('.sbs-pb-close');
  closeBtn.style.display = 'none';   // only once the job is over

  const t0 = performance.now();
  let closed = false;
  let tick = null;
  const h = {
    el,
    cancelled: false,
    /** @param {{headline?:string, detail?:string, frac?:number|null, elapsedMs?:number, etaMs?:number|null}} p */
    update(p = {}) {
      if (closed) return;
      if (p.headline !== undefined) q('.sbs-pb-headline').textContent = p.headline;
      if (p.detail !== undefined) q('.sbs-pb-detail').textContent = p.detail;
      if (p.frac !== undefined) {
        const bar = q('.sbs-pb-bar'), fill = q('.sbs-pb-fill');
        if (p.frac === null) { bar.classList.add('sbs-pb-bar--indeterminate'); fill.style.width = ''; }
        else { bar.classList.remove('sbs-pb-bar--indeterminate'); fill.style.width = `${Math.max(0, Math.min(100, p.frac * 100)).toFixed(1)}%`; }
      }
      if (p.elapsedMs !== undefined) q('.sbs-pb-elapsed').textContent = `⏱ ${fmtDuration(p.elapsedMs)}`;
      if (p.etaMs !== undefined) {
        const eta = q('.sbs-pb-eta');
        eta.textContent = p.etaMs === null ? 'estimating…' : (p.etaMs <= 0 ? 'almost done' : `≈ ${fmtDuration(p.etaMs)} left`);
      }
    },
    /** Job over. The banner turns green (or amber), keeps the summary, and dismisses itself. */
    finish(text, level = 'success', autoCloseMs = 10000) {
      if (closed) return;
      clearInterval(tick); tick = null;
      el.classList.remove('sbs-progress-banner--busy');
      el.classList.add(level === 'warn' ? 'sbs-progress-banner--warn' : 'sbs-progress-banner--done');
      q('.sbs-pb-headline').textContent = text || '';
      q('.sbs-pb-detail').textContent = '';
      q('.sbs-pb-eta').textContent = '';
      q('.sbs-pb-elapsed').textContent = `⏱ ${fmtDuration(performance.now() - t0)}`;
      q('.sbs-pb-fill').style.width = '100%';
      q('.sbs-pb-bar').classList.remove('sbs-pb-bar--indeterminate');
      cancelBtn.style.display = 'none';
      closeBtn.style.display = '';
      if (autoCloseMs > 0) setTimeout(() => h.close(), autoCloseMs);
    },
    /** Job died. Red, stays until dismissed. */
    fail(text) {
      if (closed) return;
      clearInterval(tick); tick = null;
      el.classList.remove('sbs-progress-banner--busy');
      el.classList.add('sbs-progress-banner--fail');
      q('.sbs-pb-headline').textContent = text || 'Failed';
      q('.sbs-pb-detail').textContent = '';
      q('.sbs-pb-eta').textContent = '';
      q('.sbs-pb-bar').classList.remove('sbs-pb-bar--indeterminate');
      cancelBtn.style.display = 'none';
      closeBtn.style.display = '';
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(tick); tick = null;
      el.classList.add('sbs-progress-banner--out');
      setTimeout(() => el.remove(), 220);
    },
  };
  cancelBtn.addEventListener('click', () => {
    if (h.cancelled) return;
    h.cancelled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Stopping…';
    try { onCancel?.(); } catch (err) { console.warn('[progress-banner] onCancel threw:', err); }
  });
  closeBtn.addEventListener('click', () => h.close());
  // The elapsed clock runs on its own so a stalled job still visibly ages.
  tick = setInterval(() => { if (!closed) q('.sbs-pb-elapsed').textContent = `⏱ ${fmtDuration(performance.now() - t0)}`; }, 1000);
  h.update({ frac: null, elapsedMs: 0, etaMs: null });
  _stackEl().appendChild(el);
  return h;
}
