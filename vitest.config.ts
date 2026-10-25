import { defineConfig } from 'vitest/config';

// The three packages' suites as one run, for coverage only: `pnpm test` still
// runs each package's own config on its own. `pnpm coverage` runs this, and
// writes an HTML report to coverage/.
//
// With a test timeout of 20s rather than 5s, set on the command line in the
// `coverage` script because a project keeps its own config and a CLI option is
// the one thing every project takes. Coverage on a shared CI runner makes the
// whole run several times slower, and a test that takes a second in `verify`
// timed out here at 5s. A timeout catches a test that never finishes; how
// slow is too slow is `verify`'s to say, where nothing is instrumented.
export default defineConfig({
	test: {
		projects: ['packages/core', 'apps/api', 'apps/web'],
		coverage: {
			provider: 'v8',
			include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
			exclude: ['**/*.d.ts', '**/routeTree.gen.ts'],
			reporter: ['text-summary', 'html'],
			// Each package at what it had when these were set (2026-10-22), less
			// half a point for runs that differ by a branch or two. They only go
			// up: a pull request that raises a package's numbers raises these.
			thresholds: {
				'packages/core/src/**': { statements: 95, branches: 90, functions: 98, lines: 97 },
				'apps/api/src/**': { statements: 93, branches: 89, functions: 92, lines: 95 },
				'apps/web/src/**': { statements: 94, branches: 89, functions: 94, lines: 96 },
			},
		},
	},
});
