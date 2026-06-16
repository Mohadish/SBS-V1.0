import {
  ShaderMaterial, WebGLRenderTarget, DepthTexture, MeshNormalMaterial,
  Matrix4, Vector2, NearestFilter, UnsignedIntType, RGBAFormat,
} from '../three.module.proxy.mjs';
import { Pass, FullScreenQuad } from './postprocessing/Pass.js';

/**
 * SSRReflectPass — minimal screen-space CONTACT reflections (V0.3.0.16 spike).
 *
 * Distance-limited SSR: rays are capped to a short world-space distance, so only
 * geometry touching / very close to a surface registers. This dodges SSR's worst
 * artifacts (screen-edge smear, long-range noise, off-screen misses) and gives a
 * "contact reflection" look.
 *
 * Renders its OWN normal+depth prepass via scene.overrideMaterial =
 * MeshNormalMaterial — which renders solid (no X-ray dither discard), so hit
 * detection uses CLEAN depth even when surfaces are ghosted. Reflection COLOUR is
 * sampled from the composer's current buffer (the AO'd scene), so reflections pick
 * up the real shaded look.
 *
 * SPIKE SCOPE: global params (one intensity / maxDistance / thickness), SHARP
 * reflections only (no roughness blur yet), reflects all surfaces. Per-material
 * intensity / roughness / solidness is the next phase (needs a material G-buffer).
 *
 * Console tuning: window.sbsSSR.on(true) / .set({ intensity, maxDistance, thickness, steps }).
 */
class SSRReflectPass extends Pass {
  constructor(scene, camera, width, height) {
    super();
    this.scene  = scene;
    this.camera = camera;
    this.width  = width;
    this.height = height;

    this.params = {
      intensity:   0.6,   // reflection opacity (0..1)
      maxDistance: 8.0,   // WORLD units — contact range; tune to model scale
      thickness:   1.0,   // surface thickness for the hit test (world units)
      steps:       24,    // ray-march samples (clamped to 64 in-shader)
    };

    this._normalMat = new MeshNormalMaterial();

    this._gBuf = new WebGLRenderTarget(width, height, {
      minFilter: NearestFilter, magFilter: NearestFilter, format: RGBAFormat,
    });
    this._gBuf.depthTexture = new DepthTexture(width, height);
    this._gBuf.depthTexture.type = UnsignedIntType;

    this._fsQuad = new FullScreenQuad(new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse:   { value: null },
        tNormal:    { value: null },
        tDepth:     { value: null },
        uProj:      { value: new Matrix4() },
        uProjInv:   { value: new Matrix4() },
        uIntensity: { value: this.params.intensity },
        uMaxDist:   { value: this.params.maxDistance },
        uThickness: { value: this.params.thickness },
        uSteps:     { value: this.params.steps },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tNormal;
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
          float d = texture2D(tDepth, vUv).x;
          if (d >= 1.0) { gl_FragColor = vec4(baseCol, 1.0); return; }   // background

          vec3 N = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
          if (dot(N, N) < 0.01) { gl_FragColor = vec4(baseCol, 1.0); return; }
          N = normalize(N);

          vec3 P = viewPos(vUv, d);        // view-space position (camera at origin)
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
              float distFade = 1.0 - clamp(dist / uMaxDist, 0.0, 1.0);  // contact falloff
              vec2  e        = smoothstep(0.0, 0.12, sUv) * (1.0 - smoothstep(0.88, 1.0, sUv));
              float edgeFade = e.x * e.y;                                // hide screen-edge cutoff
              reflCol = texture2D(tDiffuse, sUv).rgb;
              a = distFade * edgeFade;
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
    // 1. Clean normal + depth prepass. overrideMaterial renders solid (ignores
    //    the X-ray dither discard) → hit detection uses clean depth.
    const prevOverride = this.scene.overrideMaterial;
    const prevBg       = this.scene.background;
    this.scene.overrideMaterial = this._normalMat;
    this.scene.background = null;
    renderer.setRenderTarget(this._gBuf);
    renderer.autoClear = true;
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBg;

    // 2. SSR composite over the AO'd scene colour (readBuffer).
    const u = this._fsQuad.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tNormal.value  = this._gBuf.texture;
    u.tDepth.value   = this._gBuf.depthTexture;
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
    this._normalMat.dispose();
  }
}

export { SSRReflectPass };
