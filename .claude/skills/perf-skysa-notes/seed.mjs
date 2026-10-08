// A browser profile holding a library, made once per build and library: the
// library goes in through the app's own import (Storage options → Import
// files), at desktop size, where the storage menu is. Each measured run starts
// from an APFS clone of it (`cloneProfile`), so no run pays for the import and
// none sees what an earlier run did.
//
// A profile's IndexedDB is its origin's, so a build is seeded on the port it
// is measured on.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_DIR, playwright } from './paths.mjs';

/** What identifies a build: its `index.html` names every hashed asset. */
export const buildId = async (url) => {
	const html = await (await fetch(url)).text();
	return createHash('sha256').update(html).digest('hex').slice(0, 10);
};

export const libraryDir = (lib) => join(PERF_DIR, 'libs', lib.includes('-') ? lib : `${lib}-1`);

export const launch = async (dir, options = {}) => {
	const { chromium } = playwright();
	const context = await chromium.launchPersistentContext(dir, {
		channel: 'chromium',
		serviceWorkers: 'block',
		...options,
	});
	// No API here: local notes need none, and an answer would differ between runs.
	await context.route('**/api/**', (route) => route.abort());
	return context;
};

/** The IndexedDB rows the app holds, read raw so no module of the app is loaded twice. */
export const storedCounts = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const open = indexedDB.open('skysa-notes');
				open.onerror = () => reject(open.error);
				open.onsuccess = () => {
					const db = open.result;
					const names = ['notes', 'folders', 'files', 'fileBytes'].filter((name) =>
						db.objectStoreNames.contains(name)
					);
					const tx = db.transaction(names, 'readonly');
					const counts = {};
					names.forEach((name) => {
						const request = tx.objectStore(name).count();
						request.onsuccess = () => {
							counts[name] = request.result;
						};
					});
					tx.oncomplete = () => {
						db.close();
						resolve(counts);
					};
				};
			})
	);

const importZip = async (page, zip) => {
	await page.getByRole('button', { name: 'Storage options' }).click();
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Import files', exact: true }).click();
	await (await chooser).setFiles(zip);
	const dialog = page.getByRole('alertdialog');
	await dialog.waitFor({ timeout: 300_000 });
	const question = (await dialog.textContent()) ?? '';
	await dialog.getByRole('button', { name: 'Import', exact: true }).click();
	const said = page.getByRole('alert').filter({ hasText: 'Imported' });
	await said.waitFor({ timeout: 900_000 });
	return {
		question: question.replace(/\s+/g, ' ').trim(),
		said: (await said.textContent())?.trim(),
	};
};

/**
 * The template profile for `url` holding `lib`, seeded if it is not there yet.
 * Returns its directory and what was seeded.
 */
export const seededProfile = async (url, lib) => {
	const library = libraryDir(lib);
	const manifest = JSON.parse(readFileSync(join(library, 'manifest.json'), 'utf8'));
	const build = await buildId(url);
	const port = new URL(url).port;
	// The zips' own hashes too: a library generated again with other options is
	// another profile, though its preset and seed are the same.
	const zips = createHash('sha256')
		.update(JSON.stringify(manifest.hashes))
		.digest('hex')
		.slice(0, 10);
	const name = `${port}-${build}-${manifest.preset}-${manifest.seed}-${zips}`;
	const dir = join(PERF_DIR, 'profiles', name);
	const done = join(dir, '..', `${name}.json`);
	if (existsSync(done)) return { dir, manifest, seed: JSON.parse(readFileSync(done, 'utf8')) };
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const started = Date.now();
	const context = await launch(dir, { viewport: { width: 1400, height: 900 } });
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto(url);
	await page.getByRole('button', { name: 'Storage options' }).waitFor();
	const imports = [];
	for (const zip of manifest.zips) {
		const at = Date.now();
		imports.push({ zip, ...(await importZip(page, join(library, zip))), ms: Date.now() - at });
	}
	const counts = await storedCounts(page);
	const estimate = await page.evaluate(() => navigator.storage.estimate());
	await context.close();
	// A profile that does not hold the library is no profile to measure in.
	const short = ['notes', 'files']
		.filter((what) => (counts[what] ?? 0) !== manifest.counts[what])
		.map(
			(what) =>
				`${what}: ${counts[what] ?? 0} stored, ${manifest.counts[what]} in the library`
		);
	if (short.length > 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(`seeding ${lib} into ${url} went wrong: ${short.join('; ')}`);
	}
	const seed = { url, build, imports, counts, usage: estimate.usage, ms: Date.now() - started };
	writeFileSync(done, `${JSON.stringify(seed, null, '\t')}\n`);
	return { dir, manifest, seed };
};

/** A copy of `template` to run in, made by APFS clone: instant, and nothing written to it reaches the template. */
export const cloneProfile = (template, into) => {
	rmSync(into, { recursive: true, force: true });
	execFileSync('cp', ['-cR', template, into]);
	return into;
};

if (import.meta.url === `file://${process.argv[1]}`) {
	const [url, lib] = process.argv.slice(2);
	const { dir, seed } = await seededProfile(url, lib);
	console.log(JSON.stringify({ dir, ...seed }, null, '\t'));
}
