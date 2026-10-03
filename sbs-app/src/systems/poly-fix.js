/**
 * ⬚ FIX OBJECT (V0.3.5.45) — the repair of a mesh that came in broken, with a preview.
 *
 * Every pair of vertices closer than a threshold becomes one, the faces left with
 * fewer than three corners go, every hole is capped (poly-repair.js). The user
 * turns the threshold and sees the result as it would be: the welded points as
 * RED dots, the caps as RED faces. A mesh that takes longer than 3 s to repair
 * stops following the threshold live: a Preview button runs it instead.
 * Apply = one undo entry for every object fixed; Cancel leaves them as they were.
 *
 * Works on HOSTS (poly-edit.js's contract: mesh, alive, getPoly, snapshot,
 * commit) — the Poly Editor's parts and a project 'poly' primitive alike. The
 * markers are children of the host's mesh, so they follow it; none raycasts.
 */
import { sceneCore } from '../core/scene.js';
import { undoManager } from './undo.js';
import { setStatus, setStickyStatus, clearStickyStatus } from '../ui/status.js';
import { parseExpression } from '../ui/gizmo-numeric.js';
import { isPoly, polyExtent, polyToArrays, isWatertight } from './poly-core.js';
import { repairPoly, weldNear } from './poly-repair.js';

const T = () => window.THREE;
const LIVE_MS = 3000;                                    // his rule: slower than this, the preview waits for the button
let _fx = null;

export const isPolyFixing = () => !!_fx;

const _nice = (x) => { if (!(x > 0)) return 0; const p = Math.pow(10, Math.floor(Math.log10(x))); const m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
const _fmt = (x) => (x >= 100 ? x.toFixed(0) : x >= 1 ? String(+x.toFixed(3)) : String(+x.toPrecision(3)));

/**
 * Open the repair on these hosts. `opts.onEnd(applied)` runs when it closes (the
 * Poly Editor re-shows its gizmo / hint); `opts.label` names them in the bar.
 */
export function startPolyFix(hosts, opts = {}) {
  hosts = (hosts || []).filter(h => h?.alive?.() && h.mesh && isPoly(h.getPoly()));
  if (!hosts.length) { setStatus('Select the object(s) to fix first.', 'warn', 3500); return false; }
  endPolyFix(true);
  const items = hosts.map(h => ({ host: h, src: h.getPoly(), res: null, ov: null }));
  const ext = Math.max(...items.map(it => polyExtent(it.src)));
  const eps = Math.max(_nice(ext * 1e-4), 1e-6);
  const fx = _fx = { items, ext, eps, cap: true, live: true, dirty: true, busy: true, ms: 0, bar: null, onEnd: opts.onEnd || null, label: opts.label || (items.length === 1 ? 'the object' : `${items.length} objects`), timer: 0 };
  // an undo (or the object leaving) under the preview makes it stale: it closes, nothing applied
  for (const it of items) it.unsub = it.host.subscribe?.(() => { if (_fx === fx) { endPolyFix(true); setStatus('Fix object closed — the object changed under it.', 'info', 3500); } }) || null;
  _bar();                                                // the bar first ("working…"), the first repair a frame later
  fx.timer = setTimeout(() => { if (_fx === fx) { fx.busy = false; _compute(); } }, 30);
  _hint();
  return true;
}

/** Close it. `quiet` = nothing said (another tool took over); Cancel otherwise. */
export function endPolyFix(quiet = false, applied = false) {
  const fx = _fx; if (!fx) return;
  _fx = null;
  clearTimeout(fx.timer);
  for (const it of fx.items) { _dropOverlay(it); try { it.unsub?.(); } catch { /* gone */ } }
  try { fx.bar?.remove(); } catch { /* gone */ }
  clearStickyStatus('polyFix');
  sceneCore.requestRender?.(120);
  if (!quiet && !applied) setStatus('Fix object cancelled — nothing changed.', 'info', 2500);
  try { fx.onEnd?.(applied); } catch (err) { console.warn('[poly fix]', err); }
}

/** Bake it: every object that changes takes its repaired shape — one undo entry. */
export function applyPolyFix() {
  const fx = _fx; if (!fx) return false;
  if (fx.dirty) { fx.busy = false; _compute(true); }     // the threshold moved since the last (slow) preview — or the first repair has not run yet
  const todo = fx.items.filter(it => it.res?.ok && it.res.changed && it.host.alive());
  if (!todo.length) { setStatus(fx.items.some(it => it.res && !it.res.ok) ? 'Nothing applied — at this threshold an object would collapse. Lower it.' : 'Nothing to fix at this threshold.', 'warn', 4500); return false; }
  const sum = _sum(fx.items.filter(it => todo.includes(it)));
  endPolyFix(true, true);
  for (const it of todo) it.host.commit(it.res.poly, 'Fix object', it.host.snapshot());
  if (todo.length > 1) undoManager.mergeLast(todo.length, 'Fix object');
  const closed = todo.every(it => isWatertight(it.res.poly));
  setStatus(`Fixed — ${_sumText(sum)}${closed ? ' · now closed (watertight)' : ''}. Ctrl+Z takes it back.`, 'success', 7000);
  return true;
}

// ── computing ────────────────────────────────────────────────────────────────
function _compute(force = false) {
  const fx = _fx; if (!fx) return;
  if (!force && !fx.live) { fx.dirty = true; _bar(); return; }
  const t0 = performance.now();
  for (const it of fx.items) {
    try {
      const r = fx.cap ? repairPoly(it.src, fx.eps) : (() => { const w = weldNear(it.src, fx.eps); return { poly: w.poly, clusters: w.clusters, clustersCoincident: w.clustersCoincident || 0, capFaces: [], dropped: w.dropped || 0, holes: 0, zipped: 0, seams: [], stillOpen: 0 }; })();
      const ok = isPoly(r.poly);
      const changed = ok && (r.poly.v.length !== it.src.v.length || r.poly.f.length !== it.src.f.length || (r.clusters?.length || 0) > 0 || (r.clustersCoincident || 0) > 0 || (r.capFaces?.length || 0) > 0 || (r.zipped || 0) > 0 || (r.dropped || 0) > 0);
      it.res = { ...r, ok, changed };
    } catch (err) {
      console.warn('[poly fix] repair failed', err);
      it.res = { ok: false, changed: false, error: err?.message || String(err) };
    }
  }
  fx.ms = performance.now() - t0;
  if (fx.ms > LIVE_MS) fx.live = false;                 // from now on the Preview button runs it
  fx.dirty = false;
  for (const it of fx.items) _showOverlay(it);
  _bar();
  sceneCore.requestRender?.(120);
}

function _schedule() {
  const fx = _fx; if (!fx) return;
  if (!fx.live) { fx.dirty = true; _bar(); return; }
  clearTimeout(fx.timer); fx.busy = false;
  fx.timer = setTimeout(() => _compute(), 60);           // a slider drag sends dozens of inputs: the last one wins
}

const _sum = (items) => items.reduce((s, it) => {
  const r = it.res || {};
  s.welded += r.clusters?.length || 0; s.dups += r.clustersCoincident || 0; s.caps += r.capFaces?.length || 0;
  s.holes += Math.max(0, (r.holes || 0) - (r.zipped || 0) - (r.stillOpen || 0)); s.zipped += r.zipped || 0;
  s.dropped += r.dropped || 0; s.open += r.stillOpen || 0; s.bad += r.ok ? 0 : 1;
  return s;
}, { welded: 0, dups: 0, caps: 0, holes: 0, zipped: 0, dropped: 0, open: 0, bad: 0 });

function _sumText(s) {
  const parts = [];
  if (s.welded) parts.push(`${s.welded} point${s.welded === 1 ? '' : 's'} welded`);
  if (s.dups) parts.push(`${s.dups} duplicate${s.dups === 1 ? '' : 's'} merged`);
  if (s.holes) parts.push(`${s.holes} hole${s.holes === 1 ? '' : 's'} capped`);
  if (s.zipped) parts.push(`${s.zipped} crack${s.zipped === 1 ? '' : 's'} zipped shut`);
  if (s.dropped) parts.push(`${s.dropped} broken face${s.dropped === 1 ? '' : 's'} removed`);
  if (s.open) parts.push(`${s.open} hole${s.open === 1 ? '' : 's'} could not be closed`);
  return parts.join(' · ') || 'nothing to fix';
}

// ── the red markers ──────────────────────────────────────────────────────────
function _dropOverlay(it) {
  const g = it.ov; it.ov = null;
  if (!g) return;
  g.parent?.remove(g);
  g.children.forEach(c => { c.geometry?.dispose?.(); c.material?.dispose?.(); });
}

function _showOverlay(it) {
  _dropOverlay(it);
  const r = it.res, mesh = it.host.mesh;
  if (!r?.ok || !mesh) return;
  const Th = T();
  const g = new Th.Group(); g.name = 'polyFixPreview'; g.userData.isHelper = true; g.raycast = () => {};
  const noPick = (o) => { o.raycast = () => {}; o.userData.isHelper = true; return o; };
  if (r.capFaces?.length) {
    const { positions, normals } = polyToArrays({ v: r.poly.v, f: r.capFaces.map(i => r.poly.f[i]).filter(Boolean) });
    const geo = new Th.BufferGeometry();
    geo.setAttribute('position', new Th.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new Th.BufferAttribute(normals, 3));
    const caps = noPick(new Th.Mesh(geo, new Th.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.6, side: Th.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
    caps.renderOrder = 9690;
    g.add(caps);
  }
  const spots = [...(r.clusters || []), ...(r.seams || [])];   // welded spots + the corners a zipped crack joined
  if (spots.length) {
    const pos = new Float32Array(spots.length * 3);
    spots.forEach((c, i) => { pos[i * 3] = c[0]; pos[i * 3 + 1] = c[1]; pos[i * 3 + 2] = c[2]; });
    const geo = new Th.BufferGeometry(); geo.setAttribute('position', new Th.BufferAttribute(pos, 3));
    const dots = noPick(new Th.Points(geo, new Th.PointsMaterial({ color: 0xef4444, size: 10, sizeAttenuation: false, depthTest: false, transparent: true })));
    dots.renderOrder = 9700;
    g.add(dots);
  }
  if (!g.children.length) return;
  mesh.add(g);
  it.ov = g;
}

// ── the bar ──────────────────────────────────────────────────────────────────
function _bar() {
  const fx = _fx; if (!fx) return;
  if (!fx.bar) {
    const surf = document.getElementById('viewport-surface') || sceneCore.renderer?.domElement?.parentElement;
    fx.bar = document.createElement('div');
    fx.bar.style.cssText = 'position:absolute;top:40px;left:50%;transform:translateX(-50%);z-index:40;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:7px 10px;border-radius:10px;background:var(--panel,#0f172a);border:1px solid #ef4444;box-shadow:0 10px 30px rgba(0,0,0,.55);color:var(--text,#e5e7eb);font-size:12px;max-width:94%;';
    for (const ev of ['pointerdown', 'dblclick', 'contextmenu', 'wheel']) fx.bar.addEventListener(ev, (e) => e.stopPropagation());
    surf?.appendChild(fx.bar);
    _barBuild();
  }
  _barUpdate();
}

function _barBuild() {
  const fx = _fx, bar = fx.bar;
  const b = (label, title, fn, extra = '') => { const x = document.createElement('button'); x.className = 'btn'; x.textContent = label; x.title = title; x.style.cssText = `height:26px;padding:0 9px;font-size:12px;${extra}`; x.addEventListener('click', (e) => { e.preventDefault(); x.blur(); fn(); }); return x; };
  const lab = document.createElement('span'); lab.style.cssText = 'font-weight:600;margin-right:2px;';
  lab.textContent = `🩹 Fix ${fx.label} — weld points closer than`;
  // the slider is logarithmic: from a millionth of the object to a twentieth of it
  const lo = Math.log10(fx.ext * 1e-6), hi = Math.log10(fx.ext * 0.05);
  const num = document.createElement('input'); num.type = 'text'; num.value = _fmt(fx.eps); num.title = 'The weld distance (mm) — maths allowed (e.g. 0.5/4). Enter takes it.';
  num.style.cssText = 'width:64px;height:24px;padding:0 6px;font-size:12px;';
  const rng = document.createElement('input'); rng.type = 'range'; rng.min = '0'; rng.max = '1000'; rng.step = '1'; rng.style.cssText = 'width:150px;';
  const toR = (e) => String(Math.round(Math.max(0, Math.min(1, (Math.log10(e) - lo) / (hi - lo))) * 1000));
  rng.value = toR(fx.eps);
  const take = (v, from) => {
    if (!(v > 0) || !Number.isFinite(v) || !_fx) return;
    fx.eps = v;
    if (from !== 'num') num.value = _fmt(v);
    if (from !== 'rng') rng.value = toR(v);
    _schedule();
  };
  rng.addEventListener('input', () => take(_nice(Math.pow(10, lo + (hi - lo) * (+rng.value / 1000))), 'rng'));
  rng.addEventListener('pointerup', () => rng.blur());
  num.addEventListener('change', () => take(parseExpression(num.value), 'num'));
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); take(parseExpression(num.value), 'num'); num.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); num.value = _fmt(fx.eps); num.blur(); }
  });
  const unit = document.createElement('span'); unit.textContent = 'mm'; unit.style.opacity = '.7';
  const capL = document.createElement('label'); capL.style.cssText = 'display:flex;gap:4px;align-items:center;cursor:pointer;margin-left:4px;';
  const cap = document.createElement('input'); cap.type = 'checkbox'; cap.checked = fx.cap;
  cap.addEventListener('change', () => { if (!_fx) return; fx.cap = cap.checked; cap.blur(); _schedule(); });
  capL.append(cap, document.createTextNode('cap the holes'));
  const msg = document.createElement('span'); msg.style.cssText = 'opacity:.85;margin:0 4px;';
  const prev = b('⟳ Preview', 'This object is slow to repair (over 3 s): the preview runs when you press this', () => _compute(true), 'background:#7c2d12;border-color:#fb923c;color:#fff;');
  const ok = b('✔ Apply  [Enter]', 'Weld, remove the broken faces and cap the holes as shown. One undo step.', () => applyPolyFix(), 'background:#14532d;border-color:#22c55e;color:#dcfce7;font-weight:600;');
  const no = b('✕ Cancel  [Esc]', 'Leave everything as it was', () => endPolyFix());
  bar.append(lab, num, unit, rng, capL, msg, prev, ok, no);
  fx.ui = { msg, prev, ok };
  setTimeout(() => { try { num.focus(); num.select(); } catch { /* fine */ } }, 0);   // type a distance straight away
}

function _barUpdate() {
  const fx = _fx; if (!fx?.ui) return;
  const { msg, prev, ok } = fx.ui;
  const s = _sum(fx.items);
  prev.style.display = fx.live ? 'none' : '';
  prev.disabled = !fx.dirty;
  msg.style.color = s.bad ? '#fca5a5' : '';
  msg.textContent = fx.busy ? 'working…' : fx.dirty && !fx.live ? 'the threshold changed — press Preview to see it (or Apply)'
    : s.bad ? 'too far: an object would collapse — lower the distance'
      : `${_sumText(s)}${fx.items.some(it => it.res?.changed) ? '' : ' at this distance'}${fx.live ? '' : ` · ${(fx.ms / 1000).toFixed(1)} s`}`;
  ok.disabled = fx.busy || (!fx.dirty && !fx.items.some(it => it.res?.ok && it.res.changed));
}

function _hint() {
  setStickyStatus('🩹 FIX OBJECT — red dots = points that will be welded into one · red faces = the caps that close the holes · turn the distance until it looks right · Enter applies, Esc cancels', 'info', 'polyFix');
}
