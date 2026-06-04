/**
 * SBS — Hardware tab (V0.2.22.37).
 *
 * Lets the user spec a screw + generate it into the scene as a procedural
 * model. Future: washer and nut generators sit alongside the screw block
 * in this same tab.
 *
 * Each generated screw becomes an independent model in the tree — drag
 * into folders, color, transform, animate like any imported part.
 *
 * The form mirrors how engineers actually call out hardware: "M4 × 20
 * pan, Phillips." Diameter and length are free-numeric (so non-standard
 * sizes work too); head and drive are dropdowns of the visually-distinct
 * options the generator supports.
 */

import { addScrew } from '../systems/hardware-actions.js';
import { setStatus } from './status.js';

const HEAD_OPTIONS = [
  { value: 'pan',     label: 'Pan'                    },
  { value: 'button',  label: 'Button'                 },
  { value: 'flat',    label: 'Flat / Countersunk'     },
  { value: 'socket',  label: 'Socket cap'             },
  { value: 'lowhead', label: 'Low head'               },
  { value: 'hex',     label: 'Hex head'               },
];

const DRIVE_OPTIONS = [
  { value: 'phillips', label: 'Phillips'              },
  { value: 'slotted',  label: 'Slotted'               },
  { value: 'hex',      label: 'Hex socket / Allen'    },
  { value: 'torx',     label: 'Torx / hexalobular'    },
];

// Last-used spec persists in module scope so the form remembers across
// tab switches within the same session. Re-rendering the tab pulls these
// values back into the inputs. Defaults match a common fastener.
let _lastSpec = {
  diameter:   4,
  length:     20,
  headType:   'pan',
  driveStyle: 'phillips',
};

export function renderHardwareTab(panelEl) {
  if (!panelEl) return;

  panelEl.innerHTML = `
    <div class="card">
      <div class="title" style="font-size:13px;">Hardware</div>
      <div class="small muted" style="margin-top:4px;">
        Generate parametric fasteners into the scene. Each item becomes a
        standalone model — drag into folders, color, animate like any
        imported part. Units: 1 scene unit = 1 mm.
      </div>
    </div>

    <div class="card" style="margin-top:8px;">
      <div class="title" style="font-size:13px;">Screw</div>

      <div class="grid2" style="margin-top:8px;gap:6px;">
        <label class="small muted">Ø Diameter (mm)
          <input type="number" id="hw-screw-d" min="1" max="30" step="0.5"
                 value="${_lastSpec.diameter}"
                 style="width:100%;margin-top:2px;padding:4px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);" />
        </label>
        <label class="small muted">Length (mm)
          <input type="number" id="hw-screw-l" min="2" max="500" step="1"
                 value="${_lastSpec.length}"
                 style="width:100%;margin-top:2px;padding:4px;border:1px solid var(--line);border-radius:4px;background:var(--panel2);color:var(--text);" />
        </label>
      </div>

      <label class="small muted" style="display:block;margin-top:8px;">Head type
        <select id="hw-screw-head" style="width:100%;margin-top:2px;">
          ${HEAD_OPTIONS.map(o => `
            <option value="${o.value}" ${o.value === _lastSpec.headType ? 'selected' : ''}>${o.label}</option>
          `).join('')}
        </select>
      </label>

      <label class="small muted" style="display:block;margin-top:8px;">Drive style
        <select id="hw-screw-drive" style="width:100%;margin-top:2px;">
          ${DRIVE_OPTIONS.map(o => `
            <option value="${o.value}" ${o.value === _lastSpec.driveStyle ? 'selected' : ''}>${o.label}</option>
          `).join('')}
        </select>
      </label>

      <button class="btn" id="hw-screw-add" style="margin-top:10px;width:100%;">
        ＋ Add screw to scene
      </button>

      <div class="small muted" style="margin-top:6px;font-size:11px;opacity:0.75;">
        Tip: the screw lands at scene origin. Use the gizmo to place it,
        or move it into a folder to group related fasteners.
      </div>
    </div>

    <div class="card" style="margin-top:8px;">
      <div class="title" style="font-size:13px;color:#64748b;">Washer + Nut</div>
      <div class="small muted" style="margin-top:4px;opacity:0.7;">
        Coming next — same pattern, fewer parameters.
      </div>
    </div>
  `;

  const dInp     = panelEl.querySelector('#hw-screw-d');
  const lInp     = panelEl.querySelector('#hw-screw-l');
  const headSel  = panelEl.querySelector('#hw-screw-head');
  const driveSel = panelEl.querySelector('#hw-screw-drive');
  const addBtn   = panelEl.querySelector('#hw-screw-add');

  // Bind change handlers to persist the last spec for the next tab open.
  // Doesn't write to user settings — session-only memory is enough for
  // the typical authoring flow (set up the screw style once, generate
  // multiple instances).
  const _read = () => {
    _lastSpec = {
      diameter:   Math.max(0.5, Number(dInp.value) || 4),
      length:     Math.max(1,   Number(lInp.value) || 20),
      headType:   String(headSel.value || 'pan'),
      driveStyle: String(driveSel.value || 'phillips'),
    };
    return _lastSpec;
  };

  dInp.addEventListener('change',     _read);
  lInp.addEventListener('change',     _read);
  headSel.addEventListener('change',  _read);
  driveSel.addEventListener('change', _read);

  addBtn.addEventListener('click', () => {
    const spec = _read();
    try {
      const node = addScrew(spec);
      if (node) {
        setStatus(`Added M${spec.diameter}×${spec.length} ${spec.headType}/${spec.driveStyle}.`, 'success', 2000);
      }
    } catch (e) {
      console.error('[hardware] addScrew failed:', e);
      setStatus(`Failed to add screw: ${e?.message || 'unknown error'}`, 'danger', 4000);
    }
  });
}
