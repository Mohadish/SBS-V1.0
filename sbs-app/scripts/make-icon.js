/**
 * make-icon.js — generate assets/icons/icon.ico (+ icon.png) with no
 * external dependencies. Draws a clean "steps" mark on a blue gradient
 * rounded square, encodes a 256x256 RGBA PNG (zlib), and wraps it in a
 * Vista-style PNG-in-ICO container.
 *
 * Run: node scripts/make-icon.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;                       // icon size (px)
const buf = Buffer.alloc(S * S * 4); // RGBA

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // simple source-over alpha blend onto existing pixel
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) { buf[i] = buf[i+1] = buf[i+2] = buf[i+3] = 0; return; }
  buf[i]   = Math.round((r * sa + buf[i]   * da * (1 - sa)) / oa);
  buf[i+1] = Math.round((g * sa + buf[i+1] * da * (1 - sa)) / oa);
  buf[i+2] = Math.round((b * sa + buf[i+2] * da * (1 - sa)) / oa);
  buf[i+3] = Math.round(oa * 255);
}

// rounded-rect coverage test (with sub-pixel-ish AA via distance)
function inRoundRect(x, y, x0, y0, x1, y1, rad) {
  const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
  const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
    const dx = x - cx, dy = y - cy;
    return (dx * dx + dy * dy) <= rad * rad;
  }
  return false;
}

function fillRoundRect(x0, y0, x1, y1, rad, colorFn) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // 2x2 supersample for smoother edges
      let cov = 0;
      for (const oy of [0.25, 0.75]) for (const ox of [0.25, 0.75]) {
        if (inRoundRect(x + ox, y + oy, x0, y0, x1, y1, rad)) cov++;
      }
      if (cov === 0) continue;
      const [r, g, b] = colorFn(x, y);
      setPx(x, y, r, g, b, Math.round((cov / 4) * 255));
    }
  }
}

// ── Background: blue→sky vertical gradient, rounded square ──
const TOP = [0x1e, 0x40, 0xaf];   // blue-800
const BOT = [0x0e, 0xa5, 0xe9];   // sky-500
fillRoundRect(8, 8, S - 9, S - 9, 48, (x, y) => {
  const t = y / S;
  return [
    Math.round(TOP[0] + (BOT[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOT[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOT[2] - TOP[2]) * t),
  ];
});

// ── Three white "step" blocks forming an ascending staircase ──
const white = () => [0xff, 0xff, 0xff];
const soft  = () => [0xe2, 0xf2, 0xfd];
const blk = 58, gap = 10, r = 12;
// bottom-left, middle, top-right ascending
const baseX = 46, baseY = 168;
const steps = [
  { x: baseX,                 y: baseY,                 c: soft  },
  { x: baseX + blk + gap,     y: baseY - blk - gap,     c: white },
  { x: baseX + 2*(blk+gap),   y: baseY - 2*(blk+gap),   c: white },
];
for (const s of steps) {
  fillRoundRect(s.x, s.y, s.x + blk, s.y + blk, r, s.c);
}

// ───────────────────────── PNG encode ─────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// filtered scanlines (filter byte 0 per row)
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

// ───────────────────────── ICO wrap ─────────────────────────
const dir = Buffer.alloc(6 + 16);
dir.writeUInt16LE(0, 0);  // reserved
dir.writeUInt16LE(1, 2);  // type = icon
dir.writeUInt16LE(1, 4);  // count
dir[6]  = 0;  // width 0 => 256
dir[7]  = 0;  // height 0 => 256
dir[8]  = 0;  // palette
dir[9]  = 0;  // reserved
dir.writeUInt16LE(1, 10);   // planes
dir.writeUInt16LE(32, 12);  // bpp
dir.writeUInt32LE(png.length, 14); // bytes in res
dir.writeUInt32LE(22, 18);         // offset
const ico = Buffer.concat([dir, png]);

const outDir = path.join(__dirname, '..', 'assets', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log(`Wrote ${path.join(outDir, 'icon.ico')} (${ico.length} bytes) + icon.png (${png.length} bytes)`);
