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
import { listVoices }    from '../systems/tts.js';

let _dlg = null;

export async function openSettingsModal(initialTab = 'language') {
  if (_dlg) { try { _dlg.close(); _dlg.remove(); } catch {} _dlg = null; }
  await userSettings.initUserSettings();

  _dlg = document.createElement('dialog');
  _dlg.className = 'sbs-dialog';
  _dlg.style.cssText = 'width:min(640px,90vw);max-height:80vh;background:#0e1420;border:1px solid #334155;border-radius:10px;padding:0;color:#e5e7eb;';

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
          <button class="settings-tab" data-tab="export">Export</button>
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
      .settings-tab{background:transparent;color:#cbd5e1;border:none;text-align:left;padding:6px 14px;cursor:pointer;font-size:13px;border-left:3px solid transparent;}
      .settings-tab:hover{background:rgba(255,255,255,0.04);}
      .settings-tab.active{background:rgba(245,158,11,0.10);color:#fbbf24;border-left-color:#f59e0b;}
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
  if (name === 'export')   _renderExportTab(body);
}

async function _renderLanguageTab(body) {
  const cur = userSettings.get();
  const voices = await listVoices().catch(() => []);
  const langs = Array.from(new Set(voices.map(v => v.lang).filter(Boolean))).sort();

  body.innerHTML = `
    <h3 style="margin:0 0 6px 0;font-size:14px;">Preferred narration language</h3>
    <p class="small muted" style="margin:0 0 10px 0;">
      Filters the voice dropdown so you only see voices for one language.
      Pick "Any" to see every installed voice.<br>
      OS locale detected: <code>${_esc(cur.ui.osLocale || '—')}</code>.
    </p>

    <label class="colorlab">Language
      <select id="settings-lang" style="margin-top:6px;">
        <option value="">Any (no filter)</option>
        ${langs.map(l => `<option value="${_esc(l)}" ${l === cur.ui.preferredLanguage ? 'selected' : ''}>${_esc(l)}</option>`).join('')}
      </select>
    </label>

    <p class="small muted" style="margin-top:14px;">
      Don't see your language? Install a Windows language pack:<br>
      <em>Settings → Time &amp; language → Language &amp; region → Add a language</em> (tick "Speech").
      Then restart this app.
    </p>
  `;

  body.querySelector('#settings-lang').addEventListener('change', async (e) => {
    await userSettings.patch({ ui: { preferredLanguage: e.target.value || '' } });
    // Notify any listening UI to re-render their voice lists.
    window.dispatchEvent(new CustomEvent('sbs:user-settings-changed', { detail: { section: 'ui' } }));
  });
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
        <input type="number" id="settings-fps" min="1" max="120" step="1" value="${ex.defaultFps ?? 30}" style="margin-top:6px;" />
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
