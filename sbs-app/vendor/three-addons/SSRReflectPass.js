import {
  ShaderMaterial, WebGLMultipleRenderTargets, DepthTexture,
  Matrix4, Vector2, NearestFilter, UnsignedIntType, GLSL3,
} from '../three.module.proxy.mjs';
import { Pass, FullScreenQuad } from './postprocessing/Pass.js';

/**
 * SSRReflectPass — per-material screen-space CONTACT reflections (V0.3.0.21).
 *
 * Distance-limited SSR driven by a small G-buffer so reflections are PER-MATERIAL:
 *   - only surfaces whose colour has "Reflective (SSR)" on actually reflect,
 *   - each surface blurs by its OWN roughness,
 *   - reflection strength = that surface's reflectionIntensity,
 *   - and it fades with that surface's solidness (ghosted → ghosted reflection).
 *
 * The G-buffer is a 2-target MRT rendered with scene.overrideMaterial =
 * this._prepassMat (solid, so the X-ray dither can't hole the depth). Per-mesh
 * material values reach the shared prepass material through ssrPrepassHook
 * (installed as each mesh's onBeforeRender by materials.js):
 *   gNormalRough = (viewNormal*0.5+0.5, roughness)
 *   gMatProps    = (reflectionIntensity, solidness, reflectiveFlag, 1)
 * Depth (all geometry) comes from the attached DepthTexture, so reflective
 * surfaces can mirror NON-reflective ones too.
 *
 * Global params are now MASTERS: intensity scales every surface's reflection;
 * maxDistance / thickness / steps are the shared ray-march controls. Roughness
 * is no longer global — it comes from each material.
 *
 * Console: window.sbsSSR.on(true) / .set({intensity, maxDistance, thickness, steps}).
 */

/**
 * Per-mesh onBeforeRender hook. No-op except during the SSR G-buffer prepass
 * (guarded by the override material's userData.isSSRPrepass). Reads the mesh's
 * live material (roughness / reflectionIntensity / solidness) + its reflective
 * flag (stamped on material.userData by materials.makeMaterial) and feeds them
 * to the shared prepass material's uniforms before this mesh draws.
 */
export function ssrPrepassHook(renderer, scene, camera, geometry, material) {
  if (!material || !material.userData || !material.userData.isSSRPrepass) return;
  const u = material.uniforms;
  const m = this.material;
  let rough = 0.45, reflI = 0.5, solid = 1.0, reflective = false;
  if (m) {
    const mu = m.uniforms;
    if (mu) {
      if (mu.uRoughness)           rough = mu.uRoughness.value;
      if (mu.uReflectionIntensity) reflI = mu.uReflectionIntensity.value;
      if (mu.uSolidness)           solid = mu.uSolidness.value;
    } else {
      if (typeof m.roughness === 'number')       rough = m.roughness;
      if (typeof m.envMapIntensity === 'number') reflI = Math.min(1.0, m.envMapIntensity * 2.0);
      if (typeof m.opacity === 'number')         solid = m.opacity;
    }
    reflective = !!(m.userData && m.userData.ssrReflective);
  }
  u.uRough.value   = rough;
  u.uReflInt.value = reflI;
  u.uSolid.value   = solid;
  u.uFlag.value    = reflective ? 1.0 : 0.0;
}

class SSRReflectPass extends Pass {
  constructor(scene, camera, width, height) {
    super();
    this.scene  = scene;
    this.camera = camera;
    this.width  = width;
    this.height = height;

    this.params = {
      intensity:   1.0,   // MASTER multiplier on each surface's reflectionIntensity
      maxDistance: 8.0,   // WORLD units — contact range; tune to model scale
      thickness:   1.0,   // surface thickness for the hit test (world units)
      steps:       24,    // ray-march samples (clamped to 64 in-shader)
    };

    // ── G-buffer prepass material (MRT, GLSL3) ──────────────────────────────
    this._prepassMat = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: {
        uRough:   { value: 0.45 },
        uReflInt: { value: 0.5 },
        uSolid:   { value: 1.0 },
        uFlag:    { value: 0.0 },
      },
      vertexShader: /* glsl */`
        out vec3 vViewNormal;
        void main() {
          vViewNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        in vec3 vViewNormal;
        uniform float uRough;
        uniform float uReflInt;
        uniform float uSolid;
        uniform float uFlag;
        layout(location = 0) out vec4 gNormalRough;
        layout(location = 1) out vec4 gMatProps;
        void main() {
          gNormalRough = vec4(normalize(vViewNormal) * 0.5 + 0.5, uRough);
          gMatProps    = vec4(uReflInt, uSolid, uFlag, 1.0);
        }
      `,
    });
    this._prepassMat.userData.isSSRPrepass = true;

    this._gBuf = new WebGLMultipleRenderTargets(width, height, 2);
    for (const t of this._gBuf.texture) { t.minFilter = NearestFilter; t.magFilter = NearestFilter; }
    this._gBuf.depthTexture = new DepthTexture(width, height);
    this._gBuf.depthTexture.type = UnsignedIntType;

    // ── SSR composite (fullscreen) ──────────────────────────────────────────
    this._fsQuad = new FullScreenQuad(new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse:     { value: null },
        tNormalRough: { value: null },
        tMatProps:    { value: null },
        tDepth:       { value: null },
        uProj:        { value: new Matrix4() },
        uProjInv:     { value: new Matrix4() },
        uIntensity:   { value: this.params.intensity },
        uMaxDist:     { value: this.params.maxDistance },
        uThickness:   { value: this.params.thickness },
        uSteps:       { value: this.params.steps },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tNormalRough;
        uniform sampler2D tMatProps;
        uniform sampler2D tDepth;
        uniform mat4  uProj;
        uniform mat4  uProjInv;
        uniform float uIntensity;
        uniform float uMaxDist;
        uniform float uThickness;
        uniform float uSteps;

        vec3 viewPos(vec2 uv, float d) {
          vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 v = uProjInv * clip;
          return v.xyz / v.w;
        }

        void main() {
          vec3 baseCol = texture2D(tDiffuse, vUv).rgb;
          float d  = texture2D(tDepth, vUv).x;
          vec4  mp = texture2D(tMatProps, vUv);   // r=reflInt, g=solid, b=flag
          // Reflect only flagged surfaces; skip background.
          if (d >= 1.0 || mp.b < 0.5) { gl_FragColor = vec4(baseCol, 1.0); return; }

          vec4 nr = texture2D(tNormalRough, vUv); // rgb=normal, a=roughness
          vec3 N = nr.rgb * 2.0 - 1.0;
          if (dot(N, N) < 0.01) { gl_FragColor = vec4(baseCol, 1.0); return; }
          N = normalize(N);
          float roughness = nr.a;
          float reflInt   = mp.r;
          float solid     = mp.g;

          vec3 P = viewPos(vUv, d);
          vec3 R = reflect(normalize(P), N);

          float stepLen = uMaxDist / max(uSteps, 1.0);
          vec3 rayPos = P;
          float a = 0.0;
          vec3 reflCol = vec3(0.0);

          for (int i = 0; i < 64; i++) {
            if (float(i) >= uSteps) break;
            rayPos += R * stepLen;

            vec4 clip = uProj * vec4(rayPos, 1.0);
            if (clip.w <= 0.0) break;
            vec2 sUv = (clip.xy / clip.w) * 0.5 + 0.5;
            if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) break;

            float sD = texture2D(tDepth, sUv).x;
            if (sD >= 1.0) continue;
            vec3 sP = viewPos(sUv, sD);

            float diff = sP.z - rayPos.z;   // > 0 when the ray is behind the surface
            if (diff > 0.0 && diff < uThickness) {
              float dist     = distance(rayPos, P);
              float distFrac = clamp(dist / uMaxDist, 0.0, 1.0);
              float distFade = 1.0 - distFrac;
              vec2  e        = smoothstep(0.0, 0.12, sUv) * (1.0 - smoothstep(0.88, 1.0, sUv));
              float edgeFade = e.x * e.y;

              // PER-MATERIAL roughness blur (sunflower disc, distance-scaled).
              float blurR = roughness * 0.045 * (0.25 + 0.75 * distFrac);
              if (blurR > 0.0002) {
                vec3 acc = vec3(0.0);
                for (int t = 0; t < 12; t++) {
                  float f   = float(t);
                  float ang = f * 2.39996323;
                  vec2  o   = vec2(cos(ang), sin(ang)) * (blurR * sqrt((f + 0.5) / 12.0));
                  acc += texture2D(tDiffuse, sUv + o).rgb;
                }
                reflCol = acc / 12.0;
              } else {
                reflCol = texture2D(tDiffuse, sUv).rgb;
              }
              // Alpha = contact × edge × per-material reflectionIntensity × solidness.
              a = distFade * edgeFade * reflInt * solid;
              break;
            }
          }

          a = clamp(a * uIntensity, 0.0, 1.0);
          gl_FragColor = vec4(mix(baseCol, reflCol, a), 1.0);
        }
      `,
    }));
  }

  setSize(width, height) {
    this.width = width; this.height = height;
    this._gBuf.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    // 1. G-buffer prepass. overrideMaterial renders solid (ignores the X-ray
    //    dither discard) → hit detection uses clean depth even on ghosted parts.
    const prevOverride = this.scene.overrideMaterial;
    const prevBg       = this.scene.background;
    this.scene.overrideMaterial = this._prepassMat;
    this.scene.background = null;
    renderer.setRenderTarget(this._gBuf);
    renderer.autoClear = true;
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBg;

    // 2. SSR composite over the AO'd scene colour (readBuffer).
    const u = this._fsQuad.material.uniforms;
    u.tDiffuse.value     = readBuffer.texture;
    u.tNormalRough.value = this._gBuf.texture[0];
    u.tMatProps.value    = this._gBuf.texture[1];
    u.tDepth.value       = this._gBuf.depthTexture;
    u.uProj.value.copy(this.camera.projectionMatrix);
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uIntensity.value = this.params.intensity;
    u.uMaxDist.value   = this.params.maxDistance;
    u.uThickness.value = this.params.thickness;
    u.uSteps.value     = this.params.steps;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    renderer.autoClear = true;
    this._fsQuad.render(renderer);
  }

  dispose() {
    this._gBuf.dispose();
    if (this._gBuf.depthTexture) this._gBuf.depthTexture.dispose();
    this._fsQuad.dispose();
    this._prepassMat.dispose();
  }
}

export { SSRReflectPass };
