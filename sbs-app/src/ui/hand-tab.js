/**
 * SBS — Hands tab (V0.3.4.127, phase 1).
 * ─────────────────────────────────────
 * + Add hand (left / right) → a hand node in the tree. Pick a finger on the
 * drawing, click the object where its tip touches (systems/hand-actions.js),
 * repeat, Place hand. Then the handles in the viewport: five fingertips,
 * the palm (pink), the forearm point (yellow). Release at this step turns
 * the hand into a unit that moves like any object.
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
  const picking = state.get('handPicking');

  container.innerHTML = `
    <div class="section">
      <div class="title">🖐 Hands</div>
      <div class="small muted" style="margin-top:6px;line-height:1.5;">
        A hand that grips what you point at. Add one, pick a finger on the drawing, click the
        object where that fingertip touches, repeat, then <strong>Place hand</strong>. Drag the
        fingertip, palm (pink) and forearm (yellow) handles in the viewport to adjust.
      </div>
      <div class="card" style="margin-top:10px;display:flex;gap:6px;">
        <button class="btn" id="hand-add" style="flex:1;">+ Add hand</button>
      </div>
      <div class="card" style="margin-top:8px;padding:0;">
        <div class="title" style="padding:8px 10px;border-bottom:1px solid var(--line);">Hands <span class="small muted">(${list.length})</span></div>
        <div id="hand-list">
          ${list.length === 0 ? '<div class="small muted" style="padding:10px;">No hands yet — pick + Add hand.</div>' : list.map(h => _row(h)).join('')}
        </div>
      </div>
      <div id="hand-editor"></div>
    </div>`;

  container.querySelector('#hand-add')?.addEventListener('click', async () => {
    const side = await chooseFromButtons('Which hand?', 'The hand is drawn as a bone rig (palm, five fingers, forearm). Pick the side; both at once comes later.', [
      { id: 'right', label: 'Right hand', primary: true }, { id: 'left', label: 'Left hand' }, { id: 'cancel', label: 'Cancel' },
    ]);
    if (!side || side === 'cancel') return;
    _activeId = act.addHand(side);
    renderHandTab(container);
  });
  container.querySelector('#hand-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-hand-id]'); if (!row) return;
    const id = row.dataset.handId;
    const a = e.target.closest('[data-hand-act]')?.dataset.handAct;
    if (a === 'delete') { if (confirm('Delete this hand?')) { act.removeHand(id); if (_activeId === id) _activeId = null; renderHandTab(container); } return; }
    _activeId = id;
    state.setState({ selectedId: id, multiSelectedIds: new Set([id]) });
    renderHandTab(container);
  });

  if (_activeId) _renderEditor(container.querySelector('#hand-editor'), _liveHands().find(h => h.id === _activeId), picking);
}

function _row(h) {
  const p = h.handParams || {};
  const pinned = hands.HAND_FINGERS.filter(f => p.targets?.[f]).length;
  const st = p.released ? 'released' : pinned ? `${pinned} finger${pinned === 1 ? '' : 's'} on` : 'not placed';
  return `
    <div class="row" data-hand-id="${_esc(h.id)}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;${_activeId === h.id ? 'background:rgba(34,211,238,0.08);' : ''}">
      <span style="font-size:18px;${h.handSide === 'left' ? 'transform:scaleX(-1);display:inline-block;' : ''}">🖐</span>
      <div style="flex:1;min-width:0;">
        <div class="small" style="font-weight:600;">${_esc(h.name || 'Hand')}</div>
        <div class="small muted" style="font-size:11px;">${h.handSide === 'left' ? 'left' : 'right'} · ${st}</div>
      </div>
      <button class="btn icon" data-hand-act="delete" title="Delete" style="width:24px;height:24px;padding:0;color:#f87171;">✕</button>
    </div>`;
}

/** The hand drawing: five finger buttons on an outline. */
function _handSvg(h, picking) {
  const p = h.handParams || {};
  const left = h.handSide === 'left';
  // right-hand layout (thumb on the right); mirrored as a whole for the left
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
      <title>${hands.FINGER_LABEL[f]} — click, then click where its tip touches</title>
      <rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="${g.w / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
      ${on ? `<circle cx="${g.x + g.w / 2}" cy="${g.y + 9}" r="4" fill="#0f172a"/>` : ''}
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 160 190" width="160" height="190" style="display:block;margin:0 auto;${left ? 'transform:scaleX(-1);' : ''}">
    <rect x="30" y="80" width="90" height="82" rx="18" fill="rgba(127,127,127,.18)" stroke="rgba(127,127,127,.6)" stroke-width="2"/>
    <rect x="52" y="158" width="46" height="30" rx="8" fill="rgba(127,127,127,.12)" stroke="rgba(127,127,127,.45)" stroke-width="2"/>
    ${fingers}
  </svg>`;
}

function _renderEditor(host, h, picking) {
  if (!host || !h) { if (host) host.innerHTML = ''; return; }
  const p = h.handParams || hands.defaultHandParams();
  const pinned = hands.HAND_FINGERS.filter(f => p.targets?.[f]);
  const pk = picking?.nodeId === h.id ? picking : null;
  host.innerHTML = `
    <div class="section">
      <div class="title">${_esc(h.name || 'Hand')} <span class="small muted">(${h.handSide})</span></div>
      ${pk ? `<div class="card" style="margin-top:8px;padding:10px;background:rgba(220,38,38,0.08);border-color:#dc2626;"><div class="small" style="color:#fca5a5;font-weight:600;">◉ ${hands.FINGER_LABEL[pk.finger]}: click the object where the fingertip touches · Esc stops</div></div>` : ''}
      <div class="card" style="margin-top:8px;padding:8px;">
        <div class="small muted" style="margin-bottom:4px;">Click a finger, then click where its tip touches. Cyan = pinned. Click a pinned finger to unpin it.</div>
        ${_handSvg(h, picking)}
        <div class="small muted" style="text-align:center;margin-top:4px;">${pinned.length ? `${pinned.map(f => hands.FINGER_LABEL[f]).join(', ')} pinned` : 'no finger pinned yet'}</div>
      </div>
      <div class="card" style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <button class="btn primary" id="hand-place" ${pinned.length ? '' : 'disabled'} title="Fit the palm to the pinned fingertips (also drops a palm you moved)">Place hand</button>
        <button class="btn" id="hand-unpin" ${pinned.length ? '' : 'disabled'}>Unpin all</button>
      </div>
      <div class="card" style="margin-top:8px;padding:8px 10px;display:flex;flex-direction:column;gap:8px;">
        <label style="display:flex;align-items:center;gap:8px;"><input type="checkbox" id="hand-released" ${p.released ? 'checked' : ''}> Release at this step <span class="small muted">— the hand lets go and moves as a unit</span></label>
        <label style="display:flex;align-items:center;gap:8px;" title="How far the fingers open when released"><span class="small" style="flex:0 0 60px;">Open</span><input type="range" id="hand-open" min="0" max="1" step="0.01" value="${Number(p.open) || 0}" style="flex:1;" ${p.released ? '' : 'disabled'}></label>
        <label style="display:flex;align-items:center;gap:8px;" title="Wrist to middle fingertip"><span class="small" style="flex:0 0 60px;">Length</span><input type="number" id="hand-scale" min="50" max="1000" step="1" value="${Number(p.scale) || 190}" style="width:80px;"> <span class="small muted">mm</span></label>
        <div style="display:flex;gap:6px;">
          <button class="btn" id="hand-forearm-reset" ${p.forearm ? '' : 'disabled'} title="The forearm points straight back again">Reset forearm</button>
          <button class="btn" id="hand-palm-reset" ${p.palm ? '' : 'disabled'} title="Let the palm follow the fingertips again">Reset palm</button>
        </div>
      </div>
      <div class="small muted" style="margin-top:8px;line-height:1.5;">In the viewport, with the hand selected: drag a fingertip handle to move where it grips, the pink handle to move / turn the palm, the yellow one to swing the forearm.</div>
    </div>`;

  host.querySelectorAll('[data-finger]').forEach(g => g.addEventListener('click', () => {
    const f = g.dataset.finger;
    if (pk && pk.finger === f) { act.stopHandPick(); return; }
    if (p.targets?.[f] && !p.released) { act.clearHandFinger(h.id, f); return; }
    act.startHandPick(h.id, f);
  }));
  host.querySelector('#hand-place')?.addEventListener('click', () => act.fitHand(h.id));
  host.querySelector('#hand-unpin')?.addEventListener('click', () => act.clearAllFingers(h.id));
  host.querySelector('#hand-released')?.addEventListener('change', (e) => act.setHandReleased(h.id, e.target.checked));
  const openEl = host.querySelector('#hand-open');
  let openBefore = null;
  openEl?.addEventListener('pointerdown', () => { openBefore = act.snapshotParams(h.id); });
  openEl?.addEventListener('input', (e) => act.setHandParams(h.id, { open: Number(e.target.value) }, null));
  openEl?.addEventListener('change', (e) => { act.setHandParams(h.id, { open: Number(e.target.value) }, 'Open the hand', { before: openBefore }); openBefore = null; });
  host.querySelector('#hand-scale')?.addEventListener('change', (e) => act.setHandParams(h.id, { scale: Math.max(50, Math.min(1000, Number(e.target.value) || 190)) }, 'Hand length'));
  host.querySelector('#hand-forearm-reset')?.addEventListener('click', () => act.setHandParams(h.id, { forearm: null }, 'Reset the forearm'));
  host.querySelector('#hand-palm-reset')?.addEventListener('click', () => act.setHandParams(h.id, { palm: null }, 'Reset the palm'));
}
