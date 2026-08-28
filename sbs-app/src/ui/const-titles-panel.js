// ─── 📌 Constant Titles panel (V0.3.2.102) ──────────────────────────────────
//
// Floating navigator for constant text-box types — the "document search"
// for titles. Opened from Edit → Constant Titles… (or window.sbsConstPanel()).
//
//   • Lists every constant type with its project-wide usage: "7× · 5 steps".
//   • Select a type → ▲ ▼ jump to the prev/next step that uses it (instant,
//     no animation — like middle-clicking a step card), with a "3 / 5"
//     position readout. Wraps around at the ends.
//   • Per-row ✏️ rename and 🗑 delete — the bin is enabled ONLY for types
//     with zero instances anywhere in the project.
//   • 🧹 Clean up unused — same as Edit → Clean Up Unused Constant Titles.
//
// Counts come from overlay.countConstUsage() (raw string scan, no JSON.parse)
// and are captured on open / 🔄 — not live. After hand-editing steps, hit 🔄.
//
// Leaf module: only main.js imports it (dynamically, from the menu handler),
// so the static imports below cannot close a cycle.

import { state } from '../core/state.js';
import { steps } from '../systems/steps.js';   // StepManager instance — activateStep is a method
import {
  countConstUsage, deleteConstDef, cleanupUnusedConstDefs,
  mergeConstDefs, selectConstInstance, waitForOverlayStable,
} from '../systems/overlay.js';
import { promptString } from './prompt.js';
import { setStatus } from './status.js';
import { showContextMenu } from './context-menu.js';

let _win        = null;
let _selectedId = null;
let _navPos     = new Map();   // defId → index into its stepIds (kept while open)
let _usage      = new Map();   // defId → { count, stepIds } — snapshot, see 🔄

export function openConstTitlesPanel() {
  if (_win) { _win.style.display = 'flex'; _refresh(); return; }
  _build();
  _refresh();
}

export function closeConstTitlesPanel() {
  if (!_win) return;
  _win.remove();
  _win = null;
  _selectedId = null;
  _navPos = new Map();
}

// ─── Build ──────────────────────────────────────────────────────────────────

function _build() {
  _win = document.createElement('div');
  _win.id = 'const-titles-window';
  _win.style.cssText = [
    'position:fixed', 'top:90px', 'left:90px', 'width:340px', 'max-height:70vh',
    'background:var(--panel,#0f172a)',
    'border:1px solid var(--line,#334155)',
    'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.5)',
    // z 45, NOT the floating-window 9999 tier: this panel opens context
    // menus (z 90) and promptString modals (z 50) — both must paint and
    // hit-test ABOVE it, or its menus/prompts render underneath it.
    'z-index:45',
    'display:flex', 'flex-direction:column',
    'user-select:none',
  ].join(';');

  _win.innerHTML = `
    <div id="ctp-header" style="
      cursor:move;padding:10px 12px;display:flex;align-items:center;gap:8px;
      background:rgba(59,130,246,0.18);border-bottom:1px solid var(--line,#334155);
      border-top-left-radius:10px;border-top-right-radius:10px;
    ">
      <span style="flex:1;font-weight:600;font-size:13px;color:#dbeafe;">📌 Constant titles</span>
      <button class="btn" id="ctp-refresh" type="button" title="Recount usage"
              style="padding:2px 8px;font-size:12px;">🔄</button>
      <button class="btn" id="ctp-close" type="button" style="padding:2px 8px;font-size:12px;">✕</button>
    </div>

    <div id="ctp-list" style="flex:1;overflow-y:auto;padding:8px;display:flex;
                              flex-direction:column;gap:4px;min-height:60px;"></div>

    <div style="padding:10px 12px;border-top:1px solid var(--line,#334155);
                display:flex;align-items:center;gap:8px;">
      <button class="btn" id="ctp-prev" type="button" title="Previous step using this type"
              style="padding:4px 10px;">▲</button>
      <button class="btn" id="ctp-next" type="button" title="Next step using this type"
              style="padding:4px 10px;">▼</button>
      <span class="small muted" id="ctp-pos" style="flex:1;font-size:12px;">select a type</span>
      <button class="btn" id="ctp-cleanup" type="button" title="Delete every type with zero instances"
              style="padding:4px 10px;font-size:12px;">🧹 Clean up</button>
    </div>
  `;

  document.body.appendChild(_win);
  _wireDrag(_win.querySelector('#ctp-header'));
  _win.querySelector('#ctp-close')  .addEventListener('click', closeConstTitlesPanel);
  _win.querySelector('#ctp-refresh').addEventListener('click', _refresh);
  _win.querySelector('#ctp-prev')   .addEventListener('click', () => _jump(-1));
  _win.querySelector('#ctp-next')   .addEventListener('click', () => _jump(+1));
  _win.querySelector('#ctp-cleanup').addEventListener('click', () => { cleanupUnusedConstDefs(); _refresh(); });
}

function _wireDrag(handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = _win.getBoundingClientRect();
    ox = r.left; oy = r.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    _win.style.left = `${Math.max(0, ox + e.clientX - sx)}px`;
    _win.style.top  = `${Math.max(0, oy + e.clientY - sy)}px`;
  });
  handle.addEventListener('pointerup', () => { dragging = false; });
}

// ─── Render ─────────────────────────────────────────────────────────────────

/** Recount usage (string scan over every step), then render. */
function _refresh() {
  if (!_win) return;
  _usage = countConstUsage();
  _render();
}

/** Render rows from the existing usage snapshot — selection clicks and
 *  renames re-render WITHOUT rescanning the whole project. */
function _render() {
  if (!_win) return;
  const defs = state.get('constTextBoxes') || [];
  if (_selectedId && !defs.some(d => d.id === _selectedId)) _selectedId = null;

  const list = _win.querySelector('#ctp-list');
  list.textContent = '';

  if (!defs.length) {
    const empty = document.createElement('div');
    empty.className = 'small muted';
    empty.style.cssText = 'padding:14px 8px;font-size:12px;line-height:1.5;text-align:center;';
    empty.textContent = 'No constant titles yet. Right-click a text box → "Make constant…", or run Edit → Unify Constant Titles.';
    list.appendChild(empty);
  }

  for (const def of defs) {
    const u = _usage.get(def.id) || { count: 0, stepIds: [] };
    const row = document.createElement('div');
    const selected = def.id === _selectedId;
    row.style.cssText = [
      'display:flex', 'align-items:center', 'gap:6px', 'padding:6px 8px',
      'border-radius:6px', 'cursor:pointer', 'font-size:13px',
      `background:${selected ? 'rgba(59,130,246,0.25)' : 'var(--panel2,#1e293b)'}`,
      `border:1px solid ${selected ? '#3b82f6' : 'var(--line,#334155)'}`,
      'color:var(--text,#e2e8f0)',
    ].join(';');

    const name = document.createElement('span');
    name.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    name.textContent = `📌 ${def.name || 'Unnamed'}`;
    name.title = def.name || 'Unnamed';

    const count = document.createElement('span');
    count.className = 'small muted';
    count.style.cssText = 'font-size:11px;white-space:nowrap;';
    count.textContent = u.count
      ? `${u.count}× · ${u.stepIds.length} step${u.stepIds.length === 1 ? '' : 's'}`
      : 'unused';

    const btn = (label, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText = 'background:none;border:none;cursor:pointer;font-size:13px;padding:0 2px;';
      b.addEventListener('pointerdown', e => e.stopPropagation());
      return b;
    };
    const rename = btn('✏️', 'Rename this constant');
    rename.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = await promptString('Rename constant', def.name || '');
      if (!next || !next.trim() || next.trim() === def.name) return;
      def.name = next.trim();
      state.setState({ constTextBoxes: [...(state.get('constTextBoxes') || [])] });
      state.markDirty();
      setStatus(`Constant renamed to "${def.name}".`, 'success', 3000);
      _render();
    });

    const del = btn('🗑', u.count ? 'In use — detach every instance first' : 'Delete this constant');
    if (u.count) { del.style.opacity = '0.25'; del.style.cursor = 'not-allowed'; }
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (u.count) {
        setStatus(`"${def.name}" is in use ${u.count}× on ${u.stepIds.length} step(s) — detach those boxes first.`, 'warn', 6000);
        return;
      }
      const res = deleteConstDef(def.id);
      if (res.ok) _refresh();
    });

    row.append(name, count, rename, del);
    row.addEventListener('click', () => {
      _selectedId = def.id;
      _render();
      // Selecting = start the walk: jump straight to the first user step.
      if ((_usage.get(def.id)?.stepIds || []).length && !_navPos.has(def.id)) _jump(+1);
      else _syncPos();
    });
    // Right-click → "Unify into ▸" — merge THIS type into another one:
    // every instance re-stamped and re-pinned, this def deleted. The
    // human-judgment consolidation pass after the auto sweep.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const others = (state.get('constTextBoxes') || []).filter(d => d.id !== def.id);
      if (!others.length) return;
      showContextMenu([{
        label: `Unify "${def.name}" into…`,
        submenu: others.map(o => ({
          label: `📌 ${o.name || 'Unnamed'}`,
          action: () => {
            const res = mergeConstDefs(def.id, o.id);
            if (!res.ok) return;
            if (_selectedId === def.id) { _selectedId = o.id; _navPos.delete(o.id); }
            _navPos.delete(def.id);
            _refresh();
          },
        })),
      }], e.clientX, e.clientY);
    });
    list.appendChild(row);
  }

  // Footer state.
  const zero = defs.filter(d => !(_usage.get(d.id)?.count)).length;
  const cleanup = _win.querySelector('#ctp-cleanup');
  cleanup.textContent = zero ? `🧹 Clean up (${zero})` : '🧹 Clean up';
  cleanup.disabled = !zero;
  cleanup.style.opacity = zero ? '' : '0.4';
  _syncPos();
}

function _syncPos() {
  const posEl  = _win?.querySelector('#ctp-pos');
  const prevEl = _win?.querySelector('#ctp-prev');
  const nextEl = _win?.querySelector('#ctp-next');
  if (!posEl) return;
  const u = _selectedId ? _usage.get(_selectedId) : null;
  const total = u?.stepIds?.length || 0;
  const enabled = total > 0;
  prevEl.disabled = nextEl.disabled = !enabled;
  prevEl.style.opacity = nextEl.style.opacity = enabled ? '' : '0.4';
  if (!_selectedId)      posEl.textContent = 'select a type';
  else if (!total)       posEl.textContent = 'no steps use this type';
  else {
    let i = _navPos.get(_selectedId);
    if (i != null && i >= total) { i = total - 1; _navPos.set(_selectedId, i); }   // list shrank since capture
    posEl.textContent = i == null ? `${total} step${total === 1 ? '' : 's'}` : `step ${i + 1} / ${total}`;
  }
}

// ─── Navigate ───────────────────────────────────────────────────────────────

let _jumpSeq = 0;   // stale-jump guard for rapid ▲▲▲ clicking

async function _jump(dir) {
  if (!_selectedId) return;
  const defId = _selectedId;
  const ids = _usage.get(defId)?.stepIds || [];
  if (!ids.length) return;
  const cur  = _navPos.get(defId);
  const next = cur == null
    ? (dir > 0 ? 0 : ids.length - 1)
    : (((cur + dir) % ids.length) + ids.length) % ids.length;   // wraps
  _navPos.set(defId, next);
  _syncPos();
  const seq = ++_jumpSeq;
  try {
    await steps.activateStep(ids[next], false);   // instant, like middle-click
    await waitForOverlayStable();                  // overlay nodes exist now
    // Only the LATEST jump selects — and only if the active step is STILL
    // the one we jumped to. The seq guard catches newer panel jumps; the
    // step check catches outside navigation (step-card click, arrows,
    // undo) landing inside our await window — selecting there would force
    // edit mode on a step the user deliberately went to.
    if (seq === _jumpSeq && _win && state.get('activeStepId') === ids[next]) selectConstInstance(defId);
  } catch (err) {
    console.warn('[const-panel] jump/select failed:', err);
  }
}
