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
import { showContextMenu } from './context-menu.js';

let _container    = null;
let _dragId       = null;          // id of step being dragged
let _dragChapterId = null;         // id of chapter being dragged (header drag)
const _collapsed  = new Map();     // chapterId -> true if collapsed (ephemeral, per session)
let _expandTimer  = null;          // setTimeout id for hover-to-expand
const HOVER_EXPAND_MS = 500;
const DROP_COLOR  = '#3b82f6';     // blue insertion line

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

  const allSteps    = (state.get('steps') || []).filter(s => !s.isBaseStep);
  const allChapters = state.get('chapters') || [];
  const activeId    = state.get('activeStepId');

  if (allSteps.length === 0) {
    list.innerHTML = '<div class="small muted" style="padding:12px;">No steps yet.<br>Press <b>+ Step</b> to capture the current scene.</div>';
    return;
  }

  const scrollTop = list.scrollTop;
  list.innerHTML  = '';

  // Index each step by its position in the flat array so step cards still
  // receive the correct global index (used for the index badge).
  const flatIndex = new Map();
  allSteps.forEach((s, i) => flatIndex.set(s.id, i));

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

  // Render: chapters (in chapter-list order) → ungrouped steps at end.
  allChapters.forEach((chapter, chIdx) => {
    list.appendChild(_buildChapterHeader(chapter, chIdx + 1));
    if (_isChapterVisuallyCollapsed(chapter, activeId)) return;
    const chSteps = byChapter.get(chapter.id) || [];
    for (const step of chSteps) {
      const idx = flatIndex.get(step.id);
      list.appendChild(_buildStepCard(step, idx, step.id === activeId, allSteps.length));
    }
  });
  for (const step of ungrouped) {
    const idx = flatIndex.get(step.id);
    list.appendChild(_buildStepCard(step, idx, step.id === activeId, allSteps.length));
  }

  list.scrollTop = scrollTop;

  const activeCard = list.querySelector('.stepItem.active');
  if (activeCard) activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Chapter header ───────────────────────────────────────────────────────────

/**
 * Visual collapse state resolves lock + active-step-in-chapter overrides:
 *   - locked chapter        → always expanded
 *   - active step ∈ chapter → always expanded (ignore user collapse)
 *   - otherwise             → honour _collapsed map
 */
function _isChapterVisuallyCollapsed(chapter, activeId) {
  if (chapter.locked) return false;
  if (!_collapsed.get(chapter.id)) return false;
  if (activeId) {
    const active = (state.get('steps') || []).find(s => s.id === activeId);
    if (active?.chapterId === chapter.id) return false;
  }
  return true;
}

function _buildChapterHeader(chapter, number) {
  const wrap = document.createElement('div');
  wrap.className         = 'chapterHeader';
  wrap.dataset.chapterId = chapter.id;
  wrap.draggable         = true;
  wrap.style.cssText = [
    'padding:8px 8px',
    'margin-top:10px',
    'display:flex',
    'align-items:center',
    'gap:6px',
    'background:rgba(255,255,255,0.04)',
    'border:1px solid rgba(255,255,255,0.08)',
    'border-radius:6px',
    'cursor:grab',
    'user-select:none',
  ].join(';');

  // Collapse / expand toggle.
  //   userCollapsed = user pressed ▸
  //   actualCollapsed = what renders right now (lock + active-step override)
  //   forcedOpen = user asked to collapse but something is holding it open
  const userCollapsed   = !!_collapsed.get(chapter.id);
  const activeId        = state.get('activeStepId');
  const actualCollapsed = _isChapterVisuallyCollapsed(chapter, activeId);
  const forcedOpen      = userCollapsed && !actualCollapsed;

  const btnToggle = _mkBtn(actualCollapsed ? '▸' : '▾', userCollapsed ? 'Expand' : 'Collapse');
  btnToggle.style.fontSize = '14px';
  if (forcedOpen) btnToggle.style.opacity = '0.4';
  btnToggle.addEventListener('click', e => {
    e.stopPropagation();
    _collapsed.set(chapter.id, !userCollapsed);
    renderStepsPanel();
  });

  // Numbered badge (position-based)
  const badge = document.createElement('span');
  badge.className   = 'pill';
  badge.style.cssText = 'flex-shrink:0;font-weight:700;font-size:11px;';
  badge.textContent = String(number).padStart(2, '0');

  const name = document.createElement('span');
  name.className   = 'title';
  name.style.flex  = '1';
  name.textContent = chapter.name || 'Chapter';

  // Lock: on (blue) = always expanded; off (grey) = collapsable
  const btnLock = _mkBtn(chapter.locked ? '🔒' : '🔓', chapter.locked ? 'Unlock (allow collapse)' : 'Lock open');
  btnLock.style.color   = chapter.locked ? '#3b82f6' : '#6b7280';
  btnLock.style.opacity = chapter.locked ? '1' : '0.75';
  btnLock.addEventListener('click', e => {
    e.stopPropagation();
    actions.setChapterLocked(chapter.id, !chapter.locked);
  });

  const btnRename = _mkBtn('✎',  'Rename chapter');
  const btnDel    = _mkBtn('🗑', 'Delete chapter');
  btnRename.addEventListener('click', e => { e.stopPropagation(); _renameChapter(chapter.id); });
  btnDel.addEventListener('click',    e => { e.stopPropagation(); _deleteChapter(chapter.id); });

  wrap.append(btnToggle, badge, name, btnLock, btnRename, btnDel);

  // ── Drag the whole chapter (and its steps) ────────────────────────────────
  wrap.addEventListener('dragstart', e => {
    _dragChapterId = chapter.id;
    _dragId        = null;
    e.dataTransfer.effectAllowed = 'move';
    wrap.style.opacity = '0.5';
  });
  wrap.addEventListener('dragend', () => {
    _dragChapterId = null;
    _clearExpandTimer();
    _clearDropIndicators();
    wrap.style.opacity = '';
  });

  // ── Drop zone: accepts steps (into chapter) AND chapters (reorder) ────────
  wrap.addEventListener('dragover', e => {
    e.preventDefault();
    const side = _dragChapterId ? _dropSideFromEvent(wrap, e) : 'after';
    _setDropIndicator(wrap, side);
    // Hover-to-expand if collapsed and a step is being dragged
    if (_dragId && _collapsed.get(chapter.id) && !_expandTimer) {
      _expandTimer = setTimeout(() => {
        _collapsed.set(chapter.id, false);
        _expandTimer = null;
        renderStepsPanel();
      }, HOVER_EXPAND_MS);
    }
  });
  wrap.addEventListener('dragleave', () => {
    _clearDropIndicators();
    _clearExpandTimer();
  });
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    const side = wrap.dataset.dropSide;
    _clearDropIndicators();
    _clearExpandTimer();

    if (_dragId) {
      // Step dropped on a chapter header → move into that chapter (top of it).
      const insertIdx = _chapterTopInsertIndex(chapter.id);
      actions.moveStepToChapter(_dragId, chapter.id, insertIdx);
    } else if (_dragChapterId && _dragChapterId !== chapter.id) {
      // Chapter dropped on another chapter's header → reorder block.
      // side=before → insert chapter AT target's index (pushing target down)
      // side=after  → insert chapter AFTER target (one past target's index)
      const chapters = state.get('chapters') || [];
      let toIdx      = chapters.findIndex(c => c.id === chapter.id);
      if (toIdx >= 0) {
        if (side === 'after') toIdx += 1;
        actions.reorderChapter(_dragChapterId, toIdx);
      }
    }
  });

  return wrap;
}

function _clearExpandTimer() {
  if (_expandTimer) { clearTimeout(_expandTimer); _expandTimer = null; }
}

// ── Drop indicator ──────────────────────────────────────────────────────────
// Shows a 2px blue line ABOVE (side='before') or BELOW (side='after') a card
// or header to mark exactly where the drag will land.
function _setDropIndicator(el, side) {
  if (!el) return;
  _clearDropIndicators();
  if (side === 'before') el.style.boxShadow = `0 -2px 0 0 ${DROP_COLOR}`;
  else                    el.style.boxShadow = `0  2px 0 0 ${DROP_COLOR}`;
  el.dataset.dropSide = side;
}

function _clearDropIndicators() {
  const list = document.getElementById('steps-list');
  if (!list) return;
  list.querySelectorAll('.stepItem, .chapterHeader').forEach(el => {
    el.style.boxShadow = '';
    delete el.dataset.dropSide;
  });
}

function _dropSideFromEvent(el, e) {
  const rect = el.getBoundingClientRect();
  return (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after';
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

  if (isActive) {
    card.appendChild(_buildStepTopActive(step, idx));
    card.appendChild(_buildStepMetaRow(step));
    card.appendChild(_buildTransitionRow(step));
  } else {
    card.appendChild(_buildStepTopCollapsed(step, idx));
    // Right-click menu for collapsed step — replaces the button row.
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      _showStepContextMenu(step, e.clientX, e.clientY);
    });
  }

  // Single click → animate to step
  card.addEventListener('click', () => steps.activateStep(step.id, true));

  // Double click → instant jump to final state (skips animation)
  card.addEventListener('dblclick', e => { e.stopPropagation(); steps.activateStep(step.id, false); });

  // Drag-and-drop
  card.addEventListener('dragstart', e => {
    _dragId        = step.id;
    _dragChapterId = null;
    e.dataTransfer.effectAllowed = 'move';
    card.style.opacity = '0.5';
  });
  card.addEventListener('dragend', () => {
    _dragId = null;
    _clearExpandTimer();
    _clearDropIndicators();
    card.style.opacity = '';
  });
  card.addEventListener('dragover', e => {
    e.preventDefault();
    _setDropIndicator(card, _dropSideFromEvent(card, e));
  });
  card.addEventListener('dragleave', () => {
    _clearDropIndicators();
  });
  card.addEventListener('drop', e => {
    e.preventDefault();
    const side = card.dataset.dropSide || 'before';
    _clearDropIndicators();
    if (_dragId && _dragId !== step.id) {
      const all   = state.get('steps') || [];
      let toIdx   = all.findIndex(s => s.id === step.id);
      if (toIdx < 0) return;
      if (side === 'after') toIdx += 1;
      const targetChapterId = step.chapterId ?? null;
      actions.moveStepToChapter(_dragId, targetChapterId, toIdx);
    }
  });

  return card;
}

// ── Step top rows ────────────────────────────────────────────────────────────

/** Expanded (active) step: index badge, name, cam badge, action buttons. */
function _buildStepTopActive(step, idx) {
  const top = document.createElement('div');
  top.className = 'stepTop';

  const badge = document.createElement('span');
  badge.className   = 'pill';
  badge.style.cssText = 'flex-shrink:0;font-weight:700;';
  badge.textContent = String(idx + 1).padStart(2, '0');

  const nameLbl = document.createElement('span');
  nameLbl.className   = 'stepName';
  nameLbl.textContent = step.name || 'Unnamed Step';

  const spacer = document.createElement('span');
  spacer.className = 'stepTopSpacer';

  const camBadge = document.createElement('span');
  camBadge.textContent = '📷';
  camBadge.title       = step.snapshot?.camera ? 'Camera saved' : 'No camera saved';
  camBadge.style.cssText = `opacity:${step.snapshot?.camera ? '0.55' : '0.2'};font-size:11px;flex-shrink:0;`;

  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display:flex;gap:3px;flex-shrink:0;';

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

  actionsRow.append(btnCam, btnHide, btnRename, btnDup, btnDel);
  top.append(badge, nameLbl, spacer, camBadge, actionsRow);
  return top;
}

/** Collapsed (non-active) step: thumbnail placeholder, badge, name. No buttons. */
function _buildStepTopCollapsed(step, idx) {
  const top = document.createElement('div');
  top.className = 'stepTop';
  top.style.cssText = 'display:flex;align-items:center;gap:8px;';

  // Thumbnail placeholder — reserved slot for future preview capture.
  const thumb = document.createElement('div');
  thumb.className = 'stepThumb';
  thumb.style.cssText = [
    'flex:0 0 auto',
    'width:48px',
    'height:36px',
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

  const badge = document.createElement('span');
  badge.className   = 'pill';
  badge.style.cssText = 'flex-shrink:0;font-weight:700;';
  badge.textContent = String(idx + 1).padStart(2, '0');

  const nameLbl = document.createElement('span');
  nameLbl.className   = 'stepName';
  nameLbl.style.flex  = '1';
  nameLbl.textContent = step.name || 'Unnamed Step';

  top.append(thumb, badge, nameLbl);

  // If hidden in playback, show a small indicator on the far right.
  if (step.hidden) {
    const hideInd = document.createElement('span');
    hideInd.textContent = '🚫';
    hideInd.title = 'Hidden in playback';
    hideInd.style.cssText = 'flex-shrink:0;opacity:0.5;font-size:11px;';
    top.appendChild(hideInd);
  }
  return top;
}

/** Cam/Obj durations + easing summary row. */
function _buildStepMetaRow(step) {
  const meta = document.createElement('div');
  meta.className = 'stepMeta';
  const t         = step.transition || {};
  const globalCam = state.get('cameraAnimDurationMs') ?? 1500;
  const globalObj = state.get('objectAnimDurationMs') ?? 1500;
  const camMs     = t.durationOverride ? (t.cameraDurationMs ?? globalCam) : globalCam;
  const objMs     = t.durationOverride ? (t.objectDurationMs ?? globalObj) : globalObj;
  meta.textContent = `Cam ${camMs}ms · Obj ${objMs}ms · ${t.cameraEasing ?? 'smooth'}`;
  return meta;
}

// ── Step context menu (right-click on collapsed card) ───────────────────────

function _showStepContextMenu(step, x, y) {
  showContextMenu([
    { label: 'Rename…',       action: () => _renameStep(step.id) },
    { label: 'Duplicate',     action: () => _duplicateStep(step.id) },
    { label: step.hidden ? 'Show in playback' : 'Hide from playback',
      action: () => steps.setStepHidden(step.id, !step.hidden) },
    { label: 'Update camera', action: () => { steps.saveStepCamera(step.id); setStatus('Camera saved for step.'); } },
    { separator: true },
    { label: 'Delete',        action: () => _deleteStep(step.id) },
  ], x, y);
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

async function _onAddChapter() {
  const name = await _promptString('Chapter name:', 'Chapter');
  if (!name) return;
  const chapter = createChapter({ name });
  const chapters = [...(state.get('chapters') || []), chapter];
  state.setState({ chapters });
  state.markDirty();
  setStatus(`Created chapter "${chapter.name}".`);
  state.setState({ _pendingChapterId: chapter.id });
}

async function _renameChapter(chapterId) {
  const chapters = state.get('chapters') || [];
  const chapter  = chapters.find(c => c.id === chapterId);
  if (!chapter) return;
  const name = await _promptString('Chapter name:', chapter.name || '');
  if (!name) return;
  const updated = chapters.map(c => c.id === chapterId ? { ...c, name } : c);
  state.setState({ chapters: updated });
  state.markDirty();
}

async function _deleteChapter(chapterId) {
  const chapters = state.get('chapters') || [];
  const chapter  = chapters.find(c => c.id === chapterId);
  if (!chapter) return;
  const ok = await _confirmDialog(`Delete chapter "${chapter.name}"?\nSteps in this chapter will become ungrouped.`);
  if (!ok) return;
  const allSteps = (state.get('steps') || []).map(s =>
    s.chapterId === chapterId ? { ...s, chapterId: null } : s,
  );
  const updatedChapters = chapters.filter(c => c.id !== chapterId);
  state.setState({ steps: allSteps, chapters: updatedChapters });
  steps.normalizeOrder();
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

async function _renameStep(stepId) {
  const step = steps.getStepById(stepId);
  if (!step) return;
  const name = await _promptString('Step name:', step.name || '');
  if (name) actions.renameStep(stepId, name);
}

function _duplicateStep(stepId) {
  steps.flushSync().then(() => {
    const copy = actions.duplicateStep(stepId);
    if (copy) setStatus(`Duplicated "${copy.name}".`);
  });
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
          <button class="btn" id="_sp-cancel">Cancel</button>
          <button class="btn" id="_sp-ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
    const input  = dlg.querySelector('#_sp-input');
    const done   = (val) => { dlg.close(); dlg.remove(); resolve(val); };
    dlg.querySelector('#_sp-cancel').addEventListener('click', () => done(null));
    dlg.querySelector('#_sp-ok').addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
    dlg.showModal();
    requestAnimationFrame(() => input.select());
  });
}
