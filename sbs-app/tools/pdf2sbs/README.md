# pdf2sbs — a manual (PDF) → a ready SBS project

Dev tool, not shipped. First run 2026-10-09 on `Elbit/doc-demo/DEMO.pdf` (40 pages, 61 figures) →
`DEMO-sbs/DEMO.sbsproj` (106 steps, 12 chapters) that the app opens directly.

## Pipeline

```
PDF ──pdf/pdf-digest.py──▶ pages, images, fonts (what kind of PDF is this?)
    ──pdf/pdf-structure.py─▶ structure.json: "Figure N:" captions + image-strip clusters + text lines
    ──pdf/pdf-holes.py────▶ contact sheets of the text rows whose words became vector outlines (read them visually)
    ──(the LLM, by hand)──▶ pdf/steps-data.py: chapters + rows {name, voice, notes, figs, title, page}
    ──pdf/pdf-to-xlsx.py──▶ figure PNGs rendered at 300 dpi (+ DEMO-steps.xlsx for the Excel route)
    ──pdf/export-steps-json.py─▶ steps.json + media/ (web-sized JPEG/PNG, longest side ≤ 1920)
    ──build-project.mjs───▶ <name>.sbsproj (+ .layout.json, .preview.html)
```

```
node tools/pdf2sbs/build-project.mjs <steps.json> <out.sbsproj> [--name "Project name"]
```

The python scripts carry the DEMO paths; copy and point them at the next document. They need PyMuPDF
(`fitz`), Pillow, openpyxl.

## What was learned on DEMO.pdf (keep for the next one)

- "Microsoft: Print To PDF" slices every screenshot into horizontal strips (541 image objects for ~60
  figures). Never extract embedded images — render the figure REGION (strips assigned to the first
  "Figure N:" caption below them) at 300 dpi, the strips' own density.
- The same printer turns curly-quoted words (“Details”, ‘Main Power’, IP addresses) into vector
  outlines: ABSENT from the text layer in PyMuPDF and pdftotext alike. `pdf-holes.py` finds them
  (glyph-sized filled paths on a text row) and renders the rows for a visual read.
- Vector figures (flow diagrams, tables) have no image strips: hand-measured regions.

## Layout (build-project.mjs)

1920×1080, 5 % margins. Pictures are never cropped — each is fitted whole (small ones may grow ×3, big
ones ×1.5). Template by content:

| picture             | template                                                       |
|---------------------|----------------------------------------------------------------|
| none                | name centred (64 px bold) + body = notes, else the voiceover   |
| tall (w/h < 0.85)   | picture in a 760 px left column; title + notes centred on the right |
| icon (< 400 px)     | enlarged ×3 (≤ 480 px tall), centred; title above, notes below |
| wide / landscape / square | title row; picture fitted into what is left; notes under it |
| two pictures        | side by side under the title                                   |

Text is bound to shared styles (`pdf2sbs Title` 56 bold, `Notes` 34, `Title (centred)` 64,
`Body (centred)` 40) and pinned title positions (constTextBoxes) so the look can be restyled for every
step at once in the app. Notes boxes are free (their y depends on the picture). No masks: fitting beats
covering for pictures of wild proportions. The voiceover is never written on screen (subtitles exist for
that) except on text cards, where it is all the step has.

Open `<name>.preview.html` (serve the folder: `python -m http.server`) — `?t=tall,icon,pair`,
`?step=2,11`, `&z=1.3` — to look before opening the project.
