/**
 * SBS — Hands tab (V0.3.4.128, phase 2: poses + a ghost prop).
 * ────────────────────────────────────────────────────────────
 * + Add hand → a hand node with a grip POSE and the ghost of what it holds.
 * Align (3 points): click the three named points on the real part — the hand
 * lands exactly, the ghost hides. Closed slider, Release + Open, Length.
 * Fine-tune (double-click the hand, or the button): fingertip handles.
 */

import { state }   from '../core/state.js';
import * as hands  from '../systems/hands.js';
import * as act    from '../systems/hand-actions.js';
import { chooseFromButtons } from './prompt.js';

let _activeId = null;

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function _liveHands() {
  const nb = state.get('nodeById'); const out = [];
  if (!nb) return out;
  for (const [, n] of nb) if (n?.type === 'hand') out.push(n);
  return out;
}

export function renderHandTab(container) {
  if (!container) return;
  const list = _liveHands();
  const selId = state.get('selectedId');
  if (selId && list.some(h => h.id === selId)) _activeId = selId;
  if (_activeId && !list.some(h => h.id === _activeId)) _activeId = null;

  container.innerHTML = `
    <div class="section">
      <div class="title">🖐 Hands</div>
      <div class="small muted" style="margin-top:6px;line-height:1.5;">
        A hand with a grip. Add one, pick what it holds, then <strong>Align (3 points)</strong>:
        click the three named points on the real part and the hand lands on it.
      </div>
      <div class="card" style="margin-top:10px;display:flex;gap:6px;">
        <button class="btn" id="hand-add" style="flex:1;">+ Add hand</button>
      </div>
      ${_skinCard()}
      <div class="card" style="margin-top:8px;padding:0;">
        <div class="title" style="padding:8px 10px;border-bottom:1px solid var(--line);">Hands <span class="small muted">(${list.length})</span></div>
        <div id="hand-list">
          ${list.length === 0 ? '<div class="small muted" style="padding:10px;">No hands yet — pick + Add hand.</div>' : list.map(h => _row(h)).join('')}
        </div>
      </div>
      <div id="hand-editor"></div>
    </div>`;

  container.querySelector('#hand-add')?.addEventListener('click', async () => {
    const side = await chooseFromButtons('Which hand?', 'Pick the side. The grip comes next.', [
      { id: 'right', label: 'Right hand', primary: true }, { id: 'left', label: 'Left hand' }, { id: 'cancel', label: 'Cancel' },
    ]);
    if (!side || side === 'cancel') return;
    _activeId = act.addHand(side, 'handle');
    renderHandTab(container);
  });
  container.querySelector('#hand-skin-load')?.addEventListener('click', () => act.pickHandSkin());
  container.querySelector('#hand-skin-clear')?.addEventListener('click', () => act.clearHandSkin());
  container.querySelector('#hand-rig-export')?.addEventListener('click', () => act.exportHandRig());
  container.querySelector('#hand-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-hand-id]'); if (!row) return;
    const id = row.dataset.handId;
    const a = e.target.closest('[data-hand-act]')?.dataset.handAct;
    if (a === 'delete') { if (confirm('Delete this hand?')) { act.removeHand(id); if (_activeId === id) _activeId = null; renderHandTab(container); } return; }
    _activeId = id;
    state.setState({ selectedId: id, multiSelectedIds: new Set([id]) });
    renderHandTab(container);
  });

  if (_activeId) _renderEditor(container.querySelector('#hand-editor'), _liveHands().find(h => h.id === _activeId));
}

/** 🧤 V0.3.4.139 — the skin: a real hand mesh over the rig (machine setting). */
function _skinCard() {
  const s = hands.handSkinInfo();
  const base = s.path ? s.path.split(/[\\/]/).pop() : '';
  const line = s.loaded ? `✓ <b>${_esc(base)}</b> on every hand`
    : s.error ? `✕ ${_esc(base)}: ${_esc(s.error)}`
    : 'Procedural hand. <b>Export rig…</b> gives an .fbx of the bones; skin a real hand to them (keep the bone names), then <b>Load skin</b>.';
  return `
      <div class="card" style="margin-top:8px;padding:8px 10px;">
        <div class="small" style="font-weight:600;">🧤 Skin</div>
        <div class="small muted" style="margin-top:4px;line-height:1.45;">${line}</div>
        ${s.loaded && s.missing.length ? `<div class="small" style="margin-top:4px;color:#fbbf24;">Bones not found: ${_esc(s.missing.join(', '))}</div>` : ''}
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="btn" id="hand-skin-load" style="flex:1;" title="An .fbx or .glb with a mesh skinned to the exported bones">Load skin…</button>
          <button class="btn" id="hand-skin-clear" ${s.path ? '' : 'disabled'} title="Back to the procedural hand">✕</button>
          <button class="btn" id="hand-rig-export" title="Save the rig (right hand, at rest) as .fbx (or .glb) to skin over">Export rig…</button>
        </div>
      </div>`;
}

function _row(h) {
  const p = h.handParams || {};
  const pose = hands.HAND_POSES[p.pose] || hands.HAND_POSES.handle;
  const st = p.released ? 'released' : pose.label;
  return `
    <div class="row" data-hand-id="${_esc(h.id)}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;${_activeId === h.id ? 'background:rgba(34,211,238,0.08);' : ''}">
      <span style="font-size:18px;${h.handSide === 'left' ? 'transform:scaleX(-1);display:inline-block;' : ''}">🖐</span>
      <div style="flex:1;min-width:0;">
        <div class="small" style="font-weight:600;">${_esc(h.name || 'Hand')}</div>
        <div class="small muted" style="font-size:11px;">${h.handSide === 'left' ? 'left' : 'right'} · ${_esc(st)}</div>
      </div>
      <button class="btn icon" data-hand-act="delete" title="Delete" style="width:24px;height:24px;padding:0;color:#f87171;">✕</button>
    </div>`;
}

function _handSvg(h, picking) {
  const p = h.handParams || {};
  const left = h.handSide === 'left';
  const F = {
    thumb:  { x: 118, y: 92, w: 22, h: 46, rot: -40 },
    index:  { x: 92,  y: 24, w: 18, h: 60, rot: 0 },
    middle: { x: 68,  y: 14, w: 18, h: 70, rot: 0 },
    ring:   { x: 44,  y: 22, w: 18, h: 62, rot: 0 },
    pinky:  { x: 22,  y: 40, w: 16, h: 48, rot: 0 },
  };
  const fingers = hands.HAND_FINGERS.map(f => {
    const g = F[f];
    const on = !!p.targets?.[f] && !p.released;
    const pk = picking?.nodeId === h.id && picking.finger === f;
    const fill = pk ? '#dc2626' : on ? '#22d3ee' : 'rgba(127,127,127,.25)';
    const stroke = pk ? '#fca5a5' : on ? '#67e8f9' : 'rgba(127,127,127,.6)';
    return `<g data-finger="${f}" style="cursor:pointer;" transform="translate(${g.x + g.w / 2} ${g.y + g.h}) rotate(${g.rot}) translate(${-(g.x + g.w / 2)} ${-(g.y + g.h)})">
      <title>${hands.FINGER_LABEL[f]} — click, then click where its tip touches; click again to unpin</title>
      <rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="${g.w / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
      ${on ? `<circle cx="${g.x + g.w / 2}" cy="${g.y + 9}" r="4" fill="#0f172a"/>` : ''}
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 160 190" width="130" height="154" style="display:block;margin:0 auto;${left ? 'transform:scaleX(-1);' : ''}">
    <rect x="30" y="80" width="90" height="82" rx="18" fill="rgba(127,127,127,.18)" stroke="rgba(127,127,127,.6)" stroke-width="2"/>
    <rect x="52" y="158" width="46" height="30" rx="8" fill="rgba(127,127,127,.12)" stroke="rgba(127,127,127,.45)" stroke-width="2"/>
    ${fingers}
  </svg>`;
}

function _renderEditor(host, h) {
  if (!host || !h) { if (host) host.innerHTML = ''; return; }
  const p = h.handParams || hands.defaultHandParams();
  const picking = state.get('handPicking');
  const fine = state.get('handFineTune') === h.id;
  const pose = hands.HAND_POSES[p.pose] || hands.HAND_POSES.handle;
  const pinned = hands.HAND_FINGERS.filter(f => p.targets?.[f]);
  const pk = picking?.nodeId === h.id ? picking : null;
  const poseBtns = hands.HAND_POSE_KEYS.map(k => {
    const P = hands.HAND_POSES[k];
    return `<button class="btn" data-pose="${k}" title="${_esc(P.hint)}" style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 4px;${p.pose === k ? 'background:rgba(34,211,238,0.14);border-color:rgba(34,211,238,0.5);' : ''}"><span style="font-size:20px;line-height:1;">${P.icon}</span><span class="small" style="font-size:10.5px;">${_esc(P.label)}</span></button>`;
  }).join('');
  host.innerHTML = `
    <div class="section">
      <div class="title">${_esc(h.name || 'Hand')} <span class="small muted">(${h.handSide})</span></div>
      <div class="small muted" style="margin:6px 0 4px;">What it holds</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">${poseBtns}</div>
      <div class="card" style="margin-top:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;">
        <label style="display:flex;align-items:center;gap:8px;" title="From the relaxed hand (0) to the full grip (1)"><span class="small" style="flex:0 0 60px;">Closed</span><input type="range" id="hand-closed" min="0" max="1" step="0.01" value="${Number(p.closed ?? 1)}" style="flex:1;" ${p.released ? 'disabled' : ''}></label>
        <div style="display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;">
          <button class="btn primary" id="hand-align" ${pose.ghost && !p.released ? '' : 'disabled'} title="${pose.ghost ? 'Click, on the real part, the three points the ghost prop names — the hand lands on it' : 'This pose holds nothing — place it with the gizmo'}">🎯 Align (3 points)</button>
          <label class="small" style="display:flex;align-items:center;gap:6px;" title="The translucent prop with its three numbered points"><input type="checkbox" id="hand-ghost" ${p.ghost !== false ? 'checked' : ''} ${pose.ghost && !p.released ? '' : 'disabled'}> ghost</label>
        </div>
        ${pose.ghost ? `<div class="small muted" style="line-height:1.45;">${pose.points.map((label, i) => `<span style="color:${['#fbbf24', '#f472b6', '#4ade80'][i]};font-weight:700;">${i + 1}</span> ${_esc(label)}`).join('<br>')}</div>` : ''}
      </div>
      <div class="card" style="margin-top:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;">
        <label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="hand-released" ${p.released ? 'checked' : ''}> Release at this step <span class="small muted">— lets go, moves as a unit</span></label>
        <label style="display:flex;align-items:center;gap:8px;" title="From the grip as it was (0) to the fully open hand (1) — a little = the fingers eased off what was held"><span class="small" style="flex:0 0 60px;">Open</span><input type="range" id="hand-open" min="0" max="1" step="0.01" value="${Number(p.open) || 0}" style="flex:1;" ${p.released ? '' : 'disabled'}></label>
        <label style="display:flex;align-items:center;gap:8px;" title="Wrist to middle fingertip"><span class="small" style="flex:0 0 60px;">Length</span><input type="number" id="hand-scale" min="50" max="1000" step="1" value="${Number(p.scale) || 190}" style="width:80px;"> <span class="small muted">mm</span></label>
      </div>
      <div class="card" style="margin-top:8px;padding:8px 10px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="btn" id="hand-fine" style="flex:1;${fine ? 'background:rgba(34,211,238,0.14);border-color:rgba(34,211,238,0.5);' : ''}" title="Show the fingertip + forearm handles (or double-click the hand)">${fine ? '✓ Fine-tune fingers' : 'Fine-tune fingers…'}</button>
          <button class="btn" id="hand-unpin" ${pinned.length || p.forearm || p.forearmLocal ? '' : 'disabled'}>Reset</button>
        </div>
        ${fine ? `
          ${pk ? `<div class="small" style="margin-top:8px;color:#fca5a5;font-weight:600;">◉ ${hands.FINGER_LABEL[pk.finger]}: click the object where the fingertip touches · Esc stops</div>` : ''}
          <div class="small muted" style="margin:8px 0 4px;">Click a finger, then click where its tip touches — or drag its handle in the viewport. Cyan = pinned; click again to unpin.</div>
          ${_handSvg(h, picking)}` : ''}
      </div>
    </div>`;

  host.querySelectorAll('[data-pose]').forEach(b => b.addEventListener('click', () => act.setHandPose(h.id, b.dataset.pose)));
  const closedEl = host.querySelector('#hand-closed');
  let before = null;
  closedEl?.addEventListener('pointerdown', () => { before = act.snapshotParams(h.id); });
  closedEl?.addEventListener('input',  (e) => act.setHandParams(h.id, { closed: Number(e.target.value) }, null));
  closedEl?.addEventListener('change', (e) => { act.setHandParams(h.id, { closed: Number(e.target.value) }, 'Close the grip', { before }); before = null; });
  host.querySelector('#hand-align')?.addEventListener('click', () => act.startAlignHand(h.id));
  host.querySelector('#hand-ghost')?.addEventListener('change', (e) => act.setGhostVisible(h.id, e.target.checked));
  host.querySelector('#hand-released')?.addEventListener('change', (e) => act.setHandReleased(h.id, e.target.checked));
  const openEl = host.querySelector('#hand-open');
  let openBefore = null;
  openEl?.addEventListener('pointerdown', () => { openBefore = act.snapshotParams(h.id); });
  openEl?.addEventListener('input',  (e) => act.setHandParams(h.id, { open: Number(e.target.value) }, null));
  openEl?.addEventListener('change', (e) => { act.setHandParams(h.id, { open: Number(e.target.value) }, 'Open the hand', { before: openBefore }); openBefore = null; });
  host.querySelector('#hand-scale')?.addEventListener('change', (e) => act.setHandParams(h.id, { scale: Math.max(50, Math.min(1000, Number(e.target.value) || 190)) }, 'Hand length'));
  host.querySelector('#hand-fine')?.addEventListener('click', () => act.setHandFineTune(fine ? null : h.id));
  host.querySelector('#hand-unpin')?.addEventListener('click', () => act.clearAllFingers(h.id));
  host.querySelectorAll('[data-finger]').forEach(g => g.addEventListener('click', () => {
    const f = g.dataset.finger;
    if (pk && pk.finger === f) { act.stopHandPick(); return; }
    if (p.targets?.[f] && !p.released) { act.clearHandFinger(h.id, f); return; }
    act.startHandPick(h.id, f);
  }));
}
