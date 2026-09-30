// extract-step-trees.mjs — stream a .sbsproj; for every step capture id, name,
// snapshot.tree (structure) and the visibility/transforms entries of the
// watched ids only. Never holds the whole file.
// Usage: node extract-step-trees.mjs "<in.sbsproj>" "<out.json>" id1,id2,...
import fs from 'node:fs';
import zlib from 'node:zlib';

const [IN, OUT, IDS = ''] = process.argv.slice(2);
const watch = new Set(IDS.split(',').filter(Boolean));

const src = fs.createReadStream(IN);
const head = fs.readFileSync(IN, { start: 0, end: 1 });
const stream = (head[0] === 0x1f && head[1] === 0x8b) ? src.pipe(zlib.createGunzip()) : src;

// Byte walker with a key path. isObj[d] = container at depth d is an object.
let depth = 0, inStr = false, esc = false;
const isObj = [], key = [];        // key[d] = key under which the container at depth d+1 lives
const expectKey = [];              // expectKey[d] = next string at depth d is a key
let keyBuf = null, pendingKey = null, strBuf = null;
let cap = null;                    // { d, chunks, start, path, item }
const captures = [];
let itemIdx = -1;

function pathAt(d) { const p = []; for (let i = 1; i < d; i++) p.push(key[i] === undefined ? '*' : key[i]); return p; }
function want(p) {
  if (p[0] !== 'steps' || p[1] !== 'items') return false;
  if (p.length === 4) return p[2] === '*' && (p[3] === 'id' || p[3] === 'name');
  if (p.length === 5 && p[3] === 'snapshot') return p[4] === 'tree' || p[4] === 'visibility' || p[4] === 'transforms';
  return false;
}

stream.on('data', (chunk) => {
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;
      else if (c === 0x22) {
        inStr = false;
        if (keyBuf) { pendingKey = Buffer.concat(keyBuf).toString('utf8'); keyBuf = null; }
        else if (strBuf && !cap) {
          // primitive string value — path = containers + pending key
          const p = pathAt(depth).concat(pendingKey === null ? '*' : pendingKey);
          if (want(p)) captures.push({ path: p, item: itemIdx, value: Buffer.concat(strBuf).toString('utf8') });
          strBuf = null; pendingKey = null;
        }
      }
      else if (keyBuf) keyBuf.push(chunk.subarray(i, i + 1));
      else if (strBuf) strBuf.push(chunk.subarray(i, i + 1));
      continue;
    }
    if (c === 0x22) {
      inStr = true;
      if (expectKey[depth]) { keyBuf = []; expectKey[depth] = false; }
      else if (!cap) strBuf = [];
      continue;
    }
    if (c === 0x7b || c === 0x5b) {
      key[depth] = isObj[depth] ? pendingKey : undefined;   // array items have no key
      pendingKey = null;
      const p = pathAt(depth + 1);
      if (p.length === 3 && p[0] === 'steps' && p[1] === 'items' && p[2] === '*' && c === 0x7b) itemIdx++;
      if (!cap && want(p)) cap = { d: depth + 1, chunks: [], start: i, path: p, item: itemIdx };
      depth++;
      isObj[depth] = c === 0x7b;
      expectKey[depth] = isObj[depth];
      continue;
    }
    if (c === 0x7d || c === 0x5d) {
      if (cap && depth === cap.d) {
        cap.chunks.push(chunk.subarray(cap.start, i + 1));
        captures.push({ path: cap.path, item: cap.item, value: JSON.parse(Buffer.concat(cap.chunks).toString('utf8')) });
        cap = null;
      }
      depth--;
      pendingKey = null;
      continue;
    }
    if (c === 0x2c) { expectKey[depth] = isObj[depth]; pendingKey = null; strBuf = null; continue; }
  }
  if (cap) { cap.chunks.push(chunk.subarray(cap.start)); cap.start = 0; }
});
stream.on('end', () => {
  const steps = [];
  for (const c of captures) {
    const s = steps[c.item] || (steps[c.item] = { i: c.item });
    const k = c.path[c.path.length - 1];
    if (k === 'tree') s.tree = c.value;
    else if (k === 'visibility' || k === 'transforms') { s[k] = {}; for (const id of watch) if (id in c.value) s[k][id] = c.value[id]; }
    else s[k] = c.value;
  }
  fs.writeFileSync(OUT, JSON.stringify(steps));
  console.log(`${IN.split(/[\\/]/).pop()} → ${OUT}: ${steps.length} steps, ${steps.filter(s => s.tree).length} with tree, ${steps.filter(s => s.visibility).length} with visibility`);
});
stream.on('error', (e) => { console.error('stream error', e); process.exit(1); });
