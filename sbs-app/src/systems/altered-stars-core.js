// ★ Altered-step stars — the PURE half (V0.3.2.253).
//
// No imports, no state: every function here takes plain data and returns
// plain data, so the rules that decide "which steps did this change touch"
// can be unit-tested offline against real project files. The wiring that
// listens to state and writes `step.altered` lives in altered-stars.js.
//
// Vocabulary: a "step" is the saved step record ({ id, snapshot, overlay,
// transition, cameraBinding, narration, … }); `visibleOf(step)` returns the
// Set of node ids that are EFFECTIVELY visible in that step (own flag AND
// every ancestor, archive wins) — the same rule the renderer applies.

/** Effectively visible node ids of a step tree under its visibility map. */
export function visibleIds(tree, visibility) {
  const out = new Set();
  const V = visibility || {};
  (function walk(n, ancestorsVisible) {
    if (!n) return;
    const own = V[n.id] === undefined ? n.localVisible !== false : V[n.id] !== false;
    const eff = ancestorsVisible && own && n.archived !== true;
    if (eff) out.add(n.id);
    for (const c of (n.children || [])) walk(c, eff);
  })(tree, true);
  return out;
}

/** Ordered ids of the steps that PLAY (not base, not hidden, chapter not hidden). */
export function playableOrder(steps, chapters) {
  const chHidden = new Set((chapters || []).filter(c => c && c.hidden).map(c => c.id));
  return (steps || [])
    .filter(s => s && !s.isBaseStep && !s.hidden && !chHidden.has(s.chapterId))
    .map(s => s.id);
}

/**
 * Steps whose transition-IN changed because the step BEFORE them is not the
 * one it was: reorder, delete, hide, chapter hide/unhide. A step that is new
 * to the order is skipped — whoever created it stars it.
 */
export function predecessorChanges(prevOrder, nextOrder) {
  const prevIdx = new Map((prevOrder || []).map((id, i) => [id, i]));
  const out = [];
  (nextOrder || []).forEach((id, i) => {
    if (!prevIdx.has(id)) return;
    const before     = i > 0 ? nextOrder[i - 1] : null;
    const wasBefore  = prevIdx.get(id) > 0 ? prevOrder[prevIdx.get(id) - 1] : null;
    if (before !== wasBefore) out.push(id);
  });
  return out;
}

/**
 * Stable signature of a definition. `spec` is either the list of keys to
 * IGNORE (keys sorted, the rest kept) or a PROJECTION function returning the
 * fields that count — for definitions that also carry live per-step state
 * (a cable's current nodes / visibility ride on its record; only its style
 * is a definition).
 */
export function defSig(item, spec = []) {
  if (!item || typeof item !== 'object') return JSON.stringify(item ?? null);
  if (typeof spec === 'function') return JSON.stringify(spec(item) ?? null);
  const skip = new Set(spec);
  const sorted = {};
  for (const k of Object.keys(item).sort()) if (!skip.has(k)) sorted[k] = item[k];
  return JSON.stringify(sorted);
}

/** id → signature for a definition list (see defSig for `spec`). */
export function sigMap(list, spec = []) {
  const m = new Map();
  for (const it of (list || [])) if (it && it.id != null) m.set(it.id, defSig(it, spec));
  return m;
}

/** Which ids changed or vanished between two signature maps. */
export function changedIds(prevMap, nextMap) {
  const changed = new Set(), removed = new Set();
  for (const [id, sig] of (nextMap || new Map())) {
    if (!prevMap || !prevMap.has(id)) continue;      // new def — nothing references it yet
    if (prevMap.get(id) !== sig) changed.add(id);
  }
  for (const id of (prevMap || new Map()).keys()) if (!nextMap || !nextMap.has(id)) removed.add(id);
  return { changed, removed };
}

/** What the narration contributes to a segment: the spoken text, voice, speed. */
export function narrationSig(n) {
  if (!n) return '';
  return `${String(n.text || '').trim()}|${n.voiceId ?? ''}|${n.speed ?? 1}`;
}

/** Steps where a VISIBLE mesh wears one of the presets (per-step override, else default). */
export function stepsUsingPresets(steps, defaults, presetIds, visibleOf) {
  const out = [];
  const D = defaults || {};
  for (const s of (steps || [])) {
    const mats = s.snapshot?.materials || {};
    let hit = false;
    for (const id of visibleOf(s)) {
      const p = mats[id] ?? D[id];
      if (p != null && presetIds.has(p)) { hit = true; break; }
    }
    if (hit) out.push(s.id);
  }
  return out;
}

/** Steps whose overlay string mentions any of the ids (styles, links, const shapes/text, masks). */
export function stepsReferencing(steps, ids) {
  const list = [...ids];
  if (!list.length) return [];
  const out = [];
  for (const s of (steps || [])) {
    const ov = s.overlay;
    if (typeof ov !== 'string' || !ov) continue;
    if (list.some(id => ov.includes(id))) out.push(s.id);
  }
  return out;
}

/** Steps bound to one of the camera templates. */
export function stepsBoundToCameras(steps, templateIds) {
  return (steps || [])
    .filter(s => s.cameraBinding?.mode === 'template' && templateIds.has(s.cameraBinding.templateId))
    .map(s => s.id);
}

/** Steps in which any of the nodes is effectively visible. */
export function stepsWithVisibleNodes(steps, nodeIds, visibleOf) {
  const out = [];
  for (const s of (steps || [])) {
    const vis = visibleOf(s);
    for (const id of nodeIds) if (vis.has(id)) { out.push(s.id); break; }
  }
  return out;
}

/** Steps showing a flat shape built from one of the templates. */
export function stepsWithVisibleShapeTemplates(steps, templateIds, visibleOf) {
  const out = [];
  for (const s of (steps || [])) {
    const vis = visibleOf(s);
    let hit = false;
    (function walk(n) {
      if (hit || !n) return;
      if (n.type === 'flatShape' && n.templateId && templateIds.has(n.templateId) && vis.has(n.id)) { hit = true; return; }
      for (const c of (n.children || [])) walk(c);
    })(s.snapshot?.tree);
    if (hit) out.push(s.id);
  }
  return out;
}

/** 🔩 Steps showing a hardware instance built from one of the templates (V0.3.4.95). */
export function stepsWithVisibleHardwareTemplates(steps, templateIds, visibleOf) {
  const out = [];
  for (const s of (steps || [])) {
    const vis = visibleOf(s);
    let hit = false;
    (function walk(n) {
      if (hit || !n) return;
      if (n.type === 'hardwareInstance' && n.templateId && templateIds.has(n.templateId) && vis.has(n.id)) { hit = true; return; }
      for (const c of (n.children || [])) walk(c);
    })(s.snapshot?.tree);
    if (hit) out.push(s.id);
  }
  return out;
}

/**
 * 📝 Steps in which a note linked to one of the templates can show: the note is
 * not hidden and its anchor part is visible there (V0.3.4.95). Notes are live
 * tree nodes, never in a snapshot — `notes` is their projection
 * [{ id, templateId, anchorMeshId, localVisible }].
 */
export function stepsWithNoteTemplates(steps, templateIds, notes, visibleOf) {
  const anchors = new Set();
  for (const n of (notes || [])) if (n && n.templateId && templateIds.has(n.templateId) && n.localVisible !== false && n.anchorMeshId) anchors.add(n.anchorMeshId);
  if (!anchors.size) return [];
  return stepsWithVisibleNodes(steps, anchors, visibleOf);
}

/** Steps that carry (and show) one of the cables. */
export function stepsWithCables(steps, cableIds) {
  const out = [];
  for (const s of (steps || [])) {
    const cab = s.snapshot?.cables || {};
    for (const id of cableIds) {
      const c = cab[id];
      if (c && c.visible !== false) { out.push(s.id); break; }
    }
  }
  return out;
}
