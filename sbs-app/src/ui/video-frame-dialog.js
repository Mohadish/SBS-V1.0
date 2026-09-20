/**
 * 🎞 Pick the frame (V0.3.4.30)
 *
 * A step that holds a video clip is pictured in the document at ONE frame of
 * that clip. Until now that was always the clip's first frame; this dialog
 * scrubs the clip's own window and hands back a time, which the picture stores.
 * Two pictures on one page can hold two different frames of the same clip —
 * the time is part of the picture's identity, so they are two pictures, not one.
 *
 * It owns its own <video>, exactly like the trim dialog, so scrubbing here can
 * never disturb the clip on the canvas. It takes clip DATA, not a Konva node:
 * the step being pictured is usually not the step on screen.
 */

import * as videoOverlay from '../systems/video-overlay.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const _fmt = (ms) => {
  const t = Math.max(0, Number(ms) || 0) / 1000;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};

/**
 * @param {{abs:string, inMs:number, outMs:number, durMs:number}} clip
 * @param {number|null} atMs  the frame the picture shows now (null = the clip's first frame)
 * @returns {Promise<null|number>} the chosen time in ms, null if cancelled
 */
export function openVideoFrameDialog(clip, atMs = null) {
  return new Promise((resolve) => {
    const path  = String(clip?.abs || '');
    let durMs   = Math.max(0, Number(clip?.durMs) || 0);
    const inMs  = Math.max(0, Number(clip?.inMs) || 0);
    let outMs   = Number(clip?.outMs) || durMs;
    let at      = Number.isFinite(Number(atMs)) ? Math.max(inMs, Number(atMs)) : inMs;

    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="max-width:min(760px,94vw);">
        <div class="sbs-dialog__title">🎞 Which frame?</div>
        <div class="small muted" style="margin-top:4px;word-break:break-all;">${_esc(path.split(/[\\/]/).pop() || '')}</div>

        <video id="vf-preview" style="width:100%;max-height:46vh;margin-top:10px;background:#000;border-radius:6px;" playsinline muted></video>

        <div id="vf-track" style="position:relative;height:34px;margin-top:10px;border-radius:6px;background:rgba(255,255,255,0.08);cursor:pointer;user-select:none;">
          <div id="vf-window" style="position:absolute;top:0;bottom:0;background:rgba(34,211,238,0.18);border-left:2px solid #22d3ee;border-right:2px solid #22d3ee;"></div>
          <div id="vf-play"   style="position:absolute;top:0;bottom:0;width:3px;margin-left:-1px;background:#f59e0b;box-shadow:0 0 0 1px rgba(0,0,0,.6);"></div>
        </div>

        <div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;">
          <button class="btn" id="vf-back" title="One frame back">◀</button>
          <button class="btn" id="vf-fwd"  title="One frame on">▶</button>
          <label class="colorlab" style="margin:0;">At (seconds)
            <input type="number" id="vf-at" step="0.04" min="0" style="width:110px;" />
          </label>
          <button class="btn" id="vf-start" title="The first frame of the clip's window">⏮ First</button>
          <span class="small muted" id="vf-info" style="flex:1;min-width:160px;"></span>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;">
          <button class="btn" id="vf-cancel">Cancel</button>
          <button class="btn" id="vf-ok" style="color:#22d3ee;font-weight:600;">Use this frame</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);

    const $ = (id) => dlg.querySelector(id);
    const video = $('#vf-preview'), track = $('#vf-track'), winEl = $('#vf-window'), playEl = $('#vf-play');
    const atNum = $('#vf-at'), info = $('#vf-info');
    const STEP_MS = 40;                                   // ~one frame at 25 fps — fine enough to land on a beat

    video.src = videoOverlay.fileUrlFor(path);
    video.muted = true; video.volume = 0;

    const pct = (ms) => (durMs > 0 ? Math.max(0, Math.min(1, ms / durMs)) : 0);
    const paint = () => {
      const a = pct(inMs), b = pct(outMs);
      winEl.style.left = `${a * 100}%`;
      winEl.style.width = `${Math.max(0, b - a) * 100}%`;
      playEl.style.left = `${pct(at) * 100}%`;
      if (document.activeElement !== atNum) atNum.value = (at / 1000).toFixed(2);
      info.textContent = `Clip ${_fmt(durMs)} · the step shows ${_fmt(inMs)} → ${_fmt(outMs)} · this picture: ${_fmt(at)}`;
    };
    const seek = (ms) => {
      at = Math.min(Math.max(Math.round(ms), inMs), Math.max(outMs, inMs));
      try { video.currentTime = at / 1000; } catch { /* the decoder will catch up */ }
      paint();
    };

    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) durMs = Math.round(video.duration * 1000);
      if (!outMs || outMs > durMs) outMs = durMs;
      seek(at);
    }, { once: true });
    video.addEventListener('error', () => {
      info.textContent = 'This video could not be opened — it may have been moved, or it needs converting (Chromium plays H.264 / VP9 / AV1).';
    }, { once: true });
    video.addEventListener('seeked', paint);

    // scrub
    let dragging = false;
    const msAtX = (clientX) => {
      const r = track.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * durMs);
    };
    track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture?.(e.pointerId); seek(msAtX(e.clientX)); });
    track.addEventListener('pointermove', (e) => { if (dragging) seek(msAtX(e.clientX)); });
    const endDrag = () => { dragging = false; };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);

    $('#vf-back').addEventListener('click', () => seek(at - STEP_MS));
    $('#vf-fwd').addEventListener('click', () => seek(at + STEP_MS));
    $('#vf-start').addEventListener('click', () => seek(inMs));
    atNum.addEventListener('change', () => seek((Number(atNum.value) || 0) * 1000));
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); seek(at - (e.shiftKey ? STEP_MS * 10 : STEP_MS)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); seek(at + (e.shiftKey ? STEP_MS * 10 : STEP_MS)); }
    });

    const close = (value) => {
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* already gone */ }
      try { dlg.close(); } catch { /* not open */ }
      dlg.remove();
      resolve(value);
    };
    $('#vf-cancel').addEventListener('click', () => close(null));
    $('#vf-ok').addEventListener('click', () => close(at));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });

    paint();
    dlg.showModal();
  });
}
