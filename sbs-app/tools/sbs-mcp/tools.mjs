// sbs-mcp tools — thin wrappers: python (PyMuPDF) for the PDF side, the app's own modules for sheets + the project.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, basename, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..');
const PY = process.env.SBS_MCP_PYTHON || 'python';

const text = (s) => ({ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) });
const image = (path) => ({ type: 'image', data: readFileSync(path).toString('base64'), mimeType: extname(path).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png' });
const ok = (...content) => ({ content });
const workFor = (path, work) => work || (path.replace(/\.[^.\\/]+$/, '') + '.sbswork');

function py(args, { timeout = 600000 } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(PY, [join(HERE, 'pdf_tools.py'), ...args], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const t = setTimeout(() => { p.kill(); rej(new Error('python timed out')); }, timeout);
    p.on('close', (code) => {
      clearTimeout(t);
      let j = null; try { j = JSON.parse(out); } catch { /* not json */ }
      if (j?.error) return rej(new Error(j.error));
      if (code !== 0 && !j) return rej(new Error(`python exit ${code}: ${err.slice(-1200) || out.slice(-400)}`));
      res(j ?? { raw: out });
    });
    p.on('error', e => { clearTimeout(t); rej(new Error(`cannot run ${PY}: ${e.message}`)); });
  });
}

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const P = {
  path: { type: 'string', description: 'absolute path of the document' },
  work: { type: 'string', description: 'work folder (default: <document>.sbswork next to it)' },
};

export const TOOLS = [
  { name: 'doc_inspect', description: 'What kind of PDF is this: pages, text, image tiles (strip-sliced screenshots?), figure/table captions, fonts, a per-page outline. Writes <work>/structure.json + text-lines.txt. Run first.',
    inputSchema: S({ path: P.path, work: P.work }, ['path']),
    run: async ({ path, work }) => ok(text(await py(['inspect', path, workFor(path, work)]))) },
  { name: 'doc_text', description: 'The text lines of the given pages (y x size[B] text), from the text layer. Words that became vector outlines are NOT here — doc_holes finds them.',
    inputSchema: S({ path: P.path, pages: { type: 'string', description: 'e.g. "13-20,33" (default: all)' }, work: P.work }, ['path']),
    run: async ({ path, pages, work }) => ok(text((await py(['text', path, workFor(path, work), pages || ''])).text)) },
  { name: 'doc_page', description: 'Render a page (or a region of it, in PDF points) to a PNG and return it — to LOOK at a page, a figure, or a text row.',
    inputSchema: S({ path: P.path, page: { type: 'integer' }, dpi: { type: 'integer', description: 'default 110; 200–300 for small text' }, clip: { type: 'array', items: { type: 'number' }, description: '[x0,y0,x1,y1] in points (optional)' }, work: P.work }, ['path', 'page']),
    run: async ({ path, page, dpi, clip, work }) => { const r = await py(['page', path, workFor(path, work), String(page), String(dpi || 110), ...(clip?.length === 4 ? clip.map(String) : [])]); return ok(text(r), image(r.path)); } },
  { name: 'doc_figures', description: 'Find every "Figure N:" region (image strips assigned to the caption below them) and render each at 300 dpi to <work>/figures/<key>.png (never extracts embedded images — Print-To-PDF slices them). Vector figures and tables have no strips: pass overrides {"T1": {"page": 10, "rect": [x0,y0,x1,y1], "caption": "Table 1"}} (points; measure with doc_page).',
    inputSchema: S({ path: P.path, overrides: { type: 'object', description: 'extra / replacement regions by key' }, work: P.work }, ['path']),
    run: async ({ path, overrides, work }) => {
      const w = workFor(path, work); mkdirSync(w, { recursive: true });
      const op = join(w, 'overrides.json');
      if (overrides && Object.keys(overrides).length) { const cur = existsSync(op) ? JSON.parse(readFileSync(op, 'utf8')) : {}; writeFileSync(op, JSON.stringify({ ...cur, ...overrides }, null, 1)); }
      const r = await py(['figures', path, w, existsSync(op) ? op : '']);
      const list = Object.entries(r.figures).map(([k, f]) => `${k}  p${f.page}  ${f.w}×${f.h}px  ${f.caption}`).join('\n');
      return ok(text(`${r.count} figures → ${join(w, 'figures')}\n${list}\n\nmissing (captions without pictures): ${r.missing_captions_without_pictures.join(', ') || 'none'}\n${r.hint}`));
    } },
  { name: 'doc_holes', description: 'Find the text rows whose words became vector outlines (absent from the text layer — typically curly-quoted names, IP addresses, passwords) and return contact-sheet images of those rows to read. Transcribe what they say into the steps.',
    inputSchema: S({ path: P.path, pages: { type: 'string', description: 'only these pages, e.g. "13-36" (default: all)' }, max_images: { type: 'integer', description: 'how many sheets to return inline (default 12); the rest come as paths' }, work: P.work }, ['path']),
    run: async ({ path, pages, max_images = 12, work }) => {
      const r = await py(['holes', path, workFor(path, work)]);
      let sheets = r.sheets;
      if (pages) { const want = new Set(expand(pages)); sheets = sheets.filter(s => want.has(s.page)); }
      const content = [text(`${r.pages} pages hold ${r.boxes} outlined words. ${r.hint}\nsheets: ${sheets.map(s => `p${s.page}`).join(' ')}`)];
      sheets.slice(0, max_images).forEach(s => { content.push(text(`— page ${s.page}, rows y=${s.rows_y.join(',')} —`)); content.push(image(s.path)); });
      if (sheets.length > max_images) content.push(text('more sheets (paths): ' + sheets.slice(max_images).map(s => s.path).join('\n')));
      return { content };
    } },
  { name: 'sheet_inspect', description: 'Read an Excel / ods / csv with the app\'s own reader: sheets, size, the first rows, which columns hold pictures. For client spreadsheets before planning the steps.',
    inputSchema: S({ path: P.path, rows: { type: 'integer', description: 'how many rows to show per sheet (default 40)' }, sheet: { type: 'string', description: 'show only this sheet' } }, ['path']),
    run: async ({ path, rows = 40, sheet }) => {
      globalThis.window = globalThis.window || {}; globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
      const R = await import(pathToFileURL(join(APP, 'src', 'io', 'sheet-read.js')).href);
      const book = await R.readSheetFile(basename(path), new Uint8Array(readFileSync(path)));
      const out = [];
      for (const s of book.sheets) {
        if (sheet && s.name !== sheet) continue;
        const width = s.rows.reduce((m, r) => Math.max(m, r.length), 0);
        const picCols = {};
        for (const k of Object.keys(s.images || {})) { const c = Number(k.split(',')[1]); picCols[c] = (picCols[c] || 0) + 1; }
        out.push(`## sheet "${s.name}" — ${s.rows.length} rows × ${width} cols${s.error ? ' — ' + s.error : ''}; pictures per column: ${JSON.stringify(picCols)}; skipped pictures: ${s.imagesSkipped}`);
        s.rows.slice(0, rows).forEach((r, i) => out.push(`${i + 1}\t` + r.map((c, ci) => (String(c ?? '').replace(/\s+/g, ' ').slice(0, 60)) + (s.images?.[`${i},${ci}`] ? ' [picture]' : '')).join('\t')));
      }
      return ok(text(out.join('\n')));
    } },
  { name: 'steps_write', description: 'Write <work>/steps.json — the curated step table — and prepare web-sized media for the figures it uses. steps = { chapters: {"C01": "name", …}, rows: [{ch, name, voice, notes, figs: ["F23"], title, page, docstep}] }. Figure keys must exist in <work>/figures.json (doc_figures) unless `images` gives their paths.',
    inputSchema: S({ work: { type: 'string' }, steps: { type: 'object' }, images: { type: 'object', description: 'optional {key: {path, w, h, caption}} for pictures not from doc_figures' } }, ['work', 'steps']),
    run: async ({ work, steps, images }) => {
      const problems = [];
      if (!steps?.rows?.length) problems.push('rows is empty');
      const figs = existsSync(join(work, 'figures.json')) ? JSON.parse(readFileSync(join(work, 'figures.json'), 'utf8')) : {};
      const known = new Set([...Object.keys(figs), ...Object.keys(images || {})]);
      (steps.rows || []).forEach((r, i) => {
        if (!String(r.name || '').trim()) problems.push(`row ${i + 1}: no name`);
        if (!String(r.voice || '').trim()) problems.push(`row ${i + 1}: no voiceover`);
        if (r.ch && !(steps.chapters || {})[r.ch]) problems.push(`row ${i + 1}: chapter ${r.ch} is not in chapters`);
        for (const k of (r.figs || [])) if (!known.has(k)) problems.push(`row ${i + 1}: figure ${k} unknown`);
      });
      if (problems.length) return ok(text('NOT written:\n' + problems.join('\n')));
      mkdirSync(work, { recursive: true });
      const sp = join(work, 'steps.json');
      writeFileSync(sp, JSON.stringify({ chapters: steps.chapters || {}, rows: steps.rows, images: images || {} }, null, 1));
      const r = await py(['media', work, sp]);
      return ok(text(`written ${sp}: ${steps.rows.length} rows, ${Object.keys(steps.chapters || {}).length} chapters; media: ${r.images} pictures (${r.media_mb} MB)${r.missing.length ? '; MISSING: ' + r.missing.join(', ') : ''}`));
    } },
  { name: 'project_build', description: 'Build the .sbsproj from <work>/steps.json with the 16:9 layout engine (tools/pdf2sbs/build-project.mjs). Returns the template per step and the paths (<out>, .layout.json, .preview.html).',
    inputSchema: S({ work: { type: 'string' }, out: { type: 'string', description: 'default <work>/<name>.sbsproj' }, name: { type: 'string', description: 'project / export name' } }, ['work']),
    run: async ({ work, out, name }) => {
      const B = await import(pathToFileURL(join(APP, 'tools', 'pdf2sbs', 'build-project.mjs')).href);
      const nm = name || basename(work).replace(/\.sbswork$/, '');
      const r = await B.buildProject({ stepsPath: join(work, 'steps.json'), out: out || join(work, nm + '.sbsproj'), name: nm });
      return ok(text(r));
    } },
  { name: 'project_preview', description: 'Render chosen steps of the last build as PNGs (pictures placed, text drawn plainly) and return them — the look before opening the project in the app.',
    inputSchema: S({ work: { type: 'string' }, steps: { type: 'string', description: 'step numbers, e.g. "2,11,17" (max 8 per call)' }, layout: { type: 'string', description: 'default: the newest *.layout.json in <work>' } }, ['work', 'steps']),
    run: async ({ work, steps, layout }) => {
      const lp = layout || newest(work, /\.layout\.json$/);
      if (!lp) throw new Error('no layout.json in ' + work + ' — run project_build first');
      const list = expandList(steps).slice(0, 8);
      const r = await py(['preview', work, lp, list.join(','), join(work, 'previews')]);
      const content = [];
      for (const p of r.previews) { content.push(text(`${p.n}. ${p.name} — ${p.template}`)); content.push(image(p.path)); }
      if (!content.length) content.push(text('no such steps'));
      return { content };
    } },
];

function expand(s) { const out = []; for (const part of String(s).split(',')) { const m = part.trim().match(/^(\d+)(?:-(\d+))?$/); if (!m) continue; const a = +m[1], b = m[2] ? +m[2] : a; for (let i = a; i <= b; i++) out.push(i); } return out; }
const expandList = expand;
function newest(dir, re) { let best = null, t = 0; try { for (const f of (readdirSyncSafe(dir))) { if (!re.test(f)) continue; const m = statSync(join(dir, f)).mtimeMs; if (m > t) { t = m; best = join(dir, f); } } } catch { /* none */ } return best; }
function readdirSyncSafe(d) { try { return (readFileSyncDir(d)); } catch { return []; } }
import { readdirSync } from 'node:fs';
function readFileSyncDir(d) { return readdirSync(d); }

export async function callTool(name, args) {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t.run(args || {});
}
