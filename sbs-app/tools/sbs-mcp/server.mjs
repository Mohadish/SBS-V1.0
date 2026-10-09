#!/usr/bin/env node
/**
 * sbs-mcp — an MCP server (stdio, newline-delimited JSON-RPC 2.0, no dependencies) that gives a Claude
 * session the document → SBS project pipeline as tools:
 *
 *   doc_inspect · doc_text · doc_page · doc_figures · doc_holes      (PDF side, python + PyMuPDF)
 *   sheet_inspect                                                    (Excel / ods / csv, the app's own reader)
 *   steps_write · project_build · project_preview                    (steps.json → .sbsproj, layout previews)
 *
 * The reading and the step curation stay with the agent; everything deterministic is a tool here.
 * Register (user scope, ~/.claude.json):
 *   "sbs-mcp": { "type": "stdio", "command": "node", "args": ["E:\\SBS-dev-V0.3.1\\sbs-app\\tools\\sbs-mcp\\server.mjs"] }
 * v0 (2026-10-09): no app control yet — that is v1 (an Electron bridge: open project, capture a step, move nodes).
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool } from './tools.mjs';

const PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const log = (...a) => process.stderr.write('[sbs-mcp] ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    const v = PROTOCOLS.has(params?.protocolVersion) ? params.protocolVersion : '2024-11-05';
    return { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sbs-mcp', version: '0.1.0' },
      instructions: 'Document → SBS project pipeline. Typical order: doc_inspect → doc_text (read it) → doc_figures (+ overrides for vector figures/tables) → doc_holes (read the sheets: words missing from the text layer) → steps_write → project_build → project_preview (look) → fix → project_build again.' };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  if (method === 'tools/call') {
    try {
      const r = await callTool(params?.name, params?.arguments || {});
      return r;
    } catch (e) {
      log('tool error', params?.name, e?.message);
      return { content: [{ type: 'text', text: `${params?.name} failed: ${e?.message || e}` }], isError: true };
    }
  }
  if (method === 'resources/list') return { resources: [] };
  if (method === 'prompts/list') return { prompts: [] };
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  line = line.trim(); if (!line) return;
  let req; try { req = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  if (req.method && req.id === undefined) { if (req.method === 'notifications/initialized') log('client ready'); return; }   // notifications
  try {
    const result = await handle(req);
    send({ jsonrpc: '2.0', id: req.id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: e.code || -32000, message: e.message || String(e) } });
  }
});
rl.on('close', () => process.exit(0));
log('up');
