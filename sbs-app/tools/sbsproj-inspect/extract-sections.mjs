// extract-sections.mjs — stream a (gzip) .sbsproj and pull out only the small
// top-level sections: _sbs, assets, tree, colors. Never holds the whole file.
// Usage: node extract-sections.mjs "<in.sbsproj>" "<out.json>"
import fs from 'node:fs';
import zlib from 'node:zlib';

const [IN, OUT] = process.argv.slice(2);
const WANT = new Set(['_sbs', 'assets', 'tree', 'colors', 'chapters']);

const src = fs.createReadStream(IN);
const head = fs.readFileSync(IN, { start: 0, end: 1 });   // gzip magic?
const stream = (head[0] === 0x1f && head[1] === 0x8b) ? src.pipe(zlib.createGunzip()) : src;

// Byte-level JSON walker: depth, string state, escapes. At depth 1 we read
// each key; if wanted, capture its value's bytes until it closes.
let depth = 0, inStr = false, esc = false;
let keyBuf = null;            // collecting a depth-1 key (bytes)
let expectKey = false;        // after '{' or ',' at depth 1
let afterKey = null;          // key string awaiting ':'
let capKey = null, capDepth = 0, capChunks = [], capStrDepth0 = false;
const out = {};
let stepsCount = 0;           // count top-level items in "steps" cheaply
let inSteps = false, stepsItemsDepth = -1;

stream.on('data', (chunk) => {
  let start = 0;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;              // backslash
      else if (c === 0x22) { inStr = false; if (keyBuf) { afterKey = Buffer.concat(keyBuf).toString('utf8'); keyBuf = null; } }
      else if (keyBuf) keyBuf.push(chunk.subarray(i, i + 1));
      continue;
    }
    if (c === 0x22) {                               // opening quote
      inStr = true;
      if (depth === 1 && expectKey) { keyBuf = []; expectKey = false; }
      continue;
    }
    if (c === 0x7b || c === 0x5b) {                 // { [
      depth++;
      if (depth === 1) expectKey = true;
      if (afterKey !== null && depth === 2) {
        if (WANT.has(afterKey)) { capKey = afterKey; capDepth = 2; capChunks = []; start = i; }
        if (afterKey === 'steps') inSteps = true;
        afterKey = null;
      } else if (inSteps && depth === 3 && stepsItemsDepth < 0) {
        // "steps":{"schema_version":1,"items":[ {..},{..} ]} — items array at depth 3
        stepsItemsDepth = 3;
      }
      if (inSteps && depth === 4 && c === 0x7b) stepsCount++;
      continue;
    }
    if (c === 0x7d || c === 0x5d) {                 // } ]
      if (capKey && depth === capDepth) {
        capChunks.push(chunk.subarray(start, i + 1));
        out[capKey] = JSON.parse(Buffer.concat(capChunks).toString('utf8'));
        capKey = null; capChunks = [];
      }
      if (inSteps && depth === 2) inSteps = false;
      depth--;
      continue;
    }
    if (c === 0x3a && depth === 1 && afterKey !== null) {   // ':' after a depth-1 key
      // primitive value for a wanted key (rare) — handled via next token; skip
      continue;
    }
    if (c === 0x2c && depth === 1) { expectKey = true; afterKey = null; continue; }
  }
  if (capKey) capChunks.push(chunk.subarray(start));
});
stream.on('end', () => {
  out._stepsCount = stepsCount;
  fs.writeFileSync(OUT, JSON.stringify(out));
  const sizes = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, typeof v === 'number' ? v : JSON.stringify(v).length]));
  console.log(`${IN.split(/[\\/]/).pop()} → ${OUT}  sections:`, sizes);
});
stream.on('error', (e) => { console.error('stream error', e); process.exit(1); });
