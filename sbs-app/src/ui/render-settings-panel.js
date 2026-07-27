/**
 * Render settings panel (V0.3.0.18) — AO + SSR contact-reflection sliders.
 *
 * A single reusable builder mounted in TWO places (Files tab → under Background,
 * and Settings modal → Scene tab), both reading/writing the SAME PER-PROJECT
 * state.render store — so they stay linked. Live-applies to the viewport on drag
 * (sceneCore.applyRenderSettings) and persists on release (state.setState + markDirty,
 * so it saves WITH the project). V0.3.0.162 — was machine-global; now per-project,
 * seeded from userSettings.render (the new-project default).
 */
import { sceneCore } from '../core/scene.js';
import state from '../core/state.js';

const DEFAULTS = {
  ao:  { enabled: true,  intensity: 4.0, radius: 24.0, falloff: 1.0 },
  ssr: { enabled: false, intensity: 1.0, roughness: 0.3, maxDistance: 8.0, thickness: 1.0, steps: 24 },
  // 🎬 Production Render (V0.3.2.46) — the final-output look, stage 1: ACES
  // filmic tone mapping + exposure. OFF = classic preview look (back-compat:
  // every existing project renders exactly as before). Rides state.render →
  // saved with the project AND part of the render-cache fingerprint, so
  // preview-segments and production-segments never mix.
  production: { enabled: false, exposure: 1.0, key: 1.0, fill: 1.0, rim: 1.0, angle: 35 },
};

const AO_SLIDERS = [
  { key: 'intensity', label: 'Intensity',        min: 0, max: 8,   step: 0.1,  digits: 1 },
  { key: 'radius',    label: 'Radius (px)',      min: 1, max: 100, step: 1,    digits: 0 },
  { key: 'falloff',   label: 'Distance falloff', min: 0, max: 5,   step: 0.05, digits: 2 },
];
const SSR_SLIDERS = [
  { key: 'intensity',   label: 'Intensity (master)', min: 0, max: 2, step: 0.01, digits: 2 },
  { key: 'maxDistance', label: 'Max distance', min: 0,   max: 2000, step: 10,   digits: 0 },
  { key: 'thickness',   label: 'Thickness',    min: 0.1, max: 50,   step: 0.1,  digits: 1 },
  { key: 'steps',       label: 'Steps',        min: 4,   max: 400,  step: 1,    digits: 0 },
];
const PROD_SLIDERS = [
  { key: 'exposure', label: 'Exposure',            min: 0.3, max: 2.5, step: 0.05, digits: 2 },
  { key: 'key',      label: 'Key light (warm)',    min: 0,   max: 2.5, step: 0.05, digits: 2 },
  { key: 'fill',     label: 'Fill light (cool)',   min: 0,   max: 2.5, step: 0.05, digits: 2 },
  { key: 'rim',      label: 'Rim / backlight',     min: 0,   max: 2.5, step: 0.05, digits: 2 },
  { key: 'angle',    label: 'Rig angle (°)',       min: 0,   max: 360, step: 5,    digits: 0 },
];
const _slidersOf = (group) => group === 'ao' ? AO_SLIDERS : group === 'production' ? PROD_SLIDERS : SSR_SLIDERS;

function _merge(base, over) {
  return {
    ao:         { ...base.ao,         ...(over && over.ao         || {}) },
    ssr:        { ...base.ssr,        ...(over && over.ssr        || {}) },
    production: { ...base.production, ...(over && over.production || {}) },
  };
}

/** Build and return the render-settings panel element (caller appends it). */
export function buildRenderSettingsPanel() {
  const working = _merge(DEFAULTS, state.get('render'));   // V0.3.0.162 — per-project

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
    <div class="title" style="display:flex;align-items:center;gap:6px;">🎬 Production Render</div>
    <div class="small muted" style="font-size:11px;opacity:0.75;margin-top:2px;">
      Two looks, one switch. <b>OFF = Preview</b> — the classic flat look every existing project was
      built with. <b>ON = Production</b> — filmic tone mapping (cinematic contrast &amp; highlight
      rolloff), the first stage of the final-output render. Applies to the viewport AND exports;
      switching re-renders cached segments once.
    </div>
    <label class="small" style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer;">
      <input type="checkbox" data-toggle="production" ${working.production.enabled ? 'checked' : ''} /> Production look enabled
    </label>
    ${PROD_SLIDERS.map(s => row('production', s)).join('')}

    <div class="title" style="margin-top:14px;">Ambient occlusion</div>
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
      Which surfaces reflect, + their roughness/intensity, are set <b>per color</b> (Colors tab → "Reflective (SSR)").
      Max distance is in world units — tune to your model scale.
      Keep (Max distance ÷ Steps) ≲ Thickness for clean reflections.
    </div>
  `;

  const snapshot  = () => ({ ao: { ...working.ao }, ssr: { ...working.ssr }, production: { ...working.production } });
  const applyLive = () => sceneCore.applyRenderSettings(snapshot());
  const persist   = () => { state.setState({ render: snapshot() }); state.markDirty(); };   // V0.3.0.162 — saves with the project

  wrap.querySelectorAll('input[data-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      working[cb.dataset.toggle].enabled = cb.checked;
      applyLive();
      persist();
    });
  });

  wrap.querySelectorAll('input[data-slider]').forEach(input => {
    const [group, key] = input.dataset.slider.split('.');
    const meta  = _slidersOf(group).find(s => s.key === key);
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
