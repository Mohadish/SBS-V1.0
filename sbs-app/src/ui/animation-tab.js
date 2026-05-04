/**
 * SBS — Animation Tab
 * ====================
 * Renders the animation presets list in the left sidebar.
 * Presets define phased step transitions using the animation string syntax:
 *   'camera(500), color(300), obj+visibility(400)'
 */

import { state }           from '../core/state.js';
import * as actions        from '../systems/actions.js';
import { parseAnimation }  from '../systems/animation.js';

let _expandedId = null;

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

      <div style="margin-top:10px">
        <button class="btn" id="btn-add-anim">+ New Preset</button>
      </div>

      <div id="anim-list" style="margin-top:8px"></div>
    </div>
  `;

  container.querySelector('#btn-add-anim').addEventListener('click', () => {
    const p = actions.createAnimPreset('Animation ' + (presets.length + 1));
    _expandedId = p.id;
    renderAnimationTab(container);
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
    row.innerHTML = `
      <div class="colorRow${expanded ? ' selected' : ''}" style="cursor:pointer;gap:6px;align-items:center">
        <span style="font-size:11px;flex-shrink:0;${preset.isDefault ? 'color:#fbbf24' : 'opacity:0.2'}">★</span>
        <span class="small" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(preset.name)}</span>
        <span class="colorMeta" style="font-size:10px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0"
              title="${_esc(phaseSummary)}">${_esc(phaseSummary)}</span>
      </div>
    `;

    row.querySelector('.colorRow').addEventListener('click', () => {
      _expandedId = expanded ? null : preset.id;
      renderAnimationTab(container);
    });

    listEl.appendChild(row);

    if (expanded) {
      listEl.appendChild(_buildEditPane(preset, presets, container));
    }
  }
}

// ─── Expanded edit card ───────────────────────────────────────────────────────

function _buildEditPane(preset, presets, container) {
  const parsed   = parseAnimation(preset.animation);
  const isValid  = parsed !== null;
  const totalMs  = parsed ? parsed.reduce((s, p) => s + p.durationMs, 0) : 0;

  const pane = document.createElement('div');
  pane.className = 'card';
  pane.style.marginBottom = '8px';

  pane.innerHTML = `
    <label class="colorlab">Name
      <input type="text" class="ap-name" value="${_esc(preset.name)}" style="margin-top:6px" />
    </label>

    <label class="colorlab" style="margin-top:8px">Animation string
      <textarea class="ap-anim" rows="2" wrap="soft"
                style="margin-top:6px;width:100%;box-sizing:border-box;padding:8px 10px;font-family:monospace;font-size:14px;line-height:1.4;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:8px;caret-color:#f59e0b;resize:vertical;min-height:44px"
                placeholder="camera(500), color(500), visibility(500), obj(500)">${_esc(preset.animation)}</textarea>
    </label>

    <div class="ap-validation small" style="margin-top:5px"></div>

    <label style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer">
      <input type="checkbox" class="ap-default" ${preset.isDefault ? 'checked' : ''} />
      <span class="small muted">Use as project default</span>
    </label>
    <div class="small muted" style="margin-top:3px;padding-left:22px">
      All steps use this preset unless overridden per-step.
    </div>

    <div style="display:flex;justify-content:flex-end;margin-top:12px">
      <button class="btn ap-del" title="Delete preset">🗑 Delete</button>
    </div>
  `;

  // Show initial validation
  _updateValidation(pane.querySelector('.ap-validation'), preset.animation);

  // Commit on blur (change event); the state subscription will pick up
  // the new value and re-render the list (no explicit renderAnimationTab
  // call here — that destroyed + recreated the textarea every commit,
  // which broke focus and made keystrokes intermittently land on body).
  pane.querySelector('.ap-name').addEventListener('change', e => {
    actions.updateAnimPreset(preset.id, { name: e.target.value.trim() || preset.name });
  });

  const animInput = pane.querySelector('.ap-anim');
  animInput.addEventListener('input', e => {
    _updateValidation(pane.querySelector('.ap-validation'), e.target.value);
  });
  animInput.addEventListener('change', e => {
    const val = e.target.value.trim();
    if (val) actions.updateAnimPreset(preset.id, { animation: val });
  });

  pane.querySelector('.ap-default').addEventListener('change', e => {
    if (e.target.checked) {
      actions.setDefaultAnimPreset(preset.id);
    } else {
      actions.updateAnimPreset(preset.id, { isDefault: false });
    }
  });

  pane.querySelector('.ap-del').addEventListener('click', () => {
    if (!confirm(`Delete animation preset "${preset.name}"?\nSteps using this preset will revert to default.`)) return;
    _expandedId = null;
    actions.deleteAnimPreset(preset.id);
    renderAnimationTab(container.closest('[id^="tab-panel"]') || container);
  });

  return pane;
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


// ── Util ──────────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
