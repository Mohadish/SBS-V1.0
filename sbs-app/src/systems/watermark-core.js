/**
 * SBS — Watermark core (V0.3.4.2). Pure: no DOM, no app imports — node-testable.
 *
 * A watermark is TEXT or an IMAGE laid over (or under) a page at some angle
 * and opacity. The one rule that keeps it predictable everywhere it is drawn
 * (page preview, PDF, later the video header): an image watermark is BAKED
 * ONCE, on import, into an RGBA bitmap whose transparency is real — after
 * that every output only ever applies plain opacity. No blend modes: they
 * behave differently in a canvas, a PDF and a Word file.
 *
 * Logos arrive in three shapes; each has an exact conversion:
 *   'white' — artwork on a WHITE background  → the white becomes transparent
 *   'black' — artwork on a BLACK background  → the black becomes transparent
 *   'keep'  — already has transparency        → kept as it is
 * 'white' / 'black' are the classic "colour to alpha": the result, laid back
 * over the removed colour, is pixel-identical to the original — and over any
 * other colour the artwork keeps its own colours with soft (anti-aliased) edges.
 */

export const WATERMARK_DEFAULTS = Object.freeze({
  enabled: false,
  kind: 'text',               // 'text' | 'image'
  text: 'CONFIDENTIAL',
  color: '#808080',           // mid grey: reads on the white page AND over a dark picture (black vanishes on dark, white on paper)
  fontSize: 80,               // pt — any number
  opacity: 0.22,              // 0..1
  angle: -35,                 // degrees; negative = rising to the right
  imageWidth: 60,             // % of the page width
  layer: 'over',              // 'over' everything (protects the pictures) | 'under' the text and pictures
  image: null,                // { dataUrl, w, h, mode, tint, name } — baked RGBA PNG
});

const _num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
const _hexOk = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));
// Only a base64 image data URL with sane pixel sizes. The URL is written into a <style> rule, so this
// pattern is also what keeps a hand-edited project file from smuggling markup or CSS into the page.
const _imageOk = (im) => !!im && typeof im.dataUrl === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]+$/i.test(im.dataUrl)
  && Number(im.w) >= 1 && Number(im.h) >= 1 && Number(im.w) <= 20000 && Number(im.h) <= 20000;

/** The watermark of a document, defaults filled in and every number clamped. Safe on old files (no key at all). */
export function watermarkOf(doc) {
  const w = { ...WATERMARK_DEFAULTS, ...(doc?.watermark || {}) };
  return {
    enabled: !!w.enabled,
    kind: w.kind === 'image' ? 'image' : 'text',
    text: String(w.text ?? ''),
    color: _hexOk(w.color) ? w.color : WATERMARK_DEFAULTS.color,
    fontSize: _num(w.fontSize, 6, 600, WATERMARK_DEFAULTS.fontSize),
    opacity: _num(w.opacity, 0.01, 1, WATERMARK_DEFAULTS.opacity),
    angle: _num(w.angle, -180, 180, WATERMARK_DEFAULTS.angle),
    imageWidth: _num(w.imageWidth, 5, 150, WATERMARK_DEFAULTS.imageWidth),
    layer: w.layer === 'under' ? 'under' : 'over',
    image: _imageOk(w.image) ? { ...w.image, w: Math.round(Number(w.image.w)), h: Math.round(Number(w.image.h)) } : null,
  };
}

/** Will anything be drawn? (enabled AND has content) */
export function watermarkVisible(w) {
  return !!w && w.enabled && (w.kind === 'image' ? !!w.image : !!String(w.text || '').trim());
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/**
 * Which conversion does this bitmap want?
 *   real transparency present (≥ 2 % of the pixels see-through)   → 'keep'
 *   otherwise the BORDER decides: a light frame → 'white', a dark one → 'black'
 * @param {Uint8ClampedArray|Uint8Array} px  RGBA
 */
export function detectWatermarkMode(px, w, h) {
  const n = w * h;
  if (!n) return 'keep';
  let clear = 0;
  const stride = Math.max(1, Math.floor(n / 40000));          // a sample is plenty
  let seen = 0;
  for (let i = 0; i < n; i += stride) { seen++; if (px[i * 4 + 3] < 250) clear++; }
  if (clear / seen >= 0.02) return 'keep';
  let sum = 0, cnt = 0;
  const add = (x, y) => { const o = (y * w + x) * 4; sum += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]; cnt++; };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  return (sum / cnt) >= 128 ? 'white' : 'black';
}

/**
 * Bake a bitmap into its watermark form. Returns a NEW RGBA array.
 * @param {Uint8ClampedArray|Uint8Array} px   RGBA, not premultiplied
 * @param {{mode:'white'|'black'|'keep', tint?:string|null}} o   tint '#rrggbb' = one flat colour, shape kept in the alpha
 */
export function bakeWatermarkPixels(px, w, h, o = {}) {
  const mode = o.mode === 'white' || o.mode === 'black' ? o.mode : 'keep';
  const tint = hexToRgb(o.tint);
  const out = new Uint8ClampedArray(px.length);
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    let r = px[k] / 255, g = px[k + 1] / 255, b = px[k + 2] / 255, a = px[k + 3] / 255;
    if (mode === 'white') {
      // colour-to-alpha, white: a' = 1 − min(c); c' = (c − (1 − a')) / a'   ⇒  c'·a' + 1·(1 − a') = c
      const na = 1 - Math.min(r, g, b);
      if (na > 0) { r = (r - (1 - na)) / na; g = (g - (1 - na)) / na; b = (b - (1 - na)) / na; } else { r = g = b = 0; }
      a *= na;
    } else if (mode === 'black') {
      // colour-to-alpha, black: a' = max(c); c' = c / a'   ⇒  c'·a' + 0·(1 − a') = c
      const na = Math.max(r, g, b);
      if (na > 0) { r /= na; g /= na; b /= na; } else { r = g = b = 0; }
      a *= na;
    }
    if (tint) { r = tint[0] / 255; g = tint[1] / 255; b = tint[2] / 255; }
    out[k] = Math.round(r * 255); out[k + 1] = Math.round(g * 255); out[k + 2] = Math.round(b * 255); out[k + 3] = Math.round(a * 255);
  }
  return out;
}

/** Fit (w,h) inside max×max, never enlarging. */
export function fitWithin(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

const _esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * The watermark as one absolutely-positioned HTML layer filling its (relatively
 * positioned) parent. Pure string; the caller decides where in the z-order it goes.
 * Text stays text (crisp at any zoom, tiny in the PDF); aria-hidden keeps it out
 * of the document's reading order.
 */
export function watermarkHtml(w) {
  if (!watermarkVisible(w)) return '';
  const spin = `transform:rotate(${Number(w.angle) || 0}deg);`;
  const inner = w.kind === 'image'
    ? `<div class="wmi" style="width:${w.imageWidth}%;aspect-ratio:${w.image.w}/${w.image.h};${spin}"></div>`
    : `<div class="wmt" dir="auto" style="font-size:${w.fontSize}pt;color:${_esc(w.color)};${spin}">${_esc(w.text)}</div>`;
  return `<div class="wm" aria-hidden="true" style="opacity:${w.opacity};">${inner}</div>`;
}

/**
 * The image itself, as ONE css rule for the whole document. Every page's layer is an empty
 * box that wears it — a 1 MB logo in a 100-page manual is embedded once, not 100 times.
 */
export function watermarkCss(w) {
  return (watermarkVisible(w) && w.kind === 'image') ? `.wm .wmi { background-image: url("${w.image.dataUrl}"); }` : '';
}

export const WATERMARK_CSS = `
.wm { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; pointer-events: none; }
.wm .wmt { font-weight: 700; white-space: pre; text-align: center; line-height: 1.12; letter-spacing: 0.02em; }
.wm .wmi { flex: 0 0 auto; background-repeat: no-repeat; background-position: center; background-size: contain; }
`;
