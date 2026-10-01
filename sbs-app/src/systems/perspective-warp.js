/**
 * ⌗ PERSPECTIVE CORRECTION (V0.3.5.1) — "Square up": four corners of a photo
 * become a rectangle (keystone / 4-point homography — Photoshop's Perspective
 * Crop, a phone scanner's deskew).
 *
 * The user: a screen or a panel photographed with a phone is never square;
 * drag four corners onto it, press Enter, and the picture is re-formed so that
 * quad is a flat rectangle. The WHOLE picture goes through the same warp (the
 * surroundings stay, distorted, for context — a crop mask hides them by
 * default and the user can scale the picture down under the mask to bring them
 * back).
 *
 * Maths: H = the homography mapping the 4 source corners (image pixels) onto
 * the target rectangle; the output canvas holds the rectified rectangle plus a
 * margin of surroundings, every output pixel sampled through H⁻¹. Canvas 2D
 * cannot do a projective warp (affine only), so the warp is a tiny WebGL pass
 * on an offscreen renderer (one quad, one fragment shader), read back as a
 * data URL. Pure maths helpers are exported for tests.
 */

/** 3×3 row-major homography mapping src[i] → dst[i] (4 point pairs). */
export function homographyFromPoints(src, dst) {
  // 8 unknowns h0..h7 (h8 = 1): for each pair (x,y)→(u,v):
  //   x*h0 + y*h1 + h2 - u*x*h6 - u*y*h7 = u
  //   x*h3 + y*h4 + h5 - v*x*h6 - v*y*h7 = v
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = _solve(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** Gaussian elimination with partial pivoting; null when singular. */
function _solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    if (p !== c) [M[p], M[c]] = [M[c], M[p]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map(v => v / det);
}

export function applyH(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

const _len = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);

/**
 * The rectified size for a quad [tl, tr, br, bl] in image pixels.
 * `aspect` null → from the edge lengths (a scanner's guess); a number (w/h)
 * → the width from the top/bottom edges, the height from the aspect.
 */
export function rectifiedSize(quad, aspect = null) {
  const [tl, tr, br, bl] = quad;
  const w = Math.max(8, (_len(tl, tr) + _len(bl, br)) / 2);
  const h = aspect > 0 ? w / aspect : Math.max(8, (_len(tl, bl) + _len(tr, br)) / 2);
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * Where the four image corners land under H and the output frame that holds
 * the rectified rect (0,0,w,h) plus `margin` × its size of surroundings on
 * each side — clipped to what the warped picture actually covers, and to
 * maxDim. Returns { x, y, w, h } in rectified coordinates (x,y may be < 0).
 */
export function outputFrame(H, imgW, imgH, rectW, rectH, { margin = 1, maxDim = 4096 } = {}) {
  const corners = [applyH(H, 0, 0), applyH(H, imgW, 0), applyH(H, imgW, imgH), applyH(H, 0, imgH)];
  const finite = corners.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  let x0 = -margin * rectW, y0 = -margin * rectH, x1 = rectW * (1 + margin), y1 = rectH * (1 + margin);
  if (finite) {
    // a corner past the horizon (w ≤ 0) maps nowhere sensible — the margin box bounds it
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    x0 = Math.max(x0, Math.min(0, ...xs)); y0 = Math.max(y0, Math.min(0, ...ys));
    x1 = Math.min(x1, Math.max(rectW, ...xs)); y1 = Math.min(y1, Math.max(rectH, ...ys));
  }
  // never smaller than the rect itself, never bigger than maxDim
  x0 = Math.min(x0, 0); y0 = Math.min(y0, 0); x1 = Math.max(x1, rectW); y1 = Math.max(y1, rectH);
  if (x1 - x0 > maxDim) { const over = (x1 - x0 - maxDim) / 2; x0 += over; x1 -= over; x0 = Math.min(x0, 0); x1 = Math.max(x1, rectW); }
  if (y1 - y0 > maxDim) { const over = (y1 - y0 - maxDim) / 2; y0 += over; y1 -= over; y0 = Math.min(y0, 0); y1 = Math.max(y1, rectH); }
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1) - Math.floor(x0), h: Math.ceil(y1) - Math.floor(y0) };
}

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FRAG = `
uniform sampler2D uTex; uniform mat3 uHinv; uniform vec2 uOrigin; uniform vec2 uOut; uniform vec2 uSrc; uniform vec4 uFill;
varying vec2 vUv;
void main() {
  // output pixel (y down) → rectified coords → source pixel through H⁻¹
  vec2 o = vec2(vUv.x * uOut.x, (1.0 - vUv.y) * uOut.y) + uOrigin;
  vec3 p = uHinv * vec3(o, 1.0);
  if (p.z <= 1e-6) { gl_FragColor = uFill; return; }   // behind the horizon
  vec2 s = p.xy / p.z;
  if (s.x < 0.0 || s.y < 0.0 || s.x > uSrc.x || s.y > uSrc.y) { gl_FragColor = uFill; return; }
  gl_FragColor = texture2D(uTex, vec2(s.x / uSrc.x, s.y / uSrc.y));
}`;

/**
 * Warp `img` (HTMLImageElement / canvas) so `quad` ([tl,tr,br,bl], image px)
 * becomes a rectW × rectH rectangle, keeping the surroundings.
 * @returns {{ canvas, rect:{x,y,w,h}, width, height }} rect = where the
 *          rectified rectangle sits inside the output canvas.
 */
export function warpImage(img, quad, rectW, rectH, { margin = 1, maxDim = 4096, fill = [0, 0, 0, 0] } = {}) {
  const T = globalThis.THREE;
  if (!T) throw new Error('three.js is not loaded');
  const imgW = img.naturalWidth || img.width, imgH = img.naturalHeight || img.height;
  const H = homographyFromPoints(quad, [{ x: 0, y: 0 }, { x: rectW, y: 0 }, { x: rectW, y: rectH }, { x: 0, y: rectH }]);
  if (!H) throw new Error('those four corners do not make a usable quadrilateral');
  let Hinv = invert3(H);
  if (!Hinv) throw new Error('the perspective is degenerate');
  // V0.3.5.2 — a homography is the same up to a scale, so its inverse can come
  // out NEGATED (w < 0 everywhere that is valid). The shader's "behind the
  // horizon" test reads the sign of w, so pin it: w > 0 at the rectangle's
  // centre. (Every pixel came out as the fill colour — the user's blue screen.)
  const wc = Hinv[6] * (rectW / 2) + Hinv[7] * (rectH / 2) + Hinv[8];
  if (wc < 0) Hinv = Hinv.map(v => -v);
  const frame = outputFrame(H, imgW, imgH, rectW, rectH, { margin, maxDim });

  const canvas = document.createElement('canvas');
  canvas.width = frame.w; canvas.height = frame.h;
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(frame.w, frame.h, false);
  renderer.setClearColor(0x000000, 0);
  const tex = new T.Texture(img);
  tex.flipY = false;                       // row 0 = the top of the picture, like the maths
  tex.minFilter = T.LinearFilter; tex.magFilter = T.LinearFilter;
  tex.wrapS = T.ClampToEdgeWrapping; tex.wrapT = T.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = T.NoColorSpace || tex.colorSpace;   // pixels through untouched
  tex.needsUpdate = true;
  // column-major for GLSL
  const hinv = new T.Matrix3().set(Hinv[0], Hinv[1], Hinv[2], Hinv[3], Hinv[4], Hinv[5], Hinv[6], Hinv[7], Hinv[8]);
  const mat = new T.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, transparent: true,
    uniforms: {
      uTex: { value: tex }, uHinv: { value: hinv },
      uOrigin: { value: new T.Vector2(frame.x, frame.y) }, uOut: { value: new T.Vector2(frame.w, frame.h) },
      uSrc: { value: new T.Vector2(imgW, imgH) }, uFill: { value: new T.Vector4(...fill) },
    },
  });
  const scene = new T.Scene();
  const quadMesh = new T.Mesh(new T.PlaneGeometry(2, 2), mat);
  quadMesh.frustumCulled = false;   // V0.3.5.2 — the plane sits ON the camera's near plane; culled, it drew nothing (the blue screen)
  scene.add(quadMesh);
  const cam = new T.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  try {
    if (T.LinearSRGBColorSpace) renderer.outputColorSpace = T.LinearSRGBColorSpace;   // no gamma pass on a copy
    renderer.render(scene, cam);
    // did anything land? the rectangle's centre must be a source pixel
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(-frame.x + rectW / 2), Math.round(frame.h - (-frame.y + rectH / 2)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (px[3] === 0) throw new Error('the warp produced no pixels (WebGL) — see the console');
  } finally {
    try { mat.dispose(); tex.dispose(); quadMesh.geometry.dispose(); renderer.dispose(); } catch { /* best effort */ }
    try { renderer.forceContextLoss?.(); } catch { /* a context too many is the only cost */ }
  }
  return { canvas, rect: { x: -frame.x, y: -frame.y, w: rectW, h: rectH }, width: frame.w, height: frame.h };
}
