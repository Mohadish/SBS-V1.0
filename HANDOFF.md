# V0.2.22+ Handoff — Read this first

**You are working in:** `E:\SBS-V1.0 - Claude\.claude\worktrees\V0.2.22+\`
**Branch:** `v0.2.22-refactor`
**Started from:** tag `v0.2.21-stable` (commit `b7c2fa1`)
**Do NOT touch the main checkout** `E:\SBS-V1.0 - Claude\` — that ships V0.2.21.

---

## Why this worktree exists

V0.2.21 has a structural bug in how the in-app folder-move path constructs world transforms — it diverges from the path the project file's load uses to reconstruct the scene. The mismatch produces a **silent corruption loop** for the user's authoring work.

**This refactor unifies the two paths.** Until it lands, every cross-parent move in V0.2.21 risks contaminating per-step deltas.

---

## The bug, precisely

### The two paths today

**In-app cross-parent move** (`_moveIdsIntoNode` in `sbs-app/src/ui/tree.js`):
```
1. splice node out of parent.children
2. push into targetNode.children                    ← updates DATA spec
3. parent.object3d.remove(node.object3d)
4. targetNode.object3d.add(node.object3d)           ← mutates Three.js IN PLACE
5. applyAllTransforms(root, ...)                    ← writes baseLocal+delta per Object3D
6. scheduleTransformSync
```
**Reuses** the destination folder's existing Three.js Group (with whatever cached matrix state it has).

**Load / step-activation** (`applySnapshotInstant` in `sbs-app/src/systems/steps.js`):
```
1. cleanupFolderGroups(root, object3dById)          ← REMOVES every folder Group
2. rebuildFromTreeSpec(snapshot.tree, ...)          ← CREATES fresh Groups at identity,
                                                       parents meshes per spec
3. applyAllTransformSnapshots(snapshot.transforms)
4. applyAllTransforms                               ← finalizes world matrices
```
**Recreates** every folder Group from scratch.

### The double-compensation loop (the user's discovery)

This is the failure mode that makes the bug **dangerous, not just annoying**:

1. User moves folder/object → in-app cascade computes WRONG world pose
2. User sees it's wrong → drags with gizmo to correct it → drag writes a compensating delta into `localOffset`/`Quaternion` for the active step
3. **Save** persists the bogus compensation alongside the new tree spec
4. **Load** runs the CORRECT cascade → object's home is now where the user intended
5. **Bogus compensation applies on top** → overshoots in the opposite direction → "everything everywhere"

**Proof:** the user reset per-step deltas on a corrupted file → objects snapped to their correct home. That confirms `baseLocal*` was right; the deltas were the contamination.

### Why the bug also shows as "no visual update until step refresh"

The in-app `parent.remove/add` doesn't trigger a full matrix chain recompute. Three.js needs the rebuild (or an explicit `updateMatrixWorld(true)`) to propagate. Step refresh = forced rebuild via `applySnapshotInstant` = correct view appears.

So the user's two symptoms are the same root cause:
- "Has to step-refresh to see the move land" → in-app path doesn't fully render
- "Reload makes everything wrong" → in-app vs load disagreement

---

## What needs to change

### Rule 1 — In-app structural changes go through the rebuild pipeline

`_moveIdsIntoNode` becomes:
```
1. update DATA spec only (splice children arrays)
2. serialize current live tree → treeSpec
3. cleanupFolderGroups(root, object3dById)
4. rebuildFromTreeSpec(treeSpec, nodeById, object3dById, null)
5. applyAllTransforms(root, object3dById)
6. scheduleTransformSync
```

Outcome: what the user sees in-session is **byte-for-byte** what load reproduces from current spec. The compensation loop becomes structurally impossible.

Same rule applies to:
- `_deleteEmptyFolder` (folder delete)
- folder-create paths in `actions.js`
- Paste-Tree's `applySnapshotInstant` already does this — it's the model.

### Rule 2 — Cascade behaves the same; spec is the truth

No semantic change. Cascade move = update spec, rebuild, accept that world pose follows new parent chain. This is the user-visible intent of "Cascade position." It now matches reload byte-for-byte.

### Rule 3 — keep-position becomes per-step, never touches baseLocal*

Today's V0.2.19 keep-position writes the post-attach decomposed transform into `node.baseLocalPosition/Quaternion`. That's **project-global** — it shifts the home anchor for ALL steps, contaminating every other step.

Replace with:
```
1. capture moved object's world pose BEFORE rebuild
2. rebuild via Rule 1
3. compute world delta = (old world) × inv(new world after rebuild)
4. decompose delta into per-step localOffset/localQuaternion
5. write into the ACTIVE step's snapshot.transforms[id] only
```

Outcome: keep-position is now an active-step-only compensation, exactly as the dialog text already claims ("preserves the pose in the active step. Other steps may shift."). `baseLocal*` is never rewritten by user actions. V0.2.19's `baseLocal*` rewriting becomes a deprecated code path.

---

## Files to touch (in order)

1. **`sbs-app/src/ui/tree.js`** — `_moveIdsIntoNode` rewrite (Rule 1 + Rule 3)
2. **`sbs-app/src/ui/tree.js`** — `_deleteEmptyFolder` audit (does it use rebuild?)
3. **`sbs-app/src/systems/actions.js`** — folder-create paths, `_applyCompensationFolders` (paste-tree's preserve-world — verify it works with the new model)
4. **`sbs-app/src/systems/steps.js`** — confirm `applySnapshotInstant` is callable in mid-session without disrupting active animations
5. **`sbs-app/src/core/transforms.js`** — possibly extract a `rebuildLiveTree(root)` helper that wraps cleanup+rebuild+applyAllTransforms for shared use

## Test plan

After each rule, exercise these scenarios and compare in-session vs reload:

| # | Scenario | Expected after fix |
|---|---|---|
| 1 | Move a single mesh A → folder B (Cascade) | Same world pose in-session and after reload |
| 2 | Move folder F + descendants A → B (Cascade) | Same |
| 3 | Move A → B with keep-position | Active step preserves world; other steps shift visibly (intentional) |
| 4 | Move + gizmo-correct + save + reload | NO drift. Compensation loop must be structurally impossible. |
| 5 | Create folder, move 3 items in, delete folder | Items return to original parents at original world pose |
| 6 | Cross-model mesh move | Still a structural problem (separate refactor needed — `sourceAssetId` tracking) |

## What this refactor does NOT fix

- **Cross-model mesh moves** (the "duplicates after reload" bug). That requires per-mesh `sourceAssetId` tracking + asset-aware loader. Separate ticket.
- **FBX persistency instability** (RM sometimes loses children). Separate non-reproducible issue.

## Versioning

- This branch's `APP_VERSION` is still `'V0.2.21'` (inherited). Bump to `'V0.2.22'` only after Rule 1 lands and you've verified scenario #4 passes.

## Mental model — the three layers of node state (refresher)

```
NODE
├── baseLocal*          ← PROJECT-GLOBAL anchor. Set once at import. SACRED.
│                          (Today: keep-position writes here. After Rule 3: never written by user actions.)
├── localOffset, localQuaternion, orientationSteps   ← PER-STEP deltas.
│                          Live in step.snapshot.transforms[nodeId]; replayed every step nav.
├── pivotLocal*         ← gizmo pivot. Per-step.
└── tree position       ← per-step (step.snapshot.tree). Reparenting in step 5 doesn't affect step 1.
```

Final Three.js local pose:
```
position    = baseLocalPosition + localOffset             (if moveEnabled)
quaternion  = baseLocalQuaternion × localQuaternion       (if rotateEnabled)
scale       = baseLocalScale
```

World pose chains through parents normally.

## Why the original V0.2.19 keep-position was wrong

It captured the post-attach LIVE position into `baseLocal*`. That:
1. Mutates a project-global field for a per-step intent
2. Bakes the in-app cascade's (potentially wrong) world pose into the anchor permanently
3. Makes OTHER steps render with the new anchor — they shift visibly even though the user only wanted the active step to look right
4. Made cross-model move corruption worse (anchor now in a foreign frame)

After Rule 3, keep-position is a per-step `localOffset`/`Quaternion` write. Other steps stay untouched. Anchors never drift.

---

## Quick start for the next session

1. `cd "E:\SBS-V1.0 - Claude\.claude\worktrees\V0.2.22+"`
2. Read `sbs-app/src/ui/tree.js` around `_moveIdsIntoNode` (~line 1570)
3. Read `sbs-app/src/systems/steps.js` `applySnapshotInstant` (~line 288) and `rebuildFromTreeSpec` (~line 2445)
4. Implement Rule 1. Test scenarios #1, #2.
5. Implement Rule 3. Test scenario #4 — THIS is the success criterion. If a move + gizmo correction + reload produces drift, the refactor is incomplete.
6. Bump `APP_VERSION` in `sbs-app/src/core/schema.js` to `'V0.2.22'`.
7. Commit with message describing the unification.

---

*This handoff captures the user's V0.2.21 in-the-wild observations. The double-compensation loop is the key insight — if you remember nothing else, remember that the in-app cascade computes a different world pose than load, and the user's manual gizmo corrections get poisoned by the mismatch.*
