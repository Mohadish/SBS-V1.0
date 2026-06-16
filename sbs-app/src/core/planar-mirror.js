/**
 * PlanarMirror (V0.3.0.28 spike) — a TRUE planar reflection on a flat mesh.
 *
 * Unlike SSR, this reflects the actual scene (stable across views, optically
 * correct) by rendering the scene from a camera mirrored across the mesh's plane
 * into a texture, which the mesh then samples with screen-projected coords. Same
 * algorithm as Three's Reflector, but driven MANUALLY once per frame (from
 * SceneCore._render, before the EffectComposer) so it can't re-fire inside the
 * N8AO/SSR scene passes.
 *
 * Spike scope: one mirror created on a selected flat mesh via window.sbsMirror.
 * Caveats: the mesh should be roughly flat (a planar mirror needs one plane);
 * each mirror is an extra full scene render per frame.
 */

/** Area-agnostic plane of a mesh: world centroid + averaged world normal. */
function computeMeshPlaneLocal(mesh) {
  const THREE = window.THREE;
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const point = geo.boundingBox.getCenter(new THREE.Vector3());   // mesh-local
  const nAttr = geo.getAttribute('normal');
  const avg = new THREE.Vector3();
  if (nAttr) {
    const tmp = new THREE.Vector3();
    for (let i = 0; i < nAttr.count; i++) { tmp.fromBufferAttribute(nAttr, i); avg.add(tmp); }
  }
  if (avg.lengthSq() < 1e-9) avg.set(0, 0, 1);
  return { point, normal: avg.normalize() };   // mesh-local — transformed to world each update
}

export class PlanarMirror {
  constructor(mesh, size = 1024) {
    const THREE = window.THREE;
    this.mesh = mesh;
    this.originalMaterial = mesh.material;

    const plane = computeMeshPlaneLocal(mesh);
    this.pointLocal  = plane.point;
    this.normalLocal = plane.normal;

    this.rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.virtualCamera = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tReflect:      { value: this.rt.texture },
        textureMatrix: { value: this.textureMatrix },
        uReflectivity: { value: 0.9 },
        uTint:         { value: new THREE.Color(0x0a0a0a) },
        uDebug:        { value: 0 },
      },
      vertexShader: /* glsl */`
        uniform mat4 textureMatrix;
        varying vec4 vCoord;
        void main() {
          vCoord = textureMatrix * modelMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tReflect;
        uniform float uReflectivity;
        uniform vec3  uTint;
        uniform float uDebug;
        varying vec4 vCoord;
        void main() {
          if (uDebug > 0.5) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }  // visibility test
          vec3 refl = texture2DProj(tReflect, vCoord).rgb;
          gl_FragColor = vec4(mix(uTint, refl, uReflectivity), 1.0);
        }
      `,
    });
    mesh.material = this.material;
  }

  /** Render the reflected scene into the RT. Call ONCE per frame, pre-composer. */
  update(renderer, scene, camera) {
    const THREE = window.THREE;
    // World plane from the live transform → the mirror follows the host mesh.
    this.mesh.updateWorldMatrix(true, false);
    const mirrorPos = this.pointLocal.clone().applyMatrix4(this.mesh.matrixWorld);
    const normal    = this.normalLocal.clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(this.mesh.matrixWorld)).normalize();

    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const view   = new THREE.Vector3().subVectors(mirrorPos, camPos);
    // Face the camera regardless of the source normal's sign — an inverted
    // normal would otherwise reflect the back side (→ black).
    if (view.dot(normal) > 0) normal.negate();

    view.reflect(normal).negate().add(mirrorPos);
    const rot    = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const lookAt = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    const target = new THREE.Vector3().subVectors(mirrorPos, lookAt).reflect(normal).negate().add(mirrorPos);

    const vc = this.virtualCamera;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
    vc.lookAt(target);
    vc.near = camera.near; vc.far = camera.far;
    vc.fov = camera.fov;   vc.aspect = camera.aspect;
    vc.updateMatrixWorld();
    vc.matrixWorldInverse.copy(vc.matrixWorld).invert();
    vc.updateProjectionMatrix();

    // World → reflection-RT UV.
    this.textureMatrix.set(
      0.5, 0,   0,   0.5,
      0,   0.5, 0,   0.5,
      0,   0,   0.5, 0.5,
      0,   0,   0,   1,
    );
    this.textureMatrix.multiply(vc.projectionMatrix);
    this.textureMatrix.multiply(vc.matrixWorldInverse);

    // Oblique near-plane clip at the mirror plane → don't reflect geometry behind it.
    const clipPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, mirrorPos);
    clipPlane.applyMatrix4(vc.matrixWorldInverse);
    const cp = new THREE.Vector4(clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant);
    const pm = vc.projectionMatrix;
    const q  = new THREE.Vector4();
    q.x = (Math.sign(cp.x) + pm.elements[8])  / pm.elements[0];
    q.y = (Math.sign(cp.y) + pm.elements[9])  / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    cp.multiplyScalar(2.0 / cp.dot(q));
    pm.elements[2]  = cp.x;
    pm.elements[6]  = cp.y;
    pm.elements[10] = cp.z + 1.0 - 0.0;
    pm.elements[14] = cp.w;

    const prevRT = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    this.mesh.visible = false;            // don't reflect the mirror itself
    renderer.setRenderTarget(this.rt);
    renderer.autoClear = true;
    renderer.clear();
    renderer.render(scene, vc);
    this.mesh.visible = true;
    renderer.xr.enabled = prevXr;
    renderer.setRenderTarget(prevRT);
  }

  setDebug(on) {
    this.material.uniforms.uDebug.value = on ? 1 : 0;
    // Debug draws on TOP regardless of depth → magenta means "rendered at all",
    // independent of any z-fighting / being buried behind the host face.
    this.material.depthTest  = !on;
    this.material.depthWrite = !on;
    this.material.needsUpdate = true;
    if (this.mesh) this.mesh.renderOrder = on ? 9999 : 0;
  }

  dispose() {
    if (this.mesh) {
      this.mesh.material = this.originalMaterial;
      // Per-face mirrors own an extracted overlay sub-mesh → remove it on clear.
      if (this.mesh.userData && this.mesh.userData.isMirrorSubmesh) {
        this.mesh.geometry?.dispose?.();
        this.mesh.parent?.remove(this.mesh);
      }
    }
    this.rt.dispose();
    this.material.dispose();
  }
}
