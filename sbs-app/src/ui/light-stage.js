/**
 * 💡 Light Stage (V0.3.2.53) — a visual instrument for the production look,
 * replacing the wall of sliders with one schematic you touch.
 *
 * Top-down orbit ring with the object at centre and three light handles:
 *   KEY (warm) + FILL (cool) — DRAG either around the ring to aim the whole
 *   world-fixed rig (writes production.angle); FILL rides KEY at the shader's
 *   fixed +150° offset so the relationship is visible.
 *   RIM — camera-relative, pinned near the viewer marker (not azimuth-drag).
 * CLICK a light → its intensity (and, for the future, colour) appears below.
 * CLICK the ring/background → the environment (HDRI) picker.
 * A compact grade strip carries the three true globals: exposure / contrast /
 * saturation. Everything writes state.render.production live + persists.
 *
 * Deliberately 2D/SVG: no second WebGL context (the renderer heap is capped
 * ~3.5 GB — a second scene is a real cost). The main viewport IS the preview.
 */
import state from '../core/state.js';
import { sceneCore } from '../core/scene.js';
import * as userSettings from '../core/user-settings.js';

const HDRI_LABELS = {
  '': 'Built-in studio', studio_small_08: 'Studio — soft boxes',
  studio_small_09: 'Studio — bright', photo_studio_01: 'Photo — warm',
  brown_photostudio_02: 'Photo — earthy',
};
const HDRI_CYCLE = ['', 'studio_small_08', 'studio_small_09', 'photo_studio_01', 'brown_photostudio_02'];

let _dlg = null;

function _prod() {
  const r = state.get('render') || {};
  return { enabled: false, exposure: 1, key: 1, fill: 1, rim: 1, angle: 35,
           rimWidth: 0.45, contrast: 1, saturation: 1, hdri: '',
           envIntensity: 0.5, envBlur: 0.35, ...(r.production || {}) };
}
function _write(patch) {
  const r = state.get('render') || {};
  const production = { ..._prod(), ...patch };
  state.setState({ render: { ...r, production } });
  sceneCore.applyRenderSettings(state.get('render'));
  state.markDirty();
}

export function openLightStage() {
  if (_dlg) { try { _dlg.remove(); } catch {} _dlg = null; }
  const p = _prod();

  // NON-MODAL, DRAGGABLE (V0.3.2.54): a plain floating panel — the viewport
  // stays fully interactive (orbit the object while you light it), and the
  // header is a drag handle so the panel can be parked anywhere.
  _dlg = document.createElement('div');
  _dlg.className = 'light-stage-dlg';
  _dlg.style.cssText = 'position:fixed;top:80px;right:24px;z-index:9000;width:min(560px,94vw);'
    + 'background:var(--panel,#1e293b);color:var(--text,#e2e8f0);'
    + 'border:1px solid var(--line,#334155);border-radius:12px;padding:0;'
    + 'box-shadow:0 10px 40px rgba(0,0,0,.5);';
  _dlg.innerHTML = `
    <div id="ls-drag" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line,#334155);cursor:move;user-select:none">
      <b>💡 Light Stage <span class="small muted" style="opacity:.5;font-weight:400">⠿ drag</span></b>
      <label class="small" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" id="ls-enabled" ${p.enabled ? 'checked' : ''}/> Production look
      </label>
      <button id="ls-close" style="background:transparent;border:none;color:inherit;font-size:18px;cursor:pointer">✕</button>
    </div>
    <div id="ls-body" style="display:flex;gap:16px;padding:16px;">
      <div style="flex:0 0 auto">
        <svg id="ls-svg" width="240" height="240" viewBox="0 0 240 240" style="touch-action:none;cursor:pointer">
          <defs>
            <radialGradient id="ls-floor" cx="50%" cy="45%" r="60%">
              <stop offset="0%" stop-color="rgba(255,255,255,0.10)"/><stop offset="100%" stop-color="rgba(255,255,255,0.02)"/>
            </radialGradient>
          </defs>
          <circle cx="120" cy="120" r="96" fill="url(#ls-floor)" stroke="var(--line,#334155)" id="ls-ring"/>
          <circle cx="120" cy="120" r="96" fill="none" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 6"/>
          <!-- object at centre -->
          <rect x="106" y="106" width="28" height="28" rx="4" fill="#64748b" stroke="#94a3b8" transform="rotate(12 120 120)"/>
          <!-- viewer / camera marker (bottom = toward you) -->
          <text x="120" y="232" text-anchor="middle" fill="var(--muted,#94a3b8)" font-size="10">▲ camera</text>
          <!-- light handles (positioned by JS) -->
          <g id="ls-fill"><circle r="12" fill="#7fb0ff" stroke="#dbeafe" stroke-width="2"/><title>Fill (cool)</title></g>
          <g id="ls-key"><circle r="14" fill="#ffd27f" stroke="#fff7e6" stroke-width="2"/><title>Key (warm) — drag to aim the rig</title></g>
          <g id="ls-rim"><circle r="10" fill="#bfe0ff" stroke="#e0f2ff" stroke-width="2"/><title>Rim (camera-relative)</title></g>
        </svg>
        <div class="small muted" style="text-align:center;font-size:11px;opacity:.7;margin-top:4px">drag Key/Fill to aim · click a light</div>
      </div>
      <div style="flex:1 1 auto;min-width:0">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px">
          <select id="ls-preset" style="flex:1;min-width:0;padding:5px 6px;background:var(--panel2,#0f172a);color:inherit;border:1px solid var(--line,#334155);border-radius:6px"></select>
          <button id="ls-preset-save" title="Save current look as a preset" style="background:#f59e0b;color:#111;border:none;border-radius:6px;padding:5px 9px;cursor:pointer;font-weight:600">＋</button>
          <button id="ls-preset-del" title="Delete selected preset" style="background:transparent;color:inherit;border:1px solid var(--line,#334155);border-radius:6px;padding:5px 9px;cursor:pointer">🗑</button>
        </div>
        <div id="ls-selpanel"></div>
        <div style="margin-top:14px">
          <button id="ls-env" style="width:100%;text-align:left;background:var(--panel2,#0f172a);color:inherit;border:1px solid var(--line,#334155);border-radius:6px;padding:8px 10px;cursor:pointer">
            🌐 Environment: <b id="ls-envname">${HDRI_LABELS[p.hdri] || 'Built-in studio'}</b> <span class="small muted" style="float:right;opacity:.6">click to change ▸</span>
          </button>
          ${_sliderRow('envIntensity', 'Env strength', 0, 2, 0.05, p.envIntensity)}
          ${_sliderRow('envBlur', 'Env blur', 0, 1, 0.05, p.envBlur)}
        </div>
        <div class="title small" style="margin-top:16px;opacity:.7">Grade (global)</div>
        ${_sliderRow('exposure', 'Exposure', 0.3, 2.5, 0.05, p.exposure)}
        ${_sliderRow('contrast', 'Contrast', 0.5, 1.8, 0.02, p.contrast)}
        ${_sliderRow('saturation', 'Saturation', 0, 2, 0.05, p.saturation)}
      </div>
    </div>`;
  document.body.appendChild(_dlg);

  const $ = (id) => _dlg.querySelector(id);
  let selected = 'key';

  const layout = () => {
    const pp = _prod();
    const cx = 120, cy = 120, R = 96;
    const key = (pp.angle - 90) * Math.PI / 180;              // 0° = toward camera (bottom); screen y is down
    const fill = key + 150 * Math.PI / 180;
    const place = (g, ang, r = R) => $(g).setAttribute('transform', `translate(${cx + r * Math.cos(ang)},${cy + r * Math.sin(ang)})`);
    place('#ls-key', key);
    place('#ls-fill', fill);
    place('#ls-rim', Math.PI / 2 - 0.5, R * 0.82);            // near camera, offset
    // selection ring emphasis
    for (const [id, name] of [['#ls-key','key'],['#ls-fill','fill'],['#ls-rim','rim']]) {
      $(id).querySelector('circle').setAttribute('opacity', selected === name ? '1' : '0.72');
    }
  };

  const renderSel = () => {
    const pp = _prod();
    const meta = selected === 'key'  ? { label: 'Key light (warm)',  hint: 'the main form light — world-fixed' }
               : selected === 'fill' ? { label: 'Fill light (cool)', hint: 'lifts the shadow side — world-fixed' }
               :                       { label: 'Rim / backlight',   hint: 'edge light — follows the camera' };
    $('#ls-selpanel').innerHTML =
      `<div style="background:var(--panel2,#0f172a);border:1px solid var(--line,#334155);border-radius:8px;padding:10px 12px">
        <b>${meta.label}</b><div class="small muted" style="font-size:11px;opacity:.7;margin:2px 0 8px">${meta.hint}</div>
        ${_sliderRow(selected, 'Intensity', 0, 2.5, 0.05, pp[selected])}
        ${selected === 'rim' ? _sliderRow('rimWidth', 'Width (spread)', 0, 1, 0.05, pp.rimWidth) : ''}
      </div>`;
    _wireSliders($('#ls-selpanel'));
  };

  // ── Drag Key/Fill around the ring → angle ──────────────────────────────
  const svg = $('#ls-svg');
  let dragging = null;
  const angleFromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * (240 / r.width) - 120;
    const y = (e.clientY - r.top) * (240 / r.height) - 120;
    let a = Math.atan2(y, x) * 180 / Math.PI + 90;            // back to our azimuth convention
    if (dragging === 'fill') a -= 150;                        // fill leads key by 150°
    return ((a % 360) + 360) % 360;
  };
  const pick = (e) => {
    const t = e.target.closest('#ls-key,#ls-fill,#ls-rim');
    return t ? t.id.replace('ls-', '') : null;
  };
  svg.addEventListener('pointerdown', (e) => {
    const hit = pick(e);
    if (hit) { selected = hit; renderSel(); layout(); if (hit !== 'rim') { dragging = hit; svg.setPointerCapture(e.pointerId); } }
    else { _openEnvPicker($, layout); }                       // background click = environment
  });
  svg.addEventListener('pointermove', (e) => { if (dragging) { _write({ angle: Math.round(angleFromEvent(e)) }); layout(); } });
  svg.addEventListener('pointerup', () => { dragging = null; });

  // ── Presets (user-level library — available in every project) ──────────
  const PROD_KEYS = ['exposure','key','fill','rim','angle','rimWidth','contrast','saturation','hdri','envIntensity','envBlur'];
  const refreshPresets = (selectId) => {
    const list = userSettings.get().lightingPresets || [];
    $('#ls-preset').innerHTML = `<option value="">— presets (${list.length}) —</option>`
      + list.map(pr => `<option value="${pr.id}" ${pr.id === selectId ? 'selected' : ''}>${_esc(pr.name)}</option>`).join('');
  };
  refreshPresets();
  $('#ls-preset').addEventListener('change', async (e) => {
    const pr = (userSettings.get().lightingPresets || []).find(x => x.id === e.target.value);
    if (!pr) return;
    _write({ ...pr.production, enabled: true });
    $('#ls-enabled').checked = true;
    $('#ls-envname').textContent = HDRI_LABELS[pr.production.hdri || ''] || 'Built-in studio';
    renderSel(); layout();
  });
  $('#ls-preset-save').addEventListener('click', async () => {
    const name = (prompt('Name this lighting preset:', 'My look') || '').trim();
    if (!name) return;
    const pp = _prod();
    const production = {}; for (const k of PROD_KEYS) production[k] = pp[k];
    const id = 'lp_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '_' + (userSettings.get().lightingPresets || []).length;
    const list = [...(userSettings.get().lightingPresets || []).filter(p => p.name !== name), { id, name, production }];
    await userSettings.patch({ lightingPresets: list });
    refreshPresets(id);
  });
  $('#ls-preset-del').addEventListener('click', async () => {
    const sel = $('#ls-preset').value;
    if (!sel) { alert('Pick a preset to delete first.'); return; }
    const list = (userSettings.get().lightingPresets || []).filter(p => p.id !== sel);
    await userSettings.patch({ lightingPresets: list });
    refreshPresets();
  });

  $('#ls-enabled').addEventListener('change', (e) => { _write({ enabled: e.target.checked }); });
  $('#ls-env').addEventListener('click', () => _openEnvPicker($, layout));
  const close = () => { try { _dlg.remove(); } catch {} _dlg = null; };
  $('#ls-close').addEventListener('click', close);

  // ── Drag the whole panel by its header ─────────────────────────────────
  const handle = $('#ls-drag');
  let panDrag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#ls-close, #ls-enabled')) return;
    const r = _dlg.getBoundingClientRect();
    panDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    _dlg.style.right = 'auto';
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!panDrag) return;
    _dlg.style.left = Math.max(0, Math.min(window.innerWidth  - 60, e.clientX - panDrag.dx)) + 'px';
    _dlg.style.top  = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - panDrag.dy)) + 'px';
  });
  handle.addEventListener('pointerup', () => { panDrag = null; });

  _wireSliders(_dlg);
  renderSel();
  layout();
}

function _openEnvPicker($, layout) {
  const cur = _prod().hdri || '';
  const i = HDRI_CYCLE.indexOf(cur);
  const next = HDRI_CYCLE[(i + 1) % HDRI_CYCLE.length];
  _write({ hdri: next });
  $('#ls-envname').textContent = HDRI_LABELS[next] || 'Built-in studio';
}

const _esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function _sliderRow(key, label, min, max, step, val) {
  const v = Number(val ?? min);
  return `<label class="small" style="display:block;margin-top:8px">
    ${label} <span class="muted" data-lsval="${key}" style="float:right">${v.toFixed(2)}</span>
    <input type="range" data-lsslider="${key}" min="${min}" max="${max}" step="${step}" value="${v}" style="width:100%;margin-top:3px"/>
  </label>`;
}

function _wireSliders(root) {
  root.querySelectorAll('input[data-lsslider]').forEach(inp => {
    if (inp._wired) return; inp._wired = true;
    const key = inp.dataset.lsslider;
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      const lbl = root.querySelector(`[data-lsval="${key}"]`) || _dlg?.querySelector(`[data-lsval="${key}"]`);
      if (lbl) lbl.textContent = v.toFixed(2);
      _write({ [key]: v });
    });
  });
}
