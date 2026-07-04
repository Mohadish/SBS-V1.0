/**
 * SBS Step Browser — Step Navigation Bar
 * =========================================
 * Populates #step-nav-bar with ← / → buttons and a step counter.
 * Responds to activeStepId and steps changes.
 */

import { state } from '../core/state.js';
import { steps } from '../systems/steps.js';
import { previewStepNarration } from './steps-panel.js';

let _el = null;

export function initStepNav() {
  _el = document.getElementById('step-nav-bar');
  if (!_el) return;

  _el.innerHTML = `
    <div class="step-nav" style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap;width:100%;">
      <button class="btn btn-icon step-nav__prev" title="Previous step (←)" style="flex-shrink:0;">&#8592;</button>
      <span   class="step-nav__label" style="flex-shrink:0;min-width:90px;text-align:center;font-size:12px;"></span>
      <button class="btn btn-icon step-nav__next" title="Next step (→)" style="flex-shrink:0;">&#8594;</button>
      <input type="text" class="step-nav__narration" placeholder="Voice-over text for this step…"
             style="flex:1 1 auto;min-width:0;height:28px;padding:0 10px;font-size:13px;background:rgba(255,255,255,0.04);color:var(--text);border:1px solid rgba(255,255,255,0.10);border-radius:6px;caret-color:#f59e0b;" />
      <button class="btn btn-icon step-nav__mute" title="Auto-play narration on step change (toggle to mute)" style="flex-shrink:0;">🔊</button>
      <button class="btn btn-icon step-nav__preview" title="Preview narration" style="flex-shrink:0;">&#9654;</button>
    </div>
  `;

  _el.querySelector('.step-nav__prev').addEventListener('click', () => steps.activateRelativeStep(-1));
  _el.querySelector('.step-nav__next').addEventListener('click', () => steps.activateRelativeStep(+1));

  const narrInput  = _el.querySelector('.step-nav__narration');
  const btnPreview = _el.querySelector('.step-nav__preview');

  // V0.2.22.12 — narration text now tracks the step it BELONGS TO at the
  // moment of typing, not whichever step is active when the debounced
  // save fires. Without this, a fast user could type into Step A, then
  // arrow-navigate to Step B; the 200ms-deferred save would write Step
  // A's text into Step B (the "really annoying paste" bug).
  //
  // Also: a focused input survives navigation by design (the renderStep-
  // Nav function skips value updates while focused, to avoid stomping
  // ongoing typing). That left the input visually showing Step A's text
  // while Step B was active, compounding the confusion.
  let _saveTimer = null;
  let _editingStepId = null;       // step that owns the in-flight value
  let _editingValue  = '';
  const flushSave = () => {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    if (!_editingStepId) return;
    const allSteps = state.get('steps') || [];
    const step = allSteps.find(s => s.id === _editingStepId);
    _editingStepId = null;
    if (!step) return;
    // Trim on commit: a trailing/leading space wedges the Kokoro phonemizer AND
    // breaks the preview guard (saved-untrimmed vs preview-trimmed mismatch →
    // the real voice is silently discarded, the long-standing "paste = sticky"
    // bug). Trimming only the STORED value (not narrInput.value) never disturbs
    // ongoing typing — a mid-sentence space the user is still typing survives.
    const val = _editingValue.trim();
    if ((step.narration?.text || '') === val) return;
    // Drop any cached audio when text changes — user must re-preview / re-export.
    step.narration = { text: val };
    // The measured timeline duration is stale too (narration length changed) —
    // drop it so the TOC falls back to the estimate (flagged ~) until the next
    // sbsTocSync / export re-measures.
    delete step.renderedDurationMs;
    state.markDirty();
  };
  narrInput.addEventListener('input', () => {
    _editingStepId = state.get('activeStepId');
    _editingValue  = narrInput.value;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(flushSave, 200);
  });
  narrInput.addEventListener('blur', flushSave);
  narrInput.addEventListener('keydown', e => { if (e.key === 'Enter') narrInput.blur(); });

  // V0.2.22.12 — blur the narration input as soon as the user clicks
  // anything outside it. Pair with the editing-step-id tracking above so
  // step navigation always commits text to the step that owned it.
  // Capture phase so we run BEFORE the click reaches any other handler
  // that might call activateStep / setSelection.
  document.addEventListener('mousedown', (e) => {
    if (document.activeElement === narrInput && !narrInput.contains(e.target)) {
      flushSave();
      narrInput.blur();
    }
  }, true);

  btnPreview.addEventListener('click', async () => {
    const step = _getActiveStep();
    if (!step) return;
    await previewStepNarration(step, narrInput.value);
  });

  // Global narration mute toggle. When muted, step activation does NOT
  // auto-play the saved clip; manual ▶ still works. State is persisted
  // per project (state.narrationMuted).
  const btnMute = _el.querySelector('.step-nav__mute');
  btnMute.addEventListener('click', () => {
    state.setState({ narrationMuted: !state.get('narrationMuted') });
    state.markDirty();
  });
  state.on('change:narrationMuted', _renderMute);

  state.on('change:activeStepId', () => {
    // V0.2.22.12 — commit pending typing to the OLD step and blur the
    // input so renderStepNav's "don't stomp focused input" guard
    // allows the new step's text to populate.
    flushSave();
    if (document.activeElement === narrInput) narrInput.blur();
    renderStepNav();
  });
  state.on('change:steps',        () => renderStepNav());

  renderStepNav();
  _renderMute();
}

function _renderMute() {
  if (!_el) return;
  const btn = _el.querySelector('.step-nav__mute');
  if (!btn) return;
  const muted = !!state.get('narrationMuted');
  btn.textContent = muted ? '🔇' : '🔊';
  btn.title = muted
    ? 'Narration muted on step change — click to enable auto-play'
    : 'Auto-play narration on step change — click to mute';
  btn.style.color = muted ? '#ef4444' : '';
}

function _getActiveStep() {
  const id = state.get('activeStepId');
  if (!id) return null;
  return (state.get('steps') || []).find(s => s.id === id) || null;
}

export function renderStepNav() {
  if (!_el) return;

  const allSteps  = state.get('steps') || [];
  const visible   = allSteps.filter(s => !s.hidden && !s.isBaseStep);
  const activeId  = state.get('activeStepId');
  const activeIdx = visible.findIndex(s => s.id === activeId);

  const label = _el.querySelector('.step-nav__label');
  const prev  = _el.querySelector('.step-nav__prev');
  const next  = _el.querySelector('.step-nav__next');
  const narr  = _el.querySelector('.step-nav__narration');

  if (!label || !prev || !next) return;

  if (visible.length === 0) {
    label.textContent = 'No steps';
    prev.disabled     = true;
    next.disabled     = true;
    if (narr) { narr.value = ''; narr.disabled = true; }
    return;
  }

  // ── Top-level numbering (step-groups) ─────────────────────────────
  // The header always shows the group's number for sub-steps — both
  // head and every sub-step under it display "Step 4 / 12". The 12 is
  // the count of TOP-LEVEL entries (heads + non-grouped). Sub-steps
  // inherit the most recent top-level counter while we walk.
  let topLevelTotal = 0;
  let activeTopLevelIdx = -1;
  for (let i = 0; i < visible.length; i++) {
    const s = visible[i];
    if (!s.groupId) topLevelTotal++;
    if (i === activeIdx) activeTopLevelIdx = topLevelTotal;
  }

  const displayIdx = activeIdx >= 0 ? activeTopLevelIdx : '–';
  const active     = activeIdx >= 0 ? visible[activeIdx] : null;
  // Show the GROUP head's name for sub-steps (per spec — header treats
  // a group as one step). Falls back to active.name when not in a group.
  let displayName = active?.name || '';
  if (active?.groupId) {
    const head = visible.find(s => s.id === active.groupId);
    if (head) displayName = head.name || '';
  }
  label.textContent = `${displayIdx} / ${topLevelTotal}${active ? ' — ' + displayName : ''}`;

  // Step-groups: left arrow / prev jumps to the top-level step BEFORE
  // the current group (when on a sub-step) or the previous top-level
  // (when on a head/normal). Disable iff no such target exists.
  let searchFrom = activeIdx - 1;
  if (active?.groupId) {
    const headIdx = visible.findIndex(s => s.id === active.groupId);
    if (headIdx >= 0) searchFrom = headIdx - 1;
  }
  let hasPrevTopLevel = false;
  for (let i = searchFrom; i >= 0; i--) {
    if (!visible[i].groupId) { hasPrevTopLevel = true; break; }
  }
  prev.disabled = activeIdx < 0 || !hasPrevTopLevel;
  next.disabled = activeIdx < 0 || activeIdx >= visible.length - 1;

  // Keep the narration input in sync with the active step. Avoid stomping
  // the user's current typing by only writing when the field isn't focused.
  if (narr && document.activeElement !== narr) {
    narr.value    = active?.narration?.text || '';
    narr.disabled = !active;
  }
}
