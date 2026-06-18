/**
 * SBS — Primitives tab  (V0.2.22.90)
 * ===================================
 * A palette of parametric primitives (box / sphere / cylinder / …). Click one
 * to drop it into the scene (under the selected folder/model, else scene root).
 * When a primitive is selected, its parameter editor shows below — number
 * inputs per parameter plus a 1-5 quality (surface intricacy) slider. Every
 * change rebuilds the geometry LIVE so the result is immediate.
 */
import state        from '../core/state.js';
import * as actions  from '../systems/actions.js';
import * as hardwarePlacePicker from '../systems/hardware-place-picker.js';

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function _styleOnce() {
  if (document.getElementById('_sbs-prim-style')) return;
  const s = document.createElement('style');
  s.id = '_sbs-prim-style';
  s.textContent = `
    .prim-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:8px;}
    .prim-btn{display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 4px;
      background:var(--panel2,#1e293b);border:1px solid var(--line,#334155);border-radius:7px;
      color:var(--text,#e2e8f0);cursor:pointer;font-size:11px;}
    .prim-btn:hover{border-color:#0ea5e9;background:rgba(14,165,233,0.10);}
    .prim-ico{font-size:20px;line-height:1;}
    .prim-editor{padding:8px 10px;border-top:1px solid var(--line,#334155);}
    .prim-editor-title{font-size:12px;font-weight:600;margin-bottom:8px;color:#7dd3fc;}
    .prim-row{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:12px;}
    .prim-row > span:first-child{flex:0 0 88px;color:#94a3b8;}
    .prim-row input[type=number]{flex:1;min-width:0;box-sizing:border-box;padding:3px 6px;
      background:var(--panel,#0f172a);border:1px solid var(--line,#334155);border-radius:4px;color:var(--text,#e2e8f0);}
    .prim-row input[type=range]{flex:1;}
  `;
  document.head.appendChild(s);
}

export function renderPrimitivesTab(panel) {
  if (!panel) return;
  _styleOnce();
  const defs  = actions.getPrimitiveDefs();
  const selId = state.get('selectedId');
  const sel   = selId ? state.get('nodeById')?.get(selId) : null;
  const editing = sel && sel.type === 'primitive' ? sel : null;

  const grid = Object.entries(defs).map(([kind, d]) =>
    `<button class="prim-btn" data-kind="${kind}" title="Create ${_esc(d.label)}">
       <span class="prim-ico">${d.icon || '⬡'}</span><span>${_esc(d.label)}</span>
     </button>`).join('');

  let editor = `<div class="small muted" style="padding:10px;line-height:1.5">
      Select a primitive in the scene to edit its parameters here.</div>`;
  if (editing) {
    const d      = defs[editing.primKind] || {};
    const params = editing.primParams || {};
    const rows = (d.params || []).map(pr => {
      const v = params[pr.key] ?? pr.def;
      return `<label class="prim-row"><span>${_esc(pr.label)}</span>
        <input type="number" class="prim-param" data-key="${_esc(pr.key)}" value="${v}"
          min="${pr.min ?? 0}" ${pr.max != null ? `max="${pr.max}"` : ''} step="${pr.step ?? 1}" />
      </label>`;
    }).join('');
    const qRow = d.quality ? `
      <label class="prim-row"><span>Quality</span>
        <input type="range" id="prim-quality" min="1" max="5" step="1" value="${editing.primQuality ?? 3}" />
        <span id="prim-quality-val" style="flex:0 0 14px;text-align:right">${editing.primQuality ?? 3}</span>
      </label>
      <div class="small muted" style="font-size:10px;margin-left:96px;opacity:0.7">1 = chunky · 5 = smooth</div>` : '';
    editor = `<div class="prim-editor">
        <div class="prim-editor-title">${_esc(d.label || editing.primKind)} — parameters</div>
        ${rows}${qRow}
      </div>`;
  }

  panel.innerHTML = `
    <div class="small muted" style="padding:8px 10px 0">Click to create — drops into the selected folder/model (or scene). Move it with the gizmo.</div>
    <div class="prim-grid">${grid}</div>
    ${editor}
  `;

  panel.querySelectorAll('.prim-btn').forEach(b =>
    b.addEventListener('click', () => {
      // Create at origin, then immediately enter place-on-surface mode so the
      // user drops it where they click (surface) or in front of the camera
      // (empty space) — instead of it just popping at 0,0,0.
      const id = actions.createPrimitive(b.dataset.kind);
      if (id) hardwarePlacePicker.startPlaceNodeOnSurface(id);
    }));

  if (!editing) return;
  const id = editing.id;

  // Number params — live on input, commit one undo on change (before snapshot
  // captured at focus so the whole drag is a single undo step).
  let beforeParams = null;
  panel.querySelectorAll('.prim-param').forEach(inp => {
    inp.addEventListener('focus', () => { beforeParams = { ...(state.get('nodeById')?.get(id)?.primParams || {}) }; });
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) actions.setPrimitiveParams(id, { [inp.dataset.key]: v });   // live, no undo
    });
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) actions.setPrimitiveParams(id, { [inp.dataset.key]: v }, { undoLabel: 'Edit primitive', before: beforeParams });
    });
  });

  const q = panel.querySelector('#prim-quality');
  if (q) {
    let beforeQ = null;
    const lbl = panel.querySelector('#prim-quality-val');
    q.addEventListener('focus',     () => { beforeQ = state.get('nodeById')?.get(id)?.primQuality ?? 3; });
    q.addEventListener('pointerdown', () => { beforeQ = state.get('nodeById')?.get(id)?.primQuality ?? 3; });
    q.addEventListener('input', () => {
      if (lbl) lbl.textContent = q.value;
      actions.setPrimitiveQuality(id, parseInt(q.value, 10));   // live
    });
    q.addEventListener('change', () =>
      actions.setPrimitiveQuality(id, parseInt(q.value, 10), { undoLabel: 'Primitive quality', before: beforeQ }));
  }
}
