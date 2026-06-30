/**
 * SBS — Image Sequence editor (S1).
 *
 * Authors a "flipbook" on an overlay image: a list of FRAMES (same position/size,
 * swapped in place during the step) where each frame has a transition-in % of the
 * step's window. Frame 0 is the base image (shows from the start, fixed at 0%).
 *
 * For each transition it shows the ESTIMATED narration words leading up to that
 * point, so the user can line a swap up with the voice-over. The estimate maps
 * the % to a position in the narration text, weighted by word length + punctuation
 * pauses (speech ≈ proportional). It's a "vicinity" estimate, not exact timing.
 *
 * S1 is data + editing only — NO playback (that's S2). The model is stored on the
 * node as the `sequence` attr and round-trips through the overlay JSON:
 *   node.sequence = { frames: [{ src, pct }, ...], overrideMs: null|number }
 *   - frames[0] = base image, pct fixed 0
 *   - overrideMs = null → window is the narration duration; number → fixed window
 */
import { state } from '../core/state.js';

/** ~`count` narration words leading up to `fraction` (0..1) of the clip. Estimate
 *  weighted by word length + a punctuation-pause bump. */
export function wordsLeadingUpTo(text, fraction, count = 3) {
  const t = String(text || '').trim();
  if (!t) return '';
  const words = t.split(/\s+/);
  const weights = words.map(w => w.length + 1 + (/[.,;:!?]$/.test(w) ? 3 : 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const target = Math.max(0, Math.min(1, fraction)) * total;
  let cum = 0, idx = 0;
  for (let i = 0; i < words.length; i++) { cum += weights[i]; idx = i; if (cum >= target) break; }
  const start = Math.max(0, idx - count + 1);
  return (start > 0 ? '…' : '') + words.slice(start, idx + 1).join(' ');
}

function _readFileAsDataURL() {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload  = () => resolve(String(r.result || ''));
      r.onerror = () => resolve(null);
      r.readAsDataURL(f);
    };
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}

function _activeStepNarration() {
  try {
    const id = state.get('activeStepId');
    const step = (state.get('steps') || []).find(s => s.id === id);
    return { text: step?.narration?.text || '', durationMs: step?.narration?.durationMs || 0 };
  } catch { return { text: '', durationMs: 0 }; }
}

function _esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Open the sequence editor for an overlay image node.
 * @param {Konva.Image} node
 * @param {() => void} onChange  called after every edit (persist the overlay)
 */
export function openSequenceEditor(node, onChange = () => {}) {
  if (!node) return;
  let seq = node.getAttr('sequence');
  if (!seq || !Array.isArray(seq.frames) || seq.frames.length === 0) {
    seq = { frames: [{ src: node.getAttr('src') || null, pct: 0 }], overrideMs: null };
  } else {
    // keep frame 0 in sync with the node's current base image + pinned at 0
    seq.frames[0] = { src: node.getAttr('src') || seq.frames[0].src || null, pct: 0 };
  }
  const commit = () => { node.setAttr('sequence', seq); onChange(); };

  const narr = _activeStepNarration();
  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.style.cssText = 'min-width:540px;max-width:700px;color:var(--text);';
  document.body.appendChild(dlg);

  const render = () => {
    const windowMs = (seq.overrideMs != null ? seq.overrideMs : narr.durationMs) || 0;
    const fmtTime  = (pct) => windowMs ? `${(windowMs * pct / 100 / 1000).toFixed(2)}s` : '—';
    const rows = seq.frames.map((f, i) => {
      const isBase = i === 0;
      const pct    = isBase ? 0 : (Number(f.pct) || 0);
      const words  = isBase
        ? '<i style="opacity:0.6;">start</i>'
        : (narr.text ? _esc(wordsLeadingUpTo(narr.text, pct / 100)) : '<i style="opacity:0.6;">(no narration)</i>');
      return `
        <div class="seq-row" data-i="${i}" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid rgba(255,255,255,0.08);">
          <img src="${_esc(f.src || '')}" alt="" style="width:56px;height:40px;object-fit:contain;background:rgba(0,0,0,0.25);border-radius:4px;flex:0 0 auto;" />
          <div style="flex:0 0 28px;font-size:12px;opacity:0.6;">#${i + 1}</div>
          <label style="display:flex;align-items:center;gap:3px;font-size:12px;flex:0 0 auto;">@<input type="number" class="seq-pct" min="0" max="100" step="1" value="${pct}" ${isBase ? 'disabled' : ''} style="width:54px;height:24px;" />%</label>
          <div style="flex:0 0 48px;font-size:12px;opacity:0.7;">${fmtTime(pct)}</div>
          <div title="${typeof words === 'string' ? _esc(words.replace(/<[^>]+>/g, '')) : ''}" style="flex:1 1 auto;font-size:12px;opacity:0.9;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${words}</div>
          ${isBase ? '<div style="flex:0 0 26px;"></div>' : `<button class="btn seq-del" title="Remove frame" style="flex:0 0 auto;height:24px;">🗑</button>`}
        </div>`;
    }).join('');
    const winLabel = seq.overrideMs != null
      ? `Window: <b>${(seq.overrideMs / 1000).toFixed(2)}s</b> (fixed)`
      : (narr.durationMs ? `Window: <b>${(narr.durationMs / 1000).toFixed(2)}s</b> (narration)` : 'No narration on this step yet — turn on a fixed window to see times.');
    dlg.innerHTML = `
      <div class="sbs-dialog__body" style="display:flex;flex-direction:column;gap:10px;">
        <div class="sbs-dialog__title">Image Sequence — ${seq.frames.length} frame${seq.frames.length === 1 ? '' : 's'}</div>
        <div style="font-size:12px;opacity:0.75;line-height:1.4;">Each frame swaps in at its <b>%</b> of the step window (after the overlay loads). The words are an <i>estimate</i> of what's voiced leading up to each swap.</div>
        <div class="seq-rows">${rows || ''}</div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:2px;">
          <button class="btn seq-add">+ Add frame…</button>
          <span style="flex:1 1 auto;"></span>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;"><input type="checkbox" class="seq-override" ${seq.overrideMs != null ? 'checked' : ''} /> Fixed window</label>
          <input type="number" class="seq-override-s" min="0.1" step="0.1" value="${seq.overrideMs != null ? (seq.overrideMs / 1000) : ''}" placeholder="sec" ${seq.overrideMs != null ? '' : 'disabled'} style="width:62px;height:24px;" />
        </div>
        <div style="font-size:12px;opacity:0.85;">${winLabel}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
          <button class="btn seq-clear" title="Remove the whole sequence (keeps the base image)">Clear sequence</button>
          <button class="btn seq-close">Done</button>
        </div>
      </div>`;
    _wire();
  };

  const _wire = () => {
    dlg.querySelectorAll('.seq-pct').forEach(inp => inp.addEventListener('change', () => {
      const i = +inp.closest('.seq-row').dataset.i;
      seq.frames[i].pct = Math.max(0, Math.min(100, Number(inp.value) || 0));
      commit(); render();
    }));
    dlg.querySelectorAll('.seq-del').forEach(btn => btn.addEventListener('click', () => {
      const i = +btn.closest('.seq-row').dataset.i;
      seq.frames.splice(i, 1);
      commit(); render();
    }));
    dlg.querySelector('.seq-add')?.addEventListener('click', async () => {
      const src = await _readFileAsDataURL();
      if (!src) return;
      const last = Number(seq.frames[seq.frames.length - 1]?.pct) || 0;
      const pct  = Math.round(Math.min(100, last + (100 - last) / 2));   // midpoint last→end
      seq.frames.push({ src, pct });
      commit(); render();
    });
    dlg.querySelector('.seq-override')?.addEventListener('change', (e) => {
      seq.overrideMs = e.target.checked ? (narr.durationMs || 3000) : null;
      commit(); render();
    });
    dlg.querySelector('.seq-override-s')?.addEventListener('change', (e) => {
      const s = Number(e.target.value);
      if (s > 0) { seq.overrideMs = Math.round(s * 1000); commit(); render(); }
    });
    dlg.querySelector('.seq-clear')?.addEventListener('click', () => {
      node.setAttr('sequence', null); onChange();
      dlg.close(); dlg.remove();
    });
    dlg.querySelector('.seq-close')?.addEventListener('click', () => { dlg.close(); dlg.remove(); });
  };

  render();
  dlg.showModal();
}
