/**
 * SBS — squishing a shape the way a drawing program does (V0.3.4.17). Pure 2×2 maths, no Konva.
 *
 * Konva keeps a resize in the node's TRANSFORM (scale, and skew when a group of turned items is
 * stretched) and draws everything through it — the outline too, so a squished shape got a thick
 * and thin outline. A drawing program squishes the GEOMETRY instead and draws the outline even.
 * These helpers turn a node's transform into geometry:
 *   · a line / an arrow: its points are moved (the bends are then worked out again from them);
 *   · a circle / an ellipse: a squished ellipse is still an ellipse — just turned and sized anew;
 * the shapes whose squish cannot be written into their own attributes (a triangle, a skewed
 * rectangle) keep it in their transform and are drawn with an even outline by the overlay.
 *
 * A matrix here is [a, b, c, d]:  x' = a·x + b·y,  y' = c·x + d·y.
 */

const RAD = Math.PI / 180;

/** Skew · Scale — Konva's order after the rotation (Transform.skew(kx, ky) then .scale(sx, sy)). */
export function skewScaleOf({ scaleX = 1, scaleY = 1, skewX = 0, skewY = 0 } = {}) {
  return [scaleX, skewX * scaleY, skewY * scaleX, scaleY];
}

/** Rotation · Skew · Scale — the whole linear part of a node's transform. rotation in degrees. */
export function linearOf({ rotation = 0, ...rest } = {}) {
  const [a, b, c, d] = skewScaleOf(rest), cs = Math.cos(rotation * RAD), sn = Math.sin(rotation * RAD);
  return [cs * a - sn * c, cs * b - sn * d, sn * a + cs * c, sn * b + cs * d];
}

export const isIdentity = (m, eps = 1e-9) => Math.abs(m[0] - 1) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] - 1) < eps;

/**
 * A transform that squishes nothing: no skew and the same size change on both axes (a flip is not a squish). Such a
 * shape looks the way Konva draws it — outline included, which then grows and shrinks WITH the shape, as it always did
 * (a bonded shape fitted to a resized interface keeps its proportional outline).
 */
export function isUniform({ scaleX = 1, scaleY = 1, skewX = 0, skewY = 0 } = {}, eps = 1e-6) {
  const ax = Math.abs(scaleX), ay = Math.abs(scaleY);
  return Math.abs(skewX) < eps && Math.abs(skewY) < eps && Math.abs(ax - ay) <= eps * Math.max(ax, ay, 1);
}

/** Apply [a,b,c,d] to a flat [x0,y0,x1,y1,…] list, around `origin` (the node's offset; usually 0,0). */
export function applyToPoints(flat, m, origin = { x: 0, y: 0 }) {
  const out = (flat || []).slice();
  for (let i = 0; i + 1 < out.length; i += 2) {
    const x = out[i] - origin.x, y = out[i + 1] - origin.y;
    out[i] = m[0] * x + m[1] * y + origin.x;
    out[i + 1] = m[2] * x + m[3] * y + origin.y;
  }
  return out;
}

/**
 * The ellipse {M · (rx cos t, ry sin t)} as a turned, axis-aligned ellipse: its radii and its turn.
 * (The affine image of an ellipse is an ellipse — a 2×2 singular-value decomposition.)
 * @param {number} [near]  the node's rotation now: of the equivalent answers (turned by 180°, or by 90° with the radii
 *                        swapped) the one nearest to it is given, so a resize never flips the shape's frame round
 * @returns {{rx:number, ry:number, rotation:number}} rotation in degrees (rx ≥ ry unless `near` chose the swapped answer)
 */
export function ellipseOf(m, rx, ry, near = null) {
  const a = m[0] * rx, b = m[1] * ry, c = m[2] * rx, d = m[3] * ry;     // M · diag(rx, ry)
  const p = a * a + b * b, q = c * c + d * d, r = a * c + b * d;         // (M Mᵀ) = [[p, r], [r, q]]
  const mid = (p + q) / 2, half = Math.sqrt(Math.max(0, ((p - q) / 2) ** 2 + r * r));
  const s1 = Math.sqrt(Math.max(0, mid + half)), s2 = Math.sqrt(Math.max(0, mid - half));
  const theta = 0.5 * Math.atan2(2 * r, p - q);                          // the direction of the long radius
  if (!Number.isFinite(near)) return { rx: s1, ry: s2, rotation: theta / RAD };
  // an ellipse turned by 180° is the same ellipse: angles count modulo 180 → the difference is taken into (−90°, 90°]
  const wrap = (v) => { v = ((v + 90) % 180 + 180) % 180 - 90; return v === -90 ? 90 : v; };
  const dLong = wrap(theta / RAD - near), dSwap = wrap(theta / RAD + 90 - near);   // the long radius along x — or along y (radii swapped)
  return Math.abs(dLong) <= Math.abs(dSwap) + 1e-9 ? { rx: s1, ry: s2, rotation: near + dLong } : { rx: s2, ry: s1, rotation: near + dSwap };
}
