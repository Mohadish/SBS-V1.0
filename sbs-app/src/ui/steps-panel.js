/**
 * SBS Step Browser — Steps Panel (right sidebar)
 * =================================================
 * Renders the step timeline into #steps-panel.
 * Uses POC v0.266 class names: stepsHeader, stepsList, stepItem, stepTop,
 * stepTopSpacer, stepName, stepMeta, ghostDrop, miniToggle.
 */

import { state }    from '../core/state.js';
import { steps }    from '../systems/steps.js';
import * as actions from '../systems/actions.js';
import { createChapter, generateId } from '../core/schema.js';
import { cloneShareStrings } from '../core/clone.js';   // copy/paste steps without duplicating base64
import { setStatus } from './status.js';
import { showContextMenu } from './context-menu.js';
import { exportTimelineVideo, exportTimelineSbsProc, downloadBlob } from '../systems/video-export.js';
import { listVoices as ttsListVoices, synthesize as ttsSynthesize } from '../systems/tts.js';
import * as userSettings    from '../core/user-settings.js';
import * as narrationCache  from '../systems/narration-cache.js';
import { parseAnimation, resolveAnimationString } from '../systems/animation.js';
import { openPrivateAnimationEditor } from './animation-tab.js';
import { getPlugActionStepIds, getStepCableActions } from '../systems/cables.js';   // V0.3.0.152/153 🔌 step marker + manager

let _container    = null;
let _plugActionStepIds = new Set();   // V0.3.0.152 — steps holding a cable plug/unplug action
let _dragId       = null;          // id of step being dragged (single-drag fallback)
let _dragIds      = [];            // ids of all steps being dragged (set when multi-drag)
let _dragChapterId = null;         // id of chapter being dragged (header drag)
let _dragExpandId = null;          // single chapter currently force-expanded during a drag (hover override)
let _dragGroupExpandId   = null;   // single step-group head currently force-expanded during a drag
let _groupExpandTimer    = null;   // setTimeout id for hover-to-expand (groups)
let _groupExpandTargetId = null;   // group-head id the group timer is counting down for

// Multi-step selection lives in global state (state.selectedStepIds) so
// that actions in src/systems/actions.js can read it and route bulk
// step-snapshot mutations across N steps in one shot. The helpers below
// keep the panel's read/write call sites compact and ensure every
// mutation fires `change:selectedStepIds` for any other UI that listens
// (HUD banner, color buttons, etc.).
function _getSel() {
  const s = state.get('selectedStepIds');
  return s instanceof Set ? s : new Set();
}
function _setSel(next) {
  // Routed through actions.setSelectedSteps so every change pushes a
  // (coalesced) undo entry. Ctrl-click bursts collapse into one entry
  // within an 800 ms window — see undo.js push() coalesceKey logic.
  actions.setSelectedSteps([...next]);
}
function _selHas(id)  { return _getSel().has(id); }
function _selSize()   { return _getSel().size; }
function _selClear()  { if (_selSize()) _setSel(new Set()); }
let _expandTimer  = null;          // setTimeout id for hover-to-expand
let _expandTargetId = null;        // chapter id the timer is counting down for (to debounce hover transitions)
let _expandAnchorTop = 0;          // viewport Y of the hovered chapter header at timer start (for scroll anchor)
let _expandedId   = null;          // id of step currently shown in expanded layout (null = all collapsed)
let _clipboard    = null;          // { kind: 'steps'|'chapter', data: ... } — survives renders, cleared on new copy
let _dropSlot     = null;          // DOM node for the dashed insertion slot (step drag only)
const HOVER_EXPAND_MS       = 500;
const HOVER_GROUP_EXPAND_MS = 300;  // step-groups expand faster than chapters
const DROP_COLOR        = '#3b82f6'; // blue insertion line (top-level drop)
const DROP_COLOR_GROUP  = '#eab308'; // amber insertion line (drop INTO a group)

// ── Init ────────────────────────────────────────────────────────────────────

export function initStepsPanel() {
  _container = document.getElementById('steps-panel');
  if (!_container) return;

  _container.innerHTML = `
    <div class="stepsHeader">
      <div class="row">
        <div>
          <div class="title">Steps</div>
          <div class="filename" style="font-size:16px;">Timeline</div>
        </div>
      </div>
      <div class="grid2" style="margin-top:8px;">
        <button class="btn" id="btn-add-step">+ Step</button>
        <button class="btn" id="btn-add-chapter">+ Chapter</button>
      </div>
      <button class="btn" id="btn-export-video" style="margin-top:6px;width:100%;">🎬 Export video</button>
      <button class="btn" id="btn-export-sbsproc" style="margin-top:6px;width:100%;" title="Export a single self-contained .sbsproc file (MP4 + step manifest) for the SBS viewer.">📦 Export .sbsproc</button>
      <div class="card" style="margin-top:8px;">
        <div class="grid2">
          <label class="colorlab" title="Animation-length variable 1 (ms). Animation presets that reference AL1 resolve to this value at transition time. Default home for the camera channel.">AL1 (ms)
            <input type="number" id="global-cam-dur" min="0" max="30000" step="100" value="1500" style="margin-top:6px;" />
          </label>
          <label class="colorlab" title="Animation-length variable 2 (ms). Presets that reference AL2 resolve to this value at transition time. Default home for the object/visibility/color channels.">AL2 (ms)
            <input type="number" id="global-obj-dur" min="0" max="30000" step="100" value="1500" style="margin-top:6px;" />
          </label>
        </div>
      </div>
    </div>
    <div class="stepsList" id="steps-list"></div>
  `;

  _container.querySelector('#btn-add-step')
    .addEventListener('click', _onAddStep);
  _container.querySelector('#btn-add-chapter')
    .addEventListener('click', _onAddChapter);
  _container.querySelector('#btn-export-video')
    .addEventListener('click', _onExportVideo);
  _container.querySelector('#btn-export-sbsproc')
    ?.addEventListener('click', _onExportSbsProc);

  _container.querySelector('#global-cam-dur').addEventListener('change', e => {
    _setGlobalDuration('cameraAnimDurationMs', Number(e.target.value));
  });
  _container.querySelector('#global-obj-dur').addEventListener('change', e => {
    _setGlobalDuration('objectAnimDurationMs', Number(e.target.value));
  });

  state.on('change:steps',                _syncAndRender);
  // Camera template list affects the per-step camera dropdown built in
  // _buildTransitionRow — re-render so add/rename/delete propagates.
  state.on('change:cameraViews',          _syncAndRender);
  state.on('change:chapters',             _syncAndRender);
  state.on('change:activeStepId',         _onActiveStepChanged);
  state.on('step:applied',                _playStepNarration);
  state.on('change:cameraAnimDurationMs', _syncDurationInputs);
  state.on('change:objectAnimDurationMs', _syncDurationInputs);
  state.on('change:animationPresets',     renderStepsPanel);
  // Re-render when the multi-step selection changes — covers Ctrl/Shift
  // click, outside-click clear, Esc, and the cross-step apply banner.
  state.on('change:selectedStepIds',      renderStepsPanel);
  // Bulk-apply blink: actions.js fires this after _toggleVisibilityMulti
  // / _bulkAssignColorMulti commit a setState. We add .justEdited to the
  // matching step cards (and parent chapter headers) so the user sees
  // EXACTLY which steps the bulk action just touched. CSS handles the
  // 400 ms yellow flash; we strip the class after a beat so the next
  // bulk-apply restarts cleanly.
  state.on('steps:bulkApplied', _onBulkApplied);
  // Surgical per-step thumbnail update — avoid re-rendering the whole list.
  state.on('step:thumb', _onStepThumb);

  // Click outside the timeline panel collapses the expanded step. The
  // multi-step selection (selectedStepIds) is INTENTIONALLY NOT cleared
  // here: it's a deliberate edit-mode that the user enters via Ctrl/Shift
  // click and exits explicitly via Esc, the banner's Clear button, a
  // plain step click, or step delete. Auto-clearing on outside-click was
  // the cause of "eyeball / color edits only hit the active step": the
  // capture-phase clear ran BEFORE the click reached its target handler.
  document.addEventListener('click', e => {
    if (!_container) return;
    if (_container.contains(e.target)) return;
    const ctx = document.getElementById('context-menu');
    if (ctx && ctx.contains(e.target)) return;
    if (_expandedId !== null) {
      _expandedId = null;
      renderStepsPanel();
    }
  }, true);

  _syncDurationInputs();
  renderStepsPanel();

  // List-level drop handling — one slot, never two conflicting indicators.
  // Handles step drags and chapter drags with the same dashed slot UX.
  const list = _container.querySelector('#steps-list');
  list.addEventListener('dragover', e => {
    if (!_dragIds.length && !_dragChapterId) return;
    e.preventDefault();
    _positionDropSlot(list, e.clientY);
    // Step-group hover-expand: 300ms over a collapsed group head
    // pops it open so the user can drop INTO the group.
    if (_dragIds.length) _maybeStartGroupExpand(list, e.clientY);
  });
  list.addEventListener('dragleave', e => {
    // Only remove the slot when the pointer leaves the LIST entirely, not when
    // it transitions between children.
    if (list.contains(e.relatedTarget)) return;
    _removeDropSlot();
    _clearGroupExpandTimer();
  });
  list.addEventListener('drop', e => {
    if (!_dragIds.length && !_dragChapterId) return;
    e.preventDefault();
    _commitDropSlot(list);
    _clearGroupExpandTimer();
  });
}

/**
 * Flash the cards (and parent chapter headers) of every step that was
 * just hit by a bulk multi-step action. CSS @keyframes sbsBlinkYellow
 * does the actual 400 ms flash; this just toggles the class on the
 * matching DOM nodes and clears it after the animation so a back-to-
 * back bulk-apply re-runs the animation cleanly.
 */
function _onBulkApplied({ stepIds } = {}) {
  if (!_container || !Array.isArray(stepIds) || stepIds.length === 0) return;
  const flash = (el) => {
    if (!el) return;
    el.classList.remove('justEdited');
    // Force a reflow so the animation restarts when re-added back-to-back.
    void el.offsetWidth;
    el.classList.add('justEdited');
    setTimeout(() => el.classList.remove('justEdited'), 420);
  };
  for (const id of stepIds) {
    flash(_container.querySelector(`.stepItem[data-step-id="${id}"]`));
  }
  // Also flash parent chapter headers — gives a chapter-level "this
  // chapter just got edited" cue when the user is zoomed out.
  const stepArr = state.get('steps') || [];
  const chapterIds = new Set();
  for (const id of stepIds) {
    const s = stepArr.find(x => x.id === id);
    if (s?.chapterId) chapterIds.add(s.chapterId);
  }
  for (const chId of chapterIds) {
    flash(_container.querySelector(`.chapterHeader[data-chapter-id="${chId}"]`));
  }
}

function _onActiveStepChanged() {
  // Active step changed (click, keyboard, programmatic). Tab expansion
  // is now a SEPARATE user gesture — second click on the active step.
  // So if a tab is open and the active step is moving away from it,
  // close it. Don't auto-open the new step's tab.
  const newActive = state.get('activeStepId');
  if (_expandedId && _expandedId !== newActive) _expandedId = null;
  renderStepsPanel();
}

let _narrationAudio       = null;
let _narrationEndResolvers = [];   // queued awaiters waiting for current clip to end
function _resolveNarrationEnd() {
  const list = _narrationEndResolvers;
  _narrationEndResolvers = [];
  for (const fn of list) { try { fn(); } catch {} }
}

function _playStepNarrationNow(step) {
  // V0.1.78 — narration overflow within step groups.
  //   • If the new step has its OWN narration → stop the previous clip
  //     and start the new one (old "last-write-wins" behaviour).
  //   • If the new step has NO narration → leave the previous clip
  //     playing. This lets auto-chain through no-narration sub-steps
  //     of a group while the head's narration continues.
  //
  // The chain coordination (steps.js) holds before activating any
  // sub-step that DOES have its own narration, waiting via
  // awaitNarrationEnd() — so two clips never overlap.
  if (state.get('_exporting'))     return;
  if (state.get('narrationMuted')) return;
  if (!step || step.isBaseStep)    return;

  // Determine if this step has narration to play. We must check before
  // stopping the previous clip — otherwise a navigate to a no-narration
  // step silently cuts off the head's narration mid-overflow.
  const hasNarration = !!(step.narration?.dataFile || step.narration?.dataUrl);
  if (!hasNarration) {
    return;   // overflow: leave _narrationAudio alone.
  }

  // Stop previous clip + resolve any pending awaiters (the chain may
  // have been holding for it; the new clip becomes the thing to wait
  // on next).
  if (_narrationAudio) {
    try { _narrationAudio.pause(); } catch {}
    _narrationAudio = null;
    _resolveNarrationEnd();
  }
  narrationCache.ensurePlayable(step).then(clip => {
    if (!clip) return;
    _narrationAudio = new Audio(clip);
    _narrationAudio.addEventListener('ended', () => {
      // Natural end. Drop the ref + flush awaiters.
      if (_narrationAudio?.src === clip || _narrationAudio?.currentSrc === clip) {
        _narrationAudio = null;
      }
      _resolveNarrationEnd();
    });
    _narrationAudio.play().catch(err => console.warn('[narration] play:', err.message));
  });
}

/**
 * Public — is a narration clip currently playing?
 * Returns true only while the <audio> element exists AND hasn't ended
 * naturally / been paused. Used by the in-group auto-chain coordinator
 * to decide whether to hold the next sub-step.
 */
export function isNarrationPlaying() {
  const a = _narrationAudio;
  if (!a) return false;
  // Paused-by-user or not-yet-started clips don't count.
  return !a.paused && !a.ended;
}

/**
 * Public — promise that resolves when the current narration clip ends
 * (natural end or replaced by a new clip). Resolves immediately if no
 * clip is playing. The chain awaits this before activating any
 * narration-bearing sub-step OR before crossing the group boundary
 * when the last narration overflowed past the final sub-step.
 */
export function awaitNarrationEnd() {
  if (!isNarrationPlaying()) return Promise.resolve();
  return new Promise(resolve => { _narrationEndResolvers.push(resolve); });
}

function _playStepNarration(step) {
  // Auto-play any saved TTS / mic clip when a step is applied — UNLESS
  // the step's animation preset includes a `narration` channel. In that
  // case, the phased animator (steps.js) already emitted a
  // `narration:trigger` event at the slot start; double-playing would
  // overlap audio with itself.
  try {
    const animStr = resolveAnimationString(step?.transition || {}, state.get('animationPresets') || []);
    const phases  = animStr ? parseAnimation(animStr) : null;
    if (phases && phases.some(p => p.types.includes('narration'))) {
      // Phased animation owns playback for this step — bail.
      return;
    }
  } catch { /* fall through to legacy auto-play on any parse error */ }
  _playStepNarrationNow(step);
}

// Hook the phased-animation trigger. Fires when `narration(N)` slot
// begins inside _runPhasedAnimation. Listener payload is the target
// snapshot, but we re-derive the active step from state for safety
// (the snapshot could be missing fields).
state.on('narration:trigger', () => {
  const stepId = state.get('activeStepId');
  const step   = (state.get('steps') || []).find(s => s.id === stepId);
  if (step) _playStepNarrationNow(step);
});

/**
 * Update a single step's thumbnail <img> in place. If the slot was the
 * placeholder div (no thumbnail yet), a full re-render swaps it for an
 * <img>; after that, we just update src every tick with no DOM churn.
 */
function _onStepThumb({ stepId, dataUrl }) {
  if (!stepId || !dataUrl) return;
  const el = document.querySelector(`[data-thumb-step="${stepId}"]`);
  if (!el) return;
  if (el.tagName === 'IMG') {
    el.src = dataUrl;
  } else {
    renderStepsPanel();   // placeholder -> img swap
  }
}

function _syncAndRender() { renderStepsPanel(); }

function _syncDurationInputs() {
  const camEl = document.getElementById('global-cam-dur');
  const objEl = document.getElementById('global-obj-dur');
  if (camEl) camEl.value = state.get('cameraAnimDurationMs') ?? 1500;
  if (objEl) objEl.value = state.get('objectAnimDurationMs') ?? 1500;
}

function _setGlobalDuration(key, val) {
  const label = key === 'cameraAnimDurationMs' ? 'Animation length AL1' : 'Animation length AL2';
  actions.commitStateChange(label, [key], () => {
    state.setState({ [key]: val });
    state.markDirty();
  }, { coalesceKey: `globalDur:${key}` });
}

// ── Render ──────────────────────────────────────────────────────────────────

export function renderStepsPanel() {
  const list = document.getElementById('steps-list');
  if (!list) return;

  const allSteps    = (state.get('steps') || []).filter(s => !s.isBaseStep);
  const allChapters = state.get('chapters') || [];
  const activeId    = state.get('activeStepId');
  _plugActionStepIds = getPlugActionStepIds();   // V0.3.0.152 — recompute 🔌 markers

  if (allSteps.length === 0) {
    list.innerHTML = '<div class="small muted" style="padding:12px;">No steps yet.<br>Press <b>+ Step</b> to capture the current scene.</div>';
    return;
  }

  const scrollTop = list.scrollTop;
  list.innerHTML  = '';

  // ── Multi-step apply banner ────────────────────────────────────────
  // When ≥ 2 steps are multi-selected, show a sticky warning at the top
  // of the list. Tells the user that subsequent visibility / color
  // edits will fan out across all selected steps, not just the active
  // one. "Clear" button (and Esc, handled in main.js) drops the set.
  const selCount = _selSize();
  if (selCount >= 2) {
    const banner = document.createElement('div');
    // Background is a soft yellow tint; text needs to be DARK so it
    // reads cleanly on either theme. #78350f = amber-900.
    banner.style.cssText = `
      position:sticky;top:0;z-index:5;
      margin:-2px -2px 8px -2px;padding:6px 8px;
      background:rgba(234,179,8,0.18);
      border:1px solid rgba(234,179,8,0.55);
      border-radius:6px;
      font-size:11px;line-height:1.35;color:#78350f;
      display:flex;align-items:center;gap:8px;
    `;
    banner.innerHTML = `
      <span style="flex:1;">
        Editing <b>${selCount}</b> steps · visibility &amp; color changes
        apply to all of them.
      </span>
      <button class="btn" type="button" id="multistep-clear"
              style="padding:2px 8px;font-size:10px;flex:none;">
        Clear (Esc)
      </button>
    `;
    banner.querySelector('#multistep-clear').addEventListener('click', () => _selClear());
    list.appendChild(banner);
  }

  // ── Top-level numbering ──────────────────────────────────────────────
  // Sub-steps display the SAME number as their group head (per step-group
  // spec — the head is "Step 4" and every sub-step under it also shows
  // "Step 4"). The count we walk increments only on top-level entries
  // (heads + non-grouped); sub-steps inherit the most recent count.
  // `topLevelTotal` is the count of non-sub-step entries — used wherever
  // a "Step X / N" denominator is shown.
  const displayNumberOf = new Map();   // stepId -> number to show on badge
  let topLevelCounter = 0;
  for (const s of allSteps) {
    if (!s.groupId) topLevelCounter++;
    displayNumberOf.set(s.id, topLevelCounter);
  }
  const topLevelTotal = topLevelCounter;

  // Group steps by chapter, preserving each chapter's existing internal order.
  const byChapter = new Map();                 // chapterId -> Step[]
  const ungrouped = [];
  const chapterIds = new Set(allChapters.map(c => c.id));
  for (const s of allSteps) {
    if (s.chapterId && chapterIds.has(s.chapterId)) {
      if (!byChapter.has(s.chapterId)) byChapter.set(s.chapterId, []);
      byChapter.get(s.chapterId).push(s);
    } else {
      ungrouped.push(s);
    }
  }

  // Group-aware emission:
  //   - Top-level steps (groupId === null) always emit.
  //   - Group heads emit themselves + (when visually expanded) every
  //     immediate sub-step that follows. Sub-steps are recognised by
  //     `s.groupId === head.id` and are guaranteed by the array
  //     invariant to appear contiguously after the head.
  //   - Sub-steps NEVER emit on their own — they're emitted by their
  //     head when the group is expanded.
  const emitStep = (step, opts = {}) => {
    const displayNum = displayNumberOf.get(step.id) ?? 0;
    const isActive   = step.id === activeId;
    const isExpanded = step.id === _expandedId;
    list.appendChild(_buildStepCard(
      step, displayNum, isActive, isExpanded, topLevelTotal,
      {
        isSubStep:        !!opts.isSubStep,
        isGroupHead:      !!step.groupHead,
        isGroupCollapsed: !!opts.isGroupCollapsed,
      },
    ));
  };
  const emitBucket = (bucket) => {
    for (const s of bucket) {
      if (s.groupId) continue;            // sub-steps go via their head
      if (s.groupHead) {
        const collapsed = _isGroupVisuallyCollapsed(s, activeId);
        emitStep(s, { isGroupCollapsed: collapsed });
        if (!collapsed) {
          for (const sub of bucket) {
            if (sub.groupId === s.id) emitStep(sub, { isSubStep: true });
          }
        }
      } else {
        emitStep(s);
      }
    }
  };

  // Render: ungrouped steps at top → chapters at bottom (in chapter-list order).
  // A newly-created empty chapter naturally appears at the end of the timeline.
  emitBucket(ungrouped);
  allChapters.forEach((chapter, chIdx) => {
    list.appendChild(_buildChapterHeader(chapter, chIdx + 1));
    if (_isChapterVisuallyCollapsed(chapter, activeId)) return;
    emitBucket(byChapter.get(chapter.id) || []);
  });

  list.scrollTop = scrollTop;

  const activeCard = list.querySelector('.stepItem.active');
  if (activeCard) activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Chapter header ───────────────────────────────────────────────────────────

/**
 * Collapse = lock is the only control.
 *   - locked            → always expanded
 *   - unlocked + active step inside → expanded (auto-expand)
 *   - unlocked + no active step inside → collapsed
 */
function _isChapterVisuallyCollapsed(chapter, activeId) {
  if (chapter.locked) return false;
  if (_dragExpandId === chapter.id) return false;   // drag-hover override
  if (activeId) {
    const active = (state.get('steps') || []).find(s => s.id === activeId);
    if (active?.chapterId === chapter.id) return false;
  }
  return true;
}

/**
 * Step-group equivalent of `_isChapterVisuallyCollapsed`. A group head's
 * sub-steps are visible iff:
 *   - the head is locked (groupLocked === true), OR
 *   - the head itself is the active step, OR
 *   - one of the head's sub-steps is the active step.
 * Otherwise the group is collapsed and its sub-steps are hidden.
 *
 * (Drag-to-expand override comes in Phase E and will hook in here.)
 */
function _isGroupVisuallyCollapsed(headStep, activeId) {
  if (!headStep || !headStep.groupHead) return false;
  if (headStep.groupLocked) return false;
  if (_dragGroupExpandId === headStep.id) return false;   // drag-hover override
  // Hide cascade: a hidden head always renders EXPANDED so the user
  // sees that all its sub-steps are also hidden (cascade applied in
  // steps.setStepHidden). Unhiding the head closes the group again
  // unless one of the other expand conditions still applies.
  if (headStep.hidden) return false;
  if (activeId === headStep.id) return false;
  if (activeId) {
    const active = (state.get('steps') || []).find(s => s.id === activeId);
    if (active?.groupId === headStep.id) return false;
  }
  // Phase F: a group containing ANY currently multi-selected step (head
  // or any sub-step) auto-expands so the user can see what they've got
  // selected. Mirrors the chapter behaviour where a partially-selected
  // chapter header glows partial.
  const sel = _getSel();
  if (sel.size) {
    if (sel.has(headStep.id)) return false;
    const stepsArr = state.get('steps') || [];
    for (const s of stepsArr) {
      if (s.groupId === headStep.id && sel.has(s.id)) return false;
    }
  }
  return true;
}

function _clearGroupExpandTimer() {
  if (_groupExpandTimer) { clearTimeout(_groupExpandTimer); _groupExpandTimer = null; }
  _groupExpandTargetId = null;
}

function _performDragGroupExpand(headId) {
  _groupExpandTimer    = null;
  _groupExpandTargetId = null;
  if (_dragGroupExpandId === headId) return;
  _dragGroupExpandId = headId;
  renderStepsPanel();
}

function _endDragGroupExpand() {
  _groupExpandTargetId = null;
  if (_dragGroupExpandId !== null) { _dragGroupExpandId = null; renderStepsPanel(); }
}

function _buildChapterHeader(chapter, number) {
  const wrap = document.createElement('div');
  // .selected when ANY of this chapter's steps is in the multi-step
  // selection; .selected.partial when only SOME (vs all) are. Lets the
  // user see at a glance which chapters they're about to mass-edit.
  const chapterIds = _chapterStepIds(chapter.id);
  const sel        = _getSel();
  const overlap    = chapterIds.filter(id => sel.has(id)).length;
  const selClass   = overlap === 0
    ? ''
    : overlap === chapterIds.length ? ' selected' : ' selected partial';
  wrap.className         = 'chapterHeader' + (chapter.hidden ? ' is-hidden' : '') + selClass;
  wrap.dataset.chapterId = chapter.id;
  wrap.draggable         = true;
  // Inline base style (overridden by .chapterHeader.selected when the
  // chapter is in the multi-step selection — see components.css). Text
  // colour pulls from the theme variable so it reads on both palettes;
  // the .selected rule forces dark slate to stay readable against the
  // warm fill.
  wrap.style.cssText = [
    'padding:8px 8px',
    'margin-top:10px',
    'display:flex',
    'align-items:center',
    'gap:6px',
    // Chapter tint — green hue (was blue). Distinct from the amber
    // step-group tint so chapters and groups don't read as the same
    // construct at a glance.
    'background:rgba(34,197,94,0.12)',
    'border:1px solid rgba(34,197,94,0.45)',
    'border-radius:6px',
    'color:var(--text)',
    'cursor:grab',
    'user-select:none',
  ].join(';');

  // Numbered badge (position-based)
  const badge = document.createElement('span');
  badge.className   = 'pill';
  badge.style.cssText = 'flex-shrink:0;font-weight:700;font-size:11px;';
  badge.textContent = String(number).padStart(2, '0');

  const name = document.createElement('span');
  name.className   = 'title';
  name.style.flex  = '1';
  name.style.color = 'var(--text)';
  name.textContent = chapter.name || 'Chapter';

  // Lock: on (blue) = always expanded; off (grey) = collapsable. Lock is
  // the only collapse control — arrow toggle removed to reduce redundancy.
  const btnLock = _mkBtn(chapter.locked ? '🔒' : '🔓', chapter.locked ? 'Unlock (allow collapse)' : 'Lock open');
  btnLock.style.color   = chapter.locked ? '#3b82f6' : '#94a3b8';
  btnLock.style.opacity = chapter.locked ? '1' : '0.75';
  btnLock.addEventListener('click', e => {
    e.stopPropagation();
    actions.setChapterLocked(chapter.id, !chapter.locked);
  });

  // Eye toggle — hides every step in the chapter from playback / export
  // without deleting them. Useful for project variations: stage two
  // alternate chapters, hide one when exporting variant A, swap when
  // exporting variant B. Per-step hidden flag is independent.
  const btnEye = document.createElement('button');
  btnEye.type = 'button';
  btnEye.className = 'chapterEyeToggle';
  btnEye.textContent = chapter.hidden ? '🚫' : '👁';
  btnEye.title = chapter.hidden ? 'Show chapter in playback' : 'Hide chapter from playback';
  btnEye.addEventListener('click', e => {
    e.stopPropagation();
    actions.commitStateChange(
      chapter.hidden ? 'Show chapter' : 'Hide chapter',
      ['chapters'],
      () => steps.setChapterHidden(chapter.id, !chapter.hidden),
    );
    setStatus(chapter.hidden
      ? `Chapter "${chapter.name}" shown in playback.`
      : `Chapter "${chapter.name}" hidden from playback.`);
  });

  const btnRename = _mkBtn('✎',  'Rename chapter');
  const btnDel    = _mkBtn('🗑', 'Delete chapter');
  btnRename.addEventListener('click', e => { e.stopPropagation(); _renameChapter(chapter.id); });
  btnDel.addEventListener('click',    e => { e.stopPropagation(); _deleteChapter(chapter.id); });

  wrap.append(badge, name, btnEye, btnLock, btnRename, btnDel);

  // Right-click → chapter context menu (rename, copy, paste, lock, delete,
  // and the multi-step selection helpers — see _showChapterContextMenu).
  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _showChapterContextMenu(chapter, e.clientX, e.clientY);
  });

  // Ctrl/Cmd-click on the chapter header bulk-toggles every step in
  // this chapter in/out of the multi-step selection. Shift-click range-
  // extends from the existing anchor through this chapter's last step.
  // Plain click is left as a no-op so the eye / lock / rename / delete
  // buttons (which sit inside the header) don't have a passive
  // selection hijack stealing their event.
  wrap.addEventListener('click', e => {
    // Don't hijack clicks on the header's own buttons or form controls.
    if (e.target.closest('button, input, select, textarea, [contenteditable="true"]')) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      _toggleChapterInSelection(chapter.id);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      _extendSelectionThroughChapter(chapter.id);
      return;
    }
    // V0.2.17: plain click on the chapter header → activate the chapter's
    // first step. Side-effect: an unlocked, currently-collapsed chapter
    // auto-expands as soon as its first step becomes active (see the
    // _isChapterVisuallyCollapsed rule).
    e.preventDefault();
    e.stopPropagation();
    const ids = _chapterStepIds(chapter.id);
    if (ids.length === 0) return;
    steps.activateStep(ids[0], true);
    actions.uniteStepSelectionWithActive();
  });

  // ── Drag the whole chapter (and its steps) ────────────────────────────────
  wrap.addEventListener('dragstart', e => {
    // Same form-control guard as step cards — see _buildStepCard.
    if (e.target.closest('select, input, button, textarea, option, label, [contenteditable="true"]')) {
      e.preventDefault();
      return;
    }
    _dragChapterId = chapter.id;
    _dragId        = null;
    e.dataTransfer.effectAllowed = 'move';
    wrap.style.opacity = '0.5';
  });
  wrap.addEventListener('dragend', () => {
    _dragChapterId = null;
    _clearExpandTimer();
    _removeDropSlot();
    _endDragExpand();
    wrap.style.opacity = '';
  });

  // Chapter header is NOT a per-drop target anymore — all step and chapter
  // drops go through the list-level drop-slot logic. The header still
  // participates in hover-to-expand so that a collapsed chapter can be
  // opened mid-drag to expose its steps.
  wrap.addEventListener('dragover', e => {
    e.preventDefault();
    const activeIdNow = state.get('activeStepId');
    if (_dragId && _isChapterVisuallyCollapsed(chapter, activeIdNow)) {
      if (_expandTargetId !== chapter.id) {
        _clearExpandTimer();
        _expandTargetId  = chapter.id;
        _expandAnchorTop = wrap.getBoundingClientRect().top;
        _expandTimer = setTimeout(() => _performDragExpand(chapter.id), HOVER_EXPAND_MS);
      }
    }
  });
  wrap.addEventListener('dragleave', () => {
    if (_expandTargetId === chapter.id) _clearExpandTimer();
  });

  return wrap;
}

function _clearExpandTimer() {
  if (_expandTimer) { clearTimeout(_expandTimer); _expandTimer = null; }
  _expandTargetId = null;
}

/**
 * Fired 500ms after the user began hovering a chapter header (during a step
 * drag). Swaps the drag-expand state to this chapter, and nudges the list's
 * scrollTop so the hovered header stays under the cursor — collapsing a
 * previous chapter would otherwise shove it out from under the mouse.
 */
function _performDragExpand(chapterId) {
  _expandTimer    = null;
  _expandTargetId = null;

  // Nothing to do if we're already expanded on this chapter.
  if (_dragExpandId === chapterId) return;

  _dragExpandId = chapterId;
  renderStepsPanel();

  // Post-render: measure and correct scroll so the target header keeps its
  // viewport Y. Collapsing an earlier section can shrink the list by a lot.
  requestAnimationFrame(() => {
    const list = document.getElementById('steps-list');
    if (!list) return;
    const header = list.querySelector(`.chapterHeader[data-chapter-id="${chapterId}"]`);
    if (!header) return;
    const newTop = header.getBoundingClientRect().top;
    const delta  = newTop - _expandAnchorTop;
    if (Math.abs(delta) > 0.5) list.scrollTop += delta;
  });
}

function _endDragExpand() {
  _expandTargetId = null;
  if (_dragExpandId !== null) { _dragExpandId = null; renderStepsPanel(); }
}

// ── Drop slot ───────────────────────────────────────────────────────────────
// A single dashed placeholder inserted into the list while a step drag is in
// progress. The surrounding cards shift to make room so the user sees exactly
// where the step(s) will land.

function _buildDropSlot() {
  const slot = document.createElement('div');
  slot.className = 'drop-slot';
  // Slot height matches a collapsed step card for step drags, or a chapter
  // header for chapter drags — set via _positionDropSlot each time.
  slot.style.cssText = [
    'margin:4px 0',
    `border:2px dashed ${DROP_COLOR}`,
    'border-radius:10px',
    'background:rgba(59,130,246,0.08)',
    'box-sizing:border-box',
    'pointer-events:none',              // don't interfere with dragover of neighbours
    'transition:border-color 80ms linear,background 80ms linear',
  ].join(';');
  return slot;
}

function _removeDropSlot() {
  if (_dropSlot && _dropSlot.parentNode) _dropSlot.parentNode.removeChild(_dropSlot);
  _dropSlot = null;
  _clearDropTargetChapter();
}

/**
 * Place the drop slot at the correct vertical position for the current mouse Y.
 *
 * Step drag: walks every list child, picks the first whose midpoint is below
 * the cursor, and inserts the slot just before it. Slot height ~ collapsed
 * card.
 *
 * Chapter drag: only chapter headers are valid boundaries (dropping "inside"
 * a chapter would be meaningless — chapters move as a block). The slot snaps
 * to the nearest boundary between chapter sections. Slot height ~ header.
 */
function _positionDropSlot(list, mouseY) {
  if (!_dropSlot) _dropSlot = _buildDropSlot();

  let insertBefore = null;

  if (_dragChapterId) {
    // Chapter drag — slot ONLY snaps to chapter-header boundaries. Picks the
    // nearest gap (between two headers, before the first, or after the last).
    // V0.2.17: louder visual + a "↩ Insert chapter" label so the user sees
    // the constraint (chapters land between chapters, never between steps).
    _dropSlot.style.height = '54px';
    _dropSlot.style.display = 'flex';
    _dropSlot.style.alignItems = 'center';
    _dropSlot.style.justifyContent = 'center';
    _dropSlot.style.fontSize = '12px';
    _dropSlot.style.fontWeight = '600';
    _dropSlot.style.letterSpacing = '0.4px';
    _dropSlot.style.color = DROP_COLOR;
    _dropSlot.textContent = '↩ Insert chapter here';
    const headers = Array.from(list.querySelectorAll('.chapterHeader'));
    let bestDist = Infinity;
    for (let i = 0; i <= headers.length; i++) {
      // boundary i: just before headers[i] (or end of list when i == length).
      const ref  = headers[i] || list.lastElementChild;
      const rect = ref?.getBoundingClientRect();
      if (!rect) continue;
      const y = headers[i] ? rect.top : rect.bottom;
      const dist = Math.abs(mouseY - y);
      if (dist < bestDist) { bestDist = dist; insertBefore = headers[i] || null; }
    }
  } else {
    // Step drag — slot goes between any two cards/headers.
    _dropSlot.style.height = '60px';
    _dropSlot.style.display = '';
    _dropSlot.textContent = '';
    const children = Array.from(list.children).filter(el => el !== _dropSlot);
    for (const el of children) {
      const rect = el.getBoundingClientRect();
      const mid  = rect.top + rect.height / 2;
      if (mouseY < mid) { insertBefore = el; break; }
    }
  }

  // Already in the right place? (Check parent too — renderStepsPanel can
  // orphan the slot with a stale sibling reference.)
  if (_dropSlot.parentNode === list && _dropSlot.nextSibling === insertBefore) {
    _updateDropTargetChapter();
    return;
  }
  if (insertBefore) list.insertBefore(_dropSlot, insertBefore);
  else              list.appendChild(_dropSlot);

  // Step-group: amber slot when the drop position would join an existing
  // group, else default blue. Heads (and their carried sub-steps) can't
  // be dropped INTO another group — keep them blue.
  if (_dragIds.length) _updateDropSlotColor();
  _updateDropTargetChapter();
}

// V0.2.17: while dragging, highlight the chapter the slot currently sits
// inside (or NULL if at a top-level boundary). Makes step→chapter drops
// readable — you can see exactly which chapter you're about to land in.
let _dropTargetChapterId = null;
function _updateDropTargetChapter() {
  if (!_dropSlot || !_container) { _clearDropTargetChapter(); return; }
  // Chapter drags don't have a "target chapter" — they always drop at
  // chapter boundaries (handled in _positionDropSlot).
  if (_dragChapterId) { _clearDropTargetChapter(); return; }
  let target = null;
  for (let n = _dropSlot.previousElementSibling; n; n = n.previousElementSibling) {
    if (n.classList.contains('chapterHeader')) {
      target = n.dataset.chapterId;
      break;
    }
    if (n.classList.contains('stepItem')) {
      const step = (state.get('steps') || []).find(s => s.id === n.dataset.stepId);
      if (step?.chapterId) { target = step.chapterId; break; }
    }
  }
  if (target === _dropTargetChapterId) return;
  if (_dropTargetChapterId) {
    _container.querySelector(`.chapterHeader[data-chapter-id="${_dropTargetChapterId}"]`)
      ?.classList.remove('chapterDropTarget');
  }
  _dropTargetChapterId = target;
  if (target) {
    _container.querySelector(`.chapterHeader[data-chapter-id="${target}"]`)
      ?.classList.add('chapterDropTarget');
  }
}
function _clearDropTargetChapter() {
  if (_dropTargetChapterId && _container) {
    _container.querySelector(`.chapterHeader[data-chapter-id="${_dropTargetChapterId}"]`)
      ?.classList.remove('chapterDropTarget');
  }
  _dropTargetChapterId = null;
}

/**
 * Recolour the drop slot based on whether the current position would
 * make the dragged step a sub-step of an existing group.
 */
function _updateDropSlotColor() {
  if (!_dropSlot) return;
  const targetGroupId = _resolveTargetGroupForSlot();
  // Heads can't go into groups (rule: no nested groups). Force blue.
  const draggingHead = _dragIds.some(id => {
    const s = (state.get('steps') || []).find(x => x.id === id);
    return s?.groupHead;
  });
  const useGroup = !!targetGroupId && !draggingHead;
  const c = useGroup ? DROP_COLOR_GROUP : DROP_COLOR;
  _dropSlot.style.borderColor = c;
  _dropSlot.style.background  = useGroup
    ? 'rgba(234,179,8,0.12)'
    : 'rgba(59,130,246,0.08)';
}

/**
 * Walk neighbours of the current drop slot to determine which group
 * (if any) the dragged step(s) would belong to after landing. Returns
 * a group head's stepId, or null for top-level.
 *
 * Rule:
 *   - If next sibling is a sub-step  → join its group.
 *   - Else if prev sibling is a HEAD → join that head's group (first
 *     sub-step position).
 *   - Else if prev sibling is a sub-step AND next is NOT a sub-step
 *     of the same group → drop position is at end-of-group → top-level.
 *   - Else → top-level.
 */
function _resolveTargetGroupForSlot() {
  if (!_dropSlot) return null;
  const stepsArr = state.get('steps') || [];
  const nextEl = _dropSlot.nextElementSibling;
  const prevEl = _dropSlot.previousElementSibling;
  const stepOf = (el) => el && el.classList?.contains('stepItem')
    ? stepsArr.find(s => s.id === el.dataset.stepId) : null;
  const nextStep = stepOf(nextEl);
  const prevStep = stepOf(prevEl);
  if (nextStep?.groupId)  return nextStep.groupId;
  if (prevStep?.groupHead) return prevStep.id;
  // V0.3.0.174 — the slot sits AFTER a group's last sub-step (prev is a sub-step,
  // next isn't part of the group). Previously this fell through to top-level, so
  // you could never drop at the END of a group — only one-before-last. Now it
  // joins that group as its last position (the orange end-of-group slot).
  if (prevStep?.groupId) return prevStep.groupId;
  return null;
}

/**
 * On dragover, if the cursor sits over a collapsed group head's row,
 * start (or sustain) the 300ms auto-expand timer. Cursor leaving the
 * row clears the timer; the timer firing flips _dragGroupExpandId.
 */
function _maybeStartGroupExpand(list, mouseY) {
  // Find the group-head row directly under the cursor.
  const cards = Array.from(list.querySelectorAll('.stepItem.groupHead'));
  let target = null;
  for (const c of cards) {
    const rect = c.getBoundingClientRect();
    if (mouseY >= rect.top && mouseY <= rect.bottom) { target = c; break; }
  }
  const headId = target?.dataset.stepId || null;
  // No target — cancel any pending expansion.
  if (!headId) {
    if (_groupExpandTargetId) _clearGroupExpandTimer();
    return;
  }
  // Already expanded for this head — nothing to do.
  if (_dragGroupExpandId === headId) return;
  // Already counting down for this head — let it tick.
  if (_groupExpandTargetId === headId) return;
  // Don't expand a head we're dragging (its sub-steps come along anyway).
  if (_dragIds.includes(headId)) return;
  _clearGroupExpandTimer();
  _groupExpandTargetId = headId;
  _groupExpandTimer    = setTimeout(() => _performDragGroupExpand(headId), HOVER_GROUP_EXPAND_MS);
}

/**
 * Called on drop. Translates the slot's DOM position into a concrete move
 * action. Two paths:
 *
 *   Step drag:    chapterId = nearest preceding step or chapter header;
 *                 insert index = position of the first step card AFTER the
 *                 slot in state.steps (fallback: append at end).
 *
 *   Chapter drag: target index = number of chapter headers appearing BEFORE
 *                 the slot in the DOM. Dropping at the end places the
 *                 chapter at the last index.
 */
function _commitDropSlot(list) {
  if (!_dropSlot) return;

  if (_dragChapterId) {
    // Count chapter headers before the slot to derive the target index.
    let targetIdx = 0;
    for (let node = _dropSlot.previousElementSibling; node; node = node.previousElementSibling) {
      if (node.classList.contains('chapterHeader')) targetIdx++;
    }
    const chapters = state.get('chapters') || [];
    const fromIdx  = chapters.findIndex(c => c.id === _dragChapterId);
    // Dropping into its own slot is a no-op.
    _removeDropSlot();
    if (fromIdx < 0 || targetIdx === fromIdx || targetIdx === fromIdx + 1) return;
    // Adjust: if removing fromIdx shifts the array, a later targetIdx drops by 1.
    const adjusted = fromIdx < targetIdx ? targetIdx - 1 : targetIdx;
    actions.reorderChapter(_dragChapterId, adjusted);
    return;
  }

  // Step drag.
  let targetChapterId = null;
  for (let node = _dropSlot.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.classList.contains('stepItem')) {
      const prevStep = (state.get('steps') || []).find(s => s.id === node.dataset.stepId);
      targetChapterId = prevStep?.chapterId ?? null;
      break;
    }
    if (node.classList.contains('chapterHeader')) {
      targetChapterId = node.dataset.chapterId ?? null;
      break;
    }
  }

  const all = state.get('steps') || [];
  let toIdx = all.length;
  for (let node = _dropSlot.nextElementSibling; node; node = node.nextElementSibling) {
    if (node.classList.contains('stepItem')) {
      const idx = all.findIndex(s => s.id === node.dataset.stepId);
      if (idx >= 0) toIdx = idx;
      break;
    }
  }

  // Step-group target resolution: which group should the dropped step
  // belong to after landing? Computed BEFORE the slot is removed
  // because _resolveTargetGroupForSlot reads the slot's siblings.
  // Heads (and their carried sub-steps) can't be dropped into a group —
  // force null in that case (no nested groups).
  let targetGroupId = _resolveTargetGroupForSlot();
  const draggingHead = _dragIds.some(id => {
    const s = all.find(x => x.id === id);
    return s?.groupHead;
  });
  if (draggingHead) targetGroupId = null;
  // Don't let a sub-step land inside the SAME group it's already in
  // (no-op vs the existing groupId) — but if it's a different group or
  // null, we apply the change. The chosen target also has to NOT be
  // any of the steps we're carrying (can't make a step a sub-step of
  // itself; can't move a sub-step under a head that's coming with us).
  if (targetGroupId && _dragIds.includes(targetGroupId)) targetGroupId = null;

  // Build the assignment map: every dragged step that ISN'T a head we
  // brought along gets its groupId reassigned. Sub-steps inside a
  // dragged-head bundle keep their groupId pointing at THAT head.
  const headIdsInDrag = new Set(_dragIds.filter(id => {
    const s = all.find(x => x.id === id);
    return s?.groupHead;
  }));
  const groupAssignment = {};
  for (const id of _dragIds) {
    const s = all.find(x => x.id === id);
    if (!s) continue;
    // Sub-step coming with its own head → keep its existing groupId.
    if (s.groupId && headIdsInDrag.has(s.groupId)) continue;
    // Heads always land at top-level (groupId stays null).
    if (s.groupHead) {
      groupAssignment[id] = null;
      continue;
    }
    groupAssignment[id] = targetGroupId;
  }

  _removeDropSlot();

  if (_dragIds.length && !_dragIds.some(id => id === null)) {
    actions.moveStepsToChapterAndRegroup(_dragIds, targetChapterId, toIdx, groupAssignment);
  }
}

/**
 * Index in the full steps array where a step should land when dropped at the
 * TOP of a chapter. Uses the full array directly so the returned index is
 * correct for moveStepToChapter's splice semantics.
 *   - If the chapter already has steps, return the index of its first step.
 *   - If empty, return the index of the first step of the next chapter with
 *     steps, or the end of the array.
 */
function _chapterTopInsertIndex(chapterId) {
  const full        = state.get('steps') || [];
  const allChapters = state.get('chapters') || [];

  const firstOfCh = full.findIndex(s => !s.isBaseStep && s.chapterId === chapterId);
  if (firstOfCh >= 0) return firstOfCh;

  const idx = allChapters.findIndex(c => c.id === chapterId);
  for (let j = idx + 1; j < allChapters.length; j++) {
    const nextCid   = allChapters[j].id;
    const firstNext = full.findIndex(s => !s.isBaseStep && s.chapterId === nextCid);
    if (firstNext >= 0) return firstNext;
  }
  return full.length;
}

// ── Step card ────────────────────────────────────────────────────────────────

// V0.3.0.153 — 🔌 plug-action manager menu. Shows the step number + each cable
// action on the step (hover a row → ✕ Remove this action, which un-defines that
// state so it inherits the previous one). Plus 🗑 Delete this step. (Both, per
// the user's choice.) Driven by the 🔌 badge's right-click.
function _showPlugActionMenu(step, displayNumber, x, y) {
  const acts  = getStepCableActions(step.id);
  const items = [{ label: `Step ${displayNumber}`, disabled: true }, { separator: true }];
  if (!acts.length) {
    items.push({ label: '(no cable actions on this step)', disabled: true });
  } else {
    for (const a of acts) {
      const verb = a.action === 'plug' ? '🔌 Plug' : '⏏ Unplug';
      items.push({
        label:   `${a.cableName} · ${verb} · ${a.socketLabel} · State ${a.stateIndex}`,
        submenu: [
          { label: '✕ Remove this action', action: () => actions.removeCablePlugAction(a.cableId, step.id) },
        ],
      });
    }
  }
  items.push({ separator: true });
  items.push({ label: '🗑 Delete this step', action: () => _deleteStep(step.id) });
  showContextMenu(items, x, y);
}

function _buildStepCard(step, displayNumber, isActive, isExpanded, total, groupOpts = {}) {
  const isSelected = _selHas(step.id);
  const { isSubStep = false, isGroupHead = false, isGroupCollapsed = false } = groupOpts;
  const card = document.createElement('div');
  card.className = [
    'stepItem',
    isActive    ? 'active'     : '',
    isSelected  ? 'selected'   : '',
    step.hidden ? 'hiddenStep' : '',
    isSubStep   ? 'subStep'    : '',
    isGroupHead ? 'groupHead'  : '',
  ].filter(Boolean).join(' ');
  // Sub-steps are visually nested under their head — left-margin gives
  // the indent; the badge keeps showing the head's number per the
  // step-group spec ("all sub steps will use Step 4").
  if (isSubStep) {
    card.style.marginLeft = '16px';
  }
  // The amber group tint is applied via the .groupHead / .subStep CSS
  // rules in components.css (NOT inline) so that .selected / .active
  // can win on the cascade and the multi-select highlight reads the
  // same on a group member as on any other step.
  // draggable lives on the top-row only (set inside _buildStepTopCollapsed),
  // not on the whole card. With the whole card draggable, Chromium starts
  // an OS-level drag on mousedown of any inner <select> — dropdowns then
  // open and close as the user fights the drag. Restricting draggable to
  // the always-visible header (which doesn't host form controls) lets the
  // transition-row dropdowns work normally and still preserves drag-to-
  // reorder by grabbing the step's title row.
  card.dataset.stepId = step.id;
  card.style.marginBottom = '8px';

  // V0.3.0.152/153 — 🔌 marker for a step holding a cable plug/unplug action.
  // Absolutely positioned so it overlays the card WITHOUT changing the row height.
  // Right-click opens the plug-action manager (inspect + remove action / delete step).
  if (_plugActionStepIds.has(step.id)) {
    card.style.position = card.style.position || 'relative';
    const badge = document.createElement('div');
    badge.textContent = '🔌';
    badge.title = 'Cable plug / unplug action — right-click to manage';
    badge.style.cssText = 'position:absolute;top:0;right:0;font-size:11px;line-height:1;z-index:5;padding:2px 3px;cursor:context-menu;filter:drop-shadow(0 0 1px rgba(0,0,0,0.6));';
    badge.addEventListener('click', e => e.stopPropagation());            // don't activate the step
    badge.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();                            // own menu, not the step menu
      _showPlugActionMenu(step, displayNumber, e.clientX, e.clientY);
    });
    card.appendChild(badge);
  }

  // Top row identical in both states — except the thumbnail is hidden when
  // the card is expanded (per the original step-layout spec).
  card.appendChild(_buildStepTopCollapsed(step, displayNumber, !isExpanded, {
    isSubStep, isGroupHead, isGroupCollapsed,
  }));

  if (isExpanded) {
    card.appendChild(_buildStepActionRow(step));
    card.appendChild(_buildTransitionRow(step));
  }

  // Right-click: if step is part of a multi-selection, show the multi menu;
  // otherwise replace selection with this step and show the single menu.
  card.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    if (_selSize() > 1 && _selHas(step.id)) {
      _showMultiStepContextMenu(Array.from(_getSel()), e.clientX, e.clientY);
    } else {
      _setSel([step.id]);
      _showStepContextMenu(step, e.clientX, e.clientY);
    }
  });

  // Click semantics:
  //   Ctrl/Cmd-click → toggle in multi-selection (doesn't activate/expand)
  //   Shift-click    → extend selection to a range (visual order)
  //   plain click    → activate WITH animation; do NOT expand on first hit.
  //                    A second plain click on the SAME (already-active)
  //                    step expands it. Activating a different step
  //                    automatically collapses any previously expanded
  //                    card — only one tab can be open at a time and it
  //                    stays open until another step is single-clicked.
  card.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(_getSel());
      if (next.has(step.id)) next.delete(step.id);
      else                   next.add(step.id);
      _setSel(next);
      return;
    }
    if (e.shiftKey && _selSize()) {
      const all = (state.get('steps') || []).filter(s => !s.isBaseStep);
      const anchor = [..._getSel()].pop();
      const a = all.findIndex(s => s.id === anchor);
      const b = all.findIndex(s => s.id === step.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const next = new Set(_getSel());
        for (let i = lo; i <= hi; i++) next.add(all[i].id);
        _setSel(next);
      }
      return;
    }

    const wasActive = state.get('activeStepId') === step.id;
    if (wasActive && _expandedId !== step.id) {
      // Second click on the active step → expand it. Don't replay the
      // animation; the user already sees the final state.
      _expandedId = step.id;
      _setSel([step.id]);
      renderStepsPanel();
      return;
    }
    // New active step (or first click after a clear). Animate to it,
    // collapse whichever step was expanded — only one open tab at a
    // time. The expanded tab doesn't reopen until a SECOND click.
    _setSel([step.id]);
    _expandedId = null;
    steps.activateStep(step.id, true);
    renderStepsPanel();
  });

  // Middle-mouse → instant jump to the step's final state (no animation)
  // AND make it the sole selection (active + selected united), even out of
  // multi-select. Listen via mousedown because the middle button doesn't
  // fire a regular click in some browsers; preventDefault suppresses the
  // default scroll-anchor cursor on Chromium.
  card.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    steps.activateStep(step.id, false);
    actions.forceUniteStepSelection(step.id);
  });

  // Drag-and-drop
  card.addEventListener('dragstart', e => {
    // Native drag is initiated by Chromium when mousedown lands on a
    // [draggable=true] element — even when the original target is a
    // <select>, <input>, etc. inside it. That kills the dropdown
    // (mousedown opens drag, dropdown never opens). Cancel the drag
    // when it originated from a form control so dropdowns work.
    if (e.target.closest('select, input, button, textarea, option, label, [contenteditable="true"]')) {
      e.preventDefault();
      return;
    }
    _dragChapterId = null;
    // If the dragged step is part of a multi-selection, drag the whole set.
    if (_selHas(step.id) && _selSize() > 1) {
      _dragIds = Array.from(_getSel());
    } else {
      _dragIds = [step.id];            // single-step drag, leave selection untouched
    }
    // Step-groups: dragging a head pulls its sub-steps with it as one
    // unit. Per spec ("whole group as a unit, can't be dropped between
    // sub-steps"). The bundle is built in array order so the group
    // arrives at its destination intact. Sub-steps already in _dragIds
    // (e.g. via multi-select) aren't double-added.
    const stepsArr = state.get('steps') || [];
    const dragSet  = new Set(_dragIds);
    for (const id of [..._dragIds]) {
      const s = stepsArr.find(x => x.id === id);
      if (!s?.groupHead) continue;
      for (const sub of stepsArr) {
        if (sub.groupId === s.id && !dragSet.has(sub.id)) {
          dragSet.add(sub.id);
          _dragIds.push(sub.id);
        }
      }
    }
    _dragId = step.id;
    e.dataTransfer.effectAllowed = 'move';
    card.style.opacity = '0.5';
  });
  card.addEventListener('dragend', () => {
    _dragId  = null;
    _dragIds = [];
    _clearExpandTimer();
    _clearGroupExpandTimer();
    _removeDropSlot();
    _endDragExpand();
    _endDragGroupExpand();
    card.style.opacity = '';
  });

  // Per-card dragover / drop is intentionally NOT attached for step drags —
  // the list-level handler (see initStepsPanel) computes a single drop slot
  // position from the mouse Y relative to every card, so we never end up
  // with two competing "before/after" indicators on adjacent cards.

  return card;
}

// ── Step top rows ────────────────────────────────────────────────────────────

/** Expanded-step action row — the 5 buttons below the top thumbnail/name row. */
function _buildStepActionRow(step) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;';

  const btnCam    = _mkBtn('📷', 'Update camera for this step');
  const btnHide   = _mkBtn(step.hidden ? '🚫' : '👁', 'Toggle visibility in playback');
  const btnRename = _mkBtn('✎',  'Rename step');
  const btnDup    = _mkBtn('⧉',  'Duplicate step');
  const btnDel    = _mkBtn('🗑', 'Delete step');

  btnCam.addEventListener('click',    e => { e.stopPropagation(); actions.updateStepCameraFromCurrent(step.id); setStatus('Camera saved for step.'); });
  btnHide.addEventListener('click',   e => { e.stopPropagation(); actions.toggleStepsHidden([step.id]); });
  btnRename.addEventListener('click', e => { e.stopPropagation(); _renameStep(step.id); });
  btnDup.addEventListener('click',    e => { e.stopPropagation(); _duplicateStep(step.id); });
  btnDel.addEventListener('click',    e => { e.stopPropagation(); _deleteStep(step.id); });

  row.append(btnCam, btnHide, btnRename, btnDup, btnDel);
  return row;
}

/** Step top row: (optional) thumbnail + badge + name. No buttons. */
function _buildStepTopCollapsed(step, displayNumber, showThumb = true, groupOpts = {}) {
  const { isSubStep = false, isGroupHead = false, isGroupCollapsed = false } = groupOpts;
  const top = document.createElement('div');
  top.className = 'stepTop';
  // The top row IS the drag handle — see the long comment in _buildStepCard
  // for why draggable lives here instead of on the whole card. dragstart
  // bubbles up to the card's listener regardless.
  top.draggable = true;
  top.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:grab;';

  // Thumbnail — live preview of the viewport when this step is active.
  // Hidden while the card is expanded (full controls take precedence).
  // Falls back to an em-dash placeholder if no frame has been captured yet.
  // The thumbnail is wrapped so an eye-toggle button can overlay it
  // (revealed on hover, or always for hidden steps).
  let thumbWrap = null;
  if (showThumb) {
    thumbWrap = document.createElement('div');
    thumbWrap.className = 'stepThumbWrap';
    if (step.hidden) thumbWrap.classList.add('is-hidden');

    let thumb;
    if (step.thumbnail) {
      thumb = document.createElement('img');
      thumb.src = step.thumbnail;
      thumb.className = 'stepThumb';
      thumb.style.cssText = [
        'display:block',
        'width:72px',
        'height:48px',
        'object-fit:cover',
        'background:#000',
        'border:1px solid rgba(255,255,255,0.12)',
        'border-radius:4px',
      ].join(';');
    } else {
      thumb = document.createElement('div');
      thumb.className = 'stepThumb';
      thumb.style.cssText = [
        'width:72px',
        'height:48px',
        'background:rgba(255,255,255,0.06)',
        'border:1px solid rgba(255,255,255,0.08)',
        'border-radius:4px',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'font-size:10px',
        'color:rgba(255,255,255,0.3)',
      ].join(';');
      thumb.textContent = '—';
    }
    thumb.dataset.thumbStep = step.id;
    thumbWrap.appendChild(thumb);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'eyeToggle';
    eye.textContent = step.hidden ? '🚫' : '👁';
    eye.title = step.hidden ? 'Show in playback' : 'Hide from playback';
    // Stop click bubbling — the card's click handler activates+expands
    // and re-renders, which would race with our toggle action.
    eye.addEventListener('mousedown', e => e.stopPropagation());
    eye.addEventListener('click', e => {
      e.stopPropagation();
      _toggleStepHidden(step);
    });
    thumbWrap.appendChild(eye);
  }

  const badge = document.createElement('span');
  badge.className   = 'pill';
  badge.style.cssText = 'flex-shrink:0;font-weight:700;';
  // displayNumber is 1-based already (top-level position; head's number
  // for sub-steps). Sub-steps render the same number as their head per
  // the step-group spec.
  badge.textContent = String(displayNumber).padStart(2, '0');
  // Sub-steps get a faded badge — they share their head's number, but
  // the visual de-emphasis tells the user "this isn't a top-level step
  // on its own". Same number, lighter ink.
  if (isSubStep) badge.style.opacity = '0.55';

  const nameLbl = document.createElement('span');
  nameLbl.className   = 'stepName';
  nameLbl.style.flex  = '1';
  nameLbl.textContent = step.name || 'Unnamed Step';

  if (thumbWrap) top.appendChild(thumbWrap);
  top.append(badge, nameLbl);

  // Lock icon on group heads — same UX as chapter lock: 🔒 = always
  // expanded, 🔓 = collapses unless head/sub is active. Click toggles
  // groupLocked. Stop propagation so the row click (activate/expand)
  // doesn't fire.
  if (isGroupHead) {
    const btnLock = document.createElement('button');
    btnLock.type = 'button';
    btnLock.className = 'groupLockToggle';
    btnLock.textContent = step.groupLocked ? '🔒' : '🔓';
    btnLock.title = step.groupLocked
      ? 'Unlock (allow group to collapse)'
      : 'Lock group open';
    btnLock.style.cssText = [
      'flex-shrink:0',
      'background:transparent',
      'border:none',
      'padding:2px 4px',
      'font-size:14px',
      'cursor:pointer',
      `color:${step.groupLocked ? '#3b82f6' : '#94a3b8'}`,
      `opacity:${step.groupLocked ? '1' : '0.75'}`,
    ].join(';');
    btnLock.addEventListener('mousedown', e => e.stopPropagation());
    btnLock.addEventListener('click', e => {
      e.stopPropagation();
      actions.setGroupLocked(step.id, !step.groupLocked);
    });
    top.appendChild(btnLock);
    // Visual hint that this row owns sub-steps below: faint border line
    // along the bottom of the head row when expanded — keeps the eye
    // from treating the head + sub-steps as separate islands.
    if (!isGroupCollapsed) {
      top.style.borderBottom = '1px dashed rgba(148,163,184,0.35)';
      top.style.paddingBottom = '4px';
    }
  }

  return top;
}

/**
 * Toggle hidden state on a single step. If the step is part of a
 * multi-selection, applies the same toggle to every selected step
 * (using the right-click multi semantics: any-visible → hide all,
 * all-hidden → show all).
 */
// ── Chapter-level multi-step selection helpers ────────────────────────────
//
// These all just feed selectedStepIds (in global state). The eyeball /
// color / etc. actions don't care WHO populated the set — they just see
// "≥ 2 steps multi-selected, fan out the next edit across all of them".
// So adding chapter-aware selection here costs nothing on the action
// side.

function _chapterStepIds(chapterId) {
  return (state.get('steps') || [])
    .filter(s => !s.isBaseStep && s.chapterId === chapterId)
    .map(s => s.id);
}

/** REPLACE the multi-selection with every step of the chapter. */
function _selectChapterSteps(chapterId) {
  const ids = _chapterStepIds(chapterId);
  _setSel(ids);
  setStatus(`Selected ${ids.length} step(s) from chapter.`);
}

/** ADD every step of the chapter to the existing multi-selection. */
function _addChapterToSelection(chapterId) {
  const ids = _chapterStepIds(chapterId);
  const next = new Set(_getSel());
  ids.forEach(id => next.add(id));
  _setSel(next);
  setStatus(`Added ${ids.length} chapter step(s) to selection (${next.size} total).`);
}

/** REMOVE every step of the chapter from the existing multi-selection. */
function _removeChapterFromSelection(chapterId) {
  const ids = new Set(_chapterStepIds(chapterId));
  const next = new Set();
  for (const id of _getSel()) if (!ids.has(id)) next.add(id);
  _setSel(next);
  setStatus(`Removed chapter from selection (${next.size} step(s) remain).`);
}

/**
 * Ctrl/Cmd-click on a chapter header — toggles the WHOLE chapter in or
 * out of the multi-selection. If any of the chapter's steps are absent
 * from the current set, ADD them all; otherwise REMOVE them all.
 * Mirrors the per-step Ctrl-click semantic, scaled up to a chapter.
 */
function _toggleChapterInSelection(chapterId) {
  const ids = _chapterStepIds(chapterId);
  if (!ids.length) return;
  const cur = _getSel();
  const allIn = ids.every(id => cur.has(id));
  if (allIn) _removeChapterFromSelection(chapterId);
  else       _addChapterToSelection(chapterId);
}

/**
 * Shift-click on a chapter header — range-extend from the existing
 * anchor (last entry in the multi-selection) through this chapter's
 * last step. If no anchor exists, falls back to selecting the whole
 * chapter so the click still produces a meaningful change.
 */
function _extendSelectionThroughChapter(chapterId) {
  const all     = (state.get('steps') || []).filter(s => !s.isBaseStep);
  const idsHere = _chapterStepIds(chapterId);
  if (!idsHere.length) return;
  const anchor = [..._getSel()].pop();
  if (!anchor) {
    _selectChapterSteps(chapterId);
    return;
  }
  const a    = all.findIndex(s => s.id === anchor);
  const last = all.findIndex(s => s.id === idsHere[idsHere.length - 1]);
  if (a < 0 || last < 0) {
    _addChapterToSelection(chapterId);
    return;
  }
  const [lo, hi] = a < last ? [a, last] : [last, a];
  const next = new Set(_getSel());
  for (let i = lo; i <= hi; i++) next.add(all[i].id);
  _setSel(next);
}

/** Select every step (across all chapters). */
function _selectAllSteps() {
  const all = state.get('steps') || [];
  _setSel(new Set(all.map(s => s.id)));
}

/** Set selection to (all steps) ∖ (current selection). */
function _invertSelectedSteps() {
  const all = state.get('steps') || [];
  const cur = _getSel();
  const next = new Set();
  for (const s of all) if (!cur.has(s.id)) next.add(s.id);
  _setSel(next);
}

function _toggleStepHidden(step) {
  const inMulti = _selSize() > 1 && _selHas(step.id);
  if (inMulti) {
    const ids = Array.from(_getSel());
    actions.toggleStepsHidden(ids);
    setStatus(`Toggled visibility on ${ids.length} step(s).`);
  } else {
    actions.toggleStepsHidden([step.id]);
    setStatus(step.hidden ? 'Step shown.' : 'Step hidden.');
  }
}

// ── Step context menu (right-click on collapsed card) ───────────────────────

function _showStepContextMenu(step, x, y) {
  const allSteps = state.get('steps') || [];
  const inChapterIds = step.chapterId
    ? allSteps.filter(s => s.chapterId === step.chapterId).map(s => s.id)
    : [];
  const curSelSize = _selSize();
  const items = [
    { label: `☑ Select all steps & chapters (${allSteps.length})`,
      disabled: allSteps.length === 0,
      action:   () => _selectAllSteps() },
    { label: `☑ Select all steps in chapter (${inChapterIds.length})`,
      disabled: inChapterIds.length === 0,
      action:   () => _selectChapterSteps(step.chapterId) },
    { label: `⇄ Invert selected (${curSelSize} → ${Math.max(0, allSteps.length - curSelSize)})`,
      disabled: allSteps.length === 0,
      action:   () => _invertSelectedSteps() },
    { separator: true },
    { label: '✏ Rename…',   action: () => _renameStep(step.id) },
    { label: '🔢 Auto-name all (by chapter)', action: () => {
        const res = actions.autoNameStepsByChapter();
        if (res?.ok) setStatus(`Renamed ${res.count} step${res.count === 1 ? '' : 's'} → C{chapter}-{n}.`, 'success', 3000);
        else setStatus(`Couldn’t auto-name: ${res?.error || 'unknown'}.`, 'warn', 2500);
      } },
    { label: '📝 Auto-name all (from narration)', action: () => {
        const res = actions.autoNameStepsFromNarration();
        if (res?.ok) setStatus(`Named ${res.count} step${res.count === 1 ? '' : 's'} from narration (${res.named} narrated, rest carried forward).`, 'success', 3500);
        else setStatus(`Couldn’t auto-name: ${res?.error || 'unknown'}.`, 'warn', 2500);
      } },
    { label: '⎘ Duplicate', action: () => _duplicateStep(step.id) },
    { label: '📋 Copy',     action: () => _copyStepsToClipboard([step.id]) },
  ];
  if (_clipboard?.kind === 'steps') {
    items.push({ label: `📥 Paste under (${_clipboard.data.length})`, action: () => _pasteStepsUnder(step.id) });
  }
  // "Update camera as template" is only meaningful when the active step
  // is bound to a template — that's the template the action targets.
  // When the active step is free, the option still shows but disabled,
  // so the menu doesn't lie about what's possible.
  const activeTplLabel = _activeStepTemplateName();
  items.push(
    { label: step.hidden ? '👁 Show in playback' : '🚫 Hide from playback',
      action: () => actions.toggleStepsHidden([step.id]) },
    { label: '📷 Update step camera',
      action: () => { actions.updateStepCameraFromCurrent(step.id); setStatus('Camera saved for step.'); } },
    { label: activeTplLabel
        ? `📷🔗 Update template "${activeTplLabel}"`
        : '📷🔗 Update template (none bound to step)',
      disabled: !activeTplLabel,
      action: () => {
        actions.updateStepCameraAsTemplate([step.id]);
        setStatus(`Updated template "${activeTplLabel}" + bound step.`);
      } },
    { separator: true },
  );
  // Step-group entries (Phase B/G of "step groups"). The action labels
  // mirror what the user sees: a normal step can be CONVERTED to a
  // group; a head can be UNGROUPED (releasing any sub-steps it carries
  // back to top-level). Sub-steps don't get either entry — they have to
  // be promoted via drag-out, so the menu doesn't offer ambiguous paths.
  if (step.groupHead) {
    items.push({
      label: '⊟ Ungroup step',
      action: () => actions.ungroupStep(step.id),
    });
  } else if (!step.groupId) {
    items.push({
      label: '⊞ Convert to step group',
      action: () => actions.convertStepToGroup(step.id),
    });
  }
  items.push(
    { separator: true },
    { label: '🗑 Delete',    action: () => _deleteStep(step.id) },
  );
  showContextMenu(items, x, y);
}

/**
 * Returns the name of the template the active step is bound to, or null
 * if it's a free-camera step (or no active step). Used to label the
 * "Update camera (as template)" menu items so the user can see at a
 * glance which template would be edited.
 */
function _activeStepTemplateName() {
  const stepsArr = state.get('steps') || [];
  const activeId = state.get('activeStepId');
  if (!activeId) return null;
  const active = stepsArr.find(s => s.id === activeId);
  if (active?.cameraBinding?.mode !== 'template') return null;
  const tpl = (state.get('cameraViews') || []).find(v => v.id === active.cameraBinding.templateId);
  return tpl?.name || null;
}

/**
 * Right-click menu for a multi-selection. Rename + Duplicate are omitted —
 * they only make sense on a single step. Copy applies to the whole set.
 */
function _showMultiStepContextMenu(stepIds, x, y) {
  const stepsArr   = state.get('steps') || [];
  const selSteps   = stepIds.map(id => stepsArr.find(s => s.id === id)).filter(Boolean);
  const anyVisible = selSteps.some(s => !s.hidden);

  const activeTplLabel = _activeStepTemplateName();
  showContextMenu([
    { label: `☑ Select all steps & chapters (${stepsArr.length})`,
      disabled: stepsArr.length === 0,
      action:   () => _selectAllSteps() },
    { label: `⇄ Invert selected (${stepIds.length} → ${Math.max(0, stepsArr.length - stepIds.length)})`,
      disabled: stepsArr.length === 0,
      action:   () => _invertSelectedSteps() },
    { separator: true },
    { label: `📋 Copy (${selSteps.length})`,
      action: () => _copyStepsToClipboard(stepIds) },
    { label: anyVisible ? '🚫 Hide from playback' : '👁 Show in playback',
      action: () => actions.toggleStepsHidden(selSteps.map(s => s.id)) },
    { label: '📷 Update step camera',
      action: () => { actions.updateStepCameraFromCurrentMulti(selSteps.map(s => s.id)); setStatus(`Camera saved for ${selSteps.length} steps.`); } },
    { label: activeTplLabel
        ? `📷🔗 Update template "${activeTplLabel}"`
        : '📷🔗 Update template (none bound to step)',
      disabled: !activeTplLabel,
      action: () => {
        actions.updateStepCameraAsTemplate(selSteps.map(s => s.id));
        setStatus(`Updated template "${activeTplLabel}" + bound ${selSteps.length} step(s).`);
      } },
    { separator: true },
    { label: `🗑 Delete (${selSteps.length})`,
      action: async () => {
        const ok = await _confirmDialog(`Delete ${selSteps.length} steps?`);
        if (!ok) return;
        for (const s of selSteps) actions.deleteStep(s.id);
        _selClear();
      } },
  ], x, y);
}

/** Right-click on a chapter header — copy / paste operate on the whole chapter block. */
function _showChapterContextMenu(chapter, x, y) {
  const chapterIds = _chapterStepIds(chapter.id);
  const cur        = _getSel();
  const overlap    = chapterIds.filter(id => cur.has(id)).length;

  const items = [
    { label: `☑ Select all steps in chapter (${chapterIds.length})`,
      disabled: chapterIds.length === 0,
      action:   () => _selectChapterSteps(chapter.id) },
    { label: `＋ Add chapter to step selection (+${chapterIds.length})`,
      disabled: chapterIds.length === 0,
      action:   () => _addChapterToSelection(chapter.id) },
    { label: `✕ Remove chapter from step selection (−${overlap})`,
      disabled: overlap === 0,
      action:   () => _removeChapterFromSelection(chapter.id) },
    { separator: true },
    { label: '✏ Rename…', action: () => _renameChapter(chapter.id) },
    { label: '📋 Copy',   action: () => _copyChapterToClipboard(chapter.id) },
  ];
  if (_clipboard?.kind === 'chapter') {
    items.push({ label: '📥 Paste under', action: () => _pasteChapterUnder(chapter.id) });
  }
  if (_clipboard?.kind === 'steps') {
    items.push({ label: `📥 Paste steps into chapter (${_clipboard.data.length})`,
                 action: () => _pasteStepsIntoChapter(chapter.id) });
  }
  items.push(
    { separator: true },
    { label: chapter.locked ? '🔓 Unlock' : '🔒 Lock open',
      action: () => actions.setChapterLocked(chapter.id, !chapter.locked) },
    { label: '🗑 Delete', action: () => _deleteChapter(chapter.id) },
  );
  showContextMenu(items, x, y);
}

// ── Copy / paste clipboard operations ──────────────────────────────────────

function _cloneStep(step) {
  const copy = cloneShareStrings(step);   // shares the big base64 strings; structure is independent
  copy.id = generateId('step');
  return copy;
}

function _copyStepsToClipboard(stepIds) {
  const all = state.get('steps') || [];
  const picked = stepIds
    .map(id => all.find(s => s.id === id))
    .filter(Boolean)
    .sort((a, b) => all.indexOf(a) - all.indexOf(b));   // preserve visual order
  if (!picked.length) return;
  _clipboard = { kind: 'steps', data: cloneShareStrings(picked) };   // share base64, don't duplicate
  setStatus(`Copied ${picked.length} step(s).`);
}

function _pasteStepsUnder(targetStepId) {
  if (_clipboard?.kind !== 'steps') return;
  const all     = state.get('steps') || [];
  const tgtIdx  = all.findIndex(s => s.id === targetStepId);
  if (tgtIdx < 0) return;
  const target  = all[tgtIdx];
  const pasted  = _clipboard.data.map(s => {
    const copy = _cloneStep(s);
    copy.chapterId = target.chapterId ?? null;
    return copy;
  });
  const newAll = [...all.slice(0, tgtIdx + 1), ...pasted, ...all.slice(tgtIdx + 1)];
  actions.commitStateChange(`Paste ${pasted.length} step(s)`, ['steps'], () => {
    state.setState({ steps: newAll });
    steps.normalizeOrder();
    state.markDirty();
  });
  setStatus(`Pasted ${pasted.length} step(s).`);
}

function _pasteStepsIntoChapter(chapterId) {
  if (_clipboard?.kind !== 'steps') return;
  const all    = state.get('steps') || [];
  const pasted = _clipboard.data.map(s => {
    const copy = _cloneStep(s);
    copy.chapterId = chapterId;
    return copy;
  });
  // Append at end of chapter (normalizeOrder will regroup regardless).
  actions.commitStateChange(`Paste ${pasted.length} step(s) into chapter`, ['steps'], () => {
    state.setState({ steps: [...all, ...pasted] });
    steps.normalizeOrder();
    state.markDirty();
  });
  setStatus(`Pasted ${pasted.length} step(s) into chapter.`);
}

function _copyChapterToClipboard(chapterId) {
  const chapters = state.get('chapters') || [];
  const chapter  = chapters.find(c => c.id === chapterId);
  if (!chapter) return;
  const chSteps  = (state.get('steps') || []).filter(s => s.chapterId === chapterId);
  _clipboard = {
    kind: 'chapter',
    data: {
      chapter: JSON.parse(JSON.stringify(chapter)),
      steps:   JSON.parse(JSON.stringify(chSteps)),
    },
  };
  setStatus(`Copied chapter "${chapter.name}" (${chSteps.length} step(s)).`);
}

function _pasteChapterUnder(targetChapterId) {
  if (_clipboard?.kind !== 'chapter') return;
  const { chapter: chTpl, steps: stepTpls } = _clipboard.data;

  // New chapter with fresh id + name suffix to disambiguate.
  const newChapter = { ...JSON.parse(JSON.stringify(chTpl)),
                       id: generateId('chapter'),
                       name: (chTpl.name || 'Chapter') + ' (copy)' };

  const chapters = state.get('chapters') || [];
  const tgtIdx   = chapters.findIndex(c => c.id === targetChapterId);
  const insertAt = tgtIdx >= 0 ? tgtIdx + 1 : chapters.length;
  const newChapters = [...chapters.slice(0, insertAt), newChapter, ...chapters.slice(insertAt)];

  const pastedSteps = stepTpls.map(s => {
    const copy = _cloneStep(s);
    copy.chapterId = newChapter.id;
    return copy;
  });
  const newSteps = [...(state.get('steps') || []), ...pastedSteps];

  actions.commitStateChange(`Paste chapter "${newChapter.name}"`, ['steps', 'chapters'], () => {
    state.setState({ chapters: newChapters, steps: newSteps });
    steps.normalizeOrder();
    state.markDirty();
  });
  setStatus(`Pasted chapter "${newChapter.name}" with ${pastedSteps.length} step(s).`);
}

// ── Per-step narration (voice & speed are project-level, set in Export tab) ───

let _voiceCache = null;
export function resetVoiceCache() { _voiceCache = null; }
async function _voices() {
  if (_voiceCache) return _voiceCache;
  _voiceCache = await ttsListVoices();
  return _voiceCache;
}

/**
 * Synthesize (if needed) and play a step's narration using the project-
 * level voice + speed. Cache hit → instant playback. Cache miss → play a
 * fast OS-voice "placeholder" immediately AND kick the real synth into the
 * background; the next click hits the real voice.
 *
 * Synth de-dup: a Map keyed by stepId+text+voice+speed prevents queueing
 * the same job twice. Clicking ▶ during a pending synth just attaches to
 * the existing promise.
 */
const _pendingSynths = new Map();   // dedupKey → Promise<{dataUrl, durationMs, mime}>

function _ensureSynth(stepId, text, voiceId, speed) {
  const key = `${stepId}|${voiceId}|${speed}|${text}`;
  const cacheHit = _pendingSynths.has(key);
  console.log(`[tts-flow] ensureSynth len=${text.length} cacheHit=${cacheHit}`);   // cacheHit=true on a stick = poisoned key
  if (cacheHit) return _pendingSynths.get(key);
  const p = ttsSynthesize(text, voiceId, { speed });
  _pendingSynths.set(key, p);
  p.then(
    (o) => console.log(`[tts-flow] synth OK len=${text.length} dur=${o?.durationMs}ms`),
    (e) => console.log(`[tts-flow] synth REJECT len=${text.length}: ${e?.message}`),
  );
  p.finally(() => { if (_pendingSynths.get(key) === p) _pendingSynths.delete(key); });
  // Safety net: a synth that WEDGES and never settles would otherwise poison this
  // key forever — every later ▶ on the same step+text returns the dead promise so
  // "the real voice never generates" until you change the text or duplicate the
  // step (both mint a new key). Evict after 30s so the next click starts fresh.
  setTimeout(() => { if (_pendingSynths.get(key) === p) _pendingSynths.delete(key); }, 30_000);
  return p;
}

/** Drop all in-flight synth de-dup entries — unsticks a step whose real-voice
 *  synth wedged, WITHOUT duplicating it. Returns the count cleared. Exposed as
 *  window.sbsTTS.clearPending(). */
export function clearPendingSynths() {
  const n = _pendingSynths.size;
  _pendingSynths.clear();
  return n;
}

let _voiceListCachedPromise = null;
async function _pickFallbackVoice(preferLang) {
  if (!_voiceListCachedPromise) _voiceListCachedPromise = ttsListVoices().catch(() => []);
  const list = await _voiceListCachedPromise;
  // Prefer fast OS voices (sapi5 first — they synthesize in tens of ms,
  // OneCore is also fast). Match the project language if we can.
  const sapi    = list.filter(v => v.source === 'sapi5');
  const oneCore = list.filter(v => v.source === 'onecore');
  const candidates = [...sapi, ...oneCore];
  if (preferLang) {
    const pref = preferLang.toLowerCase();
    const langMatch = candidates.find(v => (v.lang || '').toLowerCase().includes(pref));
    if (langMatch) return langMatch.id;
  }
  return candidates[0]?.id || null;
}

export async function previewStepNarration(step, currentText) {
  if (!step) return;
  const text = (currentText ?? step.narration?.text ?? '').trim();
  if (!text) { setStatus('Nothing to narrate.', 'warning'); return; }

  const exp     = state.get('export') || {};
  const voiceId = exp.narrationVoice;
  const speed   = Number(exp.narrationSpeed) || 1.0;
  if (!voiceId) { setStatus('Pick a voice in the Export tab first.', 'warning'); return; }

  // Cache fresh? Play immediately. "Fresh" means same text/voice/speed AND
  // we have *something* playable — either inline dataUrl or a disk file we
  // can lazy-load.
  const n = step.narration || {};
  const matches = (n.text || '').trim() === text && n.voiceId === voiceId && n.speed === speed;
  const fresh   = matches && (n.dataUrl || n.dataFile);
  if (fresh) {
    const url = await narrationCache.ensurePlayable(step);
    if (url) {
      _playClip(url);
      setStatus(`Clip · ${(n.durationMs / 1000 || 0).toFixed(1)}s`);
      return;
    }
    // Disk read failed — fall through to re-synth.
    console.warn('[tts] cached dataFile unreadable, re-synthesizing');
  }

  // Cache miss — fire the real synth in the background (de-duped) AND play
  // a fast OS-voice placeholder immediately. We DO NOT promote the job to
  // the front of the worker queue; user wanted "snappy feedback now, real
  // voice later" rather than "make this one preview jump the line".
  const realSynth = _ensureSynth(step.id, text, voiceId, speed);
  realSynth.then(async out => {
    // guardMatch=false → the saved narration.text differs from what we synthesized
    // (paste-vs-save mismatch) → result discarded, "real voice never appears".
    const guardMatch = (step.narration?.text ?? '').trim() === text;
    console.log(`[tts-flow] realSynth resolved guardMatch=${guardMatch} savedLen=${(step.narration?.text || '').length} synthLen=${text.length}`);
    if (!guardMatch) return;
    // Try to write the WAV to the project's audio cache folder. If caching
    // is disabled OR the voice is OS-fast (synth is already cheap), dataFile
    // stays undefined and we fall back to inline dataUrl in the project file.
    const dataFile = await narrationCache.saveClipToDisk({
      text, voiceId, speed,
      dataUrl:  out.dataUrl,
      stepName: step.name,
      stepId:   step.id,
    }).catch(() => null);
    step.narration = { text, voiceId, speed, ...out };
    if (dataFile) step.narration.dataFile = dataFile;
    state.markDirty();
    setStatus(`Real voice ready (${(out.durationMs / 1000).toFixed(1)}s) — click ▶ to hear it.`);
  }).catch(err => {
    console.warn('[tts] background synth:', err?.message);
    // Clear the sticky "Synthesizing…" status so a failed/timed-out real synth
    // doesn't leave it spinning forever (the placeholder already played).
    setStatus(`Real voice unavailable (${err?.message || 'synth error'}) — placeholder used.`, 'warning', 5000);
  });

  // Placeholder via fast OS voice. If we can't find one, just status the
  // user and skip — better silence than crashing.
  setStatus('Synthesizing real voice — placeholder playing…', 'info', 0);
  const fallback = await _pickFallbackVoice(_userPrefLang());
  if (!fallback) { setStatus('Synthesizing… (no fallback voice available)', 'info', 0); return; }
  try {
    const out = await ttsSynthesize(text, fallback, { speed });
    _playClip(out.dataUrl);
  } catch (err) {
    console.warn('[tts] fallback failed:', err?.message);
  }
}

function _playClip(dataUrl) {
  if (_narrationAudio) { try { _narrationAudio.pause(); } catch {} }
  _narrationAudio = new Audio(dataUrl);
  _narrationAudio.play().catch(err => setStatus(`Play failed: ${err.message}`, 'danger'));
}

function _userPrefLang() {
  // Reads from user-settings cache. Returns '' if module not yet initialised
  // (initUserSettings runs at boot in main.js, so by the time the user clicks
  // ▶ on a step the cache is hot).
  try {
    return userSettings.get()?.ui?.preferredLanguages?.[0] || '';
  } catch { return ''; }
}

// ── Transition row ────────────────────────────────────────────────────────────

function _buildTransitionRow(step) {
  const t           = step.transition || {};
  const stepId      = step.id;
  const animPresets = state.get('animationPresets') || [];
  const cameraTpls  = state.get('cameraViews') || [];
  const stepPresetId   = t.animPresetId ?? null;
  const defaultPreset  = animPresets.find(p => p.isDefault);

  // cameraBinding may be missing on legacy in-memory steps that pre-date
  // the migration (project.js seeds it for loaded steps; new steps default
  // it via createStep). Defensive default keeps the dropdown sane.
  const cb            = step.cameraBinding || { mode: 'free', templateId: null };
  const boundTplId    = cb.mode === 'template' ? cb.templateId : null;

  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.style.cssText = 'margin-top:6px;font-size:12px;display:flex;flex-direction:column;gap:6px;';

  // Animation preset dropdown (no title / no description). V0.1.98 adds a
  // PRIVATE option: a per-step custom animation edited in a popup. The
  // '__private__' sentinel in animPresetId means the step uses its own
  // transition.privateAnimation string (kept in record even when a named
  // preset is later picked).
  const isPrivate  = stepPresetId === '__private__';
  const hasPrivate = isPrivate || !!(t.privateAnimation && t.privateAnimation.trim());
  const presetOptions = [
    `<option value="" ${!stepPresetId ? 'selected' : ''}>Default${defaultPreset ? ` (${_escStep(defaultPreset.name)})` : ''}</option>`,
    ...animPresets.map(p =>
      `<option value="${_escStep(p.id)}" ${stepPresetId === p.id ? 'selected' : ''}>${_escStep(p.name)}</option>`
    ),
    `<option value="__private__" ${isPrivate ? 'selected' : ''}>${hasPrivate ? '✎ Edit private animation' : '✎ Private animation…'}</option>`,
  ].join('');

  // Camera-binding dropdown — first option is always [Free camera],
  // followed by every named template. "Free" means the step uses its
  // own snapshot.camera (today's behaviour, unchanged for legacy steps).
  // Picking a template makes this step pull its camera from the template
  // at activation time — so editing the template in the Camera tab moves
  // every bound step in lock-step.
  const cameraOptions = [
    `<option value="" ${!boundTplId ? 'selected' : ''}>[Free camera]</option>`,
    ...cameraTpls.map(v =>
      `<option value="${_escStep(v.id)}" ${boundTplId === v.id ? 'selected' : ''}>${_escStep(v.name)}</option>`
    ),
  ].join('');

  // Easing dropdowns (no titles)
  const easingOptions = cur => ['smooth','linear','instant']
    .map(v => `<option value="${v}" ${(cur ?? 'smooth') === v ? 'selected' : ''}>${v[0].toUpperCase()+v.slice(1)}</option>`)
    .join('');

  wrap.innerHTML = `
    <select class="tran-cam-binding" title="Step camera. Free = uses this step's own snapshot. Template = follows a named camera that propagates updates to every step bound to it.">${cameraOptions}</select>
    <div style="display:flex;gap:4px;align-items:center">
      <select class="tran-anim-preset" style="flex:1">${presetOptions}</select>
      ${isPrivate ? `<button class="btn tran-anim-edit" title="Edit this step's private animation" style="flex-shrink:0;padding:2px 9px">✎</button>` : ''}
    </div>
    <div class="grid2">
      <select class="tran-cam-ease">${easingOptions(t.cameraEasing)}</select>
      <select class="tran-obj-ease">${easingOptions(t.objectEasing)}</select>
    </div>
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox" class="tran-fade" ${t.visibilityFade !== false ? 'checked' : ''} />
      <span class="small muted">Fade visibility changes</span>
    </label>
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;" title="When an object changes folders but barely moves, hold it still instead of letting it swing through a big arc.">
      <input type="checkbox" class="tran-reparent" ${t.reparentArc !== false ? 'checked' : ''} />
      <span class="small muted">Smooth reparent jumps</span>
      <input type="number" class="tran-reparent-thr" min="0" step="1" value="${t.reparentArcThreshold ?? 10}"
             title="Hold the object still if its visual centre moves less than this many units when it changes folders."
             style="width:48px;margin-left:auto" />
    </label>
  `;

  // Form controls are inside a step card whose root <div> has its own
  // click handler that activates+expands the step and re-renders the
  // entire panel. A click on a <select> or <input> normally bubbles up
  // and triggers that re-render mid-pick — destroying the dropdown's
  // DOM and making it look "nonresponsive". Stop click + pointer
  // events at every control so the card's handlers never fire from
  // form interactions. (The earlier draggable=true issue is also
  // covered: even though the lower rows are no longer descendants of
  // a draggable element, future-proof the guard for any new control
  // anywhere in the card.)
  for (const ctrl of wrap.querySelectorAll('select, input, label, button')) {
    ctrl.addEventListener('click',       e => e.stopPropagation());
    ctrl.addEventListener('dblclick',    e => e.stopPropagation());
    ctrl.addEventListener('mousedown',   e => e.stopPropagation());
    ctrl.addEventListener('pointerdown', e => e.stopPropagation());
    ctrl.draggable = false;
  }

  wrap.querySelector('.tran-cam-binding').addEventListener('change', e => {
    actions.setStepCameraBinding(stepId, e.target.value || null);
  });
  wrap.querySelector('.tran-anim-preset')?.addEventListener('change', e => {
    const v = e.target.value;
    if (v === '__private__') {
      // Enter private mode + pop the editor. Re-editing later uses the ✎
      // button (re-selecting the already-selected option fires no change).
      openPrivateAnimationEditor(stepId);
    } else {
      // Switching to a named preset / Default keeps any privateAnimation
      // string in record (we only patch animPresetId).
      actions.updateTransition(stepId, { animPresetId: v || null });
    }
  });
  wrap.querySelector('.tran-anim-edit')?.addEventListener('click', e => {
    e.stopPropagation();
    openPrivateAnimationEditor(stepId);
  });
  wrap.querySelector('.tran-cam-ease').addEventListener('change', e => {
    actions.updateTransition(stepId, { cameraEasing: e.target.value });
  });
  wrap.querySelector('.tran-obj-ease').addEventListener('change', e => {
    actions.updateTransition(stepId, { objectEasing: e.target.value });
  });
  wrap.querySelector('.tran-fade').addEventListener('change', e => {
    actions.updateTransition(stepId, { visibilityFade: e.target.checked });
  });
  wrap.querySelector('.tran-reparent').addEventListener('change', e => {
    actions.updateTransition(stepId, { reparentArc: e.target.checked });
  });
  wrap.querySelector('.tran-reparent-thr').addEventListener('change', e => {
    const n = Math.max(0, parseFloat(e.target.value));
    actions.updateTransition(stepId, { reparentArcThreshold: Number.isFinite(n) ? n : 10 });
  });

  return wrap;
}

function _escStep(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ── Chapter actions ──────────────────────────────────────────────────────────

async function _onAddChapter() {
  const name = await _promptString('Chapter name:', 'Chapter');
  if (!name) return;
  const chapter = createChapter({ name });
  actions.commitStateChange(`Create chapter "${chapter.name}"`, ['chapters'], () => {
    state.setState({ chapters: [...(state.get('chapters') || []), chapter] });
    state.markDirty();
  });
  setStatus(`Created chapter "${chapter.name}".`);
  state.setState({ _pendingChapterId: chapter.id });
}

async function _renameChapter(chapterId) {
  const chapters = state.get('chapters') || [];
  const chapter  = chapters.find(c => c.id === chapterId);
  if (!chapter) return;
  const name = await _promptString('Chapter name:', chapter.name || '');
  if (!name) return;
  actions.commitStateChange('Rename chapter', ['chapters'], () => {
    state.setState({ chapters: (state.get('chapters') || []).map(c => c.id === chapterId ? { ...c, name } : c) });
    state.markDirty();
  });
}

async function _deleteChapter(chapterId) {
  const chapters = state.get('chapters') || [];
  const chapter  = chapters.find(c => c.id === chapterId);
  if (!chapter) return;

  const allSteps  = state.get('steps') || [];
  const stepsIn   = allSteps.filter(s => s.chapterId === chapterId);
  const msg = stepsIn.length > 0
    ? `Delete chapter "${chapter.name}"?\n\nThis will also delete ${stepsIn.length} step(s) inside it.`
    : `Delete chapter "${chapter.name}"?`;
  const ok = await _confirmDialog(msg);
  if (!ok) return;

  actions.commitStateChange(`Delete chapter "${chapter.name}"`, ['steps', 'chapters'], () => {
    const all = state.get('steps') || [];
    state.setState({
      steps:    all.filter(s => s.chapterId !== chapterId),
      chapters: (state.get('chapters') || []).filter(c => c.id !== chapterId),
    });
    steps.normalizeOrder();
    state.markDirty();
  });
  setStatus(stepsIn.length > 0
    ? `Deleted chapter "${chapter.name}" and ${stepsIn.length} step(s).`
    : `Deleted chapter "${chapter.name}".`);
}

// ── Step actions ─────────────────────────────────────────────────────────────

async function _onAddStep() {
  await steps.flushSync();
  const all = state.get('steps') || [];

  // Empty project — make a blank first step (into the just-made chapter if any).
  if (!all.length) {
    const chapterId = state.get('_pendingChapterId') ?? null;
    const step = actions.createStep('New Step', { chapterId });
    if (chapterId) state.setState({ _pendingChapterId: null });
    setStatus(`Created step "${step.name}".`);
    return;
  }

  // V0.3.0.174 — "New step" now DUPLICATES the LAST step (no selection needed),
  // so you can be anywhere. If the last step's chapter is followed by an EMPTY
  // chapter, the copy lands as that chapter's first step; otherwise it lands right
  // after the last step.
  const lastStep = all[all.length - 1];
  const chapters = state.get('chapters') || [];
  let emptyChapter = null;
  const chIdx = chapters.findIndex(c => c.id === lastStep.chapterId);
  if (chIdx >= 0) {
    for (let i = chIdx + 1; i < chapters.length; i++) {
      if (!all.some(s => s.chapterId === chapters[i].id)) { emptyChapter = chapters[i]; break; }
    }
  }

  const copy = actions.duplicateStep(lastStep.id);   // copy lands right after lastStep
  if (copy && emptyChapter) {
    // Re-home the copy into the trailing empty chapter (mutate in place so
    // duplicateStep's undo/redo, which captured this ref, stays consistent).
    copy.chapterId = emptyChapter.id;
    state.setState({ steps: [...(state.get('steps') || [])] });
    state.markDirty();
  }
  if (state.get('_pendingChapterId')) state.setState({ _pendingChapterId: null });
  if (copy) setStatus(`New step — copy of "${lastStep.name}"${emptyChapter ? ` → "${emptyChapter.name}"` : ''}.`);
}

// ── Video export ────────────────────────────────────────────────────────────
let _exportingCtrl = null;   // AbortController, null when idle

async function _onExportVideo() {
  const btn = document.getElementById('btn-export-video');
  if (_exportingCtrl) {
    _exportingCtrl.abort();
    return;
  }
  _exportingCtrl = new AbortController();
  const origText = btn.textContent;
  btn.textContent = '■ Cancel export';

  const exp         = state.get('export') || {};
  const projectName = exp.fileName || state.get('projectName') || 'timeline';
  const stamp       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  try {
    await steps.flushSync();
    const { blob, extension } = await exportTimelineVideo({
      format:      exp.outputFormat || 'mp4',
      fps:         Number(exp.fps) || 30,
      stepHoldMs:  Number(exp.stepHoldMs) || 400,
      offline:     exp.offlineRender !== false,   // was missing → always ran realtime
      signal:      _exportingCtrl.signal,
      onProgress:  ({ current, total, stepName }) => {
        setStatus(`Exporting ${current}/${total}: ${stepName}…`, 'info', 0);
      },
    });
    downloadBlob(blob, `${projectName}-${stamp}.${extension}`);
    setStatus(`Exported ${(blob.size / 1e6).toFixed(1)} MB as ${extension.toUpperCase()}.`);
  } catch (err) {
    if (err?.name === 'AbortError') setStatus('Export cancelled.', 'warning');
    else {
      console.error('Export failed:', err);
      setStatus(`Export failed: ${err.message}`, 'danger');
    }
  } finally {
    _exportingCtrl = null;
    btn.textContent = origText;
  }
}

/**
 * Export the timeline as a .sbsproc — a single self-contained binary
 * (12-byte header + manifest JSON + MP4 bytes) that the SBS viewer
 * reads. Step-groups collapse to one viewer-step in the manifest;
 * sub-steps land in `sub_steps` so the viewer can show them as a
 * timeline within the group if it wants.
 */
async function _onExportSbsProc() {
  const btn = document.getElementById('btn-export-sbsproc');
  if (_exportingCtrl) {
    _exportingCtrl.abort();
    return;
  }
  _exportingCtrl = new AbortController();
  const origText = btn ? btn.textContent : '';
  if (btn) btn.textContent = '■ Cancel export';

  const exp         = state.get('export') || {};
  const projectName = exp.fileName || state.get('projectName') || 'process';
  const stamp       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  try {
    await steps.flushSync();
    const { blob, extension, manifest, totalDurationMs } = await exportTimelineSbsProc({
      fps:        Number(exp.fps) || 30,
      stepHoldMs: Number(exp.stepHoldMs) || 400,
      // Offline render is the deterministic path — every animation phase
      // advances on a synthetic clock so audio/video alignment is exact
      // regardless of host throttling. Mirror the regular video-export
      // setting so the .sbsproc button respects the same Export-tab
      // checkbox the user already configured.
      offline:    exp.offlineRender !== false,   // default ON (match Export tab)
      signal:     _exportingCtrl.signal,
      onProgress: ({ current, total, stepName }) => {
        setStatus(`Exporting ${current}/${total}: ${stepName}…`, 'info', 0);
      },
    });
    downloadBlob(blob, `${projectName}-${stamp}.${extension}`);
    const stepCount = manifest?.steps?.length ?? 0;
    setStatus(`Exported ${(blob.size / 1e6).toFixed(1)} MB .sbsproc · ${stepCount} viewer-step(s) · ${(totalDurationMs / 1000).toFixed(1)}s.`);
  } catch (err) {
    if (err?.name === 'AbortError') setStatus('Export cancelled.', 'warning');
    else {
      console.error('.sbsproc export failed:', err);
      setStatus(`.sbsproc export failed: ${err.message}`, 'danger');
    }
  } finally {
    _exportingCtrl = null;
    if (btn) btn.textContent = origText;
  }
}

async function _renameStep(stepId) {
  const step = steps.getStepById(stepId);
  if (!step) return;
  const name = await _promptString('Step name:', step.name || '');
  if (name) actions.renameStep(stepId, name);
}

function _duplicateStep(stepId) {
  // flushSync is synchronous (returns undefined), so don't .then() it —
  // that's what was throwing "Cannot read properties of undefined".
  steps.flushSync();
  const copy = actions.duplicateStep(stepId);
  if (copy) setStatus(`Duplicated "${copy.name}".`);
}

async function _deleteStep(stepId) {
  const step = steps.getStepById(stepId);
  if (!step) return;
  const ok = await _confirmDialog(`Delete step "${step.name}"?`);
  if (!ok) return;
  actions.deleteStep(stepId);
  setStatus(`Deleted step "${step.name}".`);
}

// ── Util ─────────────────────────────────────────────────────────────────────

function _mkBtn(text, title) {
  const btn = document.createElement('button');
  btn.className   = 'miniToggle';
  btn.title       = title;
  btn.textContent = text;
  btn.style.fontSize = '13px';
  return btn;
}

// Promise-returning Yes/No modal — Electron renderer blocks window.confirm.
function _confirmDialog(message) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div style="white-space:pre-wrap">${_escStep(message)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button class="btn" id="_sp-no">Cancel</button>
          <button class="btn" id="_sp-yes">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('#_sp-no').addEventListener('click',  () => done(false));
    dlg.querySelector('#_sp-yes').addEventListener('click', () => done(true));
    dlg.addEventListener('keydown', e => {
      if (e.key === 'Enter')  done(true);
      if (e.key === 'Escape') done(false);
    });
    dlg.showModal();
  });
}

// Promise-returning modal text input — Electron renderer blocks window.prompt.
function _promptString(title, defaultVal = '') {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sbs-dialog';
    dlg.innerHTML = `
      <div class="sbs-dialog__body">
        <div class="sbs-dialog__title">${_escStep(title)}</div>
        <input type="text" id="_sp-input" value="${_escStep(defaultVal)}"
          style="margin-top:10px;width:100%;box-sizing:border-box" />
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button type="button" class="btn" id="_sp-cancel">Cancel</button>
          <button type="button" class="btn" id="_sp-ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const input  = dlg.querySelector('#_sp-input');
    // V0.3.0.174 — idempotent close (guard against a double fire leaving the
    // dialog up) + close() wrapped so a throw can't skip remove().
    let settled = false;
    const done   = (val) => {
      if (settled) return;
      settled = true;
      try { dlg.close(); } catch {}
      dlg.remove();
      resolve(val);
    };
    dlg.querySelector('#_sp-cancel').addEventListener('click', () => done(null));
    dlg.querySelector('#_sp-ok').addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); done(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });   // native Esc on <dialog>
    dlg.showModal();
    // Explicit focus — <dialog> sometimes auto-focuses the first button
    // instead of the input, which eats the Enter keystroke.
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}
