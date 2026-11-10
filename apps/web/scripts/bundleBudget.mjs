// A web build's size budget, held to the lines the app sets (`size.mjs`
// here). Every figure is gzipped bytes, which is what a phone downloads. It
// fails when the build is over any line, so growth is a choice someone made in
// a pull request rather than something found later.
//
// Four kinds of line:
//   - the largest JavaScript chunk, since one huge chunk is parsed in one go
//   - all the JavaScript together
//   - what each page loads before it runs: its entry script and the chunks
//     its HTML preloads
//   - all the CSS together
//
// Plain Node, no dependencies.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const KB = 1000;

const gzipped = (path) => gzipSync(readFileSync(path), { level: 9 }).length;
const sum = (sizes) => sizes.reduce((total, size) => total + size, 0);
const kb = (bytes) => `${(bytes / KB).toFixed(1)} kB`;

/**
 * Measures the build in `dist` against `budget` (`largestChunk`, `allScripts`,
 * `pages` by their file name, `allStyles`, each in bytes), writes a line for
 * each, and fails the process when any is over. `setIn` is where the app sets
 * its figures, for the message that says which line to raise.
 */
export const checkBudget = ({ dist, budget, setIn }) => {
	const assets = join(dist, 'assets');

	const named = (ending) =>
		readdirSync(assets)
			.filter((name) => name.endsWith(ending))
			.map((name) => ({ name, size: gzipped(join(assets, name)) }));

	const scripts = named('.js');
	const largest = scripts.reduce((most, chunk) => (chunk.size > most.size ? chunk : most));

	// The entry and its `modulepreload`s, as Vite writes them into the page.
	const pageScripts = (page) =>
		[
			...readFileSync(join(dist, page), 'utf8').matchAll(
				/(?:src|href)="\/(assets\/[^"]+\.js)"/g
			),
		].map(([, path]) => gzipped(join(dist, path)));

	const lines = [
		{
			what: `largest chunk (${largest.name})`,
			size: largest.size,
			budget: budget.largestChunk,
		},
		{
			what: 'all JavaScript',
			size: sum(scripts.map(({ size }) => size)),
			budget: budget.allScripts,
		},
		...Object.entries(budget.pages).map(([page, limit]) => ({
			what: `${page} before it runs`,
			size: sum(pageScripts(page)),
			budget: limit,
		})),
		{
			what: 'all CSS',
			size: sum(named('.css').map(({ size }) => size)),
			budget: budget.allStyles,
		},
	];

	lines.forEach(({ what, size, budget: limit }) =>
		process.stdout.write(
			`${size > limit ? 'OVER' : 'ok  '}  ${kb(size).padStart(9)} of ${kb(limit).padStart(9)}  ${what}\n`
		)
	);

	const over = lines.filter(({ size, budget: limit }) => size > limit);
	if (over.length > 0) {
		process.stderr.write(
			`\nThe web build is over its size budget. Make it smaller, or raise the line in ${setIn} and say why in the pull request.\n`
		);
		process.exitCode = 1;
	}
};
