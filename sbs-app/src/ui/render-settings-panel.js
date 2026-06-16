/**
 * Render settings panel (V0.3.0.18) — AO + SSR contact-reflection sliders.
 *
 * A single reusable builder mounted in TWO places (Files tab → under Background,
 * and Settings modal → Scene tab), both reading/writing the SAME global
 * userSettings.render store — so they stay linked. Live-applies to the viewport
 * on drag (sceneCore.applyRenderSettings) and persists on release
 * (userSettings.patch). Machine-scope for now; per-project override comes later.
 */
import { sceneCore } from '../core/scene.js';
import * as userSettings from '../core/user-settings.js';

const DEFAULTS = {
  ao:  { enabled: true,  intensity: 4.0, radius: 24.0, falloff: 1.0 },
  ssr: { enabled: false, intensity: 0.6, roughness: 0.3, maxDistance: 8.0, thickness: 1.0, steps: 24 },
};

const AO_SLIDERS = [
  { key: 'intensity', label: 'Intensity',        min: 0, max: 8,   step: 0.1,  digits: 1 },
  { key: 'radius',    label: 'Radius (px)',      min: 1, max: 100, step: 1,    digits: 0 },
  { key: 'falloff',   label: 'Distance falloff', min: 0, max: 5,   step: 0.05, digits: 2 },
];
const SSR_SLIDERS = [
  { key: 'intensity',   label: 'Intensity',    min: 0,   max: 1,    step: 0.01, digits: 2 },
  { key: 'roughness',   label: 'Roughness (blur)', min: 0, max: 1,  step: 0.01, digits: 2 },
  { key: 'maxDistance', label: 'Max distance', min: 0,   max: 2000, step: 10,   digits: 0 },
  { key: 'thickness',   label: 'Thickness',    min: 0.1, max: 50,   step: 0.1,  digits: 1 },
  { key: 'steps',       label: 'Steps',        min: 4,   max: 400,  step: 1,    digits: 0 },
];

function _merge(base, over) {
  return {
    ao:  { ...base.ao,  ...(over && over.ao  || {}) },
    ssr: { ...base.ssr, ...(over && over.ssr || {}) },
  };
}

/** Build and return the render-settings panel element (caller appends it). */
export function buildRenderSettingsPanel() {
  const working = _merge(DEFAULTS, userSettings.get().render);

  const row = (group, s) => `
    <label class="small" style="display:block;margin-top:8px;">
      ${s.label}
      <span class="muted" data-val="${group}.${s.key}" style="float:right;">${working[group][s.key].toFixed(s.digits)}</span>
      <input type="range" data-slider="${group}.${s.key}"
             min="${s.min}" max="${s.max}" step="${s.step}" value="${working[group][s.key]}"
             style="width:100%;margin-top:4px;" />
    </label>`;

  const wrap = document.createElement('div');
  wrap.className = 'section';
  wrap.innerHTML = `
    <div class="title">Ambient occlusion</div>
    <label class="small" style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;">
      <input type="checkbox" data-toggle="ao" ${working.ao.enabled ? 'checked' : ''} /> Enabled
    </label>
    ${AO_SLIDERS.map(s => row('ao', s)).join('')}

    <div class="title" style="margin-top:14px;">Contact reflections (SSR)</div>
    <label class="small" style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;">
      <input type="checkbox" data-toggle="ssr" ${working.ssr.enabled ? 'checked' : ''} /> Enabled
    </label>
    ${SSR_SLIDERS.map(s => row('ssr', s)).join('')}
    <div class="small muted" style="margin-top:6px;font-size:10px;line-height:1.4;">
      Max distance is in world units — tune to your model scale.
      Keep (Max distance ÷ Steps) ≲ Thickness for clean reflections.
    </div>
  `;

  const snapshot  = () => ({ ao: { ...working.ao }, ssr: { ...working.ssr } });
  const applyLive = () => sceneCore.applyRenderSettings(snapshot());
  const persist   = () => userSettings.patch({ render: snapshot() });

  wrap.querySelectorAll('input[data-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      working[cb.dataset.toggle].enabled = cb.checked;
      applyLive();
      persist();
    });
  });

  wrap.querySelectorAll('input[data-slider]').forEach(input => {
    const [group, key] = input.dataset.slider.split('.');
    const meta  = (group === 'ao' ? AO_SLIDERS : SSR_SLIDERS).find(s => s.key === key);
    const valEl = wrap.querySelector(`[data-val="${group}.${key}"]`);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      working[group][key] = v;
      if (valEl) valEl.textContent = v.toFixed(meta.digits);
      applyLive();                 // live during drag
    });
    input.addEventListener('change', persist);   // persist on release
  });

  return wrap;
}
