#!/usr/bin/env node
/*
 * SBS project translator — translate every on-screen + narration string in a
 * .sbsproj from one language to another, deterministically, without corrupting
 * anything else. The terminology "skill" lives in glossary.<src>-<tgt>.json, so
 * quality improves by editing the glossary, not by needing a human each run.
 *
 * Usage:
 *   GOOGLE_API_KEY=xxx node translate-project.js <in.sbsproj> <out.sbsproj> [--src iw] [--tgt en] [--voice os:kokoro|am_echo] [--mock]
 *
 *   --mock   run the whole pipeline with a fake translator (no API/key) to
 *            verify extraction + reinsertion + gzip round-trip on a real file.
 *
 * What it translates: chapter names, non-default step names, narration text,
 * overlay userTextBox captions (HTML), header custom items (HTML). Narration
 * audio is cleared + the voice swapped so the app re-synthesizes in the target
 * language. Everything else (assets, tree, transforms, positions, header
 * ARRANGEMENT) is byte-preserved.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- args ----
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--mock') flags.mock = true;
  else if (a.startsWith('--')) { flags[a.slice(2)] = argv[++i]; }
  else pos.push(a);
}
const IN = pos[0], OUT = pos[1];
const SRC = flags.src || 'iw';                       // Google uses 'iw' for Hebrew
const TGT = flags.tgt || 'en';
const VOICE = flags.voice || 'os:kokoro|am_echo';    // narration re-synth voice
const MOCK = !!flags.mock;
const KEY = process.env.GOOGLE_API_KEY || flags.key || '';
if (!IN || !OUT) { console.error('usage: node translate-project.js <in.sbsproj> <out.sbsproj> [--src iw --tgt en --voice os:kokoro|am_echo --mock]'); process.exit(2); }
if (!MOCK && !KEY) { console.error('No GOOGLE_API_KEY (set env var or --key, or pass --mock).'); process.exit(2); }

const glossaryPath = path.join(__dirname, `glossary.${SRC}-${TGT}.json`);
const G = fs.existsSync(glossaryPath) ? JSON.parse(fs.readFileSync(glossaryPath, 'utf8')) : { keep: [], keepPatterns: [], force: {} };

// ---- glossary protection: wrap protected spans so the API leaves them verbatim ----
// keep terms → themselves; force terms → their target; keepPatterns → verbatim.
// Longest source first so multi-word terms win over their sub-words.
const forcePairs = Object.entries(G.force || {}).sort((a, b) => b[0].length - a[0].length);
const keepList = (G.keep || []).slice().sort((a, b) => b.length - a.length);
const NT_OPEN = '<span translate="no">', NT_CLOSE = '</span>';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Protect within a PLAIN string; returns an html fragment for format=html.
function protectPlain(text) {
  let t = esc(text);
  for (const [src, tgt] of forcePairs) if (src) t = t.split(esc(src)).join(NT_OPEN + esc(tgt) + NT_CLOSE);
  for (const k of keepList) if (k) t = t.split(esc(k)).join(NT_OPEN + esc(k) + NT_CLOSE);
  for (const p of (G.keepPatterns || [])) t = t.replace(new RegExp(p, 'g'), (m) => NT_OPEN + esc(m) + NT_CLOSE);
  return t;
}
// Protect within an existing HTML string (only the source-language TEXT terms —
// they never appear inside ASCII style attributes, so a plain replace is safe).
function protectHtml(html) {
  let t = html;
  for (const [src, tgt] of forcePairs) if (src) t = t.split(src).join(NT_OPEN + esc(tgt) + NT_CLOSE);
  for (const k of keepList) if (k && /[^\x00-\x7F]/.test(k)) t = t.split(k).join(NT_OPEN + esc(k) + NT_CLOSE);
  return t;
}
function unwrapNoTranslate(s) { return s.replace(/<span translate="no">([\s\S]*?)<\/span>/g, '$1'); }
function stripTags(s) {
  return unwrapNoTranslate(s).replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
}
// Hebrew/Arabic captions read RTL; flip alignment when going to a LTR target.
const isRtl = (l) => ['iw', 'he', 'ar', 'fa', 'ur'].includes(l);
const isLtr = (l) => !isRtl(l);
function flipDirection(html) {
  if (!(isRtl(SRC) && isLtr(TGT))) return html;
  return html.replace(/text-align:\s*right/gi, 'text-align:left').replace(/direction:\s*rtl/gi, 'direction:ltr');
}

// ---- machine translation ----
async function gTranslate(qs, format) {
  if (MOCK) return qs.map(q => unwrapNoTranslate(q).replace(/[֐-׿]+/g, 'XX'));   // fake: Hebrew runs → XX, forced terms survive
  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: qs, source: SRC, target: TGT, format }),
  });
  if (!res.ok) throw new Error(`Translate API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return j.data.translations.map(t => t.translatedText);
}
async function translateBatch(texts, format) {
  const out = []; const B = 64;
  for (let i = 0; i < texts.length; i += B) out.push(...await gTranslate(texts.slice(i, i + B), format));
  return out;
}

// ---- extraction / reinsertion (shared DFS so ordinals line up) ----
const DEFAULT_STEP = /^(__base__|New Step( \(copy\))*|Step \d+)$/;
function walkUserTextBoxes(ov, cb) { let ord = 0; (function w(n){ if(!n||typeof n!=='object')return; const a=n.attrs||{}; if(a.textHtml&&a.name==='userTextBox')cb(n,ord++); (n.children||[]).forEach(w); })(ov); }

(async () => {
  const raw = zlib.gunzipSync(fs.readFileSync(IN)).toString('utf8');
  const p = JSON.parse(raw);
  const steps = p.steps?.items || p.steps || [];
  const chapters = p.chapters?.items || p.chapters || [];
  const hItems = p.headers?.items || [];
  const heb = /[֐-׿]/;   // still-untranslated = contains source-script chars

  // Collect units (skip anything already in the target language).
  const plain = [], html = [];   // { apply(translated) }
  chapters.forEach(c => { if (c?.name && heb.test(c.name)) plain.push({ src: c.name, apply: v => c.name = v }); });
  steps.forEach(s => { if (s?.name && !DEFAULT_STEP.test(s.name) && heb.test(s.name)) plain.push({ src: s.name, apply: v => s.name = v }); });
  steps.forEach(s => { const t = s?.narration?.text; if (t && heb.test(t)) plain.push({ src: t, apply: v => s.narration.text = v }); });
  steps.forEach(s => {
    if (!s.overlay) return;
    let ov = s.overlay, wasStr = typeof ov === 'string';
    try { if (wasStr) ov = JSON.parse(ov); } catch { return; }
    let touched = false;
    walkUserTextBoxes(ov, (node) => { if (heb.test(node.attrs.textHtml)) { html.push({ src: node.attrs.textHtml, apply: v => { node.attrs.textHtml = v; touched = true; } }); } });
    // defer re-stringify until after apply; stash a finalizer
    html._finalizers = html._finalizers || [];
    html._finalizers.push(() => { if (touched) s.overlay = wasStr ? JSON.stringify(ov) : ov; });
  });
  hItems.forEach(h => { if (h.kind === 'custom' && h.textHtml && heb.test(h.textHtml)) html.push({ src: h.textHtml, apply: v => h.textHtml = v }); });

  console.log(`extracting: ${plain.length} plain + ${html.length} html unit(s) still in ${SRC}`);

  // Translate.
  if (plain.length) {
    const tr = await translateBatch(plain.map(u => protectPlain(u.src)), 'html');
    plain.forEach((u, i) => u.apply(stripTags(tr[i]).trim()));
  }
  if (html.length) {
    const tr = await translateBatch(html.map(u => protectHtml(u.src)), 'html');
    html.forEach((u, i) => u.apply(flipDirection(unwrapNoTranslate(tr[i]))));
  }
  (html._finalizers || []).forEach(fn => fn());

  // Narration: clear ALL cached audio + swap voice so the app re-synthesizes in
  // the target language. (Even untouched clips: their old-language audio is stale.)
  let cleared = 0;
  steps.forEach(s => { if (s?.narration?.text?.trim()) { delete s.narration.dataUrl; delete s.narration.dataFile; delete s.narration.mime; s.narration.voiceId = VOICE; cleared++; } });
  if (p.settings?.export) p.settings.export.narrationVoice = VOICE;

  const json = JSON.stringify(p);
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
  fs.writeFileSync(OUT, gz);
  console.log(`voice → ${VOICE}, cleared ${cleared} narration clip(s) for re-synth`);
  console.log(`wrote ${OUT}  (${(gz.length / 1e6).toFixed(2)} MB gz / ${(json.length / 1e6).toFixed(2)} MB json)${MOCK ? '  [MOCK translation]' : ''}`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
