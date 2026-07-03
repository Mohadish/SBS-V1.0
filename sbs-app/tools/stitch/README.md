# SBS book stitcher (Road B)

Combine several SBS "books" (separate project files) into **one video** with a
table-of-contents intro — and only re-export the books that actually changed.

- **Accurate TOC timecodes** — read from each book's REAL render (the `.sbsproc`
  export carries chapter markers + measured duration), so chapter 1 @ 0:20,
  chapter 2 @ 1:30 are exact. No animation-timing guesswork.
- **Incremental** — the tool hashes each book's `.sbsproj` and tells you which
  books changed since the last stitch, so you only re-export those. Unchanged
  books reuse their existing export — you skip their (expensive) 3D re-render.
- **Stitch** — TOC intro + every book concatenated into the final `.mp4`.

## One-time setup
`ffmpeg.exe` + `ffprobe.exe` live in `bin/` (already fetched, git-ignored). If
they're missing, drop a Windows ffmpeg static build's `bin/` contents there.

## Workflow
1. In SBS, export **each book** using the **`.sbsproc`** format (File → Export).
   `.sbsproc` carries the chapter markers the TOC needs. (A plain `.mp4` also
   works but gives a book-level TOC only — no per-chapter times.)
2. Write a `books.json` next to the exports (see `books.sample.json`): the books
   **in order**, each with a `title`, its `export` file, and (optional) its
   source `sbsproj` for change-detection.
3. **See the plan** (no video built, no ffmpeg needed for `.sbsproc`):
   ```
   node stitch-books.js books.json
   ```
   Prints which books changed + the full TOC with real timecodes.
4. **Build the video:**
   ```
   node stitch-books.js books.json --run
   ```
   Produces `output` (default `final-stitched.mp4`) + saves a `.state.json` so
   the next run knows which books changed.

## Next time
Change only book 2? Re-export just book 2's `.sbsproc`, rerun — the tool reuses
book 1's export and the TOC re-times automatically.

## Notes / v2
- v1 re-encodes the final assembly (robust to any param drift between the TOC
  card and the book segments). Lossless stream-copy concat is a planned
  optimization once params are confirmed identical.
- No cross-book 3D transition (baked video) — that's Road A. Use a section title
  or fade at boundaries; often a clean "next part" break is desirable anyway.
