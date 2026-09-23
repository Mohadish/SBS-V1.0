/**
 * SBS — inline SVG icons (V0.3.4.115).
 * ───────────────────────────────────
 * Small pictograms the UI drops into buttons as markup. Vector, so they stay
 * crisp at any button size, and they carry their own colours (no emoji font
 * lottery between machines).
 *
 * eyedropperSvg — the pipette the user chose (2026-09-23) in place of the 💧
 * emoji: a dark rubber bulb with its collar, a light glass tube tapering to a
 * rounded tip, at 45° with the tip bottom-left. Drawn upright in a 24-unit box
 * and rotated about the centre.
 */

const BULB = '#454a52';   // the rubber (a touch lighter than the picture's, for the dark panels)
const GLASS = '#e3e4e6';  // the glass

/** @param {number} size  rendered width/height in px
 *  @param {string} extra additional inline CSS for the <svg> (e.g. 'opacity:.8;') */
export function eyedropperSvg(size = 20, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:middle;flex:none;pointer-events:none;${extra}">` +
    `<g transform="rotate(45 12 12)">` +
      `<path fill="${GLASS}" d="M10 10.2h4l-.3 8.4c0 .5-.3 .9-.8 1.1h-1.8c-.5-.2-.8-.6-.8-1.1z"/>` +   // the tube, tapering to a shoulder
      `<rect fill="${GLASS}" x="10.9" y="18.6" width="2.2" height="4.4" rx="1.1"/>` +  // the tip, rounded
      `<path fill="${BULB}" d="M9.2 8.5V3.8a2.8 2.8 0 0 1 5.6 0v4.7z"/>` +             // the bulb, round top
      `<rect fill="${BULB}" x="8.6" y="8.2" width="6.8" height="2" rx=".7"/>` +        // the collar
    `</g></svg>`;
}
