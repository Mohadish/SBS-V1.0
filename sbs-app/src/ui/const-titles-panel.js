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
  mergeConstDefs, selectConstInstance, selectTextUnitByTid, waitForOverlayStable,
} from '../systems/overlay.js';
import * as lang from '../systems/language-packs.js';
import * as actions from '../systems/actions.js';
import * as subtitles from '../systems/subtitles.js';
import { setStepNarrationText } from './step-nav.js';
import { promptString, chooseFromButtons } from './prompt.js';
import { setStatus } from './status.js';
import { showContextMenu } from './context-menu.js';

let _win        = null;
let _tab        = 'const';     // 'const' | 'review' | 'rules'
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
      <span style="flex:1;font-weight:600;font-size:13px;color:#dbeafe;">🏷 Title manager</span>
      <button class="btn" id="ctp-refresh" type="button" title="Rescan"
              style="padding:2px 8px;font-size:12px;">🔄</button>
      <button class="btn" id="ctp-close" type="button" style="padding:2px 8px;font-size:12px;">✕</button>
    </div>

    <div id="ctp-tabs" style="display:flex;gap:4px;padding:8px 10px 0;border-bottom:1px solid var(--line,#334155);">
      <button class="btn" data-tab="const"  type="button" style="padding:4px 12px;font-size:12px;">📌 Constant titles</button>
      <button class="btn" data-tab="review" type="button" style="padding:4px 12px;font-size:12px;">🌍 Translated titles</button>
      <button class="btn" data-tab="rules"  type="button" style="padding:4px 12px;font-size:12px;">🔤 Replace rules</button>
    </div>

    <div id="ctp-list" style="flex:1;overflow-y:auto;padding:8px;display:flex;
                              flex-direction:column;gap:4px;min-height:60px;"></div>

    <div id="ctp-foot-const" style="padding:10px 12px;border-top:1px solid var(--line,#334155);
                display:flex;align-items:center;gap:8px;">
      <button class="btn" id="ctp-prev" type="button" title="Previous step using this type"
              style="padding:4px 10px;">▲</button>
      <button class="btn" id="ctp-next" type="button" title="Next step using this type"
              style="padding:4px 10px;">▼</button>
      <span class="small muted" id="ctp-pos" style="flex:1;font-size:12px;">select a type</span>
      <button class="btn" id="ctp-cleanup" type="button" title="Delete every type with zero instances"
              style="padding:4px 10px;font-size:12px;">🧹 Clean up</button>
    </div>

    <div id="ctp-foot-review" style="padding:10px 12px;border-top:1px solid var(--line,#334155);
                display:none;align-items:center;gap:8px;">
      <label class="small muted" style="display:flex;align-items:center;gap:5px;font-size:11.5px;cursor:pointer;">
        <input type="checkbox" id="ctp-filter" checked> only changed
      </label>
      <span class="small muted" id="ctp-review-count" style="flex:1;font-size:11.5px;"></span>
      <button class="btn" id="ctp-authorize" type="button"
              title="Clear the markers on rows you have already looked at (untouched ❗ rows stay)"
              style="padding:4px 10px;font-size:12px;">✓ Authorize all</button>
    </div>

    <div id="ctp-foot-rules" style="padding:10px 12px;border-top:1px solid var(--line,#334155);
                display:none;align-items:center;gap:8px;">
      <button class="btn" id="ctp-rule-add" type="button" style="padding:4px 10px;font-size:12px;">＋ Add rule</button>
      <span class="small muted" id="ctp-rule-note" style="flex:1;font-size:11.5px;"></span>
      <button class="btn" id="ctp-rule-run" type="button"
              title="Apply every rule across this language — the original's rules rewrite the project text itself"
              style="padding:4px 10px;font-size:12px;">▶ Run rules now</button>
      <button class="btn" id="ctp-rule-bake" type="button"
              title="Apply every rule, then delete the rules — the corrected text becomes the text"
              style="padding:4px 10px;font-size:12px;">🔥 Bake</button>
    </div>
  `;

  document.body.appendChild(_win);
  _wireDrag(_win.querySelector('#ctp-header'));
  _win.querySelector('#ctp-close')  .addEventListener('click', closeConstTitlesPanel);
  _win.querySelector('#ctp-refresh').addEventListener('click', _refresh);
  _win.querySelectorAll('#ctp-tabs [data-tab]').forEach(b => {
    b.addEventListener('click', () => { _tab = b.dataset.tab; _refresh(); });
  });
  _win.querySelector('#ctp-filter').addEventListener('change', () => _renderReview());
  _win.querySelector('#ctp-authorize').addEventListener('click', _onAuthorizeAll);
  _win.querySelector('#ctp-rule-add').addEventListener('click', () => _onEditRule(null));
  _win.querySelector('#ctp-rule-run').addEventListener('click', () => _onRunRules(false));
  _win.querySelector('#ctp-rule-bake').addEventListener('click', () => _onRunRules(true));
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

// ─── 🌍 Translated titles tab ───────────────────────────────────────────────
//
// A review queue for everything the translation engine changed in the
// language you are currently viewing. Markers, in sort order:
//   ❗   changed / newly translated — not looked at
//   ❗✏  the source moved but YOUR hand-edit was kept — needs judgement
//   ❗✱  you opened it and left it alone
//   ✱   you opened it and changed it
// Rows keep project order inside each group. "Authorize all" clears only
// what you actually opened; untouched ❗ rows survive.

const MARK_LABEL = { '!': '❗', '!p': '❗✏', '!*': '❗✱', '*': '✱', '': '' };
const MARK_TITLE = {
  '!':  'Changed by translation — not reviewed yet',
  '!p': 'The original changed, but your hand-edit was kept. Right-click to take the machine translation instead.',
  '!*': 'You opened this and left it as it was',
  '*':  'You opened this and edited it',
  '':   '',
};

let _reviewRows = [];
let _reviewSide = 'tgt';

async function _renderReview() {
  if (!_win) return;
  const list = _win.querySelector('#ctp-list');
  list.textContent = '';
  const onlyChanged = !!_win.querySelector('#ctp-filter')?.checked;
  const rows = onlyChanged ? _reviewRows.filter(r => r.mark) : _reviewRows;

  const marked = _reviewRows.filter(r => r.mark).length;
  const unseen = _reviewRows.filter(r => r.mark === '!' || r.mark === '!p').length;
  const countEl = _win.querySelector('#ctp-review-count');
  if (countEl) countEl.textContent = marked
    ? `${marked} changed · ${unseen} not reviewed`
    : 'nothing changed in this language';

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'small muted';
    empty.style.cssText = 'padding:14px 8px;font-size:12px;line-height:1.5;text-align:center;';
    empty.textContent = onlyChanged
      ? 'No translation changes to review. Untick "only changed" to see every title.'
      : 'No titles found in this project.';
    list.appendChild(empty);
    return;
  }

  for (const r of rows) {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex', 'align-items:center', 'gap:8px', 'padding:6px 8px',
      'border-radius:6px', 'cursor:pointer', 'font-size:12.5px',
      'background:var(--panel2,#1e293b)',
      `border:1px solid ${r.mark === '!' || r.mark === '!p' ? 'rgba(217,160,61,0.55)' : 'var(--line,#334155)'}`,
      'color:var(--text,#e2e8f0)',
    ].join(';');

    const mark = document.createElement('span');
    mark.style.cssText = 'width:26px;flex:none;font-size:12px;';
    mark.textContent = MARK_LABEL[r.mark] || '';
    mark.title = MARK_TITLE[r.mark] || '';

    const kind = document.createElement('span');
    kind.className = 'small muted';
    kind.style.cssText = 'width:74px;flex:none;font-size:10.5px;text-transform:uppercase;letter-spacing:0.05em;';
    kind.textContent = r.label;

    const txt = document.createElement('span');
    txt.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    // Text-box entries are HTML — show readable text, not markup.
    const plain = String(r.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    txt.textContent = plain || '(empty)';
    txt.title = plain;

    row.append(mark, kind, txt);
    row.title = 'Click to go to it · double-click to edit';
    row.addEventListener('click', () => _onOpenRow(r));
    row.addEventListener('dblclick', () => _onEditRow(r));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); _onRowMenu(e, r); });
    list.appendChild(row);
  }
}

/** Click a row → go to that title, select it, and mark it as seen. */
async function _onOpenRow(r) {
  try {
    if (r.stepId && r.stepId !== state.get('activeStepId')) {
      await steps.activateStep(r.stepId, false);
      await waitForOverlayStable();
    }
    const m = /^text:(.+)$/.exec(r.key);
    if (m) selectTextUnitByTid(m[1]);
    // ❗ → ❗✱ : opened, not yet changed. Editing it later promotes to ✱.
    if (r.mark === '!' || r.mark === '!p') {
      await lang.setReviewState(r.lang, r.key, _reviewSide, 'seen');
      await _refresh();
    }
  } catch (e) {
    setStatus(`Could not open that title: ${e?.message || e}`, 'warn', 6000);
  }
}

/**
 * Double-click → open the RIGHT editor for that kind of row, rather than
 * editing in the list. Reusing the real editors means formatting, validation
 * and undo all behave exactly as they do everywhere else — and a styled text
 * box keeps its styling, which editing markup in a list field would flatten.
 */
async function _onEditRow(r) {
  try {
    if (r.stepId && r.stepId !== state.get('activeStepId')) {
      await steps.activateStep(r.stepId, false);
      await waitForOverlayStable();
    }
    let m;
    if ((m = /^text:(.+)$/.exec(r.key))) {
      // Straight into the in-place editor on the canvas.
      if (!selectTextUnitByTid(m[1], { edit: true })) {
        setStatus('That text box is not on this step any more — rescan.', 'warn', 6000);
      }
      return;
    }
    if ((m = /^step:(.+):name$/.exec(r.key))) {
      const step = steps.getStepById(m[1]);
      const name = await promptString('Step name:', step?.name || '');
      if (name && name.trim()) actions.renameStep(m[1], name.trim());
    } else if ((m = /^chapter:(.+):name$/.exec(r.key))) {
      const ch = (state.get('chapters') || []).find(c => c.id === m[1]);
      const name = await promptString('Chapter name:', ch?.name || '');
      // Same shape the steps panel's chapter rename uses — there is no
      // actions.renameChapter to call, the mutation IS the commit.
      if (name && name.trim()) {
        const chapterId = m[1], next = name.trim();
        actions.commitStateChange('Rename chapter', ['chapters'], () => {
          state.setState({ chapters: (state.get('chapters') || []).map(c => c.id === chapterId ? { ...c, name: next } : c) });
          state.markDirty();
        });
      }
    } else if ((m = /^step:(.+):narration$/.exec(r.key))) {
      const step = steps.getStepById(m[1]);
      const text = await promptString('Voice-over text:', step?.narration?.text || '');
      // Same writer the nav bar uses — targeted undo, drops the stale
      // measured duration, trims for the phonemizer.
      if (text != null) setStepNarrationText(m[1], text);
    } else if ((m = /^subtitle:(.+):(.+)$/.exec(r.key))) {
      const step = steps.getStepById(m[1]);
      const lng  = m[2] === 'orig' ? '' : m[2];
      const cur  = step?.subtitles?.[m[2]]?.text || '';
      const text = await promptString('Subtitle text:', cur);
      if (text != null) subtitles.setSubtitleOverride(m[1], lng, text);
    }
    await _refresh();
  } catch (e) {
    setStatus(`Could not edit that: ${e?.message || e}`, 'warn', 6000);
  }
}

function _onRowMenu(e, r) {
  const items = [];
  if (r.mark === '!p') {
    items.push({
      label: '↺ Update to translated version',
      action: async () => {
        const res = await lang.acceptMachineTranslation(r.lang, r.key);
        if (!res.ok) setStatus(res.error, 'warn', 7000);
        else setStatus('Replaced with the machine translation — Ctrl+Z restores your version.', 'success', 7000);
        await _refresh();
      },
    });
  }
  if (r.mark) {
    items.push({
      label: '✓ Accept translation',
      action: async () => {
        await lang.setReviewState(r.lang, r.key, _reviewSide, 'edited');
        await lang.clearReviewed(r.lang, _reviewSide);
        await _refresh();
      },
    });
  }
  if (!items.length) return;
  showContextMenu(items, e.clientX, e.clientY);
}

async function _onAuthorizeAll() {
  const code = lang.activeLang();
  const targets = _reviewSide === 'src'
    ? [...new Set(_reviewRows.filter(r => r.mark).map(r => r.lang))]
    : [code];
  let cleared = 0;
  for (const c of targets) {
    const res = await lang.clearReviewed(c, _reviewSide);
    if (res.ok) cleared += res.cleared || 0;
    else setStatus(res.error, 'warn', 6000);
  }
  setStatus(cleared
    ? `Authorized ${cleared} reviewed change(s). Unreviewed ❗ rows were kept.`
    : 'Nothing reviewed yet — open a row first, then authorize.', 'info', 7000);
  await _refresh();
}

// ─── 🔤 Replace rules tab ───────────────────────────────────────────────────

let _rules = [];

async function _renderRules() {
  if (!_win) return;
  const code = lang.activeLang();
  const list = _win.querySelector('#ctp-list');
  list.textContent = '';
  const note = _win.querySelector('#ctp-rule-note');
  const isSource = code === lang.sourceLang();
  const rules = _rules || [];
  note.textContent = (rules.length ? `${rules.length} rule(s) for ${code}` : `no rules for ${code} yet`)
                   + (isSource ? ' — these rewrite the original text' : '');
  if (!rules.length) {
    const m = document.createElement('div');
    m.className = 'small muted';
    m.style.cssText = 'padding:14px 8px;font-size:12px;line-height:1.5;text-align:center;';
    m.textContent = isSource
      ? 'No rules yet. A rule finds a phrase and replaces it throughout the ORIGINAL text — step names, chapters, voiceover and titles. Every translation is flagged for review afterwards, because the source changed.'
      : 'No rules yet. A rule finds a phrase in this language and replaces it — applied to every new translation, and to existing ones with "Run rules now".';
    list.appendChild(m);
    return;
  }

  for (const r of rules) {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex', 'align-items:center', 'gap:8px', 'padding:7px 9px',
      'border-radius:6px', 'font-size:12.5px', 'cursor:pointer',
      'background:var(--panel2,#1e293b)', 'border:1px solid var(--line,#334155)',
      'color:var(--text,#e2e8f0)',
    ].join(';');
    const find = document.createElement('span');
    find.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    find.textContent = r.find;
    const arrow = document.createElement('span');
    arrow.className = 'small muted';
    arrow.style.cssText = 'flex:none;font-size:11px;';
    arrow.textContent = '→';
    const rep = document.createElement('span');
    rep.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    rep.textContent = r.replace || '(delete)';
    const cs = document.createElement('span');
    cs.className = 'small muted';
    cs.style.cssText = 'flex:none;font-size:10px;';
    cs.textContent = r.caseSensitive ? 'Aa' : '';
    cs.title = r.caseSensitive ? 'Case sensitive' : '';
    row.append(find, arrow, rep, cs);
    row.title = 'Click to edit · right-click to delete';
    row.addEventListener('click', () => _onEditRule(r));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      showContextMenu([{ label: '🗑 Delete rule', action: () => _onDeleteRule(r) }], e.clientX, e.clientY);
    });
    list.appendChild(row);
  }
}

async function _onEditRule(rule) {
  const code = lang.activeLang();
  const find = await promptString('Find this phrase (in ' + code + '):', rule?.find || '');
  if (find == null || !find.trim()) return;
  const replace = await promptString(`Replace "${find.trim()}" with:`, rule?.replace ?? '');
  if (replace == null) return;
  try {
    const cur = await lang.getRules(code);
    const res = lang.upsertRule(cur, {
      id: rule?.id, find, replace, caseSensitive: rule?.caseSensitive || false,
    });
    if (!res.ok) { setStatus(res.error, 'warn', 7000); return; }
    const w = await lang.setRules(code, res.rules);
    if (!w.ok) { setStatus(w.error, 'warn', 7000); return; }
    setStatus(res.collapsed
      ? `Rule saved — ${res.collapsed} earlier rule(s) now point straight at the new wording.`
      : 'Rule saved. It applies to every new translation; use "Run rules now" for existing ones.', 'success', 8000);
    await _refresh();
  } catch (e) {
    setStatus(`Could not save the rule: ${e?.message || e}`, 'warn', 7000);
  }
}

async function _onDeleteRule(rule) {
  const code = lang.activeLang();
  try {
    const cur = await lang.getRules(code);
    const w = await lang.setRules(code, cur.filter(r => r.id !== rule.id));
    if (!w.ok) { setStatus(w.error, 'warn', 6000); return; }
    setStatus('Rule deleted. Text already replaced stays as it is.', 'info', 6000);
    await _refresh();
  } catch (e) { setStatus(`Delete failed: ${e?.message || e}`, 'warn', 6000); }
}

async function _onRunRules(bake) {
  const code = lang.activeLang();
  if (bake) {
    const rules = await lang.getRules(code);
    if (!rules.length) { setStatus('No rules to bake.', 'warn', 5000); return; }
    const ok = await chooseFromButtons(
      `Bake ${rules.length} rule(s) into ${code}?`,
      'The corrected text becomes the text, and the rules are deleted. One Ctrl+Z restores both.',
      [{ id: 'bake', label: '🔥 Bake', primary: true }, { id: 'cancel', label: 'Cancel' }],
    );
    if (ok !== 'bake') return;
  }
  const res = await lang.runRules(code, { bake });
  if (!res.ok) { setStatus(res.error, 'warn', 7000); return; }
  const bits = [];
  if (res.changed)   bits.push(`${res.changed} line(s)`);
  if (res.subtitles) bits.push(`${res.subtitles} subtitle(s)`);
  const what = bits.length ? bits.join(' + ') : 'nothing';
  setStatus(bake
    ? `Baked into ${what} — the rules are gone; the text is now the truth. Ctrl+Z restores both.`
    : (bits.length ? `Rules applied to ${what} — Ctrl+Z reverses the run.`
                   : 'Nothing matched — every line already reads the way the rules say.'),
    bake ? 'success' : 'info', 8000);
  await _refresh();
}

/** Recount usage (string scan over every step), then render. */
async function _refresh() {
  if (!_win) return;
  _win.querySelectorAll('#ctp-tabs [data-tab]').forEach(b => {
    const on = b.dataset.tab === _tab;
    b.style.opacity = on ? '' : '0.55';
    b.style.background = on ? 'rgba(59,130,246,0.25)' : '';
  });
  _win.querySelector('#ctp-foot-const').style.display  = _tab === 'const'  ? 'flex' : 'none';
  _win.querySelector('#ctp-foot-review').style.display = _tab === 'review' ? 'flex' : 'none';
  _win.querySelector('#ctp-foot-rules').style.display  = _tab === 'rules'  ? 'flex' : 'none';

  if (_tab === 'rules') {
    try { _rules = await lang.getRules(lang.activeLang()); }
    catch (e) { _rules = []; setStatus(e?.message || 'Could not read the rules.', 'warn', 7000); }
    await _renderRules();
    return;
  }

  if (_tab === 'review') {
    try {
      const r = await lang.reviewRows();
      _reviewRows = r.rows;
      _reviewSide = r.side;
    } catch (e) {
      _reviewRows = []; _reviewSide = 'tgt';
      setStatus(`Could not read the language packs: ${e?.message || e}`, 'warn', 7000);
    }
    await _renderReview();
    return;
  }
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
