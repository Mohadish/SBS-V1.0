/**
 * SBS — Settings modal (File → Settings…).
 *
 * Tabs: Language, Export.
 * Mutates the user-level settings file via core/user-settings.js. Project
 * files are unaffected.
 *
 * Open via openSettingsModal(); idempotent — re-opening just brings the
 * existing dialog forward.
 */

import * as userSettings from '../core/user-settings.js';
import { buildRenderSettingsPanel } from './render-settings-panel.js';
import { listVoices, invalidateVoiceCache } from '../systems/tts.js';
import sceneCore         from '../core/scene.js';
import state             from '../core/state.js';
import * as actions       from '../systems/actions.js';

let _dlg = null;

export async function openSettingsModal(initialTab = 'language') {
  if (_dlg) { try { _dlg.close(); _dlg.remove(); } catch {} _dlg = null; }
  await userSettings.initUserSettings();

  _dlg = document.createElement('dialog');
  _dlg.className = 'sbs-dialog';
  _dlg.style.cssText = 'width:min(640px,90vw);max-height:80vh;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0;color:var(--text);';

  _dlg.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;min-height:380px;">
      <div style="padding:12px 16px;border-bottom:1px solid #334155;display:flex;align-items:center;gap:8px;">
        <strong style="font-size:14px;">Settings</strong>
        <span class="small muted" id="settings-path"></span>
        <span style="flex:1;"></span>
        <button class="btn" id="settings-close" style="height:24px;padding:0 10px;">Close</button>
      </div>
      <div style="display:flex;flex:1;min-height:0;">
        <nav id="settings-tabs" style="width:140px;border-right:1px solid #334155;padding:8px 0;display:flex;flex-direction:column;gap:2px;">
          <button class="settings-tab" data-tab="language">Language</button>
          <button class="settings-tab" data-tab="scene">Scene</button>
          <button class="settings-tab" data-tab="import">Import</button>
          <button class="settings-tab" data-tab="export">Export</button>
          <button class="settings-tab" data-tab="autosave">Autosave</button>
          <button class="settings-tab" data-tab="nuts">Nuts</button>
          <button class="settings-tab" data-tab="cloud">Cloud TTS</button>
          <button class="settings-tab" data-tab="translate">Translation</button>
        </nav>
        <section id="settings-body" style="flex:1;padding:14px 16px;overflow:auto;font-size:13px;">
        </section>
      </div>
    </div>
  `;

  // Style tabs (small, side-nav style).
  const styleId = '_sbs-settings-style';
  if (!document.getElementById(styleId)) {
    const s = document.createElement('style'); s.id = styleId;
    s.textContent = `
      .settings-tab{background:transparent;color:var(--text);border:none;text-align:left;padding:6px 14px;cursor:pointer;font-size:13px;border-left:3px solid transparent;}
      .settings-tab:hover{background:rgba(127,127,127,0.10);}
      .settings-tab.active{background:rgba(245,158,11,0.12);color:#d97706;border-left-color:#f59e0b;}
      html[data-theme="light"] .settings-tab.active{color:#b45309;}
    `;
    document.head.appendChild(s);
  }

  document.body.appendChild(_dlg);

  // Show file path so user knows where prefs live.
  if (window.sbsNative?.userSettings) {
    window.sbsNative.userSettings.path().then(p => {
      const lbl = _dlg.querySelector('#settings-path');
      if (lbl) lbl.textContent = p;
    }).catch(() => {});
  }

  _dlg.querySelector('#settings-close').addEventListener('click', () => closeSettingsModal());
  _dlg.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettingsModal(); });

  for (const tab of _dlg.querySelectorAll('.settings-tab')) {
    tab.addEventListener('click', () => _showTab(tab.dataset.tab));
  }

  _showTab(initialTab);
  _dlg.showModal();
}

export function closeSettingsModal() {
  if (!_dlg) return;
  try { _dlg.close(); _dlg.remove(); } catch {}
  _dlg = null;
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

function _showTab(name) {
  if (!_dlg) return;
  for (const tab of _dlg.querySelectorAll('.settings-tab')) {
    tab.classList.toggle('active', tab.dataset.tab === name);
  }
  const body = _dlg.querySelector('#settings-body');
  body.innerHTML = '';
  if (name === 'language') _renderLanguageTab(body);
  if (name === 'scene')    _renderSceneTab(body);
  if (name === 'import')   _renderImportTab(body);
  if (name === 'export')   _renderExportTab(body);
  if (name === 'nuts')     _renderNutsTab(body);
  if (name === 'cloud')    _renderCloudTab(body);
  if (name === 'translate') _renderTranslateTab(body);
  if (name === 'autosave') _renderAutosaveTab(body);
}

/**
 * V0.3.2.37 — Autosave tab. Writing a large project blocks the renderer for
 * seconds, so the point of these controls is WHEN that pause is allowed to
 * happen. Rotating slots give several restore points instead of one.
 */
function _renderAutosaveTab(body) {
  const s = userSettings.get().autosave || {};
  const row = (label, control, hint) =>
    `<div style="margin-bottom:14px"><label style="display:flex;align-items:center;gap:8px;font-size:13px">${control}<span>${label}</span></label>`
    + (hint ? `<div class="small muted" style="font-size:11px;opacity:.7;margin:3px 0 0 26px">${hint}</div>` : '') + '</div>';
  const num = (id, val, min, max, w = 60) =>
    `<input type="number" id="${id}" value="${val}" min="${min}" max="${max}" style="width:${w}px;padding:4px 6px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text)" />`;

  body.innerHTML = `
    <h3 style="margin:0 0 4px">Auto-backup</h3>
    <div class="small muted" style="font-size:12px;margin-bottom:14px;opacity:.8">
      Writes a spare copy of the project so a crash can't cost you everything. It never touches your real
      file — <b>Ctrl+S is still the save</b>. On a large project a backup pauses the app for a few seconds,
      which is what the timing options below are for.
    </div>

    ${row('Enable auto-backup',
          `<input type="checkbox" id="as-enabled" ${s.enabled !== false ? 'checked' : ''} />`,
          'A manual save restarts the countdown.')}

    ${row(`Back up after ${num('as-interval', s.intervalMin ?? 10, 1, 240)} minutes of unsaved work`, '',
          'Counts only while there are changes to save.')}

    ${row('Wait for a pause in my work',
          `<input type="checkbox" id="as-idle" ${s.waitForIdle !== false ? 'checked' : ''} />`,
          `Off = back up the moment it's due, even mid-action. On = wait until you've been idle for
           ${num('as-idlesec', s.idleSec ?? 6, 1, 120, 50)} seconds.`)}

    ${row('If I\'m still working, ask instead of interrupting',
          `<input type="checkbox" id="as-nudge" ${s.nudgeWhenBusy !== false ? 'checked' : ''} />`,
          `Shows a dismissible "good time to back up" prompt. Backs up anyway after
           ${num('as-maxwait', s.maxWaitMin ?? 25, 1, 480)} minutes so a crash can't cost more than that.`)}

    ${row(`Keep ${num('as-slots', s.slots ?? 3, 1, 9, 50)} rotating backups`, '',
          'Cycles through <code>name.autosave1 / 2 / 3</code> — oldest overwritten first, so you can step back through several versions.')}

    <div style="margin-bottom:6px;font-size:13px">Backup folder</div>
    <div style="display:flex;gap:6px;align-items:center">
      <input type="text" id="as-folder" value="${(s.folder || '').replace(/"/g, '&quot;')}" placeholder="(next to the project file)"
             style="flex:1;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);font-size:12px" />
      <button id="as-browse" class="btn" style="padding:6px 10px">Browse…</button>
      <button id="as-clear"  class="btn" style="padding:6px 10px">Default</button>
    </div>
    <div class="small muted" style="font-size:11px;opacity:.7;margin-top:4px">Empty = alongside the project. A folder on another drive doubles as off-machine insurance.</div>

    <div style="margin-top:18px;display:flex;gap:8px;align-items:center">
      <button id="as-now" class="btn" style="padding:6px 12px">Back up now</button>
      <span id="as-status" class="small muted" style="font-size:11px;opacity:.8"></span>
    </div>
  `;

  const save = (patch) => userSettings.patch({ autosave: patch });
  const bind = (id, ev, fn) => body.querySelector('#' + id)?.addEventListener(ev, fn);
  bind('as-enabled', 'change', e => save({ enabled: !!e.target.checked }));
  bind('as-idle',    'change', e => save({ waitForIdle: !!e.target.checked }));
  bind('as-nudge',   'change', e => save({ nudgeWhenBusy: !!e.target.checked }));
  bind('as-interval','change', e => save({ intervalMin: Math.max(1, Number(e.target.value) || 10) }));
  bind('as-idlesec', 'change', e => save({ idleSec:     Math.max(1, Number(e.target.value) || 6) }));
  bind('as-maxwait', 'change', e => save({ maxWaitMin:  Math.max(1, Number(e.target.value) || 25) }));
  bind('as-slots',   'change', e => save({ slots: Math.max(1, Math.min(9, Number(e.target.value) || 3)) }));
  bind('as-folder',  'change', e => save({ folder: e.target.value.trim() }));
  bind('as-clear',   'click',  () => { const i = body.querySelector('#as-folder'); i.value = ''; save({ folder: '' }); });
  bind('as-browse',  'click',  async () => {
    const dir = await window.sbsNative?.chooseFolder?.({ title: 'Choose backup folder' });
    if (dir) { body.querySelector('#as-folder').value = dir; save({ folder: dir }); }
  });
  bind('as-now', 'click', async () => {
    const st = body.querySelector('#as-status');
    if (st) st.textContent = 'Backing up…';
    const r = await window.sbsAutosave?.now?.();
    if (st) st.textContent = r?.saved ? `Saved ${r.mb} MB → ${r.path.split(/[\\/]/).pop()}`
                                      : (r?.skipped ? 'Save the project once first.' : 'Backup failed — see console.');
  });
  window.sbsAutosave?.status?.().then(x => {
    const st = body.querySelector('#as-status');
    if (st && x) st.textContent = `Last backup ${x.minsSinceBackup} min ago · next slot: ${String(x.nextSlot || '').split(/[\\/]/).pop() || '—'}`;
  }).catch(() => {});
}

/**
 * V0.2.22.58 — Nuts tab. System-level defaults for the hardware
 * insertion animation, saved with user data. Per-instance values left
 * as "use default" resolve to the project default (.sbsproj) then to
 * these. See systems/hardware-defaults.js.
 */
function _renderNutsTab(body) {
  const cur = userSettings.get();
  const n = cur.nuts || {};
  const sz = n.tagSize || 'medium';
  body.innerHTML = `
    <h3 style="margin:0 0 6px 0;font-size:14px;">Hardware insertion defaults</h3>
    <p class="small muted" style="margin:0 0 12px 0;">
      Default values for the screw insertion animation. A screw set to
      "use default" for an option pulls from here (or from a project's
      own saved default, if one is set in the Hardware tab).
    </p>

    <div class="grid2" style="gap:10px;">
      <label class="small muted">Spacing X (mm)
        <input type="number" id="_nt-x" value="${_esc(String(n.distance ?? 20))}" min="1" step="1"
          style="width:100%;box-sizing:border-box;margin-top:3px;" />
      </label>
      <label class="small muted">Reposition pre-step (ms)
        <input type="number" id="_nt-ms" value="${_esc(String(n.repositionMs ?? 300))}" min="0" step="10"
          style="width:100%;box-sizing:border-box;margin-top:3px;" />
      </label>
    </div>

    <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer;">
      <input type="checkbox" id="_nt-tag" ${n.tagName ? 'checked' : ''} />
      <span class="small">Show name tag by default</span>
    </label>
    <div style="display:flex;align-items:flex-end;gap:14px;margin-top:6px;margin-left:24px;">
      <label class="small muted">Tag size
        <select id="_nt-size" style="margin-left:6px;">
          <option value="small"  ${sz === 'small'  ? 'selected' : ''}>Small</option>
          <option value="medium" ${sz === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="large"  ${sz === 'large'  ? 'selected' : ''}>Large</option>
        </select>
      </label>
      <label class="small muted">Text colour
        <input type="color" id="_nt-tagcolor" value="${_esc(n.tagColor || '#ffffff')}"
          style="width:48px;height:28px;margin-top:3px;margin-left:6px;padding:2px;border-radius:4px;cursor:pointer;vertical-align:middle;" />
      </label>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer;">
      <input type="checkbox" id="_nt-explode" ${n.explodeBefore ? 'checked' : ''} />
      <span class="small">Display exploded before insertion</span>
    </label>
    <div class="small muted" style="margin:2px 0 0 24px;font-size:10px;opacity:0.7;">
      Shows the nut pulled apart (washers below the head) on every step before it's inserted.
    </div>

    <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer;">
      <input type="checkbox" id="_nt-pause" ${n.pauseBefore ? 'checked' : ''} />
      <span class="small">Pause before insertion</span>
      <input type="number" id="_nt-pausems" value="${_esc(String(n.pauseBeforeMs ?? 300))}" min="0" step="50"
        style="width:96px;margin-left:6px;" /> <span class="small muted">ms</span>
    </label>
    <div class="small muted" style="margin:2px 0 0 24px;font-size:10px;opacity:0.7;">
      Holds on the exploded nut so the tags are readable, then inserts.
    </div>

    <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer;">
      <input type="checkbox" id="_nt-traj" ${n.trajectory ? 'checked' : ''} />
      <span class="small">Show trajectory line by default</span>
    </label>
    <div class="grid3" style="gap:10px;margin-top:6px;margin-left:24px;">
      <label class="small muted">Thickness (mm)
        <input type="number" id="_nt-thick" value="${_esc(String(n.lineThickness ?? 0.5))}" min="0.05" step="0.05"
          style="width:100%;box-sizing:border-box;margin-top:3px;" />
      </label>
      <label class="small muted">Gap scale
        <input type="number" id="_nt-gap" value="${_esc(String(n.lineGap ?? 2))}" min="0" step="0.25"
          style="width:100%;box-sizing:border-box;margin-top:3px;" title="gap = thickness × this" />
      </label>
      <label class="small muted">Colour
        <input type="color" id="_nt-color" value="${_esc(n.lineColor || '#ffaa00')}"
          style="width:48px;height:28px;margin-top:3px;padding:2px;border-radius:4px;cursor:pointer;" />
      </label>
    </div>
  `;

  const save = () => {
    userSettings.patch({ nuts: {
      distance:      Math.max(1, Number(body.querySelector('#_nt-x').value)    || 20),
      repositionMs:  Math.max(0, Number(body.querySelector('#_nt-ms').value)   || 300),
      tagName:       body.querySelector('#_nt-tag').checked,
      tagSize:       body.querySelector('#_nt-size').value,
      tagColor:      body.querySelector('#_nt-tagcolor').value,
      explodeBefore: body.querySelector('#_nt-explode').checked,
      pauseBefore:   body.querySelector('#_nt-pause').checked,
      pauseBeforeMs: Math.max(0, Number(body.querySelector('#_nt-pausems').value) || 300),
      trajectory:    body.querySelector('#_nt-traj').checked,
      lineThickness: Math.max(0.05, Number(body.querySelector('#_nt-thick').value) || 0.5),
      lineGap:       Math.max(0,    Number(body.querySelector('#_nt-gap').value)   || 2),
      lineColor:     body.querySelector('#_nt-color').value,
    } });
  };
  for (const sel of ['#_nt-x','#_nt-ms','#_nt-tag','#_nt-size','#_nt-tagcolor','#_nt-explode','#_nt-pause','#_nt-pausems','#_nt-traj','#_nt-thick','#_nt-gap','#_nt-color']) {
    body.querySelector(sel)?.addEventListener('change', save);
  }
}

/**
 * V0.2.22.35 — Cloud TTS tab. Personal-authoring scope: when enabled +
 * an API key is set, the Export tab's voice dropdown lists Google Cloud
 * Hebrew voices alongside the OS ones. Off by default; opt-in only.
 *
 * The key is stored plaintext in user-settings.json (under userData) —
 * standard for personal-machine config and consistent with how other
 * personal-scope settings are stored. Note in the UI explains this.
 */
function _renderCloudTab(body) {
  const cur   = userSettings.get();
  const cloud = cur.cloud || { enabled: false, googleApiKey: '' };

  body.innerHTML = `
    <h3 style="margin:0 0 6px 0;font-size:14px;">Cloud Text-to-Speech (experimental)</h3>
    <p class="small muted" style="margin:0 0 10px 0;">
      Opt-in: enables Google Cloud TTS Hebrew voices in the Export tab's
      voice picker. Better Hebrew quality than the default OS voice (Asaf).
      Requires internet + a Google Cloud API key. Personal-use scope —
      not shipped to end-users of your exported projects.
    </p>

    <p class="small" style="margin:0 0 10px 0;padding:8px;background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);border-radius:6px;color:#fbbf24;">
      <strong>How to get a key:</strong> sign in to
      <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#fbbf24;text-decoration:underline;">console.cloud.google.com</a>
      → enable the <em>Text-to-Speech API</em> → create an API key →
      paste it below. Google's free tier covers ~1 M characters/month of
      WaveNet voices — typical personal authoring stays free.
    </p>

    <label style="display:flex;align-items:center;gap:8px;margin:14px 0 6px 0;cursor:pointer;">
      <input type="checkbox" id="cloud-enabled" ${cloud.enabled ? 'checked' : ''}/>
      <strong>Enable Google Cloud TTS</strong>
    </label>

    <div id="cloud-key-row" style="display:${cloud.enabled ? 'block' : 'none'};margin-top:8px;">
      <label class="small muted" style="display:block;margin-bottom:4px;">Google Cloud TTS API key</label>
      <input type="password" id="cloud-key" value="${_esc(cloud.googleApiKey)}"
             placeholder="AIza..." autocomplete="off" spellcheck="false"
             style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);font-family:monospace;font-size:12px;" />
      <p class="small muted" style="margin:6px 0 0 0;font-size:11px;">
        Stored as plain text in <code>user-settings.json</code> (machine-scope).
        Never written to project files. Cleared when you delete it here or
        uncheck the toggle above. After saving, re-open the Export tab to
        refresh the voice dropdown.
      </p>
    </div>

    <div id="cloud-test-row" style="display:${cloud.enabled ? 'block' : 'none'};margin-top:12px;">
      <button class="btn" id="cloud-test-btn">Test connection</button>
      <span id="cloud-test-status" class="small muted" style="margin-left:8px;"></span>
    </div>
  `;

  const enabledCb = body.querySelector('#cloud-enabled');
  const keyInp    = body.querySelector('#cloud-key');
  const keyRow    = body.querySelector('#cloud-key-row');
  const testRow   = body.querySelector('#cloud-test-row');
  const testBtn   = body.querySelector('#cloud-test-btn');
  const testStat  = body.querySelector('#cloud-test-status');

  const _refreshVisibility = () => {
    const on = !!enabledCb.checked;
    keyRow.style.display  = on ? 'block' : 'none';
    testRow.style.display = on ? 'block' : 'none';
  };

  enabledCb.addEventListener('change', async () => {
    await userSettings.patch({ cloud: { enabled: !!enabledCb.checked } });
    invalidateVoiceCache();
    window.dispatchEvent(new CustomEvent('sbs:user-settings-changed', { detail: { section: 'cloud' } }));
    _refreshVisibility();
  });

  // Save on blur, not every keystroke — API keys are long and we don't
  // want partial keys hitting disk on every character.
  keyInp.addEventListener('change', async () => {
    await userSettings.patch({ cloud: { googleApiKey: keyInp.value.trim() } });
    invalidateVoiceCache();
    window.dispatchEvent(new CustomEvent('sbs:user-settings-changed', { detail: { section: 'cloud' } }));
  });
  keyInp.addEventListener('blur', async () => {
    await userSettings.patch({ cloud: { googleApiKey: keyInp.value.trim() } });
    invalidateVoiceCache();
    window.dispatchEvent(new CustomEvent('sbs:user-settings-changed', { detail: { section: 'cloud' } }));
  });

  // One-shot test: synth "שלום" with the first Hebrew WaveNet voice and
  // surface the result. Validates key + network + Hebrew billing on
  // the project all in one click.
  testBtn.addEventListener('click', async () => {
    const apiKey = keyInp.value.trim();
    if (!apiKey) { testStat.textContent = 'Paste an API key first.'; testStat.style.color = '#f87171'; return; }
    testStat.textContent = 'Testing…'; testStat.style.color = '';
    try {
      // Save the key first so the test reads the same one synth would.
      await userSettings.patch({ cloud: { googleApiKey: apiKey, enabled: true } });
      invalidateVoiceCache();
      const { synthesize } = await import('../systems/tts.js');
      const out = await synthesize('שלום עולם.', 'gcp:he-IL-Wavenet-B', { speed: 1.0 });
      const audio = new Audio(out.dataUrl);
      audio.play().catch(() => {});
      testStat.innerHTML = `<span style="color:#86efac;">✓ ${Math.round(out.durationMs)} ms — playing…</span>`;
    } catch (e) {
      testStat.innerHTML = `<span style="color:#f87171;">✗ ${_esc(e?.message || 'failed')}</span>`;
    }
  });
}

async function _renderLanguageTab(body) {
  const cur = userSettings.get();
  const selected = new Set(cur.ui.preferredLanguages || []);

  // Pull every input we have:
  //  - OS-installed languages (Get-WinUserLanguageList on Win) — primary
  //  - Languages of installed voices (in case OS list misses something)
  // Union, deduped by friendly name.
  const [osLangs, voices] = await Promise.all([
    window.sbsNative?.userSettings?.installedLanguages?.() ?? Promise.resolve([]),
    listVoices().catch(() => []),
  ]);
  const fromOs     = (osLangs || []).map(o => ({ name: _normalizeLangName(o.name), tag: o.tag, source: 'os' }));
  const fromVoices = (voices  || []).map(v => ({ name: _normalizeLangName(v.lang), tag: '',  source: 'voice' }));

  // Map by friendly name; merge sources so we can show whether voices exist.
  const byName = new Map();
  for (const e of [...fromOs, ...fromVoices]) {
    if (!e.name) continue;
    const cur = byName.get(e.name) || { name: e.name, tags: new Set(), hasVoice: false };
    if (e.tag) cur.tags.add(e.tag);
    if (e.source === 'voice') cur.hasVoice = true;
    byName.set(e.name, cur);
  }
  const items = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  // Mark which of our selected languages have voices (for warning display).
  const selectedWithoutVoices = [...selected].filter(name => {
    const m = byName.get(name);
    return m && !m.hasVoice;
  });

  body.innerHTML = `
    <h3 style="margin:0 0 6px 0;font-size:14px;">Preferred narration languages</h3>
    <p class="small muted" style="margin:0 0 10px 0;">
      Tick the languages you want to use. The voice dropdown in the Export
      tab will only show voices for the languages you pick. Untick all to
      disable filtering.<br>
      OS locale detected: <code>${_esc(cur.ui.osLocale || '—')}</code>.
    </p>

    <p class="small" style="margin:0 0 10px 0;padding:8px;background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);border-radius:6px;color:#fbbf24;">
      <strong>Heads up:</strong> Windows separates "language pack" (display
      language) from "speech voices" (TTS). A language with <em>no voices
      yet</em> means the speech feature wasn't installed for it. Open
      <em>Windows Settings → Time &amp; language → Speech</em> and install
      voices for the language you want, then restart this app.
    </p>

    <div id="settings-lang-list" style="display:flex;flex-direction:column;gap:4px;max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:8px;background:var(--panel2);">
      ${items.length === 0
        ? '<div class="small muted">No installed languages detected. Try: Windows Settings → Time &amp; language → Language &amp; region.</div>'
        : items.map(it => {
            const id = `lang-${_esc(it.name).replace(/\s+/g, '-')}`;
            return `
              <label for="${id}" style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 6px;border-radius:4px;background:rgba(255,255,255,0.02);">
                <input type="checkbox" id="${id}" data-lang-name="${_esc(it.name)}" ${selected.has(it.name) ? 'checked' : ''} />
                <span style="flex:1;font-size:13px;">${_esc(it.name) || '<em style="opacity:0.5;">(unnamed)</em>'}</span>
                ${it.hasVoice
                  ? '<span class="small" style="color:#86efac;font-size:11px;">✓ voices ready</span>'
                  : '<span class="small muted" style="font-size:11px;">no voices yet</span>'}
              </label>
            `;
          }).join('')}
    </div>

    ${selectedWithoutVoices.length ? `
      <p class="small" style="margin-top:10px;color:#f59e0b;">
        ⚠ You picked <strong>${selectedWithoutVoices.map(_esc).join(', ')}</strong> but Windows hasn't installed speech voices for those.
        Install via <em>Windows Settings → Time &amp; language → Speech</em>, then restart this app.
      </p>` : ''}

    <p class="small muted" style="margin-top:10px;">
      Detected ${items.length} language(s) — ${items.filter(i => i.hasVoice).length} with voices, ${items.filter(i => !i.hasVoice).length} without.
    </p>
  `;

  body.querySelectorAll('input[type=checkbox][data-lang-name]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const name = cb.dataset.langName;
      if (cb.checked) selected.add(name);
      else            selected.delete(name);
      await userSettings.patch({ ui: { preferredLanguages: [...selected] } });
      window.dispatchEvent(new CustomEvent('sbs:user-settings-changed', { detail: { section: 'ui' } }));
    });
  });
}

/** Shorten "Hebrew (Israel)" → "Hebrew" so OS + voice lists merge cleanly. */
function _normalizeLangName(raw) {
  if (!raw) return '';
  return String(raw).split(/[(\u00ad/-]/)[0].trim();
}

function _renderSceneTab(body) {
  const cur = userSettings.get();
  const sc  = cur.scene || {};
  const grad = sc.defaultBackgroundGradient || { enabled:false, color1:'#0f172a', color2:'#1e293b', angleDeg:180 };
  const zoom = (typeof sc.cameraZoomScale === 'number') ? sc.cameraZoomScale : 1.0;

  body.innerHTML = `
    <h3 style="margin:0 0 6px 0;font-size:14px;">Camera</h3>
    <p class="small muted" style="margin:0 0 10px 0;">
      Adjusts how much each wheel-tick zooms. The step scales with the
      camera's distance to the orbit pivot, so it works at any model
      size — this slider just biases the default sensitivity.
    </p>

    <label class="colorlab" style="display:block;">
      Scene → Camera zoom scale
      <span id="scene-zoom-val" class="muted" style="float:right;">${zoom.toFixed(2)}×</span>
      <input type="range" id="scene-zoom" min="0.1" max="5" step="0.05" value="${zoom}"
             style="width:100%;margin-top:6px;" />
    </label>
    <div class="small muted" style="margin-top:4px;font-size:11px;">
      0.1× = very fine · 1.0× = default · 5.0× = very coarse
    </div>

    <hr style="border:none;border-top:1px solid var(--line);margin:16px 0;" />

    <h3 style="margin:0 0 6px 0;font-size:14px;">Default background</h3>
    <p class="small muted" style="margin:0 0 10px 0;">
      Applied to new projects (and live to the current viewport). Saved
      projects can still override per-file.
    </p>

    <div class="field-row">
      <label class="small" style="flex:1;">Solid color</label>
      <input type="color" id="scene-bg-color" value="${_esc(sc.defaultBackgroundColor || '#0f172a')}"
             style="width:44px;height:28px;padding:2px;border-radius:4px;cursor:pointer;" />
    </div>

    <label class="small" style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;">
      <input type="checkbox" id="scene-bg-grad-toggle" ${grad.enabled ? 'checked' : ''} />
      Use 2-color gradient
    </label>

    <div id="scene-bg-grad-controls" style="display:${grad.enabled ? 'block' : 'none'};margin-top:8px;">
      <div class="field-row">
        <label class="small" style="flex:1;">From</label>
        <input type="color" id="scene-bg-grad-c1" value="${_esc(grad.color1 || '#0f172a')}"
               style="width:44px;height:28px;padding:2px;border-radius:4px;cursor:pointer;" />
      </div>
      <div class="field-row" style="margin-top:6px;">
        <label class="small" style="flex:1;">To</label>
        <input type="color" id="scene-bg-grad-c2" value="${_esc(grad.color2 || '#1e293b')}"
               style="width:44px;height:28px;padding:2px;border-radius:4px;cursor:pointer;" />
      </div>
      <label class="small" style="display:block;margin-top:8px;">
        Direction <span id="scene-bg-grad-angle-val" class="muted" style="float:right;">${grad.angleDeg ?? 180}°</span>
        <input type="range" id="scene-bg-grad-angle" min="0" max="360" step="1" value="${grad.angleDeg ?? 180}"
               style="width:100%;margin-top:4px;" />
      </label>
      <div class="small muted" style="margin-top:4px;line-height:1.4;font-size:10px;">
        0° top→bottom · 90° left→right · 180° bottom→top · 270° right→left
      </div>
    </div>
  `;

  // AO + SSR sliders (shared panel; per-project state.render).
  body.appendChild(buildRenderSettingsPanel());

  // ── Zoom slider ─────────────────────────────────────────────────────────
  const zoomEl    = body.querySelector('#scene-zoom');
  const zoomLabel = body.querySelector('#scene-zoom-val');
  zoomEl.addEventListener('input', () => {
    const v = Number(zoomEl.value) || 1.0;
    zoomLabel.textContent = `${v.toFixed(2)}×`;
    sceneCore.setUserZoomScale(v);   // live apply
  });
  zoomEl.addEventListener('change', () => {
    const v = Number(zoomEl.value) || 1.0;
    userSettings.patch({ scene: { cameraZoomScale: v } });
  });

  // ── Background — solid color ────────────────────────────────────────────
  body.querySelector('#scene-bg-color').addEventListener('input', e => {
    const v = e.target.value;
    userSettings.patch({ scene: { defaultBackgroundColor: v } });   // pref (not undoable)
    // Live apply to project state — undoable (change:backgroundColor repaints).
    actions.commitStateChange('Background color', ['backgroundColor'], () => {
      state.setState({ backgroundColor: v });
      state.markDirty();
    }, { coalesceKey: 'bgColor' });
  });

  // ── Background — gradient ───────────────────────────────────────────────
  const _patchGrad = (partial) => {
    const cur2  = userSettings.get();
    const merged = { ...(cur2.scene?.defaultBackgroundGradient || {}), ...partial };
    userSettings.patch({ scene: { defaultBackgroundGradient: merged } });   // pref
    // Live-apply to current project state — undoable.
    actions.commitStateChange('Background gradient', ['backgroundGradient'], () => {
      state.setState({ backgroundGradient: { ...(state.get('backgroundGradient') || {}), ...partial } });
      state.markDirty();
    }, { coalesceKey: 'bgGradient' });
  };

  const gradToggle = body.querySelector('#scene-bg-grad-toggle');
  const gradWrap   = body.querySelector('#scene-bg-grad-controls');
  gradToggle.addEventListener('change', () => {
    const on = gradToggle.checked;
    gradWrap.style.display = on ? 'block' : 'none';
    _patchGrad({ enabled: on });
  });

  body.querySelector('#scene-bg-grad-c1').addEventListener('input', e =>
    _patchGrad({ color1: e.target.value }));
  body.querySelector('#scene-bg-grad-c2').addEventListener('input', e =>
    _patchGrad({ color2: e.target.value }));

  const angleEl    = body.querySelector('#scene-bg-grad-angle');
  const angleLabel = body.querySelector('#scene-bg-grad-angle-val');
  angleEl.addEventListener('input', () => {
    const deg = Number(angleEl.value) || 0;
    angleLabel.textContent = `${deg}°`;
    _patchGrad({ angleDeg: deg });
  });
}

/**
 * V0.2.22.85 — Import tab. Controls how STEP/IGES files are brought in via
 * the native 64-bit converter: the tree structure (assembly hierarchy with
 * real names vs a flat part list), and whether to ask per-file at load time.
 */
function _renderImportTab(body) {
  const cur  = userSettings.get();
  const cad  = cur.cad || {};
  const mode = cad.importMode === 'flat' ? 'flat' : 'hierarchy';

  body.innerHTML = `
    <h3 style="margin:0 0 6px 0;font-size:14px;">CAD import (STEP / IGES)</h3>
    <p class="small muted" style="margin:0 0 12px 0;line-height:1.5;">
      How big CAD files are organised when the native converter brings them in.
      Affects new imports only — existing project files keep their structure.
    </p>

    <h4 style="margin:6px 0;font-size:13px;">Default tree structure</h4>
    <label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;cursor:pointer;">
      <input type="radio" name="imp-mode" value="hierarchy" ${mode !== 'flat' ? 'checked' : ''} />
      <span class="small"><b>Assembly hierarchy</b> — folders + real part names that mirror the
        CAD assembly tree (like SolidWorks). <i>(recommended)</i></span>
    </label>
    <label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;cursor:pointer;">
      <input type="radio" name="imp-mode" value="flat" ${mode === 'flat' ? 'checked' : ''} />
      <span class="small"><b>Flat list (legacy)</b> — every part at one level, generic names.
        Lowest risk, no restructuring — the original behaviour.</span>
    </label>

    <label style="display:flex;align-items:center;gap:8px;margin-top:16px;cursor:pointer;">
      <input type="checkbox" id="imp-ask" ${cad.askImportOnLoad ? 'checked' : ''} />
      <span class="small">Ask me which structure to use each time I load a CAD file</span>
    </label>
    <div class="small muted" style="margin:2px 0 0 24px;font-size:11px;opacity:0.8;">
      When on, the STEP load popup shows a Hierarchy / Flat choice. When off, loads
      silently use the default above.
    </div>
  `;

  for (const r of body.querySelectorAll('input[name="imp-mode"]')) {
    r.addEventListener('change', () => {
      if (r.checked) userSettings.patch({ cad: { importMode: r.value } });
    });
  }
  body.querySelector('#imp-ask').addEventListener('change', e =>
    userSettings.patch({ cad: { askImportOnLoad: !!e.target.checked } }));
}

function _renderExportTab(body) {
  const cur = userSettings.get();
  const ex  = cur.export || {};

  body.innerHTML = `
    <h3 style="margin:0 0 6px 0;font-size:14px;">Export defaults</h3>
    <p class="small muted" style="margin:0 0 10px 0;">
      Used as defaults for new projects. Existing projects keep their own
      Export tab values.
    </p>

    <div class="grid2">
      <label class="colorlab">Default frame rate (fps)
        <input type="number" id="settings-fps" min="1" max="120" step="1" value="${ex.defaultFps ?? 50}" style="margin-top:6px;" />
      </label>
      <label class="colorlab">Default step hold (ms)
        <input type="number" id="settings-hold" min="0" max="10000" step="100" value="${ex.defaultStepHoldMs ?? 800}" style="margin-top:6px;" />
      </label>
    </div>

    <label class="colorlab" style="margin-top:10px;">Default output format
      <select id="settings-fmt" style="margin-top:6px;">
        <option value="mp4"      ${ex.defaultFormat === 'mp4'      ? 'selected' : ''}>MP4 (H.264)</option>
        <option value="webm_vp9" ${ex.defaultFormat === 'webm_vp9' ? 'selected' : ''}>WebM VP9</option>
        <option value="webm_vp8" ${ex.defaultFormat === 'webm_vp8' ? 'selected' : ''}>WebM VP8</option>
      </select>
    </label>

    <label style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer;">
      <input type="checkbox" id="settings-narr" ${ex.narrationEnabled !== false ? 'checked' : ''} />
      <span class="small muted">Include narration in export by default</span>
    </label>
  `;

  body.querySelector('#settings-fps').addEventListener('change', e =>
    userSettings.patch({ export: { defaultFps: Number(e.target.value) || 30 } }));
  body.querySelector('#settings-hold').addEventListener('change', e =>
    userSettings.patch({ export: { defaultStepHoldMs: Number(e.target.value) || 800 } }));
  body.querySelector('#settings-fmt').addEventListener('change', e =>
    userSettings.patch({ export: { defaultFormat: e.target.value } }));
  body.querySelector('#settings-narr').addEventListener('change', e =>
    userSettings.patch({ export: { narrationEnabled: !!e.target.checked } }));
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

/**
 * V0.3.2.147 — Translation engine tab.
 *
 * The offline engine talks to an OpenAI-compatible server running on this
 * machine, which is the protocol Ollama, LM Studio and llama.cpp's server
 * all speak — so the runtime stays the user's choice, not ours.
 *
 * The Test button round-trips a real sentence and shows what came back. A
 * tick that only proved the socket opened would hide the failure that
 * actually matters: a server that answers but translates badly, or chats
 * back instead of translating.
 */
function _renderTranslateTab(body) {
  const cur     = userSettings.get();
  const t       = cur.translate || {};
  const isLocal = (t.provider || 'google') === 'local';
  const gloss   = (Array.isArray(t.glossary) ? t.glossary : [])
    .map(g => `${g.from} = ${g.to}`).join('\n');

  body.innerHTML = `
    <h3 style="margin:0 0 6px 0;font-size:14px;">Translation engine</h3>
    <p class="small muted" style="margin:0 0 12px 0;">
      Used by language packs and subtitles. The offline engine runs a model
      on this computer — no account, no API key, no internet.
    </p>

    <label style="display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;">
      <input type="radio" name="tr-provider" value="google" ${isLocal ? '' : 'checked'} />
      <span><strong>Google Cloud Translation</strong> — needs internet and a billed API key.</span>
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;">
      <input type="radio" name="tr-provider" value="local" ${isLocal ? 'checked' : ''} />
      <span><strong>Offline (local model)</strong> — runs on this machine's GPU.</span>
    </label>

    <div id="tr-local" style="display:${isLocal ? 'block' : 'none'};margin-top:14px;border-top:1px solid var(--line);padding-top:12px;">
      <label class="small muted" style="display:block;margin-bottom:4px;">Server URL (OpenAI-compatible)</label>
      <input type="text" id="tr-url" value="${_esc(t.localBaseUrl || '')}" spellcheck="false"
             placeholder="http://127.0.0.1:11434/v1"
             style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);font-family:monospace;font-size:12px;" />
      <p class="small muted" style="margin:4px 0 10px 0;font-size:11px;">
        Ollama <code>http://127.0.0.1:11434/v1</code> ·
        LM Studio <code>http://127.0.0.1:1234/v1</code> ·
        llama.cpp <code>http://127.0.0.1:8080/v1</code>
      </p>

      <label class="small muted" style="display:block;margin-bottom:4px;">Model name</label>
      <input type="text" id="tr-model" value="${_esc(t.localModel || '')}" spellcheck="false"
             placeholder="gemma3:12b"
             style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);font-family:monospace;font-size:12px;" />
      <p class="small muted" style="margin:4px 0 10px 0;font-size:11px;">
        Exactly as the server names it — <code>ollama list</code> for Ollama.
      </p>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <label class="small muted" style="display:block;margin-bottom:4px;">Timeout (seconds)</label>
          <input type="number" id="tr-timeout" min="5" max="900" value="${Math.round((t.timeoutMs || 120000) / 1000)}"
                 style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);font-size:12px;" />
        </div>
        <div>
          <label class="small muted" style="display:block;margin-bottom:4px;">Parallel requests</label>
          <input type="number" id="tr-conc" min="1" max="8" value="${Number(t.concurrency) || 2}"
                 style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);font-size:12px;" />
        </div>
      </div>
      <p class="small muted" style="margin:4px 0 10px 0;font-size:11px;">
        Raise parallel requests only if the server is configured for it —
        Ollama needs <code>OLLAMA_NUM_PARALLEL</code>. Too high just queues.
      </p>

      <label class="small muted" style="display:block;margin:10px 0 4px 0;">Glossary — one <code>term = translation</code> per line</label>
      <textarea id="tr-gloss" rows="5" spellcheck="false"
                style="width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);font-family:monospace;font-size:12px;">${_esc(gloss)}</textarea>
      <p class="small muted" style="margin:4px 0 12px 0;font-size:11px;">
        Forced on every translation. This is the offline engine's real
        advantage — your terminology is instructed, not guessed at.
      </p>

      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn" id="tr-test">Test connection</button>
        <span id="tr-test-out" class="small muted"></span>
      </div>
      <pre id="tr-test-sample" class="small" style="display:none;margin-top:8px;padding:8px;background:var(--panel2);border:1px solid var(--line);border-radius:4px;white-space:pre-wrap;font-size:11px;"></pre>
    </div>
  `;

  const q = (sel) => body.querySelector(sel);

  const readGlossary = () => String(q('#tr-gloss')?.value || '')
    .split('\n')
    .map(line => {
      const i = line.indexOf('=');
      if (i < 0) return null;
      const from = line.slice(0, i).trim();
      const to   = line.slice(i + 1).trim();
      return (from && to) ? { from, to } : null;
    })
    .filter(Boolean);

  const save = async () => {
    const secs = Number(q('#tr-timeout')?.value);
    await userSettings.patch({ translate: {
      provider:     body.querySelector('input[name="tr-provider"]:checked')?.value || 'google',
      localBaseUrl: String(q('#tr-url')?.value || '').trim(),
      localModel:   String(q('#tr-model')?.value || '').trim(),
      timeoutMs:    (Number.isFinite(secs) && secs > 0 ? secs : 120) * 1000,
      concurrency:  Math.max(1, Math.min(8, Number(q('#tr-conc')?.value) || 2)),
      glossary:     readGlossary(),
    } });
    window.dispatchEvent(new CustomEvent('sbs:user-settings-changed', { detail: { section: 'translate' } }));
  };

  for (const r of body.querySelectorAll('input[name="tr-provider"]')) {
    r.addEventListener('change', async () => {
      q('#tr-local').style.display = (r.value === 'local' && r.checked) ? 'block' : 'none';
      await save();
    });
  }
  for (const sel of ['#tr-url', '#tr-model', '#tr-timeout', '#tr-conc', '#tr-gloss']) {
    q(sel)?.addEventListener('change', save);
  }

  q('#tr-test')?.addEventListener('click', async () => {
    await save();                                    // test exactly what's on screen
    const out    = q('#tr-test-out');
    const sample = q('#tr-test-sample');
    out.textContent = 'Testing…';
    out.style.color = '';
    sample.style.display = 'none';
    const secs = Number(q('#tr-timeout')?.value);
    const res  = await window.sbsNative?.translate?.testLocal?.({
      baseUrl:   String(q('#tr-url').value || '').trim(),
      model:     String(q('#tr-model').value || '').trim(),
      target:    'he',
      timeoutMs: (Number.isFinite(secs) && secs > 0 ? secs : 120) * 1000,
    });
    if (!res) { out.textContent = 'Test unavailable in this build.'; return; }
    if (res.ok) {
      out.textContent = `OK — ${res.ms} ms`;
      out.style.color = '#4ade80';
      sample.style.display = 'block';
      sample.textContent = `EN  ${res.sample}\nHE  ${res.text}`;
    } else {
      out.textContent = res.error || 'Failed.';
      out.style.color = '#f87171';
    }
  });
}
