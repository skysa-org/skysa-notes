// The web build's size budget: `node apps/web/scripts/size.mjs`, after
// `vite build`, from anywhere. Every figure is gzipped bytes, which is what a
// phone downloads; the kit's `@skysa/pwa/budget` measures the build against
// them and fails when it is over any line.
//
// The pages are the app and the fill window the bookmarklet opens.
//
// Set (2026-10-22) at that day's build plus about five per cent. Raising one
// is fine when the growth is wanted; say so in the pull request. Plain Node.

import { fileURLToPath, URL } from 'node:url';

import { checkBudget } from '@skysa/pwa/budget';

const KB = 1000;

checkBudget({
	dist: fileURLToPath(new URL('../dist/', import.meta.url)),
	budget: {
		largestChunk: 350 * KB,
		allScripts: 1050 * KB,
		pages: { 'index.html': 320 * KB, 'fill.html': 270 * KB },
		allStyles: 17 * KB,
	},
	setIn: 'apps/web/scripts/size.mjs',
});
