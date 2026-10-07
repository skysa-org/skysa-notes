---
name: perf-skysa-notes
description: Measure skysa-notes' speed and memory on an emulated phone with a large library — thousands of notes, nested notebooks, scratchpad cards, large photos — and compare main with a branch. Use when asked to check performance, to get before/after numbers for a PR, or to find what is slow with a big library or big pictures.
---

Generated libraries go in through the app's own Import, into a browser
profile seeded once per build. Each scenario then runs in a fresh clone of that
profile, in Chromium emulating a phone: 390×844 at 3×, touch, CPU slowed 4×,
production build. The results are medians and spreads, compared between
targets.

Paths are relative to this folder. Playwright is the one run-skysa-notes
installs (`$TMPDIR/skysa-run/pw`; see that skill). Everything generated goes in
`$PERF_DIR`, which defaults to `~/Library/Caches/skysa-perf` (not `$TMPDIR`,
which macOS empties).

## Builds to measure: worktrees outside the repo

Never build or check out in a checkout someone else is using. Make worktrees
outside the repo, so its Vite watcher and ESLint never see them, and serve
**production builds** on ports nothing else uses. Dev mode renders twice
under StrictMode and serves modules unbundled.

```bash
git -C <repo> worktree add --detach ../skysa-perf/main origin/main
git -C <repo> worktree add --detach ../skysa-perf/branch <branch>
# in each (pnpm through the PATH shim from run-skysa-notes):
pnpm install --frozen-lockfile --prefer-offline
cd apps/web && pnpm exec vite build
pnpm exec vite preview --port 5301 --strictPort    # main; the branch on 5302
```

## Libraries

```bash
node gen-library.mjs --preset m       # s: 1k notes, m: 3k, l: 10k (+ scratch notes)
node gen-library.mjs --preset pics    # 20 × 12 MP, 10 × 48 MP and 20 picture cards
```

| preset | notes | notebooks | depth | scratch | Big (direct + in parts) |
|---|---|---|---|---|---|
| s | 1,000 | 60 | 3 | 200 | 600 (300 + 300 in 10) |
| m | 3,000 | 250 | 4 | 600 | 1,200 (600 + 600 in 20) |
| l | 10,000 | 600 | 5 | 2,000 | 3,000 (1,500 + 1,500 in 40) |
| pics | 48 | 3 | 1 | 20 + 20 picture cards | — |

Seeded, so a preset is the same bytes every time (`manifest.json` holds their
hashes and what each scenario should find). Photos are made once in Chromium
(noise, so they compress like a phone's) and kept in `$PERF_DIR/images`.

## Run

```bash
node perf.mjs --lib m --target main=http://localhost:5301/ --target branch=http://localhost:5302/ --runs 5
node perf.mjs --lib pics --scenarios pictures,pictures48,cards --runs 3
node compare.mjs $PERF_DIR/results/<file>.json --md     # for a PR
```

The first run on a build seeds its profile (seconds for text, about 10 s for
the photos). A profile belongs to an origin, so each port has its own, and a
new build gets a new one. `--profile phone-low` slows the CPU 6×;
`--profile desktop` is 1400×900 at full speed. `--shots` saves a screenshot of
each scenario's end.

| scenario | what | main metrics |
|---|---|---|
| cold | open at `#/big/`, its list mounted behind the note | `listedMs`, `settledMs`, `tbt`, `idbNotes` |
| openBig | from the loose notes, tap Big in the notebooks pane | `listedMs`, `longest`, `tbt` |
| scrollList | fling Big's list to the end | `frameP95`, `slowFrames`, `tbt` |
| tree | open shut notebooks one tap at a time, fling the tree | `tapP50`, `tapMax`, `nodes` |
| scratch | tap the scratchpad, fling the wall, open a card | `cardsMs`, `placedMs`, `openMs`, `tbt` |
| typing | type 135 keys into a note in Big, then autosave | `tbt`, `longest`, `idbNotes`, `keyP95` |
| search | type a rare word in search | `answerMs`, `longest` |
| pictures / pictures48 | open the 12 MP / 48 MP note, fling it, leave | `rendererMB`, `leftRendererMB`, `firstMs` |
| cards | the scratchpad with picture cards, flung through | `rendererMB`, `firstMs` |

- `tbt` is the long tasks' time over 50 ms, `longest` the longest task, from the
  page's `longtask` entries.
- `idbNotes`/`idbRows` count IndexedDB rows read (the probe wraps the IDB
  prototypes).
- `rendererMB` is the renderer processes' resident memory, from `ps`.
  Decoded pictures show up there, as nothing in the web platform reports them.
- `scriptMs`/`taskMs`/`layoutMs` are CDP `Performance.getMetrics` deltas.

A change counts as better or worse when it moved 10% (5% for counts) and the
interquartile ranges do not overlap; otherwise it is `≈`.

## What emulation does not tell you

CPU throttling slows the renderer's main thread only. Decoding, IndexedDB and
raster run at the Mac's speed, and rasterization is in software. WebKit under
Playwright is the desktop engine, with none of iOS's memory limits. Check by
hand on a phone:

- **iPhone:** Safari Web Inspector over a cable: Timelines (CPU, Rendering
  Frames, Memory, whose Images category is the decoded pictures).
- **Android:** `chrome://inspect`.

Import the same zips there, into a separate origin from real notes.

## Gotchas

- `vite preview` doesn't send `public/_headers`, so the CSP isn't applied
  here. The harness evaluates its probes over CDP and doesn't depend on it.
- The probe has to be loaded before the app (`addInitScript`); a probe loaded
  later misses the first long tasks.
- Close other heavy work while measuring (`pgrep -fl 'vitest|vite build'`);
  `loadavg` is recorded in each result.
