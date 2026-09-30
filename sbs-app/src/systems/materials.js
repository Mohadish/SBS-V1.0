/**
 * SBS Step Browser — Materials System
 * ======================================
 * Color presets, material creation, override mode, geometry outlines,
 * and selection highlighting.
 *
 * Key concepts:
 *   • overrideMode: when true, color presets replace original materials.
 *     When false, everything reverts to the original import materials.
 *   • meshColorAssignments: { [meshNodeId]: colorPresetId | null }
 *     Each mesh node can be assigned a color preset.
 *   • ColorPreset types:
 *     - 'solid'  → MeshStandardMaterial (color, roughness, metalness)
 *     - 'falloff' → ShaderMaterial (view-dependent edge transparency)
 *   • Screen-door fade: all materials support a `transitionOpacity`
 *     uniform that enables dithered visibility fade during step transitions.
 *   • Geometry outlines: optional EdgesGeometry wireframe overlay per mesh.
 *   • Selection highlight: outline effect on selected mesh objects.
 *
 * Three.js is a global script (window.THREE).
 */

import state from '../core/state.js';
import { createColorPreset, APP_VERSION } from '../core/schema.js';
import { sceneCore } from '../core/scene.js';
import * as clock from '../core/clock.js';
import { ssrPrepassHook } from '../../vendor/three-addons/SSRReflectPass.js';

// ── Selection-highlight edges cache (Fix B, V0.1.70) ──────────────────────
// EdgesGeometry has `.parameters.geometry` back-pointing to its source,
// so stashing it on the source's userData closed a JSON cycle that
// broke project save / delete-assembly snapshots. A module-scoped
// WeakMap keyed by source BufferGeometry sidesteps the cycle AND
// auto-evicts when the source geometry is disposed/GC'd (no manual
// cleanup needed).
const _sbsEdgesGeoCache = new WeakMap();

// 🎬 Production Render look state (V0.3.2.47/48) — module-level so materials
// created at ANY time (preset edits, model loads) inherit the current mode.
// Written only by materials.setProductionLook(). angle stored in RADIANS.
const _prodToneMap = { on: 0, exposure: 1.0, key: 1.0, fill: 1.0, rim: 1.0, angle: 35 * Math.PI / 180,
                       rimWidth: 0.45, contrast: 1.0, saturation: 1.0, envIntensity: 0.5, envBlur: 0.35 };

// V0.2.7: shift a #rrggbb hex by `deg` degrees in HSL space. Used to derive
// the expanded-color YELLOW + MAGENTA hulls from the current selection
// color, so changing the selection palette retunes them automatically
// (cyan #00ffff +240° → yellow, +120° → magenta).
function _hueShiftHex(hex, deg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffd23f';
  const n = parseInt(m[1], 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0)
      : max === g ? (b - r) / d + 2
      :             (r - g) / d + 4;
    h /= 6;
  }
  h = (h + deg / 360) % 1; if (h < 0) h += 1;
  if (s < 0.25) s = 0.6;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let R, G, B;
  if (s === 0) { R = G = B = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    R = hue2rgb(p, q, h + 1 / 3); G = hue2rgb(p, q, h); B = hue2rgb(p, q, h - 1 / 3);
  }
  const hx = v => ('0' + Math.round(v * 255).toString(16)).slice(-2);
  return '#' + hx(R) + hx(G) + hx(B);
}


// ── GLSL snippets ─────────────────────────────────────────────────────────

// Screen-door dither — hash-based, independent of pixel size
const DITHER_NOISE_GLSL = `
float transitionDitherNoise(vec2 p) {
  vec2 cell = floor(p);
  return fract(52.9829189 * fract(dot(cell, vec2(0.06711056, 0.00583715))));
}
`;

// 🖐 V0.3.4.161 — scratch targets, shared by every hand, for a hand's OWN nearest
// depth while it fades (materials._handMaterial). One per viewport size: a frame
// draws the hand into the canvas-sized composer targets AND each planar-mirror /
// thumbnail target, and resizing one target between them would reallocate it several
// times a frame. Float depth, sampled nearest. Only ever allocated once a hand fades.
const _handShellRTs = new Map();
function _handShellTarget(w, h) {
  const key = w + 'x' + h;
  let rt = _handShellRTs.get(key);
  if (rt) return rt;
  if (_handShellRTs.size >= 6) {   // window resizes leave stale sizes behind
    for (const old of _handShellRTs.values()) { try { old.depthTexture?.dispose(); old.dispose(); } catch {} }
    _handShellRTs.clear();
  }
  rt = new THREE.WebGLRenderTarget(w, h);
  const dt = new THREE.DepthTexture(w, h, THREE.FloatType);
  dt.format = THREE.DepthFormat;
  rt.depthTexture = dt;
  _handShellRTs.set(key, rt);
  return rt;
}

// V0.3.4.168 — THE SHADING NORMAL, ORIENTED BY THE GEOMETRY. Both SBS passes used
// faceforward(N, -V, N): flip N wherever dot(N, V) < 0. On a part whose vertex
// normals lean away from its faces (CAD tessellation), that zero crossing is not
// at the silhouette but a LINE across the face — one screen row, moving with the
// camera, the same row on every parallel plate, one side lit with N and the other
// with −N (his horizontal / vertical "environment box" lines; in production the
// rim's curvature gate lit the jump as a white hairline). Now N is flipped only
// when it disagrees with the face's own geometric normal (from the position
// derivatives, turned toward the viewer so winding does not matter) — a decision
// that is constant across the face.
// V0.3.4.169 — and when the stored normal is nearly PERPENDICULAR to the face (this
// model: the stored normals are unusable on every part — a sign test on a dot
// product near zero flipped per pixel → speckle over everything), the face's own
// geometric normal is used instead; a sane stored normal (|dot| ≥ 0.5, every real
// smooth surface) is kept, and the two are blended in between so nothing steps.
const FACING_GLSL = `
vec3 sbsFaceNormal(vec3 N, vec3 V, vec3 viewPos) {
  vec3 Ng = cross(dFdx(viewPos), dFdy(viewPos));
  float gl = length(Ng);
  if (gl < 1e-20) return N;
  Ng /= gl;
  if (dot(Ng, V) < 0.0) Ng = -Ng;
  float a = dot(N, Ng);
  vec3  Ns = a < 0.0 ? -N : N;                       // agree with the face
  float w  = smoothstep(0.2, 0.5, abs(a));           // 0 = stored normal unusable, 1 = trusted
  return normalize(mix(Ng, Ns, w));
}
`;

// Simple view-space Phong lighting helper
const PHONG_GLSL = `
vec3 sbsPhong(vec3 albedo, vec3 N, vec3 V, float roughness, float metalness, float reflectivity) {
  // Key light in view space (warm top-left)
  vec3 L = normalize(vec3(0.38, 0.82, 0.45));
  float diff  = max(dot(N, L), 0.0);
  // Exponential shininess: roughness=0 → 4096 (mirror), roughness=1 → 2 (chalk)
  float shin  = exp2(mix(1.0, 12.0, 1.0 - roughness));
  float spec  = pow(max(dot(reflect(-L, N), V), 0.0), shin);
  // Fill from below (cool bounce)
  vec3  L2    = normalize(vec3(-0.2, -0.5, 0.3));
  float diff2 = max(dot(N, L2), 0.0) * 0.18;

  vec3 ambient  = albedo * 0.24;
  vec3 diffuse  = albedo * (diff * 0.60 + diff2);

  // Fresnel-like F0: dielectric=4% white specular, metal=100% coloured specular
  vec3  specColor = mix(vec3(1.0), albedo, metalness);
  float specF0    = mix(0.04, 1.0, metalness);
  vec3  specular  = specColor * spec * specF0 * reflectivity * 3.0;
  return ambient + diffuse + specular;
}

// ── 🎬 Production light rig (V0.3.2.48) ────────────────────────────────────
// Three-point cinematography, replacing the flat hardcoded view-space light
// when Production Render is ON:
//   KEY  — warm, WORLD-fixed (form/shadow side stays put as the camera moves;
//          azimuth spins with uRigAngle so the rig can be aimed per project)
//   FILL — cool, WORLD-fixed, opposite side, low elevation — lifts shadows
//   RIM  — cool-white, CAMERA-relative backlight: rims only read against the
//          silhouette, so this one is deliberately view-space (cinema practice)
vec3 sbsRigPhong(vec3 albedo, vec3 Nw, vec3 Vw, vec3 Nv, vec3 Vv,
                 float roughness, float metalness, float reflectivity,
                 float keyI, float fillI, float rimI, float angleRad, float rimWidth,
                 vec3 envAmbient) {
  float sa = sin(angleRad), ca = cos(angleRad);
  vec3 Lkey  = normalize(vec3(0.766 * sa, 0.643, 0.766 * ca));                          // elevation 40°
  vec3 Lfill = normalize(vec3(0.966 * sin(angleRad + 2.62), 0.259, 0.966 * cos(angleRad + 2.62))); // el 15°, az +150°
  vec3 warm = vec3(1.0, 0.956, 0.878);
  vec3 cool = vec3(0.845, 0.914, 1.0);
  float dK = max(dot(Nw, Lkey),  0.0);
  float dF = max(dot(Nw, Lfill), 0.0);
  float shin = exp2(mix(1.0, 12.0, 1.0 - roughness));
  float spec = pow(max(dot(reflect(-Lkey, Nw), Vw), 0.0), shin);
  vec3  specColor = mix(vec3(1.0), albedo, metalness);
  float specF0    = mix(0.04, 1.0, metalness);
  // Ambient = the ENVIRONMENT's blurred light from this surface's direction
  // (V0.3.2.51) — so switching HDRIs visibly re-tints the whole object, not
  // just the mirror highlights. envAmbient is sampled in main() from uEnvMap.
  vec3 ambient  = albedo * envAmbient * 0.45;
  vec3 diffuse  = albedo * (warm * (dK * 0.85 * keyI) + cool * (dF * 0.22 * fillI));
  vec3 specular = specColor * spec * specF0 * reflectivity * 3.0 * keyI;
  vec3 Lrim  = normalize(vec3(-0.25, 0.4, -1.0));                 // behind-above, view space
  // RIM WIDTH (user finding #2): exponent controls how far the rim bleeds
  // inward from the silhouette across the curvature. width 0 → exp 5 (a
  // hairline on the most tangent faces), width 1 → exp 0.8 (falls off across
  // the whole curved body).
  float edge = pow(1.0 - clamp(dot(Nv, Vv), 0.0, 1.0), mix(5.0, 0.8, clamp(rimWidth, 0.0, 1.0)));
  // CURVATURE GATE (user finding): on a flat plate every pixel shares one
  // normal, so at grazing angles the WHOLE face passes the edge test and
  // floods white. Rim is a curved-surface effect — gate it by local surface
  // curvature (screen-space normal derivative): flat face → ~0 → no rim;
  // curved silhouette → full rim.
  float curv = clamp(length(fwidth(Nv)) * 18.0, 0.0, 1.0);
  vec3 rim   = cool * (max(dot(Nv, Lrim), 0.0) * edge * curv * 1.2 * rimI);
  return ambient + diffuse + specular + rim;
}
`;

// ─── Vertex shader (shared by all SBS shader materials) ──────────────────
const SBS_VERT = `
varying vec3 vViewPos;
varying vec3 vNormalView;
void main() {
  vNormalView = normalize(normalMatrix * normal);
  vec4 mvPos  = modelViewMatrix * vec4(position, 1.0);
  vViewPos    = mvPos.xyz;
  gl_Position = projectionMatrix * mvPos;
}`;

// ─── Unified front-face fragment shader ──────────────────────────────────
//
//  solidness  1.0  → alpha = 1.0 everywhere   (fully solid)
//  solidness  0.0  → alpha = falloff curve     (X-ray: edges opaque, centre transparent)
//  solidness  0–1  → smooth interpolation between the two curves
//
//  The falloff power is fixed at 2.5 — a soft, natural rim effect.
//  The opacity curve: falloff = pow(1 - dotNV, 2.5)
//    dotNV=1 (face-on) → falloff=0  → low opacity at centre
//    dotNV=0 (edge-on) → falloff=1  → high opacity at silhouette
//
const SBS_FRONT_FRAG = `
precision highp float;
varying vec3  vViewPos;
varying vec3  vNormalView;
uniform vec3  uColor;
uniform float uSolidness;            // 1=solid, 0=full X-ray
uniform float uMetalness;
uniform float uRoughness;
uniform float uReflectionIntensity;  // 0=matte, 1=shiny (0.5=neutral default)
uniform sampler2D uEnvMap;           // the PMREM (V0.3.4.167) — sampled through three's textureCubeUV below
uniform float uToneMapOn;            // 🎬 Production Render (V0.3.2.47): 1 = ACES filmic
uniform float uExposure;             //     linear-space exposure — applied only when on
uniform float uRigKey;               // 🎬 rig intensities (V0.3.2.48) — key / fill / rim
uniform float uRigFill;
uniform float uRigRim;
uniform float uRigAngle;             //     rig azimuth, radians (spins key+fill around world Y)
uniform float uRimWidth;             // 🎬 rim falloff spread: 0 = silhouette hairline, 1 = across the curvature
uniform float uContrast;             // 🎬 filmic grade (V0.3.2.50) — post-ACES contrast around mid-gray
uniform float uSaturation;           //     and color saturation (1 = neutral for both)
uniform float uEnvIntensity;         // 🎬 HDRI strength (V0.3.2.52) — scales reflections + ambience
uniform float uEnvBlur;              //     global env blur: 0 = sharp reflections, 1 = fully diffuse
// ACES filmic fit (Narkowicz 2015) — cinematic contrast + soft highlight
// rolloff. Runs in LINEAR space, before the gamma below. The SBS unified
// shader is a raw ShaderMaterial, so renderer.toneMapping never touches it —
// production tone mapping must live here, as uniforms (live, no recompile).
vec3 sbsACES(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43;
  const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
// viewMatrix is injected automatically by Three.js — do NOT redeclare it here
uniform float transitionOpacity;     // 0=invisible, 1=visible (dither fade)
${DITHER_NOISE_GLSL}
${FACING_GLSL}
${PHONG_GLSL}
// V0.3.4.167 — THE ENVIRONMENT IS THE PMREM. Until now this shader took a
// samplerCube: first six unrelated canvas gradients (a box with hard edges),
// then a cube of the HDRI without mipmaps (roughness ignored — every material a
// mirror of the studio's softbox edges), then with hardware mipmaps (a box
// filter — a coarse level shows its texel grid, so a blurred edge became a
// staircase). The PMREM is the GGX-prefiltered environment three builds for its
// own materials — smooth at every roughness. Its 2D CubeUV packing is read with
// three's own helper; the CUBEUV_* defines come from material.envMap (set on the
// ShaderMaterial for exactly that), so this chunk is empty until an env exists.
#include <cube_uv_reflection_fragment>
vec3 sbsEnv(vec3 dir, float rough) {
#ifdef ENVMAP_TYPE_CUBE_UV
  return textureCubeUV(uEnvMap, dir, clamp(rough, 0.0, 1.0)).rgb;
#else
  return vec3(0.0);
#endif
}
void main() {
  vec3  V   = normalize(-vViewPos);
  vec3  N   = sbsFaceNormal(normalize(vNormalView), V, vViewPos);   // V0.3.4.168 (was faceforward)
  float dotNV = clamp(dot(N, V), 0.0, 1.0);

  // ── Opacity: smooth curve blend ─────────────────────────────────────
  float fall  = pow(1.0 - dotNV, 2.5);
  float alpha = mix(fall, 1.0, uSolidness);

  // ── Phong lighting (in view space) ───────────────────────────────────
  vec3 albedo   = pow(uColor, vec3(2.2));               // sRGB → linear
  vec3 litColor = sbsPhong(albedo, N, V, uRoughness, uMetalness, uReflectionIntensity);

  // ── 🎬 Production light rig (world-fixed key/fill + view-space rim) ───
  // transpose(mat3(viewMatrix)) = camera→world rotation (viewMatrix is world→camera,
  // and for cameras the 3×3 block is orthogonal so transpose = inverse).
  mat3 v2w = transpose(mat3(viewMatrix));
  vec3 Nw  = normalize(v2w * N);
  vec3 Vw  = normalize(v2w * V);
  vec3 envAmb   = sbsEnv(Nw, 1.0) * uEnvIntensity;   // fully rough = irradiance-ish (what three's IBL does too)
  vec3 rigColor = sbsRigPhong(albedo, Nw, Vw, N, V,
                              uRoughness, uMetalness, uReflectionIntensity,
                              uRigKey, uRigFill, uRigRim, uRigAngle, uRimWidth,
                              envAmb);
  litColor = mix(litColor, rigColor, uToneMapOn);   // one switch = the whole production look

  // ── Environment map reflection (world space) ──────────────────────────
  vec3  R_w    = reflect(-Vw, Nw);
  // The production env-blur slider: a live roughness offset on the prefiltered
  // environment — 0 = the material's own roughness, 1 = roughness 0.6 (never
  // 1.0: that integrates the whole hemisphere and a flat plate goes FLAT — his
  // "no gradient at all" after .167; 0.6 keeps a broad, directional sweep like
  // the old 12-px downsample did). Production only; the preview keeps the
  // material roughness.
  float envRough = mix(uRoughness, mix(uRoughness, max(uRoughness, 0.6), clamp(uEnvBlur, 0.0, 1.0)), uToneMapOn);
  vec3  envRGB = sbsEnv(R_w, envRough) * uEnvIntensity;
  vec3  envF0  = mix(vec3(0.04), albedo, uMetalness);   // Fresnel F0
  litColor    += envRGB * envF0 * uReflectionIntensity * 2.0;

  // ── 🎬 Production tone mapping (gated — preview path untouched) ───────
  litColor = mix(litColor, sbsACES(litColor * uExposure), uToneMapOn);

  // ── Gamma correction ─────────────────────────────────────────────────
  litColor = pow(max(litColor, vec3(0.0)), vec3(1.0 / 2.2));

  // ── 🎬 Filmic grade (production only, V0.3.2.50) ──────────────────────
  // The visible personality of the filmic look: saturation (luma-preserving)
  // + contrast pivoted on mid-gray, applied display-space after the curve.
  float lumG   = dot(litColor, vec3(0.2126, 0.7152, 0.0722));
  vec3  graded = mix(vec3(lumG), litColor, uSaturation);
  graded       = clamp(mix(vec3(0.5), graded, uContrast), 0.0, 1.0);
  litColor     = mix(litColor, graded, uToneMapOn);

  // ── Dither fade (step transitions) ───────────────────────────────────
  float fade = clamp(transitionOpacity, 0.0, 1.0);
  if (fade <= transitionDitherNoise(gl_FragCoord.xy)) discard;

  gl_FragColor = vec4(litColor, alpha);
}`;

// ─── Back-face fragment shader (optional second pass) ────────────────────
//  Renders the inside surface with a separate colour and edge darkening.
//  Only active when preset.backFaceEnabled = true.
//
const SBS_BACK_FRAG = `
precision highp float;
varying vec3  vViewPos;
varying vec3  vNormalView;
uniform vec3  uBackColor;
uniform float uBackAlpha;
uniform float uBackEdgeDarken;
uniform float transitionOpacity;
uniform float uToneMapOn;            // 🎬 Production Render — keeps the inner shell
uniform float uExposure;             //     consistent with the tone-mapped front
vec3 sbsACES(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43;
  const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
${DITHER_NOISE_GLSL}
${FACING_GLSL}
void main() {
  vec3  V   = normalize(-vViewPos);
  vec3  N   = sbsFaceNormal(normalize(vNormalView), V, vViewPos);   // V0.3.4.168 (was faceforward)
  float dotNV  = clamp(dot(N, V), 0.0, 1.0);
  float fall   = pow(1.0 - dotNV, 2.5);   // fixed falloff power matches front shader
  float darken = mix(1.0, 1.0 - uBackEdgeDarken, fall);
  float alpha  = clamp(uBackAlpha, 0.0, 1.0);
  float fade   = clamp(transitionOpacity, 0.0, 1.0);
  if (fade <= transitionDitherNoise(gl_FragCoord.xy)) discard;
  // 🎬 Production tone mapping — the flat back tint is authored in sRGB, so
  // linearize → ACES → re-gamma (gated; preview path byte-identical).
  vec3 backC = uBackColor * darken;
  vec3 linC  = pow(max(backC, vec3(0.0)), vec3(2.2));
  linC       = mix(linC, sbsACES(linC * uExposure), uToneMapOn);
  backC      = pow(linC, vec3(1.0 / 2.2));
  gl_FragColor = vec4(backC, alpha);
}`;


// ─── Back-pass outline vertex shader ─────────────────────────────────────────
const BACK_OUTLINE_VERT = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// ─── Back-pass outline fragment shader (screen-door dither) ──────────────────
//
//  Renders back/hidden edges without any alpha blending — uses per-pixel
//  discard so depth sorting never matters. Results look identical to an
//  opaque line at the given coverage level.
//
//  uDitherOpacity = 0.0 → every pixel discarded   (fully invisible)
//  uDitherOpacity = 1.0 → every pixel drawn        (fully visible)
//  in-between           → dithered fraction drawn  (smooth apparent fade)
//
const BACK_OUTLINE_FRAG = `
precision highp float;
uniform vec3  uLineColor;
uniform float uDitherOpacity;
float backOutlineDitherNoise(vec2 p) {
  vec2 cell = floor(p);
  return fract(52.9829189 * fract(dot(cell, vec2(0.06711056, 0.00583715))));
}
void main() {
  if (uDitherOpacity <= backOutlineDitherNoise(gl_FragCoord.xy)) discard;
  gl_FragColor = vec4(uLineColor, 1.0);
}`;


// ─── Smart outline shaders (face-normal based front/back classification) ─────
//
//  Each edge carries the average normal of its two adjacent faces (aNormal).
//  In the vertex shader we project this to view space — the z-component tells
//  us whether the edge faces toward (+) or away from (-) the camera.
//  The two fragment shaders split on that sign so there is no depth-write
//  dependency and therefore no threshold jump.
//
const SMART_OUTLINE_VERT = `
attribute vec3 aNormal;
varying   float vFacing;
void main() {
  vFacing     = normalize(normalMatrix * aNormal).z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Front-pass: only edges whose face normal faces the camera
const SMART_FRONT_FRAG = `
precision highp float;
uniform vec3  uColor;
uniform float uOpacity;
varying float vFacing;
void main() {
  if (vFacing < 0.0) discard;
  gl_FragColor = vec4(uColor, uOpacity);
}`;

// Back-pass: only edges whose face normal faces away from the camera
const SMART_BACK_FRAG = `
precision highp float;
uniform vec3  uColor;
uniform float uOpacity;
varying float vFacing;
void main() {
  if (vFacing >= 0.0) discard;
  gl_FragColor = vec4(uColor, uOpacity);
}`;


// ═══════════════════════════════════════════════════════════════════════════
//  MATERIALS SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
class MaterialsSystem {
  constructor() {
    // nodeId (mesh) → THREE.Mesh
    this.meshById              = new Map();

    // nodeId (mesh) → original THREE.Material (from import)
    this.originalMaterials     = new Map();

    // nodeId (mesh) → colorPresetId  (current effective — can be per-step)
    this.meshColorAssignments  = {};

    // nodeId (mesh) → colorPresetId  (permanent base layer — set at import or
    // via "Set as Default". Steps deviate from this; "Revert to Default" returns here.)
    this.meshDefaultColors     = {};

    // PMREM-processed HDR environment map (set after renderer is available)
    this._pmremEnvMap          = null;

    // Geometry outline meshes: nodeId → THREE.LineSegments (front-pass, depthTest on)
    this._outlineMeshes        = new Map();

    // Back-pass outline meshes: nodeId → THREE.LineSegments (depthTest off, opacity by solidness)
    this._outlineBackMeshes    = new Map();

    // Selection outline color
    this._selectionColor       = '#00ffff';

    // Selected nodeIds (mesh level) — set externally
    this._selectedMeshIds      = new Set();
    this._previewMeshIds       = new Set();   // ray-select candidate preview channel (V0.1.90)
    this._shapeTabHighlightIds = new Set();   // V0.2.1: shape-tab driven highlight
    this._shapeGhostById       = new Map();   // V0.2.1: id → ghost LineSegments (for hidden flatShape instances)
    this._expColorHighlightIds = new Set();   // V0.2.6: expanded-color → selected-mesh highlight
    this._expColorGhostById    = new Map();   // V0.2.6: id → magenta ghost (for hidden meshes that use the expanded color)

    // Active colour transition (set by beginColorTransition, cleared when done)
    this._colorTransition      = null;

    // Active visibility fade transitions: nodeId → { from, to, startMs, durationMs, easeFn, hide }
    this._visTransitions       = new Map();
    // Showing meshes that have been snap-zero'd ahead of their fade phase.
    // applyAll's reapply block honours this set so a color transition's
    // final applyAll doesn't pop them to opacity 1 between phases.
    this._pendingShowingHidden = new Set();
  }

  // ─── Setup ───────────────────────────────────────────────────────────────
  init() {
    // Subscribe to selection changes
    state.on('selection:change', ({ multi }) => {
      this._selectedMeshIds = multi ?? new Set();
      this.applySelectionHighlight();
    });

    // Build PMREM env map as soon as the Three.js renderer is available.
    // sceneCore emits 'init' after the WebGLRenderer is created.
    sceneCore.on('init', () => this._initPmremEnvMap());
    // V0.3.4.164 — that event had ALREADY fired: main.js boots the scene (step 2)
    // before materials.init() (step 3), so the studio never built at start-up —
    // scene.environment stayed empty and the SBS shader kept the six-canvas box
    // (why .163 changed nothing on screen). Build it now if the renderer is up.
    if (sceneCore.renderer) this._initPmremEnvMap();

    // V0.3.4.165 — console: sbsEnvDiag() → which environment the shader samples right now.
    if (typeof window !== 'undefined') window.sbsEnvDiag = () => {
      const env = this.metalEnvMap;
      const which = !env ? 'none' : this._pmremForHdri ? 'HDRI PMREM (' + this._pmremForHdri + ')' : 'studio PMREM';
      let sampled = 0, current = 0, stale = 0, standard = 0;
      for (const [, mesh] of this.meshById) {
        const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of ms) {
          const t = m?.uniforms?.uEnvMap?.value ?? m?.envMap;
          if (!t) continue;
          sampled++;
          if (t === env) current++; else stale++;
          if (m?.isMeshStandardMaterial) standard++;
        }
      }
      const out = { version: APP_VERSION, envNow: which, envSize: env ? `${env.image?.width}x${env.image?.height}` : null,
        hdriActive: this._activeHdri || null, envBlur: _prodToneMap.envBlur, productionOn: !!_prodToneMap.on,
        materials: { total: sampled, current, stale, textured: standard } };
      console.log('[sbsEnvDiag]', JSON.stringify(out));
      return out;
    };

    // V0.3.4.168 — console: sbsNormalDiag() → how far each part's vertex normals lean
    // from its faces (selected parts, or all with sbsNormalDiag(true)). meanDeg / maxDeg
    // = angle between a triangle's geometric normal (from its winding) and its vertex
    // normals; tiltedPct = triangles over 30°, flippedPct = over 90° (pointing into the
    // part). A healthy CAD mesh reads a few degrees; a plate that draws a moving line
    // across itself reads tens of degrees or flips.
    if (typeof window !== 'undefined') window.sbsNormalDiag = (all = false) => {
      const ids = (all || !this._selectedMeshIds?.size) ? [...this.meshById.keys()] : [...this._selectedMeshIds];
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      const ng = new THREE.Vector3(), nv = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
      const rows = [];
      for (const id of ids) {
        const mesh = this.meshById.get(id);
        const g = mesh?.geometry;
        if (!g?.attributes?.position) continue;
        const pos = g.attributes.position, nor = g.attributes.normal, idx = g.index;
        if (!nor) { rows.push({ id, name: mesh.name || '', normals: 'NONE' }); continue; }
        const tris = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
        const step = Math.max(1, Math.floor(tris / 4000));
        let n = 0, tilted = 0, flipped = 0, sum = 0, max = 0;
        for (let t = 0; t < tris; t += step) {
          const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
          a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
          ng.subVectors(b, a).cross(t2.subVectors(c, a));
          if (ng.lengthSq() < 1e-24) continue;
          ng.normalize();
          nv.fromBufferAttribute(nor, i0).add(t1.fromBufferAttribute(nor, i1)).add(t2.fromBufferAttribute(nor, i2));
          if (nv.lengthSq() < 1e-12) continue;
          nv.normalize();
          const ang = Math.acos(Math.max(-1, Math.min(1, ng.dot(nv)))) * 180 / Math.PI;
          n++; sum += ang; if (ang > max) max = ang; if (ang > 30) tilted++; if (ang > 90) flipped++;
        }
        if (!n) continue;
        rows.push({ id, name: mesh.name || '', tris, meanDeg: +(sum / n).toFixed(1), maxDeg: +max.toFixed(1),
          tiltedPct: +(100 * tilted / n).toFixed(1), flippedPct: +(100 * flipped / n).toFixed(1),
          mirrored: mesh.matrixWorld.determinant() < 0 });
      }
      rows.sort((x, y) => (y.tiltedPct ?? 0) - (x.tiltedPct ?? 0));
      console.table(rows.slice(0, 40));
      // …and where the geometry came from (V0.3.4.170), so the source file can be tested outside the app.
      const assets = (state.get('assets') || []).map(a => ({ id: a.id, name: a.name, type: a.type, path: a.resolvedPath || a.originalPath || a.path || '' }));
      console.log('[sbsNormalDiag] sources:', JSON.stringify(assets));
      return rows;
    };
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  PRESET DEFAULTS
  // ═══════════════════════════════════════════════════════════════════════
  ensurePresetDefaults(p) {
    if (!p) return;
    // Handle old-format presets (type/opacity) coming from legacy projects
    if (p.solidness === undefined) {
      if (p.type === 'falloff' || p.falloff) {
        p.solidness = 0.0;
      } else {
        p.solidness = typeof p.opacity === 'number' ? p.opacity : 1.0;
      }
    }
    // Migrate old reflectionIntensity / envMapIntensity / falloffStrength
    if (p.reflectionIntensity === undefined) {
      if (typeof p.envMapIntensity === 'number') {
        p.reflectionIntensity = Math.min(1, Math.max(0, p.envMapIntensity * 50));
      } else {
        p.reflectionIntensity = 0.5;
      }
    }
    if (typeof p.metalness !== 'number')          p.metalness          = 0.05;
    if (typeof p.roughness !== 'number')          p.roughness          = 0.45;
    if (!p.color)                                 p.color              = '#4a90d9';
    if (p.outlineEnabled === undefined)           p.outlineEnabled     = null;
    if (p.ssrReflective === undefined)            p.ssrReflective      = false;
    if (p.flatMirror === undefined)               p.flatMirror         = false;
    if (!p.backFaceColor)                         p.backFaceColor      = '#ffffff';
    if (typeof p.backFaceOpacity !== 'number')    p.backFaceOpacity    = 0.35;
    if (typeof p.backFaceEdgeDarken !== 'number') p.backFaceEdgeDarken = 0.45;
  }

  /**
   * Returns true when solidness is high enough that the material should be
   * treated as opaque (depthWrite on, no transparency sorting needed).
   */
  _isOpaque(preset) {
    return (preset.solidness ?? 1.0) >= 0.999;
  }

  /**
   * Returns true when the original material carries texture maps that we
   * should preserve (and therefore must use MeshStandardMaterial for).
   */
  _hasTextureMaps(originalMaterial, preset) {
    if (preset?.removeTextures) return false;
    const orig = Array.isArray(originalMaterial)
      ? (originalMaterial.find(m => m?.isMeshStandardMaterial) ?? originalMaterial[0])
      : originalMaterial;
    if (!orig) return false;
    return !!(
      orig.map        || orig.normalMap    || orig.roughnessMap ||
      orig.metalnessMap || orig.aoMap      || orig.emissiveMap  ||
      orig.alphaMap   || orig.bumpMap      || orig.displacementMap
    );
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  ENVIRONMENT MAP
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * V0.3.4.172 — "Smooth gradient" environment (his ask: "a sphere that is
   * completely unified in its transition — no sharp lines"). A pure function of
   * direction, continuous everywhere: bright above the horizon, dark below, one
   * BROAD soft key lobe (pow 3, not a hotspot), a hint of cool above / warm below.
   * On a flat plate it reads as a smooth sweep even at roughness 0 — nothing in it
   * can draw an edge. Linear HDR, fed through the same PMREM as the HDRIs.
   */
  _gradientEquirect(W = 256, H = 128) {
    const data = new Float32Array(W * H * 4);
    const kx = 0.38, ky = 0.82, kz = 0.45, kl = Math.hypot(kx, ky, kz);
    const sstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const phi   = (x / W) * Math.PI * 2;
        const theta = (1 - y / H) * Math.PI - Math.PI / 2;
        const dx = Math.cos(theta) * Math.cos(phi), dy = Math.sin(theta), dz = Math.cos(theta) * Math.sin(phi);
        // vertical sweep, steepest AROUND THE HORIZON (a face-on plate reflects
        // the band ±15° about it, so that is where the change must live):
        // 0.12 well below → 1.3 well above, plus a gentle continuation to the poles.
        const up = sstep(0, 1, dy), down = sstep(0, 1, -dy);
        let v = 0.12 + 1.18 * sstep(-0.4, 0.4, dy) + up * 0.25 - down * 0.05;
        // one broad, soft key lobe
        const kd = Math.max(0, (dx * kx + dy * ky + dz * kz) / kl);
        v += Math.pow(kd, 3) * 1.5;
        // tint: a touch cool above, warm below
        const r = v * (1 - up * 0.06 + down * 0.08), g = v, b = v * (1 + up * 0.10 - down * 0.10);
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
      }
    }
    return { data, W, H };
  }

  /** PMREM from a float RGBA equirect (shared by the studio, the gradient and the HDRIs). */
  _pmremFromEquirect(renderer, data, W, H) {
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(tex);
    pmrem.dispose();
    tex.dispose();
    return rt.texture;
  }

  /**
   * The environment every SBS material samples: the PMREM (V0.3.4.167) — the
   * HDRI's while Production has one, else the procedural studio's. One texture
   * for the SBS shader (uEnvMap + material.envMap, read with textureCubeUV) and
   * for scene.environment (textured MeshStandardMaterial parts). null only before
   * the renderer exists (the shader then samples nothing; applyAll rebinds).
   *   History: a six-canvas cube (a box with hard edges), then a cube of the HDRI
   * without mipmaps (roughness ignored), then with hardware mipmaps (box filter →
   * staircases). The PMREM is what three's own materials use; it is prefiltered
   * per roughness and seamless.
   */
  get metalEnvMap() {
    return this._pmremEnvMap ?? null;
  }

  /**
   * Build a proper PMREM-processed HDR environment map from a procedural
   * equirectangular DataTexture. Requires the WebGLRenderer (available after
   * sceneCore.init()). Re-applies all materials once ready.
   */
  _initPmremEnvMap() {
    const renderer = sceneCore.renderer;
    if (!renderer || this._pmremEnvMap) return;

    // ── Build a 256×128 float32 equirectangular HDR map ──────────────────
    const W = 256, H = 128;
    const data = new Float32Array(W * H * 4);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i   = (y * W + x) * 4;
        const phi   = (x / W) * Math.PI * 2;          // 0 … 2π (longitude)
        const theta = (1 - y / H) * Math.PI - Math.PI / 2; // π/2 … -π/2 (latitude)

        const dx = Math.cos(theta) * Math.cos(phi);
        const dy = Math.sin(theta);
        const dz = Math.cos(theta) * Math.sin(phi);

        // Base: very dark ambient
        let r = 0.025, g = 0.03, b = 0.04;

        // Upper hemisphere: blue-white sky gradient
        if (dy > 0) { r += dy * 0.30; g += dy * 0.38; b += dy * 0.55; }
        // Lower hemisphere: warm ground
        if (dy < 0) { const f = -dy; r += f*0.08; g += f*0.06; b += f*0.04; }

        // Key light — bright warm-white (top-front-left, matches Phong L direction)
        const kd  = Math.max(0, dx*0.38 + dy*0.82 + dz*0.45);
        const ks  = Math.pow(kd, 14);   // tight hotspot
        const km  = Math.pow(kd,  3);   // softer halo
        r += ks * 8.0 + km * 0.5;
        g += ks * 7.6 + km * 0.48;
        b += ks * 7.0 + km * 0.43;

        // Fill light — cool blue-white (top-right)
        const fd  = Math.max(0, dx * -0.55 + dy * 0.60 + dz * -0.58);
        const fs  = Math.pow(fd, 8);
        r += fs * 1.0; g += fs * 1.3; b += fs * 2.2;

        // Rim light — warm accent from behind
        const rd  = Math.max(0, dz * -0.95 + dy * 0.1);
        r += Math.pow(rd, 5) * 0.9;
        g += Math.pow(rd, 5) * 0.7;
        b += Math.pow(rd, 5) * 0.5;

        data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 1.0;
      }
    }

    const eqTex = new THREE.DataTexture(
      data, W, H, THREE.RGBAFormat, THREE.FloatType,
    );
    eqTex.mapping = THREE.EquirectangularReflectionMapping;
    eqTex.needsUpdate = true;

    // ── Process through PMREMGenerator for roughness-filtered mips ────────
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(eqTex);
    pmrem.dispose();
    eqTex.dispose();

    this._pmremEnvMap = rt.texture;
    this._pmremForHdri = null;         // the studio, not an HDRI

    // Apply to scene so MeshStandardMaterial meshes also benefit
    if (sceneCore.scene) sceneCore.scene.environment = this._pmremEnvMap;

    // Rebuild all materials so uEnvMap is the PMREM version
    this.applyAll();
  }

  /**
   * 🎬 Production HDRI environment (V0.3.2.49). Swaps the environment to a real
   * .hdr from assets/hdri/ (Poly Haven, CC0) — the same PMREM pipeline as the
   * procedural studio, so it feeds uEnvMap (SBS shader) AND scene.environment
   * (textured materials) identically. Active ONLY while Production Render is on;
   * turning it off (or picking "Built-in studio") rebuilds the procedural map.
   *   V0.3.4.167: the env-blur slider no longer rebuilds anything — it is the
   * uEnvBlur uniform (setProductionLook), a live roughness offset on the PMREM.
   * The CPU downsample + cube of .55 are gone (see metalEnvMap).
   */
  async applyProductionEnvironment(prod) {
    const want = (prod?.enabled && prod?.hdri) ? String(prod.hdri) : null;
    if (want === (this._activeHdri ?? null) && (want ? this._pmremForHdri === want : !this._pmremForHdri)) return;
    // V0.3.4.181 — one load per HDRI at a time: every render-settings write re-entered
    // this while the file was still decoding (a second decode + PMREM of the same file).
    if (this._hdriLoading?.name === want) return this._hdriLoading.promise;

    const renderer = sceneCore.renderer;
    if (!renderer) return;
    this._activeHdri = want;
    const run = this._applyProductionEnvironmentNow(prod, want, renderer);
    this._hdriLoading = { name: want, promise: run };
    try { await run; } finally { if (this._hdriLoading?.promise === run) this._hdriLoading = null; }
  }

  /** V0.3.4.181 — every live material that still points at an old environment texture follows the swap. */
  _rebindEnvironment(oldTex) {
    const env = this._pmremEnvMap ?? null;
    const fix = (m) => {
      if (!m || !m.isMaterial) return;
      if (m.isShaderMaterial) return;                       // SBS materials rebind through applyAll (uEnvMap + .envMap)
      if (m.envMap && (m.envMap === oldTex || m.envMap !== env)) { m.envMap = null; m.needsUpdate = true; }   // scene.environment is the live one
    };
    try { sceneCore.scene?.traverse(o => { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) fix(m); }); } catch {}
    try { for (const [, m] of this.originalMaterials) (Array.isArray(m) ? m : [m]).forEach(fix); } catch {}
  }

  async _applyProductionEnvironmentNow(prod, want, renderer) {

    if (!want) {                       // back to the built-in procedural studio
      this._hdriEquirect = null;
      const oldStudio = this._pmremEnvMap;
      this._pmremEnvMap = null;
      this._initPmremEnvMap();         // rebuilds scene.environment + applyAll()
      this._rebindEnvironment(oldStudio);
      oldStudio?.dispose?.();
      return;
    }
    if (want === 'gradient') {         // V0.3.4.172 — the built-in smooth gradient (no file)
      try {
        const { data, W, H } = this._gradientEquirect();
        const old = this._pmremEnvMap;
        this._pmremEnvMap = this._pmremFromEquirect(renderer, data, W, H);
        this._pmremForHdri = want;
        if (sceneCore.scene) sceneCore.scene.environment = this._pmremEnvMap;
        this.applyAll();
        this._rebindEnvironment(old);
        old?.dispose?.();
        console.log('[materials] 🎬 smooth gradient environment → PMREM');
      } catch (e) {
        console.warn('[materials] gradient environment failed:', e?.message);
        this._activeHdri = null;
      }
      return;
    }

    // READ + DECODE the file only when the HDRI itself changed.
    if (this._hdriEquirect?.name !== want) {
      try {
        const { decodeRGBE } = await import('../../vendor/rgbe-decode.mjs');
        const url = new URL('../../assets/hdri/' + want + '.hdr', import.meta.url);
        let p = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);          // windows file:// → drive path
        const r = await window.sbsNative.readFile(p, 'buffer');
        if (!r?.ok) throw new Error(r?.error || 'read failed: ' + p);
        const img = decodeRGBE(r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data));
        if (this._activeHdri !== want) return;               // selection changed mid-load
        this._hdriEquirect = { name: want, data: img.data, w: img.width, h: img.height };
      } catch (e) {
        console.warn('[materials] HDRI load failed — keeping current environment:', e?.message);
        this._activeHdri = null;
        return;
      }
    }

    try {
      const src = this._hdriEquirect;
      const fullTex = new THREE.DataTexture(src.data, src.w, src.h, THREE.RGBAFormat, THREE.FloatType);
      fullTex.mapping = THREE.EquirectangularReflectionMapping;
      fullTex.needsUpdate = true;
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const rt = pmrem.fromEquirectangular(fullTex);
      pmrem.dispose();
      fullTex.dispose();
      const old = this._pmremEnvMap;
      this._pmremEnvMap = rt.texture;
      this._pmremForHdri = want;
      if (sceneCore.scene) sceneCore.scene.environment = this._pmremEnvMap;
      this.applyAll();                 // rebind uEnvMap everywhere
      this._rebindEnvironment(old);
      old?.dispose?.();
      console.log(`[materials] 🎬 HDRI "${want}" → PMREM`);
    } catch (e) {
      console.warn('[materials] HDRI PMREM build failed:', e?.message);
      this._activeHdri = null;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  MATERIAL CREATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create the right material for a preset.
   *
   * Texture path (original material has maps AND removeTextures is false):
   *   → MeshStandardMaterial — preserves albedo/normal/roughness/etc. maps.
   *     Solidness is implemented as opacity on this path (smooth 0–1).
   *
   * All other presets:
   *   → SBS unified ShaderMaterial — always used regardless of solidness.
   *     Solidness smoothly interpolates the opacity curve from X-ray (0) to
   *     fully solid (1) via the fragment shader. No hard switch at any value.
   */
  makeMaterial(preset, originalMaterial = null) {
    this.ensurePresetDefaults(preset);
    const mat = this._hasTextureMaps(originalMaterial, preset)
      ? this.makeSolidMaterial(preset, originalMaterial)
      : this.makeFalloffFrontMaterial(preset);
    // Stamp the per-material SSR reflective flag so the SSR prepass can read it.
    if (mat) { mat.userData = mat.userData || {}; mat.userData.ssrReflective = !!preset.ssrReflective; }
    return mat;
  }

  /**
   * MeshStandardMaterial for texture-mapped presets only.
   * Used when the original material has texture maps that need to be preserved.
   *
   * Texture-aware tinting:
   *   All texture maps are carried through into the new material.
   *   The preset color acts as a multiplicative tint over the albedo map —
   *   white (#ffffff) = no visual change, any other color = tint.
   *
   * Solidness on this path:
   *   Implemented as opacity (0=invisible, 1=fully opaque). This is a simpler
   *   approximation than the shader X-ray curve, but keeps textures intact.
   */
  makeSolidMaterial(preset, originalMaterial = null) {
    this.ensurePresetDefaults(preset);

    // Resolve a single material from a possible multi-material array
    const orig = Array.isArray(originalMaterial)
      ? (originalMaterial.find(m => m?.isMeshStandardMaterial) ?? originalMaterial[0])
      : originalMaterial;

    // When the mesh has texture maps, honour the original roughness/metalness
    // scalars (the map texels are multiplied by them and the artist set them intentionally).
    const roughness = Number.isFinite(orig?.roughness) ? orig.roughness : (preset.roughness ?? 0.45);
    const metalness = Number.isFinite(orig?.metalness) ? orig.metalness : (preset.metalness ?? 0.05);

    // Solidness drives opacity on the texture path (smooth 0–1 range)
    const solidness = preset.solidness ?? 1.0;
    const isOpaque  = solidness >= 0.999;

    // reflectionIntensity (0–1) maps to envMapIntensity (0–0.5 range); the production
    // Environment-strength slider scales it from that base (setProductionLook, V0.3.4.181)
    const envBase = (preset.reflectionIntensity ?? 0.5) * 0.5;
    const envMapIntensity = envBase * (_prodToneMap.envIntensity / 0.5);

    const mat = new THREE.MeshStandardMaterial({
      color:           preset.color ?? '#ffffff',
      roughness,
      metalness,
      envMap:          this.metalEnvMap,
      envMapIntensity,
      transparent:     !isOpaque || (orig?.transparent ?? false),
      opacity:         isOpaque ? (Number.isFinite(orig?.opacity) ? orig.opacity : 1) : solidness,
      depthWrite:      true,
      side:            orig?.side ?? THREE.FrontSide,
      // Solid-enough textured meshes write stencil so back outlines respect them
      stencilWrite:    solidness >= 0.9,
      stencilRef:      1,
      stencilZPass:    THREE.ReplaceStencilOp,
    });
    mat.userData.envBase = envBase;   // V0.3.4.181 — see setProductionLook

    // ── Carry through texture maps ────────────────────────────────────────
    // This function is only called when orig has maps (gated by _hasTextureMaps).
    if (orig) {
      if (orig.map)             mat.map              = orig.map;
      if (orig.normalMap)     { mat.normalMap         = orig.normalMap;
                                mat.normalScale       = orig.normalScale?.clone?.()
                                                        ?? new THREE.Vector2(1, 1); }
      if (orig.roughnessMap)    mat.roughnessMap      = orig.roughnessMap;
      if (orig.metalnessMap)    mat.metalnessMap      = orig.metalnessMap;
      if (orig.aoMap)         { mat.aoMap             = orig.aoMap;
                                mat.aoMapIntensity    = orig.aoMapIntensity ?? 1; }
      if (orig.emissiveMap)   { mat.emissiveMap       = orig.emissiveMap;
                                mat.emissive          = orig.emissive?.clone?.()
                                                        ?? new THREE.Color(0);
                                mat.emissiveIntensity = orig.emissiveIntensity ?? 1; }
      if (orig.alphaMap)        mat.alphaMap          = orig.alphaMap;
      if (orig.bumpMap)       { mat.bumpMap           = orig.bumpMap;
                                mat.bumpScale         = orig.bumpScale ?? 1; }
      if (orig.displacementMap){ mat.displacementMap  = orig.displacementMap;
                                 mat.displacementScale = orig.displacementScale ?? 1;
                                 mat.displacementBias  = orig.displacementBias  ?? 0; }
    }

    this._patchScreenDoorFade(mat);
    return mat;
  }

  /**
   * SBS unified ShaderMaterial — used for ALL non-texture presets.
   *
   * Solidness smoothly controls the opacity curve from 0 to 1:
   *   solidness=1 → flat y=1.0 curve (fully opaque, solid)
   *   solidness=0 → X-ray falloff curve (edges opaque, centre transparent)
   *   solidness 0–1 → smooth per-fragment interpolation, no hard threshold
   *
   * depthWrite is enabled when solidness=1 (opaque) so depth sorting is correct.
   */
  makeFalloffFrontMaterial(preset) {
    this.ensurePresetDefaults(preset);
    const fadeState  = { value: 1.0 };
    const solidness  = preset.solidness ?? 1.0;
    const isOpaque   = this._isOpaque(preset);   // >= 0.999 — controls alpha blending queue

    // depthWrite always true — closed CAD bodies must write depth even when transparent
    // so complex/concave geometry doesn't bleed through itself.
    const writesDepth = true;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor:               { value: new THREE.Color(preset.color) },
        uSolidness:           { value: solidness },
        uMetalness:           { value: preset.metalness           ?? 0.05 },
        uRoughness:           { value: preset.roughness           ?? 0.45 },
        uReflectionIntensity: { value: preset.reflectionIntensity ?? 0.5 },
        uEnvMap:              { value: this.metalEnvMap },
        uToneMapOn:           { value: _prodToneMap.on },        // 🎬 current mode at creation
        uExposure:            { value: _prodToneMap.exposure },
        uRigKey:              { value: _prodToneMap.key },
        uRigFill:             { value: _prodToneMap.fill },
        uRigRim:              { value: _prodToneMap.rim },
        uRigAngle:            { value: _prodToneMap.angle },
        uRimWidth:            { value: _prodToneMap.rimWidth },
        uContrast:            { value: _prodToneMap.contrast },
        uSaturation:          { value: _prodToneMap.saturation },
        uEnvIntensity:        { value: _prodToneMap.envIntensity },
        uEnvBlur:             { value: _prodToneMap.envBlur },
        transitionOpacity:    fadeState,
      },
      vertexShader:   SBS_VERT,
      fragmentShader: SBS_FRONT_FRAG,
      transparent:    !isOpaque,
      depthTest:      true,
      depthWrite:     writesDepth,
      side:           THREE.FrontSide,
    });

    // Meshes with solidness >= 0.9 write stencil=1 at their pixels each frame.
    // (Back-pass outlines used depthTest:false + stencil!=1 until V0.3.4.157; they now
    // draw first in the transparent queue with the depth test — the stencil is inert.)
    if (solidness >= 0.9) {
      mat.stencilWrite = true;
      mat.stencilRef   = 1;
      mat.stencilZPass = THREE.ReplaceStencilOp;
    }

    // V0.3.4.167 — three reads material.envMap for ANY material when it builds the
    // program: a PMREM here makes it emit the CUBEUV_* defines the shader's
    // textureCubeUV needs (and recompile when the PMREM changes). uEnvMap above is
    // the same texture, bound as the sampler.
    mat.envMap = this.metalEnvMap;

    mat.userData.transitionFadeState = fadeState;
    mat.userData.isSbsShader         = true;
    mat.userData.isFalloffFront      = true;
    return mat;
  }

  /**
   * 🎬 Production Render tone mapping (V0.3.2.47). The SBS unified shader is a
   * raw ShaderMaterial — renderer.toneMapping can't reach it, so ACES lives in
   * the shader behind uToneMapOn/uExposure uniforms. This pushes the current
   * mode to every live SBS material (uniform writes — instant, no recompile;
   * the exposure slider is butter). New materials read _prodToneMap at
   * creation, so preset edits/rebuilds inherit the mode automatically.
   */
  setProductionLook(prod = {}) {
    _prodToneMap.on       = prod.enabled ? 1 : 0;
    _prodToneMap.exposure = Number(prod.exposure) > 0 ? Number(prod.exposure) : 1.0;
    _prodToneMap.key      = Number.isFinite(Number(prod.key))  ? Number(prod.key)  : 1.0;
    _prodToneMap.fill     = Number.isFinite(Number(prod.fill)) ? Number(prod.fill) : 1.0;
    _prodToneMap.rim      = Number.isFinite(Number(prod.rim))  ? Number(prod.rim)  : 1.0;
    _prodToneMap.angle    = (Number.isFinite(Number(prod.angle)) ? Number(prod.angle) : 35) * Math.PI / 180;
    _prodToneMap.rimWidth   = Number.isFinite(Number(prod.rimWidth))   ? Number(prod.rimWidth)   : 0.45;
    _prodToneMap.contrast   = Number.isFinite(Number(prod.contrast))   ? Number(prod.contrast)   : 1.0;
    _prodToneMap.saturation = Number.isFinite(Number(prod.saturation)) ? Number(prod.saturation) : 1.0;
    _prodToneMap.envIntensity = Number.isFinite(Number(prod.envIntensity)) ? Number(prod.envIntensity) : 0.5;
    _prodToneMap.envBlur      = Number.isFinite(Number(prod.envBlur))      ? Number(prod.envBlur)      : 0.35;
    const apply = (m) => {
      const u = m?.uniforms;
      if (!u?.uToneMapOn) {
        // V0.3.4.181 — a MeshStandardMaterial (textured preset, hand skin, cable)
        // takes the Environment-strength slider too: its base env intensity (set
        // where it was made) × strength/0.5, so the default look is unchanged.
        // (Environment blur has no MeshStandard equivalent in r152 — SBS-only.)
        if (m?.isMeshStandardMaterial && typeof m.userData?.envBase === 'number') {
          const v = m.userData.envBase * (_prodToneMap.envIntensity / 0.5);
          if (m.envMapIntensity !== v) m.envMapIntensity = v;
        }
        return;
      }
      u.uToneMapOn.value = _prodToneMap.on;
      u.uExposure.value  = _prodToneMap.exposure;
      if (u.uRigKey) {
        u.uRigKey.value      = _prodToneMap.key;
        u.uRigFill.value     = _prodToneMap.fill;
        u.uRigRim.value      = _prodToneMap.rim;
        u.uRigAngle.value    = _prodToneMap.angle;
        u.uRimWidth.value    = _prodToneMap.rimWidth;
        u.uContrast.value    = _prodToneMap.contrast;
        u.uSaturation.value  = _prodToneMap.saturation;
        if (u.uEnvIntensity) u.uEnvIntensity.value = _prodToneMap.envIntensity;
        if (u.uEnvBlur)      u.uEnvBlur.value       = _prodToneMap.envBlur;
      }
    };
    sceneCore.scene?.traverse(o => {
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ms) apply(m);
    });
    sceneCore.requestRender?.(150);
  }

  /** @deprecated V0.3.2.47 shim — use setProductionLook(prod). */
  setProductionToneMapping(enabled, exposure) {
    this.setProductionLook({ ..._prodToneMap, enabled, exposure, angle: _prodToneMap.angle * 180 / Math.PI });
  }

  /**
   * Back-face pass material (optional — only created when backFaceEnabled=true).
   * Renders the inner surface with its own colour and edge darkening.
   */
  makeFalloffBackMaterial(preset) {
    this.ensurePresetDefaults(preset);
    const fadeState = { value: 1.0 };

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uBackColor:        { value: new THREE.Color(preset.backFaceColor ?? '#ffffff') },
        uBackAlpha:        { value: preset.backFaceOpacity     ?? 0.35 },
        uBackEdgeDarken:   { value: preset.backFaceEdgeDarken ?? 0.45 },
        uToneMapOn:        { value: _prodToneMap.on },        // 🎬 current mode at creation
        uExposure:         { value: _prodToneMap.exposure },
        transitionOpacity: fadeState,
      },
      vertexShader:   SBS_VERT,
      fragmentShader: SBS_BACK_FRAG,
      transparent:    true,
      depthTest:      true,
      depthWrite:     false,
      side:           THREE.BackSide,
    });

    mat.userData.transitionFadeState = fadeState;
    mat.userData.isSbsShader         = true;
    mat.userData.isFalloffBack       = true;
    return mat;
  }

  /**
   * Update an existing SBS ShaderMaterial's uniforms in-place from a preset.
   * Used during step transitions to lerp material values without recreating.
   */
  updateFalloffUniforms(mat, preset) {
    if (!mat?.isShaderMaterial || !mat.userData.isSbsShader) return;
    const u = mat.uniforms;
    if (u.uColor)               u.uColor.value.set(preset.color ?? '#4a90d9');
    if (u.uSolidness)           u.uSolidness.value           = preset.solidness           ?? 1.0;
    if (u.uMetalness)           u.uMetalness.value           = preset.metalness           ?? 0.05;
    if (u.uRoughness)           u.uRoughness.value           = preset.roughness           ?? 0.45;
    if (u.uReflectionIntensity) u.uReflectionIntensity.value = preset.reflectionIntensity ?? 0.5;
    if (u.uEnvMap) {
      const env = this.metalEnvMap;
      u.uEnvMap.value = env;
      if (mat.envMap !== env) { mat.envMap = env; mat.needsUpdate = true; }   // the CUBEUV_* defines follow the PMREM
    }
  }

  /**
   * Compute a linearly interpolated preset from A→B at time t (0–1).
   * Used by steps.js during colour-changing step transitions.
   */
  lerpPresets(pA, pB, t) {
    if (!pA) return pB;
    if (!pB) return pA;
    this.ensurePresetDefaults(pA);
    this.ensurePresetDefaults(pB);
    const lerp = (a, b) => a + (b - a) * t;
    // Lerp RGB colour components
    const cA = new THREE.Color(pA.color);
    const cB = new THREE.Color(pB.color);
    const cLerp = cA.lerp(cB, t);
    return {
      ...pB,
      color:               '#' + cLerp.getHexString(),
      metalness:           lerp(pA.metalness,           pB.metalness),
      roughness:           lerp(pA.roughness,           pB.roughness),
      solidness:           lerp(pA.solidness,           pB.solidness),
      reflectionIntensity: lerp(pA.reflectionIntensity ?? 0.5, pB.reflectionIntensity ?? 0.5),
    };
  }

  /**
   * Patch a MeshStandardMaterial to support `transitionOpacity` uniform
   * (screen-door dithered fade during step transitions).
   * No-op on shader materials (they already have it built in).
   */
  /** 🖐 The hand branch of applyAll, for one registered hand mesh (see the comment there). */
  _applyHand(nodeId, mesh, original, presetById) {
    if (!original) return;
    const sid = this.meshColorAssignments[nodeId] ?? null;
    const pst = sid ? presetById.get(sid) : null;
    const hm  = this._handMaterial(mesh, original);
    if (mesh.material !== hm) {
      const old = mesh.material;
      mesh.material = hm;
      if (old && old !== original && old !== hm) { try { old.dispose?.(); } catch {} }
    }
    const tint = hm.userData.handTint;
    if (pst) {
      this.ensurePresetDefaults(pst);
      tint.uTint.value.set(pst.color || '#cccccc');
      tint.uTintMix.value = 1;
      tint.uSolid.value   = typeof pst.solidness === 'number' ? Math.max(0, Math.min(1, pst.solidness)) : 1;
      hm.roughness = typeof pst.roughness === 'number' ? pst.roughness : (original.roughness ?? hm.roughness);
      hm.metalness = typeof pst.metalness === 'number' ? pst.metalness : (original.metalness ?? hm.metalness);
    } else {
      tint.uTintMix.value = 0;   // uTint kept: a fade-out mixes the last shade away
      tint.uSolid.value   = 1;
      hm.roughness = original.roughness ?? hm.roughness;
      hm.metalness = original.metalness ?? hm.metalness;
    }
    hm.opacity = 1;   // solidness lives in uSolid (see _handMaterial)
    if (!hm.transparent) { hm.transparent = true; hm.needsUpdate = true; }   // always blended (V0.3.4.160)
  }
  /** 🖐 A (re)built hand puts on its material at once — without a full applyAll mid-activation. */
  refreshHand(nodeId) {
    const mesh = this.meshById.get(nodeId);
    if (!mesh?.userData?.handNodeId) return;
    const presets = state.get('colorPresets') || [];
    this._applyHand(nodeId, mesh, this.originalMaterials.get(nodeId), new Map(presets.map(p => [p.id, p])));
  }

  /**
   * 🖐 V0.3.4.157 — the hand's one material: a clone of its original (texture kept)
   * with a tint-mix patch — `diffuseColor.rgb = mix(textured, uTint, uTintMix)` right
   * after the map is applied — blended alpha = solidness × fade (V0.3.4.160). Rebuilt only when
   * the original changes (a new rig / skin / texture).
   */
  _handMaterial(mesh, original) {
    let hm = mesh.userData.handMat;
    if (hm && hm.userData?.handOriginalUuid === original.uuid) return hm;
    try { hm?.dispose?.(); } catch {}
    hm = original.clone();
    hm.userData = { ...(hm.userData || {}), envBase: typeof original.envMapIntensity === 'number' ? original.envMapIntensity : 1 };   // V0.3.4.181 — Environment strength reaches the skin
    hm.envMapIntensity = hm.userData.envBase * (_prodToneMap.envIntensity / 0.5);
    // V0.3.4.160 — REAL see-through (his call: the screen-door dither "is not an
    // opacity"). Always BLENDED — never flipped opaque ↔ transparent, so neither a
    // solidness change nor a show/hide fade switches programs mid-way (the .157
    // snap); at solidness 1 the alpha is 1 and it reads opaque.
    hm.transparent = true;
    hm.depthWrite  = true;
    hm.opacity     = 1;
    const tint = { uTint: { value: new THREE.Color(1, 1, 1) }, uTintMix: { value: 0 }, uSolid: { value: 1 } };
    const fade = { value: 1 };
    // V0.3.4.161 — the hand's own nearest depth during a show/hide fade (see onBeforeRender)
    const shell = { uHandDepth: { value: null }, uHandDepthOn: { value: 0 }, uHandDepthVp: { value: new THREE.Vector4(0, 0, 1, 1) } };
    // (the original by uuid, never by reference: a Material in userData would be
    //  JSON-serialised by any later .clone()). transitionFadeState = the show/hide
    //  fade _setMaterialFade drives; transitionDitherPatched keeps the dither off it.
    hm.userData = { ...(hm.userData || {}), handTint: tint, handOriginalUuid: original.uuid,
                    transitionFadeState: fade, transitionDitherPatched: true };
    const priorCompile = hm.onBeforeCompile;
    hm.onBeforeCompile = function (shader) {
      if (typeof priorCompile === 'function') priorCompile.call(this, shader);
      shader.uniforms.uTint = tint.uTint;
      shader.uniforms.uTintMix = tint.uTintMix;
      shader.uniforms.uSolid = tint.uSolid;
      shader.uniforms.uHandFade = fade;
      shader.uniforms.uHandDepth = shell.uHandDepth;
      shader.uniforms.uHandDepthOn = shell.uHandDepthOn;
      shader.uniforms.uHandDepthVp = shell.uHandDepthVp;
      if (!shader.fragmentShader.includes('uniform vec3 uTint;')) {
        shader.fragmentShader = 'uniform vec3 uTint;\nuniform float uTintMix;\nuniform float uSolid;\nuniform float uHandFade;\n'
          + 'uniform highp sampler2D uHandDepth;\nuniform float uHandDepthOn;\nuniform vec4 uHandDepthVp;\n' + shader.fragmentShader;
      }
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        '#include <map_fragment>\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, uTint, clamp(uTintMix, 0.0, 1.0));',
      );
      // SOLIDNESS × FADE as the blended alpha, written after output_fragment. The SBS
      // X-ray: edges keep their cover, the face-on middle opens up —
      // alpha = mix(pow(1 − |N·V|, 2.5), 1, solidness), the curve of the SBS shader.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `{
\t\tfloat sbsFacing = clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
\t\tfloat sbsXray   = pow(1.0 - sbsFacing, 2.5);
\t\tgl_FragColor.a  = mix(sbsXray, 1.0, clamp(uSolid, 0.0, 1.0)) * clamp(uHandFade, 0.0, 1.0);
\t\tif (uHandDepthOn > 0.5) {   // mid-fade: only the hand's outer shell (its own depth, not the frame's)
\t\t\tvec2 sbsHdUv = (gl_FragCoord.xy - uHandDepthVp.xy) * uHandDepthVp.zw;
\t\t\tif (gl_FragCoord.z > texture2D(uHandDepth, sbsHdUv).r + 1e-5) discard;
\t\t}
\t}
#include <dithering_fragment>`,
      );
    };
    const priorKey = hm.customProgramCacheKey;
    hm.customProgramCacheKey = function () { return (typeof priorKey === 'function' ? priorKey.call(this) : '') + '|sbs_handtint4'; };
    // DEPTH PASSES — while see-through, the blended colour draw writes no depth; two
    // depth-only draws of the same object, right before it (so it keeps the hand's
    // place in the back-to-front sort), do:
    //  • depthMat → the FRAME's depth, thinned by the same screen-door noise every
    //    other object fades with. That depth is what N8AO reads: the hand's ambient
    //    occlusion now fades with the hand instead of staying full and popping off at
    //    the end (V0.3.4.161 — his catch). The colour itself stays real alpha.
    //    At full fade nothing is thinned: the outer shell's depth, as in .160.
    //  • shellMat → mid-fade only: the hand's OWN nearest depth into a scratch
    //    target, since the thinned frame depth can no longer keep the colour pass to
    //    the outer shell — the colour draw discards anything behind it (no fingers
    //    ghosting through the palm).
    // (depthMat is pushed a hair back — polygonOffset — so the shell's own pixels pass
    //  LessEqual; shellMat is exact — the colour draw compares against it with an epsilon.
    //  Both take the hand's side: a double-sided skin must lay down its back faces too.)
    const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: hm.side });
    const shellMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: hm.side });
    depthMat.polygonOffset = true; depthMat.polygonOffsetFactor = 1; depthMat.polygonOffsetUnits = 1;
    depthMat.onBeforeCompile = function (shader) {
      shader.uniforms.uHandFade = fade;
      shader.fragmentShader = 'uniform float uHandFade;\n' + DITHER_NOISE_GLSL + shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        'if (clamp(uHandFade, 0.0, 1.0) <= transitionDitherNoise(gl_FragCoord.xy)) discard;\n#include <dithering_fragment>');
    };
    depthMat.customProgramCacheKey = () => 'sbs_handdepth';
    const vp = new THREE.Vector4();
    hm.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
      shell.uHandDepthOn.value = 0;
      if (tint.uSolid.value >= 0.999 && fade.value >= 0.999) { hm.depthWrite = true; return; }   // solid: nothing inside shows
      hm.depthWrite = false;
      if (fade.value < 0.999) {
        renderer.getCurrentViewport(vp);
        const prev = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        const rt = _handShellTarget(Math.max(1, vp.z), Math.max(1, vp.w));
        renderer.setRenderTarget(rt);
        renderer.state.buffers.depth.setMask(true);   // clear() honours the last draw's depth mask
        renderer.clear(false, true, false);
        renderer.renderBufferDirect(camera, scene, geometry, shellMat, object, group);
        renderer.setRenderTarget(prev, face, mip);
        shell.uHandDepth.value = rt.depthTexture;
        shell.uHandDepthVp.value.set(vp.x, vp.y, 1 / Math.max(1, vp.z), 1 / Math.max(1, vp.w));
        shell.uHandDepthOn.value = 1;
      }
      renderer.renderBufferDirect(camera, scene, geometry, depthMat, object, group);
    };
    hm.addEventListener('dispose', () => { try { depthMat.dispose(); shellMat.dispose(); } catch {} });
    hm.needsUpdate = true;
    mesh.userData.handMat = hm;
    return hm;
  }

  _patchScreenDoorFade(material) {
    if (!material || Array.isArray(material)) return;
    material.userData = material.userData ?? {};
    if (material.userData.transitionDitherPatched) return;

    const fadeState = { value: 1.0 };
    material.userData.transitionFadeState = fadeState;

    const priorOnBeforeCompile  = material.onBeforeCompile;
    const priorCacheKey         = material.customProgramCacheKey;

    material.onBeforeCompile = function(shader) {
      if (typeof priorOnBeforeCompile === 'function')
        priorOnBeforeCompile.call(this, shader);

      shader.uniforms.transitionOpacity = fadeState;

      if (!shader.fragmentShader.includes('uniform float transitionOpacity')) {
        shader.fragmentShader = `
uniform float transitionOpacity;
${DITHER_NOISE_GLSL}
` + shader.fragmentShader;
      }

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
float transitionCoverage = clamp(gl_FragColor.a, 0.0, 1.0)
  * clamp(transitionOpacity, 0.0, 1.0);
if (transitionCoverage <= transitionDitherNoise(gl_FragCoord.xy)) discard;
gl_FragColor.a = 1.0;
#include <dithering_fragment>`,
      );
    };

    material.customProgramCacheKey = function() {
      const base = typeof priorCacheKey === 'function' ? priorCacheKey.call(this) : '';
      return base + '|sbs_dither';
    };

    material.userData.transitionDitherPatched = true;
    // FORCE RECOMPILE (V0.3.2.61) — installing onBeforeCompile + a changed
    // cache key does NOT by itself rebuild an already-compiled program; only a
    // version bump does. Without this, a primitive whose clean MeshStandard-
    // Material was already compiled kept a dither-less program → its fade
    // ramp had zero visual effect and it hard-SNAPPED off at the end.
    material.needsUpdate = true;
  }

  /**
   * Remove the falloff back-pass mesh from a Three.js mesh (cleanup).
   */
  _removeFalloffBackPass(mesh) {
    const back = mesh?.userData?.falloffBackPass;
    if (!back) return;
    mesh.remove(back);
    back.material?.dispose?.();
    delete mesh.userData.falloffBackPass;
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  APPLY MATERIALS
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Apply all color presets to all mesh Three.js objects.
   * Call after: preset change, assignment change, override mode change,
   * or after a snapshot is applied.
   */
  applyAll() {
    this._colorTransition = null;   // cancel any in-progress colour animation
    sceneCore.requestRender?.(150); // materials changed → wake the render-on-demand loop (covers undo/redo, programmatic recolors)
    const overrideMode = state.get('solidOverride');
    const presets      = state.get('colorPresets');
    const presetById   = new Map(presets.map(p => [p.id, p]));

    // FlatShape templates indexed by id for fast template-fill lookup.
    // Built once per applyAll() pass — cheaper than calling state.get
    // inside the per-mesh loop.
    const shapeTpls = state.get('shapeTemplates') || [];
    const tplById   = new Map(shapeTpls.map(t => [t.id, t]));
    const nodeById  = state.get('nodeById');

    for (const [nodeId, mesh] of this.meshById) {
      const original = this.originalMaterials.get(nodeId);
      this._removeFalloffBackPass(mesh);

      // Dispose any GENERATED material we previously installed before
      // overwriting mesh.material. The original (stored in
      // originalMaterials) is the canonical material we revert to —
      // never dispose it. Without this, every applyAll call leaks one
      // material per mesh; after a long QA session that's measurable.
      const _disposeGenerated = (mat) => {
        if (!mat || mat === original) return;
        try { mat.dispose?.(); } catch {}
      };

      // ── flatShape branch ──────────────────────────────────────────
      // flatShape meshes (polygon shapes + image-shapes) get a lighter
      // touch: we MUTATE `mesh.material.color` in place rather than
      // swapping the material type. This preserves:
      //   - transparent:true → fade animation via _setMaterialFade
      //   - the texture map on image-shapes (we skip them outright)
      //   - the shape's flat aesthetic (no falloff shader effect)
      //
      // Color resolution chain matches regular meshes:
      //   per-step preset → project default → template fill.
      // overrideMode=false short-circuits to template fill.
      if (mesh.userData?.flatShapeNodeId) {
        // Image-shape — texture dominates. v1: silently skip preset
        // application (assignment is still stored, just doesn't paint).
        if (mesh.material?.map) {
          continue;
        }
        const shapeNode = nodeById?.get(nodeId);
        const tpl       = shapeNode?.templateId ? tplById.get(shapeNode.templateId) : null;
        const templateFill = tpl?.fill || '#cccccc';

        let targetColor;
        if (overrideMode) {
          const sid = this.meshColorAssignments[nodeId]
                   ?? this.meshDefaultColors[nodeId]
                   ?? null;
          const pst = sid ? presetById.get(sid) : null;
          targetColor = pst?.color || templateFill;
        } else {
          targetColor = templateFill;
        }
        if (mesh.material?.color?.set) mesh.material.color.set(targetColor);
        continue;
      }

      // ── 🖐 hand branch (V0.3.4.155, crossfade V0.3.4.157) ──────────
      // A hand is registered under its node id by its visible mesh (the skinned
      // mesh, or the palm whose material every capsule shares). It wears ONE
      // persistent material (the original + a tint-mix patch + the dither fade):
      // the texture always stays on it, and a per-step preset MIXES a solid shade
      // over it (uTintMix 0 → 1) with the preset's roughness / metalness and
      // solidness (opacity → dithered X-ray). One material means the colour slot
      // can lerp the mix, so texture ↔ shade is a real crossfade. A plain
      // standard material, so the skinned mesh still skins. No default colour for
      // a hand: without an assignment it is its textured self.
      if (mesh.userData?.handNodeId) {
        this._applyHand(nodeId, mesh, original, presetById);
        continue;
      }

      // ── primitive branch (V0.2.22.93) ─────────────────────────────
      // Parametric primitives get the FULL SBS shader for their assigned preset
      // — metalness / roughness / reflection / solidness, same as CAD meshes —
      // but ALWAYS (independent of the global solid-override toggle, which is
      // what previously left them uncoloured). No preset → plain default.
      if (mesh.userData?.primitiveNodeId) {
        const sid = this.meshColorAssignments[nodeId] ?? this.meshDefaultColors[nodeId] ?? null;
        const pst = sid ? presetById.get(sid) : null;
        if (pst) {
          this.ensurePresetDefaults(pst);
          _disposeGenerated(mesh.material);
          mesh.material = this.makeMaterial(pst, original);
          if (pst.backFaceEnabled) {
            const back = new THREE.Mesh(mesh.geometry, this.makeFalloffBackMaterial(pst));
            back.raycast          = () => {};
            back.frustumCulled    = mesh.frustumCulled;
            back.matrixAutoUpdate = true;
            back.userData.noSelect = true;
            mesh.add(back);
            mesh.userData.falloffBackPass = back;
          }
        } else if (original && mesh.material !== original) {
          _disposeGenerated(mesh.material);
          mesh.material = original;
          // A no-preset primitive reverts to its CLEAN original — re-install the
          // dither-fade so it can still ramp out (else it hard-snaps). The patch
          // no-ops if already done and forces a recompile (V0.3.2.61).
          this._patchScreenDoorFade(mesh.material);
        }
        continue;
      }

      if (!overrideMode) {
        // Restore original import material
        if (original && mesh.material !== original) {
          _disposeGenerated(mesh.material);
          mesh.material = original;
        }
        continue;
      }

      // Resolution chain: per-step override → project default → none.
      // Per-step assignments live in meshColorAssignments (set by step
      // activation). Project-level defaults live in meshDefaultColors and
      // act as a fallback whenever the step has no explicit override for
      // this mesh — so "Set as default" persists across every step that
      // doesn't override.
      const presetId = this.meshColorAssignments[nodeId]
                    ?? this.meshDefaultColors[nodeId]
                    ?? null;
      const preset   = presetId ? presetById.get(presetId) : null;

      if (preset) {
        this.ensurePresetDefaults(preset);
        _disposeGenerated(mesh.material);
        mesh.material = this.makeMaterial(preset, original);

        // Back-face pass — only when preset explicitly enables it
        if (preset.backFaceEnabled) {
          const back = new THREE.Mesh(mesh.geometry, this.makeFalloffBackMaterial(preset));
          back.raycast        = () => {};     // not selectable
          back.frustumCulled  = mesh.frustumCulled;
          back.matrixAutoUpdate = true;
          back.userData.noSelect = true;
          mesh.add(back);
          mesh.userData.falloffBackPass = back;
        }
      } else {
        // No preset assigned — use original import material
        if (original && mesh.material !== original) {
          _disposeGenerated(mesh.material);
          mesh.material = original;
        }
      }
    }

    this.applyGeometryOutlines();
    this.applySelectionHighlight();

    // Re-apply any in-progress visibility fade values.
    // applyAll() just rebuilt material objects (resetting transitionOpacity to 1.0)
    // and applyGeometryOutlines() reset outline opacities — both need correction
    // for meshes that are currently mid-fade.
    if (this._visTransitions?.size) {
      const now             = clock.now();
      const outlineSettings = state.get('geometryOutline');
      for (const [nodeId, tr] of this._visTransitions) {
        const raw   = Math.max(0, Math.min((now - tr.startMs) / tr.durationMs, 1));
        const alpha = tr.easeFn(raw);
        const t      = tr.from + (tr.to - tr.from) * alpha;
        // backOp uses alpha (0→1 progress) so it fades correctly for both hide and show.
        // hiding:  fromBackOp → 0    (alpha 0→1)
        // showing: 0 → toBackOp     (alpha 0→1)
        const backOp = tr.fromBackOp + (tr.toBackOp - tr.fromBackOp) * alpha;
        this._setNodeTransitionOpacity(nodeId, t, outlineSettings, backOp);
      }
    }
    // Pending showing-hidden meshes: snapped-to-zero ahead of their
    // visibility phase. Without this, a color transition's final
    // applyAll would pop them visible for one frame before the
    // visibility phase fades them in.
    if (this._pendingShowingHidden?.size) {
      const outlineSettings = state.get('geometryOutline');
      for (const nodeId of this._pendingShowingHidden) {
        if (this._visTransitions.has(nodeId)) continue;   // active fade owns it
        this._setNodeTransitionOpacity(nodeId, 0.0, outlineSettings, 0);
      }
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  SNAPSHOT (for step capture/apply)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Capture current color assignments as a snapshot.
   *
   * Architectural rule: a snapshot entry whose value equals the project
   * default for that mesh is NOT a real override — it's tracking the
   * default. We strip those entries at capture so future changes to the
   * project default propagate to this step automatically. The snapshot
   * carries only true per-step overrides.
   *
   * Returns { [meshNodeId]: colorPresetId }
   */
  captureSnapshot() {
    const out = {};
    for (const [id, presetId] of Object.entries(this.meshColorAssignments)) {
      if (presetId == null) continue;
      if (this.meshDefaultColors[id] === presetId) continue;   // tracking default
      out[id] = presetId;
    }
    return out;
  }

  /**
   * Apply a materials snapshot (restores color assignments + re-applies).
   *
   * Defensive filter: drop any entry that matches the current project
   * default. Even if a legacy snapshot still carries default-tracking
   * stamps, they are interpreted as inheritance-from-default so a later
   * default change will re-resolve them via the fallback chain in applyAll.
   */
  applySnapshot(snapshot) {
    if (!snapshot) return;
    this.cancelVisibilityTransitions();   // snap any in-flight vis fades to final state
    const filtered = {};
    for (const [id, presetId] of Object.entries(snapshot)) {
      if (presetId == null) continue;
      if (this.meshDefaultColors[id] === presetId) continue;
      filtered[id] = presetId;
    }
    this.meshColorAssignments = filtered;
    this.applyAll();
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  COLOUR TRANSITION (smooth interpolation between step material states)
  // ═══════════════════════════════════════════════════════════════════════

  /** Snapshot current material uniform values for every mesh. */
  _captureUniformValues() {
    const values = new Map();
    for (const [nodeId, mesh] of this.meshById) {
      const mat = mesh.material;
      let color               = new THREE.Color(1, 1, 1);
      let solidness           = 1.0;
      let metalness           = 0.05;
      let roughness           = 0.45;
      let reflectionIntensity = 0.5;

      if (mat?.isShaderMaterial && mat.uniforms?.uColor) {
        color = mat.uniforms.uColor.value.clone();
      } else if (mat?.color) {
        color = mat.color.clone();
      }

      if (mat?.isShaderMaterial && mat.uniforms?.uSolidness) {
        solidness = mat.uniforms.uSolidness.value;
      } else if (typeof mat?.opacity === 'number') {
        solidness = mat.opacity;
      }

      if (mat?.isShaderMaterial && mat.uniforms?.uMetalness) {
        metalness = mat.uniforms.uMetalness.value;
      } else if (typeof mat?.metalness === 'number') {
        metalness = mat.metalness;
      }

      if (mat?.isShaderMaterial && mat.uniforms?.uRoughness) {
        roughness = mat.uniforms.uRoughness.value;
      } else if (typeof mat?.roughness === 'number') {
        roughness = mat.roughness;
      }

      if (mat?.isShaderMaterial && mat.uniforms?.uReflectionIntensity) {
        reflectionIntensity = mat.uniforms.uReflectionIntensity.value;
      } else if (typeof mat?.envMapIntensity === 'number') {
        // texture path stores reflectionIntensity * 0.5 as envMapIntensity
        reflectionIntensity = mat.envMapIntensity / 0.5;
      }

      const back = this._outlineBackMeshes.get(nodeId);
      const backOpacity = back?.material?.uniforms?.uOpacity?.value
                       ?? back?.material?.uniforms?.uDitherOpacity?.value
                       ?? 0;

      const entry = { color, solidness, metalness, roughness, reflectionIntensity, backOpacity };
      // 🖐 V0.3.4.157 — a hand's shade over its texture: the tint and how much of it
      const ht = mat?.userData?.handTint;
      if (ht) { entry.tint = ht.uTint.value.clone(); entry.tintMix = ht.uTintMix.value; entry.handSolid = ht.uSolid.value; }
      values.set(nodeId, entry);
    }
    return values;
  }

  /** Push captured uniform values back onto current materials. */
  _applyUniformValues(values) {
    for (const [nodeId, v] of values) {
      const mesh = this.meshById.get(nodeId);
      if (!mesh) continue;
      const mat = mesh.material;

      if (mat?.isShaderMaterial && mat.uniforms?.uColor) {
        mat.uniforms.uColor.value.copy(v.color);
      } else if (mat?.color) {
        mat.color.copy(v.color);
      }

      if (mat?.isShaderMaterial && mat.uniforms?.uSolidness) {
        mat.uniforms.uSolidness.value = v.solidness;
      } else if (mat && !mat.isShaderMaterial && typeof mat.opacity === 'number') {
        mat.opacity = v.solidness;
      }

      if (mat?.isShaderMaterial && mat.uniforms?.uMetalness) {
        mat.uniforms.uMetalness.value = v.metalness;
      } else if (mat && typeof mat.metalness === 'number') {
        mat.metalness = v.metalness;
      }

      if (mat?.isShaderMaterial && mat.uniforms?.uRoughness) {
        mat.uniforms.uRoughness.value = v.roughness;
      } else if (mat && typeof mat.roughness === 'number') {
        mat.roughness = v.roughness;
      }

      if (mat?.isShaderMaterial && mat.uniforms?.uReflectionIntensity) {
        mat.uniforms.uReflectionIntensity.value = v.reflectionIntensity;
      } else if (mat && typeof mat.envMapIntensity === 'number') {
        mat.envMapIntensity = v.reflectionIntensity * 0.5;
      }

      if (v.tintMix != null && mat?.userData?.handTint) {
        mat.userData.handTint.uTint.value.copy(v.tint);
        mat.userData.handTint.uTintMix.value = v.tintMix;
        if (v.handSolid != null) mat.userData.handTint.uSolid.value = v.handSolid;
      }

      const back = this._outlineBackMeshes.get(nodeId);
      if (back?.material?.uniforms?.uOpacity) {
        back.material.uniforms.uOpacity.value = v.backOpacity;
        back.visible = v.backOpacity > 0.001;
      } else if (back?.material?.uniforms?.uDitherOpacity) {
        back.material.uniforms.uDitherOpacity.value = v.backOpacity;
        back.visible = v.backOpacity > 0.001;
      }
    }
  }

  /**
   * Begin an animated colour transition to a new material snapshot.
   * Called by steps.js during animated step transitions instead of applySnapshot.
   *
   * Flow:
   *   1. Capture FROM state (current uniforms)
   *   2. applyAll() → builds new materials at target values (also clears _colorTransition)
   *   3. Capture TO state (new uniforms)
   *   4. Reset materials back to FROM values
   *   5. Store transition — advanceColorTransition() will interpolate each frame
   *
   * @param {object}   toSnapshot   meshColorAssignments snapshot
   * @param {number}   durationMs   animation duration
   * @param {function} easeFn       easing function (t → t)
   */
  beginColorTransition(toSnapshot, durationMs, easeFn) {
    const fromValues = this._captureUniformValues();

    // applyAll clears _colorTransition and builds target materials
    this.meshColorAssignments = { ...toSnapshot };
    this.applyAll();

    const toValues = this._captureUniformValues();

    this._applyUniformValues(fromValues);   // reset to from state

    // Fix transparent + stencilWrite to match FROM solidness on all transitioning meshes.
    // applyAll() built materials for the TARGET solidness — transparent and stencilWrite
    // flags are wrong for the FROM state, causing immediate visual pops.
    for (const [nodeId, from] of fromValues) {
      const to = toValues.get(nodeId);
      if (!to) continue;
      if (from.solidness >= 0.999 && to.solidness >= 0.999) continue;
      const mesh = this.meshById.get(nodeId);
      if (!mesh) continue;
      const mat = mesh.material;
      if (mat) {
        mat.transparent   = true;
        mat.stencilWrite  = false;
        mat.needsUpdate   = true;
      }
    }

    // Patch toBackOp for showing-vis-transitions now that meshColorAssignments
    // has been updated to the target snapshot (so solidness is the target solidness).
    // Must NOT read toValues.backOpacity — applyAll's vis-reapply zeroed those.
    if (this._visTransitions.size) {
      const outlineSettings = state.get('geometryOutline');
      for (const [nodeId, tr] of this._visTransitions) {
        if (tr.hide) continue;
        tr.toBackOp = this._computeTargetBackOp(nodeId, outlineSettings);
      }
    }

    this._colorTransition = {
      fromValues, toValues,
      startMs:    clock.now(),
      durationMs: Math.max(durationMs, 1),
      easeFn,
    };
  }

  /**
   * Advance the active colour transition by one frame.
   * Called each tick from steps._advanceObjectTransitions.
   */
  advanceColorTransition(nowMs) {
    const tr = this._colorTransition;
    if (!tr) return;
    sceneCore.requestRender?.(120);   // colours are lerping → keep the loop awake

    const raw   = Math.max(0, Math.min((nowMs - tr.startMs) / tr.durationMs, 1));
    const alpha = tr.easeFn(raw);

    for (const [nodeId, from] of tr.fromValues) {
      const to   = tr.toValues.get(nodeId);
      if (!to) continue;
      const mesh = this.meshById.get(nodeId);
      if (!mesh) continue;
      const mat  = mesh.material;

      const lerp = (a, b) => a + (b - a) * alpha;

      // Color
      if (mat?.isShaderMaterial && mat.uniforms?.uColor) {
        mat.uniforms.uColor.value.setRGB(
          lerp(from.color.r, to.color.r),
          lerp(from.color.g, to.color.g),
          lerp(from.color.b, to.color.b),
        );
      } else if (mat?.color) {
        mat.color.setRGB(
          lerp(from.color.r, to.color.r),
          lerp(from.color.g, to.color.g),
          lerp(from.color.b, to.color.b),
        );
      }

      // Solidness / opacity — also keep stencilWrite in sync so back outline fades correctly
      const lerpedSolidness = lerp(from.solidness, to.solidness);
      if (mat?.isShaderMaterial && mat.uniforms?.uSolidness) {
        mat.uniforms.uSolidness.value = lerpedSolidness;
      } else if (mat && !mat.isShaderMaterial && typeof mat.opacity === 'number') {
        mat.opacity = lerpedSolidness;
      }

      // Metalness
      if (mat?.isShaderMaterial && mat.uniforms?.uMetalness) {
        mat.uniforms.uMetalness.value = lerp(from.metalness, to.metalness);
      } else if (mat && typeof mat.metalness === 'number') {
        mat.metalness = lerp(from.metalness, to.metalness);
      }

      // Roughness
      if (mat?.isShaderMaterial && mat.uniforms?.uRoughness) {
        mat.uniforms.uRoughness.value = lerp(from.roughness, to.roughness);
      } else if (mat && typeof mat.roughness === 'number') {
        mat.roughness = lerp(from.roughness, to.roughness);
      }

      // Reflection intensity
      if (mat?.isShaderMaterial && mat.uniforms?.uReflectionIntensity) {
        mat.uniforms.uReflectionIntensity.value = lerp(from.reflectionIntensity, to.reflectionIntensity);
      } else if (mat && typeof mat.envMapIntensity === 'number') {
        mat.envMapIntensity = lerp(from.reflectionIntensity, to.reflectionIntensity) * 0.5;
      }

      // 🖐 V0.3.4.157 — a hand: texture ↔ shade is the MIX, lerped. A side with no
      // shade (mix 0) borrows the other side's tint, so the fade never passes
      // through a stale colour.
      if (from.tintMix != null && to.tintMix != null && mat?.userData?.handTint) {
        const tFrom = from.tintMix < 0.001 ? to.tint : from.tint;
        const tTo   = to.tintMix   < 0.001 ? tFrom   : to.tint;
        mat.userData.handTint.uTint.value.setRGB(lerp(tFrom.r, tTo.r), lerp(tFrom.g, tTo.g), lerp(tFrom.b, tTo.b));
        mat.userData.handTint.uTintMix.value = lerp(from.tintMix, to.tintMix);
        if (from.handSolid != null && to.handSolid != null) mat.userData.handTint.uSolid.value = lerp(from.handSolid, to.handSolid);
      }

      // Back outline opacity — skip if a visibility transition is already driving it
      // (advanceVisibilityTransitions runs after this and uses stored fromBackOp/toBackOp)
      if (!this._visTransitions.has(nodeId)) {
        const back   = this._outlineBackMeshes.get(nodeId);
        const backOp = lerp(from.backOpacity, to.backOpacity);
        if (back?.material?.uniforms?.uOpacity) {
          back.material.uniforms.uOpacity.value = backOp;
          back.visible = backOp > 0.001 || to.backOpacity > 0.001;
        } else if (back?.material?.uniforms?.uDitherOpacity) {
          back.material.uniforms.uDitherOpacity.value = backOp;
          back.visible = backOp > 0.001 || to.backOpacity > 0.001;
        }
      }
    }

    if (raw >= 1) {
      this._colorTransition = null;
      // Rebuild materials at final target values so transparent/depthWrite flags
      // are correctly set (transition may have forced transparent=true on opaque targets).
      this.applyAll();
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  VISIBILITY FADE TRANSITIONS (per-mesh dither fade on show/hide)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Set transitionOpacity + outline opacities for a single mesh node at time t (0–1).
   * t=0 → fully invisible (dithered out), t=1 → fully visible.
   *
   * Back outline is driven by the stored fromBackOp/toBackOp values captured at
   * transition start — NOT recomputed from current solidness — so a simultaneous
   * colour transition (e.g. solidness 0.3 → 1.0) can't clobber the back-fade curve.
   *
   * @param {string}  nodeId
   * @param {number}  t                0–1 visibility opacity (drives dither + front outline)
   * @param {object}  [outlineSettings] pre-fetched geometryOutline state
   * @param {number}  [backOp]          pre-computed back outline opacity (skip if undefined)
   */
  _setNodeTransitionOpacity(nodeId, t, outlineSettings, backOp) {
    const mesh = this.meshById.get(nodeId);
    if (!mesh) return;

    const settings = outlineSettings ?? state.get('geometryOutline');

    // ── Mesh material dither fade ────────────────────────────────────────
    this._setMaterialFade(mesh.material, t);
    const backPass = mesh.userData.falloffBackPass;
    if (backPass) this._setMaterialFade(backPass.material, t);

    if (!settings?.enabled) return;

    const globalOpacity = settings.opacity ?? 0.9;

    // ── Front outline: scale by t ────────────────────────────────────────
    const front = this._outlineMeshes.get(nodeId);
    if (front?.material?.uniforms?.uOpacity !== undefined) {
      front.material.uniforms.uOpacity.value = globalOpacity * t;
    }

    // ── Back outline: use pre-computed value if provided ─────────────────
    if (backOp !== undefined) {
      const back = this._outlineBackMeshes.get(nodeId);
      if (back?.material?.uniforms?.uOpacity !== undefined) {
        back.material.uniforms.uOpacity.value = backOp;
        back.visible = backOp > 0.001;
      }
    }
  }

  /**
   * Compute the steady-state back-outline opacity for a node from its current
   * meshColorAssignments entry. Call after updating assignments to target snapshot.
   */
  _computeTargetBackOp(nodeId, outlineSettings) {
    const settings = outlineSettings ?? state.get('geometryOutline');
    if (!settings?.enabled) return 0;
    const overrideMode  = state.get('solidOverride');
    const presets       = state.get('colorPresets') || [];
    const presetById    = new Map(presets.map(p => [p.id, p]));
    const presetId      = this.meshColorAssignments[nodeId] ?? this.meshDefaultColors[nodeId];
    const preset        = presetId ? presetById.get(presetId) : null;
    const solidness     = (overrideMode && preset) ? (preset.solidness ?? 1.0) : 1.0;
    const globalOpacity = settings.opacity ?? 0.9;
    return Math.min(1, Math.max(0, (0.9 - solidness) / 0.6)) * globalOpacity;
  }

  /**
   * Begin visibility fade transitions for a set of hiding / showing mesh nodes.
   * Must be called BEFORE beginColorTransition (so applyAll reapplies fades).
   *
   * Hiding meshes: caller keeps obj.visible=true; we fade transitionOpacity 1→0,
   *   then set obj.visible=false when complete.
   * Showing meshes: obj.visible is already true; we fade transitionOpacity 0→1.
   *
   * @param {string[]}   hidingIds    mesh nodeIds going visible → hidden
   * @param {string[]}   showingIds   mesh nodeIds going hidden → visible
   * @param {number}     durationMs
   * @param {function}   easeFn
   */
  beginVisibilityTransitions(hidingIds, showingIds, durationMs, easeFn) {
    const now             = clock.now();
    const outlineSettings = state.get('geometryOutline');

    for (const nodeId of hidingIds) {
      // Capture the back outline's current opacity as the "from" value.
      // This must happen BEFORE beginColorTransition updates meshColorAssignments,
      // so the FROM solidness is still correct.
      const back       = this._outlineBackMeshes.get(nodeId);
      const fromBackOp = back?.material?.uniforms?.uOpacity?.value ?? 0;

      // alpha=0 at start → backOp = fromBackOp + (0 - fromBackOp)*0 = fromBackOp
      this._setNodeTransitionOpacity(nodeId, 1.0, outlineSettings, fromBackOp);
      this._visTransitions.set(nodeId, {
        from: 1.0, to: 0.0,
        fromBackOp, toBackOp: 0,           // back outline fades fromBackOp → 0
        startMs: now, durationMs: Math.max(durationMs, 1),
        easeFn, hide: true,
      });
    }

    for (const nodeId of showingIds) {
      // alpha=0 at start → backOp = 0 + (toBackOp - 0)*0 = 0
      // toBackOp is patched by beginColorTransition after target materials are built.
      this._setNodeTransitionOpacity(nodeId, 0.0, outlineSettings, 0);
      this._visTransitions.set(nodeId, {
        from: 0.0, to: 1.0,
        fromBackOp: 0, toBackOp: 0,        // toBackOp patched by beginColorTransition
        startMs: now, durationMs: Math.max(durationMs, 1),
        easeFn, hide: false,
      });
      // Hand off ownership: vis transition now drives this node's
      // opacity, so applyAll's pending-showing snap should ignore it.
      this._pendingShowingHidden.delete(nodeId);
    }
  }

  /**
   * Advance per-mesh visibility fade transitions by one frame.
   * Called each tick by steps._advanceObjectTransitions (AFTER advanceColorTransition).
   *
   * @param {number}  nowMs
   * @param {Map}     object3dById   steps.object3dById
   */
  advanceVisibilityTransitions(nowMs, object3dById) {
    if (!this._visTransitions.size) {
      // Even with no active fades, a deferred-hide may now be clear to finish
      // (its last fading descendant just completed on a prior frame).
      return this._flushDeferredHides(object3dById);
    }

    const outlineSettings = state.get('geometryOutline');
    const done            = [];

    for (const [nodeId, tr] of this._visTransitions) {
      const raw   = Math.max(0, Math.min((nowMs - tr.startMs) / tr.durationMs, 1));
      const alpha = tr.easeFn(raw);
      const t     = tr.from + (tr.to - tr.from) * alpha;

      // alpha (0→1) drives back opacity correctly for both directions:
      //   hiding:  fromBackOp→0       showing: 0→toBackOp
      const backOp = tr.fromBackOp + (tr.toBackOp - tr.fromBackOp) * alpha;
      this._setNodeTransitionOpacity(nodeId, t, outlineSettings, backOp);

      if (raw >= 1) done.push(nodeId);
    }

    for (const nodeId of done) {
      const tr = this._visTransitions.get(nodeId);
      this._visTransitions.delete(nodeId);

      if (tr.hide) {
        const obj = object3dById.get(nodeId);
        // V0.3.0.103 — if a DESCENDANT is still fading (e.g. an image shape placed
        // on this primitive, fading in the separate 'shape' channel), DON'T hide
        // obj yet — doing so would cascade-hide the descendant and snap its fade.
        // Keep it invisible via material opacity (already ~0) and defer the real
        // hide until the descendant finishes.
        if (obj && this._hasFadingDescendant(obj, object3dById)) {
          (this._deferredHides = this._deferredHides || new Set()).add(nodeId);
        } else {
          this._finishHide(nodeId, obj);
        }
      }
      // showing: already at t=1.0, outline opacity already at target — nothing more to do
    }
    // A descendant completing this frame may free a deferred ancestor.
    this._flushDeferredHides(object3dById);
    // V0.1.74: return true on the frame where the LAST transition just completed
    // (and no deferred hide is still pending) so the caller re-cascades ancestors.
    return done.length > 0 && this._visTransitions.size === 0 && !(this._deferredHides?.size);
  }

  /**
   * Declare the FULL set of node ids that will hide during the current step
   * transition (mesh + shape channels), set by steps.js before the phases run.
   * Lets a completed ancestor fade DEFER its real hide while a descendant is
   * still pending OR fading in a later phase. Resets the deferred set too.
   */
  setPendingHideSet(ids) {
    this._pendingHideIds = new Set(ids || []);
    this._deferredHides  = new Set();
  }

  /** True if any node still PENDING/active in the hide set is a descendant of `obj`. */
  _hasFadingDescendant(obj, object3dById) {
    if (!this._pendingHideIds?.size) return false;
    for (const otherId of this._pendingHideIds) {
      const o = object3dById.get(otherId);
      if (!o || o === obj) continue;
      let p = o.parent;
      while (p) { if (p === obj) return true; p = p.parent; }
    }
    return false;
  }

  /** Actually hide a completed hiding mesh + reset its fade material to 1.0. */
  _finishHide(nodeId, obj) {
    if (obj) obj.visible = false;
    const mesh = this.meshById.get(nodeId);
    if (mesh) this._setMaterialFade(mesh.material, 1.0);
    const bp = mesh?.userData?.falloffBackPass;
    if (bp) this._setMaterialFade(bp.material, 1.0);
    this._pendingHideIds?.delete(nodeId);
  }

  /** Finish any deferred hides whose descendants have all stopped fading. Returns
   * true if that drained the last pending hide (used as the re-cascade trigger). */
  _flushDeferredHides(object3dById) {
    if (!this._deferredHides?.size) return false;
    let flushed = false;
    for (const id of [...this._deferredHides]) {
      const obj = object3dById.get(id);
      if (!obj || !this._hasFadingDescendant(obj, object3dById)) {
        this._finishHide(id, obj);
        this._deferredHides.delete(id);
        flushed = true;
      }
    }
    return flushed && this._deferredHides.size === 0 && this._visTransitions.size === 0;
  }

  /**
   * Immediately zero transitionOpacity on "showing" meshes before a phased animation.
   * Called before the visibility phase starts so meshes remain invisible during
   * earlier phases (e.g. camera), then fade in when the visibility phase begins.
   *
   * @param {string[]} showingIds  mesh node IDs that will be fading in
   */
  snapShowingToZero(showingIds) {
    const outlineSettings = state.get('geometryOutline');
    for (const nodeId of showingIds) {
      this._setNodeTransitionOpacity(nodeId, 0.0, outlineSettings, 0);
      this._pendingShowingHidden.add(nodeId);
    }
  }

  /**
   * Cancel all in-progress visibility transitions immediately.
   * Resets transitionOpacity to 1.0 on all fading meshes.
   * The caller (applySnapshot / applySnapshotInstant) is responsible for setting
   * obj.visible to the correct final state.
   */
  cancelVisibilityTransitions() {
    if (!this._visTransitions.size) return;
    for (const [nodeId] of this._visTransitions) {
      const mesh = this.meshById.get(nodeId);
      if (mesh) this._setMaterialFade(mesh.material, 1.0);
      const bp = mesh?.userData?.falloffBackPass;
      if (bp) this._setMaterialFade(bp.material, 1.0);
    }
    this._visTransitions.clear();
  }

  /**
   * V0.3.0.127 — force EVERY flatShape's material back to full opacity.
   * Unlike regular meshes (rebuilt by applyAll → opacity self-restores to 1.0),
   * the flatShape branch of applyAll only writes color and never touches opacity
   * (materials.js ~860-882). So a fade interrupted by a snapshot snap / rapid
   * replay leaves a shape's opacity STRANDED: at 0 it renders as an outline /
   * sparse dither ("fade in then only an outline"); at 1 with obj.visible later
   * re-asserted it pops back ("fade out then pop"). The snapshot's obj.visible is
   * the sole authority for shown-vs-hidden — opacity is just reset to 1.0 so
   * visible shapes are solid and hidden ones (visible=false) are primed. Called at
   * every applySnapshotInstant finalize. Root fix for the recurring shape blink/
   * threshold/outline/pop family (3 independent audits converged here).
   */
  resetFlatShapeOpacities() {
    for (const [, mesh] of this.meshById) {
      if (!mesh?.userData?.flatShapeNodeId) continue;
      this._setMaterialFade(mesh.material, 1.0);
      const bp = mesh.userData?.falloffBackPass;
      if (bp) this._setMaterialFade(bp.material, 1.0);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  ASSIGNMENT
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Assign a color preset to one or more mesh node IDs.
   * @param {string[]} meshNodeIds
   * @param {string}   presetId
   */
  assignPreset(meshNodeIds, presetId) {
    meshNodeIds.forEach(id => { this.meshColorAssignments[id] = presetId; });
    state.markDirty();
    this.applyAll();
  }

  /**
   * Remove preset assignment from one or more mesh node IDs
   * (restores original material).
   */
  removePreset(meshNodeIds) {
    meshNodeIds.forEach(id => { delete this.meshColorAssignments[id]; });
    state.markDirty();
    this.applyAll();
  }

  /**
   * Remap mesh node IDs after model reload (fresh IDs → saved IDs).
   * Called during project open / asset relink so color assignments survive.
   * @param {Map<string,string>} idMap  freshId → savedId
   */
  remapMeshIds(idMap) {
    const remapObj = (obj) => {
      const remapped = {};
      for (const [k, v] of Object.entries(obj)) {
        const newKey = idMap.has(k) ? idMap.get(k) : k;
        remapped[newKey] = v;
      }
      return remapped;
    };

    // Remap the live mesh registry (fresh IDs → saved IDs)
    // Must happen first so applyAll() can match saved assignments to meshes.
    for (const [freshId, savedId] of idMap) {
      if (freshId === savedId) continue;
      if (this.meshById.has(freshId)) {
        this.meshById.set(savedId, this.meshById.get(freshId));
        this.meshById.delete(freshId);
      }
      if (this._outlineMeshes.has(freshId)) {
        this._outlineMeshes.set(savedId, this._outlineMeshes.get(freshId));
        this._outlineMeshes.delete(freshId);
      }
      if (this._outlineBackMeshes.has(freshId)) {
        this._outlineBackMeshes.set(savedId, this._outlineBackMeshes.get(freshId));
        this._outlineBackMeshes.delete(freshId);
      }
      // B2/M16 (V0.3.2.106): was `this._originalMaterials` — a field that
      // does not exist (the real one is `originalMaterials`); the optional
      // chain silently skipped the whole block, so originals were never
      // remapped to saved IDs: solid-override off / revert showed the wrong
      // look and textured parts lost their maps after reopen or relink.
      if (this.originalMaterials.has(freshId)) {
        this.originalMaterials.set(savedId, this.originalMaterials.get(freshId));
        this.originalMaterials.delete(freshId);
      }
    }

    this.meshColorAssignments = remapObj(this.meshColorAssignments);
    this.meshDefaultColors    = remapObj(this.meshDefaultColors);
  }

  /**
   * Remove all references to a deleted preset from assignments.
   */
  pruneDeletedPreset(presetId) {
    let changed = false;
    for (const [k, v] of Object.entries(this.meshColorAssignments)) {
      if (v === presetId) { delete this.meshColorAssignments[k]; changed = true; }
    }
    if (changed) this.applyAll();
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  TRANSITION FADE
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Set the transition opacity on all active materials (0 = invisible, 1 = opaque).
   * Used during step transitions for smooth material cross-fades.
   */
  setTransitionOpacity(value) {
    for (const [, mesh] of this.meshById) {
      this._setMaterialFade(mesh.material, value);
      const back = mesh.userData.falloffBackPass;
      if (back) this._setMaterialFade(back.material, value);
    }
  }

  _setMaterialFade(material, value) {
    if (!material) return;
    let handled = false;
    if (material.userData?.transitionFadeState) {
      material.userData.transitionFadeState.value = value;
      handled = true;
    }
    if (material.isShaderMaterial && material.uniforms?.transitionOpacity) {
      material.uniforms.transitionOpacity.value = value;
      handled = true;
    }
    // Fallback for plain transparent materials (flatShape MeshBasicMaterial
    // doesn't carry the dither-fade shader chunk regular meshes get).
    // Direct alpha works fine since the material was built with
    // transparent=true. Skip if the material isn't already marked
    // transparent — flipping it dynamically requires needsUpdate.
    if (!handled && material.transparent === true && 'opacity' in material) {
      material.opacity = value;
      handled = true;
    }
    // V0.3.0.114 — last resort: an OPAQUE material that never got the dither chunk
    // (e.g. a primitive material restored from its clean original, or registered
    // before the patch shipped). Install it now so it fades instead of snapping.
    if (!handled && !material.isShaderMaterial && material.transparent !== true) {
      this._patchScreenDoorFade(material);
      if (material.userData?.transitionFadeState) material.userData.transitionFadeState.value = value;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  GEOMETRY OUTLINES
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Apply/update geometry outline wireframes for all meshes.
   * Settings come from state.geometryOutline.
   */
  /**
   * Build a BufferGeometry for smart outlines.
   * Like EdgesGeometry but each edge vertex carries an `aNormal` attribute —
   * the average normal of the two adjacent faces. The outline shader uses this
   * to classify edges as front- or back-facing per-fragment without any
   * depth-write dependency.
   */
  _buildAnnotatedEdgeGeometry(geometry, thresholdAngle = 35) {
    const geo     = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    const posAttr = geo.attributes.position;
    const triCount = posAttr.count / 3;

    const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
    const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

    // ── Per-face normals ──────────────────────────────────────────────────
    const faceNormals = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
      _a.fromBufferAttribute(posAttr, t * 3);
      _b.fromBufferAttribute(posAttr, t * 3 + 1);
      _c.fromBufferAttribute(posAttr, t * 3 + 2);
      _e1.subVectors(_b, _a);
      _e2.subVectors(_c, _a);
      const n = new THREE.Vector3().crossVectors(_e1, _e2);
      faceNormals[t] = n.length() > 1e-10 ? n.normalize() : new THREE.Vector3(0, 1, 0);
    }

    // ── Edge map: position-keyed → { va, vb, normals[] } ─────────────────
    const PREC = 1e4;
    const pk   = v =>
      `${Math.round(v.x * PREC)},${Math.round(v.y * PREC)},${Math.round(v.z * PREC)}`;
    const edgeMap = new Map();
    const _p = new THREE.Vector3(), _q = new THREE.Vector3();

    for (let t = 0; t < triCount; t++) {
      const fn = faceNormals[t];
      for (let e = 0; e < 3; e++) {
        _p.fromBufferAttribute(posAttr, t * 3 + e);
        _q.fromBufferAttribute(posAttr, t * 3 + (e + 1) % 3);
        const kp = pk(_p), kq = pk(_q);
        const key = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
        if (!edgeMap.has(key)) edgeMap.set(key, { va: _p.clone(), vb: _q.clone(), normals: [] });
        edgeMap.get(key).normals.push(fn.clone());
      }
    }

    // ── Build output arrays ───────────────────────────────────────────────
    const cosThresh = Math.cos(THREE.MathUtils.degToRad(thresholdAngle));
    const outPos = [], outNorm = [];

    for (const { va, vb, normals } of edgeMap.values()) {
      let avg;
      if (normals.length === 1) {
        avg = normals[0];                              // boundary edge
      } else if (normals.length >= 2) {
        if (normals[0].dot(normals[1]) > cosThresh) continue; // smooth — skip
        avg = normals[0].clone().add(normals[1]).normalize();  // crease edge
      } else continue;

      outPos.push( va.x, va.y, va.z,  vb.x, vb.y, vb.z);
      outNorm.push(avg.x, avg.y, avg.z, avg.x, avg.y, avg.z);
    }

    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(outPos,  3));
    result.setAttribute('aNormal',  new THREE.Float32BufferAttribute(outNorm, 3));
    return result;
  }

  applyGeometryOutlines() {
    const settings = state.get('geometryOutline');
    if (!settings) return;

    const overrideMode = state.get('solidOverride');
    const presets      = state.get('colorPresets') || [];
    const presetById   = new Map(presets.map(p => [p.id, p]));

    for (const [nodeId, mesh] of this.meshById) {
      // 🖐 V0.3.4.156 — never on a hand: an edge outline is built from the bind-pose
      // geometry, so on a skinned hand it drew the rest pose over the posed one, and
      // on the capsules it is noise. The user: "drop it on hands".
      if (!settings.enabled || mesh.userData?.handNodeId) {
        this._removeOutline(nodeId);
        continue;
      }

      const color   = settings.color   ?? '#000000';
      const opacity = settings.opacity ?? 0.9;

      // ── Front-pass outline (smart shader, depthTest=true) ─────────────────
      // Discards back-facing edges in the fragment shader via face-normal dot
      // with view direction — no depth-write dependency, no threshold jump.
      let outline = this._outlineMeshes.get(nodeId);
      if (!outline) {
        const edgeGeo = this._buildAnnotatedEdgeGeometry(
          mesh.geometry, settings.creaseAngle ?? 35
        );
        const frontMat = new THREE.ShaderMaterial({
          uniforms:       { uColor: { value: new THREE.Color(color) },
                            uOpacity: { value: opacity } },
          vertexShader:   SMART_OUTLINE_VERT,
          fragmentShader: SMART_FRONT_FRAG,
          transparent:    true,
          depthTest:      true,
          depthWrite:     false,
        });
        outline = new THREE.LineSegments(edgeGeo, frontMat);
        outline.raycast           = () => {};
        outline.userData.noSelect = true;
        mesh.add(outline);
        this._outlineMeshes.set(nodeId, outline);
      } else {
        outline.material.uniforms.uColor.value.set(color);
        outline.material.uniforms.uOpacity.value = opacity;
      }

      // ── Back-pass outline (smart shader) ──────────────────────────────────
      // Discards front-facing edges — only back/hidden edges drawn.
      //
      // V0.3.4.157 — drawn FIRST in the transparent queue (renderOrder −1) WITH the
      // depth test. The opaque objects are already in the depth buffer, so one in
      // front hides the lines; the semi-transparent body they belong to is not yet
      // drawn, so it does not — and when it draws, it is blended OVER its own back
      // lines, which then read as seen through it. The old pass (depth test off,
      // drawn after everything, guarded only by a stencil that just some opaque
      // materials write) put the lines over the object's own front faces and over
      // any object that should have covered them.
      //
      // Fade range: solidness ≥ 0.9 → uOpacity 0.0  (invisible)
      //             solidness ≤ 0.3 → uOpacity 1.0  (fully visible)
      let outlineBack = this._outlineBackMeshes.get(nodeId);
      if (!outlineBack) {
        const backMat = new THREE.ShaderMaterial({
          uniforms:       { uColor: { value: new THREE.Color(color) },
                            uOpacity: { value: 0 } },
          vertexShader:   SMART_OUTLINE_VERT,
          fragmentShader: SMART_BACK_FRAG,
          transparent:    true,
          depthTest:      true,
          depthWrite:     false,
        });
        // Share the annotated geometry with the front-pass
        outlineBack = new THREE.LineSegments(outline.geometry, backMat);
        outlineBack.raycast           = () => {};
        outlineBack.userData.noSelect = true;
        outlineBack.visible           = false;
        mesh.add(outlineBack);
        this._outlineBackMeshes.set(nodeId, outlineBack);
      } else {
        outlineBack.material.uniforms.uColor.value.set(color);
      }
      // (also migrates a back pass built by an older version in this session)
      if (!outlineBack.material.depthTest || outlineBack.material.stencilWrite) {
        outlineBack.material.depthTest    = true;
        outlineBack.material.stencilWrite = false;
        outlineBack.material.needsUpdate  = true;
      }
      outlineBack.renderOrder = -1;

      // Update back-pass opacity for current solidness
      const presetId  = this.meshColorAssignments[nodeId];
      const preset    = presetId ? presetById.get(presetId) : null;
      const solidness = (overrideMode && preset) ? (preset.solidness ?? 1.0) : 1.0;
      this._updateOutlineBackOpacity(nodeId, solidness, settings);
    }
  }

  /**
   * Update back-pass outline opacity from solidness ramp.
   * solidness ≥ 0.9 → 0%   solidness ≤ 0.3 → 100%  (linear between)
   */
  _updateOutlineBackOpacity(nodeId, solidness, settings) {
    const back = this._outlineBackMeshes.get(nodeId);
    if (!back) return;
    if (!settings?.enabled) { back.visible = false; return; }

    const globalOpacity = settings.opacity ?? 0.9;
    const backOpacity   = Math.min(1, Math.max(0, (0.9 - solidness) / 0.6)) * globalOpacity;

    back.material.uniforms.uOpacity.value = backOpacity;
    back.visible = backOpacity > 0.001;
  }

  setGeometryOutline(settings) {
    state.setState({ geometryOutline: { ...state.get('geometryOutline'), ...settings } });
    this.applyGeometryOutlines();
  }

  _removeOutline(nodeId) {
    // Remove back-pass FIRST (it shares geometry with front-pass)
    const back = this._outlineBackMeshes.get(nodeId);
    if (back) {
      back.parent?.remove(back);
      back.material?.dispose(); // geometry is shared — do NOT dispose here
      this._outlineBackMeshes.delete(nodeId);
    }
    const outline = this._outlineMeshes.get(nodeId);
    if (outline) {
      outline.parent?.remove(outline);
      outline.geometry?.dispose();
      outline.material?.dispose();
      this._outlineMeshes.delete(nodeId);
    }
  }

  clearAllOutlines() {
    for (const [nodeId] of this._outlineMeshes) this._removeOutline(nodeId);
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  SELECTION HIGHLIGHT  — back-face hull approach
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Apply/remove selection highlight on all meshes.
   *
   * Technique: a second Mesh is added as a child of the selected mesh,
   * using BackSide rendering scaled slightly larger (1.008×) with a
   * solid colour. This creates a clean silhouette outline that works
   * with solid AND transparent/falloff materials.
   *
   * @param {string[] | Set<string>} [meshIds]  override (default: internal set)
   */
  applySelectionHighlight(meshIds) {
    const selected = meshIds instanceof Set
      ? meshIds
      : meshIds
        ? new Set(meshIds)
        : this._selectedMeshIds;

    const color = state.get('selectionOutlineColor') ?? '#00ffff';

    // ── Fix A (V0.1.66): diff-based update ─────────────────────────────
    // Previously this iterated EVERY registered mesh in the scene on
    // every selection change — O(total meshes) per click. With bake-and
    // -flatten producing flat models (hundreds of mesh siblings under
    // one model), that's ~500 _applySelectionHull calls just to expand
    // a selection by one item.
    //
    // Track the last-applied selection set and only touch meshes whose
    // selected-state actually CHANGED since last call. Net work:
    //   O(symmetricDifference(prev, current)) — typically 1 or 2 meshes
    //   per click, regardless of scene size.
    //
    // First-time path: prev is empty, work is bounded by `selected`.
    // Color-only changes (no id changes): zero work — the diff is
    // empty. setSelectionOutlineColor still works because it nukes
    // _lastHighlightedIds first (see below) to force a full re-pass.
    // V0.2.18: when the PRIMARY selection is a locked folder, render the
    // descendant meshes with the OUTLINE only — no surface tint. A locked
    // folder selection often includes hundreds of meshes, and the cyan
    // overlay on every face buries the scene colors (impossible to align
    // / move things). Outline alone keeps the silhouette readable while
    // the faces show their real material.
    const _selPrimary = (() => {
      const id = state.get('selectedId');
      const nb = state.get('nodeById');
      return id && nb ? nb.get(id) : null;
    })();
    const outlineOnly = !!(_selPrimary && _selPrimary.type === 'folder' && _selPrimary.locked === true);
    // V0.2.20 bug-fix: previously, when outlineOnly toggled we cleared
    // `_lastHighlightedIds` to force a re-pass — but that also wiped the
    // STRIP loop's view of what was previously highlighted, so old hulls
    // never got removed (sticky cyan after deselecting a locked folder).
    // Keep two views:
    //   prevAll   — full previous selection, used for the STRIP pass so
    //               we always remove hulls from meshes that left the set.
    //   prevApply — empty when we want to force every selected mesh to
    //               re-run through _applySelectionHull (color-update
    //               branch will flip overlay.visible to the new outlineOnly).
    const prevAll    = this._lastHighlightedIds || new Set();
    const forceRepass = (this._lastOutlineOnly !== outlineOnly);
    if (forceRepass) this._lastOutlineOnly = outlineOnly;
    const prevApply = forceRepass ? new Set() : prevAll;

    // Newly selected — apply hull (or re-run all on outlineOnly toggle).
    for (const id of selected) {
      if (prevApply.has(id)) continue;
      const mesh = this.meshById.get(id);
      if (mesh) this._applySelectionHull(mesh, true, color, null, { outlineOnly });
    }
    // Newly deselected — strip hull. Use prevAll so stale hulls left from
    // a locked-folder selection are ALWAYS cleaned up.
    for (const id of prevAll) {
      if (selected.has(id)) continue;
      const mesh = this.meshById.get(id);
      if (mesh) this._applySelectionHull(mesh, false, color);
    }
    this._lastHighlightedIds = new Set(selected);
    // V0.2.7: any mesh currently in the expanded-color highlight set must
    // keep its cyan hull SUPPRESSED so the yellow on top doesn't mix with
    // it (selection changes may have just (re-)created the cyan hull).
    if (this._expColorHighlightIds && this._expColorHighlightIds.size > 0) {
      for (const id of this._expColorHighlightIds) {
        const m = this.meshById.get(id);
        if (m && selected.has(id)) this._setSelectionHullVisible(m, false);
      }
    }
  }

  // ── Ray-select candidate preview (V0.1.90) ────────────────────────────
  // A SEPARATE highlight channel (own userData keys) that coexists with the
  // selection highlight, so the persistent cyan selection stays visible
  // while the user cycles candidates in a different hue. Diff-based like the
  // selection path. clearPreviewHighlight() strips it (on confirm/cancel).
  applyPreviewHighlight(meshIds, color) {
    const want = meshIds instanceof Set ? meshIds : new Set(meshIds || []);
    const prev = this._previewMeshIds || new Set();
    const keys = { overlay: 'sbsPreviewOverlay', outline: 'sbsPreviewOutline', opacity: 0.30 };
    for (const id of want) {
      const m = this.meshById.get(id);
      if (m) this._applySelectionHull(m, true, color, keys);
    }
    for (const id of prev) {
      if (want.has(id)) continue;
      const m = this.meshById.get(id);
      if (m) this._applySelectionHull(m, false, color, keys);
    }
    this._previewMeshIds = new Set(want);
  }

  clearPreviewHighlight() {
    const keys = { overlay: 'sbsPreviewOverlay', outline: 'sbsPreviewOutline', opacity: 0.30 };
    for (const id of (this._previewMeshIds || new Set())) {
      const m = this.meshById.get(id);
      if (m) this._applySelectionHull(m, false, '#000000', keys);
    }
    this._previewMeshIds = new Set();
  }

  // ── Shape-tab highlight (V0.2.1) ───────────────────────────────────────
  // Dedicated channel driven by shape-tab selection. For VISIBLE instances:
  // paints a hull (overlay + edge outline) using its own userData keys so it
  // coexists with the normal selection / preview channels — skipped on
  // meshes already in the scene selection to avoid a double overlay. For
  // HIDDEN instances: renders a "ghost" LineSegments parented to the SCENE
  // root (not the mesh) so it stays visible regardless of any ancestor's
  // visibility cascade. The ghost mirrors the mesh's world transform.
  applyShapeTabHighlight(meshIds) {
    const want  = meshIds instanceof Set ? meshIds : new Set(meshIds || []);
    const prev  = this._shapeTabHighlightIds || new Set();
    const color = state.get('selectionOutlineColor') ?? '#00ffff';
    const keys  = { overlay: 'sbsShapeTabOverlay', outline: 'sbsShapeTabOutline', opacity: 0.20 };

    // Drop meshes no longer in the set (strip hull + ghost).
    for (const id of prev) {
      if (want.has(id)) continue;
      const m = this.meshById.get(id);
      if (m) this._applySelectionHull(m, false, color, keys);
      this._removeShapeGhost(id);
    }
    // Add / refresh meshes in the set.
    for (const id of want) {
      const m = this.meshById.get(id);
      if (!m) { this._removeShapeGhost(id); continue; }
      let visible = true;
      for (let o = m; o; o = o.parent) { if (o.visible === false) { visible = false; break; } }
      if (visible) {
        // Drop any stale ghost; skip hull when the mesh is already in scene
        // selection (the cyan selection hull is already drawn there).
        this._removeShapeGhost(id);
        if (this._selectedMeshIds?.has(id)) {
          // strip our channel if it had been applied earlier
          this._applySelectionHull(m, false, color, keys);
        } else {
          this._applySelectionHull(m, true, color, keys);
        }
      } else {
        // Hidden — no normal hull (parent invisible). Render a ghost at the scene root.
        this._applySelectionHull(m, false, color, keys);
        this._addShapeGhost(id, m, color);
      }
    }
    this._shapeTabHighlightIds = new Set(want);
  }

  clearShapeTabHighlight() {
    const color = state.get('selectionOutlineColor') ?? '#00ffff';
    const keys  = { overlay: 'sbsShapeTabOverlay', outline: 'sbsShapeTabOutline', opacity: 0.20 };
    for (const id of (this._shapeTabHighlightIds || new Set())) {
      const m = this.meshById.get(id);
      if (m) this._applySelectionHull(m, false, color, keys);
      this._removeShapeGhost(id);
    }
    this._shapeTabHighlightIds = new Set();
  }

  _addShapeGhost(meshNodeId, mesh, color) {
    this._removeShapeGhost(meshNodeId);
    if (!mesh.geometry) return;
    let edgesGeo = _sbsEdgesGeoCache.get(mesh.geometry);
    if (!edgesGeo) {
      edgesGeo = new THREE.EdgesGeometry(mesh.geometry, 15);
      _sbsEdgesGeoCache.set(mesh.geometry, edgesGeo);
    }
    const mat = new THREE.LineBasicMaterial({
      color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85,
    });
    const ghost = new THREE.LineSegments(edgesGeo, mat);
    mesh.updateMatrixWorld(true);
    ghost.matrix.copy(mesh.matrixWorld);
    ghost.matrixAutoUpdate = false;
    ghost.renderOrder       = 999;
    ghost.frustumCulled     = false;
    ghost.userData.noSelect = true;
    ghost.raycast           = () => {};
    // Attach to the very top of the parent chain (the Three.js Scene) so the
    // ghost survives any hidden ancestor in the mesh's visibility cascade.
    let sceneRoot = mesh;
    while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
    sceneRoot.add(ghost);
    this._shapeGhostById.set(meshNodeId, ghost);
  }

  _removeShapeGhost(meshNodeId) {
    const g = this._shapeGhostById?.get(meshNodeId);
    if (!g) return;
    if (g.parent) g.parent.remove(g);
    g.material?.dispose();
    // geometry is shared from the WeakMap cache — do NOT dispose.
    this._shapeGhostById.delete(meshNodeId);
  }

  // ── Expanded-color highlight (V0.2.6) ──────────────────────────────────
  // When a color is expanded in the Colors tab, the meshes that USE that
  // color AND are scene-selected light up. Visible meshes get a YELLOW hull
  // (same hue as the expanded row's outline); HIDDEN meshes get a MAGENTA
  // ghost outline parented to the scene root so the user can see *where*
  // the hidden geometry sits even though its material is invisible.
  applyExpandedColorHighlight(meshIds) {
    const want    = meshIds instanceof Set ? meshIds : new Set(meshIds || []);
    const prev    = this._expColorHighlightIds || new Set();
    // V0.2.7: yellow/magenta are HUE-SHIFTS from the current selection color
    // (defaults: cyan #00ffff → yellow +240°, magenta +120°). Changing the
    // selection color retunes them automatically — see setSelectionOutlineColor.
    const base    = state.get('selectionOutlineColor') ?? '#00ffff';
    const yellow  = _hueShiftHex(base, 240);
    const magenta = _hueShiftHex(base, 120);
    const keys    = { overlay: 'sbsExpColorOverlay', outline: 'sbsExpColorOutline', opacity: 0.45 };

    for (const id of prev) {
      if (want.has(id)) continue;
      const m = this.meshById.get(id);
      if (m) {
        this._applySelectionHull(m, false, yellow, keys);
        this._setSelectionHullVisible(m, true);   // restore cyan if mesh still in scene selection
      }
      this._removeExpandedColorGhost(id);
    }
    for (const id of want) {
      const m = this.meshById.get(id);
      if (!m) { this._removeExpandedColorGhost(id); continue; }
      let visible = true;
      for (let o = m; o; o = o.parent) { if (o.visible === false) { visible = false; break; } }
      if (visible) {
        this._removeExpandedColorGhost(id);
        this._applySelectionHull(m, true, yellow, keys);
        // Hide the cyan selection hull so the yellow doesn't tint-mix with it.
        this._setSelectionHullVisible(m, false);
      } else {
        this._applySelectionHull(m, false, yellow, keys);
        this._setSelectionHullVisible(m, true);   // hidden mesh: cyan also hidden via parent, harmless
        this._addExpandedColorGhost(id, m, magenta);
      }
    }
    this._expColorHighlightIds = new Set(want);
  }

  clearExpandedColorHighlight() {
    const base    = state.get('selectionOutlineColor') ?? '#00ffff';
    const yellow  = _hueShiftHex(base, 240);
    const keys    = { overlay: 'sbsExpColorOverlay', outline: 'sbsExpColorOutline', opacity: 0.45 };
    for (const id of (this._expColorHighlightIds || new Set())) {
      const m = this.meshById.get(id);
      if (m) {
        this._applySelectionHull(m, false, yellow, keys);
        this._setSelectionHullVisible(m, true);
      }
      this._removeExpandedColorGhost(id);
    }
    this._expColorHighlightIds = new Set();
  }

  // V0.2.7: show/hide the cyan selection overlay+outline children on a
  // single mesh (without removing them). Used to suppress the cyan hull
  // while the expanded-color YELLOW hull is on top, so the two don't
  // tint-mix into a muddy color.
  _setSelectionHullVisible(mesh, visible) {
    const ov = mesh.userData?.sbsSelectionOverlay;
    // V0.2.20: when the primary selection is a locked folder we keep the
    // SURFACE overlay hidden (outline-only). Honour that on "restore"
    // calls so collapsing an expanded-color row doesn't pop the cyan
    // surface tint back on top of locked-folder meshes.
    if (ov) ov.visible = visible && !this._lastOutlineOnly;
    const ou = mesh.userData?.sbsSelectionOutline;
    if (ou) ou.visible = visible;
  }

  _addExpandedColorGhost(meshNodeId, mesh, color) {
    this._removeExpandedColorGhost(meshNodeId);
    if (!mesh.geometry) return;
    let edgesGeo = _sbsEdgesGeoCache.get(mesh.geometry);
    if (!edgesGeo) {
      edgesGeo = new THREE.EdgesGeometry(mesh.geometry, 15);
      _sbsEdgesGeoCache.set(mesh.geometry, edgesGeo);
    }
    const mat = new THREE.LineBasicMaterial({
      color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95,
    });
    const ghost = new THREE.LineSegments(edgesGeo, mat);
    mesh.updateMatrixWorld(true);
    ghost.matrix.copy(mesh.matrixWorld);
    ghost.matrixAutoUpdate = false;
    ghost.renderOrder       = 999;
    ghost.frustumCulled     = false;
    ghost.userData.noSelect = true;
    ghost.raycast           = () => {};
    let sceneRoot = mesh;
    while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
    sceneRoot.add(ghost);
    this._expColorGhostById.set(meshNodeId, ghost);
  }

  _removeExpandedColorGhost(meshNodeId) {
    const g = this._expColorGhostById?.get(meshNodeId);
    if (!g) return;
    if (g.parent) g.parent.remove(g);
    g.material?.dispose();
    this._expColorGhostById.delete(meshNodeId);
  }

  /**
   * Create or remove the selection overlay + edge outline on a single mesh.
   *
   * Replaces the old BackSide scaled hull which broke on geometry not centred
   * at its local origin (the hull would expand toward world-space origin).
   *
   * New approach:
   *   • sbsSelectionOverlay — FrontSide MeshBasicMaterial at 70% opacity,
   *     depthTest:false so it always sits on top of the surface.
   *   • sbsSelectionOutline — EdgesGeometry LineSegments at 100% opacity,
   *     depthTest:false so edges always draw over geometry, no z-fighting.
   */
  _applySelectionHull(mesh, isSelected, color, keys = null, opts = null) {
    const OVERLAY_KEY = keys?.overlay ?? 'sbsSelectionOverlay';
    const OUTLINE_KEY = keys?.outline ?? 'sbsSelectionOutline';
    const OVERLAY_OPACITY = keys?.opacity ?? 0.20;
    // V0.2.18: outlineOnly hides the surface tint (keeps the outline). Used
    // for locked-folder selections so the underlying scene colors stay
    // legible across a large descendant set.
    const outlineOnly = !!opts?.outlineOnly;

    // ── Remove ────────────────────────────────────────────────────────────
    if (!isSelected) {
      const overlay = mesh.userData[OVERLAY_KEY];
      if (overlay) {
        mesh.remove(overlay);
        overlay.material.dispose();
        delete mesh.userData[OVERLAY_KEY];
      }
      const outline = mesh.userData[OUTLINE_KEY];
      if (outline) {
        mesh.remove(outline);
        outline.material.dispose();
        // Fix B (V0.1.66): do NOT dispose outline.geometry — it's the
        // cached sbsEdgesGeo stashed on mesh.geometry.userData. Disposing
        // here would force a re-compute on every re-select of this mesh.
        // We trade a small persistent memory cost for repeat-select speed.
        delete mesh.userData[OUTLINE_KEY];
      }
      return;
    }

    // ── Update colour only if both already exist ──────────────────────────
    if (mesh.userData[OVERLAY_KEY] && mesh.userData[OUTLINE_KEY]) {
      mesh.userData[OVERLAY_KEY].material.color.set(color);
      mesh.userData[OUTLINE_KEY].material.color.set(color);
      mesh.userData[OVERLAY_KEY].visible = !outlineOnly;
      return;
    }

    // ── Create overlay (front-face, low-opacity surface tint) ─────────────
    // 0.20 — matches the project's Solidness falloff translucency level
    // so users can still SEE the underlying mesh colour and discern
    // hidden / faded states through the highlight. The crisp edge
    // outline below carries the "this is selected" information; the
    // surface tint just disambiguates membership when many meshes are
    // selected at once.
    const overlayMat = new THREE.MeshBasicMaterial({
      color,
      transparent:  true,
      opacity:      OVERLAY_OPACITY,
      depthTest:    false,
      depthWrite:   false,
      side:         THREE.FrontSide,
    });
    const overlay = new THREE.Mesh(mesh.geometry, overlayMat);
    overlay.raycast          = () => {};
    overlay.frustumCulled    = mesh.frustumCulled;
    overlay.matrixAutoUpdate = true;
    overlay.userData.noSelect = true;
    overlay.visible          = !outlineOnly;
    mesh.add(overlay);
    mesh.userData[OVERLAY_KEY] = overlay;

    // ── Create edge outline (LineSegments, 100% opacity) ──────────────────
    // Fix B (V0.1.66 → V0.1.70): EdgesGeometry is the expensive bit
    // (CPU edge-extraction over every triangle). Cache it via a module-
    // level WeakMap keyed by the source BufferGeometry. WeakMap was
    // chosen over `geometry.userData` because EdgesGeometry holds a
    // back-reference to its source via `.parameters.geometry` — stashing
    // it on userData closed a JSON cycle that blew up
    // _cloneTreeWithoutObject3d during delete-assembly (V0.1.69 bug).
    // The WeakMap auto-evicts when the source geometry is disposed and
    // GC'd; no manual cleanup needed.
    let edgesGeo = _sbsEdgesGeoCache.get(mesh.geometry);
    if (!edgesGeo) {
      edgesGeo = new THREE.EdgesGeometry(mesh.geometry, 15); // 15° crease threshold
      _sbsEdgesGeoCache.set(mesh.geometry, edgesGeo);
    }
    const edgesMat = new THREE.LineBasicMaterial({
      color,
      depthTest:  false,
      depthWrite: false,
    });
    const outline = new THREE.LineSegments(edgesGeo, edgesMat);
    outline.raycast          = () => {};
    outline.frustumCulled    = mesh.frustumCulled;
    outline.matrixAutoUpdate = true;
    outline.userData.noSelect = true;
    mesh.add(outline);
    mesh.userData[OUTLINE_KEY] = outline;
  }

  setSelectionOutlineColor(hex) {
    this._selectionColor = hex;
    state.setState({ selectionOutlineColor: hex });
    // Fix A's diff cache would short-circuit this call (selection set
    // unchanged) — but we want every existing overlay's colour to
    // refresh. Wipe the cache to force a full re-pass through
    // _applySelectionHull's color-update branch.
    this._lastHighlightedIds = null;
    this.applySelectionHighlight();
    // V0.2.7: yellow/magenta hulls are hue-shifts of the selection color —
    // re-apply them so they retune to the new palette.
    if (this._expColorHighlightIds && this._expColorHighlightIds.size > 0) {
      this.applyExpandedColorHighlight([...this._expColorHighlightIds]);
    }
  }

  /**
   * Hide or restore the per-mesh selection overlay/outline children. Used
   * by the thumbnail capture path so saved previews never carry the cyan
   * highlight of whatever was selected at capture time.
   *
   * Visibility-only toggle (no material changes), so the next render brings
   * everything back instantly with zero side effects.
   */
  setSelectionVisualsVisible(visible) {
    for (const mesh of this.meshById.values()) {
      const overlay = mesh.userData?.sbsSelectionOverlay;
      const outline = mesh.userData?.sbsSelectionOutline;
      if (overlay) overlay.visible = visible;
      if (outline) outline.visible = visible;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  COLOR PRESET CRUD
  // ═══════════════════════════════════════════════════════════════════════
  createPreset(overrides = {}) {
    const preset = createColorPreset(overrides);
    this.ensurePresetDefaults(preset);
    const presets = [...state.get('colorPresets'), preset];
    state.setState({ colorPresets: presets });
    state.markDirty();
    state.emit('materials:presetCreated', preset);
    return preset;
  }

  updatePreset(presetId, updates) {
    const presets = state.get('colorPresets');
    const idx     = presets.findIndex(p => p.id === presetId);
    if (idx < 0) return;
    Object.assign(presets[idx], updates);
    state.setState({ colorPresets: [...presets] });
    state.markDirty();
    this.applyAll();
    state.emit('materials:presetUpdated', presets[idx]);
  }

  deletePreset(presetId) {
    // Safety guard — UI must call defaultColorMeshCount() first and block if > 0.
    // This prevents accidental deletion even if the UI check is bypassed.
    if (this.isDefaultPreset(presetId)) return;

    const presets = state.get('colorPresets').filter(p => p.id !== presetId);
    state.setState({ colorPresets: presets });
    this.pruneDeletedPreset(presetId);
    state.markDirty();
    state.emit('materials:presetDeleted', presetId);
  }

  getPresetById(presetId) {
    return state.get('colorPresets').find(p => p.id === presetId) ?? null;
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  REGISTER / UNREGISTER MESHES (called by importers.js)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Register a loaded Three.js mesh and store its original material.
   * Called once per mesh when a model is imported.
   *
   * @param {string}     nodeId   data tree mesh node ID
   * @param {THREE.Mesh} mesh     Three.js mesh
   */
  registerMesh(nodeId, mesh) {
    this.meshById.set(nodeId, mesh);
    // SSR G-buffer prepass hook (no-op outside the prepass). Feeds this mesh's
    // material roughness / reflectionIntensity / solidness + reflective flag.
    mesh.onBeforeRender = ssrPrepassHook;
    // Store original material (deep-clone to avoid sharing) — capture it CLEAN,
    // before the screen-door patch below, so a later restore-to-original is pristine.
    if (mesh.material && !this.originalMaterials.has(nodeId)) {
      this.originalMaterials.set(nodeId, mesh.material.clone());
    }
    // V0.3.0.114 — make every OPAQUE registered mesh dither-fadeable during step
    // transitions. Previously only the managed (colored) material got the screen-door
    // patch (see _buildManagedMaterial), so a freshly-created primitive's raw
    // MeshStandardMaterial couldn't fade and snapped ("pop in/out"). Skip transparent
    // materials (flatShapes) — those fade via the opacity fallback in _setMaterialFade.
    if (mesh.material && !Array.isArray(mesh.material) && mesh.material.transparent !== true) {
      this._patchScreenDoorFade(mesh.material);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  BASE COLOR EXTRACTION  (auto-runs on every model import)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Extract base colors from newly imported meshes and create/assign presets.
   *
   * For each mesh in meshNodeIds:
   *   1. Read the stored original material's color (hex).
   *   2. Find an existing ColorPreset with that color, or create one.
   *      Deduplication is by exact lowercase hex string — two meshes with
   *      identical colors share one preset.
   *   3. Assign the preset to the mesh via meshColorAssignments.
   *
   * Also enables solidOverride so presets take effect immediately.
   * Existing presets from prior imports are reused when the hex matches —
   * loading the same file twice won't create duplicate presets.
   *
   * @param {string[]} meshNodeIds  node IDs of newly imported mesh nodes
   */
  /**
   * Extract base colors from newly imported meshes and create/assign presets.
   *
   * @param {string[]} meshNodeIds   node IDs of newly imported mesh nodes
   * @param {object}   opts
   * @param {boolean}  opts.globalDedup  true (default) = reuse existing presets
   *                                     that share the same hex color globally.
   *                                     false = deduplicate only within this
   *                                     import batch (use for GLTF/GLB/FBX so
   *                                     two unrelated models don't share presets
   *                                     just because they both have white parts).
   */
  extractBaseColors(meshNodeIds, { globalDedup = true } = {}) {
    if (!meshNodeIds?.length) return;

    // Seed the dedup map from existing presets (or start empty for per-model dedup).
    const existing    = state.get('colorPresets');
    const presetByHex = globalDedup
      ? new Map(existing.map(p => [p.color?.toLowerCase(), p]))
      : new Map();

    for (const nodeId of meshNodeIds) {
      const original = this.originalMaterials.get(nodeId);
      if (!original) continue;

      // ── Skip multi-material arrays ──────────────────────────────────
      // A mesh with an array of materials (GLTF face groups, FBX sub-meshes)
      // can't be represented by a single preset.  Leave it with its original
      // materials so all texture slots render correctly.
      if (Array.isArray(original)) continue;

      // ── Extract the dominant hex color ──────────────────────────────
      const mat = original;
      const hex    = mat?.color?.isColor ? ('#' + mat.color.getHexString()) : '#bfcad4';
      const hexKey = hex.toLowerCase();

      // ── Find or create a preset for this color ──────────────────────
      let preset = presetByHex.get(hexKey);
      if (!preset) {
        const rawName = mat?.name?.trim() ?? '';
        const isGenericName =
          !rawName ||
          /^(default|material|mesh|standard|lambert|phong|\d+)$/i.test(rawName);
        const name = isGenericName ? hex : rawName;
        const roughness = Number.isFinite(mat?.roughness) ? mat.roughness : 0.45;
        const metalness = Number.isFinite(mat?.metalness) ? mat.metalness : 0.05;
        preset = this.createPreset({ color: hex, name, roughness, metalness });
        presetByHex.set(hexKey, preset);
      }

      // ── Assign as both current and default ──────────────────────────
      this.meshColorAssignments[nodeId] = preset.id;
      this.meshDefaultColors[nodeId]    = preset.id;
    }

    // Enable solidOverride so presets are immediately visible.
    if (!state.get('solidOverride')) {
      state.setState({ solidOverride: true });
      state.emit('materials:overrideModeChanged', true);
    }

    state.emit('materials:defaultColorsChanged');
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  DEFAULT COLOR MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /** Returns a Set of all presetIds currently used as mesh default colors. */
  getDefaultPresetIds() {
    return new Set(Object.values(this.meshDefaultColors));
  }

  /** True if presetId is the default color of at least one mesh. */
  isDefaultPreset(presetId) {
    return Object.values(this.meshDefaultColors).some(v => v === presetId);
  }

  /** Count of meshes that have presetId as their default color. */
  defaultColorMeshCount(presetId) {
    return Object.values(this.meshDefaultColors).filter(v => v === presetId).length;
  }

  /**
   * Assign a preset as the permanent project-level default color for the
   * given meshes. Project-level — not step-sensitive.
   *
   * Architectural rule (mirror of captureSnapshot's strip): an entry in any
   * step's snapshot.materials whose value equals a mesh's project default
   * is NOT a real override; it's tracking the default. So whenever a default
   * changes, EVERY step snapshot is scanned once: any meshId entry that
   * already matched the OLD default OR happens to match the NEW default is
   * dropped. The lookup chain in applyAll then resolves those meshes through
   * the new default automatically.
   *
   * This isn't a patch — it's the data-side enforcement of the same rule
   * applied at capture/apply. Step snapshots only ever hold real overrides.
   */
  assignDefaultColor(meshNodeIds, presetId) {
    // 🖐 V0.3.4.155 — a hand has no default colour: its texture is the default.
    // (The UI says so; here the hand ids are simply left out.)
    const nb = state.get('nodeById');
    meshNodeIds = (meshNodeIds || []).filter(id => nb?.get(id)?.type !== 'hand');
    if (!meshNodeIds.length) return;
    const prevDefaults = {};
    meshNodeIds.forEach(id => {
      prevDefaults[id] = this.meshDefaultColors[id];
      this.meshDefaultColors[id] = presetId;
      delete this.meshColorAssignments[id];   // override → default fallback
    });

    // Sweep step snapshots: drop entries matching old or new default for
    // each affected mesh. Any value still left in snapshot.materials after
    // this sweep is a true explicit override.
    const stepsArr = state.get('steps') || [];
    let touched = false;
    for (const step of stepsArr) {
      const m = step.snapshot?.materials;
      if (!m) continue;
      for (const id of meshNodeIds) {
        const v = m[id];
        if (v === undefined) continue;
        if (v === prevDefaults[id] || v === presetId) {
          delete m[id];
          touched = true;
        }
      }
    }
    if (touched) state.setState({ steps: [...stepsArr] });

    state.markDirty();
    this.applyAll();
    state.emit('materials:defaultColorsChanged');
  }

  /**
   * Revert the current-session assignment back to each mesh's default color.
   * Removes any step-specific or manual override for those meshes.
   */
  revertToDefault(meshNodeIds) {
    meshNodeIds.forEach(id => {
      const def = this.meshDefaultColors[id];
      if (def !== undefined) this.meshColorAssignments[id] = def;
      else delete this.meshColorAssignments[id];
    });
    state.markDirty();
    this.applyAll();
  }

  /**
   * Swap all default-color assignments from oldPresetId to newPresetId.
   * Used when replacing a default preset before deletion.
   * Also updates the current-session assignment where it matched the old default.
   */
  reassignDefault(oldPresetId, newPresetId) {
    for (const nodeId of Object.keys(this.meshDefaultColors)) {
      if (this.meshDefaultColors[nodeId] === oldPresetId) {
        this.meshDefaultColors[nodeId] = newPresetId;
        if (this.meshColorAssignments[nodeId] === oldPresetId) {
          this.meshColorAssignments[nodeId] = newPresetId;
        }
      }
    }
    state.markDirty();
    this.applyAll();
    state.emit('materials:defaultColorsChanged');
  }

  /**
   * Unregister a mesh (e.g. when a model is removed).
   */
  unregisterMesh(nodeId) {
    const mesh = this.meshById.get(nodeId);
    if (mesh) {
      this._removeFalloffBackPass(mesh);
      this._removeOutline(nodeId);
      this._applySelectionHull(mesh, false, '#00ffff'); // remove overlay/outline if present
    }
    this.meshById.delete(nodeId);
    this.originalMaterials.delete(nodeId);
    delete this.meshColorAssignments[nodeId];
  }

  /**
   * Unregister ALL meshes belonging to a model (identified by nodeIds).
   */
  unregisterMeshes(nodeIds) {
    nodeIds.forEach(id => this.unregisterMesh(id));
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  OVERRIDE MODE
  // ═══════════════════════════════════════════════════════════════════════
  setOverrideMode(enabled) {
    state.setState({ solidOverride: !!enabled });
    this.applyAll();
    state.emit('materials:overrideModeChanged', enabled);
  }

  toggleOverrideMode() {
    this.setOverrideMode(!state.get('solidOverride'));
  }
}


// ── Singleton export ───────────────────────────────────────────────────────
export const materials = new MaterialsSystem();
export default materials;
