#!/usr/bin/env node
/**
 * Fetch the Kokoro-82M model + all voice files into kokoro-bundle/.
 *
 * The bundle directory is gitignored; this script exists so any developer
 * (or CI) can populate it with one command. electron-builder's
 * extraResources config copies the bundle into the installer so the
 * shipped app is fully offline from first launch.
 *
 * Run from sbs-app/:
 *   node scripts/fetch-kokoro.js
 *   # or: npm run fetch-models
 *
 * Skips files that are already present at the expected size, so re-running
 * is safe / fast.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const HF_BASE = `https://huggingface.co/${REPO}/resolve/main`;
const HF_API  = `https://huggingface.co/api/models/${REPO}/tree/main`;

const ROOT       = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'kokoro-bundle', REPO);

const REQUIRED_TOP = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];
const REQUIRED_ONNX = ['onnx/model_q8f16.onnx'];

main().catch(err => { console.error(err); process.exit(1); });

async function main() {
  fs.mkdirSync(path.join(BUNDLE_DIR, 'onnx'),   { recursive: true });
  fs.mkdirSync(path.join(BUNDLE_DIR, 'voices'), { recursive: true });

  // 1. Tiny top-level files
  for (const f of REQUIRED_TOP) {
    await fetchIfMissing(f);
  }
  // 2. Big model file
  for (const f of REQUIRED_ONNX) {
    await fetchIfMissing(f);
  }
  // 3. Every voice in the HF voices/ folder
  console.log('Listing voices…');
  const voices = await listFolder('voices');
  console.log(`Found ${voices.length} voice file(s).`);
  // Concurrency cap so we don't hammer HF
  const POOL = 6;
  for (let i = 0; i < voices.length; i += POOL) {
    await Promise.all(voices.slice(i, i + POOL).map(v => fetchIfMissing(v.path, v.size)));
  }
  console.log(`\n✓ Bundle ready at ${BUNDLE_DIR}`);
  reportTotalSize(BUNDLE_DIR);
}

function reportTotalSize(dir) {
  let total = 0;
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  }
  walk(dir);
  console.log(`  Total: ${(total / 1e6).toFixed(1)} MB`);
}

function listFolder(folder) {
  return new Promise((resolve, reject) => {
    https.get(`${HF_API}/${folder}`, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HF API ${folder} returned ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end',  () => {
        try {
          const arr = JSON.parse(body);
          resolve(arr.filter(e => e.type === 'file').map(e => ({ path: e.path, size: e.size })));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchIfMissing(relPath, expectedSize) {
  const dest = path.join(BUNDLE_DIR, relPath);
  if (fs.existsSync(dest)) {
    const sz = fs.statSync(dest).size;
    if (!expectedSize || sz === expectedSize) {
      process.stdout.write(`  ✓ ${relPath} (cached)\n`);
      return Promise.resolve();
    }
    // Size mismatch — re-download.
    fs.unlinkSync(dest);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return downloadFile(`${HF_BASE}/${relPath}`, dest, relPath);
}

function downloadFile(url, dest, label) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      // HuggingFace uses 302 redirects (sometimes relative) to S3 / xet for LFS files.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        downloadFile(next, dest, label).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`${label} → HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      let lastReported = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', chunk => {
        received += chunk.length;
        if (total > 1e6 && received - lastReported > total / 10) {
          process.stdout.write(`\r  ⇣ ${label} ${(received / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`);
          lastReported = received;
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close();
        process.stdout.write(`\r  ✓ ${label}${' '.repeat(30)}\n`);
        resolve();
      });
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}
