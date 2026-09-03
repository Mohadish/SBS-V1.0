/**
 * SBS — Text drop shadow + outline (V0.3.2.144)
 *
 * Per-text-box effects, applied to the WHOLE box (not per character).
 * Both compile down to a single CSS `text-shadow` list, which the
 * SVG-foreignObject rasteriser understands — so the same declaration
 * drives the live canvas and the exported frames with no second code path.
 *
 * Why text-shadow for BOTH
 * ────────────────────────
 * The obvious choice for the outline is `-webkit-text-stroke`, but two
 * Chromium facts rule it out (probed against Chrome 148, the engine this
 * app ships on):
 *
 *   1. -webkit-text-stroke is CENTRED on the glyph outline, so half of it
 *      eats into the letterform.
 *   2. `paint-order: stroke fill` — the usual fix, which puts the fill back
 *      on top — is IGNORED for HTML text inside a foreignObject. Measured:
 *      the glyph interior renders stroke-coloured with and without it.
 *
 * A ring of hard-edged shadows has neither problem: shadows always paint
 * BEHIND the glyph, so the letterform stays crisp and the outline sits
 * entirely outside it. Verified in the same probe (fill intact, outline
 * present).
 *
 * The ring also gives us the shadow's "expansion", which plain CSS
 * text-shadow has no parameter for — it offers offset, blur and colour,
 * but no spread. Sampling the shadow around a circle of radius = spread
 * thickens it outward, which is what spread means.
 *
 * Cost note: each ring sample is another shadow the compositor draws, so
 * sample counts are kept proportional to the radius and capped.
 */

/**
 * Drop shadow defaults.
 *
 * Angle is in SCREEN coordinates, where y grows downward — so 0° points
 * right, 90° points down, and 45° is the conventional down-right drop
 * shadow. (Not 135°, which is down-LEFT here; the maths-convention
 * reflex is wrong on a canvas.)
 */
export function defaultShadow() {
  return { color: '#000000', opacity: 0.75, distance: 3, angle: 45, blur: 4, spread: 0 };
}

export function defaultOutline() {
  return { color: '#000000', opacity: 1, thickness: 2 };
}

const _num = (v, dflt, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

export function normaliseShadow(s) {
  if (!s) return null;
  const d = defaultShadow();
  return {
    color:    typeof s.color === 'string' ? s.color : d.color,
    opacity:  _num(s.opacity,  d.opacity,  0, 1),
    distance: _num(s.distance, d.distance, 0, 200),
    angle:    _num(s.angle,    d.angle,    0, 360),
    blur:     _num(s.blur,     d.blur,     0, 100),
    spread:   _num(s.spread,   d.spread,   0, 50),
  };
}

export function normaliseOutline(o) {
  if (!o) return null;
  const d = defaultOutline();
  return {
    color:     typeof o.color === 'string' ? o.color : d.color,
    opacity:   _num(o.opacity,   d.opacity,   0, 1),
    thickness: _num(o.thickness, d.thickness, 0, 50),
  };
}

/** '#rrggbb' + 0..1 alpha → 'rgba(r,g,b,a)'. Passes non-hex through. */
function _rgba(hex, alpha) {
  const a = Math.max(0, Math.min(1, Number(alpha)));
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return String(hex || '#000000');
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * How many samples to place around a ring of the given radius. Too few
 * and the ring scallops between samples; too many and we hand the
 * compositor hundreds of shadow passes for no visible gain.
 */
function _ringSamples(radius) {
  return Math.max(12, Math.min(64, Math.ceil(radius * 8)));
}

/** One ring of shadows at `radius` around (cx, cy). radius 0 → single sample. */
function _ring(cx, cy, radius, blur, colour) {
  if (radius <= 0) return [`${cx.toFixed(2)}px ${cy.toFixed(2)}px ${blur.toFixed(2)}px ${colour}`];
  const n   = _ringSamples(radius);
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    out.push(
      `${(cx + radius * Math.cos(a)).toFixed(2)}px ` +
      `${(cy + radius * Math.sin(a)).toFixed(2)}px ` +
      `${blur.toFixed(2)}px ${colour}`,
    );
  }
  // Fill the middle too, or a blurred ring reads as a hollow halo.
  out.push(`${cx.toFixed(2)}px ${cy.toFixed(2)}px ${blur.toFixed(2)}px ${colour}`);
  return out;
}

/**
 * Compile shadow + outline into one CSS text-shadow value.
 *
 * Returns { css, extent } where `extent` is how far the effect reaches
 * beyond the glyphs, in px. The caller uses it to make sure the box has
 * enough padding for the effect to render inside the raster — the SVG has
 * hard bounds, so anything past them is simply cut off.
 *
 * The outline is listed FIRST: in a text-shadow list, earlier entries
 * paint on top, and the outline hugs the glyph while the drop shadow
 * belongs behind it.
 */
export function textEffectsCss(shadow, outline) {
  const sh = normaliseShadow(shadow);
  const ol = normaliseOutline(outline);
  const parts = [];
  let extent = 0;

  if (ol && ol.thickness > 0 && ol.opacity > 0) {
    parts.push(..._ring(0, 0, ol.thickness, 0, _rgba(ol.color, ol.opacity)));
    extent = Math.max(extent, ol.thickness);
  }

  if (sh && sh.opacity > 0 && (sh.distance > 0 || sh.blur > 0 || sh.spread > 0)) {
    const rad = (sh.angle * Math.PI) / 180;
    const dx  = sh.distance * Math.cos(rad);
    const dy  = sh.distance * Math.sin(rad);
    parts.push(..._ring(dx, dy, sh.spread, sh.blur, _rgba(sh.color, sh.opacity)));
    extent = Math.max(extent, sh.distance + sh.spread + sh.blur);
  }

  return { css: parts.join(','), extent: Math.ceil(extent) };
}

/** True when either effect would actually draw something. */
export function hasTextEffects(shadow, outline) {
  return !!textEffectsCss(shadow, outline).css;
}
