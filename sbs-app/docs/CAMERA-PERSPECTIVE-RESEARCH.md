# Per-step perspective, orthographic views and smooth transitions — research

Research only (2026-09-20). Nothing in this document is built yet.
Goal: a per-step **amount of perspective** (orthographic … wide), **standard views** for the work
camera, and step-to-step transitions between different perspective amounts that do **not** bob,
pump, or settle with a zoom at the end.

---

## 1. What the app does today

| Piece | Where | Behaviour |
|---|---|---|
| The camera | `src/core/scene.js:265` | One `THREE.PerspectiveCamera`, fov from settings (45), never swapped. |
| Per-step camera | `src/core/schema.js:754` `createCameraState()` | `position`, `quaternion`, `pivot`, `up`, **`fov`**, optional `orbitPivot`, `orbitPullout`. **A per-step fov already exists in the file format** — it is captured and restored, it simply has no UI and never differs between steps. |
| Capture / apply | `scene.js:1016` / `scene.js:1040` | `getCameraState()` / `applyCameraState()`. |
| Transition | `scene.js:1139` `animateCameraTo()` + `scene.js:1211` `_advanceTransition()` | One eased alpha drives everything. Position: `lerp` (or a spherical orbit rig when a step has a pinned `orbitPivot`, `scene.js:87` `_buildOrbitTween`). Orientation: `slerp`. **FOV: plain linear lerp, `scene.js:1272`.** |
| Orbit / zoom | `scene.js:1501` `_initControls()` | Custom CAD controls. Wheel = **dolly** along the view axis (no `camera.zoom` anywhere). Pivot = raycast hit under the cursor. |
| Clip planes | `scene.js:1350` `_updateClipPlanes()` | Already adaptive: `far = dist + r·1.5`, `near = max(far/50000, (dist − r)·0.5)`, rebuilt only on a >2% change. This is what makes a far-away camera safe. |
| Camera templates | `src/ui/sidebar-left.js:3325` | Saved views bound to steps; the template already carries `fov`. |
| Render cache | `src/systems/render-cache.js:413` `_cameraStill()` | Compares `position`, `quaternion`, `up` **and `fov`** — a step that only changes perspective already counts as a camera move. Nothing to add. |
| Work camera | `src/systems/steps.js:198` `_workCamOn()` | Not a second camera — a gate that stops steps from applying their recorded camera. Standard views would be a *view-setting* feature, not a camera-type feature. |

### Consumers that would break under a real `OrthographicCamera`

Everything that projects goes through `Vector3.project()` / `Raycaster.setFromCamera()` and is
camera-type agnostic (`anchored-shapes.js:101`, `notes-render.js:245`, `snap-picker.js`, `gizmo.js:1532`,
`main.js:3078`…). But these read `camera.fov` directly and would compute nonsense with an ortho camera:

`ui/gizmo.js:683,762` (gizmo screen size) · `ui/hardware-preview.js:182` · `systems/shape-editor.js:1299` ·
`systems/pivot-center-picker.js:219,422` · `systems/folder-align-picker.js:407` ·
`systems/folder-align-3pt-picker.js:336` · `systems/hardware-place-picker.js:314` ·
`systems/frame-visibility.js:153` (builds its own `PerspectiveCamera` from the step state) ·
`core/planar-mirror.js:161` (copies `fov` to the reflection camera) · N8AO / SSR composer passes
(`scene.js:684`) · `fitStateForBox()` (`scene.js:1296`).

**→ Recommendation: never swap the camera type.** "Orthographic" is a very long lens (see §4).

---

## 2. The bob, measured

Frame height at the subject's plane: **H = 2 · d · tan(fov/2)**. What the eye reads is `H`
(subject size on screen) and the amount of perspective (`k = tan(fov/2)`, i.e. `1/d` at a fixed `H`).

Today's transition interpolates `d` and `fov` *independently*, so their product wanders and only
comes back at the ends — which is precisely why the artefact reads as a zoom-out and a zoom back in
that settles at the end of the move. Simulated (`smoothstep` easing, subject at the focus plane):

| Move (framing identical at both ends) | Scheme | Worst subject size | Zoom reversals |
|---|---|---|---|
| 50° → 1° | lerp position + lerp fov (today) | **×0.076** — 13× too small mid-move | 1 |
| 50° → 1° | framing-locked (below) | ×1.000 | 0 |
| 50° → 10° | lerp position + lerp fov (today) | **×0.55** — half size mid-move | 1 |
| 50° → 10° | framing-locked | ×1.000 | 0 |
| 50° → 1° **and** a 4× zoom-in | framing-locked with *linear* framing | ×0.79 | 1 |
| 50° → 1° **and** a 4× zoom-in | framing-locked with *geometric* framing | ×1.000 | 0 |

A second, independent bob already exists today and has nothing to do with perspective: when no
`orbitPivot` is pinned, the position is **lerped in a straight line**, so a swing of φ degrees around
the subject cuts the corner and the camera ends up `cos(φ/2)` of the distance away mid-move — the
subject grows ×1.15 at 60°, ×1.41 at 90°, ×2.0 at 120°, then shrinks back. Same "in and out".

## 3. The fix — interpolate what the eye reads, derive the rest

```
per end:  T = focus point,  q = orientation,  d = focus distance,  k = tan(fov/2),  H = 2·d·k

α = ease(t)
T(α) = lerp(T0, T1, α)                     — or the existing orbit rig
q(α) = slerp(q0, q1, α)                    — unchanged
k(α) = lerp(k0, k1, α)                     — perspective amount, LINEAR (k=0 is orthographic)
H(α) = H0 · (H1/H0)^α                      — framing, GEOMETRIC (a zoom is multiplicative)
d(α) = H(α) / (2·k(α))                     — DERIVED, never interpolated
fov(α) = 2·atan(k(α))
P(α) = T(α) − forward(q(α)) · d(α)
```

Three properties, all confirmed in the simulation (`scratchpad/cam-sim.mjs`):

1. **The framing is exact on every frame**, not only at the ends → no bob, nothing to settle.
2. **`k` is the perceptually linear parameter.** The perspective cue is the front/back size ratio
   `1/(1 − 2kz/H)`, which is linear in `k` for the small values that matter. Easing `k` eases the
   *look*. (Easing the fov *angle* is within ~5% of this — acceptable but less clean, and it does not
   reach orthographic. Easing the distance is what breaks everything: `d = H/2k` explodes as `k→0`.)
3. **The distance rushes near the ortho end and that is correct.** With a 2 s move into a 1° view,
   the last 5% of the time covers ~8% of the whole dolly. It looks smooth because the framing is
   pinned and `k` is linear; only the *number* moves fast. Do not "fix" it by easing `d`.

### Which point is the focus plane?

The framing is only pinned at one depth. Pick it badly and the subject bobs anyway. Order:

1. the step's pinned `orbitPivot` if it has one (the user chose it);
2. else `pivot` **projected onto the view axis** — `d = (pivot − P) · forward`, *not* the raw
   distance (the CAD pivot is a cursor hit, often off-axis);
3. else the bounding-sphere centre of the step's visible geometry, projected the same way;
4. else the current `|P − pivot|` (today's behaviour).

Guard: if the result is ≤ 0 or absurd (behind the camera, or < 1% of the scene radius), fall back
down the list.

### Gating — do not touch what already works

Engage the new path **only when the two ends' `k` differ** (`|k0 − k1| > 1e-4`). Every existing
project has one fov everywhere, so every existing transition keeps running the exact code path it
runs today, byte for byte. The straight-line-chord bob (§2) is a *separate*, opt-in improvement —
recommend offering it as "orbit the subject" on the step rather than silently changing every move.

One more small thing while in there: the pinned-orbit rig interpolates its radius **linearly**
(`scene.js:1242`, `fromR + (toR − fromR)·α`). For a large zoom that dwells (the same reason the
framing must be geometric). `r(α) = r0·(r1/r0)^α` is a one-line change, gated on a ratio > ~1.5.

---

## 4. "Orthographic" without an orthographic camera

`k → 0` sends `d → ∞`, so a true parallel projection cannot be reached by dollying. Two routes:

**A. FOV floor (recommended).** Define orthographic as `fov_min = 0.5°` (`k ≈ 0.0044`), i.e. the
camera sits ~115× the frame height away. Convergence error across a subject one frame-height deep is
**0.44%** — about 4 px on a 1080-tall frame, invisible on an assembly drawing. (0.2° / ~290× halves
that again, at the cost of float32 headroom — see §7.5.) Everything above keeps
working: the camera type never changes, the gizmo, pickers, mirrors, N8AO, raycasting, templates and
the file format are all untouched, and the transition is continuous right into the limit.
Precision check: at `d ≈ 290 · H` with the existing adaptive clip planes, the near/far ratio stays
near 1 (`(d+r)/(d−r)`), so depth precision is *better* than a close-up shot; float32 view-space
rounding is ~1e-7·d ≈ 6e-5 of the frame height — sub-pixel. Fog is the one thing that would break,
and the scene has none.

Checked in the vendored passes: **N8AO does handle `isOrthographicCamera`** (6 call sites in
`vendor/three-addons/N8AO.js`), **SSRReflectPass does not** (zero mentions), and the outline pass
only uses an ortho camera for its own full-screen quad (`outline-pass.js:112`) — irrelevant either way.

**B. True `OrthographicCamera`** at the end of the move (or a custom projection matrix of the family
`w = 1 + k·z`, which *is* exactly this dolly zoom expressed about the focus plane and reaches `k = 0`
without moving the camera). Mathematically clean, and the only way to get provably parallel lines —
but it means auditing every `camera.fov` consumer listed in §1 and teaching N8AO/SSR/mirrors/gizmo
about a second camera type. **Park this until someone actually needs measurable parallel projection
(e.g. a technical-drawing export).** If it ever happens, the transition designed here is unchanged:
it is the same one-parameter family, and the swap happens at the `k = k_min` endpoint where the two
cameras differ by 0.4%.

---

## 5. Per-step UI and data

* **Data: nothing new.** The step's `camera.fov` already carries it. Orthographic = `fov = 0.5`.
  Old files load unchanged; a file written with `fov: 0.5` opens in an older build as a very long
  lens — graceful, not broken. (Optional sugar: `camera.ortho: true` as a *display* flag so the UI
  can say "Orthographic" instead of "0.5°"; must be ignored by the maths, which stays on `fov`.)
* **Slider semantics:** dragging *Perspective* must **dolly to hold the framing** (same maths as the
  transition, at one instant) — the composition does not change, only the perspective does. A plain
  fov slider (no dolly) makes the subject jump and is the wrong control; the demo page has both side
  by side to show the difference.
* Slider scale: geometric in `k` between `0.5°` and `~78°`, labelled in degrees **and** in 35mm-
  equivalent focal length (`f ≈ 12/k` mm), with the bottom stop reading "Orthographic".

### 5.1 What the slider actually cures — the corner stretch

"Too much perspective … stuff stretched around you" is the rectilinear projection's off-axis
magnification: a point at angle θ off the axis is stretched radially by `1/cos θ` and covers
`1/cos³θ` of the area it would at the centre. At 16:9:

| vertical fov | ≈ lens | diagonal half-angle | radial stretch at the corner | corner area |
|---|---|---|---|---|
| 78° | 15 mm | 58.8° | ×1.93 | ×7.20 |
| 65° | 19 mm | 52.4° | ×1.64 | ×4.41 |
| 50° | 26 mm | 43.6° | ×1.38 | ×2.63 |
| **45° (app default)** | 29 mm | 40.2° | **×1.31** | **×2.24** |
| 35° | 38 mm | 32.7° | ×1.19 | ×1.68 |
| 25° | 54 mm | 24.3° | ×1.10 | ×1.32 |
| 15° | 91 mm | 15.0° | ×1.04 | ×1.11 |
| 3° | 458 mm | 3.1° | ×1.00 | ×1.00 |

So the complaint is real and quantified: at the current 45°, a part in the corner of the frame is
drawn 31% longer along the radius and covers 2.2× the area it would in the middle. **A sane default
for technical illustration is 30–35°** (CAD apps sit around there), with the slider free to go from
orthographic up to 78° for a dramatic hero shot. Note this is a *reframing* change for existing
projects if the default is changed globally — safer: leave old steps at whatever they saved, and set
the new default only for new steps/projects.
* Undo: the slider writes the step's camera state → it is a mutation → through `systems/actions.js`
  with `beginPresetEdit` / `commitPresetEdit`-style batching on pointerdown/up (the project rule).
* Camera templates (`sidebar-left.js`) already carry `fov`, so a template captures the perspective
  too — check the "Update" path keeps it.

## 6. Standard views (work camera)

Not a camera-type feature: a set of orientations applied through the existing
`animateCameraTo()` — keep the current pivot and framing, change azimuth/elevation only, optionally
also drop to orthographic on arrival (this is what Fusion's "perspective with ortho faces" does).
Six axis views + isometric; bind to a view-cube widget or the numpad.

Known landmine: the orbit controls rebuild their basis as `right = forward × worldY`
(`scene.js:1626`), which is **degenerate at an exact top or bottom view** and falls back to
`(1,0,0)` — the view will roll the moment the user orbits. Either clamp axis views to 89.9°
(cheap, invisible) or give the controls a proper up-vector fallback. Decide before building.

## 7. Risk register

* Touches ≥3 systems (scene/camera, steps/transitions, UI + actions/undo, export & render cache) →
  **per CLAUDE.md this needs explicit approval before any code is written.** Suggested phasing:
  1. **Transition maths only** (gated on differing fov, no UI) — invisible until a step has a
     different fov, and independently testable with a two-step project.
  2. **Per-step Perspective slider** + undo + templates.
  3. Standard views / view cube.
  4. (Only if needed) true orthographic camera.
* Export: the offline path uses the same `animateCameraTo` tick, so it inherits the fix. Verify the
  deterministic-frame rule still holds (the derived distance is a pure function of α → it does).
* Render cache: `_cameraStill()` already includes `fov`; a fov-only change re-renders. ✔
* 3D-anchored overlay shapes/notes project through the camera every frame — a perspective change
  moves them, which is correct, but it means a fov-only step change is *not* a static hold.
* Thumbnails and `frame-visibility.js` rebuild a camera from the step state including `fov`. ✔
* **Overscan uses `camera.zoom = 1/ov`** (`scene.js:905`) — the true frame height is
  `H = 2·d·tan(fov/2)/zoom`. `zoom` is a viewport display factor, constant through a transition and
  not part of the step state, so it scales both ends equally and drops out of the maths. Just never
  read `H` off the screen without dividing by `zoom`, and keep the slider's dolly independent of it.

## 7.5 Prior art (what other apps actually do)

Researched 2026-09-20; each claim below was read from the source or page linked.

* **Nobody in DCC/CAD animates the perspective↔ortho switch.** Blender assigns `rv3d->persp` once,
  *before* its smooth-view animation starts — the projection hard-cuts and only the pose is smoothed
  ([view3d_navigate_smoothview.cc](https://projects.blender.org/blender/blender/src/branch/main/source/blender/editors/space_view3d/view3d_navigate_smoothview.cc)).
  Fusion's "Perspective with Ortho Faces" switches instantly. SketchUp does not even preserve the zoom
  across the toggle (open feature request). Epic, on Unreal: "the Engine is not able to blend between
  them", and the community answer is a CineCamera **dolly zoom**. → What we are building has no
  prior art to copy; the smooth version is a genuine differentiator, and the risk is ours to manage.
* **The framing-match formula is confirmed by Blender**: its viewport ortho scale is
  `dist · sensor_size / lens` with `sensor_size = 72` — algebraically our `H = 2·d·tan(fov/2)`, keyed
  to the **view distance** (`rv3d->dist`). That is the same focus plane we chose (§3).
* **Blender interpolates `dist` and `lens` linearly** (`interpf`). So "geometric distance" is *not*
  universal practice — but Blender's `lens` almost never changes between two views, which is exactly
  the case where linear and geometric are indistinguishable. Our gate (§3) means we only diverge
  from that behaviour when the perspective actually differs.
* **The one-parameter projection family is real and published**: *Generalized Projection Matrices*,
  [arXiv:2208.09549](https://arxiv.org/abs/2208.09549) — one matrix with a blend parameter plus `d`,
  "the distance for which the two forms of projection have the same FOV". A three.js implementation
  of the same family (`w = 1 + k·z`, constant-size focus plane, `k = 0` = ortho, `k < 0` = reverse
  perspective) exists at [bntre/reverse-perspective-threejs](https://github.com/bntre/reverse-perspective-threejs).
  This is route B in §4 and it is the exact continuous limit of our dolly zoom.
* **The known artefact of naive matrix blending is pacing, not geometry.** Unity users lerping all 16
  elements report "the first half of the lerp doesn't move very much and the last half moves very
  quickly" — the same trap as easing `d` instead of `k`. Also note matrix blending keeps the camera
  *stationary* (no dolly parallax) while a dolly zoom really moves it; we want the dolly.
* **Perceptual support for geometric framing**: van Wijk & Nuij's model (pan is perceived linearly,
  **zoom logarithmically**; D3's `interpolateZoom`) and After Effects' Exponential Scale assistant,
  which exists precisely because a linear scale ramp does not read as a constant zoom. Their
  zoom-out-then-in arc, however, is for large 2D pans — for step-to-step moves it would read as an
  unwanted pull-back, so plain log interpolation, not the vW&N ellipse.
* **Cinematography gives no time-parameterization**: Wikipedia's dolly-zoom article only states the
  static relation. There is no film-side prescription — our choice of `k` is the reasoned one.
* **three.js specifics, read from source**: `Vector3.project/unproject` and
  `Frustum.setFromProjectionMatrix` are camera-agnostic (a common claim that they are perspective-only
  is wrong), but **`Raycaster.setFromCamera` is not** — it branches on camera type and has a long tail
  of orthographic bugs ([#9009](https://github.com/mrdoob/three.js/issues/9009),
  [#14916](https://github.com/mrdoob/three.js/issues/14916)). Another point for keeping one camera type.
  `Spherical.makeSafe()` clamps `phi` away from the poles — the library-level version of our exact-top-view
  problem (§6). The removed `CombinedCamera` matched its ortho frustum at `(near+far)/2`, **not** at the
  orbit target — do not copy that choice.
* **N8AO + orthographic is reported to wash out**: "N8AO reconstructs world positions from the depth
  buffer and with ortho cams that depth is linear… that huge range basically washes out the AO"
  ([thread](https://discourse.threejs.org/t/n8ao-failing-to-render-when-using-orthographiccamera-in-r3f/90885)).
  Our fake-ortho keeps hyperbolic depth, and `_updateClipPlanes` gives `near ≈ (d−r)·0.5`,
  `far ≈ d+1.5r` → a near/far ratio of about **2** even at the ortho end, i.e. *better* precision than
  a close-up. Still: **verify AO quality at the ortho end during the build** — it is the one thing
  measurement, not theory, should settle.
* **Float32 caveat**: three.js uploads `modelViewMatrix` as float32, so a camera at ~290× the scene
  size costs ~9 of 24 bits in the translation column. Survivable, but it is why the ortho floor below
  is set at **0.5° (≈115× the frame height, 0.44% convergence error)** rather than 0.2°; drop to 0.2°
  only if someone scrutinises parallelism, and re-check AO and coplanar faces if so.

## 8. Implementation sketch (phase 1 — transition maths only)

All inside `src/core/scene.js`; no other file changes, no schema change, no UI.

```js
// new, next to _buildOrbitTween
const _K = (fovDeg) => Math.tan(fovDeg * Math.PI / 360);          // k = tan(fov/2)
const _FOV = (k) => 2 * Math.atan(k) * 180 / Math.PI;

// focus distance of a camera state: the pivot projected on the view axis (§3)
function _focusDist(pos, quat, pivot, fallbackR) { … }

// in animateCameraTo(), after fromFov / toFov are known:
const kFrom = _K(fromFov), kTo = _K(toFov);
const persp = Math.abs(kFrom - kTo) > 1e-4;      // ← THE GATE. false = today's code, untouched.
if (persp) {
  const dFrom = _focusDist(fromPos, fromQ, fromPivot, r);
  const dTo   = _focusDist(toPos,   toQ,   toPivot,   r);
  this._transition.dolly = { kFrom, kTo, HFrom: 2 * dFrom * kFrom, HTo: 2 * dTo * kTo };
}

// in _advanceTransition(), AFTER the existing position/quaternion block and
// INSTEAD of the linear fov lerp, when t.dolly exists:
const k = d.kFrom + (d.kTo - d.kFrom) * alpha;
const H = d.HFrom * Math.pow(d.HTo / d.HFrom, alpha);
const dist = H / (2 * k);
const focus = t.fromPivot.clone().lerp(t.toPivot, alpha);   // or the orbit rig's p
const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
this.camera.position.copy(focus).addScaledVector(fwd, -dist);
this.camera.fov = _FOV(k);
this.camera.updateProjectionMatrix();
```

Note the order: the existing code already set the position and orientation for this frame; the dolly
block *overrides the distance only*, sliding the camera along its own view axis so the aim and the
orbit path keep working as they do today. **The pull-out hump must move from the radius to the
framing** when this path is active — `H *= 1 + pull·(1−cos 2πα)/2` instead of `r *= …`
(`scene.js:1248`), otherwise the derived distance simply erases it. Validate with a two-step project where
step B differs only in `fov` (set it from the console: `steps.getActive().camera.fov = 2`).

## 9. Try it

`scratchpad/persp-lab.html` (published artifact "Perspective Transition Lab") — plays the same A→B
move with today's scheme and with the framing-locked scheme, traces the subject's on-screen size,
and has the live Perspective-vs-plain-FOV sliders.
