/**
 * SBS Step Browser — Step Navigation Bar
 * =========================================
 * Populates #step-nav-bar with ← / → buttons and a step counter.
 * Responds to activeStepId and steps changes.
 */

import { state } from '../core/state.js';
import { steps } from '../systems/steps.js';

let _el = null;

export function initStepNav() {
  _el = document.getElementById('step-nav-bar');
  if (!_el) return;

  _el.innerHTML = `
    <div class="step-nav">
      <button class="btn btn-icon step-nav__prev" title="Previous step (←)">&#8592;</button>
      <span   class="step-nav__label"></span>
      <button class="btn btn-icon step-nav__next" title="Next step (→)">&#8594;</button>
    </div>
  `;

  _el.querySelector('.step-nav__prev').addEventListener('click', () => steps.activateRelativeStep(-1));
  _el.querySelector('.step-nav__next').addEventListener('click', () => steps.activateRelativeStep(+1));

  state.on('change:activeStepId', () => renderStepNav());
  state.on('change:steps',        () => renderStepNav());

  renderStepNav();
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

  if (!label || !prev || !next) return;

  if (visible.length === 0) {
    label.textContent      = 'No steps';
    prev.disabled          = true;
    next.disabled          = true;
    return;
  }

  const displayIdx = activeIdx >= 0 ? activeIdx + 1 : '–';
  const active     = activeIdx >= 0 ? visible[activeIdx] : null;
  label.textContent = `${displayIdx} / ${visible.length}${active ? ' — ' + active.name : ''}`;

  prev.disabled = activeIdx <= 0;
  next.disabled = activeIdx < 0 || activeIdx >= visible.length - 1;
}
