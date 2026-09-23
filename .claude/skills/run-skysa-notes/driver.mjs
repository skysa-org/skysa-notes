#!/usr/bin/env node
// Drives the running web app in headless Chromium. One command per line on
// stdin; each run is a fresh browser context, so IndexedDB starts empty.
//
//   node .claude/skills/run-skysa-notes/driver.mjs <<'EOF'
//   notebook Test
//   note
//   mode raw
//   type first<br />second
//   save
//   mode rich
//   status
//   ss rich
//   EOF
//
// Playwright is not a dependency of this repo. It is loaded from PW_DIR
// (default $TMPDIR/skysa-run/pw), where SKILL.md says to install it.

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const base = join(process.env.TMPDIR ?? tmpdir(), 'skysa-run');
const PW_DIR = process.env.PW_DIR ?? join(base, 'pw');
const SHOTS = process.env.SHOTS ?? join(base, 'screenshots');
const URL = process.env.URL ?? 'http://localhost:5173/';
mkdirSync(SHOTS, { recursive: true });

const { chromium } = createRequire(join(PW_DIR, 'package.json'))('playwright');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
	// The API's 502s when wrangler is not running are expected for local notes.
	if (m.type() === 'error' && !m.text().includes('502')) errors.push(`console: ${m.text()}`);
});

const button = (name) => page.getByRole('button', { name, exact: true });
/** Whichever editor is showing: CodeMirror in markdown mode, ProseMirror in rich. */
const editor = async () =>
	(await page.locator('.cm-content').count())
		? page.locator('.cm-content')
		: page.locator('.editor-rich-surface');
const unescape = (text) => text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

const commands = {
	nav: async (path = '') => {
		await page.goto(new globalThis.URL(path, URL).href);
		await page.waitForTimeout(1500);
	},
	/** New notebook. The app needs one before it will make a note. */
	notebook: async (name = 'Test') => {
		await button('New notebook').click();
		await page.waitForTimeout(400);
		await page.keyboard.type(name);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(800);
	},
	note: async () => {
		await button('New note').click();
		await page.waitForTimeout(1000);
	},
	/** `mode raw` or `mode rich`: presses the tab, if it is not pressed already. */
	mode: async (which) => {
		const tab = button(which === 'raw' ? 'Markdown' : 'Rich text');
		if ((await tab.getAttribute('aria-pressed')) !== 'true') await tab.click();
		await page.waitForTimeout(1200);
	},
	/**
	 * Inserted, not typed: typing `[` into CodeMirror gets a `]` for free. `\n`
	 * is a newline. Clicks into the editor only if focus is elsewhere — a click
	 * would throw away a `select-all` made just before.
	 */
	type: async (...words) => {
		const target = await editor();
		const focused = await target.evaluate((el) => el.contains(document.activeElement));
		if (!focused) await target.click();
		await page.keyboard.insertText(unescape(words.join(' ')));
	},
	'select-all': async () => {
		await (await editor()).click();
		await page.keyboard.press('ControlOrMeta+a');
	},
	press: async (key) => page.keyboard.press(key),
	click: async (...selector) => page.locator(selector.join(' ')).first().click(),
	wait: async (ms = '500') => page.waitForTimeout(Number(ms)),
	/** Autosave is debounced by 2 s; this waits it out. */
	save: async () => page.waitForTimeout(2600),
	/** The markdown in the raw editor. */
	raw: async () =>
		page
			.locator('.cm-content')
			.evaluate((el) =>
				[...el.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n')
			),
	/** The text of the rich editor. */
	rich: async () => page.locator('.editor-rich-surface').textContent(),
	/** The note's banner (`role="status"`), e.g. the raw-mode one. */
	status: async () =>
		(await page.getByRole('status').count())
			? page.getByRole('status').first().textContent()
			: '(no banner)',
	/** The two mode tabs: pressed, disabled, tooltip. */
	tabs: async () =>
		Promise.all(
			['Rich text', 'Markdown'].map(async (name) => {
				const tab = button(name);
				return `${name}: pressed=${await tab.getAttribute('aria-pressed')} disabled=${await tab.isDisabled()} title="${await tab.getAttribute('title')}"`;
			})
		),
	buttons: async () =>
		page
			.locator('button')
			.evaluateAll((all) =>
				all
					.map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim())
					.filter(Boolean)
			),
	eval: async (...js) => page.evaluate(js.join(' ')),
	ss: async (name = 'shot') => {
		const path = join(SHOTS, `${name}.png`);
		await page.screenshot({ path });
		return path;
	},
	errors: async () => (errors.length ? errors : '(none)'),
};

await commands.nav();
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	const trimmed = line.trim();
	if (trimmed === '' || trimmed.startsWith('#')) continue;
	const [name, ...args] = trimmed.split(' ');
	const run = commands[name];
	if (run === undefined) {
		console.log(`? unknown command "${name}" — one of: ${Object.keys(commands).join(', ')}`);
		continue;
	}
	try {
		const result = await run(...args);
		console.log(
			`> ${trimmed}${result === undefined ? '' : `\n${JSON.stringify(result, null, 1)}`}`
		);
	} catch (error) {
		console.log(
			`! ${trimmed}\n${error instanceof Error ? error.message.split('\n')[0] : error}`
		);
	}
}
await browser.close();
