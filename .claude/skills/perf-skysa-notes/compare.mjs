#!/usr/bin/env node
// Compare results: the targets of one run, or the first target of each of
// several runs (named by their labels). `--md` prints a table for a PR.
//
//   node compare.mjs $PERF_DIR/results/<run>.json --md
//   node compare.mjs before.json after.json

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { table } from './stats.mjs';

const { values: args, positionals: files } = parseArgs({
	allowPositionals: true,
	options: { md: { type: 'boolean', default: false } },
});
const runs = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
const merged =
	runs.length === 1
		? runs[0]
		: {
				results: Object.fromEntries(
					runs.map((run, at) => {
						const [name, results] = Object.entries(run.results)[0];
						return [run.meta.label || `${name}#${at + 1}`, results];
					})
				),
			};
runs.forEach((run) =>
	console.log(
		`${run.meta.label || 'run'}: ${run.meta.lib}, ${run.meta.profile} (CPU ×${run.meta.cpu}), ${run.meta.runs} runs, ${run.meta.targets.map((target) => `${target.name}@${target.build}`).join(', ')}`
	)
);
console.log(table(merged, { markdown: args.md }));
