# SBS Project — Claude Directives

## Architecture Rules

### Complex multi-system actions — WARN BEFORE BUILD
If a feature requires coordinating 3+ systems simultaneously (e.g. delete preset → update steps + meshes + history), STOP. Tell user before coding. Propose simpler alternative. Only proceed with explicit approval.

### Reply style
Ultra-concise caveman mode unless user asks otherwise.
"Stoneman" = refresh reply rules.

### Undo / Redo — every mutation goes through actions.js
All user-facing mutations must go through `systems/actions.js` and push to `undoManager`. Direct calls to `materials`, `steps`, or `state` from UI code are not undoable. Slider batching: pointerdown → `beginPresetEdit`, input → live update, pointerup → `commitPresetEdit`.

### Step = self-contained snapshot
A step stores a complete, standalone scene snapshot: visibility, transforms, materials (color assignments), camera. Steps must never reference other steps or rely on sequential playback order. Any step must be deployable in isolation and produce a correct scene. Diffs are computed at activation time, not stored.

### Save / Load — complete project state, backward compatible
The project file is the single source of truth. It must capture ALL runtime state needed to restore the session exactly:
- color presets, mesh color assignments (`colors.assignments`), mesh default colors (`colors.defaults`)
- steps with full snapshots, camera views, settings
- scene tree (for ID remapping on model reload)

New fields must be added non-destructively (safe defaults on missing keys). Legacy formats must migrate via `migrateSection()`. Never break load of older `.sbsproj` files.
