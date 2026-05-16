/**
 * SBS — Animation Tab
 * ====================
 * Renders the animation presets list in the left sidebar.
 * Presets define phased step transitions using the animation string syntax:
 *   'camera(500), color(300), obj+visibility(400)'
 *
 * The expanded preset card has TWO views of the same phase data:
 *   1. The animation-string textarea (power-user, free-form)
 *   2. The visual phase list — capsule rows, one per phase, with each
 *      channel as a chip
 *
 * In B2 (this revision) the visual view is read-only — it parses the
 * current string and renders. B3 will add drag-drop between phases.
 */

import { state }            from '../core/state.js';
import * as actions         from '../systems/actions.js';
import {
  parseAnimation,
  parseAnimationForEdit,
  serializePhasesForEdit,
  normalizeStringForCompare,
  similarityScore,
} from '../systems/animation.js';
import { showContextMenu }  from './context-menu.js';
import * as userSettings    from '../core/user-settings.js';
import { setStatus }        from './status.js';

let _expandedId = null;

// Animation-string textarea collapsed by default per preset. Set membership
// = "expanded"; absence = "collapsed". User toggles by clicking the
// section header.
const _stringExpanded = new Set();

// Channel chip metadata. Order here drives the visual sort INSIDE a phase
// so users see a stable left-to-right layout regardless of how the string
// happened to list types. The label is rendered after the icon.
// `pause` is INTENTIONALLY not in this map — it isn't a draggable
// capsule any more. Pauses are now expressed as "empty phases" the user
// adds via the "+ Add pause" button. The animation string still uses
// `pause(N)` tokens to represent them (see serializePhasesForEdit) — the
// engine treats pause as a regular channel, but the visual editor hides
// it as a chip and shows the row as an empty-with-pause-hint phase.
const CHANNEL_META = {
  camera:    { icon: '📷', label: 'camera'    },
  visibility:{ icon: '👁',  label: 'visibility'},
  obj:       { icon: '📦', label: 'obj'       },
  color:     { icon: '🎨', label: 'color'     },
  // overlay (classic crossfade) and overlays (sustained no-flicker) are
  // the SAME logical channel — the chip toggles between them via right-
  // click. Different icons so the user can tell at a glance which mode
  // is active without reading the label.
  overlay:   { icon: '🖍️', label: 'overlay'   },   // crayon = "blunt" classic crossfade (shared items dip)
  overlays:  { icon: '✏️', label: 'overlays'  },   // pencil = "precise" sustained (shared items stay solid)
  cable:     { icon: '🔌', label: 'cable'     },
  narration: { icon: '👄', label: 'narration' },
  notes:     { icon: '📝', label: 'notes'     },
  shape:     { icon: '⬜', label: 'shape'     },
};
const CHANNEL_ORDER = Object.keys(CHANNEL_META);

/**
 * Render the animation tab into the given container element.
 * Called on init and whenever animationPresets state changes.
 *
 * @param {HTMLElement} container  #tab-panel-animation
 */
export function renderAnimationTab(container) {
  if (!container) return;
  const presets = state.get('animationPresets') || [];

  container.innerHTML = `
    <div class="section">
      <div class="title">Animation</div>
      <div class="small muted" style="margin-top:6px;line-height:1.6">
        Define named animation presets for step transitions.<br>
        Each phase runs sequentially. Types inside a phase run simultaneously.
      </div>

      <div class="card" style="margin-top:10px;font-size:11px;line-height:1.8;color:#94a3b8">
        <code style="display:block">camera(500), color(300)</code>
        <span>→ camera moves first, then colors change</span>
        <code style="display:block;margin-top:4px">obj+visibility(400)</code>
        <span>→ objects move and visibility fades simultaneously</span>
      </div>

      <div style="margin-top:10px;display:flex;gap:6px">
        <button class="btn" id="btn-add-anim" style="flex:1">+ New Preset</button>
        <button class="btn" id="btn-from-collection" style="flex:1"
                title="Import a preset from your personal collection (stored in user settings, cross-project).">+ From collection</button>
      </div>

      <div id="anim-list" style="margin-top:8px"></div>
    </div>
  `;

  container.querySelector('#btn-add-anim').addEventListener('click', () => {
    const p = actions.createAnimPreset('Animation ' + (presets.length + 1));
    _expandedId = p.id;
    renderAnimationTab(container);
  });

  container.querySelector('#btn-from-collection').addEventListener('click', () => {
    _openCollectionPicker(container);
  });

  _renderList(container.querySelector('#anim-list'), presets, container);
}

// ─── Preset list ─────────────────────────────────────────────────────────────

function _renderList(listEl, presets, container) {
  if (!presets.length) {
    listEl.innerHTML = '<div class="small muted">No presets yet. Steps use global durations.</div>';
    return;
  }

  listEl.innerHTML = '';

  for (const preset of presets) {
    const expanded    = _expandedId === preset.id;
    const parsed      = parseAnimation(preset.animation);
    const phaseSummary = parsed
      ? parsed.map(p => `${p.types.join('+')}(${p.durationMs})`).join(' → ')
      : '(invalid)';

    const row = document.createElement('div');
    row.style.marginBottom = '4px';
    // Name is an inline INPUT — editable any time, doubles as the row's
    // display label. Clicking the input doesn't toggle expand/collapse.
    row.innerHTML = `
      <div class="colorRow${expanded ? ' selected' : ''}" style="cursor:pointer;gap:6px;align-items:center">
        <span class="anim-row-default" title="${preset.isDefault ? 'Project default' : 'Click to set as project default'}"
              style="font-size:14px;flex-shrink:0;cursor:pointer;${preset.isDefault ? 'color:#fbbf24' : 'opacity:0.3'}">★</span>
        <input class="anim-row-name" data-name-preset="${_esc(preset.id)}"
               type="text" value="${_esc(preset.name)}"
               style="flex:1;min-width:0;border:1px solid transparent;background:transparent;color:var(--text);
                      font-size:13px;padding:2px 4px;border-radius:4px"
               title="Click to expand + rename" />
        <span class="anim-row-summary" style="font-size:10px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;color:var(--text);opacity:0.7"
              title="${_esc(phaseSummary)}">${_esc(phaseSummary)}</span>
      </div>
    `;

    // Click anywhere on row (except inputs/star) → toggle expand
    row.querySelector('.colorRow').addEventListener('click', (e) => {
      const t = (e.target?.tagName || '').toUpperCase();
      if (t === 'INPUT' || e.target.classList.contains('anim-row-default')) return;
      _expandedId = expanded ? null : preset.id;
      renderAnimationTab(container);
    });

    // ★ click → toggle default
    row.querySelector('.anim-row-default').addEventListener('click', (e) => {
      e.stopPropagation();
      if (preset.isDefault) actions.updateAnimPreset(preset.id, { isDefault: false });
      else                  actions.setDefaultAnimPreset(preset.id);
    });

    // Right-click → ADD to user collection. Always opens the rename +
    // similarity-guard dialog (Coll-B). Two independent blocks:
    //   • NAME conflict → blocked with auto-suggested unique name
    //   • STRUCTURE conflict → soft warning + "Update existing" option
    // The two are separate concerns: same name doesn't imply same
    // structure, and same structure doesn't imply same name.
    row.querySelector('.colorRow').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu([
        {
          label: `★ Add "${preset.name}" to my collection…`,
          action: () => _openAddToCollectionDialog(preset),
        },
      ], e.clientX, e.clientY);
    });

    // Name commit on change/blur — preserves focus until user leaves
    const nameInput = row.querySelector('.anim-row-name');
    // Clicking the name field expands the row AND keeps focus in the
    // input ready for editing. If the row is already expanded, clicking
    // does nothing (caret stays where it is).
    nameInput.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_expandedId !== preset.id) {
        _expandedId = preset.id;
        renderAnimationTab(container);
        // After re-render, find the new (different DOM) input and focus it.
        setTimeout(() => {
          const fresh = container.querySelector(`[data-name-preset="${preset.id}"]`);
          if (fresh) { fresh.focus(); fresh.select(); }
        }, 0);
      }
    });
    nameInput.addEventListener('focus', () => {
      nameInput.style.borderColor = 'var(--line)';
      nameInput.style.background  = 'var(--panel)';
    });
    nameInput.addEventListener('blur', () => {
      nameInput.style.borderColor = 'transparent';
      nameInput.style.background  = 'transparent';
    });
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v && v !== preset.name) actions.updateAnimPreset(preset.id, { name: v });
    });

    listEl.appendChild(row);

    if (expanded) {
      listEl.appendChild(_buildEditPane(preset, presets, container));
    }
  }
}

// ─── Expanded edit card ───────────────────────────────────────────────────────

function _buildEditPane(preset, presets, container) {
  const stringExpanded = _stringExpanded.has(preset.id);

  const pane = document.createElement('div');
  pane.className = 'card';
  pane.style.marginBottom = '8px';

  pane.innerHTML = `
    <!-- 1. DEFAULT toggle (at the very top, under the row's editable name) -->
    <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
      <input type="checkbox" class="ap-default" ${preset.isDefault ? 'checked' : ''} />
      <span style="color:var(--text);font-size:13px">Use as project default</span>
    </label>
    <div style="margin-top:3px;padding-left:22px;font-size:11px;color:var(--text);opacity:0.7">
      All steps use this preset unless overridden per-step.
    </div>

    <!-- 2. Animation string — collapsed by default. Header shows preview;
         click to expand the textarea for power-user editing. -->
    <div class="ap-string-section" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">
      <div class="ap-string-toggle" style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text);font-size:12px"
           title="Click to ${stringExpanded ? 'collapse' : 'expand'} the raw animation string">
        <span style="opacity:0.65;font-size:10px;width:14px">${stringExpanded ? '▾' : '▸'}</span>
        <span style="font-weight:600">Animation string</span>
        ${stringExpanded ? '' : `
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.7;font-family:monospace;font-size:11px">${_esc(preset.animation)}</span>
        `}
      </div>
      ${stringExpanded ? `
        <textarea class="ap-anim" rows="2" wrap="soft"
                  style="margin-top:6px;width:100%;box-sizing:border-box;padding:8px 10px;font-family:monospace;font-size:13px;line-height:1.4;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:8px;caret-color:#f59e0b;resize:vertical;min-height:44px"
                  placeholder="camera(AL1), color(500), visibility(AL2), obj(AL2)">${_esc(preset.animation)}</textarea>
        <div class="ap-validation" style="margin-top:5px;font-size:11px"></div>
      ` : ''}
    </div>

    <!-- 3. Visual phase editor -->
    <div class="ap-phases" style="margin-top:10px"></div>

    <div style="display:flex;justify-content:flex-end;margin-top:12px">
      <button class="btn ap-del" title="Delete preset">🗑 Delete</button>
    </div>
  `;

  // Initial render
  if (stringExpanded) {
    _updateValidation(pane.querySelector('.ap-validation'), preset.animation);
  }
  _renderPhasesView(pane.querySelector('.ap-phases'), preset);

  // String section: click header to toggle
  pane.querySelector('.ap-string-toggle').addEventListener('click', () => {
    if (stringExpanded) _stringExpanded.delete(preset.id);
    else                _stringExpanded.add(preset.id);
    renderAnimationTab(container.closest('[id^="tab-panel"]') || container);
  });

  // Textarea (only present when expanded)
  const animInput = pane.querySelector('.ap-anim');
  if (animInput) {
    animInput.addEventListener('input', e => {
      _updateValidation(pane.querySelector('.ap-validation'), e.target.value);
      _renderPhasesView(pane.querySelector('.ap-phases'), {
        ...preset,
        animation: e.target.value,
      });
    });
    animInput.addEventListener('change', e => {
      const val = e.target.value.trim();
      if (val) actions.updateAnimPreset(preset.id, { animation: val });
    });
  }

  pane.querySelector('.ap-default').addEventListener('change', e => {
    if (e.target.checked) actions.setDefaultAnimPreset(preset.id);
    else                  actions.updateAnimPreset(preset.id, { isDefault: false });
  });

  pane.querySelector('.ap-del').addEventListener('click', () => {
    if (!confirm(`Delete animation preset "${preset.name}"?\nSteps using this preset will revert to default.`)) return;
    _expandedId = null;
    actions.deleteAnimPreset(preset.id);
    renderAnimationTab(container.closest('[id^="tab-panel"]') || container);
  });

  return pane;
}

/**
 * Render the visual phase editor for a preset. Each phase is a row with
 * a collapsible header (phase number, duration control) and a body of
 * channel chips. Chips can be dragged between phases (HTML5 DnD). The
 * +Add phase button appends an empty phase (renders as `pause`).
 *
 * State lives in the preset's animation string. Every mutation:
 *   1. Parses the current string into structured phases
 *   2. Mutates the phases array
 *   3. Serialises back to a string via serializePhasesForEdit
 *   4. Commits via actions.updateAnimPreset
 *
 * No local copy of the phases is held — re-parsing on every change keeps
 * the textarea and the visual editor automatically in sync (textarea
 * commits trigger renderAnimationTab → which re-parses for visual).
 */
function _renderPhasesView(host, preset) {
  if (!host) return;
  const parsed = parseAnimationForEdit(preset.animation);

  if (!parsed) {
    host.innerHTML = `
      <div style="color:#f87171;padding:6px 0;font-size:13px">
        ✗ Animation string is invalid — fix the textarea above to see phases.
      </div>`;
    return;
  }

  // Resolve AL token to ms for the "total" display (purely informational)
  const resolveAL = (tok) => {
    if (tok === 'AL1') return state.get('cameraAnimDurationMs') ?? 1500;
    if (tok === 'AL2') return state.get('objectAnimDurationMs')  ?? 1500;
    const n = parseInt(tok, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const totalDur = parsed.reduce((s, p) => s + resolveAL(p.durationRaw), 0);

  // Total shown in seconds (1 decimal) — "3.2 sec" reads faster than
  // "3200ms" once the user is composing real animations. Header text
  // uses var(--text) at full opacity so it's readable in BOTH light
  // and dark modes (was pale grey in light mode before).
  const totalSec = (totalDur / 1000).toFixed(1);
  const headerHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:13px;color:var(--text);font-weight:600">
      <span>Time blocks (${parsed.length})</span>
      <span style="font-size:12px;font-weight:500">total ${totalSec} sec</span>
    </div>`;

  // One row per time block — 3-column layout (light-mode safe via CSS vars):
  //   col 1: drag handle ⋮  (just the dots — block number removed per UX
  //                          request; row order is visible already)
  //   col 2: combined duration field — text input + ▼ picker. Typing
  //          digits sets a custom ms value; ▼ opens a popup to pick AL1
  //          / AL2 / Custom.
  //   col 3: chip flow (drop targets for inter-block chip moves)
  //
  // A "pause time block" = phase containing only `pause` channel. These
  // get an orange tint and reject chip drops via the drop handler.
  // An "empty time block" (types=[]) is a transient state before the
  // user drops chips in. Both serialize as pause(N) — see
  // serializePhasesForEdit.
  const rowsHtml = parsed.map((phase, idx) => {
    const phaseTypes = new Set(phase.types);
    const orderedTypes = CHANNEL_ORDER.filter(t => phaseTypes.has(t));
    for (const t of phase.types) {
      if (!CHANNEL_ORDER.includes(t)) orderedTypes.push(t);
    }
    const isPauseBlock = phase.types.length === 1 && phase.types[0] === 'pause';

    const durRaw     = phase.durationRaw || 'AL1';
    const durDisplay = /^AL[12]$/i.test(durRaw) ? durRaw.toUpperCase() : durRaw;

    // Combined duration field: text input + ▼ button. Sized just wide
    // enough for "99999" (5 digits) — the practical max anyone needs
    // is well under 100s. All colours via CSS vars for light/dark
    // parity.
    const durControlHtml = `
      <div class="cap-dur" style="display:inline-flex;align-items:center;
                                   border:1px solid var(--line);border-radius:4px;
                                   background:var(--panel)">
        <input class="cap-dur-input" data-phase-idx="${idx}"
               type="text" maxlength="5"
               value="${_esc(durDisplay)}"
               style="width:36px;padding:2px 2px;font-size:11px;
                      background:transparent;color:var(--text);
                      border:none;outline:none;text-align:center"
               title="Type a number (ms) for custom, or use ▼ to pick AL1/AL2/Custom" />
        <button class="cap-dur-picker" data-phase-idx="${idx}"
                type="button"
                style="background:none;border:none;color:var(--text);
                       cursor:pointer;padding:0 3px;font-size:9px;
                       opacity:0.7"
                title="Pick AL1 / AL2 / Custom">▼</button>
      </div>`;

    const chipsHtml = orderedTypes.map(t => {
      const meta = CHANNEL_META[t] || { icon: '•', label: t };
      return `
        <span class="cap-chip"
              draggable="true"
              data-phase-idx="${idx}" data-channel="${_esc(t)}"
              style="display:inline-flex;align-items:center;gap:5px;
                     padding:3px 9px;margin:2px;
                     background:rgba(56,189,248,0.12);
                     border:1px solid rgba(56,189,248,0.4);
                     border-radius:999px;font-size:13px;line-height:1.2;
                     white-space:nowrap;cursor:grab;
                     color:var(--text);user-select:none"
              title="Drag to move to another phase">
          <span>${meta.icon}</span><span>${_esc(meta.label)}</span>
        </span>`;
    }).join('');

    const bodyHtml = orderedTypes.length
      ? chipsHtml
      : (isPauseBlock
          ? `<span style="font-style:italic;padding:0 4px;color:#7c2d12;font-size:12px;font-weight:600">⏸ pause time block</span>`
          : `<span style="font-style:italic;padding:0 4px;color:var(--text);opacity:0.65;font-size:12px">drop a channel here</span>`);

    // Pause blocks get an orange tint so the user sees them as
    // structurally different from a channel time block.
    const rowBg     = isPauseBlock ? 'rgba(251,146,60,0.22)'  : 'rgba(100,116,139,0.18)';
    const rowBorder = isPauseBlock ? 'rgba(251,146,60,0.55)'  : 'var(--line)';

    return `
      <div class="cap-phase-row ${isPauseBlock ? 'cap-phase-pause' : ''}" data-phase-idx="${idx}"
           data-is-pause="${isPauseBlock ? '1' : '0'}"
           draggable="true"
           style="display:grid;
                  grid-template-columns:20px 62px 1fr;
                  align-items:center;column-gap:6px;
                  border:1px solid ${rowBorder};border-radius:6px;
                  padding:4px 6px;margin-bottom:4px;
                  background:${rowBg};
                  color:var(--text);
                  min-height:28px"
           title="Drag this row to reorder. Right-click to remove the time block.">
        <span class="cap-phase-handle"
              style="display:inline-flex;align-items:center;justify-content:center;
                     cursor:grab;font-size:16px;color:var(--text);opacity:0.55;
                     user-select:none;padding:0">
          ⋮
        </span>
        ${durControlHtml}
        <div class="cap-phase-body"
             data-phase-idx="${idx}"
             data-is-pause="${isPauseBlock ? '1' : '0'}"
             style="display:flex;flex-wrap:wrap;align-items:center;
                    min-height:24px;color:var(--text)">
          ${bodyHtml}
        </div>
      </div>`;
  }).join('');

  // + Add time block / + Add pause buttons.
  //   + Add time block → empty phase (types:[]) waiting for chip drops.
  //                      It becomes pause(N) in the string until chips
  //                      land — at which point it's a real channel phase.
  //   + Add pause      → pause phase (types:['pause']) — orange-tinted,
  //                      rejects chip drops (you can't drag channels INTO
  //                      a declared pause). User can convert it by
  //                      dragging a chip in if they change their mind —
  //                      the serializer drops pause when other channels
  //                      arrive (see parseAnimation / serializePhasesForEdit).
  // Button text color #0c4a6e (sky-900) reads in both light and dark.
  const addButtonsHtml = `
    <div style="display:flex;gap:6px;margin-top:6px">
      <button class="cap-add-phase"
              style="flex:1;padding:6px 10px;font-size:12px;
                     background:rgba(56,189,248,0.22);
                     border:1px dashed rgba(56,189,248,0.65);
                     border-radius:6px;color:#0c4a6e;cursor:pointer;
                     font-weight:600"
              title="Append an empty time block. Drag channel chips into it to populate.">
        + Add time block
      </button>
      <button class="cap-add-pause"
              style="flex:1;padding:6px 10px;font-size:12px;
                     background:rgba(251,146,60,0.22);
                     border:1px dashed rgba(251,146,60,0.65);
                     border-radius:6px;color:#7c2d12;cursor:pointer;
                     font-weight:600"
              title="Append a pause time block — a time spacer with no channels.">
        + Add pause
      </button>
    </div>`;

  host.innerHTML = headerHtml + rowsHtml + addButtonsHtml;

  // ── Wiring ────────────────────────────────────────────────────────────

  // Duration combined field: text input (custom ms) + ▼ picker for AL tokens.
  host.querySelectorAll('.cap-dur-input').forEach(inp => {
    inp.addEventListener('click', (e) => { e.stopPropagation(); });
    inp.addEventListener('change', () => {
      const idx = Number(inp.dataset.phaseIdx);
      const raw = inp.value.trim().toUpperCase();
      // Three valid forms: AL1, AL2, or digits-only.
      let next = null;
      if (/^AL[12]$/.test(raw)) {
        next = raw;
      } else {
        const v = parseInt(raw, 10);
        if (Number.isFinite(v) && v >= 0 && v <= 99999) next = String(v);
      }
      if (next === null) {
        // Revert to current value
        const cur = parseAnimationForEdit(preset.animation)?.[idx]?.durationRaw || 'AL1';
        inp.value = cur;
        return;
      }
      _mutatePhases(preset, phases => {
        if (phases[idx]) phases[idx].durationRaw = next;
      });
    });
    // Keep input numeric-ish on the fly (allow AL letters too)
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/[^0-9AaLl]/g, '').slice(0, 5);
    });
  });

  host.querySelectorAll('.cap-dur-picker').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const idx  = Number(btn.dataset.phaseIdx);
      const rect = btn.getBoundingClientRect();
      showContextMenu([
        { label: 'AL1', action: () => _mutatePhases(preset, ph => { if (ph[idx]) ph[idx].durationRaw = 'AL1'; }) },
        { label: 'AL2', action: () => _mutatePhases(preset, ph => { if (ph[idx]) ph[idx].durationRaw = 'AL2'; }) },
        {
          label: 'Custom…',
          action: () => {
            // If currently on an AL token, seed with its resolved ms value
            // so the input has something useful when the user starts
            // editing. Otherwise leave the existing custom number alone.
            _mutatePhases(preset, ph => {
              if (!ph[idx]) return;
              const cur = ph[idx].durationRaw;
              if (cur === 'AL1') ph[idx].durationRaw = String(state.get('cameraAnimDurationMs') ?? 1500);
              else if (cur === 'AL2') ph[idx].durationRaw = String(state.get('objectAnimDurationMs') ?? 1500);
              // else: already custom — leave as-is
            });
            // Focus + select the input so user can immediately type
            setTimeout(() => {
              const inp = host.querySelector(`.cap-dur-input[data-phase-idx="${idx}"]`);
              if (inp) { inp.focus(); inp.select(); }
            }, 0);
          },
        },
      ], rect.left, rect.bottom + 2);
    });
  });

  // + Add time block — empty CHANNEL block (placeholder). Serialises as
  // `null(0)`, contributes 0ms to the animation. When the user drops
  // their first chip in, the drop handler bumps the duration to AL1.
  // If the user later drags the last chip out, the row auto-deletes
  // (see the drop handler) — there's no "empty channel block" lingering
  // around. The only way to create an explicit pause is "+ Add pause".
  host.querySelector('.cap-add-phase')?.addEventListener('click', () => {
    _mutatePhases(preset, phases => {
      phases.push({ types: [], durationRaw: '0' });
    });
  });
  // + Add pause — explicit pause block (types:['pause']). Orange tint,
  // rejects chip drops. Default duration AL1 (user can change).
  host.querySelector('.cap-add-pause')?.addEventListener('click', () => {
    _mutatePhases(preset, phases => {
      phases.push({ types: ['pause'], durationRaw: 'AL1' });
    });
  });

  // Drag-source: chip
  host.querySelectorAll('.cap-chip').forEach(chip => {
    chip.addEventListener('dragstart', (e) => {
      const payload = {
        fromPhase: Number(chip.dataset.phaseIdx),
        channel:   chip.dataset.channel,
      };
      e.dataTransfer.setData('application/x-sbs-chip', JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'move';
      chip.style.opacity = '0.4';
      e.stopPropagation();   // don't also start a phase-row drag
    });
    chip.addEventListener('dragend', () => { chip.style.opacity = ''; });

    // overlay <-> overlays mode toggle (right-click on the overlay chip).
    // Both tokens drive the same channel slot in the engine; they differ
    // only in WHICH crossfade algorithm runs (classic vs sustained).
    // Description + toggle live in a context menu so the user discovers
    // the mode without it cluttering the row.
    const channel = chip.dataset.channel;
    if (channel === 'overlay' || channel === 'overlays') {
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(chip.dataset.phaseIdx);
        const isSustained = channel === 'overlays';
        const desc = isSustained
          ? [
              '✏️  SUSTAINED  (current)',
              'New layer fades IN over the old',
              'layer, THEN old fades OUT.',
              'Items shared between steps stay',
              'at 100% — no flicker.',
            ]
          : [
              '🖍️  CLASSIC CROSSFADE  (current)',
              'Old and new layers fade SIMULTANEOUSLY.',
              'Shared items dip to ~50% mid-fade',
              'then climb back — visible flicker',
              'on items that appear in both steps.',
            ];
        const swapTo = isSustained ? 'overlay' : 'overlays';
        const swapFrom = channel;
        showContextMenu([
          ...desc.map(line => ({ label: line, disabled: true })),
          { separator: true },
          {
            label: isSustained
              ? '🖍️ Switch to classic crossfade'
              : '✏️ Switch to sustained (no flicker)',
            action: () => {
              _mutatePhases(preset, phases => {
                const ph = phases[idx];
                if (!ph) return;
                ph.types = ph.types.map(t => t === swapFrom ? swapTo : t);
              });
            },
          },
        ], e.clientX, e.clientY);
      });
    }
  });

  // Drag-source: phase row (for reorder). The chip's dragstart calls
  // stopPropagation so dragging a chip doesn't also fire the row's
  // dragstart. Dragging anywhere ELSE in the row → fires here.
  host.querySelectorAll('.cap-phase-row').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      // Filter: ignore drags originating inside form controls so the
      // user can still interact with the input / picker button.
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'OPTION' || tag === 'BUTTON') {
        e.preventDefault();
        return;
      }
      const payload = { fromIdx: Number(row.dataset.phaseIdx) };
      e.dataTransfer.setData('application/x-sbs-phase', JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'move';
      row.style.opacity = '0.5';
    });
    row.addEventListener('dragend', () => { row.style.opacity = ''; });

    // Right-click → Remove phase (only if more than one phase exists).
    // Removed phase's channels dump into the NEXT phase (or the previous
    // one if the removed phase is the last). The invariant "every
    // channel is in exactly one phase" stays preserved.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentPhases = parseAnimationForEdit(preset.animation);
      if (!currentPhases || currentPhases.length <= 1) return;   // only phase — no remove
      const idx = Number(row.dataset.phaseIdx);
      showContextMenu([
        {
          label: '🗑 Remove time block',
          action: () => _removePhase(preset, idx),
        },
      ], e.clientX, e.clientY);
    });
  });

  // Drop target: time block body — accepts CHIPS.
  // PAUSE blocks (data-is-pause="1") reject drops outright: the
  // dragover doesn't preventDefault, so dropEffect stays 'none' and
  // the chip springs back to the source. This is the visual contract
  // for "pause blocks can't hold channels".
  host.querySelectorAll('.cap-phase-body').forEach(body => {
    const isPause = body.dataset.isPause === '1';
    body.addEventListener('dragover', (e) => {
      const hasChip = e.dataTransfer.types.includes('application/x-sbs-chip');
      if (!hasChip) return;
      if (isPause) {
        // Visual cue: red-tint outline + cursor:no-drop. Don't preventDefault
        // so the drop is rejected by default.
        body.style.outline = '2px dashed rgba(239,68,68,0.6)';
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.style.outline = '2px dashed rgba(56,189,248,0.6)';
    });
    body.addEventListener('dragleave', () => { body.style.outline = ''; });
    body.addEventListener('drop', (e) => {
      body.style.outline = '';
      if (isPause) return;                  // explicit pause = no drops
      const raw = e.dataTransfer.getData('application/x-sbs-chip');
      if (!raw) return;
      e.preventDefault();
      let payload; try { payload = JSON.parse(raw); } catch { return; }
      const toPhase = Number(body.dataset.phaseIdx);
      if (toPhase === payload.fromPhase) return;   // same phase — no-op
      _mutatePhases(preset, phases => {
        const src = phases[payload.fromPhase];
        const dst = phases[toPhase];

        if (src) {
          src.types = src.types.filter(t => t !== payload.channel);
        }
        if (dst && !dst.types.includes(payload.channel)) {
          // First chip landing in an empty placeholder bumps its
          // duration from the no-op `null(0)` placeholder up to AL1.
          // The user can then change it via the dropdown / input.
          if (dst.types.length === 0 && dst.durationRaw === '0') {
            dst.durationRaw = 'AL1';
          }
          dst.types.push(payload.channel);
        }
        // Auto-delete the source block if dragging out its last chip
        // emptied it (and it's not a pause block — pause blocks were
        // never drop-source candidates because they have no chips).
        // This preserves the rule: empty channel blocks only exist as
        // a transient placeholder created via "+ Add time block".
        if (src && src.types.length === 0) {
          phases.splice(payload.fromPhase, 1);
        }
      });
    });
  });

  // Drop target: phase row — accepts PHASES (reorder).
  // Insert ABOVE the target if the pointer is in the top half, BELOW
  // otherwise. Visual indicator: top/bottom border highlight.
  host.querySelectorAll('.cap-phase-row').forEach(row => {
    row.addEventListener('dragover', (e) => {
      const hasPhase = e.dataTransfer.types.includes('application/x-sbs-phase');
      if (!hasPhase) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = row.getBoundingClientRect();
      const insertAbove = (e.clientY - r.top) < (r.height / 2);
      row.style.boxShadow = insertAbove
        ? 'inset 0 3px 0 #38bdf8'    // top edge bar
        : 'inset 0 -3px 0 #38bdf8';  // bottom edge bar
    });
    row.addEventListener('dragleave', () => { row.style.boxShadow = ''; });
    row.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('application/x-sbs-phase');
      if (!raw) return;
      e.preventDefault();
      row.style.boxShadow = '';
      let payload; try { payload = JSON.parse(raw); } catch { return; }
      const fromIdx = payload.fromIdx;
      const toIdx   = Number(row.dataset.phaseIdx);
      if (fromIdx === toIdx) return;
      const r = row.getBoundingClientRect();
      const insertAbove = (e.clientY - r.top) < (r.height / 2);
      _mutatePhases(preset, phases => {
        if (fromIdx < 0 || fromIdx >= phases.length) return;
        const [moving] = phases.splice(fromIdx, 1);
        // Re-compute target index after the splice
        let target = toIdx;
        if (toIdx > fromIdx) target = toIdx - 1;
        if (!insertAbove) target += 1;
        target = Math.max(0, Math.min(phases.length, target));
        phases.splice(target, 0, moving);
      });
    });
  });
}

/**
 * Remove a phase, dumping its channels into the next phase (or the
 * previous one if the removed phase is the last). Preserves the
 * "every channel exactly once" invariant. Caller is responsible for
 * not calling this when phases.length === 1.
 */
function _removePhase(preset, idx) {
  _mutatePhases(preset, phases => {
    if (phases.length <= 1) return;
    if (idx < 0 || idx >= phases.length) return;
    const removed = phases.splice(idx, 1)[0];
    const channels = removed?.types || [];
    // Pick recipient: next phase if it exists (now at the same index
    // post-splice), otherwise the new last phase (the one before).
    const recipient = phases[idx] || phases[phases.length - 1];
    if (!recipient) return;
    for (const ch of channels) {
      if (!recipient.types.includes(ch)) recipient.types.push(ch);
    }
  });
}

/**
 * Mutate phases in place via the given fn, serialise back to the
 * animation string, commit via actions. Triggers the state subscription
 * which re-renders the whole tab — keeping the textarea + visual editor
 * + step-panel preview all in sync.
 */
function _mutatePhases(preset, mutateFn) {
  const phases = parseAnimationForEdit(preset.animation);
  if (!phases) return;
  mutateFn(phases);
  // Clean up: drop trailing phases that are pure pause if the entire
  // string would otherwise be empty. (Currently allow any number of
  // pause phases — user-authored dwells are intentional.)
  const newStr = serializePhasesForEdit(phases);
  if (newStr && newStr !== preset.animation) {
    actions.updateAnimPreset(preset.id, { animation: newStr });
  }
}

function _updateValidation(el, str) {
  if (!el) return;
  const parsed = parseAnimation(str);
  if (!str?.trim()) {
    el.textContent = '';
    el.style.color = '';
    return;
  }
  if (parsed) {
    const totalMs = parsed.reduce((s, p) => s + p.durationMs, 0);
    el.innerHTML = `<span style="color:#86efac">✓ ${parsed.length} phase${parsed.length === 1 ? '' : 's'} · ${totalMs}ms total</span>`;
  } else {
    el.innerHTML = '<span style="color:#f87171">✗ Invalid — use format: camera(500), color(300)</span>';
  }
}


// ── User-collection (cross-project preset library) ───────────────────────────
//
// Stored at userSettings.animation.collection as Array<{ name, animation }>.
// Entries are deduplicated by NAME — adding a preset whose name already
// exists overwrites the stored animation string. The "messy users" case
// (same name, different strings) is intentionally not policed; whichever
// add is most recent wins.

function _getCollection() {
  const arr = userSettings.get()?.animation?.collection;
  return Array.isArray(arr) ? arr : [];
}

function _isInCollection(preset) {
  return _getCollection().some(c => c.name === preset.name);
}

/**
 * Find collection entries that match this preset:
 *   • exact  — same NORMALISED structure (custom ms values ignored). 1.00 score.
 *   • close  — score > 0.66 but not exact (different AL tokens, partial overlap).
 * Both lists already filter OUT the entry that has the EXACT same name as
 * the preset (that's handled by the name-uniqueness check separately).
 *
 * Each returned entry: { name, animation, score }
 */
function _findCollectionMatches(preset) {
  const list = _getCollection();
  const exact = [];
  const close = [];
  for (const c of list) {
    const s = similarityScore(preset.animation, c.animation);
    if (s >= 1) exact.push({ ...c, score: s });
    else if (s > 0.66) close.push({ ...c, score: s });
  }
  // Sort close-matches by score descending
  close.sort((a, b) => b.score - a.score);
  return { exact, close };
}

/** Returns true if `name` is already used by another collection entry. */
function _nameInCollection(name) {
  return _getCollection().some(c => c.name === name);
}

/** Generate a unique variant: "X" → "X (2)" / "X (3)" / … */
function _suggestUniqueName(baseName) {
  if (!_nameInCollection(baseName)) return baseName;
  let n = 2;
  while (_nameInCollection(`${baseName} (${n})`)) n++;
  return `${baseName} (${n})`;
}

/**
 * Replace a collection entry by name (in-place value swap).
 */
async function _replaceInCollection(targetName, newEntry) {
  const list = _getCollection();
  const idx  = list.findIndex(c => c.name === targetName);
  if (idx < 0) return false;
  const next = [...list];
  next[idx] = newEntry;
  await userSettings.patch({ animation: { collection: next } });
  return true;
}

/**
 * Append a new entry to the collection. Caller must verify the name is
 * unique first (use _nameInCollection / _suggestUniqueName).
 */
async function _appendToCollection(entry) {
  const list = _getCollection();
  await userSettings.patch({ animation: { collection: [...list, entry] } });
}

/**
 * Modal dialog: "Add to my collection".
 *
 * Two distinct dialog shapes:
 *
 *   A. EXACT MATCH path — collection already has a structurally-identical
 *      entry. No way to add a duplicate (user's invariant: "identical
 *      scheme duplicate in collection is possible — not good"). The
 *      user can ONLY:
 *        • Cancel        → bail with no change
 *        • Rename & align → updates the existing collection entry's
 *                            name AND the anim-tab preset's name to a
 *                            shared value (so the user can find their
 *                            template under the project's name later).
 *                            Allowed names: the matched entry's CURRENT
 *                            name (no-op for collection, just renames
 *                            the anim-tab preset) OR a new unique name
 *                            (renames BOTH).
 *
 *   B. NO-EXACT path — never blocks. Optionally shows close-match hint.
 *      User picks a name (default: the preset's current name auto-
 *      suggested unique). Save appends a new entry. NAME conflicts
 *      blocked with auto-suggested unique alternative.
 *
 * The dialog uses one HTML shape and branches on `hasExact` at wire-
 * time. Keeps the path code together for readability.
 */
function _openAddToCollectionDialog(preset) {
  const { exact, close } = _findCollectionMatches(preset);
  const hasExact = exact.length > 0;
  // For the exact-match path, the FIRST exact entry is the "canonical"
  // one we'd rename / align with. If legacy data has multiple exacts
  // (which the new rules prevent going forward), the user can clean up
  // in the picker later.
  const exactEntry = hasExact ? exact[0] : null;

  // Initial name field default:
  //   exact path → match entry's current name (user can rename to a new
  //                 unique value, or keep to align the anim-tab preset only)
  //   no-exact   → preset's name, auto-suggested unique if collision
  const initialName = hasExact ? exactEntry.name : _suggestUniqueName(preset.name);

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.style.cssText = 'width:min(540px,95vw);max-height:80vh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:18px';

  const exactBannerHtml = hasExact ? `
    <div style="margin-top:10px;padding:10px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.5);border-radius:6px;color:var(--text);font-size:12px;line-height:1.55">
      <div style="font-weight:600;margin-bottom:4px;color:#fbbf24">⚠️ Exact preset found in collection</div>
      <div>Under the name: <b>"${_esc(exactEntry.name)}"</b>${exact.length > 1 ? ` (and ${exact.length - 1} other duplicate${exact.length > 2 ? 's' : ''})` : ''}</div>
      <div style="margin-top:6px">Would you like to rename it? Cancel stops the add. Rename aligns the names between the collection entry and this preset.</div>
    </div>` : '';

  const closeBannerHtml = (!hasExact && close.length) ? `
    <div style="margin-top:10px;padding:8px 10px;background:rgba(148,163,184,0.10);border:1px dashed var(--line);border-radius:6px;font-size:11px;color:var(--text);opacity:0.85">
      <div style="font-weight:600;margin-bottom:4px">Similar entries already in collection:</div>
      ${close.map(c => `<div>• <b>${_esc(c.name)}</b> — ${Math.round(c.score * 100)}% structural match</div>`).join('')}
    </div>` : '';

  const saveLabel = hasExact ? 'Rename and align' : 'Save to collection';

  dlg.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:6px">Add to my collection</div>
    <div style="font-size:12px;opacity:0.85;margin-bottom:10px">
      Save the animation string as a reusable template. You can pull it into any future project via "+ From collection".
    </div>

    ${exactBannerHtml}
    ${closeBannerHtml}

    <label style="display:block;margin-top:14px;font-size:12px;color:var(--text)">
      ${hasExact ? 'Use this name for both:' : 'Save as name:'}
      <input type="text" class="ap-coll-name" value="${_esc(initialName)}"
             style="width:100%;margin-top:5px;padding:6px 8px;font-size:13px;
                    background:var(--panel);color:var(--text);
                    border:1px solid var(--line);border-radius:4px;
                    box-sizing:border-box" />
    </label>
    <div class="ap-coll-name-err" style="margin-top:6px;font-size:11px;color:#f87171;min-height:14px"></div>

    <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:14px">
      <button class="btn ap-coll-cancel">Cancel</button>
      <button class="btn ap-coll-save" style="background:rgba(56,189,248,0.25);border:1px solid rgba(56,189,248,0.6)">${saveLabel}</button>
    </div>
  `;

  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());

  const nameInput = dlg.querySelector('.ap-coll-name');
  const errEl     = dlg.querySelector('.ap-coll-name-err');

  dlg.querySelector('.ap-coll-cancel').addEventListener('click', () => dlg.close());

  dlg.querySelector('.ap-coll-save').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      errEl.textContent = 'Name cannot be blank.';
      nameInput.focus();
      return;
    }

    if (hasExact) {
      // EXACT path: name uniqueness is enforced EXCEPT for the matched
      // entry's own current name (that's the "keep existing name and
      // just align the preset" case). If user picks the name of a
      // DIFFERENT existing entry → block.
      const collidesWithOther = _getCollection().some(c =>
        c.name === name && c.name !== exactEntry.name
      );
      if (collidesWithOther) {
        const suggested = _suggestUniqueName(name);
        errEl.textContent = `"${name}" is used by another entry. Suggested: ${suggested}`;
        nameInput.value = suggested;
        nameInput.focus();
        nameInput.select();
        return;
      }
      // Rename the collection entry (no-op if same name) AND the anim-tab
      // preset. Use the LATEST animation from the preset (the structures
      // match by definition, but custom ms values might differ — the user
      // probably wants their freshly-edited preset's exact string saved).
      if (name !== exactEntry.name) {
        await _replaceInCollection(exactEntry.name, { name, animation: preset.animation });
      } else {
        // Same name → still update the stored animation in case custom
        // ms values differ from the saved version.
        await _replaceInCollection(exactEntry.name, { name: exactEntry.name, animation: preset.animation });
      }
      // Align the anim-tab preset's name too.
      if (preset.name !== name) {
        actions.updateAnimPreset(preset.id, { name });
      }
      setStatus(`Aligned "${name}" — collection + project preset now share the name.`);
      dlg.close();
      return;
    }

    // NO-EXACT path: standard name-uniqueness check.
    if (_nameInCollection(name)) {
      const suggested = _suggestUniqueName(name);
      errEl.textContent = `"${name}" already exists in your collection. Suggested: ${suggested}`;
      nameInput.value = suggested;
      nameInput.focus();
      nameInput.select();
      return;
    }
    await _appendToCollection({ name, animation: preset.animation });
    setStatus(`Added "${name}" to your collection.`);
    dlg.close();
  });

  // Clear inline error as soon as the user edits the name
  nameInput.addEventListener('input', () => { errEl.textContent = ''; });

  dlg.showModal();
  // Pre-select the name so the user can just type to override
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 0);
}

/**
 * Structural signature of an animation string.
 *
 *   `camera+obj(500), color(AL1)` and
 *   `obj+camera(1200), color(800)` and
 *   `camera+obj(AL2), color(750)`
 *
 * all reduce to `[camera+obj][color]`. Durations are stripped entirely
 * and channels INSIDE a phase are sorted alphabetically so user-typing
 * order doesn't matter. Phase ORDER is preserved — `[color][camera+obj]`
 * is a DIFFERENT signature from `[camera+obj][color]` because the
 * execution sequence is observably different.
 *
 * Used to sort the collection picker so structurally-similar entries
 * cluster together.
 */
function _structuralSig(animStr) {
  const phases = parseAnimationForEdit(animStr);
  if (!phases) return '';
  return phases
    .map(p => '[' + [...new Set(p.types)].sort().join('+') + ']')
    .join('');
}

/**
 * Render a READ-ONLY phase preview for a given animation string. Mirrors
 * the look of the editor's `_renderPhasesView` (3-col rows: handle,
 * duration display, chip flow) but with no inputs, no drag-drop, no
 * right-click — just a static visual.
 *
 * Used in the 2-column import picker's preview pane (Coll-C) and the
 * compare view (Coll-C2, future).
 */
function _renderPhasesPreview(host, animStr) {
  if (!host) return;
  const parsed = parseAnimationForEdit(animStr);
  if (!parsed || parsed.length === 0) {
    host.innerHTML = `<div style="font-size:12px;color:var(--text);opacity:0.6;padding:8px;font-style:italic">
      Invalid or empty animation string.
    </div>`;
    return;
  }

  const resolveAL = (tok) => {
    if (tok === 'AL1') return state.get('cameraAnimDurationMs') ?? 1500;
    if (tok === 'AL2') return state.get('objectAnimDurationMs')  ?? 1500;
    const n = parseInt(tok, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const totalSec = (parsed.reduce((s, p) => s + resolveAL(p.durationRaw), 0) / 1000).toFixed(1);

  const headerHtml = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:12px;color:var(--text);font-weight:600">
      <span>Time blocks (${parsed.length})</span>
      <span style="font-size:11px;font-weight:500">total ${totalSec} sec</span>
    </div>`;

  const rowsHtml = parsed.map((phase) => {
    const phaseTypes = new Set(phase.types);
    const orderedTypes = CHANNEL_ORDER.filter(t => phaseTypes.has(t));
    for (const t of phase.types) {
      if (!CHANNEL_ORDER.includes(t)) orderedTypes.push(t);
    }
    const isPauseBlock = phase.types.length === 1 && phase.types[0] === 'pause';
    const durRaw       = phase.durationRaw || 'AL1';
    const durDisplay   = /^AL[12]$/i.test(durRaw) ? durRaw.toUpperCase() : durRaw;

    const chipsHtml = orderedTypes.map(t => {
      const meta = CHANNEL_META[t] || { icon: '•', label: t };
      return `
        <span style="display:inline-flex;align-items:center;gap:5px;
                     padding:3px 9px;margin:2px;
                     background:rgba(56,189,248,0.12);
                     border:1px solid rgba(56,189,248,0.4);
                     border-radius:999px;font-size:12px;line-height:1.2;
                     white-space:nowrap;color:var(--text);user-select:none">
          <span>${meta.icon}</span><span>${_esc(meta.label)}</span>
        </span>`;
    }).join('');

    const bodyHtml = orderedTypes.length
      ? chipsHtml
      : (isPauseBlock
          ? `<span style="font-style:italic;padding:0 4px;color:#7c2d12;font-size:11px;font-weight:600">⏸ pause time block</span>`
          : `<span style="font-style:italic;padding:0 4px;color:var(--text);opacity:0.65;font-size:11px">empty</span>`);

    const rowBg     = isPauseBlock ? 'rgba(251,146,60,0.22)'  : 'rgba(100,116,139,0.18)';
    const rowBorder = isPauseBlock ? 'rgba(251,146,60,0.55)'  : 'var(--line)';

    return `
      <div style="display:grid;grid-template-columns:20px 50px 1fr;
                  align-items:center;column-gap:6px;
                  border:1px solid ${rowBorder};border-radius:6px;
                  padding:4px 6px;margin-bottom:4px;
                  background:${rowBg};color:var(--text);min-height:26px">
        <span style="text-align:center;font-size:14px;color:var(--text);opacity:0.4">⋮</span>
        <span style="text-align:center;font-size:11px;font-family:monospace;
                     background:var(--panel);border:1px solid var(--line);
                     border-radius:3px;padding:2px 0;color:var(--text)">${_esc(durDisplay)}</span>
        <div style="display:flex;flex-wrap:wrap;align-items:center;min-height:22px;color:var(--text)">
          ${bodyHtml}
        </div>
      </div>`;
  }).join('');

  host.innerHTML = headerHtml + rowsHtml;
}

/**
 * Modal picker — 2-column layout (Coll-C).
 *
 *   LEFT column: scrollable list of all collection entries, sorted by
 *                structural signature (similar shapes cluster). Each row
 *                has a × delete button and is selectable.
 *   RIGHT column: read-only PREVIEW of the currently-selected entry's
 *                time blocks (same look as the editor, no inputs).
 *                "Add to project" button below the preview imports the
 *                entry as a new preset.
 *
 * Picker opens with the FIRST entry pre-selected so the preview pane
 * isn't empty on load.
 */
function _openCollectionPicker(container) {
  // Selected index into the LIVE sorted list (NOT into raw collection —
  // we use _origIdx for collection lookups). Re-clamped on every list
  // re-render so deletions don't leave it dangling.
  let selectedListIdx = _getCollection().length ? 0 : null;

  // Search state — channels dragged into each zone. Pauses are not
  // allowed (the channel isn't in CHANNEL_META, so the palette won't
  // render a pause chip). Durations are intentionally ignored — search
  // is purely structural per the user's spec.
  const searchZones = { start: [], mid: [], end: [] };

  const dlg = document.createElement('dialog');
  dlg.className = 'sbs-dialog';
  dlg.style.cssText = 'width:min(980px,95vw);max-height:85vh;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:18px';

  // Palette = drag source for the 3 search zones. Mirrors the chip
  // style used elsewhere so the visual language is consistent.
  const paletteChipsHtml = CHANNEL_ORDER.map(t => {
    const meta = CHANNEL_META[t];
    return `
      <span class="cap-search-palette-chip" draggable="true" data-channel="${_esc(t)}"
            style="display:inline-flex;align-items:center;gap:5px;
                   padding:3px 9px;margin:2px;
                   background:rgba(56,189,248,0.10);
                   border:1px solid rgba(56,189,248,0.35);
                   border-radius:999px;font-size:12px;line-height:1.2;
                   white-space:nowrap;cursor:grab;
                   color:var(--text);user-select:none"
            title="Drag into a search zone below to filter">
        <span>${meta.icon}</span><span>${_esc(meta.label)}</span>
      </span>`;
  }).join('');

  dlg.innerHTML = `
    <div style="font-size:15px;font-weight:600;margin-bottom:6px">Import from my collection</div>
    <div style="font-size:12px;opacity:0.8;margin-bottom:10px">
      Click a preset on the left to preview it; click <b>Add to project</b> to add a COPY to this project's animation list.
      Drag channel chips into the search zones below to filter by structure.
    </div>

    <!-- Search palette + 3 fixed zones (start / mid / end) -->
    <div class="cap-coll-search" style="padding:8px 10px;background:rgba(148,163,184,0.08);
                                         border:1px solid var(--line);border-radius:8px;margin-bottom:10px">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:6px">
        <span style="font-size:11px;color:var(--text);opacity:0.75;font-weight:600;margin-right:4px">Palette:</span>
        ${paletteChipsHtml}
        <button class="cap-coll-search-clear"
                style="margin-left:auto;font-size:11px;padding:3px 8px;
                       background:rgba(148,163,184,0.15);
                       border:1px solid var(--line);border-radius:4px;
                       color:var(--text);cursor:pointer"
                title="Clear all 3 search zones">Clear search</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;column-gap:8px">
        <div class="cap-coll-zone" data-zone="start"
             style="border:1px dashed var(--line);border-radius:6px;
                    padding:6px 8px;min-height:34px;
                    background:rgba(56,189,248,0.03)">
          <div style="font-size:10px;color:var(--text);opacity:0.55;margin-bottom:2px;font-weight:600">START</div>
          <div class="cap-coll-zone-chips" style="display:flex;flex-wrap:wrap;align-items:center;min-height:20px;font-size:11px;color:var(--text);opacity:0.6;font-style:italic">drop here</div>
        </div>
        <div class="cap-coll-zone" data-zone="mid"
             style="border:1px dashed var(--line);border-radius:6px;
                    padding:6px 8px;min-height:34px;
                    background:rgba(56,189,248,0.03)">
          <div style="font-size:10px;color:var(--text);opacity:0.55;margin-bottom:2px;font-weight:600">MID</div>
          <div class="cap-coll-zone-chips" style="display:flex;flex-wrap:wrap;align-items:center;min-height:20px;font-size:11px;color:var(--text);opacity:0.6;font-style:italic">drop here</div>
        </div>
        <div class="cap-coll-zone" data-zone="end"
             style="border:1px dashed var(--line);border-radius:6px;
                    padding:6px 8px;min-height:34px;
                    background:rgba(56,189,248,0.03)">
          <div style="font-size:10px;color:var(--text);opacity:0.55;margin-bottom:2px;font-weight:600">END</div>
          <div class="cap-coll-zone-chips" style="display:flex;flex-wrap:wrap;align-items:center;min-height:20px;font-size:11px;color:var(--text);opacity:0.6;font-style:italic">drop here</div>
        </div>
      </div>
    </div>

    <div class="cap-coll-grid"
         style="display:grid;grid-template-columns:1fr 1fr;column-gap:12px;
                max-height:48vh;min-height:220px">
      <!-- LEFT: list -->
      <div class="cap-coll-list" style="overflow-y:auto;padding-right:4px;
                                       border-right:1px solid var(--line)"></div>
      <!-- RIGHT: preview + actions -->
      <div class="cap-coll-right" style="display:flex;flex-direction:column;
                                         overflow-y:auto;padding-left:4px">
        <div class="cap-coll-preview" style="flex:1"></div>
        <div class="cap-coll-actions" style="margin-top:8px"></div>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;margin-top:12px;gap:6px;
                border-top:1px solid var(--line);padding-top:10px">
      <button class="btn cap-coll-close">Close</button>
    </div>
  `;

  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());

  const listEl    = dlg.querySelector('.cap-coll-list');
  const previewEl = dlg.querySelector('.cap-coll-preview');
  const actionsEl = dlg.querySelector('.cap-coll-actions');

  /**
   * Search-filter predicate. Given a collection entry's animation string
   * and the search zones, returns true if the entry MATCHES every filled
   * zone. Empty zones are no-ops.
   *
   *   start zone: chip set must be a SUBSET of the entry's FIRST phase
   *   end zone:   chip set must be a SUBSET of the entry's LAST phase
   *   mid zone:   chip set must be a SUBSET of at least ONE phase
   *               (any position — first, middle, or last)
   *
   * Pure structural — durations and AL tokens are ignored entirely.
   */
  function _matchesSearch(animStr) {
    const phases = parseAnimationForEdit(animStr);
    if (!phases || phases.length === 0) return false;
    const start = searchZones.start;
    const mid   = searchZones.mid;
    const end   = searchZones.end;
    const _subsetOf = (sub, of) => {
      const set = new Set(of);
      return sub.every(c => set.has(c));
    };
    if (start.length) {
      if (!_subsetOf(start, phases[0].types)) return false;
    }
    if (end.length) {
      if (!_subsetOf(end, phases[phases.length - 1].types)) return false;
    }
    if (mid.length) {
      // "Mid" matches any phase that contains all the mid chips.
      const someMatch = phases.some(p => _subsetOf(mid, p.types));
      if (!someMatch) return false;
    }
    return true;
  }

  /** Re-render the left list. Rebuilds DOM each time the collection
   *  changes (after a delete) — cheaper than incremental diff and the
   *  collection is small. */
  function renderList() {
    const current = _getCollection();
    if (current.length === 0) {
      listEl.innerHTML = `
        <div style="padding:18px 8px;color:var(--text);opacity:0.7;text-align:center;font-size:12px">
          Your collection is empty.<br>
          Right-click any preset in this project → "Add to my collection" to start.
        </div>`;
      previewEl.innerHTML = '';
      actionsEl.innerHTML = '';
      return;
    }

    // Re-sort because the underlying collection may have shrunk after a delete.
    const liveAll = current
      .map((c, origIdx) => ({ name: c.name, animation: c.animation, _origIdx: origIdx, _sig: _structuralSig(c.animation) }))
      .sort((a, b) => a._sig !== b._sig ? a._sig.localeCompare(b._sig) : a.name.localeCompare(b.name));

    // Apply search filter — empty zones = no constraints.
    const live = liveAll.filter(c => _matchesSearch(c.animation));

    // No matches? Show a hint inside the list pane, clear the preview.
    if (live.length === 0) {
      const hasSearch = searchZones.start.length || searchZones.mid.length || searchZones.end.length;
      listEl.innerHTML = `
        <div style="padding:18px 8px;color:var(--text);opacity:0.7;text-align:center;font-size:12px">
          ${hasSearch ? 'No collection entries match the current search.<br>Clear a zone or drop different chips.' : 'No collection entries.'}
        </div>`;
      previewEl.innerHTML = '';
      actionsEl.innerHTML = '';
      return;
    }

    // Clamp selection to a valid index.
    if (selectedListIdx == null || selectedListIdx >= live.length) {
      selectedListIdx = 0;
    }

    let prevSig = null;
    listEl.innerHTML = live.map((c, i) => {
      const newGroup = c._sig !== prevSig && i > 0;
      prevSig = c._sig;
      const gap = newGroup ? '<div style="height:6px;border-top:1px dashed var(--line);margin:6px 0"></div>' : '';
      const isSel = i === selectedListIdx;
      return gap + `
        <div class="cap-coll-row" data-list-idx="${i}" data-orig-idx="${c._origIdx}"
             style="display:flex;align-items:center;gap:8px;padding:7px 8px;cursor:pointer;
                    border:1px solid ${isSel ? '#38bdf8' : 'var(--line)'};
                    border-radius:6px;margin-bottom:4px;
                    background:${isSel ? 'rgba(56,189,248,0.22)' : 'rgba(56,189,248,0.06)'}">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;color:var(--text);font-size:12px;
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.name)}</div>
            <div style="font-family:monospace;font-size:10px;opacity:0.7;color:var(--text);
                        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
                        max-width:100%">${_esc(c.animation)}</div>
          </div>
          <button class="cap-coll-del" data-orig-idx="${c._origIdx}" data-name="${_esc(c.name)}"
                  style="background:rgba(220,38,38,0.15);border:1px solid rgba(220,38,38,0.4);
                         border-radius:4px;color:var(--text);font-size:11px;
                         padding:2px 6px;cursor:pointer"
                  title="Remove this entry from your collection">×</button>
        </div>`;
    }).join('');

    renderPreview(live);

    // Wire row click for selection
    listEl.querySelectorAll('.cap-coll-row').forEach(r => {
      r.addEventListener('click', (e) => {
        if (e.target.classList.contains('cap-coll-del')) return;
        selectedListIdx = Number(r.dataset.listIdx);
        renderList();
      });
    });

    // Wire delete (with confirm)
    listEl.querySelectorAll('.cap-coll-del').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const i    = Number(btn.dataset.origIdx);
        const name = btn.dataset.name || 'entry';
        if (!confirm(`Remove "${name}" from your collection?\n\nThis only removes the saved template.\nProjects that already imported it are unaffected.`)) {
          return;
        }
        const list = _getCollection();
        const next = list.filter((_, k) => k !== i);
        await userSettings.patch({ animation: { collection: next } });
        setStatus(`Removed "${name}" from your collection.`);
        // Don't clamp selectedListIdx — renderList does it.
        renderList();
      });
    });
  }

  /** Render the right-column preview + actions for the currently
   *  selected entry. */
  function renderPreview(live) {
    if (selectedListIdx == null || !live[selectedListIdx]) {
      previewEl.innerHTML = '';
      actionsEl.innerHTML = '';
      return;
    }
    const sel = live[selectedListIdx];
    previewEl.innerHTML = `
      <div style="margin-bottom:6px">
        <div style="font-size:14px;font-weight:600;color:var(--text)">${_esc(sel.name)}</div>
        <div style="font-family:monospace;font-size:10px;opacity:0.65;color:var(--text);
                    word-break:break-all">${_esc(sel.animation)}</div>
      </div>
      <div class="cap-coll-preview-phases"></div>
    `;
    _renderPhasesPreview(previewEl.querySelector('.cap-coll-preview-phases'), sel.animation);

    actionsEl.innerHTML = `
      <button class="btn cap-coll-add"
              style="width:100%;background:rgba(56,189,248,0.25);
                     border:1px solid rgba(56,189,248,0.6);
                     padding:8px 12px;font-size:13px;font-weight:600">
        + Add "${_esc(sel.name)}" to project
      </button>
    `;
    actionsEl.querySelector('.cap-coll-add').addEventListener('click', () => {
      const entry = _getCollection()[sel._origIdx];
      if (!entry) return;
      // Resolve name collision in current project's presets — same logic
      // as the old single-list picker.
      const existing = (state.get('animationPresets') || []).map(p => p.name);
      let name = entry.name;
      let suffix = 2;
      while (existing.includes(name)) { name = `${entry.name} (${suffix++})`; }
      const p = actions.createAnimPreset(name);
      actions.updateAnimPreset(p.id, { animation: entry.animation });
      setStatus(`Imported "${name}" from collection.`);
      dlg.close();
      _expandedId = p.id;
      renderAnimationTab(container);
    });
  }

  dlg.querySelector('.cap-coll-close').addEventListener('click', () => dlg.close());

  // ── Search zone wiring ───────────────────────────────────────────────

  /** Re-render every search zone's chips from `searchZones`. */
  function renderSearchZones() {
    for (const zone of ['start', 'mid', 'end']) {
      const zoneEl = dlg.querySelector(`.cap-coll-zone[data-zone="${zone}"] .cap-coll-zone-chips`);
      if (!zoneEl) continue;
      const chips = searchZones[zone];
      if (chips.length === 0) {
        zoneEl.innerHTML = '<span style="opacity:0.6;font-style:italic">drop here</span>';
      } else {
        zoneEl.innerHTML = chips.map(t => {
          const meta = CHANNEL_META[t] || { icon: '•', label: t };
          return `
            <span class="cap-coll-zone-chip" data-zone="${zone}" data-channel="${_esc(t)}"
                  style="display:inline-flex;align-items:center;gap:5px;
                         padding:2px 8px;margin:2px;
                         background:rgba(56,189,248,0.20);
                         border:1px solid rgba(56,189,248,0.5);
                         border-radius:999px;font-size:11px;line-height:1.2;
                         white-space:nowrap;color:var(--text);user-select:none">
              <span>${meta.icon}</span><span>${_esc(meta.label)}</span>
              <button class="cap-coll-zone-rm" data-zone="${zone}" data-channel="${_esc(t)}"
                      style="background:none;border:none;color:var(--text);
                             opacity:0.6;cursor:pointer;padding:0;margin-left:2px;font-size:11px"
                      title="Remove from this zone">×</button>
            </span>`;
        }).join('');
      }
    }

    // Re-bind the × buttons each render (the inner HTML is fresh)
    dlg.querySelectorAll('.cap-coll-zone-rm').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const zone    = btn.dataset.zone;
        const channel = btn.dataset.channel;
        searchZones[zone] = searchZones[zone].filter(c => c !== channel);
        renderSearchZones();
        renderList();
      });
    });
  }

  // Palette: drag source. Sets a payload marker so zone drop handlers
  // can distinguish search-palette drags from anim-tab editor drags
  // (which use 'application/x-sbs-chip').
  dlg.querySelectorAll('.cap-search-palette-chip').forEach(chip => {
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-sbs-search-chip', chip.dataset.channel);
      e.dataTransfer.effectAllowed = 'copy';
      chip.style.opacity = '0.4';
    });
    chip.addEventListener('dragend', () => { chip.style.opacity = ''; });
  });

  // Drop zones: accept palette chip drops, ignore other drag types.
  dlg.querySelectorAll('.cap-coll-zone').forEach(zoneEl => {
    const zone = zoneEl.dataset.zone;
    zoneEl.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-sbs-search-chip')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      zoneEl.style.outline = '2px dashed rgba(56,189,248,0.7)';
    });
    zoneEl.addEventListener('dragleave', () => { zoneEl.style.outline = ''; });
    zoneEl.addEventListener('drop', (e) => {
      zoneEl.style.outline = '';
      const channel = e.dataTransfer.getData('application/x-sbs-search-chip');
      if (!channel) return;
      e.preventDefault();
      if (!searchZones[zone].includes(channel)) {
        searchZones[zone].push(channel);
        renderSearchZones();
        renderList();
      }
    });
  });

  // Clear search button — drains all 3 zones at once.
  dlg.querySelector('.cap-coll-search-clear').addEventListener('click', () => {
    searchZones.start = [];
    searchZones.mid   = [];
    searchZones.end   = [];
    renderSearchZones();
    renderList();
  });

  renderSearchZones();
  renderList();
  dlg.showModal();
}


// ── Util ──────────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
