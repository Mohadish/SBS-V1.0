// End-to-end smoke of sbs-mcp over real stdio JSON-RPC: DEMO.pdf → steps → .sbsproj → previews.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
const SERVER = 'E:/SBS-dev-V0.3.1/sbs-app/tools/sbs-mcp/server.mjs';
const PDF = 'D:/Nadav-Avi/project/Elbit/doc-demo/DEMO.pdf';
const WORK = process.env.SBS_MCP_WORK || 'E:/claude-temp/demo-mcp-work';
rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });

const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
p.stderr.on('data', d => process.stderr.write('  [server] ' + d));
let buf = ''; const pending = new Map(); let nextId = 1;
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } } });
const call = (method, params) => new Promise(res => { const id = nextId++; pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const tool = async (name, args) => { const t0 = Date.now(); const r = await call('tools/call', { name, arguments: args }); const c = r.result?.content || []; const txt = c.filter(x => x.type === 'text').map(x => x.text).join('\n'); const imgs = c.filter(x => x.type === 'image').length; console.log(`\n### ${name} (${Date.now() - t0} ms, ${imgs} images${r.result?.isError ? ', ERROR' : ''})\n` + txt.slice(0, 1400) + (txt.length > 1400 ? '\n…' : '')); if (r.error) console.log('RPC ERROR', r.error); return r; };
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
ok(init.result?.protocolVersion === '2025-06-18' && init.result?.serverInfo?.name === 'sbs-mcp', 'initialize');
notify('notifications/initialized', {});
const list = await call('tools/list', {});
ok(list.result?.tools?.length === 9, `tools/list: ${list.result?.tools?.map(t => t.name).join(', ')}`);

const insp = await tool('doc_inspect', { path: PDF, work: WORK });
ok(/"pages": 40/.test(insp.result.content[0].text) && /"strip_sliced": true/.test(insp.result.content[0].text), 'inspect: 40 pages, strip-sliced detected');
const txt = await tool('doc_text', { path: PDF, work: WORK, pages: '20' });
ok(/Verify the IP is/.test(txt.result.content[0].text), 'text: page 20 read');
const pg = await tool('doc_page', { path: PDF, work: WORK, page: 20, dpi: 60 });
ok(pg.result.content.some(c => c.type === 'image'), 'page: image returned');
const figs = await tool('doc_figures', { path: PDF, work: WORK, overrides: {
  F3: { page: 9, rect: [23, 178, 571, 516], caption: 'Figure 3: Production Flow' },
  T1: { page: 10, rect: [55, 143, 554, 283], caption: 'Table 1: Production Files' },
  T2: { page: 11, rect: [47, 106, 553, 318], caption: 'Table 2: Customer SW Files' },
  F22: { page: 20, rect: [40, 94, 556, 290] }, F36: { page: 26, rect: [169, 114, 444, 233] }, F42: { page: 29, rect: [139, 230, 456, 478] }, F53: { page: 35, rect: [132, 163, 484, 389] },
} });
ok(/63 figures/.test(figs.result.content[0].text) && /missing.*: none/.test(figs.result.content[0].text), 'figures: 63 rendered, none missing');
const holes = await tool('doc_holes', { path: PDF, work: WORK, pages: '20', max_images: 1 });
ok(holes.result.content.some(c => c.type === 'image') && /outlined words/.test(holes.result.content[0].text), 'holes: sheet for page 20 returned as an image');
const sheet = await tool('sheet_inspect', { path: 'D:/Nadav-Avi/project/Elbit/doc-demo/DEMO-steps.xlsx', rows: 3 });
ok(/sheet "Steps" — 107 rows/.test(sheet.result.content[0].text), 'sheet_inspect reads the xlsx');
// the curated DEMO table (from the earlier run) through steps_write
const prev = JSON.parse(readFileSync('D:/Nadav-Avi/project/Elbit/doc-demo/DEMO-sbs/steps.json', 'utf8'));
const bad = await tool('steps_write', { work: WORK, steps: { chapters: prev.chapters, rows: [{ ch: 'C01', name: 'x', voice: '', figs: ['F999'] }] } });
ok(/NOT written/.test(bad.result.content[0].text) && /no voiceover/.test(bad.result.content[0].text) && /F999 unknown/.test(bad.result.content[0].text), 'steps_write validates');
const wr = await tool('steps_write', { work: WORK, steps: { chapters: prev.chapters, rows: prev.rows } });
ok(/written .*106 rows, 12 chapters; media: 63 pictures/.test(wr.result.content[0].text), 'steps_write: 106 rows, 63 pictures prepared');
const build = await tool('project_build', { work: WORK, name: 'DEMO via MCP' });
const bt = build.result.content[0].text;
ok(/"steps": 106/.test(bt) && /"pictures": 63/.test(bt) && existsSync(WORK + '/DEMO via MCP.sbsproj'), 'project_build: 106 steps, 63 pictures, file exists');
const pv = await tool('project_preview', { work: WORK, steps: '2,11,17' });
ok(pv.result.content.filter(c => c.type === 'image').length === 3, 'project_preview: 3 images');
p.stdin.end();
console.log(fails ? `\n${fails} FAIL` : '\nall passed');
process.exit(fails ? 1 : 0);
