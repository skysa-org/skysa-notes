#!/usr/bin/env node
// Measures the app on an emulated phone against a seeded library: each
// scenario in a fresh clone of the seeded profile, each target in turn, N times.
//
//   node perf.mjs --lib m --target main=http://localhost:5301/ --target branch=http://localhost:5302/
//   node perf.mjs --lib pics --scenarios pictures,cards --runs 3
//
// Writes $PERF_DIR/results/<time>-<label>-<lib>-<profile>.json and prints medians.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { PERF_DIR, playwright } from './paths.mjs';
import { cloneProfile, launch, seededProfile } from './seed.mjs';
import { summarize, table } from './stats.mjs';

const { values: args } = parseArgs({
	options: {
		lib: { type: 'string', default: 'm' },
		target: { type: 'string', multiple: true, default: ['main=http://localhost:5301/'] },
		profile: { type: 'string', default: 'phone' },
		runs: { type: 'string', default: '5' },
		warmup: { type: 'string', default: '1' },
		scenarios: { type: 'string', default: 'all' },
		label: { type: 'string', default: '' },
		shots: { type: 'boolean', default: false },
	},
});

const { devices } = playwright();
const PROFILES = {
	phone: {
		cpu: 4,
		options: {
			...devices['Pixel 7'],
			viewport: { width: 390, height: 844 },
			deviceScaleFactor: 3,
			locale: 'en-US',
			timezoneId: 'UTC',
		},
	},
	'phone-low': { cpu: 6 },
	desktop: {
		cpu: 1,
		options: { viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'UTC' },
	},
};
PROFILES['phone-low'].options = PROFILES.phone.options;
const profile = PROFILES[args.profile];
const targets = args.target.map((spec) => {
	const at = spec.indexOf('=');
	return { name: spec.slice(0, at), url: spec.slice(at + 1) };
});
const runs = Number(args.runs);
const warmup = Number(args.warmup);
const RUN_DIR = join(PERF_DIR, 'runs');
mkdirSync(RUN_DIR, { recursive: true });

/** Resident memory of this script's browser, by kind of process, in MB. */
const memory = () => {
	const procs = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], {
		maxBuffer: 1 << 24,
	})
		.toString()
		.trim()
		.split('\n')
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
		.filter(Boolean)
		.map(([, pid, ppid, rss, command]) => ({ pid: +pid, ppid: +ppid, rss: +rss, command }));
	const children = new Map();
	procs.forEach((proc) => children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc]));
	const mine = [];
	const walk = (pid) =>
		(children.get(pid) ?? []).forEach((proc) => {
			mine.push(proc);
			walk(proc.pid);
		});
	walk(process.pid);
	const mb = (test) =>
		Math.round(
			mine.filter((proc) => test(proc.command)).reduce((sum, proc) => sum + proc.rss, 0) /
				1024
		);
	return {
		rendererMB: mb((command) => command.includes('--type=renderer')),
		gpuMB: mb((command) => command.includes('--type=gpu-process')),
		browserMB: mb(() => true),
	};
};

/** CDP's counters, in ms and MB, after a garbage collection. */
const counters = async (cdp) => {
	await cdp.send('HeapProfiler.collectGarbage');
	const { metrics } = await cdp.send('Performance.getMetrics');
	const value = (name) => metrics.find((metric) => metric.name === name)?.value ?? 0;
	return {
		script: value('ScriptDuration') * 1000,
		task: value('TaskDuration') * 1000,
		layout: value('LayoutDuration') * 1000,
		style: value('RecalcStyleDuration') * 1000,
		heapMB: value('JSHeapUsedSize') / 1048576,
	};
};

const delta = (before, after) => ({
	scriptMs: after.script - before.script,
	taskMs: after.task - before.task,
	layoutMs: after.layout - before.layout + (after.style - before.style),
	heapMB: after.heapMB,
});

/**
 * The page time of the frame after `test(arg)` turns true, or null at `timeout`.
 * Sent as an expression, which CDP evaluates outside the page's CSP.
 */
const until = (page, test, arg, timeout = 120_000) =>
	page.evaluate(
		`window.__perf.until(() => (${test.toString()})(${JSON.stringify(arg ?? null)}), ${timeout})`
	);
const now = (page) => page.evaluate(() => performance.now());
const quiet = (page, ms = 1_000) => page.evaluate((ms) => window.__perf.quiet(ms), ms);
const reset = (page) => page.evaluate(() => window.__perf.reset());
const summary = (page) => page.evaluate(() => window.__perf.summary());
/** Until at least `n` elements match `selector`. */
const untilCount = (page, selector, n = 1, timeout) =>
	until(
		page,
		(arg) => document.querySelectorAll(arg.selector).length >= arg.n,
		{ selector, n },
		timeout
	);

/** Scroll the nearest scroller of `selector` to its end with touch flings; frame intervals while it runs. */
const fling = async (page, cdp, selector) => {
	const box = await page.evaluate((selector) => {
		const start = document.querySelector(selector);
		let element = start;
		while (element && !/(auto|scroll)/.test(getComputedStyle(element).overflowY))
			element = element.parentElement;
		const scroller = element ?? document.scrollingElement;
		scroller.setAttribute('data-perf-scroller', '');
		const rect = scroller.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 400) };
	}, selector);
	await page.evaluate(() => window.__perf.startFrames());
	const started = Date.now();
	for (let i = 0; i < 40; i += 1) {
		await cdp.send('Input.synthesizeScrollGesture', {
			x: Math.round(box.x),
			y: Math.round(box.y),
			yDistance: -2500,
			speed: 3000,
			gestureSourceType: 'touch',
		});
		const end = await page.evaluate(() => {
			const scroller = document.querySelector('[data-perf-scroller]');
			return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
		});
		if (end) break;
	}
	const frames = await page.evaluate(() => window.__perf.stopFrames());
	const sorted = [...frames].sort((a, b) => a - b);
	return {
		scrollMs: Date.now() - started,
		frameP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
		frameMax: sorted.at(-1) ?? 0,
		slowFrames: frames.filter((frame) => frame > 50).length,
	};
};

/**
 * The pictures drawn, as the memory their decoded pixels take at their natural
 * size, in MB: what a browser that decodes a picture whole holds for them.
 * Chromium may decode a JPEG at the size it is drawn, so its resident memory
 * understates what Safari on an iPhone holds; this does not depend on either.
 */
const decodedMB = (page) =>
	page.evaluate(
		() =>
			[...document.images]
				.filter((img) => img.complete && img.naturalWidth > 0)
				.reduce((sum, img) => sum + img.naturalWidth * img.naturalHeight * 4, 0) / 1048576
	);

/** Each takes the page, a CDP session, the library's manifest and the base URL, and returns metrics. */
const SCENARIOS = {
	/** Open the app straight at Big, with its list mounted behind the note. */
	cold: {
		needs: (m) => m.big !== undefined,
		run: async ({ page, cdp, manifest, base }) => {
			await page.goto(`${base}${manifest.big.hash}`);
			const listed = await untilCount(page, '.note-list li.row-item', manifest.big.rows);
			const edited = await untilCount(page, '.editor-rich-surface');
			const settled = await quiet(page);
			return {
				listedMs: listed,
				noteMs: edited,
				settledMs: Math.max(settled, listed, edited),
				...(await summary(page)),
				...delta({ script: 0, task: 0, layout: 0, style: 0 }, await counters(cdp)),
			};
		},
	},

	/** From the loose notes, choose Big in the notebooks pane. */
	openBig: {
		needs: (m) => m.big !== undefined,
		run: async ({ page, cdp, manifest, base }) => {
			await page.goto(`${base}#/`);
			await untilCount(page, '.editor-rich-surface, .note-list');
			await quiet(page);
			await page.locator('.compact-picker[data-pane="notebooks"]').tap();
			const row = page
				.locator('nav.sidebar button.row')
				.filter({ has: page.locator('.row-label', { hasText: /^Big$/ }) });
			await row.waitFor();
			await quiet(page, 500);
			const before = await counters(cdp);
			await reset(page);
			const start = await now(page);
			await row.tap();
			const listed = await untilCount(page, '.note-list li.row-item', manifest.big.rows);
			const settled = await quiet(page);
			return {
				listedMs: listed - start,
				settledMs: Math.max(settled, listed) - start,
				...(await summary(page)),
				...delta(before, await counters(cdp)),
			};
		},
	},

	/** Big's list, flung from top to bottom. */
	scrollList: {
		needs: (m) => m.big !== undefined,
		run: async ({ page, cdp, manifest, base }) => {
			await page.goto(`${base}${manifest.big.hash}`);
			await untilCount(page, '.note-list li.row-item', manifest.big.rows);
			await quiet(page);
			await page.locator('.compact-picker[data-pane="notes"]').tap();
			await page.locator('.note-list').waitFor({ state: 'visible' });
			await quiet(page, 500);
			const before = await counters(cdp);
			await reset(page);
			const scrolled = await fling(page, cdp, '.note-list li.row-item');
			await quiet(page, 500);
			return { ...scrolled, ...(await summary(page)), ...delta(before, await counters(cdp)) };
		},
	},

	/** Open shut notebooks in the notebooks pane, one tap at a time, then fling the tree. */
	tree: {
		run: async ({ page, cdp, base }) => {
			await page.goto(`${base}#/`);
			await untilCount(page, '.editor-rich-surface, .note-list');
			await quiet(page);
			await page.locator('.compact-picker[data-pane="notebooks"]').tap();
			await page.locator('nav.sidebar').waitFor({ state: 'visible' });
			await quiet(page, 500);
			const before = await counters(cdp);
			await reset(page);
			const taps = [];
			for (let i = 0; i < 60; i += 1) {
				const shut = page
					.locator('nav.sidebar button.row-disclosure[aria-expanded="false"]')
					.first();
				if ((await shut.count()) === 0) break;
				await shut.evaluate((element) => element.setAttribute('data-perf-tap', ''));
				await shut.scrollIntoViewIfNeeded();
				const start = await now(page);
				await shut.tap();
				const opened = await until(
					page,
					() =>
						document.querySelector('[data-perf-tap]')?.getAttribute('aria-expanded') ===
						'true'
				);
				await page.evaluate(() =>
					document.querySelector('[data-perf-tap]')?.removeAttribute('data-perf-tap')
				);
				taps.push(opened - start);
			}
			const sorted = [...taps].sort((a, b) => a - b);
			const scrolled = await fling(page, cdp, 'nav.sidebar button.row');
			return {
				taps: taps.length,
				tapP50: sorted[Math.floor(sorted.length / 2)] ?? 0,
				tapMax: sorted.at(-1) ?? 0,
				...scrolled,
				...(await summary(page)),
				...delta(before, await counters(cdp)),
			};
		},
	},

	/** Choose the scratchpad, fling its wall, open a card. */
	scratch: {
		needs: (m) => m.counts.scratch > 0,
		run: async ({ page, cdp, manifest, base }) => {
			await page.goto(`${base}#/`);
			await untilCount(page, '.editor-rich-surface, .note-list');
			await quiet(page);
			await page.locator('.compact-picker[data-pane="notebooks"]').tap();
			const row = page
				.locator('nav.sidebar button.row')
				.filter({ has: page.locator('.row-label', { hasText: /^Scratchpad$/ }) });
			await row.waitFor();
			await quiet(page, 500);
			const before = await counters(cdp);
			await reset(page);
			const start = await now(page);
			await row.tap();
			const cards = await untilCount(page, '.scratch-card', manifest.counts.scratch);
			const placed = await until(
				page,
				() =>
					document.querySelector('.scratch-wall') !== null &&
					document.querySelectorAll('.scratch-wall:not(.placed)').length === 0
			);
			const settled = await quiet(page);
			const shown = await summary(page);
			const scrolled = await fling(page, cdp, '.scratch-card');
			await quiet(page, 500);
			await page.evaluate(() =>
				document.querySelector('[data-perf-scroller]')?.scrollTo(0, 0)
			);
			await quiet(page, 500);
			const open = page.locator('.scratch-card-open').first();
			const opening = await now(page);
			await open.tap();
			const opened = await untilCount(
				page,
				'.card-sheet .editor-rich-surface, [role="dialog"] .editor-rich-surface'
			);
			return {
				cardsMs: cards - start,
				placedMs: placed - start,
				settledMs: Math.max(settled, placed) - start,
				shownTbt: shown.tbt,
				...scrolled,
				openMs: opened - opening,
				...(await summary(page)),
				...delta(before, await counters(cdp)),
			};
		},
	},

	/** Type into a note in Big, its 1,200-row list mounted behind it, and let autosave run. */
	typing: {
		needs: (m) => m.typing !== undefined,
		run: async ({ page, cdp, manifest, base }) => {
			await page.goto(`${base}${manifest.typing.hash}`);
			await untilCount(page, '.editor-rich-surface');
			await untilCount(page, '.note-list li.row-item', manifest.big.rows);
			await quiet(page);
			await page.locator('.editor-rich-surface').tap();
			await page.keyboard.press('ControlOrMeta+End');
			await quiet(page, 500);
			const before = await counters(cdp);
			await reset(page);
			await page.keyboard.type(' the quick brown fox jumps over the lazy dog'.repeat(3), {
				delay: 120,
			});
			// Autosave waits 2 s after the last key.
			await page.waitForTimeout(3_000);
			await quiet(page);
			const events = await page.evaluate(() =>
				window.__perf.events
					.filter((event) =>
						['keydown', 'keypress', 'beforeinput', 'input', 'keyup'].includes(
							event.name
						)
					)
					.map((event) => event.duration)
			);
			const sorted = [...events].sort((a, b) => a - b);
			return {
				slowKeys: events.length,
				keyP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
				keyMax: sorted.at(-1) ?? 0,
				...(await summary(page)),
				...delta(before, await counters(cdp)),
			};
		},
	},

	/** Type a rare word into search and wait for the first answer. */
	search: {
		run: async ({ page, cdp, manifest, base }) => {
			await page.goto(`${base}#/`);
			await untilCount(page, '.editor-rich-surface, .note-list');
			await quiet(page);
			await page.locator('button[aria-label="Search notes"]').tap();
			const field = page.locator('input[aria-label="Search notes"]');
			await field.waitFor();
			await quiet(page, 500);
			const before = await counters(cdp);
			await reset(page);
			const start = await now(page);
			await field.pressSequentially(manifest.search.rare.word, { delay: 150 });
			const answered = await untilCount(
				page,
				'[role="listbox"][aria-label="Search results"] [role="option"]'
			);
			const settled = await quiet(page);
			return {
				answerMs: answered - start,
				settledMs: Math.max(settled, answered) - start,
				...(await summary(page)),
				...delta(before, await counters(cdp)),
			};
		},
	},

	/** A note of twenty 12 MP photos: first picture, scrolled through, then left. */
	pictures: {
		needs: (m) => m.pictures !== undefined,
		run: async (context) => pictureNote(context, context.manifest.pictures.twelve),
	},

	/** A note of ten 48 MP photos. */
	pictures48: {
		needs: (m) => m.pictures !== undefined,
		run: async (context) => pictureNote(context, context.manifest.pictures.fortyEight),
	},

	/** The scratchpad with picture cards, flung through until every picture has drawn. */
	cards: {
		needs: (m) => m.pictures !== undefined,
		run: async ({ page, cdp, manifest, base }) => {
			await page.goto(`${base}#/`);
			await untilCount(page, '.editor-rich-surface, .note-list');
			await quiet(page);
			const idle = memory();
			await reset(page);
			const start = await now(page);
			await page.goto(`${base}#scratchpad`);
			const first = await until(page, () =>
				[...document.querySelectorAll('.scratch-card-picture img')].some(
					(img) => img.complete && img.naturalWidth > 0
				)
			);
			const scrolled = await fling(page, cdp, '.scratch-card');
			const all = await until(
				page,
				(n) =>
					[...document.querySelectorAll('.scratch-card-picture img')].filter(
						(img) => img.complete && img.naturalWidth > 0
					).length >= n,
				manifest.pictures.cards,
				60_000
			);
			await quiet(page);
			const held = memory();
			const decoded = await decodedMB(page);
			return {
				firstMs: first - start,
				allDrawn: all === null ? 0 : 1,
				decodedMB: decoded,
				...scrolled,
				idleRendererMB: idle.rendererMB,
				rendererMB: held.rendererMB,
				gpuMB: held.gpuMB,
				...(await summary(page)),
				...delta({ script: 0, task: 0, layout: 0, style: 0 }, await counters(cdp)),
			};
		},
	},
};

const pictureNote = async ({ page, cdp, base }, note) => {
	await page.goto(`${base}#/`);
	await untilCount(page, '.editor-rich-surface, .note-list');
	await quiet(page);
	const idle = memory();
	const before = await counters(cdp);
	await reset(page);
	const start = await now(page);
	await page.goto(`${base}${note.hash}`);
	const drawn = () =>
		[...document.querySelectorAll('.note-image img')].filter(
			(img) => img.complete && img.naturalWidth > 0
		).length;
	const first = await until(
		page,
		(n) =>
			[...document.querySelectorAll('.note-image img')].filter(
				(img) => img.complete && img.naturalWidth > 0
			).length >= n,
		1
	);
	const scrolled = await fling(page, cdp, '.note-image');
	const all = await until(
		page,
		(n) =>
			[...document.querySelectorAll('.note-image img')].filter(
				(img) => img.complete && img.naturalWidth > 0
			).length >= n,
		note.images,
		90_000
	);
	await quiet(page);
	const held = memory();
	const heldHeap = await counters(cdp);
	const shown = await page.evaluate(drawn);
	const decoded = await decodedMB(page);
	// Leave, and wait out the object URLs' 5 s grace.
	await page.locator('.compact-picker[data-pane="notebooks"]').tap();
	await page
		.locator('nav.sidebar button.row')
		.filter({ has: page.locator('.row-label', { hasText: /^Loose notes$/ }) })
		.tap();
	await page.waitForTimeout(7_000);
	await cdp.send('HeapProfiler.collectGarbage');
	await page.waitForTimeout(1_000);
	const left = memory();
	return {
		firstMs: first - start,
		allDrawn: all === null ? 0 : 1,
		drawn: shown,
		decodedMB: decoded,
		...scrolled,
		idleRendererMB: idle.rendererMB,
		rendererMB: held.rendererMB,
		gpuMB: held.gpuMB,
		leftRendererMB: left.rendererMB,
		heldHeapMB: heldHeap.heapMB,
		...delta(before, await counters(cdp)),
	};
};

const once = async (target, template, scenario, manifest) => {
	const dir = cloneProfile(template, join(RUN_DIR, `${target.name}-${process.pid}`));
	const context = await launch(dir, profile.options);
	try {
		await context.addInitScript({ path: new URL('./probe.js', import.meta.url).pathname });
		const page = context.pages()[0] ?? (await context.newPage());
		const cdp = await context.newCDPSession(page);
		await cdp.send('Performance.enable');
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
		const result = await SCENARIOS[scenario].run({ page, cdp, manifest, base: target.url });
		if (args.shots)
			await page.screenshot({
				path: join(PERF_DIR, 'results', `${target.name}-${scenario}.png`),
			});
		return result;
	} finally {
		await context.close();
		rmSync(dir, { recursive: true, force: true });
	}
};

const seeded = [];
for (const target of targets) {
	const { dir, manifest, seed } = await seededProfile(target.url, args.lib);
	seeded.push({ ...target, template: dir, manifest, seed });
	console.error(`${target.name}: seeded ${JSON.stringify(seed.counts)} (build ${seed.build})`);
}
const { manifest } = seeded[0];
const wanted = args.scenarios === 'all' ? Object.keys(SCENARIOS) : args.scenarios.split(',');
const chosen = wanted.filter((name) => SCENARIOS[name].needs?.(manifest) ?? true);

const results = Object.fromEntries(seeded.map((target) => [target.name, {}]));
for (const scenario of chosen) {
	for (let run = 0; run < warmup + runs; run += 1) {
		// Interleaved, so a drift in the machine falls on every target alike.
		for (const target of seeded) {
			try {
				const metrics = await once(target, target.template, scenario, manifest);
				if (run < warmup) continue;
				const into = (results[target.name][scenario] ??= {});
				Object.entries(metrics).forEach(([name, value]) => {
					if (typeof value === 'number' && Number.isFinite(value))
						(into[name] ??= []).push(value);
				});
				console.error(`  ${scenario} ${target.name} #${run - warmup + 1}`);
			} catch (error) {
				console.error(
					`  ${scenario} ${target.name} #${run + 1} failed: ${error.message.split('\n')[0]}`
				);
				((results[target.name][scenario] ??= {}).errors ??= []).push(
					error.message.split('\n')[0]
				);
			}
		}
	}
}

const out = {
	schema: 1,
	meta: {
		label: args.label,
		lib: args.lib,
		profile: args.profile,
		cpu: profile.cpu,
		runs,
		warmup,
		at: new Date().toISOString(),
		loadavg: loadavg(),
		targets: seeded.map(({ name, url, seed }) => ({
			name,
			url,
			build: seed.build,
			seeded: seed.counts,
			importMs: seed.imports.map((each) => each.ms),
		})),
	},
	results: Object.fromEntries(
		Object.entries(results).map(([name, scenarios]) => [
			name,
			Object.fromEntries(
				Object.entries(scenarios).map(([scenario, metrics]) => [
					scenario,
					summarize(metrics),
				])
			),
		])
	),
};
mkdirSync(join(PERF_DIR, 'results'), { recursive: true });
const file = join(
	PERF_DIR,
	'results',
	`${out.meta.at.replace(/[:.]/g, '-')}-${args.label || 'run'}-${args.lib}-${args.profile}.json`
);
writeFileSync(file, `${JSON.stringify(out, null, '\t')}\n`);
console.log(table(out));
console.log(file);
