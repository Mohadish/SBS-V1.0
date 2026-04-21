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
import { createColorPreset } from '../core/schema.js';
import { sceneCore } from '../core/scene.js';


// ── GLSL snippets ─────────────────────────────────────────────────────────

// Screen-door dither — hash-based, independent of pixel size
const DITHER_NOISE_GLSL = `
float transitionDitherNoise(vec2 p) {
  vec2 cell = floor(p);
  return fract(52.9829189 * fract(dot(cell, vec2(0.06711056, 0.00583715))));
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
uniform samplerCube uEnvMap;         // PMREM environment cube (roughness-prefiltered)
// viewMatrix is injected automatically by Three.js — do NOT redeclare it here
uniform float transitionOpacity;     // 0=invisible, 1=visible (dither fade)
${DITHER_NOISE_GLSL}
${PHONG_GLSL}
void main() {
  vec3  V   = normalize(-vViewPos);
  vec3  N   = normalize(vNormalView);
  N = faceforward(N, -V, N);
  float dotNV = clamp(dot(N, V), 0.0, 1.0);

  // ── Opacity: smooth curve blend ─────────────────────────────────────
  float fall  = pow(1.0 - dotNV, 2.5);
  float alpha = mix(fall, 1.0, uSolidness);

  // ── Phong lighting (in view space) ───────────────────────────────────
  vec3 albedo   = pow(uColor, vec3(2.2));               // sRGB → linear
  vec3 litColor = sbsPhong(albedo, N, V, uRoughness, uMetalness, uReflectionIntensity);

  // ── Environment map reflection (world space) ──────────────────────────
  // transpose(mat3(viewMatrix)) = camera→world rotation (viewMatrix is world→camera,
  // and for cameras the 3×3 block is orthogonal so transpose = inverse).
  mat3  v2w    = transpose(mat3(viewMatrix));
  vec3  R_w    = reflect(-(v2w * V), normalize(v2w * N));
  // textureLod samples the PMREM mip that matches the roughness level
  vec3  envRGB = textureLod(uEnvMap, R_w, uRoughness * 8.0).rgb;
  vec3  envF0  = mix(vec3(0.04), albedo, uMetalness);   // Fresnel F0
  litColor    += envRGB * envF0 * uReflectionIntensity * 2.0;

  // ── Gamma correction ─────────────────────────────────────────────────
  litColor = pow(max(litColor, vec3(0.0)), vec3(1.0 / 2.2));

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
${DITHER_NOISE_GLSL}
void main() {
  vec3  V   = normalize(-vViewPos);
  vec3  N   = normalize(vNormalView);
  N = faceforward(N, -V, N);
  float dotNV  = clamp(dot(N, V), 0.0, 1.0);
  float fall   = pow(1.0 - dotNV, 2.5);   // fixed falloff power matches front shader
  float darken = mix(1.0, 1.0 - uBackEdgeDarken, fall);
  float alpha  = clamp(uBackAlpha, 0.0, 1.0);
  float fade   = clamp(transitionOpacity, 0.0, 1.0);
  if (fade <= transitionDitherNoise(gl_FragCoord.xy)) discard;
  gl_FragColor = vec4(uBackColor * darken, alpha);
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

    // Canvas-based fallback env map (used before PMREM is ready)
    this._canvasEnvMap         = null;

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

    // Active colour transition (set by beginColorTransition, cleared when done)
    this._colorTransition      = null;

    // Active visibility fade transitions: nodeId → { from, to, startMs, durationMs, easeFn, hide }
    this._visTransitions       = new Map();
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
   * Fallback canvas-based cube map used before the PMREM HDR map is ready.
   * Low dynamic range (8-bit sRGB) so reflections are approximate but instant.
   */
  _createCanvasEnvMap() {
    const SIZE = 64;
    const makeFace = (top, bottom, glow = 'rgba(255,255,255,0)') => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
      const g = canvas.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, SIZE);
      grad.addColorStop(0,    top);
      grad.addColorStop(0.55, '#a7b3c5');
      grad.addColorStop(1,    bottom);
      g.fillStyle = grad;
      g.fillRect(0, 0, SIZE, SIZE);
      const rg = g.createRadialGradient(
        SIZE * 0.3, SIZE * 0.25, 2,
        SIZE * 0.3, SIZE * 0.25, SIZE * 0.55,
      );
      rg.addColorStop(0, glow);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, SIZE, SIZE);
      return canvas;
    };

    const tex = new THREE.CubeTexture([
      makeFace('#f8fbff', '#5b6674', 'rgba(255,255,255,0.85)'),
      makeFace('#f8fbff', '#5b6674', 'rgba(255,255,255,0.85)'),
      makeFace('#ffffff', '#8e99a8', 'rgba(255,255,255,0.95)'),
      makeFace('#3a4552', '#111827', 'rgba(255,255,255,0.15)'),
      makeFace('#dfe7f0', '#44505d', 'rgba(255,255,255,0.55)'),
      makeFace('#dfe7f0', '#44505d', 'rgba(255,255,255,0.55)'),
    ]);
    tex.needsUpdate = true;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Returns the best available env map: PMREM HDR when ready, else canvas fallback. */
  get metalEnvMap() {
    return this._pmremEnvMap
      ?? (this._canvasEnvMap ??= this._createCanvasEnvMap());
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

    // Apply to scene so MeshStandardMaterial meshes also benefit
    if (sceneCore.scene) sceneCore.scene.environment = this._pmremEnvMap;

    // Rebuild all materials so uEnvMap is the PMREM version
    this.applyAll();
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
    return this._hasTextureMaps(originalMaterial, preset)
      ? this.makeSolidMaterial(preset, originalMaterial)
      : this.makeFalloffFrontMaterial(preset);
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

    // reflectionIntensity (0–1) maps to envMapIntensity (0–0.5 range)
    const envMapIntensity = (preset.reflectionIntensity ?? 0.5) * 0.5;

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
    // Back-pass outlines use depthTest:false + stencil!=1 to avoid bleeding
    // through these solid-enough objects while still being smooth (no depth pop).
    if (solidness >= 0.9) {
      mat.stencilWrite = true;
      mat.stencilRef   = 1;
      mat.stencilZPass = THREE.ReplaceStencilOp;
    }

    mat.userData.transitionFadeState = fadeState;
    mat.userData.isSbsShader         = true;
    mat.userData.isFalloffFront      = true;
    return mat;
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
    if (u.uEnvMap)              u.uEnvMap.value              = this.metalEnvMap;
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
    const overrideMode = state.get('solidOverride');
    const presets      = state.get('colorPresets');
    const presetById   = new Map(presets.map(p => [p.id, p]));

    for (const [nodeId, mesh] of this.meshById) {
      const original = this.originalMaterials.get(nodeId);
      this._removeFalloffBackPass(mesh);

      if (!overrideMode) {
        // Restore original import material
        if (original) mesh.material = original;
        continue;
      }

      const presetId = this.meshColorAssignments[nodeId] ?? null;
      const preset   = presetId ? presetById.get(presetId) : null;

      if (preset) {
        this.ensurePresetDefaults(preset);
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
        if (original) mesh.material = original;
      }
    }

    this.applyGeometryOutlines();
    this.applySelectionHighlight();

    // Re-apply any in-progress visibility fade values.
    // applyAll() just rebuilt material objects (resetting transitionOpacity to 1.0)
    // and applyGeometryOutlines() reset outline opacities — both need correction
    // for meshes that are currently mid-fade.
    if (this._visTransitions?.size) {
      const now             = performance.now();
      const outlineSettings = state.get('geometryOutline');
      for (const [nodeId, tr] of this._visTransitions) {
        const raw   = Math.min((now - tr.startMs) / tr.durationMs, 1);
        const alpha = tr.easeFn(raw);
        const t      = tr.from + (tr.to - tr.from) * alpha;
        // backOp uses alpha (0→1 progress) so it fades correctly for both hide and show.
        // hiding:  fromBackOp → 0    (alpha 0→1)
        // showing: 0 → toBackOp     (alpha 0→1)
        const backOp = tr.fromBackOp + (tr.toBackOp - tr.fromBackOp) * alpha;
        this._setNodeTransitionOpacity(nodeId, t, outlineSettings, backOp);
      }
    }
  }


  // ═══════════════════════════════════════════════════════════════════════
  //  SNAPSHOT (for step capture/apply)
  // ═══════════════════════════════════════════════════════════════════════
  /**
   * Capture current color assignments as a snapshot.
   * Returns { [meshNodeId]: colorPresetId | null }
   */
  captureSnapshot() {
    return { ...this.meshColorAssignments };
  }

  /**
   * Apply a materials snapshot (restores color assignments + re-applies).
   */
  applySnapshot(snapshot) {
    if (!snapshot) return;
    this.cancelVisibilityTransitions();   // snap any in-flight vis fades to final state
    this.meshColorAssignments = { ...snapshot };
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

      values.set(nodeId, { color, solidness, metalness, roughness, reflectionIntensity, backOpacity });
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
      startMs:    performance.now(),
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

    const raw   = Math.min((nowMs - tr.startMs) / tr.durationMs, 1);
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
    const presetId      = this.meshColorAssignments[nodeId];
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
    const now             = performance.now();
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
    if (!this._visTransitions.size) return;

    const outlineSettings = state.get('geometryOutline');
    const done            = [];

    for (const [nodeId, tr] of this._visTransitions) {
      const raw   = Math.min((nowMs - tr.startMs) / tr.durationMs, 1);
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
        // Fade complete — now actually hide the Three.js object
        const obj = object3dById.get(nodeId);
        if (obj) obj.visible = false;
        // Reset transitionOpacity to 1.0 so the object renders normally if shown again
        const mesh = this.meshById.get(nodeId);
        if (mesh) this._setMaterialFade(mesh.material, 1.0);
        const bp = mesh?.userData?.falloffBackPass;
        if (bp) this._setMaterialFade(bp.material, 1.0);
      }
      // showing: already at t=1.0, outline opacity already at target — nothing more to do
    }
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
      if (this._originalMaterials?.has(freshId)) {
        this._originalMaterials.set(savedId, this._originalMaterials.get(freshId));
        this._originalMaterials.delete(freshId);
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
    if (material.userData?.transitionFadeState) {
      material.userData.transitionFadeState.value = value;
    }
    if (material.isShaderMaterial && material.uniforms?.transitionOpacity) {
      material.uniforms.transitionOpacity.value = value;
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
      if (!settings.enabled) {
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

      // ── Back-pass outline (smart shader, depthTest=false + stencil) ───────
      // Discards front-facing edges — only back/hidden edges drawn.
      // depthTest:false so back edges aren't killed by the depth buffer.
      // Stencil mask (written by solid meshes) prevents bleed through solids.
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
          depthTest:      false,
          depthWrite:     false,
          stencilWrite:   true,
          stencilFunc:    THREE.NotEqualStencilFunc,
          stencilRef:     1,
          stencilFail:    THREE.KeepStencilOp,
          stencilZFail:   THREE.KeepStencilOp,
          stencilZPass:   THREE.KeepStencilOp,
        });
        // Share the annotated geometry with the front-pass
        outlineBack = new THREE.LineSegments(outline.geometry, backMat);
        outlineBack.raycast           = () => {};
        outlineBack.userData.noSelect = true;
        outlineBack.visible           = false;
        outlineBack.renderOrder       = 1;
        mesh.add(outlineBack);
        this._outlineBackMeshes.set(nodeId, outlineBack);
      } else {
        outlineBack.material.uniforms.uColor.value.set(color);
      }

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

    for (const [nodeId, mesh] of this.meshById) {
      this._applySelectionHull(mesh, selected.has(nodeId), color);
    }
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
  _applySelectionHull(mesh, isSelected, color) {
    const OVERLAY_KEY = 'sbsSelectionOverlay';
    const OUTLINE_KEY = 'sbsSelectionOutline';

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
        outline.geometry.dispose();
        delete mesh.userData[OUTLINE_KEY];
      }
      return;
    }

    // ── Update colour only if both already exist ──────────────────────────
    if (mesh.userData[OVERLAY_KEY] && mesh.userData[OUTLINE_KEY]) {
      mesh.userData[OVERLAY_KEY].material.color.set(color);
      mesh.userData[OUTLINE_KEY].material.color.set(color);
      return;
    }

    // ── Create overlay (front-face, 70% opacity) ──────────────────────────
    const overlayMat = new THREE.MeshBasicMaterial({
      color,
      transparent:  true,
      opacity:      0.70,
      depthTest:    false,
      depthWrite:   false,
      side:         THREE.FrontSide,
    });
    const overlay = new THREE.Mesh(mesh.geometry, overlayMat);
    overlay.raycast          = () => {};
    overlay.frustumCulled    = mesh.frustumCulled;
    overlay.matrixAutoUpdate = true;
    overlay.userData.noSelect = true;
    mesh.add(overlay);
    mesh.userData[OVERLAY_KEY] = overlay;

    // ── Create edge outline (LineSegments, 100% opacity) ──────────────────
    const edgesGeo = new THREE.EdgesGeometry(mesh.geometry, 15); // 15° crease threshold
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
    this.applySelectionHighlight();
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
    // Store original material (deep-clone to avoid sharing)
    if (mesh.material && !this.originalMaterials.has(nodeId)) {
      this.originalMaterials.set(nodeId, mesh.material.clone());
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
   * Assign a preset as the permanent default color for the given meshes.
   * Also updates the current-session assignment so the change is immediate.
   */
  assignDefaultColor(meshNodeIds, presetId) {
    meshNodeIds.forEach(id => {
      this.meshDefaultColors[id]    = presetId;
      this.meshColorAssignments[id] = presetId;
    });
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
