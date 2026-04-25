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

  // Save narration text live (every keystroke). The previous 'change'-event
  // approach lost edits when the user arrow-navigated away without blurring
  // — the input never fires 'change' if focus stays in the document, and
  // re-render then overwrites the un-saved value.
  // Direct mutation + markDirty doesn't trigger a panel re-render, so the
  // input keeps focus while typing.
  let _saveTimer = null;
  const saveText = () => {
    const step = _getActiveStep();
    if (!step) return;
    if ((step.narration?.text || '') === narrInput.value) return;
    // Drop any cached audio when text changes — user must re-preview / re-export.
    step.narration = { text: narrInput.value };
    state.markDirty();
  };
  narrInput.addEventListener('input', () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveText, 200);
  });
  narrInput.addEventListener('blur', saveText);
  narrInput.addEventListener('keydown', e => { if (e.key === 'Enter') narrInput.blur(); });

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

  state.on('change:activeStepId', () => renderStepNav());
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

  const displayIdx = activeIdx >= 0 ? activeIdx + 1 : '–';
  const active     = activeIdx >= 0 ? visible[activeIdx] : null;
  label.textContent = `${displayIdx} / ${visible.length}${active ? ' — ' + active.name : ''}`;

  prev.disabled = activeIdx <= 0;
  next.disabled = activeIdx < 0 || activeIdx >= visible.length - 1;

  // Keep the narration input in sync with the active step. Avoid stomping
  // the user's current typing by only writing when the field isn't focused.
  if (narr && document.activeElement !== narr) {
    narr.value    = active?.narration?.text || '';
    narr.disabled = !active;
  }
}
