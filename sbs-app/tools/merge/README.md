# SBS project merger (same-source)

Merge two `.sbsproj` halves that were **split from the same project** back into
one, and optionally move narration audio out to a disk-cache folder.

## When it's safe
Only for **same-source** halves — they must share the model/tree node IDs. Check
first:
```
node --max-old-space-size=4096 <scratch>/merge-check.js a.json b.json
```
Tree-id overlap must be ~100% ("SAME SOURCE — clean append"). If it says
"DIVERGENT IDs", the halves loaded the model independently and would need
name/path remapping — this tool does NOT handle that.

## Run
```
node --max-old-space-size=6144 merge-projects.js <base.sbsproj> <add.sbsproj> <out.sbsproj> [--audio <folderName>]
```
- **base** wins on everything shared (tree, model, shapes, cables, hardware,
  colors, header, settings). Its definitions are identical to `add`'s.
- Every definition list is unioned by id (so a step from `add` never references a
  missing style/preset/camera).
- `add`'s steps + chapters that `base` doesn't already have (by id) are appended;
  shared base/setup steps are kept once, from `base`.
- `--audio <folder>`: writes every inline **kokoro** clip to
  `<out-dir>/<folder>/<voiceSlug>/<stepSlug>__<hash>.wav` (the app's exact
  narration-cache scheme) and stamps `narration.dataFile`, dropping the base64.
  Open the merged file FROM the folder that holds `<folder>` so the paths resolve.

## Important limitation
Audio externalize only helps if audio is the weight. On a **large-model,
many-step** project the real bulk is the **per-step scene snapshots** (each step
stores a full snapshot of every node) plus **inline overlay images** — neither is
externalized here. Profile the result with `mem-profile.js` before assuming it's
light. Merging back a project you split for memory reasons rebuilds most of that
weight.
