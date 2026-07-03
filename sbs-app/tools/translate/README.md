# SBS project translator

Translate every on-screen + narration string in a `.sbsproj` from one language
to another — **without needing anyone to hand-translate it.** The terminology
"skill" lives in the glossary file; the machine does the bulk.

## What it does
- Translates: chapter names, custom step names, narration text, on-screen
  captions (`userTextBox`), custom header text.
- Keeps: proper nouns/brands (OSTERWALDER), part numbers, machine codes — via the
  glossary `keep`/`keepPatterns` lists.
- Forces correct domain terms (punch, die, press set, filler shoe…) via the
  glossary `force` map, so the API can't mistranslate your vocabulary.
- Clears narration audio + sets the voice (default `os:kokoro|am_echo`) so the app
  **re-synthesizes** in the new language on next export/preview.
- Flips RTL→LTR text alignment (Hebrew→English) in captions/header.
- Leaves EVERYTHING else byte-identical: model, tree, transforms, positions,
  header arrangement.

## One-time setup
1. In the Google Cloud console (same project as your TTS key), enable
   **Cloud Translation API**. (Your TTS key may be restricted to TTS — check.)
2. Put that API key on a single line in `google-key.txt` (this folder). It is
   git-ignored and never leaves your machine.

## Run it
Drag a `.sbsproj` onto **`run-he-to-en.bat`**. You get `<name>-EN.sbsproj` next
to it. Open that in SBS; export/preview to hear the English narration.

Or from a terminal:
```
GOOGLE_API_KEY=xxxxx node translate-project.js in.sbsproj out.sbsproj --src iw --tgt en
```
Add `--mock` to dry-run the whole pipeline with a fake translator (no key/API) —
proves extraction + reinsertion on a real file.

## Improve quality
Edit `glossary.he-en.json` — add `keep` terms, `keepPatterns`, or `force`
mappings. Every future run gets better. That file **is** the captured expertise.

## Other languages
Copy the glossary to `glossary.<src>-<tgt>.json` and pass `--src`/`--tgt`
(Google codes; Hebrew = `iw`). Non-English targets need a matching narration
voice — pass `--voice`.
