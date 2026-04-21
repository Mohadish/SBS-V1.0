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
import { createChapter } from '../core/schema.js';
import { setStatus } from './status.js';

let _container = null;
let _dragId    = null;

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
      <div class="card" style="margin-top:8px;">
        <div class="grid2">
          <label class="colorlab">Camera (ms)
            <input type="number" id="global-cam-dur" min="0" max="30000" step="100" value="1500" style="margin-top:6px;" />
          </label>
          <label class="colorlab">Objects (ms)
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

  _container.querySelector('#global-cam-dur').addEventListener('change', e => {
    _setGlobalDuration('cameraAnimDurationMs', Number(e.target.value));
  });
  _container.querySelector('#global-obj-dur').addEventListener('change', e => {
    _setGlobalDuration('objectAnimDurationMs', Number(e.target.value));
  });

  state.on('change:steps',                _syncAndRender);
  state.on('change:chapters',             _syncAndRender);
  state.on('change:activeStepId',         renderStepsPanel);
  state.on('change:cameraAnimDurationMs', _syncDurationInputs);
  state.on('change:objectAnimDurationMs', _syncDurationInputs);
  state.on('change:animationPresets',     renderStepsPanel);

  _syncDurationInputs();
  renderStepsPanel();
}

function _syncAndRender() { renderStepsPanel(); }

function _syncDurationInputs() {
  const camEl = document.getElementById('global-cam-dur');
  const objEl = document.getElementById('global-obj-dur');
  if (camEl) camEl.value = state.get('cameraAnimDurationMs') ?? 1500;
  if (objEl) objEl.value = state.get('objectAnimDurationMs') ?? 1500;
}

function _setGlobalDuration(key, val) {
  state.setState({ [key]: val });
  state.markDirty();
}

// ── Render ──────────────────────────────────────────────────────────────────

export function renderStepsPanel() {
  const list = document.getElementById('steps-list');
  if (!list) return;

  const allSteps    = state.get('steps')    || [];
  const allChapters = state.get('chapters') || [];
  const activeId    = state.get('activeStepId');

  if (allSteps.length === 0) {
    list.innerHTML = '<div class="small muted" style="padding:12px;">No steps yet.<br>Press <b>+ Step</b> to capture the current scene.</div>';
    return;
  }

  const scrollTop = list.scrollTop;
  list.innerHTML  = '';

  const chapterById    = new Map(allChapters.map(c => [c.id, c]));
  const emittedChapters = new Set();

  allSteps.forEach((step, idx) => {
    if (step.chapterId && !emittedChapters.has(step.chapterId)) {
      const chapter = chapterById.get(step.chapterId);
      if (chapter) {
        list.appendChild(_buildChapterHeader(chapter));
        emittedChapters.add(step.chapterId);
      }
    }
    const isActive = step.id === activeId;
    list.appendChild(_buildStepCard(step, idx, isActive, allSteps.length));
  });

  list.scrollTop = scrollTop;

  const activeCard = list.querySelector('.stepItem.active');
  if (activeCard) activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Chapter header ───────────────────────────────────────────────────────────

function _buildChapterHeader(chapter) {
  const wrap = document.createElement('div');
  wrap.dataset.chapterId = chapter.id;
  wrap.style.cssText = 'padding:6px 4px 2px;display:flex;align-items:center;gap:6px;';

  const name = document.createElement('span');
  name.className   = 'title';
  name.style.flex  = '1';
  name.textContent = chapter.name || 'Chapter';

  const btnRename = _mkBtn('✎', 'Rename chapter');
  const btnDel    = _mkBtn('🗑', 'Delete chapter');
  btnRename.addEventListener('click', e => { e.stopPropagation(); _renameChapter(chapter.id); });
  btnDel.addEventListener('click',    e => { e.stopPropagation(); _deleteChapter(chapter.id); });

  wrap.append(name, btnRename, btnDel);
  return wrap;
}

// ── Step card ────────────────────────────────────────────────────────────────

function _buildStepCard(step, idx, isActive, total) {
  const card = document.createElement('div');
  card.className = [
    'stepItem',
    isActive    ? 'active'     : '',
    step.hidden ? 'hiddenStep' : '',
  ].filter(Boolean).join(' ');
  card.draggable      = true;
  card.dataset.stepId = step.id;
  card.style.marginBottom = '8px';

  // ── Top row ──────────────────────────────────────────────────────────────
  const top = document.createElement('div');
  top.className = 'stepTop';

  // Index badge
  const badge = document.createElement('span');
  badge.className   = 'pill';
  badge.style.cssText = 'flex-shrink:0;font-weight:700;';
  badge.textContent = String(idx + 1).padStart(2, '0');

  // Name
  const nameLbl = document.createElement('span');
  nameLbl.className   = 'stepName';
  nameLbl.textContent = step.name || 'Unnamed Step';

  // Spacer
  const spacer = document.createElement('span');
  spacer.className = 'stepTopSpacer';

  // Camera badge
  const camBadge = document.createElement('span');
  camBadge.textContent = '📷';
  camBadge.title       = step.snapshot?.camera ? 'Camera saved' : 'No camera saved';
  camBadge.style.cssText = `opacity:${step.snapshot?.camera ? '0.55' : '0.2'};font-size:11px;flex-shrink:0;`;

  // Action buttons
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:3px;flex-shrink:0;';

  const btnCam    = _mkBtn('📷', 'Update camera for this step');
  const btnHide   = _mkBtn(step.hidden ? '🚫' : '👁', 'Toggle visibility in playback');
  const btnRename = _mkBtn('✎',  'Rename step');
  const btnDup    = _mkBtn('⧉',  'Duplicate step');
  const btnDel    = _mkBtn('🗑', 'Delete step');

  btnCam.addEventListener('click',    e => { e.stopPropagation(); steps.saveStepCamera(step.id); setStatus('Camera saved for step.'); });
  btnHide.addEventListener('click',   e => { e.stopPropagation(); steps.setStepHidden(step.id, !step.hidden); });
  btnRename.addEventListener('click', e => { e.stopPropagation(); _renameStep(step.id); });
  btnDup.addEventListener('click',    e => { e.stopPropagation(); _duplicateStep(step.id); });
  btnDel.addEventListener('click',    e => { e.stopPropagation(); _deleteStep(step.id); });

  actions.append(btnCam, btnHide, btnRename, btnDup, btnDel);
  top.append(badge, nameLbl, spacer, camBadge, actions);

  // ── Meta row ──────────────────────────────────────────────────────────────
  const meta = document.createElement('div');
  meta.className = 'stepMeta';
  const t = step.transition || {};
  const globalCam = state.get('cameraAnimDurationMs') ?? 1500;
  const globalObj = state.get('objectAnimDurationMs') ?? 1500;
  const camMs = t.durationOverride ? (t.cameraDurationMs ?? globalCam) : globalCam;
  const objMs = t.durationOverride ? (t.objectDurationMs ?? globalObj) : globalObj;
  meta.textContent = `Cam ${camMs}ms · Obj ${objMs}ms · ${t.cameraEasing ?? 'smooth'}`;

  card.appendChild(top);
  card.appendChild(meta);

  // ── Transition settings (active step only) ────────────────────────────────
  if (isActive) {
    card.appendChild(_buildTransitionRow(step));
  }

  // Click → activate
  card.addEventListener('click', () => steps.activateStep(step.id, true));

  // Drag-and-drop
  card.addEventListener('dragstart', e => {
    _dragId = step.id;
    e.dataTransfer.effectAllowed = 'move';
    card.style.opacity = '0.5';
  });
  card.addEventListener('dragend', () => {
    _dragId = null;
    card.style.opacity = '';
  });
  card.addEventListener('dragover', e => {
    e.preventDefault();
    card.classList.add('ghostDrop');
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('ghostDrop');
  });
  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('ghostDrop');
    if (_dragId && _dragId !== step.id) {
      const all   = state.get('steps') || [];
      const toIdx = all.findIndex(s => s.id === step.id);
      if (toIdx >= 0) actions.reorderStep(_dragId, toIdx);
    }
  });

  return card;
}

// ── Transition row ────────────────────────────────────────────────────────────

function _buildTransitionRow(step) {
  const t           = step.transition || {};
  const globalCam   = state.get('cameraAnimDurationMs') ?? 1500;
  const globalObj   = state.get('objectAnimDurationMs') ?? 1500;
  const hasOverride = t.durationOverride === true;
  const stepId      = step.id;
  const animPresets = state.get('animationPresets') || [];

  // Resolve which preset is active (step → project default → none)
  const stepPresetId   = t.animPresetId ?? null;
  const defaultPreset  = animPresets.find(p => p.isDefault);
  const activePresetId = stepPresetId || defaultPreset?.id || null;
  const activePreset   = animPresets.find(p => p.id === activePresetId);

  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.style.marginTop = '6px';
  wrap.style.fontSize  = '12px';

  // ── Animation preset selector ─────────────────────────────────────────────
  const presetOptions = [
    `<option value="" ${!stepPresetId ? 'selected' : ''}>Project default${defaultPreset ? ` (${_escStep(defaultPreset.name)})` : ' — none'}</option>`,
    ...animPresets.map(p =>
      `<option value="${_escStep(p.id)}" ${stepPresetId === p.id ? 'selected' : ''}>${_escStep(p.name)}</option>`
    ),
  ].join('');

  // When a preset is active, show its animation string and hide legacy controls
  const usingPreset = !!activePreset;

  wrap.innerHTML = `
    ${animPresets.length > 0 ? `
    <label class="colorlab">Animation preset
      <select class="tran-anim-preset" style="margin-top:4px">
        ${presetOptions}
      </select>
    </label>
    ${usingPreset ? `
    <div class="small muted" style="margin-top:5px;padding:4px 6px;background:rgba(255,255,255,0.04);border-radius:4px;font-family:monospace;font-size:10px;word-break:break-all">
      ${_escStep(activePreset.animation)}
    </div>` : ''}
    <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.08);padding-top:8px"></div>
    ` : ''}

    ${!usingPreset ? `
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox" class="tran-override" ${hasOverride ? 'checked' : ''} />
      <span class="small muted">Override global durations</span>
    </label>

    ${hasOverride ? `
    <div class="grid2" style="margin-top:8px;">
      <label class="colorlab">Camera (ms)
        <input type="number" class="tran-cam-dur" value="${t.cameraDurationMs ?? globalCam}" min="0" max="30000" step="100" style="margin-top:4px;" />
      </label>
      <label class="colorlab">Objects (ms)
        <input type="number" class="tran-obj-dur" value="${t.objectDurationMs ?? globalObj}" min="0" max="30000" step="100" style="margin-top:4px;" />
      </label>
    </div>` : `
    <div class="small muted" style="margin-top:6px;">📐 Camera: ${globalCam}ms &nbsp; Objects: ${globalObj}ms</div>`}
    ` : `
    <div class="small muted" style="margin-top:2px;">Durations defined by preset above.</div>
    `}

    <div class="grid2" style="margin-top:8px;">
      <label class="colorlab">Camera easing
        <select class="tran-cam-ease" style="margin-top:4px;">
          <option value="smooth"  ${(t.cameraEasing ?? 'smooth') === 'smooth'  ? 'selected' : ''}>Smooth</option>
          <option value="linear"  ${(t.cameraEasing ?? 'smooth') === 'linear'  ? 'selected' : ''}>Linear</option>
          <option value="instant" ${(t.cameraEasing ?? 'smooth') === 'instant' ? 'selected' : ''}>Instant</option>
        </select>
      </label>
      <label class="colorlab">Object easing
        <select class="tran-obj-ease" style="margin-top:4px;">
          <option value="smooth"  ${(t.objectEasing ?? 'smooth') === 'smooth'  ? 'selected' : ''}>Smooth</option>
          <option value="linear"  ${(t.objectEasing ?? 'smooth') === 'linear'  ? 'selected' : ''}>Linear</option>
          <option value="instant" ${(t.objectEasing ?? 'smooth') === 'instant' ? 'selected' : ''}>Instant</option>
        </select>
      </label>
    </div>

    <label style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;">
      <input type="checkbox" class="tran-fade" ${t.visibilityFade !== false ? 'checked' : ''} />
      <span class="small muted">Fade visibility changes</span>
    </label>
  `;

  // ── Event listeners ───────────────────────────────────────────────────────
  wrap.querySelector('.tran-anim-preset')?.addEventListener('change', e => {
    actions.updateTransition(stepId, { animPresetId: e.target.value || null });
  });
  wrap.querySelector('.tran-override')?.addEventListener('change', e => {
    actions.updateTransition(stepId, { durationOverride: e.target.checked });
  });
  wrap.querySelector('.tran-cam-dur')?.addEventListener('change', e => {
    actions.updateTransition(stepId, { cameraDurationMs: Number(e.target.value) });
  });
  wrap.querySelector('.tran-obj-dur')?.addEventListener('change', e => {
    actions.updateTransition(stepId, { objectDurationMs: Number(e.target.value) });
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

  return wrap;
}

function _escStep(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ── Chapter actions ──────────────────────────────────────────────────────────

function _onAddChapter() {
  const name = prompt('Chapter name:', 'Chapter');
  if (!name) return;
  const chapter = createChapter({ name: name.trim() });
  const chapters = [...(state.get('chapters') || []), chapter];
  state.setState({ chapters });
  state.markDirty();
  setStatus(`Created chapter "${chapter.name}".`);
  state.setState({ _pendingChapterId: chapter.id });
}

function _renameChapter(chapterId) {
  const chapters = state.get('chapters') || [];
  const chapter  = chapters.find(c => c.id === chapterId);
  if (!chapter) return;
  const name = prompt('Chapter name:', chapter.name || '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const updated = chapters.map(c => c.id === chapterId ? { ...c, name: trimmed } : c);
  state.setState({ chapters: updated });
  state.markDirty();
}

function _deleteChapter(chapterId) {
  const chapters = state.get('chapters') || [];
  const chapter  = chapters.find(c => c.id === chapterId);
  if (!chapter) return;
  if (!confirm(`Delete chapter "${chapter.name}"?\nSteps in this chapter will become ungrouped.`)) return;
  const allSteps = (state.get('steps') || []).map(s =>
    s.chapterId === chapterId ? { ...s, chapterId: null } : s,
  );
  const updatedChapters = chapters.filter(c => c.id !== chapterId);
  state.setState({ steps: allSteps, chapters: updatedChapters });
  state.markDirty();
  setStatus(`Deleted chapter "${chapter.name}".`);
}

// ── Step actions ─────────────────────────────────────────────────────────────

async function _onAddStep() {
  await steps.flushSync();
  const chapterId = state.get('_pendingChapterId') ?? null;
  const step = actions.createStep('New Step', { chapterId });
  if (chapterId) state.setState({ _pendingChapterId: null });
  setStatus(`Created step "${step.name}".`);
}

function _renameStep(stepId) {
  const step = steps.getStepById(stepId);
  if (!step) return;
  const name = prompt('Step name:', step.name || '');
  if (name === null) return;
  const trimmed = name.trim();
  if (trimmed) actions.renameStep(stepId, trimmed);
}

function _duplicateStep(stepId) {
  steps.flushSync().then(() => {
    const copy = actions.duplicateStep(stepId);
    if (copy) setStatus(`Duplicated "${copy.name}".`);
  });
}

function _deleteStep(stepId) {
  const step = steps.getStepById(stepId);
  if (!step) return;
  if (!confirm(`Delete step "${step.name}"?`)) return;
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
