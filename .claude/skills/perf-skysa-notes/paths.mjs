// Where the harness keeps what it makes, and where Playwright is.
//
// Generated libraries, seeded browser profiles and results live in PERF_DIR
// (default ~/Library/Caches/skysa-perf), not $TMPDIR, which macOS empties.
// Playwright is the one run-skysa-notes installs, outside the repo.

import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const PERF_DIR = process.env.PERF_DIR ?? join(homedir(), 'Library', 'Caches', 'skysa-perf');
export const PW_DIR = process.env.PW_DIR ?? join(process.env.TMPDIR ?? tmpdir(), 'skysa-run', 'pw');

export const playwright = () => createRequire(join(PW_DIR, 'package.json'))('playwright');
