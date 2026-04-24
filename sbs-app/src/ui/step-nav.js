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
    <div class="step-nav" style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap;">
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
        <button class="btn btn-icon step-nav__prev" title="Previous step (←)">&#8592;</button>
        <span   class="step-nav__label" style="min-width:140px;text-align:center;"></span>
        <button class="btn btn-icon step-nav__next" title="Next step (→)">&#8594;</button>
      </div>
      <input type="text" class="step-nav__narration" placeholder="Voice-over text for this step…"
             style="flex:1;min-width:0;height:28px;padding:0 10px;font-size:13px;background:rgba(255,255,255,0.04);color:var(--text);border:1px solid rgba(255,255,255,0.10);border-radius:6px;caret-color:#f59e0b;" />
      <button class="btn btn-icon step-nav__preview" title="Preview narration"
              style="flex-shrink:0;">&#9654;</button>
    </div>
  `;

  _el.querySelector('.step-nav__prev').addEventListener('click', () => steps.activateRelativeStep(-1));
  _el.querySelector('.step-nav__next').addEventListener('click', () => steps.activateRelativeStep(+1));

  const narrInput  = _el.querySelector('.step-nav__narration');
  const btnPreview = _el.querySelector('.step-nav__preview');

  // Save narration text on blur / Enter.
  narrInput.addEventListener('change', () => {
    const step = _getActiveStep();
    if (!step) return;
    step.narration = { text: narrInput.value };
    state.markDirty();
  });
  narrInput.addEventListener('keydown', e => { if (e.key === 'Enter') narrInput.blur(); });

  btnPreview.addEventListener('click', async () => {
    const step = _getActiveStep();
    if (!step) return;
    await previewStepNarration(step, narrInput.value);
  });

  state.on('change:activeStepId', () => renderStepNav());
  state.on('change:steps',        () => renderStepNav());

  renderStepNav();
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
