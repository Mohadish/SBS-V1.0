/**
 * 🎬 Video trim / audio dialog (V0.3.2.75)
 *
 * "Play this clip from this second to that second, and decide whether its
 * audio plays or my voice-over does."
 *
 * A live <video> preview with a scrubber and two draggable handles for the
 * IN and OUT points, numeric fields for exact values, and a mute toggle.
 * Changes are applied to the Konva node on OK (one undo entry from the
 * caller); Cancel restores the values the dialog opened with.
 *
 * The dialog owns its own <video> element so scrubbing never disturbs the
 * clip playing on the canvas.
 */

import * as videoOverlay from '../systems/video-overlay.js';

const _fmt = (ms) => {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

/**
 * @param {Konva.Image} node a video node
 * @returns {Promise<null|{trimInMs:number,trimOutMs:number,muted:boolean,volume:number}>}
 *          the chosen settings, or null if cancelled
 */
export function openVideoTrimDialog(node) {
  return new Promise((resolve) => {
    const path   = videoOverlay.resolveVideoPath(node);
    const durMs0 = Number(node.getAttr('videoDurationMs') ?? 0);
    let inMs     = Math.max(0, Number(node.getAttr('trimInMs') ?? 0));
    let outMs    = Number(node.getAttr('trimOutMs') ?? 0) || durMs0;
    let muted    = node.getAttr('muted') !== false;
    let volume   = Number(node.getAttr('volume') ?? 1);
    let durMs    = durMs0;

    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="max-width:min(720px,92vw);">
        <div class="sbs-dialog__title">🎬 Video — trim &amp; audio</div>
        <div class="small muted" style="margin-top:4px;word-break:break-all;">${_esc(path.split(/[\\/]/).pop() || '')}</div>

        <video id="vt-preview" style="width:100%;max-height:44vh;margin-top:10px;background:#000;border-radius:6px;" playsinline></video>

        <div id="vt-track" style="position:relative;height:34px;margin-top:10px;border-radius:6px;background:rgba(255,255,255,0.08);cursor:pointer;user-select:none;">
          <div id="vt-window" style="position:absolute;top:0;bottom:0;background:rgba(34,211,238,0.25);border-left:2px solid #22d3ee;border-right:2px solid #22d3ee;"></div>
          <div id="vt-play"   style="position:absolute;top:0;bottom:0;width:2px;background:#f59e0b;"></div>
          <div id="vt-h-in"   title="Drag: start point" style="position:absolute;top:0;bottom:0;width:10px;margin-left:-5px;cursor:ew-resize;background:#22d3ee;border-radius:3px;opacity:0.9;"></div>
          <div id="vt-h-out"  title="Drag: end point"   style="position:absolute;top:0;bottom:0;width:10px;margin-left:-5px;cursor:ew-resize;background:#22d3ee;border-radius:3px;opacity:0.9;"></div>
        </div>

        <div class="grid2" style="margin-top:10px;">
          <label class="colorlab">Start (seconds)
            <input type="number" id="vt-in" step="0.05" min="0" />
          </label>
          <label class="colorlab">End (seconds)
            <input type="number" id="vt-out" step="0.05" min="0" />
          </label>
        </div>

        <div style="display:flex;align-items:center;gap:14px;margin-top:10px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;">
            <input type="checkbox" id="vt-muted" />
            <span>Mute this clip (use the step's voice-over)</span>
          </label>
          <label style="display:flex;align-items:center;gap:6px;flex:1;min-width:180px;">
            <span class="small muted">Volume</span>
            <input type="range" id="vt-vol" min="0" max="1" step="0.05" style="flex:1;" />
          </label>
        </div>

        <div class="small muted" id="vt-info" style="margin-top:8px;line-height:1.5;"></div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;">
          <button class="btn" id="vt-preview-btn">▶ Preview window</button>
          <button class="btn" id="vt-cancel">Cancel</button>
          <button class="btn" id="vt-ok" style="color:#22d3ee;font-weight:600;">Apply</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);

    const $ = (id) => dlg.querySelector(id);
    const video  = $('#vt-preview');
    const track  = $('#vt-track');
    const winEl  = $('#vt-window');
    const playEl = $('#vt-play');
    const hIn    = $('#vt-h-in');
    const hOut   = $('#vt-h-out');
    const inNum  = $('#vt-in');
    const outNum = $('#vt-out');
    const mutedCb= $('#vt-muted');
    const volRng = $('#vt-vol');
    const info   = $('#vt-info');

    video.src    = videoOverlay.fileUrlFor(path);
    video.muted  = true;           // the dialog preview is always silent-safe
    video.volume = 0;

    const pct = (ms) => (durMs > 0 ? Math.max(0, Math.min(1, ms / durMs)) : 0);

    const paint = () => {
      const a = pct(inMs), b = pct(outMs);
      winEl.style.left  = (a * 100) + '%';
      winEl.style.width = Math.max(0, (b - a) * 100) + '%';
      hIn.style.left    = (a * 100) + '%';
      hOut.style.left   = (b * 100) + '%';
      playEl.style.left = (pct(video.currentTime * 1000) * 100) + '%';
      inNum.value  = (inMs  / 1000).toFixed(2);
      outNum.value = (outMs / 1000).toFixed(2);
      mutedCb.checked = muted;
      volRng.value = volume;
      volRng.disabled = muted;
      const win = Math.max(0, outMs - inMs);
      info.textContent =
        `Clip ${_fmt(durMs)} · using ${_fmt(win)} (${_fmt(inMs)} → ${_fmt(outMs)}).` +
        (muted ? ' Audio muted — the step\'s voice-over plays.' : ' This clip\'s own audio will play.');
    };

    const clampOrder = () => {
      if (durMs > 0) { inMs = Math.min(inMs, Math.max(0, durMs - 40)); outMs = Math.min(outMs, durMs); }
      inMs = Math.max(0, inMs);
      if (outMs - inMs < 40) outMs = Math.min(durMs || inMs + 40, inMs + 40);
    };

    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) durMs = Math.round(video.duration * 1000);
      if (!outMs || outMs > durMs) outMs = durMs;
      clampOrder();
      try { video.currentTime = inMs / 1000; } catch { /* ignore */ }
      paint();
    }, { once: true });
    video.addEventListener('error', () => {
      info.textContent = 'This video could not be opened. Chromium plays H.264 / VP9 / AV1 — ProRes and HEVC need converting first.';
    }, { once: true });
    video.addEventListener('timeupdate', () => {
      // Stop the preview at the OUT point so the window is what you hear/see.
      if (outMs > 0 && video.currentTime * 1000 >= outMs) { video.pause(); }
      paint();
    });

    // ── Scrubbing + handle drags ────────────────────────────────────────────
    const msAtClientX = (clientX) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      return Math.round(f * durMs);
    };
    let dragging = null;   // 'in' | 'out' | 'seek'
    const onDown = (which) => (e) => { dragging = which; e.preventDefault(); e.stopPropagation(); onMove(e); };
    const onMove = (e) => {
      if (!dragging || !durMs) return;
      const ms = msAtClientX(e.clientX);
      if (dragging === 'in')  { inMs  = Math.min(ms, outMs - 40); }
      else if (dragging === 'out') { outMs = Math.max(ms, inMs + 40); }
      else { try { video.currentTime = ms / 1000; } catch { /* ignore */ } }
      clampOrder();
      if (dragging !== 'seek') { try { video.currentTime = (dragging === 'in' ? inMs : outMs) / 1000; } catch { /* ignore */ } }
      paint();
    };
    const onUp = () => { dragging = null; };
    hIn.addEventListener('pointerdown', onDown('in'));
    hOut.addEventListener('pointerdown', onDown('out'));
    track.addEventListener('pointerdown', (e) => { if (e.target === track || e.target === winEl) onDown('seek')(e); });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    inNum.addEventListener('change',  () => { inMs  = Math.round((Number(inNum.value)  || 0) * 1000); clampOrder(); try { video.currentTime = inMs / 1000; } catch {} paint(); });
    outNum.addEventListener('change', () => { outMs = Math.round((Number(outNum.value) || 0) * 1000); clampOrder(); try { video.currentTime = outMs / 1000; } catch {} paint(); });
    mutedCb.addEventListener('change', () => { muted = mutedCb.checked; paint(); });
    volRng.addEventListener('input',   () => { volume = Number(volRng.value); paint(); });

    $('#vt-preview-btn').addEventListener('click', () => {
      try { video.currentTime = inMs / 1000; video.play().catch(() => {}); } catch { /* ignore */ }
    });

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { video.pause(); } catch { /* ignore */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
      dlg.close(); dlg.remove();
    };
    $('#vt-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
    $('#vt-ok').addEventListener('click', () => {
      clampOrder();
      cleanup();
      resolve({ trimInMs: inMs, trimOutMs: outMs, muted, volume });
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); cleanup(); resolve(null); });

    paint();
    dlg.showModal();
  });
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
