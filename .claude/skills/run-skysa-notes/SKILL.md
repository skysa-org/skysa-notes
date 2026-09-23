---
name: run-skysa-notes
description: Run, start, and drive skysa-notes (the notes PWA and its API) to see a change working in the real app. Use when asked to start the dev server, open or screenshot the app, click through a note/editor flow, check what the rich or markdown editor does with some markdown, or confirm a UI change in a browser rather than in tests.
---

Start the dev servers, then drive the web app headlessly with
`.claude/skills/run-skysa-notes/driver.mjs`: a Playwright script that reads
one command per line from stdin (`notebook`, `note`, `mode raw`, `type …`,
`status`, `ss …`). For a change inside the editor's parse/serialize path, the
**direct invocation** probe below is quicker than the browser.

Paths are relative to the repo root. Verified on macOS (darwin), Node 22.15.

## Prerequisites

`pnpm` is not on the agent's PATH, and the root scripts call `pnpm` from
inside themselves (`pnpm -r …`), so `corepack pnpm dev` fails with
`sh: pnpm: command not found`. Put a shim on PATH first:

```bash
mkdir -p "${TMPDIR:-/tmp/}skysa-run/bin"
printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "${TMPDIR:-/tmp/}skysa-run/bin/pnpm"
chmod +x "${TMPDIR:-/tmp/}skysa-run/bin/pnpm"
export PATH="${TMPDIR:-/tmp/}skysa-run/bin:$PATH"
```

Playwright is **not** a dependency of this repo, and should not become one to
run this. Install it outside the repo, where the driver looks for it
(`PW_DIR`, default `$TMPDIR/skysa-run/pw`):

```bash
PW_DIR="${TMPDIR:-/tmp/}skysa-run/pw"
mkdir -p "$PW_DIR" && npm install --prefix "$PW_DIR" --no-save --silent playwright@1
npx --prefix "$PW_DIR" playwright install chromium
```

## Run (agent path)

1. Start web (Vite, :5173) and API (wrangler, :8787) in the background, and
   poll until both answer (macOS has no `timeout`; loop instead):

```bash
pnpm dev    # run_in_background
for i in $(seq 1 45); do curl -sf http://localhost:5173 >/dev/null && { echo web-up; break; }; sleep 1; done
```

   Local notes need only the web app. For a second copy that does not
   disturb a running one, send its output to a file (sent to `/dev/null`,
   it never came up here), then use `URL=http://localhost:5199/` for the driver:

```bash
cd apps/web && L="${TMPDIR:-/tmp/}skysa-run/vite.log"; (corepack pnpm exec vite --port 5199 --strictPort >"$L" 2>&1 &)
for i in $(seq 1 45); do curl -sf http://localhost:5199 >/dev/null && { echo up-5199; break; }; sleep 1; done
```

2. Drive it. Each run is a **fresh browser context**, so IndexedDB is empty
   and there are no notebooks — make one before a note:

```bash
node .claude/skills/run-skysa-notes/driver.mjs <<'EOF'
notebook Test
note
mode raw
type See [docs][d]\n\n[d]: https://example.com
save
mode rich
status
tabs
ss banner
select-all
type See the docs.
mode rich
status
rich
ss retried
errors
EOF
```

   Output is `> command` then the result as JSON. Screenshots go to
   `$TMPDIR/skysa-run/screenshots/<name>.png` (override with `SHOTS`).
   **Open the screenshot and look at it.**

| Command | Does |
|---|---|
| `notebook NAME` / `note` | New notebook (named) / new note in it |
| `mode raw` / `mode rich` | Press the Markdown / Rich text tab (skips if already pressed) |
| `type TEXT` | Insert into whichever editor shows; `\n` is a newline |
| `select-all`, `press KEY`, `click SELECTOR` | Keyboard / Playwright selector |
| `save` | Wait out the 2 s autosave debounce |
| `raw` / `rich` | Text of the CodeMirror / ProseMirror editor |
| `status` | The note's `role="status"` banner, or `(no banner)` |
| `tabs` | Mode tabs: pressed, disabled, tooltip |
| `buttons`, `eval JS`, `wait MS`, `nav PATH` | Inspect / escape hatch |
| `ss NAME`, `errors` | Screenshot; page errors (API 502s filtered out) |

## Direct invocation (editor internals)

Most editor PRs change what Milkdown does to a body. Mount the real editor in
a throwaway vitest file and write results to a file — **console output from a
passing test in `apps/web` is not shown**, even with `--silent=false`:

```bash
cd apps/web && cat > tests/zz-probe.test.ts <<'EOF'
import { type Editor } from '@milkdown/kit/core';
import { appendFileSync } from 'node:fs';
import { afterEach, it } from 'vitest';

import { createRichEditor, currentMarkdown, whatIsLost } from '../src/editor/rich.js';

const OUT = process.env.PROBE_OUT ?? '/tmp/probe.txt';
const editors: Editor[] = [];
afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
});

it('probe', async () => {
	for (const body of ['first<br />second\n', '[a][r]\n\n[r]: /u\n']) {
		const root = document.createElement('div');
		const editor = await createRichEditor({ root, body, onUserEdit: () => undefined }).create();
		editors.push(editor);
		editor.action((ctx) => {
			appendFileSync(OUT, `${JSON.stringify(body)} => ${JSON.stringify(currentMarkdown(ctx))} lost=${JSON.stringify(whatIsLost(ctx, body))}\n`);
		});
	}
});
EOF
OUT="${TMPDIR:-/tmp/}skysa-run/probe.txt"; rm -f "$OUT"
PROBE_OUT="$OUT" corepack pnpm vitest run tests/zz-probe.test.ts; cat "$OUT"; rm tests/zz-probe.test.ts
```

Import from `@skysa/core` by its root only: `@skysa/core/src/...` is refused
by the package's `exports`. For `core`'s own remark pipeline, put the probe in
`packages/core/tests/` and import `../src/markdown/pipeline.js` directly.

## Run (human path)

`pnpm dev` (with the shim), open http://localhost:5173/. Stop:

```bash
lsof -ti:5173 -sTCP:LISTEN | xargs kill; lsof -ti:8787 -sTCP:LISTEN | xargs kill
```

## Test

`pnpm verify` (with the shim) — format check, lint, typecheck and every
suite. It is the CI gate; `pnpm test` alone skips `format:check`.

## Gotchas

- **Brackets:** typing `[` into CodeMirror auto-inserts `]`. The driver's
  `type` uses `insertText`, which does not.
- **A click cancels a selection.** `type` clicks the editor only when focus is
  elsewhere; otherwise `select-all` then `type` appends instead of replacing.
- **`New note` also matches `New notebook`** by accessible name; the driver
  matches buttons exactly.
- **Nothing is stored until autosave fires** (2 s debounce). Use `save` before
  reading the store or switching away, unless the point is to test the
  pending-edit path.
- **New notes open in rich mode.** `mode raw` first to type markdown as
  written.
- **Without the API** the console shows 502s and the sidebar says connecting
  storage needs the server. Local notes work regardless.

## Troubleshooting

- `page.goto: net::ERR_CONNECTION_REFUSED` from the driver → the dev server
  is not up on `URL`'s port yet; poll it first.
- Vite logs `Route file ".../routes/search.ts" does not export a Route` on
  start → harmless; the app runs.
- `sh: pnpm: command not found` from `corepack pnpm dev`/`verify` → the
  PATH shim above.
- `No "X" export is defined on the "../src/editor/rich.js" mock` →
  `tests/RichEditor.test.tsx` mocks `rich.js` wholesale; a new function the
  component calls must be added to that mock.
- `is not exported under the conditions` → a `@skysa/core/src/...` import;
  use the package root.
