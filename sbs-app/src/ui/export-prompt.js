/**
 * 🎬 Export prompt (V0.3.2.80) — the human-verification escape hatch for the
 * incremental render cache.
 *
 * The cache re-renders segments whose FINGERPRINT changed. But when an
 * upstream fix changes what earlier steps left behind in the live scene in
 * a way the fingerprint can't see, downstream segments are served stale —
 * and only a human watching the output can know. This prompt turns that
 * verification into a workflow: on Export, choose
 *
 *   • Render full project — the normal incremental export, OR
 *   • Re-render specific steps — type ranges + singles in any order
 *     ("0-10, 28-55, 205-208, 124, 89-102, 74"); each selected step also
 *     pulls in its n−1 and n+1 neighbours (a segment renders FROM the
 *     previous step's state, so seamless transitions need both sides),
 *     and the matching cached segments are FORCE-overwritten.
 *   • Optionally: "when finished, assemble the complete video" — the rest
 *     of the timeline comes from cache.
 *
 * DELIBERATELY NON-MODAL: a floating, draggable panel. The user must be
 * able to scrub the timeline, click steps and read step numbers WHILE
 * typing ranges — a modal would hide exactly the information the input
 * needs. "+ current" appends the active step's number.
 *
 * Step numbers = the timeline's visible numbering (groups count as ONE
 * step; selecting a group re-renders its whole segment).
 */

import { state }     from '../core/state.js';
import { setStatus } from './status.js';

/**
 * Parse "0-10, 28-55, C11, 124, C4" → sorted unique step numbers, clamped
 * to [1..max]. Ranges may be reversed (55-28 works). `C<n>` (V0.3.2.81,
 * case-insensitive) expands to every step of chapter n via the `chapters`
 * map (chapter number → its top-level step numbers); an unknown chapter is
 * reported as a bad token. Returns { base, withNeighbors, chaptersUsed,
 * error } — error is the first bad token, or null.
 */
export function parseStepRanges(text, max, chapters = null) {
  const base = new Set();
  const chaptersUsed = [];
  for (const raw of String(text || '').split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    const cm = /^[cC]\s*(\d+)$/.exec(tok);
    if (cm) {
      const num = parseInt(cm[1], 10);
      const stepNums = chapters?.get?.(num);
      if (!stepNums || !stepNums.length) return { base: [], withNeighbors: [], chaptersUsed: [], error: tok };
      for (const n of stepNums) if (n >= 1 && n <= max) base.add(n);
      chaptersUsed.push(num);
      continue;
    }
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(tok);
    if (!m) return { base: [], withNeighbors: [], chaptersUsed: [], error: tok };
    let a = parseInt(m[1], 10);
    let b = m[2] !== undefined ? parseInt(m[2], 10) : a;
    if (b < a) [a, b] = [b, a];
    a = Math.max(1, Math.min(a, max));
    b = Math.max(1, Math.min(b, max));
    for (let n = a; n <= b; n++) base.add(n);
  }
  const withNeighbors = new Set(base);
  for (const n of base) {                       // n−1 / n+1: transitions render from both sides
    if (n > 1)   withNeighbors.add(n - 1);
    if (n < max) withNeighbors.add(n + 1);
  }
  const sort = (s) => [...s].sort((x, y) => x - y);
  return { base: sort(base), withNeighbors: sort(withNeighbors), chaptersUsed, error: null };
}

/**
 * Chapter number (1-based, chapters-array order — same numbering the TOC
 * and chapterNumber headers use) → that chapter's top-level step numbers.
 */
function _chapterStepMap() {
  const chapters = state.get('chapters') || [];
  const numOfChapter = new Map(chapters.map((c, i) => [c.id, i + 1]));
  const map = new Map();
  let n = 0;
  for (const s of (state.get('steps') || [])) {
    if (s.isBaseStep || s.hidden) continue;
    if (!s.groupId) n++; else continue;          // groups count as one; sub-steps ride with the head
    const cnum = numOfChapter.get(s.chapterId);
    if (!cnum) continue;
    if (!map.has(cnum)) map.set(cnum, []);
    map.get(cnum).push(n);
  }
  return map;
}

/** Count of top-level (non-group-member) visible steps — the timeline numbering. */
function _topLevelCount() {
  return (state.get('steps') || []).filter(s => !s.isBaseStep && !s.hidden && !s.groupId).length;
}

/** The active step's timeline number (group members resolve to their head's number). */
function _activeTopLevelNumber() {
  const all = (state.get('steps') || []).filter(s => !s.isBaseStep && !s.hidden);
  const activeId = state.get('activeStepId');
  let n = 0, hit = null;
  for (const s of all) {
    if (!s.groupId) n++;
    if (s.id === activeId) { hit = n; break; }
  }
  return hit;
}

/**
 * Show the prompt. Resolves with:
 *   { mode:'full' }
 *   { mode:'selection', base, withNeighbors, thenFull }
 *   null (cancelled)
 */
export function openExportPrompt() {
  return new Promise((resolve) => {
    document.getElementById('sbs-export-prompt')?.remove();   // never two at once

    const max = _topLevelCount();
    const el = document.createElement('div');
    el.id = 'sbs-export-prompt';
    el.style.cssText = [
      'position:fixed', 'top:120px', 'right:40px', 'z-index:9500',
      'width:390px', 'background:var(--panel, #0f172a)', 'color:var(--text, #e2e8f0)',
      'border:1px solid var(--line, #334155)', 'border-radius:10px',
      'box-shadow:0 12px 40px rgba(0,0,0,0.55)', 'font-size:13px',
    ].join(';');
    el.innerHTML = `
      <div id="xp-drag" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line,#334155);cursor:move;user-select:none;">
        <span style="font-weight:600;">🎬 Export video</span>
        <span class="small muted" style="flex:1;">${max} steps</span>
        <button class="btn icon" id="xp-close" style="width:24px;height:24px;padding:0;">✕</button>
      </div>
      <div style="padding:12px;">
        <button class="btn" id="xp-full" style="width:100%;font-weight:600;color:#22d3ee;">▶ Render full project (incremental)</button>

        <div class="small muted" style="margin:12px 0 6px;">— or re-render specific steps (overwrites their cache; C4 = all of chapter 4) —</div>
        <div style="display:flex;gap:6px;">
          <input id="xp-ranges" type="text" placeholder="e.g. 0-10, C11, 124, 89-102, 74"
                 style="flex:1;font-family:Consolas,monospace;font-size:12px;padding:6px 8px;background:rgba(255,255,255,0.05);color:inherit;border:1px solid var(--line,#334155);border-radius:6px;" />
          <button class="btn" id="xp-add-cur" title="Append the active step's number">+ current</button>
        </div>
        <div class="small" id="xp-preview" style="margin-top:6px;min-height:16px;color:#94a3b8;line-height:1.4;"></div>
        <label style="display:flex;align-items:center;gap:6px;margin-top:8px;">
          <input type="checkbox" id="xp-then-full" checked />
          <span>When finished, assemble the complete video (rest from cache)</span>
        </label>
        <button class="btn" id="xp-selection" style="width:100%;margin-top:8px;" disabled>🎯 Re-render selection</button>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding-top:10px;border-top:1px solid var(--line,#334155);">
          <button class="btn" id="xp-purge" title="Delete cached segments no longer matching any current step (accumulated stale generations)">🧹 Purge stale cache</button>
          <span class="small muted">panel is movable — timeline stays clickable</span>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    // ── dragging ──
    const drag = el.querySelector('#xp-drag');
    let dOff = null;
    drag.addEventListener('pointerdown', (e) => {
      if (e.target.id === 'xp-close') return;
      dOff = { x: e.clientX - el.offsetLeft, y: e.clientY - el.offsetTop };
      drag.setPointerCapture(e.pointerId);
    });
    drag.addEventListener('pointermove', (e) => {
      if (!dOff) return;
      el.style.left = Math.max(0, e.clientX - dOff.x) + 'px';
      el.style.top  = Math.max(0, e.clientY - dOff.y) + 'px';
      el.style.right = 'auto';
    });
    drag.addEventListener('pointerup', () => { dOff = null; });

    // ── parsing preview ──
    const input    = el.querySelector('#xp-ranges');
    const preview  = el.querySelector('#xp-preview');
    const btnSel   = el.querySelector('#xp-selection');
    const chapters = _chapterStepMap();
    let parsed = { base: [], withNeighbors: [], chaptersUsed: [], error: null };
    const refresh = () => {
      parsed = parseStepRanges(input.value, max, chapters);
      if (parsed.error) {
        preview.textContent = /^[cC]/.test(parsed.error)
          ? `"${parsed.error}" — no such chapter (project has ${chapters.size}).`
          : `Can't read "${parsed.error}" — numbers, ranges, or C<chapter>, comma-separated.`;
        preview.style.color = '#f87171';
        btnSel.disabled = true;
      } else if (!parsed.base.length) {
        preview.textContent = '';
        btnSel.disabled = true;
      } else {
        const extra = parsed.withNeighbors.length - parsed.base.length;
        const chap  = parsed.chaptersUsed.length
          ? ` (incl. chapter${parsed.chaptersUsed.length > 1 ? 's' : ''} ${parsed.chaptersUsed.join(', ')})`
          : '';
        preview.textContent = `${parsed.base.length} step(s)${chap} + ${extra} neighbour(s) (n−1/n+1) = ${parsed.withNeighbors.length} to re-render.`;
        preview.style.color = '#94a3b8';
        btnSel.disabled = false;
      }
    };
    // 💾 V0.3.2.81 — the ranges text is PROJECT data: prefill from the file,
    // persist as you type (debounced). The export section round-trips
    // wholesale through save/load, so the field rides along with defaults-
    // safe behaviour on older files.
    input.value = String((state.get('export') || {}).rerenderRanges || '');
    let _saveT = null;
    input.addEventListener('input', () => {
      refresh();
      clearTimeout(_saveT);
      _saveT = setTimeout(() => {
        state.setState({ export: { ...(state.get('export') || {}), rerenderRanges: input.value } });
        state.markDirty();
      }, 400);
    });
    refresh();
    el.querySelector('#xp-add-cur').addEventListener('click', () => {
      const n = _activeTopLevelNumber();
      if (n == null) { setStatus('No active step.', 'warn', 2500); return; }
      input.value = input.value.trim() ? input.value.replace(/,\s*$/, '') + ', ' + n : String(n);
      refresh();
    });

    const done = (result) => { el.remove(); resolve(result); };
    el.querySelector('#xp-close').addEventListener('click', () => done(null));
    el.querySelector('#xp-full').addEventListener('click', () => done({ mode: 'full' }));
    el.querySelector('#xp-selection').addEventListener('click', () => {
      if (parsed.error || !parsed.base.length) return;
      done({
        mode: 'selection',
        base: parsed.base,
        withNeighbors: parsed.withNeighbors,
        thenFull: el.querySelector('#xp-then-full').checked,
      });
    });
    el.querySelector('#xp-purge').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true; b.textContent = '🧹 Purging…';
      try {
        const r = await window.sbsCachePurge?.({ force: true });
        b.textContent = '🧹 Purge stale cache';
        setStatus(`Cache purge: removed ${r?.deleted ?? '?'} stale segment file(s)${r?.mb ? ` (~${r.mb} MB)` : ''}, kept ${r?.kept ?? '?'} live. Hidden steps re-render when next needed.`, 'success', 9000);
      } catch (err) {
        b.textContent = '🧹 Purge stale cache';
        setStatus('Purge failed: ' + (err?.message || err), 'danger', 6000);
      }
      b.disabled = false;
    });
  });
}
