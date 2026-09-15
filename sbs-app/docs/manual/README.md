# SBS Step Browser — user manual

* `SBS-Manual.html` — the manual. Single self-contained file: searchable sidebar, light/dark theme, print styles. Open it in any browser (double-click).
* `SBS-Manual.pdf` — the same content rendered to A4 with bookmarks, one chapter per page break.
* `img/` — screenshot slots. Each `figure.shot` in the HTML names the PNG it expects (for example `img/steps-panel.png`). Drop a PNG there and the placeholder box is replaced automatically; no HTML edit needed.
* `make-pdf.cjs` — regenerates the PDF with the app's own Electron (no extra dependencies).

## Regenerate the PDF

From `sbs-app/`:

```
npx electron docs/manual/make-pdf.cjs docs/manual/SBS-Manual.html docs/manual/SBS-Manual.pdf
```

## Editing rules

* Labels in `<span class="ui">…</span>` must match the on-screen text exactly — the manual is written from the application's own labels.
* Every `<section class="ch">` needs an `id` and one `<h1>`; every `<h2>` needs an `id`. The sidebar, search index and breadcrumbs are built from those at load time.
* The `docs/` folder is not packaged into the installer (see `package.json` → `build.files`).
