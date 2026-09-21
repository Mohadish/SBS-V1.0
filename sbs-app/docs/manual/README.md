# SBS Step Browser — user manual

* `SBS-Manual.html` — the manual. Single self-contained file: searchable sidebar, light/dark theme, print styles. Open it in any browser (double-click).
* `SBS-Manual.pdf` — the same content rendered to A4 with bookmarks, one chapter per page break.
* `img/` — screenshot slots. Each `figure.shot` in the HTML names the PNG it expects (for example `img/steps-panel.png`). Drop a PNG there and the placeholder box is replaced automatically; no HTML edit needed.
* `make-pdf.cjs` — regenerates the PDF with the app's own Electron (no extra dependencies). The recipe itself is `electron/manual-pdf.js`, shared with the app's own **Help ▸ Save the manual as PDF…**, so the two can never disagree.

## Regenerate the PDF

From `sbs-app/`:

```
npm run manual-pdf
```

`npm run build` does this for you, so the PDF in an installer always matches the HTML.

## Editing rules

* Labels in `<span class="ui">…</span>` must match the on-screen text exactly — the manual is written from the application's own labels.
* Every `<section class="ch">` needs an `id` and one `<h1>`; every `<h2>` needs an `id`. The sidebar, search index and breadcrumbs are built from those at load time.
* The manual SHIPS: `SBS-Manual.html`, `SBS-Manual.pdf` and `img/` go into the installer as `resources/manual/` (`package.json` → `extraResources`), and **Help ▸ SBS Manual** (F1) opens the HTML inside the app. The ⬇ PDF button in the page appears only there — it looks for `window.sbsHelp`.
