/**
 * Radiance RGBE (.hdr) decoder — pure JS, no dependencies (V0.3.2.49).
 * Decodes to Float32 RGBA (linear), matching three.js RGBELoader's scaling
 * (f = 2^(e-136)) so PMREM output is identical to the reference loader.
 * Supports the common encodings: new-style per-channel RLE scanlines,
 * flat pixels, and old-style run markers.
 */
export function decodeRGBE(bytes) {
  let pos = 0;
  const readLine = () => {
    let s = '';
    while (pos < bytes.length) {
      const c = bytes[pos++];
      if (c === 0x0a) break;
      s += String.fromCharCode(c);
    }
    return s.replace(/\r$/, '');
  };

  let line = readLine();
  if (!line.startsWith('#?')) throw new Error('not a RADIANCE (.hdr) file');
  let fmtOk = false;
  while (true) {
    line = readLine();
    if (line === '') break;                       // blank line ends the header
    if (line.startsWith('FORMAT=')) fmtOk = line.includes('32-bit_rle_rgbe');
  }
  if (!fmtOk) throw new Error('unsupported RADIANCE pixel format');

  const dim = readLine().trim().split(/\s+/);     // "-Y <H> +X <W>"
  if (dim[0] !== '-Y' || dim[2] !== '+X') throw new Error('unsupported orientation: ' + dim.join(' '));
  const height = parseInt(dim[1], 10);
  const width  = parseInt(dim[3], 10);
  if (!(width > 0 && height > 0)) throw new Error('bad dimensions');

  const data = new Float32Array(width * height * 4);
  const emit = (r, g, b, e, idx) => {
    const d = idx * 4;
    if (e === 0) { data[d] = data[d + 1] = data[d + 2] = 0; }
    else {
      const f = Math.pow(2, e - 136);             // matches three RGBELoader
      data[d] = r * f; data[d + 1] = g * f; data[d + 2] = b * f;
    }
    data[d + 3] = 1;
  };

  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const rowBase = y * width;
    if (width >= 8 && width < 32768 &&
        bytes[pos] === 2 && bytes[pos + 1] === 2 &&
        ((bytes[pos + 2] << 8) | bytes[pos + 3]) === width) {
      // ── New-style RLE: 4 channels, each RLE across the scanline ────────
      pos += 4;
      for (let ch = 0; ch < 4; ch++) {
        let x = 0;
        while (x < width) {
          let n = bytes[pos++];
          if (n > 128) {                          // run of one value
            const v = bytes[pos++];
            n -= 128;
            while (n-- > 0) scan[(x++) * 4 + ch] = v;
          } else {                                // literal span
            while (n-- > 0) scan[(x++) * 4 + ch] = bytes[pos++];
          }
        }
      }
      for (let x = 0; x < width; x++) {
        emit(scan[x * 4], scan[x * 4 + 1], scan[x * 4 + 2], scan[x * 4 + 3], rowBase + x);
      }
    } else {
      // ── Flat pixels / old-style runs ───────────────────────────────────
      let x = 0;
      while (x < width) {
        const r = bytes[pos++], g = bytes[pos++], b = bytes[pos++], e = bytes[pos++];
        if (r === 1 && g === 1 && b === 1 && (rowBase + x) > 0) {
          let cnt = e;                             // repeat previous pixel
          const prev = (rowBase + x - 1) * 4;
          while (cnt-- > 0 && x < width) {
            const d = (rowBase + x) * 4;
            data[d] = data[prev]; data[d + 1] = data[prev + 1];
            data[d + 2] = data[prev + 2]; data[d + 3] = 1;
            x++;
          }
        } else {
          emit(r, g, b, e, rowBase + x);
          x++;
        }
      }
    }
  }
  return { width, height, data };
}
