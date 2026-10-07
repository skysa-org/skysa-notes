#!/usr/bin/env node
// A library to measure with, made the same way every time from a seed: nested
// notebooks, notes of mixed markdown and length, a "Big" notebook, scratch
// notes with pins and colours, and — for `--preset pics` — notes and cards full
// of large photos. Written as zips the app's own import takes, with a
// manifest of what a scenario should find.
//
//   node gen-library.mjs --preset m            # 3,000 notes
//   node gen-library.mjs --preset pics         # photos (makes JPEGs in Chromium once)
//
// Output: $PERF_DIR/libs/<preset>-<seed>/{library.zip,pictures-N.zip,manifest.json}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { PERF_DIR } from './paths.mjs';
import { writeZip } from './zip.mjs';

const PRESETS = {
	s: { notes: 1_000, notebooks: 60, depth: 3, scratch: 200, big: 600, bigParts: 10 },
	m: { notes: 3_000, notebooks: 250, depth: 4, scratch: 600, big: 1_200, bigParts: 20 },
	l: { notes: 10_000, notebooks: 600, depth: 5, scratch: 2_000, big: 3_000, bigParts: 40 },
	pics: { notes: 50, notebooks: 3, depth: 1, scratch: 20, big: 0, bigParts: 0, pictures: true },
};

const { values: args } = parseArgs({
	options: {
		preset: { type: 'string', default: 'm' },
		seed: { type: 'string', default: '1' },
		'words-median': { type: 'string', default: '180' },
		force: { type: 'boolean', default: false },
	},
});
const preset = PRESETS[args.preset];
if (preset === undefined) throw new Error(`No preset ${args.preset}: ${Object.keys(PRESETS)}`);
const seed = Number(args.seed);
const out = join(PERF_DIR, 'libs', `${args.preset}-${seed}`);
if (existsSync(join(out, 'manifest.json')) && !args.force) {
	console.log(`${out} exists (--force to make it again)`);
	process.exit(0);
}
mkdirSync(out, { recursive: true });

// mulberry32: small, fast, and the same numbers in every Node.
const prng = (start) => {
	let state = start >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};
const random = prng(seed);
const int = (below) => Math.floor(random() * below);
const pick = (list) => list[int(list.length)];
const chance = (p) => random() < p;
/** Log-normal around `median`, so most notes are short and a few are very long. */
const lognormal = (median, sigma) => {
	const u = Math.max(random(), 1e-9);
	const v = random();
	return Math.round(
		median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))
	);
};

const WORDS = (
	'the of and to in is that it for on with as was at by be this from or have an are not but ' +
	'had they which one you were all we can her has there been if more when will would who so ' +
	'no she other its may these about two time could only them some into than then also any most ' +
	'over after what first new such through years where much your way well down should because ' +
	'each just those people how too little state good very make world still own see men work long ' +
	'here get both between life being under never day same another know while last might us great ' +
	'old year off come since against go came right used take three himself few house use during ' +
	'without again place around however home small found thought went say part once general high ' +
	'upon school every does got united left number course war until always away something fact ' +
	'water though less public put think almost hand enough far took head yet government system ' +
	'better set told nothing night end why called did eyes find going look asked later knew point ' +
	'next program city business give group toward young days let room president side social given ' +
	'present several order national possible rather second face per among form important often ' +
	'things looked early white case john become large big need four within felt along children saw ' +
	'garden ledger harbour lantern meadow quarry orchard ribbon saddle timber violet walnut'
).split(' ');
/** In a handful of notes, so a search for it has a few answers. */
const RARE = 'quokka';
const RARE_HITS = 25;
/** In one note only. */
const UNIQUE = 'zyzzyva';
const NAMES = [
	'Projects',
	'Reading',
	'Recipes',
	'Travel',
	'Work',
	'Ideas',
	'Journal',
	'Café',
	'Garden',
	'Études',
	'Meetings',
	'Archive',
	'Personal',
	'Research',
	'Health',
];
const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];

const cap = (word) => word[0].toUpperCase() + word.slice(1);
const words = (count) => Array.from({ length: count }, () => pick(WORDS)).join(' ');
const sentence = (count) => `${cap(words(Math.max(count, 1)))}.`;
/** What core's `slugify` would make of a title, near enough: these titles are plain words. */
const slug = (text) =>
	text
		.normalize('NFC')
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
/** As `urlSlug` and `spell` in `apps/web/src/routes/place.ts` write a path. */
const hashOf = (path, notebook) =>
	`#/${path
		.replace(/\.md$/i, '')
		.split('/')
		.map((name) => encodeURIComponent(slug(name) || name))
		.join('/')}${notebook ? '/' : ''}`;

const date = (at) => new Date(Date.UTC(2023, 0, 1) + at * 86_400_000).toISOString();

/** Markdown of about `count` words, in the kinds of block a note is made of. */
const body = (title, count, extra = '') => {
	const blocks = [`# ${title}`];
	let left = count;
	while (left > 0) {
		const kind = random();
		if (kind < 0.55) {
			const n = Math.min(left, 20 + int(60));
			blocks.push(
				`${sentence(n)}${chance(0.3) ? ` **${words(2)}** and _${words(2)}_.` : ''}`
			);
			left -= n;
		} else if (kind < 0.7) {
			const items = 2 + int(5);
			blocks.push(Array.from({ length: items }, () => `- ${words(3 + int(6))}`).join('\n'));
			left -= items * 6;
		} else if (kind < 0.8) {
			const items = 2 + int(4);
			blocks.push(
				Array.from(
					{ length: items },
					() => `- [${chance(0.4) ? 'x' : ' '}] ${words(3 + int(5))}`
				).join('\n')
			);
			left -= items * 5;
		} else if (kind < 0.86) {
			blocks.push(`## ${cap(words(2 + int(3)))}`);
			left -= 3;
		} else if (kind < 0.91) {
			blocks.push(
				`\`\`\`js\nconst ${pick(WORDS)} = ${int(1000)};\nconsole.log(${pick(WORDS)});\n\`\`\``
			);
			left -= 8;
		} else if (kind < 0.95) {
			blocks.push(
				`| ${cap(pick(WORDS))} | ${cap(pick(WORDS))} |\n| --- | --- |\n| ${words(2)} | ${int(100)} |\n| ${words(2)} | ${int(100)} |`
			);
			left -= 10;
		} else {
			blocks.push(`See [${words(2)}](https://example.com/${pick(WORDS)}) for ${words(4)}.`);
			left -= 8;
		}
	}
	if (extra !== '') blocks.splice(1 + int(blocks.length), 0, extra);
	return `${blocks.join('\n\n')}\n`;
};

const withFrontmatter = (fields, text) =>
	`---\n${Object.entries(fields)
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n')}\n---\n${text}`;

// Notebooks: "Big" and its parts first, then the rest nested at random.
const folders = [];
const depthOf = (path) => path.split('/').length;
if (preset.big > 0) {
	folders.push('Big');
	for (let i = 1; i <= preset.bigParts; i += 1)
		folders.push(`Big/Part ${String(i).padStart(2, '0')}`);
}
const others = [];
for (let i = 0; folders.length + others.length < preset.notebooks; i += 1) {
	const name = `${pick(NAMES)} ${cap(pick(WORDS))} ${i + 1}`;
	const parents = others.filter((path) => depthOf(path) < preset.depth);
	const parent = parents.length === 0 || chance(0.25) ? '' : pick(parents);
	others.push(parent === '' ? name : `${parent}/${name}`);
}
folders.push(...others);
if (preset.pictures) folders.push('Pictures');

const entries = [];
const taken = new Set();
const fileIn = (folder, title) => {
	const stem = slug(title) || 'note';
	let name = `${stem}.md`;
	for (let n = 2; taken.has(`${folder}/${name}`); n += 1) name = `${stem}-${n}.md`;
	const path = folder === '' ? name : `${folder}/${name}`;
	taken.add(`${folder}/${name}`);
	return path;
};

const counts = { notes: 0, scratch: 0, pinned: 0, files: 0, folders: folders.length };
const rareAt = new Set();
const textNotes = preset.notes - (preset.pictures ? 2 : 0);
while (rareAt.size < Math.min(RARE_HITS, textNotes)) rareAt.add(int(textNotes));
const uniqueAt = int(textNotes);

const big = { direct: 0, all: 0 };
let typing;
let uniquePath;
for (let i = 0; i < textNotes; i += 1) {
	let folder;
	if (i < preset.big) {
		folder =
			i < preset.big / 2 || preset.bigParts === 0
				? 'Big'
				: `Big/Part ${String(1 + (i % preset.bigParts)).padStart(2, '0')}`;
		big.all += 1;
		if (folder === 'Big') big.direct += 1;
	} else if (i % 100 === 0) {
		folder = '';
	} else {
		folder = others.length === 0 ? '' : pick(others);
	}
	const title = cap(words(2 + int(5)));
	const length = Math.min(
		Math.max(lognormal(Number(args['words-median']), 0.9), 5),
		chance(0.01) ? 20_000 : 5_000
	);
	const extra = [
		rareAt.has(i) ? `A ${RARE} was here.` : '',
		i === uniqueAt ? `The ${UNIQUE} is unique.` : '',
	]
		.filter(Boolean)
		.join(' ');
	const markdown = body(title, length, extra);
	const path = fileIn(folder, title);
	const text = chance(0.6)
		? withFrontmatter({ created: date(int(1200)), updated: date(1200 + int(200)) }, markdown)
		: markdown;
	entries.push({ path, bytes: Buffer.from(text) });
	counts.notes += 1;
	if (folder === 'Big' && typing === undefined && length < 600)
		typing = { path, hash: hashOf(path, false) };
	if (i === uniqueAt) uniquePath = path;
}

for (let i = 0; i < preset.scratch; i += 1) {
	const named = chance(0.2);
	const fields = {
		id: `scratch-${seed}-${i}`,
		created: date(int(1400)),
		updated: date(1400 + int(20)),
	};
	const pinned = chance(0.1);
	if (pinned) fields.pinned = 'true';
	if (chance(0.4)) fields.color = pick(COLORS);
	const title = cap(words(2 + int(3)));
	if (named) fields.title = title;
	const length = 5 + int(80);
	const text = chance(0.3)
		? Array.from(
				{ length: 2 + int(6) },
				() => `- [${chance(0.3) ? 'x' : ' '}] ${words(2 + int(4))}`
			).join('\n')
		: words(length);
	const path = named ? fileIn('.scratchpad', title) : `.scratchpad/untitled-${i + 1}.md`;
	taken.add(path);
	entries.push({ path, bytes: Buffer.from(withFrontmatter(fields, `${text}\n`)) });
	counts.notes += 1;
	counts.scratch += 1;
	if (pinned) counts.pinned += 1;
}

for (const folder of folders) entries.push({ path: folder });

const manifest = {
	preset: args.preset,
	seed,
	counts,
	big:
		preset.big > 0
			? { path: 'Big', hash: hashOf('Big', true), rows: big.all, direct: big.direct }
			: undefined,
	typing,
	search: {
		rare: { word: RARE, hits: Math.min(RARE_HITS, textNotes) },
		unique: { word: UNIQUE, path: uniquePath },
	},
	zips: ['library.zip'],
};

// Pictures: one note of twenty 12 MP photos, one of ten 48 MP ones, and cards.
if (preset.pictures) {
	const { makeJpegs } = await import('./images.mjs');
	const twelve = await makeJpegs({ width: 4000, height: 3000, count: 20, bytes: 6e6, seed });
	const fortyEight = await makeJpegs({ width: 8000, height: 6000, count: 10, bytes: 20e6, seed });
	const cards = await makeJpegs({
		width: 4000,
		height: 3000,
		count: 20,
		bytes: 4e6,
		seed: seed + 1,
	});
	const pictures = [];
	const note = (folder, title, photos) => {
		const lines = photos.map(
			(photo, at) => `${sentence(12 + int(20))}\n\n![Photo ${at + 1}](${photo.name})`
		);
		const path = fileIn(folder, title);
		pictures.push({ path, bytes: Buffer.from(body(title, 40, lines.join('\n\n'))) });
		photos.forEach((photo) =>
			pictures.push({
				path: `${folder}/${photo.name}`,
				bytes: readFileSync(photo.file),
				store: true,
			})
		);
		counts.notes += 1;
		counts.files += photos.length;
		return {
			path,
			hash: hashOf(path, false),
			images: photos.length,
			bytes: photos.reduce((sum, photo) => sum + photo.size, 0),
		};
	};
	manifest.pictures = {
		twelve: note(
			'Pictures',
			'Twenty photos',
			twelve.map((photo, at) => ({ ...photo, name: `photo-12mp-${at + 1}.jpg` }))
		),
		fortyEight: note(
			'Pictures',
			'Ten big photos',
			fortyEight.map((photo, at) => ({ ...photo, name: `photo-48mp-${at + 1}.jpg` }))
		),
	};
	cards.forEach((photo, at) => {
		const name = `card-${String(at + 1).padStart(3, '0')}.jpg`;
		pictures.push({
			path: `.scratchpad/card-${at + 1}.md`,
			bytes: Buffer.from(
				withFrontmatter(
					{ id: `card-${seed}-${at}`, created: date(1500 + at) },
					`${words(8 + int(20))}\n\n![](${name})\n`
				)
			),
		});
		pictures.push({
			path: `.scratchpad/${name}`,
			bytes: readFileSync(photo.file),
			store: true,
		});
		counts.notes += 1;
		counts.scratch += 1;
		counts.files += 1;
	});
	manifest.pictures.cards = cards.length;
	writeZip(join(out, 'pictures-1.zip'), pictures);
	manifest.zips.push('pictures-1.zip');
}

writeZip(join(out, 'library.zip'), entries);
manifest.hashes = Object.fromEntries(
	manifest.zips.map((zip) => [
		zip,
		createHash('sha256')
			.update(readFileSync(join(out, zip)))
			.digest('hex')
			.slice(0, 16),
	])
);
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
console.log(
	JSON.stringify({ out, ...manifest.counts, big: manifest.big, hashes: manifest.hashes })
);
