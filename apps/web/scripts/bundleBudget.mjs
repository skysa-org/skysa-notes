// The web build's size budget: `node apps/web/scripts/bundleBudget.mjs`, after
// `vite build`, from anywhere. Every figure is gzipped bytes, which is what a
// phone downloads. It fails when the build is over any line, so growth is a
// choice someone made in a pull request rather than something found later.
//
// Four lines:
//   - the largest JavaScript chunk, since one huge chunk is parsed in one go
//   - all the JavaScript together
//   - what each page loads before it runs: its entry script and the chunks
//     its HTML preloads (the app, and the fill window the bookmarklet opens)
//   - all the CSS together
//
// Set (2026-10-22) at that day's build plus about five per cent. Raising one
// is fine when the growth is wanted; say so in the pull request. Plain Node,
// no dependencies.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1000;

const BUDGET = {
	largestChunk: 350 * KB,
	allScripts: 1050 * KB,
	pages: { 'index.html': 320 * KB, 'fill.html': 270 * KB },
	allStyles: 17 * KB,
};

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const assets = join(dist, 'assets');

const gzipped = (path) => gzipSync(readFileSync(path), { level: 9 }).length;
const sum = (sizes) => sizes.reduce((total, size) => total + size, 0);
const kb = (bytes) => `${(bytes / KB).toFixed(1)} kB`;

const named = (ending) =>
	readdirSync(assets)
		.filter((name) => name.endsWith(ending))
		.map((name) => ({ name, size: gzipped(join(assets, name)) }));

const scripts = named('.js');
const largest = scripts.reduce((most, chunk) => (chunk.size > most.size ? chunk : most));

// The entry and its `modulepreload`s, as Vite writes them into the page.
const pageScripts = (page) =>
	[
		...readFileSync(join(dist, page), 'utf8').matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g),
	].map(([, path]) => gzipped(join(dist, path)));

const lines = [
	{ what: `largest chunk (${largest.name})`, size: largest.size, budget: BUDGET.largestChunk },
	{
		what: 'all JavaScript',
		size: sum(scripts.map(({ size }) => size)),
		budget: BUDGET.allScripts,
	},
	...Object.entries(BUDGET.pages).map(([page, budget]) => ({
		what: `${page} before it runs`,
		size: sum(pageScripts(page)),
		budget,
	})),
	{ what: 'all CSS', size: sum(named('.css').map(({ size }) => size)), budget: BUDGET.allStyles },
];

lines.forEach(({ what, size, budget }) =>
	process.stdout.write(
		`${size > budget ? 'OVER' : 'ok  '}  ${kb(size).padStart(9)} of ${kb(budget).padStart(9)}  ${what}\n`
	)
);

const over = lines.filter(({ size, budget }) => size > budget);
if (over.length > 0) {
	process.stderr.write(
		'\nThe web build is over its size budget. Make it smaller, or raise the line in apps/web/scripts/bundleBudget.mjs and say why in the pull request.\n'
	);
	process.exitCode = 1;
}
