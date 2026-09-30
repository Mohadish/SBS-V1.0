// repair-lens.mjs — single-pass streaming repair of one node in project.tree.root.
// Reads <broken.sbsproj>, replaces the node whose id matches with the node taken
// from <good-sections.json> (an extract-sections.mjs output), writes a NEW gzip
// .sbsproj. Everything outside the "tree" section is copied byte-for-byte.
// Usage: node repair-lens.mjs "<broken.sbsproj>" "<good-sections.json>" <nodeId> "<out.sbsproj>"
import fs from 'node:fs';
import zlib from 'node:zlib';

const [IN, GOOD, NODE_ID, OUT] = process.argv.slice(2);
if (!IN || !GOOD || !NODE_ID || !OUT) { console.error('usage: in good.json nodeId out'); process.exit(1); }
if (fs.existsSync(OUT)) { console.error('refusing to overwrite', OUT); process.exit(1); }

const good = JSON.parse(fs.readFileSync(GOOD, 'utf8'));
let goodNode = null;
(function w(n) { if (!n || goodNode) return; if (n.id === NODE_ID) { goodNode = n; return; } (n.children || []).forEach(w); })(good.tree.root);
if (!goodNode) { console.error('node not found in good tree'); process.exit(1); }

const head = fs.readFileSync(IN, { start: 0, end: 1 });
const gz = head[0] === 0x1f && head[1] === 0x8b;
const src = fs.createReadStream(IN);
const inStream = gz ? src.pipe(zlib.createGunzip()) : src;
const outGz = zlib.createGzip({ level: 6 });
const outFile = fs.createWriteStream(OUT);
outGz.pipe(outFile);

// Walker: find the depth-1 key "tree" and buffer its value; pass everything else through.
let depth = 0, inStr = false, esc = false, expectKey = false, keyBuf = null, pendingKey = null;
let capturing = false, capDepth = 0, capChunks = [];
let done = false, patched = false;
const write = (buf) => { if (buf.length) outGz.write(buf); };

inStream.on('data', (chunk) => {
  if (done) { write(chunk); return; }
  let passStart = 0;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 0x5c) esc = true;
      else if (c === 0x22) { inStr = false; if (keyBuf) { pendingKey = Buffer.concat(keyBuf).toString('utf8'); keyBuf = null; } }
      else if (keyBuf) keyBuf.push(chunk.subarray(i, i + 1));
      continue;
    }
    if (c === 0x22) { inStr = true; if (depth === 1 && expectKey) { keyBuf = []; expectKey = false; } continue; }
    if (c === 0x7b || c === 0x5b) {
      if (depth === 1 && pendingKey === 'tree' && !capturing) {
        // pass through everything before this byte, start capturing from it
        write(chunk.subarray(passStart, i));
        capturing = true; capDepth = 2; capChunks = [chunk.subarray(i, i + 1)]; passStart = i + 1;
        pendingKey = null; depth++; continue;
      }
      pendingKey = null;
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (c === 0x7d || c === 0x5d) {
      if (capturing && depth === capDepth) {
        capChunks.push(chunk.subarray(passStart, i + 1));
        const tree = JSON.parse(Buffer.concat(capChunks).toString('utf8'));
        let hit = 0;
        (function w(n) { if (!n) return; const kids = n.children || [];
          for (let k = 0; k < kids.length; k++) {
            if (kids[k].id === NODE_ID) {
              const keep = kids[k];
              const fixed = { ...goodNode, children: keep.children || [], localVisible: keep.localVisible, archived: keep.archived === true };
              delete fixed._preservedNotesForRebuild;
              kids[k] = fixed; hit++;
            } else w(kids[k]);
          } })(tree.root);
        if (hit !== 1) { console.error(`expected exactly one ${NODE_ID} in tree.root, found ${hit}`); process.exit(1); }
        write(Buffer.from(JSON.stringify(tree), 'utf8'));
        patched = true; capturing = false; done = true;
        passStart = i + 1;
        write(chunk.subarray(passStart));
        return;
      }
      depth--;
      continue;
    }
    if (c === 0x2c && depth === 1) { expectKey = true; pendingKey = null; continue; }
  }
  if (capturing) capChunks.push(chunk.subarray(passStart));
  else write(chunk.subarray(passStart));
});
inStream.on('end', () => {
  outGz.end();
  outFile.on('finish', () => {
    if (!patched) { console.error('tree section never found — nothing patched'); process.exit(1); }
    console.log(`repaired ${NODE_ID} → ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
  });
});
inStream.on('error', (e) => { console.error('stream error', e); process.exit(1); });
