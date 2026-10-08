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
| pics | 48 + 2 picture notes | 4 (with Pictures) | 1 | 20 + 20 picture cards | — |

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
new build, or a library generated again with other options, gets a new one.
Seeding checks that every note and file in the library arrived. `--profile
phone-low` slows the CPU 6×; there is no desktop profile, as the scenarios find
their way round the phone's layout and tap. `--shots` saves a screenshot of
each scenario's end.

A run that hasn't ended after `--deadline` seconds (600) fails. It is
recorded as an error and the measurement goes on. That is longer than every
bounded wait in the longest scenario. The deadline is for the waits that have
no bound: a `page.evaluate`, a CDP call, a browser that never finishes
starting.

The error says where the run was:
- starting the browser, or opening its page;
- the main thread busy, since a busy thread answers no debugger and so gives
  no stack;
- or the stack it was paused at, with a picture saved as
  `results/stuck-<target>-<scenario>-<time>.png`.

The browser is then ended by its profile, since a stalled one may not close.
Each run clones its profile into a directory of its own.

| scenario | what | main metrics |
|---|---|---|
| cold | open at `#/big/`, its list mounted behind the note | `listedMs`, `settledMs`, `tbt`, `idbNotes` |
| openBig | from the loose notes, tap Big in the notebooks pane | `listedMs`, `longest`, `tbt` |
| scrollList | fling Big's list to the end | `frameP95`, `slowFrames`, `tbt` |
| tree | open shut notebooks one tap at a time, fling the tree | `tapP50`, `tapMax`, `nodes` |
| scratch | tap the scratchpad, fling the wall, open a card | `cardsMs`, `placedMs`, `openMs`, `tbt` |
| typing | type 132 keys into a note in Big, then autosave | `tbt`, `longest`, `idbNotes`, `keyP95` |
| search | put a rare word into search at once, until every note holding it is listed | `answerMs`, `longest` |
| pictures / pictures48 | open the 12 MP / 48 MP note, fling it, leave | `decodedMB`, `rendererMB`, `leftRendererMB`, `firstMs` |
| picturesAgain / pictures48Again | the same, a second time in the same run: from what the first open left on the device, such as copies | as above |
| cards | the scratchpad with picture cards, flung through | `decodedMB`, `rendererMB`, `firstMs` |

- A time after a tap (openBig's `listedMs`, `tapP50`, `cardsMs`, `openMs`) starts when
  the touch reached the page, not when Playwright was asked to tap: it first
  waits for the element to be still and hit-tests it, on the slowed thread.
- A wait that never ends is an error in the results, never a time. Only
  `allDrawn` may be 0.
- `scrolledPx` and `reachedEnd` say how far a fling went; one that moves
  nothing is an error.
- `keyP95`/`keyMax` are over every key typed; a key Event Timing did not
  report (under 16 ms) counts as 0. `slowKeys` is the keys that took 16 ms or
  more.
- `tbt` is the long tasks' time over 50 ms, `longest` the longest task, from the
  page's `longtask` entries.
- `idbNotes`/`idbRows` count IndexedDB rows read, each a value cloned (the
  probe wraps the IDB prototypes). Keys are counted apart: `idbNoteKeys` is
  the notes' keys read by key cursor, `getAllKeys` or `getKey`, one each,
  with no value cloned.
- `decodedMB` is what the pictures drawn take decoded: each `<img>`'s natural
  width × height × 4: what a browser that decodes each picture whole holds
  for them. Chromium may decode a JPEG at the size it is drawn, so its own
  memory understates an iPhone's; this does not depend on either.
- `rendererMB` is the renderer processes' resident memory, from `ps`. An idle
  renderer is already about 440 MB, and it moves by tens of MB from run to
  run, so it is a check on `decodedMB` rather than a measure of its own.
- `scriptMs`/`taskMs`/`layoutMs` are CDP `Performance.getMetrics` deltas.

A change counts as better or worse when it moved 10% (5% for counts of what
the app does: rows read, writes, nodes, pictures drawn) and the interquartile
ranges do not overlap, or every sample on each side was the same; otherwise it
is `≈`. A change from 0 is shown as the change itself, not a percentage. `taps`
and `idleRendererMB` say what a run did or started from, and get no verdict.
Targets run in turn about (ABBA), so none is always run after another.

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
  `loadavg` is recorded in each result. Run one `perf.mjs` at a time
  (`pgrep -fl perf.mjs`). Two at once skew each other's numbers, and stalled
  browsers were seen only then.
- Chromium sometimes stalls while starting: `launchPersistentContext` returns,
  then the first call on the context never does. That is `context.route` in
  `launch`, or adding the probe and opening the page. The deadline reports it as
  "starting the browser" or "opening its page". A stalled browser ignores
  SIGTERM, so it is ended with SIGKILL.

## Afterwards

Stop the `vite preview` servers, and remove the worktrees once their branches
are merged (`git -C <repo> worktree remove ../skysa-perf/branch`). The
profiles and libraries in `$PERF_DIR` can stay; they are keyed by build, and
a new build seeds its own.
