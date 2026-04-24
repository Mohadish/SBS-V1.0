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
import { setStatus } from './status.js';
import { showContextMenu } from './context-menu.js';

let _container    = null;
let _dragId       = null;          // id of step being dragged (single-drag fallback)
let _dragIds      = [];            // ids of all steps being dragged (set when multi-drag)
let _dragChapterId = null;         // id of chapter being dragged (header drag)
let _selectedIds  = new Set();     // set of step ids currently multi-selected
const _dragExpand = new Set();     // chapterIds force-expanded during a drag (hover override)
let _expandTimer  = null;          // setTimeout id for hover-to-expand
let _expandedId   = null;          // id of step currently shown in expanded layout (null = all collapsed)
let _clipboard    = null;          // { kind: 'steps'|'chapter', data: ... } — survives renders, cleared on new copy
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
  state.on('change:activeStepId',         _onActiveStepChanged);
  state.on('change:cameraAnimDurationMs', _syncDurationInputs);
  state.on('change:objectAnimDurationMs', _syncDurationInputs);
  state.on('change:animationPresets',     renderStepsPanel);
  // Surgical per-step thumbnail update — avoid re-rendering the whole list.
  state.on('step:thumb', _onStepThumb);

  // Click outside the timeline panel collapses the expanded step AND clears
  // the multi-selection. The scene's active step is unchanged. Capture phase
  // so we see clicks before their own handlers cancel propagation.
  document.addEventListener('click', e => {
    if (!_container) return;
    if (_container.contains(e.target)) return;
    // Context menu (rendered outside the timeline) shouldn't count as "outside".
    const ctx = document.getElementById('context-menu');
    if (ctx && ctx.contains(e.target)) return;
    let dirty = false;
    if (_expandedId !== null) { _expandedId = null; dirty = true; }
    if (_selectedIds.size)   { _selectedIds.clear(); dirty = true; }
    if (dirty) renderStepsPanel();
  }, true);

  _syncDurationInputs();
  renderStepsPanel();
}

function _onActiveStepChanged() {
  // When active step changes via keyboard or any other path, sync expansion.
  _expandedId = state.get('activeStepId');
  renderStepsPanel();
}

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

  // Render: ungrouped steps at top → chapters at bottom (in chapter-list order).
  // A newly-created empty chapter naturally appears at the end of the timeline.
  const emitStep = (step) => {
    const idx      = flatIndex.get(step.id);
    const isActive   = step.id === activeId;
    const isExpanded = step.id === _expandedId;
    list.appendChild(_buildStepCard(step, idx, isActive, isExpanded, allSteps.length));
  };
  ungrouped.forEach(emitStep);
  allChapters.forEach((chapter, chIdx) => {
    list.appendChild(_buildChapterHeader(chapter, chIdx + 1));
    if (_isChapterVisuallyCollapsed(chapter, activeId)) return;
    (byChapter.get(chapter.id) || []).forEach(emitStep);
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
  if (_dragExpand.has(chapter.id)) return false;   // hover-over during drag
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
    'background:rgba(59,130,246,0.12)',
    'border:1px solid rgba(59,130,246,0.45)',
    'border-radius:6px',
    'color:#bfdbfe',
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
  name.style.color = '#dbeafe';
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

  const btnRename = _mkBtn('✎',  'Rename chapter');
  const btnDel    = _mkBtn('🗑', 'Delete chapter');
  btnRename.addEventListener('click', e => { e.stopPropagation(); _renameChapter(chapter.id); });
  btnDel.addEventListener('click',    e => { e.stopPropagation(); _deleteChapter(chapter.id); });

  wrap.append(badge, name, btnLock, btnRename, btnDel);

  // Right-click → chapter context menu (rename, copy, paste, lock, delete).
  wrap.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    _showChapterContextMenu(chapter, e.clientX, e.clientY);
  });

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
    _endDragExpand();
    wrap.style.opacity = '';
  });

  // ── Drop zone: accepts steps (into chapter) AND chapters (reorder) ────────
  wrap.addEventListener('dragover', e => {
    e.preventDefault();
    const side = _dragChapterId ? _dropSideFromEvent(wrap, e) : 'after';
    _setDropIndicator(wrap, side);
    // Hover-to-expand if chapter is visually collapsed and a step is being dragged.
    const activeIdNow = state.get('activeStepId');
    if (_dragId && !_expandTimer && _isChapterVisuallyCollapsed(chapter, activeIdNow)) {
      _expandTimer = setTimeout(() => {
        _dragExpand.add(chapter.id);
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

    if (_dragIds.length) {
      // Step(s) dropped on a chapter header → move into that chapter (top of it).
      const insertIdx = _chapterTopInsertIndex(chapter.id);
      if (_dragIds.length > 1) actions.moveStepsToChapter(_dragIds, chapter.id, insertIdx);
      else                      actions.moveStepToChapter(_dragIds[0], chapter.id, insertIdx);
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

function _endDragExpand() {
  if (_dragExpand.size) { _dragExpand.clear(); renderStepsPanel(); }
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

function _buildStepCard(step, idx, isActive, isExpanded, total) {
  const isSelected = _selectedIds.has(step.id);
  const card = document.createElement('div');
  card.className = [
    'stepItem',
    isActive    ? 'active'     : '',
    isSelected  ? 'selected'   : '',
    step.hidden ? 'hiddenStep' : '',
  ].filter(Boolean).join(' ');
  card.draggable      = true;
  card.dataset.stepId = step.id;
  card.style.marginBottom = '8px';

  // Top row identical in both states — except the thumbnail is hidden when
  // the card is expanded (per the original step-layout spec).
  card.appendChild(_buildStepTopCollapsed(step, idx, !isExpanded));

  if (isExpanded) {
    card.appendChild(_buildStepActionRow(step));
    card.appendChild(_buildTransitionRow(step));
  }

  // Right-click: if step is part of a multi-selection, show the multi menu;
  // otherwise replace selection with this step and show the single menu.
  card.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    if (_selectedIds.size > 1 && _selectedIds.has(step.id)) {
      _showMultiStepContextMenu(Array.from(_selectedIds), e.clientX, e.clientY);
    } else {
      _selectedIds = new Set([step.id]);
      renderStepsPanel();
      _showStepContextMenu(step, e.clientX, e.clientY);
    }
  });

  // Click semantics:
  //   Ctrl/Cmd-click → toggle in multi-selection (doesn't activate/expand)
  //   Shift-click    → extend selection to a range (visual order)
  //   plain click    → replace selection, activate + expand
  card.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey) {
      if (_selectedIds.has(step.id)) _selectedIds.delete(step.id);
      else                            _selectedIds.add(step.id);
      renderStepsPanel();
      return;
    }
    if (e.shiftKey && _selectedIds.size) {
      const all = (state.get('steps') || []).filter(s => !s.isBaseStep);
      const anchor = [..._selectedIds].pop();
      const a = all.findIndex(s => s.id === anchor);
      const b = all.findIndex(s => s.id === step.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) _selectedIds.add(all[i].id);
      }
      renderStepsPanel();
      return;
    }
    _selectedIds = new Set([step.id]);
    _expandedId  = step.id;
    steps.activateStep(step.id, true);
    renderStepsPanel();
  });

  // Double click → instant jump to final state (skips animation)
  card.addEventListener('dblclick', e => {
    e.stopPropagation();
    _selectedIds = new Set([step.id]);
    _expandedId  = step.id;
    steps.activateStep(step.id, false);
    renderStepsPanel();
  });

  // Drag-and-drop
  card.addEventListener('dragstart', e => {
    _dragChapterId = null;
    // If the dragged step is part of a multi-selection, drag the whole set.
    if (_selectedIds.has(step.id) && _selectedIds.size > 1) {
      _dragIds = Array.from(_selectedIds);
    } else {
      _dragIds = [step.id];            // single-step drag, leave selection untouched
    }
    _dragId = step.id;
    e.dataTransfer.effectAllowed = 'move';
    card.style.opacity = '0.5';
  });
  card.addEventListener('dragend', () => {
    _dragId  = null;
    _dragIds = [];
    _clearExpandTimer();
    _clearDropIndicators();
    _endDragExpand();
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
    if (_dragIds.length && !_dragIds.includes(step.id)) {
      const all   = state.get('steps') || [];
      let toIdx   = all.findIndex(s => s.id === step.id);
      if (toIdx < 0) return;
      if (side === 'after') toIdx += 1;
      const targetChapterId = step.chapterId ?? null;
      if (_dragIds.length > 1) {
        actions.moveStepsToChapter(_dragIds, targetChapterId, toIdx);
      } else {
        actions.moveStepToChapter(_dragIds[0], targetChapterId, toIdx);
      }
    }
  });

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

  btnCam.addEventListener('click',    e => { e.stopPropagation(); steps.saveStepCamera(step.id); setStatus('Camera saved for step.'); });
  btnHide.addEventListener('click',   e => { e.stopPropagation(); steps.setStepHidden(step.id, !step.hidden); });
  btnRename.addEventListener('click', e => { e.stopPropagation(); _renameStep(step.id); });
  btnDup.addEventListener('click',    e => { e.stopPropagation(); _duplicateStep(step.id); });
  btnDel.addEventListener('click',    e => { e.stopPropagation(); _deleteStep(step.id); });

  row.append(btnCam, btnHide, btnRename, btnDup, btnDel);
  return row;
}

/** Step top row: (optional) thumbnail + badge + name. No buttons. */
function _buildStepTopCollapsed(step, idx, showThumb = true) {
  const top = document.createElement('div');
  top.className = 'stepTop';
  top.style.cssText = 'display:flex;align-items:center;gap:8px;';

  // Thumbnail — live preview of the viewport when this step is active.
  // Hidden while the card is expanded (full controls take precedence).
  // Falls back to an em-dash placeholder if no frame has been captured yet.
  let thumb = null;
  if (!showThumb) {
    // skip — no thumbnail in expanded mode
  } else if (step.thumbnail) {
    thumb = document.createElement('img');
    thumb.src = step.thumbnail;
    thumb.className = 'stepThumb';
    thumb.style.cssText = [
      'flex:0 0 auto',
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
      'flex:0 0 auto',
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
  if (thumb) thumb.dataset.thumbStep = step.id;

  const badge = document.createElement('span');
  badge.className   = 'pill';
  badge.style.cssText = 'flex-shrink:0;font-weight:700;';
  badge.textContent = String(idx + 1).padStart(2, '0');

  const nameLbl = document.createElement('span');
  nameLbl.className   = 'stepName';
  nameLbl.style.flex  = '1';
  nameLbl.textContent = step.name || 'Unnamed Step';

  if (thumb) top.appendChild(thumb);
  top.append(badge, nameLbl);

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

// ── Step context menu (right-click on collapsed card) ───────────────────────

function _showStepContextMenu(step, x, y) {
  const items = [
    { label: 'Rename…',   action: () => _renameStep(step.id) },
    { label: 'Duplicate', action: () => _duplicateStep(step.id) },
    { label: 'Copy',      action: () => _copyStepsToClipboard([step.id]) },
  ];
  if (_clipboard?.kind === 'steps') {
    items.push({ label: `Paste under (${_clipboard.data.length})`, action: () => _pasteStepsUnder(step.id) });
  }
  items.push(
    { label: step.hidden ? 'Show in playback' : 'Hide from playback',
      action: () => steps.setStepHidden(step.id, !step.hidden) },
    { label: 'Update camera', action: () => { steps.saveStepCamera(step.id); setStatus('Camera saved for step.'); } },
    { separator: true },
    { label: 'Delete',    action: () => _deleteStep(step.id) },
  );
  showContextMenu(items, x, y);
}

/**
 * Right-click menu for a multi-selection. Rename + Duplicate are omitted —
 * they only make sense on a single step. Copy applies to the whole set.
 */
function _showMultiStepContextMenu(stepIds, x, y) {
  const stepsArr   = state.get('steps') || [];
  const selSteps   = stepIds.map(id => stepsArr.find(s => s.id === id)).filter(Boolean);
  const anyVisible = selSteps.some(s => !s.hidden);

  showContextMenu([
    { label: `Copy (${selSteps.length})`,
      action: () => _copyStepsToClipboard(stepIds) },
    { label: anyVisible ? 'Hide from playback' : 'Show in playback',
      action: () => selSteps.forEach(s => steps.setStepHidden(s.id, anyVisible)) },
    { label: 'Update camera',
      action: () => { selSteps.forEach(s => steps.saveStepCamera(s.id)); setStatus(`Camera saved for ${selSteps.length} steps.`); } },
    { separator: true },
    { label: `Delete (${selSteps.length})`,
      action: async () => {
        const ok = await _confirmDialog(`Delete ${selSteps.length} steps?`);
        if (!ok) return;
        for (const s of selSteps) actions.deleteStep(s.id);
        _selectedIds.clear();
        renderStepsPanel();
      } },
  ], x, y);
}

/** Right-click on a chapter header — copy / paste operate on the whole chapter block. */
function _showChapterContextMenu(chapter, x, y) {
  const items = [
    { label: 'Rename…', action: () => _renameChapter(chapter.id) },
    { label: 'Copy',    action: () => _copyChapterToClipboard(chapter.id) },
  ];
  if (_clipboard?.kind === 'chapter') {
    items.push({ label: 'Paste under', action: () => _pasteChapterUnder(chapter.id) });
  }
  if (_clipboard?.kind === 'steps') {
    items.push({ label: `Paste steps into chapter (${_clipboard.data.length})`,
                 action: () => _pasteStepsIntoChapter(chapter.id) });
  }
  items.push(
    { separator: true },
    { label: chapter.locked ? 'Unlock' : 'Lock open',
      action: () => actions.setChapterLocked(chapter.id, !chapter.locked) },
    { label: 'Delete', action: () => _deleteChapter(chapter.id) },
  );
  showContextMenu(items, x, y);
}

// ── Copy / paste clipboard operations ──────────────────────────────────────

function _cloneStep(step) {
  const copy = JSON.parse(JSON.stringify(step));
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
  _clipboard = { kind: 'steps', data: JSON.parse(JSON.stringify(picked)) };
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
  state.setState({ steps: newAll });
  steps.normalizeOrder();
  state.markDirty();
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
  state.setState({ steps: [...all, ...pasted] });
  steps.normalizeOrder();
  state.markDirty();
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

  state.setState({ chapters: newChapters, steps: newSteps });
  steps.normalizeOrder();
  state.markDirty();
  setStatus(`Pasted chapter "${newChapter.name}" with ${pastedSteps.length} step(s).`);
}

// ── Transition row ────────────────────────────────────────────────────────────

function _buildTransitionRow(step) {
  const t           = step.transition || {};
  const stepId      = step.id;
  const animPresets = state.get('animationPresets') || [];
  const stepPresetId   = t.animPresetId ?? null;
  const defaultPreset  = animPresets.find(p => p.isDefault);

  const wrap = document.createElement('div');
  wrap.className = 'card';
  wrap.style.cssText = 'margin-top:6px;font-size:12px;display:flex;flex-direction:column;gap:6px;';

  // Animation preset dropdown (no title / no description)
  const presetOptions = [
    `<option value="" ${!stepPresetId ? 'selected' : ''}>Default${defaultPreset ? ` (${_escStep(defaultPreset.name)})` : ''}</option>`,
    ...animPresets.map(p =>
      `<option value="${_escStep(p.id)}" ${stepPresetId === p.id ? 'selected' : ''}>${_escStep(p.name)}</option>`
    ),
  ].join('');

  // Easing dropdowns (no titles)
  const easingOptions = cur => ['smooth','linear','instant']
    .map(v => `<option value="${v}" ${(cur ?? 'smooth') === v ? 'selected' : ''}>${v[0].toUpperCase()+v.slice(1)}</option>`)
    .join('');

  wrap.innerHTML = `
    ${animPresets.length > 0 ? `<select class="tran-anim-preset">${presetOptions}</select>` : ''}
    <div class="grid2">
      <select class="tran-cam-ease">${easingOptions(t.cameraEasing)}</select>
      <select class="tran-obj-ease">${easingOptions(t.objectEasing)}</select>
    </div>
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox" class="tran-fade" ${t.visibilityFade !== false ? 'checked' : ''} />
      <span class="small muted">Fade visibility changes</span>
    </label>
  `;

  wrap.querySelector('.tran-anim-preset')?.addEventListener('change', e => {
    actions.updateTransition(stepId, { animPresetId: e.target.value || null });
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

  const allSteps  = state.get('steps') || [];
  const stepsIn   = allSteps.filter(s => s.chapterId === chapterId);
  const msg = stepsIn.length > 0
    ? `Delete chapter "${chapter.name}"?\n\nThis will also delete ${stepsIn.length} step(s) inside it.`
    : `Delete chapter "${chapter.name}"?`;
  const ok = await _confirmDialog(msg);
  if (!ok) return;

  const remainingSteps  = allSteps.filter(s => s.chapterId !== chapterId);
  const updatedChapters = chapters.filter(c => c.id !== chapterId);
  state.setState({ steps: remainingSteps, chapters: updatedChapters });
  steps.normalizeOrder();
  state.markDirty();
  setStatus(stepsIn.length > 0
    ? `Deleted chapter "${chapter.name}" and ${stepsIn.length} step(s).`
    : `Deleted chapter "${chapter.name}".`);
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
    // Explicit focus — <dialog> sometimes auto-focuses the first button
    // instead of the input, which eats the Enter keystroke.
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}
