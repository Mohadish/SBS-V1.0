# Hebrew TTS Add-on — Dev Handoff (V0.3.2.133–134)

Commits: `b40cd21` (integration) + `fa08474` (review fixes) on `v0.3.1-dev`.
Written for the main development chat. Everything below is verified live, not
planned.

## What exists now

Hebrew voiceover in SBS via a fine-tuned Kokoro-82M checkpoint, as a
**presence-gated, fully removable add-on**:

- `sbs-app/kokoro-he/` (605 MB, **gitignored**) — Hebrew model.onnx, `he_shaul`
  voicepack, phonikud nikud model + vendored dictabert tokenizer.
- Folder absent → app is byte-identical to before: no Hebrew voice listed, no
  code path touched. Delete the folder to fully revert.
- Folder present → `he_shaul — Hebrew (Male)` appears in the voice list; typing
  Hebrew narration synthesizes at **~0.85 s/clip warm (CPU)**.
- `npm run build:he` → test-only installer in `dist-he/`
  (`...HEBREW-TEST.exe`, ~1 GB). The default `npm run build` is clean —
  verified at the NSIS-archive level (0 kokoro-he entries).

## ⚠️ License — read before anything else

The voice derives from **SASPEECH (© Israeli Public Broadcasting Corp),
NON-COMMERCIAL only**. Hard rules:

1. Never commit `kokoro-he/` (gitignored; keep it that way).
2. Never ship or demo the HEBREW-TEST installer externally. It exists to prove
   the pipeline on the offline test machine, period.
3. Never move the kokoro-he entry into the DEFAULT `extraResources` (that
   config wildcard-ships whole folders silently).
4. Never fine-tune from this checkpoint — a derivative inherits the license.
   A future clean voice starts from stock Kokoro-82M (Apache 2.0).
5. `dist-he/` is quarantined + gitignored. Don't build Hebrew into `dist/`.

Everything else in the chain is commercially clean: Kokoro weights +
kokoro-js Apache-2.0, phonikud CC-BY-4.0 (attribution required — add to
credits/SBOM before any commercial Hebrew ships), phonikud-onnx MIT.

## Architecture (files touched)

```
renderer  src/systems/tts.js         he_* kokoro voices → sbsNative.tts.synthesizeHe(TEXT)
preload   electron/preload.js        synthesizeHe, kokoroHeUrl
main      electron/main.js           _kokoroHeDir() presence gate (dev/worktree/packaged),
                                     _KOKORO_HE_VOICES manifest, tts:synthesizeHe → worker
worker    electron/kokoro-worker.js  'synth-he': nikud ONNX → IPA → tokens → Hebrew model
g2p       electron/hebrew-g2p.js     JS port of phonikud (nikud wrapper + rule FST)
build     electron-builder-he.js     build:he lane, output dist-he/
tests     scripts/test-hebrew-g2p.js 18/18 phonemize + 8/8 tokenizer parity vs Python
          scripts/test-hebrew-e2e.js full chain smoke in pure Node
```

Cache: **no change** — narration-cache slugs by voice name (`kokoro-he-shaul`),
and `he_*` exists only on the Hebrew checkpoint. If the checkpoint is ever
retrained, rename the voice (`he_shaul2`) or add a model rev to the slug, or
stale clips will replay.

## Landmines (each cost us a live crash or a verified bug — do not re-learn)

1. **onnxruntime-node loads in ONE context only.** Native binding in both main
   and a worker_thread → app dies on the second main-side inference (exit 127).
   That's why the ENTIRE Hebrew chain lives in the worker and main only
   forwards text. Don't "optimize" nikud back into main or the renderer.
2. **Model loads are serialized** (`_serializeLoad` in kokoro-worker.js).
   transformers.js re-reads the process-global `env.localModelPath` on every
   file fetch; concurrent cold EN+HE loads corrupt each other without the lock.
   Any third model must join the same chain.
3. **No DML for the Hebrew graph.** The fp32 export's ConvTranspose fails DML
   inference ("parameter is incorrect"). Ladder is CPU-only. Any new candidate
   MUST smoke-test with a real forward pass — from_pretrained alone lies.
4. **G2P parity is load-bearing.** The model was trained with phonikud's exact
   output; `hebrew-g2p.js` matches it byte-for-byte, INCLUDING two non-obvious
   behaviors: (a) Python's `mark_vocal_shva` return value is discarded upstream
   — the rule is inert; vocal shva comes from the nikud model's meteg. (b) the
   dictabert tokenizer collapses disallowed-char RUNS to one [UNK] and its
   StripAccents does NOT decompose. Run `node scripts/test-hebrew-g2p.js`
   after ANY edit to hebrew-g2p.js; regenerate fixtures from Python phonikud
   (spike venv: `E:\hebrew-tts-spike\.venv`) when adding cases.
5. **kokoro-js resolves voicepacks from its own package dir** (inside the asar
   when packaged) — that's why the worker reads `kokoro-he/voices/*.bin`
   itself. Also `from_pretrained` demands `tokenizer.json` +
   `config.json({"model_type":"style_text_to_speech_2"})` in the model dir
   even when the tokenizer is bypassed.

## Pronunciation control (works today)

- Per-language find/replace rules (V0.3.2.130) fix recurring terms:
  `RPL → אר פי אל`, `בורג` mispronunciations, etc.
- phonikud hyper-phoneme escape for exact control: `[RPL](/ʔaʁ pˈi ʔˈel/)` —
  the IPA passes through verbatim (fixed + fixture-gated in .134).
- Digits are NOT expanded (deliberate divergence from Python phonikud) —
  narration text should spell numbers out, or a replace rule should.

## Known gaps (non-blocking, in priority order)

1. Latin runs inside Hebrew text are DROPPED (matches Python with no fallback).
   Mixed-language synth = later phase (Latin-span → English G2P → stitch).
2. No WebGPU path for Hebrew (CPU only, ~0.85 s warm is fine). Needs a
   DML/WebGPU-compatible re-export of the ONNX first (see 3 above; likely the
   same ConvTranspose family as the 24 dB ONNX-vs-PyTorch residual).
3. Cold first clip is slow (~6–14 s: nikud load + model load + smoke). Could
   pre-warm on first Hebrew voice selection instead of first synth.
4. `he_shaul` is one male voice. More voices = 522 KB .bin each — but only
   for THIS checkpoint's license status; see the voice-replacement plan.

## The bigger picture

This add-on is disposable plumbing around a non-shippable voice. The plan of
record (see session "make kokoro hebrew work", memory
`project_hebrew_kokoro_spike`): crowdsource a license-clean Hebrew corpus via
a consent-first recording web app, fine-tune stock Kokoro-82M with the
kikiri-tts recipe (runs on the 4090), then swap the weights — the entire app
side stays as-is.
