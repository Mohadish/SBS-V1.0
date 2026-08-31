// ─── 🌍 Languages panel (V0.3.2.116) ────────────────────────────────────────
//
// Floating panel opened from Edit → Languages… (or window.sbsLangPanel()).
// One project, many languages: the .sbsproj holds one language at a time and
// each other language lives in a <project>.<lang>.sbslang.json sidecar.
//
// Per language it shows the drift report — how many lines are translated, how
// many went stale because you edited the original since, how many you fixed by
// hand (never overwritten), and how many constant title sets still have no
// layout for that language — then lets you Scan, Translate and Switch.
//
// z-index 45 ON PURPOSE: this panel opens prompts (z50) and context menus
// (z90), and they must paint above it. See const-titles-panel.js.

import { state } from '../core/state.js';
import { setStatus } from './status.js';
import { promptString } from './prompt.js';
import * as lang from '../systems/language-packs.js';

let _win = null;
let _rows = [];        // [{ code, report }]
let _busy = false;

export async function openLanguagePanel() {
  if (_win) { _win.style.display = 'flex'; await _refresh(); return; }
  _build();
  await _refresh();
}

export function closeLanguagePanel() {
  if (!_win) return;
  _win.remove();
  _win = null;
  _rows = [];
}

// ─── Build ──────────────────────────────────────────────────────────────────

function _build() {
  _win = document.createElement('div');
  _win.id = 'language-window';
  _win.style.cssText = [
    'position:fixed', 'top:90px', 'left:120px', 'width:520px', 'max-height:76vh',
    'background:var(--panel,#0f172a)',
    'border:1px solid var(--line,#334155)',
    'border-radius:10px',
    'box-shadow:0 10px 30px rgba(0,0,0,0.5)',
    'z-index:45',
    'display:flex', 'flex-direction:column',
    'user-select:none',
  ].join(';');

  _win.innerHTML = `
    <div id="lang-header" style="
      cursor:move;padding:10px 12px;display:flex;align-items:center;gap:8px;
      background:rgba(59,130,246,0.18);border-bottom:1px solid var(--line,#334155);
      border-top-left-radius:10px;border-top-right-radius:10px;">
      <span style="flex:1;font-weight:600;font-size:13px;color:#dbeafe;">🌍 Languages</span>
      <button class="btn" id="lang-refresh" type="button" title="Rescan the project" style="padding:2px 8px;font-size:12px;">🔄</button>
      <button class="btn" id="lang-close"   type="button" style="padding:2px 8px;font-size:12px;">✕</button>
    </div>

    <div class="small muted" id="lang-note" style="padding:9px 14px 0;font-size:11.5px;line-height:1.5;"></div>

    <div id="lang-list" style="flex:1;overflow-y:auto;padding:10px 12px;display:flex;
                               flex-direction:column;gap:6px;min-height:70px;"></div>

    <div style="padding:10px 12px;border-top:1px solid var(--line,#334155);
                display:flex;align-items:center;gap:8px;">
      <button class="btn" id="lang-add" type="button" style="padding:4px 10px;">＋ Add language</button>
      <span class="small muted" id="lang-status" style="flex:1;font-size:11.5px;"></span>
    </div>
  `;

  document.body.appendChild(_win);
  _wireDrag(_win.querySelector('#lang-header'));
  _win.querySelector('#lang-close').addEventListener('click', closeLanguagePanel);
  _win.querySelector('#lang-refresh').addEventListener('click', () => _refresh());
  _win.querySelector('#lang-add').addEventListener('click', () => { _onAdd().catch(e => console.error('[lang] add failed:', e)); });
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

function _say(msg) { const el = _win?.querySelector('#lang-status'); if (el) el.textContent = msg || ''; }

let _refreshing = false;

async function _refresh() {
  if (!_win || _refreshing) return;   // overlapping refreshes duplicated rows
  _refreshing = true;
  try {
    const codes = await lang.listPackLanguages();
    const rows = [];
    for (const code of codes) {
      // A corrupt pack now throws rather than reading as "no pack" — surface
      // it as a row so the user can see WHICH file is broken.
      try { rows.push({ code, pack: await lang.loadPack(code) }); }
      catch (e) { rows.push({ code, pack: null, error: e.message }); }
    }
    if (!_win) return;               // panel closed while we awaited
    _rows = rows;
    _render();
  } finally {
    _refreshing = false;
  }
}

function _statsOf(pack) {
  const es = Object.values(pack?.entries || {});
  const s = { total: es.length, done: 0, stale: 0, edited: 0, missing: 0 };
  for (const e of es) {
    if (e.state === 'edited') {
      s.edited++;
      if (e.drifted) s.stale++;   // hand-edited AND the source moved — worth review, never auto-overwritten
    }
    else if (e.state === 'stale') s.stale++;
    else if (e.tgt) s.done++;
    else s.missing++;
  }
  s.unpositioned = Object.values(pack?.constTexts || {}).filter(v => v && !v.positioned).length;
  return s;
}

function _render() {
  if (!_win) return;
  const src = lang.sourceLang();
  const act = lang.activeLang();
  const saved = !!state.get('projectPath');

  const note = _win.querySelector('#lang-note');
  note.textContent = !saved
    ? 'Save the project first — language packs live in files beside the .sbsproj.'
    : `Authored in "${src}", currently showing "${act}". Packs live beside the project as <project>.<lang>.sbslang.json. Voiceover AUDIO and subtitle overrides are separate systems and are not swapped.`;

  // The add/refresh buttons sit outside the row list, so they need their own
  // busy state — otherwise they stay live during a long translate.
  for (const sel of ['#lang-add', '#lang-refresh']) {
    const b = _win.querySelector(sel);
    if (!b) continue;
    b.disabled = _busy;
    b.style.opacity = _busy ? '0.45' : '';
  }

  const list = _win.querySelector('#lang-list');
  list.textContent = '';

  list.appendChild(_langRow({
    code: src, isSource: true, active: act === src,
    stats: null,
  }));

  for (const { code, pack, error } of _rows) {
    if (code === src) continue;
    list.appendChild(_langRow({ code, isSource: false, active: act === code, stats: pack ? _statsOf(pack) : null, error }));
  }

  if (!_rows.filter(r => r.code !== src).length) {
    const empty = document.createElement('div');
    empty.className = 'small muted';
    empty.style.cssText = 'padding:10px 4px;font-size:12px;line-height:1.5;';
    empty.textContent = 'No other languages yet. "＋ Add language" creates a pack (e.g. he) and translates the project into it.';
    list.appendChild(empty);
  }
}

function _langRow({ code, isSource, active, stats, error }) {
  const row = document.createElement('div');
  row.style.cssText = [
    'display:flex', 'flex-direction:column', 'gap:6px', 'padding:9px 10px',
    'border-radius:7px', 'font-size:13px',
    `background:${active ? 'rgba(59,130,246,0.22)' : 'var(--panel2,#1e293b)'}`,
    `border:1px solid ${active ? '#3b82f6' : 'var(--line,#334155)'}`,
    'color:var(--text,#e2e8f0)',
  ].join(';');

  const top = document.createElement('div');
  top.style.cssText = 'display:flex;align-items:center;gap:8px;';
  const name = document.createElement('span');
  name.style.cssText = 'font-weight:600;';
  name.textContent = isSource ? `${code} — original` : code;
  const badge = document.createElement('span');
  badge.className = 'small muted';
  badge.style.cssText = 'font-size:11px;';
  badge.textContent = active ? '● showing now' : '';
  top.append(name, badge);

  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1;';
  top.appendChild(spacer);

  const mkBtn = (label, title, fn, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'padding:3px 9px;font-size:12px;';
    b.disabled = disabled || _busy;
    if (b.disabled) b.style.opacity = '0.45';
    b.addEventListener('click', () => fn());
    return b;
  };

  if (!isSource) {
    top.appendChild(mkBtn('Scan', 'Rescan the project and report what changed since this language was translated', () => _onScan(code)));
    top.appendChild(mkBtn('Translate', 'Machine-translate everything new or stale (hand-edited lines are kept)', () => _onTranslate(code)));
  }
  top.appendChild(mkBtn(active ? 'Showing' : 'Switch to', 'Put this language into the project', () => _onSwitch(code), active));
  row.appendChild(top);

  if (error) {
    const e = document.createElement('div');
    e.style.cssText = 'font-size:11.5px;color:#e06a5c;line-height:1.45;';
    e.textContent = error;
    row.appendChild(e);
  } else if (stats) {
    const s = document.createElement('div');
    s.className = 'small muted';
    s.style.cssText = 'font-size:11.5px;display:flex;gap:10px;flex-wrap:wrap;';
    const bits = [`${stats.done}/${stats.total} translated`];
    if (stats.stale)        bits.push(`⚠ ${stats.stale} drifted`);
    if (stats.missing)      bits.push(`${stats.missing} not translated`);
    if (stats.edited)       bits.push(`✎ ${stats.edited} hand-edited`);
    if (stats.unpositioned) bits.push(`◻ ${stats.unpositioned} sets unpositioned`);
    s.textContent = bits.join('   ·   ');
    row.appendChild(s);
  }
  return row;
}

// ─── Actions ────────────────────────────────────────────────────────────────

function _guardSource() {
  if (lang.activeLang() !== lang.sourceLang()) {
    setStatus(`Switch back to "${lang.sourceLang()}" first — scanning reads the original text.`, 'warn', 7000);
    return false;
  }
  return true;
}

async function _onAdd() {
  if (_busy) { setStatus('Busy — wait for the current operation to finish.', 'warn', 4000); return; }
  if (!state.get('projectPath')) { setStatus('Save the project first — packs live beside the .sbsproj.', 'warn', 6000); return; }
  const code = (await promptString('Language code (e.g. he, es, fr)', 'he') || '').trim().toLowerCase();
  if (!code) return;
  if (!/^[a-z]{2}(-[a-z]{2,4})?$/i.test(code)) { setStatus('Use a language code like he, es, pt-br.', 'warn', 6000); return; }
  if (code === lang.sourceLang()) { setStatus(`"${code}" is the project's own language.`, 'warn', 5000); return; }
  await _onScan(code);
}

async function _onScan(code) {
  if (_busy || !_guardSource()) return;
  _busy = true; _render(); _say(`Scanning for ${code}…`);
  try {
    const r = await lang.scanLanguage(code);
    if (!r.ok) { setStatus(r.error, 'warn', 8000); _say(''); return; }
    setStatus(`${code}: ${r.total} translatable lines — ${r.added} new, ${r.stale} drifted, ${r.edited} hand-edited.`, 'info', 8000);
    _say(`${r.added} new · ${r.stale} drifted`);
  } catch (e) {
    console.error('[lang] scan failed:', e);
    setStatus(`Scan failed: ${e?.message || e}`, 'warn', 8000);
  } finally {
    _busy = false;
    await _refresh();
  }
}

async function _onTranslate(code) {
  if (_busy || !_guardSource()) return;
  if (!lang.translationAvailable()) {
    setStatus('No Google API key — Settings → Cloud TTS tab.', 'warn', 8000);
    return;
  }
  _busy = true; _render(); _say(`Translating ${code}…`);
  try {
    const r = await lang.translateLanguage(code, {
      onProgress: (done, total) => _say(`Translating ${code}… ${done}/${total}`),
    });
    if (!r.ok) {
      setStatus(`${r.error} (${r.translated || 0} saved before the failure)`, 'warn', 9000);
    } else {
      setStatus(r.translated
        ? `Translated ${r.translated} line(s) into ${code}. Switch to it to see the project in ${code}.`
        : `${code} is already up to date.`, 'success', 8000);
    }
  } catch (e) {
    console.error('[lang] translate failed:', e);
    setStatus(`Translation failed: ${e?.message || e}`, 'warn', 8000);
  } finally {
    _busy = false;
    await _refresh();
  }
}

async function _onSwitch(code) {
  if (_busy) return;
  _busy = true; _render(); _say(`Switching to ${code}…`);
  try {
    const r = await lang.switchLanguage(code, { onProgress: (m) => _say(m) });
    if (!r.ok) { setStatus(r.error, 'warn', 8000); return; }
    setStatus(r.unchanged
      ? `Already showing ${code}.`
      : `Now showing ${code} — ${r.changed} field(s) swapped. Ctrl+Z reverses the switch.`, 'success', 8000);
  } catch (e) {
    console.error('[lang] switch failed:', e);
    setStatus(`Switch failed: ${e?.message || e}`, 'warn', 8000);
  } finally {
    _busy = false;
    await _refresh();
  }
}
