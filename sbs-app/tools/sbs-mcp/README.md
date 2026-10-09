# sbs-mcp — the document → SBS project pipeline as MCP tools (v0)

Dev tool, not shipped. A stdio MCP server (newline-delimited JSON-RPC 2.0, **no npm dependencies**)
that a Claude session drives. v0 = the pipeline only; v1 = app control (an Electron bridge: open
project, capture a step, move overlay nodes, tree edits) once the layout rules are dialled in.

Registered user-scope in `~/.claude.json`:

```json
"sbs-mcp": { "type": "stdio", "command": "node", "args": ["E:\\SBS-dev-V0.3.1\\sbs-app\\tools\\sbs-mcp\\server.mjs"] }
```

A new Claude Code session picks it up (tools appear as `mcp__sbs-mcp__*`).

| tool | does |
|---|---|
| `doc_inspect` | pages, text, image tiles (strip-sliced?), captions, fonts, per-page outline → `<work>/structure.json` |
| `doc_text` | text lines of chosen pages (y x size text) |
| `doc_page` | render a page / region (points) → PNG, returned as an image |
| `doc_figures` | "Figure N:" regions (strips → caption below) rendered at 300 dpi; `overrides` for vector figures / tables |
| `doc_holes` | rows whose words became vector outlines → contact-sheet images to read |
| `sheet_inspect` | Excel / ods / csv through the app's own reader (client spreadsheets) |
| `steps_write` | validate + write `<work>/steps.json`, prepare web-sized media |
| `project_build` | `.sbsproj` via `tools/pdf2sbs/build-project.mjs` (16:9 layout engine) + `.layout.json` + `.preview.html` |
| `project_preview` | PNG of chosen steps' layout, returned as images (look before opening) |

`<work>` defaults to `<document>.sbswork` next to the document. Python side: `pdf_tools.py`
(PyMuPDF + Pillow; `SBS_MCP_PYTHON` picks the interpreter).

Smoke test (DEMO.pdf, real stdio, all 9 tools): `node tools/sbs-mcp/smoke-test.mjs`.

## The agent's loop

`doc_inspect` → `doc_text` (read) → `doc_figures` (+ overrides) → `doc_holes` (read the sheets, put
the missing words into the steps) → `steps_write` → `project_build` → `project_preview` (look) →
fix the table → build again → open in the app. What the layout engine does is in
`tools/pdf2sbs/README.md`; every rule he confirms goes there, in code.
