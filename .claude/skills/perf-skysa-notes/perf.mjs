#!/usr/bin/env node
// Measures the app on an emulated phone against a seeded library: each
// scenario in a fresh clone of the seeded profile, each target in turn, N times.
//
//   node perf.mjs --lib m --target main=http://localhost:5301/ --target branch=http://localhost:5302/
//   node perf.mjs --lib pics --scenarios pictures,cards --runs 3
//
// Writes $PERF_DIR/results/<time>-<label>-<lib>-<profile>.json and prints medians.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
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
		cpuprofile: { type: 'boolean', default: false },
		deadline: { type: 'string', default: '600' },
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
};
PROFILES['phone-low'].options = PROFILES.phone.options;
// Phones only: the scenarios find their way round the phone's layout, its
// panes and its pickers, and tap.
const profile = PROFILES[args.profile];
if (profile === undefined)
	throw new Error(`--profile is one of ${Object.keys(PROFILES).join(', ')}`);
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

/** The sessions being profiled (`--cpuprofile`): from the first counters taken, what is measured. */
const profiling = new WeakSet();

/** CDP's counters, in ms and MB, after a garbage collection. */
const counters = async (cdp) => {
	if (args.cpuprofile && !profiling.has(cdp)) {
		profiling.add(cdp);
		await cdp.send('Profiler.enable');
		await cdp.send('Profiler.start');
	}
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
 * The page time of the frame after `test(arg)` turns true. Sent as an
 * expression, which CDP evaluates outside the page's CSP. A wait that never
 * ends throws, so the run is an error rather than a time; an `optional` one
 * gives null.
 */
const until = async (page, test, arg, { timeout = 120_000, optional = false } = {}) => {
	const at = await page.evaluate(
		`window.__perf.until(() => (${test.toString()})(${JSON.stringify(arg ?? null)}), ${timeout})`
	);
	if (at === null && !optional) {
		const waited = JSON.stringify(arg ?? test.toString().slice(0, 100));
		throw new Error(`waited ${timeout} ms for ${waited}`);
	}
	return at;
};
const now = (page) => page.evaluate(() => performance.now());
const quiet = (page, ms = 1_000) => page.evaluate((ms) => window.__perf.quiet(ms), ms);
const reset = (page) => page.evaluate(() => window.__perf.reset());
const summary = (page) => page.evaluate(() => window.__perf.summary());
/** Until at least `n` elements match `selector`. */
const untilCount = (page, selector, n = 1) =>
	until(page, (arg) => document.querySelectorAll(arg.selector).length >= arg.n, {
		selector,
		n,
	});

/**
 * Until a list of `rows` notes is drawn: every row, or, where the list draws
 * only the rows near the screen (#275), those, which say they are of more
 * (`aria-setsize`). Either way, what the user sees of it.
 */
const untilListed = (page, rows) =>
	until(
		page,
		(arg) => {
			const drawn = document.querySelectorAll('.note-list li.row-item');
			return drawn.length >= arg.rows || drawn[0]?.hasAttribute('aria-setsize') === true;
		},
		{ rows }
	);

/**
 * Until a scratchpad of `count` cards is drawn: every card, or, where the wall
 * draws only the cards near the screen (#275), a placed wall with cards on it.
 * A wall that is not windowed is placed with every card at once, so on either
 * it is the wall the user sees.
 */
const untilCards = (page, count) =>
	until(
		page,
		(arg) => {
			const drawn = document.querySelectorAll('.scratch-card').length;
			return (
				drawn >= arg.count ||
				(drawn > 0 && document.querySelector('.scratch-wall.placed') !== null)
			);
		},
		{ count }
	);

/**
 * Tap `locator`; the page time the touch reached the page. Playwright waits for
 * the element to be still, scrolls to it and hit-tests it before it touches,
 * all on the slowed thread, and none of that is the app's time.
 */
const tap = async (page, locator) => {
	await page.evaluate(() => {
		window.__perf.touched = null;
	});
	await locator.tap();
	const at = await page.evaluate(() => window.__perf.touched);
	if (at === null) throw new Error('the tap never reached the page');
	return at;
};

/**
 * Scroll the nearest scroller of `selector` to its end with touch flings: how
 * far it went, whether it got there, and the frame intervals while it ran. A
 * scroller that never moved throws.
 */
const fling = async (page, cdp, selector) => {
	const box = await page.evaluate((selector) => {
		const start = document.querySelector(selector);
		let element = start;
		// The nearest that scrolls and has something to scroll.
		while (
			element &&
			!(
				/(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
				element.scrollHeight > element.clientHeight
			)
		)
			element = element.parentElement;
		const scroller = element ?? document.scrollingElement;
		// Only this one: a fling before it in the same page marked its own,
		// which can still be there, kept mounted out of sight.
		document.querySelectorAll('[data-perf-scroller]').forEach((marked) => {
			marked.removeAttribute('data-perf-scroller');
		});
		scroller.setAttribute('data-perf-scroller', '');
		// From the top, wherever what came before left it.
		scroller.scrollTo(0, 0);
		const rect = scroller.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 400) };
	}, selector);
	await quiet(page, 300);
	const where = () =>
		page.evaluate(() => {
			const scroller = document.querySelector('[data-perf-scroller]');
			return {
				top: scroller.scrollTop,
				end: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
			};
		});
	const from = await where();
	await page.evaluate(() => window.__perf.startFrames());
	const started = Date.now();
	let at = from;
	// Until the end, or three flings in a row that moved nothing.
	for (let flings = 0, still = 0; flings < 400 && !at.end && still < 3; flings += 1) {
		await cdp.send('Input.synthesizeScrollGesture', {
			x: Math.round(box.x),
			y: Math.round(box.y),
			yDistance: -2500,
			speed: 3000,
			gestureSourceType: 'touch',
		});
		const next = await where();
		still = next.top === at.top ? still + 1 : 0;
		at = next;
	}
	const frames = await page.evaluate(() => window.__perf.stopFrames());
	if (at.top === from.top) throw new Error(`flinging ${selector} scrolled nothing`);
	const sorted = [...frames].sort((a, b) => a - b);
	return {
		scrollMs: Date.now() - started,
		scrolledPx: at.top - from.top,
		reachedEnd: at.end ? 1 : 0,
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
			// Not waiting for `load`: a list up before it would be timed at the
			// first look, not when it came.
			await page.goto(`${base}${manifest.big.hash}`, { waitUntil: 'commit' });
			const listed = await untilListed(page, manifest.big.rows);
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
			const start = await tap(page, row);
			const listed = await untilListed(page, manifest.big.rows);
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
			await untilListed(page, manifest.big.rows);
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
				const start = await tap(page, shut);
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
			// The tree's own rows: the scratchpad's row is above its scroller.
			const scrolled = await fling(page, cdp, 'nav.sidebar .tree button.row');
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
			const start = await tap(page, row);
			const cards = await untilCards(page, manifest.counts.scratch);
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
			const opening = await tap(page, page.locator('.scratch-card-open').first());
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

	/** Type into a note in Big, its list mounted behind it, and let autosave run. */
	typing: {
		needs: (m) => m.typing !== undefined,
		run: async ({ page, cdp, manifest, base }) => {
			await page.goto(`${base}${manifest.typing.hash}`);
			await untilCount(page, '.editor-rich-surface');
			await untilListed(page, manifest.big.rows);
			await quiet(page);
			await page.locator('.editor-rich-surface').tap();
			await page.keyboard.press('ControlOrMeta+End');
			await quiet(page, 500);
			const before = await counters(cdp);
			await reset(page);
			const typed = ' the quick brown fox jumps over the lazy dog'.repeat(3);
			await page.keyboard.type(typed, { delay: 120 });
			// Autosave waits 2 s after the last key.
			await page.waitForTimeout(3_000);
			await quiet(page);
			// Event Timing reports only what took 16 ms or more: a key not in
			// it was quicker, and counts as 0 here.
			const slow = await page.evaluate(() =>
				window.__perf.events
					.filter((event) => event.name === 'keydown')
					.map((event) => event.duration)
			);
			const keys = [...slow, ...Array(Math.max(0, typed.length - slow.length)).fill(0)].sort(
				(a, b) => a - b
			);
			const done = await summary(page);
			if (done.idbWrites === 0)
				throw new Error('nothing was saved: the keys never reached the note');
			return {
				slowKeys: slow.length,
				keyP95: keys[Math.floor(keys.length * 0.95)] ?? 0,
				keyMax: keys.at(-1) ?? 0,
				...done,
				...delta(before, await counters(cdp)),
			};
		},
	},

	/**
	 * A rare word put into search at once, until every note holding it is
	 * listed. Typed a letter at a time, the first letter alone would list
	 * notes, and that would be the time.
	 */
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
			await page.evaluate(() => {
				window.__perf.typed = null;
			});
			await field.fill(manifest.search.rare.word);
			const start = await page.evaluate(() => window.__perf.typed);
			if (start === null) throw new Error('the word never reached the field');
			const answered = await untilCount(
				page,
				'[role="listbox"][aria-label="Search results"] [role="option"]',
				manifest.search.rare.hits
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

	/**
	 * Search as it is used on a phone: the field opened and typed into at once,
	 * a letter at a time. First the rare word, from the moment the field has
	 * the cursor, so its keys arrive while the search is still getting ready;
	 * then, over it, a word in most notes, whose every key lists a full page of
	 * matches. `answerMs` is from the tap to the rare word's notes listed.
	 */
	searchTyping: {
		run: async ({ page, cdp, manifest, base }) => {
			const options = '[role="listbox"][aria-label="Search results"] [role="option"]';
			await page.goto(`${base}#/`);
			await untilCount(page, '.editor-rich-surface, .note-list');
			await quiet(page);
			const before = await counters(cdp);
			await reset(page);
			const opened = await tap(page, page.locator('button[aria-label="Search notes"]'));
			await until(
				page,
				() => document.activeElement?.getAttribute('aria-label') === 'Search notes'
			);
			const { word, hits } = manifest.search.rare;
			await page.keyboard.type(word, { delay: 120 });
			const answered = await untilCount(page, options, hits);
			await quiet(page, 500);
			// Over the rare word rather than after emptying the field, which
			// would be a search closed and opened again.
			await page.locator('input[aria-label="Search notes"]').selectText();
			const common = 'lantern';
			await page.keyboard.type(common, { delay: 120 });
			await quiet(page);
			const slow = await page.evaluate(() =>
				window.__perf.events
					.filter((event) => event.name === 'keydown')
					.map((event) => event.duration)
			);
			const typed = word.length + common.length;
			const keys = [...slow, ...Array(Math.max(0, typed - slow.length)).fill(0)].sort(
				(a, b) => a - b
			);
			return {
				answerMs: answered - opened,
				slowKeys: slow.length,
				keyP95: keys[Math.floor(keys.length * 0.95)] ?? 0,
				keyMax: keys.at(-1) ?? 0,
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

	/**
	 * The 12 MP note opened again, in the app loaded again: measured the
	 * second time, from what the first left on the device — the copies made
	 * of its pictures, where the build makes them.
	 */
	picturesAgain: {
		needs: (m) => m.pictures !== undefined,
		run: async (context) => {
			await pictureNote(context, context.manifest.pictures.twelve);
			await openedAgain(context);
			return pictureNote(context, context.manifest.pictures.twelve);
		},
	},

	/** The 48 MP note opened again, measured the second time. */
	pictures48Again: {
		needs: (m) => m.pictures !== undefined,
		run: async (context) => {
			await pictureNote(context, context.manifest.pictures.fortyEight);
			await openedAgain(context);
			return pictureNote(context, context.manifest.pictures.fortyEight);
		},
	},

	/** The scratchpad with picture cards, flung through until every picture has drawn. */
	cards: {
		needs: (m) => m.pictures !== undefined,
		run: (context) => pictureCards(context),
	},

	/**
	 * The picture cards shown again, measured the second time: drawn from the
	 * thumbs made the first, each card's room held from the size read then.
	 */
	cardsAgain: {
		needs: (m) => m.pictures !== undefined,
		run: async (context) => {
			await pictureCards(context);
			await openedAgain(context);
			return pictureCards(context);
		},
	},
};

/**
 * A page of its own, as the app opened again would be: from the list, so
 * nothing of what is measured next starts before it is asked for.
 */
const openedAgain = async ({ page, base }) => {
	await page.goto(`${base}#/`);
	await page.reload();
};

/**
 * Count each time a card already placed on the wall is placed somewhere else:
 * the wall placing it again because one above it changed height. Once a
 * placing, however many writes to its style it took.
 */
const watchMoves = (page) =>
	page.evaluate(() => {
		window.__cardMoves?.observer.disconnect();
		const placed = (style) => /translate\([^)]*\)/.exec(style ?? '')?.[0];
		const last = new WeakMap();
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				const card = record.target;
				if (!(card instanceof HTMLElement) || !card.classList.contains('scratch-card')) {
					continue;
				}
				const was = last.get(card) ?? placed(record.oldValue);
				const is = placed(card.getAttribute('style'));
				if (is === undefined) continue;
				last.set(card, is);
				if (was !== undefined && was !== is) window.__cardMoves.count += 1;
			}
		});
		observer.observe(document.body, {
			subtree: true,
			attributes: true,
			attributeFilter: ['style'],
			attributeOldValue: true,
		});
		window.__cardMoves = { observer, count: 0 };
	});

/** The scratchpad with picture cards, opened and flung through. */
const pictureCards = async ({ page, cdp, manifest, base }) => {
	await page.goto(`${base}#/`);
	await untilCount(page, '.editor-rich-surface, .note-list');
	await quiet(page);
	const idle = memory();
	const before = await counters(cdp);
	await watchMoves(page);
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
		{ timeout: 60_000, optional: true }
	);
	await quiet(page);
	const held = memory();
	const decoded = await decodedMB(page);
	return {
		firstMs: first - start,
		cardMoves: await page.evaluate(() => window.__cardMoves.count),
		allDrawn: all === null ? 0 : 1,
		decodedMB: decoded,
		...scrolled,
		idleRendererMB: idle.rendererMB,
		rendererMB: held.rendererMB,
		gpuMB: held.gpuMB,
		...(await summary(page)),
		...delta(before, await counters(cdp)),
	};
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
		{ timeout: 90_000, optional: true }
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

/** A promise's answer, or `null` once `ms` have passed without one; the timer holds nothing open. */
const within = (promise, ms) =>
	Promise.race([promise, new Promise((done) => setTimeout(done, ms, null).unref())]);

/**
 * Where a run that will not end is, and a picture of it, so a stall is a
 * finding, not a hang. The debugger is asked for the page's script stack;
 * a main thread busy with a long task does not answer it (`Debugger.enable`
 * waits behind the task), and is reported as busy, without a stack or a
 * picture, which waits on the same thread. Enabling the debugger before the
 * run would get the stack, at a cost to what is measured.
 */
const stuckAt = async (page, cdp, picture) => {
	const enabled = await within(
		cdp.send('Debugger.enable').then(() => 'on'),
		5_000
	).catch(() => 'gone');
	if (enabled === 'gone') return 'its CDP session had closed';
	if (enabled === null) return 'main thread busy (no answer to Debugger.enable in 5 s)';
	const shot = await within(
		page.screenshot({ path: picture, timeout: 10_000 }).then(() => ` (picture: ${picture})`),
		12_000
	).catch(() => null);
	const paused = new Promise((done) => cdp.once('Debugger.paused', done));
	await within(cdp.send('Debugger.pause'), 5_000).catch(() => undefined);
	const stop = await within(paused, 10_000);
	if (stop === null) return `main thread idle, waiting on something${shot ?? ''}`;
	// The probe's own polling, where the harness is waiting on the page, is
	// what a pause finds most often; the frames below it say what for.
	const frames = stop.callFrames
		.slice(0, 12)
		.map(
			(frame) =>
				`${frame.functionName || '(anon)'} ${frame.url.split('/').pop()}:${frame.location.lineNumber + 1}`
		)
		.join(' < ');
	return `paused at ${frames}${shot ?? ''}`;
};

/** A regular expression that matches `text` and only it. */
const literally = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const deadline = Number(args.deadline);
if (!Number.isFinite(deadline) || deadline <= 0) {
	throw new Error('--deadline is a number of seconds, more than 0');
}

/** Each run's profile its own, so nothing left of one run is in the next's. */
const counted = { runs: 0 };

const once = async (target, template, scenario, manifest) => {
	counted.runs += 1;
	const dir = cloneProfile(
		template,
		join(RUN_DIR, `${target.name}-${process.pid}-${counted.runs}`)
	);
	// What has been made so far, so a run past its deadline can say where it
	// was and still be closed.
	const held = {};
	const work = (async () => {
		// Opening a context starts the browser and routes the API away
		// (`launch`), which is where Chromium was seen to stall.
		held.context = await launch(dir, profile.options);
		await held.context.addInitScript({ path: new URL('./probe.js', import.meta.url).pathname });
		const page = held.context.pages()[0] ?? (await held.context.newPage());
		const cdp = await held.context.newCDPSession(page);
		Object.assign(held, { page, cdp });
		await cdp.send('Performance.enable');
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
		const result = await SCENARIOS[scenario].run({ page, cdp, manifest, base: target.url });
		if (profiling.has(cdp)) {
			const { profile: taken } = await cdp.send('Profiler.stop');
			writeFileSync(
				join(
					PERF_DIR,
					'results',
					`${target.name}-${scenario}-${String(counted.runs)}.cpuprofile`
				),
				JSON.stringify(taken)
			);
		}
		if (args.shots)
			await page.screenshot({
				path: join(PERF_DIR, 'results', `${target.name}-${scenario}.png`),
			});
		return result;
	})();
	const late = Symbol('late');
	const timer = { id: undefined };
	try {
		// A run that ends while it is being looked at for being late is still
		// late: the deadline decides, and the looking comes after.
		const first = await Promise.race([
			work,
			new Promise((done) => {
				timer.id = setTimeout(done, deadline * 1000, late);
			}),
		]);
		if (first !== late) return first;
		const where =
			held.cdp === undefined
				? `before the page was open (${held.context === undefined ? 'starting the browser' : 'opening its page'})`
				: await stuckAt(
						held.page,
						held.cdp,
						join(
							PERF_DIR,
							'results',
							`stuck-${target.name}-${scenario}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
						)
					);
		throw new Error(`stuck past ${deadline} s: ${where}`);
	} finally {
		clearTimeout(timer.id);
		work.catch(() => undefined);
		await within(held.context?.close(), 15_000).catch(() => undefined);
		// A browser that would not close is ended, by the profile it was given,
		// which every one of its processes is started with.
		spawnSync('pkill', ['-9', '-f', `user-data-dir=${literally(resolve(dir))}( |$)`]);
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			// Left in `runs/`: no later run takes its name.
		}
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
		// Interleaved, so a drift in the machine falls on every target alike,
		// and in turn about (ABBA), so none is always the one after another.
		for (const target of run % 2 === 0 ? seeded : [...seeded].reverse()) {
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
				const said = error.message.split('\n')[0];
				const which = run < warmup ? `warmup ${run + 1}` : `#${run - warmup + 1}`;
				console.error(`  ${scenario} ${target.name} ${which} failed: ${said}`);
				// A warmup is not measured, nor is its failing.
				if (run >= warmup)
					((results[target.name][scenario] ??= {}).errors ??= []).push(said);
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
