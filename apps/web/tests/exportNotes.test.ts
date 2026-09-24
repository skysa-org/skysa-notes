import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeProvider, createSyncEngine, isHidden } from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindConnection } from '../src/store/connection.js';
import {
	createDatabase,
	LOCAL_CONNECTION_ID,
	type NoteRecord,
	type NotesDatabase,
} from '../src/store/db.js';
import {
	ArchiveLimitError,
	crc32,
	DOWNLOAD_GRACE_MS,
	downloadLibrary,
	downloadNotes,
	downloadProblem,
	downloadSource,
	entryName,
	filesOf,
	holdsAnything,
	type Library,
	libraryOf,
	type ZipFile,
	zipOf,
} from '../src/store/exportNotes.js';
import { createFolder } from '../src/store/folders.js';
import { beforeClosing } from '../src/store/heldEdits.js';
import {
	createNote,
	deleteNote,
	importNoteFile,
	noteFile,
	saveNoteBody,
} from '../src/store/notes.js';
import { createDexieSyncStore } from '../src/sync/store.js';

/**
 * The archive is written by hand, so it is read back by hand: a reader here
 * that shares nothing with the writer — its own CRC, its own offsets — and
 * checks every field a real one depends on. Where the machine has `unzip`, that
 * is asked as well, since the point is that other people's tools open it.
 */

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** Bit by bit, with no table: slow, obvious, and not the code under test. */
const slowCrc32 = (bytes: Uint8Array): number =>
	(bytes.reduce(
		(crc, byte) =>
			Array.from({ length: 8 }).reduce<number>(
				(each) => ((each & 1) === 1 ? (each >>> 1) ^ 0xedb88320 : each >>> 1),
				crc ^ byte
			),
		0xffffffff
	) ^
		0xffffffff) >>>
	0;

interface ReadEntry {
	path: string;
	content: string;
	flags: number;
	method: number;
	time: number;
	date: number;
	crc: number;
	size: number;
	offset: number;
}

/**
 * Read an archive the way a tool does: find the end record, walk the central
 * directory it points at, and follow each entry to its local header. Every
 * expectation a reader has of the structure is asserted on the way.
 */
const readZip = (bytes: Uint8Array): { entries: ReadEntry[]; directoryOffset: number } => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (at: number) => view.getUint16(at, true);
	const u32 = (at: number) => view.getUint32(at, true);

	// No archive comment, so the end record is exactly the last 22 bytes.
	const end = bytes.length - 22;
	expect(u32(end)).toBe(0x06054b50);
	expect(u16(end + 4)).toBe(0); // this disk
	expect(u16(end + 6)).toBe(0); // disk with the directory
	const count = u16(end + 8);
	expect(u16(end + 10)).toBe(count);
	const directorySize = u32(end + 12);
	const directoryOffset = u32(end + 16);
	expect(u16(end + 20)).toBe(0); // comment length
	// The directory runs right up to the end record, with nothing between.
	expect(directoryOffset + directorySize).toBe(end);

	// Where the next central header is, and where the next local header has to
	// be if entries sit back to back. Moved along as it reads, as a reader does.
	const cursor = { current: directoryOffset };
	const expected = { current: 0 };
	const next = (): ReadEntry => {
		const at = cursor.current;
		const local = expected.current;
		expect(u32(at)).toBe(0x02014b50);
		expect(u16(at + 4)).toBe(20); // made by: 2.0, host 0
		expect(u16(at + 6)).toBe(20); // needed to extract
		const flags = u16(at + 8);
		const method = u16(at + 10);
		const time = u16(at + 12);
		const date = u16(at + 14);
		const crc = u32(at + 16);
		const compressed = u32(at + 20);
		const size = u32(at + 24);
		const nameLength = u16(at + 28);
		expect(u16(at + 30)).toBe(0); // extra
		expect(u16(at + 32)).toBe(0); // comment
		expect(u16(at + 34)).toBe(0); // disk
		expect(u16(at + 36)).toBe(0); // internal attributes
		const offset = u32(at + 42);
		const name = bytes.slice(at + 46, at + 46 + nameLength);
		// External attributes: MS-DOS's directory bit on a folder's entry, and
		// nothing on a file's.
		expect(u32(at + 38)).toBe(text(name).endsWith('/') ? 0x10 : 0);

		// Entries sit back to back from the start of the file.
		expect(offset).toBe(local);
		expect(compressed).toBe(size);

		// The local header says the same thing, field for field.
		expect(u32(offset)).toBe(0x04034b50);
		expect(u16(offset + 4)).toBe(20);
		expect(u16(offset + 6)).toBe(flags);
		expect(u16(offset + 8)).toBe(method);
		expect(u16(offset + 10)).toBe(time);
		expect(u16(offset + 12)).toBe(date);
		expect(u32(offset + 14)).toBe(crc);
		expect(u32(offset + 18)).toBe(size);
		expect(u32(offset + 22)).toBe(size);
		expect(u16(offset + 26)).toBe(nameLength);
		expect(u16(offset + 28)).toBe(0);
		expect(bytes.slice(offset + 30, offset + 30 + nameLength)).toEqual(name);

		const data = bytes.slice(offset + 30 + nameLength, offset + 30 + nameLength + size);
		expect(data.length).toBe(size);
		expect(slowCrc32(data)).toBe(crc);

		cursor.current = at + 46 + nameLength;
		expected.current = offset + 30 + nameLength + size;
		return {
			path: text(name),
			content: text(data),
			flags,
			method,
			time,
			date,
			crc,
			size,
			offset,
		};
	};
	const entries = Array.from({ length: count }, next);
	// The directory starts where the last file ends, and ends where it said.
	expect(expected.current).toBe(directoryOffset);
	expect(cursor.current).toBe(end);
	return { entries, directoryOffset };
};

/** How many entries the end record claims, without reading any of them. */
const countIn = (bytes: Uint8Array): number =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
		bytes.length - 14,
		true
	);

const pathsAndContents = (bytes: Uint8Array) =>
	readZip(bytes).entries.map(({ path, content }) => ({ path, content }));

describe('crc32', () => {
	it('matches the known vectors', () => {
		expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
		expect(crc32(utf8(''))).toBe(0);
		expect(crc32(utf8('a'))).toBe(0xe8b7be43);
		expect(crc32(utf8('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
	});

	it('is unsigned, and agrees with the bit-by-bit definition on every byte value', () => {
		const every = Uint8Array.from({ length: 1024 }, (_, index) => (index * 7) & 0xff);

		expect(crc32(every)).toBe(slowCrc32(every));
		expect(crc32(every)).toBeGreaterThanOrEqual(0);
	});
});

describe('a store-only ZIP', () => {
	it('is a valid, empty archive for no files: the end record and nothing else', () => {
		const bytes = zipOf([]);

		expect(bytes.length).toBe(22);
		expect(readZip(bytes)).toEqual({ entries: [], directoryOffset: 0 });
	});

	it('holds each file at its path, stored, with its sizes, offsets and CRC', () => {
		const files: ZipFile[] = [
			{ path: 'a.md', content: '# A\n' },
			{ path: 'work/plan.md', content: '123456789' },
		];

		const { entries } = readZip(zipOf(files));

		expect(entries.map(({ path, content }) => ({ path, content }))).toEqual(files);
		expect(entries.map((entry) => entry.method)).toEqual([0, 0]);
		expect(entries.map((entry) => entry.offset)).toEqual([0, 30 + 'a.md'.length + 4]);
		expect(entries[1]?.crc).toBe(0xcbf43926);
		expect(entries[1]?.size).toBe(9);
	});

	it('says its names are UTF-8, and writes names and contents as UTF-8', () => {
		const files: ZipFile[] = [
			{
				path: 'Résumé/日本語 🗒️.md',
				content: '# Überschrift\n\nnaïve — “quoted” 日本語 🗒️\n',
			},
		];

		const { entries } = readZip(zipOf(files));

		expect(entries[0]?.flags).toBe(0x0800);
		expect(entries[0]?.path).toBe(files[0]?.path);
		expect(entries[0]?.content).toBe(files[0]?.content);
		// Sizes are in bytes, not in characters.
		expect(entries[0]?.size).toBe(utf8(files[0]?.content ?? '').length);
		expect(entries[0]?.size).toBeGreaterThan((files[0]?.content ?? '').length);
	});

	it('sets the UTF-8 flag on a plain ASCII name too', () => {
		expect(readZip(zipOf([{ path: 'a.md', content: '' }])).entries[0]?.flags).toBe(0x0800);
	});

	it('stores an empty file as an entry of no bytes and a CRC of zero', () => {
		const { entries } = readZip(
			zipOf([
				{ path: 'empty.md', content: '' },
				{ path: 'after.md', content: 'x' },
			])
		);

		expect(entries[0]).toMatchObject({ path: 'empty.md', content: '', size: 0, crc: 0 });
		expect(entries[1]).toMatchObject({ path: 'after.md', content: 'x' });
	});

	it('keeps every file when paths collide, numbering the later ones in the order given', () => {
		const bytes = zipOf([
			{ path: 'work/a.md', content: 'first' },
			{ path: 'work/a.md', content: 'second' },
			{ path: 'work/a.md', content: 'third' },
			// One name on the disk most people will unpack this onto.
			{ path: 'Work/A.md', content: 'fourth' },
			{ path: 'a.md', content: 'not in the way' },
		]);

		expect(pathsAndContents(bytes)).toEqual([
			{ path: 'work/a.md', content: 'first' },
			{ path: 'work/a (2).md', content: 'second' },
			{ path: 'work/a (3).md', content: 'third' },
			{ path: 'Work/A (4).md', content: 'fourth' },
			{ path: 'a.md', content: 'not in the way' },
		]);
	});

	it('does not number a file onto a name another file already has', () => {
		const bytes = zipOf([
			{ path: 'a.md', content: 'first' },
			{ path: 'a (2).md', content: 'the real a (2)' },
			{ path: 'a.md', content: 'second' },
			{ path: 'README', content: 'one' },
			{ path: 'README', content: 'two' },
		]);

		expect(pathsAndContents(bytes)).toEqual([
			{ path: 'a.md', content: 'first' },
			{ path: 'a (2).md', content: 'the real a (2)' },
			{ path: 'a (3).md', content: 'second' },
			{ path: 'README', content: 'one' },
			{ path: 'README (2)', content: 'two' },
		]);
	});

	it('gives the same bytes for the same files', () => {
		const files: ZipFile[] = [
			{ path: 'a.md', content: 'A', modifiedAt: Date.UTC(2026, 8, 19, 10, 0, 0) },
			{ path: 'a.md', content: 'B' },
		];

		expect(zipOf(files)).toEqual(zipOf(files));
	});

	it('dates a file in MS-DOS local time, and one with no date at the start of 1980', () => {
		// Built from local parts, as the format is local: true in any time zone.
		const at = new Date(2026, 8, 19, 13, 37, 42).getTime();

		const { entries } = readZip(
			zipOf([
				{ path: 'dated.md', content: '', modifiedAt: at },
				{ path: 'undated.md', content: '' },
				{ path: 'too-early.md', content: '', modifiedAt: new Date(1970, 0, 1).getTime() },
			])
		);

		expect(entries[0]?.date).toBe(((2026 - 1980) << 9) | (9 << 5) | 19);
		expect(entries[0]?.time).toBe((13 << 11) | (37 << 5) | 21);
		// Two-second steps, so an odd second is the even one before it: 57 is
		// written as 28, which reads back as 56. Never rounded up, where 59
		// would become a sixtieth second no clock has.
		const odd = (seconds: number) =>
			readZip(
				zipOf([
					{
						path: 'odd.md',
						content: '',
						modifiedAt: new Date(2026, 8, 19, 13, 37, seconds).getTime(),
					},
				])
			).entries[0]?.time ?? -1;
		expect(odd(57) & 0x1f).toBe(28);
		expect(odd(59) & 0x1f).toBe(29);
		expect(odd(57)).toBe(odd(56));
		expect(entries[1]).toMatchObject({ date: (1 << 5) | 1, time: 0 });
		expect(entries[2]).toMatchObject({ date: (1 << 5) | 1, time: 0 });
	});

	describe('at the edges of what the format can say', () => {
		const empties = (count: number): ZipFile[] =>
			Array.from({ length: count }, (_, index) => ({
				path: `${String(index)}.md`,
				content: '',
			}));

		it('writes 65,534 files, and refuses 65,535: that count is how ZIP64 says "look elsewhere"', () => {
			expect(countIn(zipOf(empties(0xfffe)))).toBe(0xfffe);
			expect(() => zipOf(empties(0xffff))).toThrow(RangeError);
		});

		it('counts an empty notebook as an entry, since it is one', () => {
			expect(countIn(zipOf(empties(0xfffd), [{ path: 'one more' }]))).toBe(0xfffe);
			expect(() => zipOf(empties(0xfffe), [{ path: 'one more' }])).toThrow(RangeError);
		});

		it('says which limit it met, so the user can be told in words', () => {
			expect(() => zipOf(empties(0xffff))).toThrow(
				expect.objectContaining({ name: 'ArchiveLimitError', limit: 'entries' })
			);
			expect(() => zipOf(empties(0xfffe), [{ path: 'one more' }])).toThrow(
				expect.objectContaining({ limit: 'entries' })
			);
			expect(() => zipOf([{ path: `${'a'.repeat(0xffff)}.md`, content: '' }])).toThrow(
				expect.objectContaining({ limit: 'name' })
			);
		});

		it('writes a name of 65,535 bytes, and refuses one of 65,536 rather than wrap its length', () => {
			const longest = `${'a'.repeat(0xffff - 3)}.md`;

			const { entries } = readZip(zipOf([{ path: longest, content: 'x' }]));
			expect(entries[0]?.path).toBe(longest);
			expect(entries[0]?.content).toBe('x');

			expect(() => zipOf([{ path: `a${longest}`, content: 'x' }])).toThrow(RangeError);
			// In bytes, not characters: half as many of these is already too long.
			expect(() => zipOf([{ path: `${'é'.repeat(0x8000)}.md`, content: 'x' }])).toThrow(
				RangeError
			);
		});
	});

	describe('the name an entry is written under', () => {
		it.each([
			['/abs.md', 'abs.md'],
			['../up.md', 'up.md'],
			['a/../../b.md', 'b.md'],
			['a//b.md', 'a/b.md'],
			['./x.md', 'x.md'],
			['a\\..\\..\\w.md', 'a_.._.._w.md'],
			['a/b\\c.md', 'a/b_c.md'],
			['..\\..\\etc/passwd', '.._.._etc/passwd'],
			['', 'untitled.md'],
			['/', 'untitled.md'],
			['..', 'untitled.md'],
			['./.', 'untitled.md'],
			['a/b/', 'a/b'],
			// The spelling is the user's: only the comparison folds.
			['Work/Plan É.md', 'Work/Plan É.md'],
		])('writes %j as %j', (path, name) => {
			expect(entryName(path)).toBe(name);
			expect(
				readZip(zipOf([{ path, content: 'x' }])).entries.map((entry) => entry.path)
			).toEqual([name]);
		});

		it('never writes a name that is absolute, climbs, or holds a backslash', () => {
			const hostile = [
				'/abs.md',
				'../up.md',
				'a/../../b.md',
				'a//b.md',
				'./x.md',
				'a\\..\\..\\w.md',
				'',
				'//../..//',
				'..\\x',
				'a/./../..',
			];

			const names = readZip(
				zipOf(hostile.map((path) => ({ path, content: '' })))
			).entries.map((entry) => entry.path);

			expect(names).toHaveLength(hostile.length);
			expect(new Set(names).size).toBe(hostile.length);
			names.forEach((name) => {
				expect(name.startsWith('/')).toBe(false);
				expect(name.includes('\\')).toBe(false);
				expect(name.split('/').filter((part) => ['', '.', '..'].includes(part))).toEqual(
					[]
				);
			});
		});

		it('tells apart by the name it writes, so two spellings of one path are one name', () => {
			// Compared normalized and written raw, these were two entries with two
			// names that unpack onto one file.
			expect(
				pathsAndContents(
					zipOf([
						{ path: 'a/b.md', content: 'first' },
						{ path: 'a//b.md', content: 'second' },
						{ path: '/a/./b.md', content: 'third' },
						{ path: '', content: 'fourth' },
						{ path: 'untitled.md', content: 'fifth' },
					])
				)
			).toEqual([
				{ path: 'a/b.md', content: 'first' },
				{ path: 'a/b (2).md', content: 'second' },
				{ path: 'a/b (3).md', content: 'third' },
				{ path: 'untitled.md', content: 'fourth' },
				{ path: 'untitled (2).md', content: 'fifth' },
			]);
		});
	});

	describe('a notebook with nothing in it', () => {
		const written = (files: readonly ZipFile[], folders: { path: string }[]) =>
			readZip(zipOf(files, folders)).entries.map(({ path, size }) => ({ path, size }));

		it('is an entry of its own: its name and a slash, no bytes, and marked a folder', () => {
			expect(
				written(
					[{ path: 'work/plan.md', content: 'x' }],
					[{ path: 'ideas' }, { path: 'work' }]
				)
			).toEqual([
				{ path: 'ideas/', size: 0 },
				{ path: 'work/plan.md', size: 1 },
			]);
		});

		it('is written once under any spelling, and never for the root or a folder a file is in', () => {
			expect(
				written(
					[{ path: 'a/b/c.md', content: '' }],
					[
						{ path: '' },
						{ path: '..' },
						{ path: 'a' },
						{ path: 'A/B' },
						{ path: 'Empty' },
						{ path: 'empty/' },
						{ path: 'x\\..\\y' },
					]
				).map(({ path }) => path)
			).toEqual(['Empty/', 'x_.._y/', 'a/b/c.md']);
		});

		it('takes its name before any file does, so the file of that name is the numbered one', () => {
			expect(
				written([{ path: 'Plan.md', content: 'file' }], [{ path: 'plan.md' }]).map(
					({ path }) => path
				)
			).toEqual(['plan.md/', 'Plan (2).md']);
		});

		it('changes nothing about an archive where every notebook holds a note', () => {
			const files = [{ path: 'w/a.md', content: 'a' }];

			expect(zipOf(files, [{ path: 'w' }])).toEqual(zipOf(files));
			expect(zipOf(files, [])).toEqual(zipOf(files));
		});
	});

	describe('a file where a folder has to be', () => {
		it('numbers the file, whichever of the two came first', () => {
			const file = { path: 'a', content: 'a file' };
			const inside = { path: 'a/b.md', content: 'in a folder' };

			expect(pathsAndContents(zipOf([inside, file]))).toEqual([
				{ path: 'a/b.md', content: 'in a folder' },
				{ path: 'a (2)', content: 'a file' },
			]);
			expect(pathsAndContents(zipOf([file, inside]))).toEqual([
				{ path: 'a (2)', content: 'a file' },
				{ path: 'a/b.md', content: 'in a folder' },
			]);
		});

		it('sees the folder at any depth, under any spelling, and does not number onto one', () => {
			expect(
				pathsAndContents(
					zipOf([
						{ path: 'Work/2026.md/plan.md', content: 'deep' },
						{ path: 'work/2026.MD', content: 'a file named as the folder is' },
						{ path: 'x.md', content: 'first' },
						{ path: 'x.md', content: 'second' },
						{ path: 'x (2).md/inner.md', content: 'makes `x (2).md` a folder' },
					])
				)
			).toEqual([
				{ path: 'Work/2026.md/plan.md', content: 'deep' },
				{ path: 'work/2026 (2).MD', content: 'a file named as the folder is' },
				{ path: 'x.md', content: 'first' },
				{ path: 'x (3).md', content: 'second' },
				{ path: 'x (2).md/inner.md', content: 'makes `x (2).md` a folder' },
			]);
		});
	});

	it('zips twenty thousand files, three thousand of them at one path, each under its own name', () => {
		const DUPLICATES = 3000;
		const files: ZipFile[] = Array.from({ length: 20_000 }, (_, index) =>
			index < DUPLICATES
				? { path: 'notes/same.md', content: `copy ${String(index)}` }
				: { path: `notes/${String(index)}.md`, content: `note ${String(index)}` }
		);

		const { entries } = readZip(zipOf(files));

		expect(entries).toHaveLength(20_000);
		expect(new Set(entries.map((entry) => entry.path.toLowerCase())).size).toBe(20_000);
		// In the order given, numbered in the order given, and each with its own text.
		expect(entries[0]).toMatchObject({ path: 'notes/same.md', content: 'copy 0' });
		expect(entries[1]).toMatchObject({ path: 'notes/same (2).md', content: 'copy 1' });
		expect(entries[DUPLICATES - 1]).toMatchObject({
			path: `notes/same (${String(DUPLICATES)}).md`,
			content: `copy ${String(DUPLICATES - 1)}`,
		});
		expect(entries[DUPLICATES]).toMatchObject({
			path: `notes/${String(DUPLICATES)}.md`,
			content: `note ${String(DUPLICATES)}`,
		});
		expect(entries.every((entry, index) => entry.content.endsWith(` ${String(index)}`))).toBe(
			true
		);
	}, 60_000);

	it('does not run out of stack on a folder of names already numbered by hand', () => {
		// What importing one of these archives leaves behind, and then a
		// duplicate of the first: every number up to the last is taken.
		const TAKEN = 12_000;
		const files: ZipFile[] = [
			{ path: 'a.md', content: 'the first' },
			...Array.from({ length: TAKEN - 1 }, (_, index) => ({
				path: `a (${String(index + 2)}).md`,
				content: '',
			})),
			{ path: 'a.md', content: 'the duplicate' },
		];

		const bytes = zipOf(files);

		expect(countIn(bytes)).toBe(TAKEN + 1);
		expect(new TextDecoder().decode(bytes).includes(`a (${String(TAKEN + 1)}).md`)).toBe(true);
	}, 60_000);

	const unzip = (() => {
		try {
			execFileSync('unzip', ['-v'], { stdio: 'ignore' });
			return true;
		} catch {
			return false;
		}
	})();

	it.skipIf(!unzip)('is an archive `unzip` tests clean and reads the contents of', () => {
		const folder = mkdtempSync(join(tmpdir(), 'skysa-export-'));
		try {
			const archive = join(folder, 'notes.zip');
			const content = '# Überschrift\n\nnaïve 日本語\n';
			writeFileSync(
				archive,
				zipOf([
					{ path: 'work/plan.md', content, modifiedAt: Date.now() },
					{ path: 'Résumé/日本語.md', content: 'x' },
					{ path: 'empty.md', content: '' },
				])
			);

			// Exits non-zero on a bad CRC, a bad offset or a directory that does
			// not match its local headers.
			const report = execFileSync('unzip', ['-t', archive], { encoding: 'utf8' });
			expect(report).toContain('No errors detected');
			// By an ASCII name: how a non-ASCII one is spelled on a command line
			// is the locale's business, not the archive's.
			expect(
				execFileSync('unzip', ['-p', archive, 'work/plan.md'], { encoding: 'utf8' })
			).toBe(content);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it.skipIf(!unzip)('unpacks an empty notebook as an empty folder', () => {
		const folder = mkdtempSync(join(tmpdir(), 'skysa-export-'));
		try {
			const archive = join(folder, 'notes.zip');
			writeFileSync(
				archive,
				zipOf([{ path: 'work/plan.md', content: 'x' }], [{ path: 'ideas/later' }])
			);

			execFileSync('unzip', ['-q', archive, '-d', join(folder, 'out')]);

			expect(statSync(join(folder, 'out', 'ideas', 'later')).isDirectory()).toBe(true);
			expect(statSync(join(folder, 'out', 'work', 'plan.md')).isFile()).toBe(true);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe('what the user is told when there is no download', () => {
	it('names the limit that was met, and that nothing was downloaded', () => {
		expect(downloadProblem(new ArchiveLimitError('entries', ''))).toBe(
			'There are too many notes and notebooks here for one archive, which holds at most 65,534. Nothing was downloaded.'
		);
		expect(downloadProblem(new ArchiveLimitError('bytes', ''))).toBe(
			'These notes come to more than one archive can hold, which is 4 GB. Nothing was downloaded.'
		);
		expect(downloadProblem(new ArchiveLimitError('name', ''))).toBe(
			'A note here has a path too long to put in an archive. Nothing was downloaded.'
		);
	});

	it('asks for another try when it was anything else', () => {
		expect(downloadProblem(new Error('The database connection is closing.'))).toBe(
			'The notes could not be downloaded. Try again.'
		);
		expect(downloadProblem(new RangeError('not ours'))).toBe(
			'The notes could not be downloaded. Try again.'
		);
	});
});

describe('exporting notes', () => {
	const opened: NotesDatabase[] = [];
	const listening: (() => void)[] = [];
	const scope = { connectionId: 'dropbox-1' };

	afterEach(async () => {
		listening.splice(0).forEach((stop) => {
			stop();
		});
		vi.unstubAllGlobals();
		vi.useRealTimers();
		await Promise.all(opened.splice(0).map((db) => db.delete()));
	});

	const freshDatabase = (): NotesDatabase => {
		const db = createDatabase(`export-${crypto.randomUUID()}`);
		opened.push(db);
		return db;
	};

	it('writes each note as the file a push would send, at the path the provider has', async () => {
		const db = freshDatabase();
		// A file the app did not write: no frontmatter, and it must not gain any.
		const pulled = await importNoteFile(db, {
			...scope,
			path: 'work/From elsewhere.md',
			source: '# From elsewhere\n\nas it came\n',
		});
		const made = await createNote(db, { ...scope, title: 'Made here', body: 'typed\n' });

		const files = filesOf([pulled, made]);

		expect(files.map((file) => file.path)).toEqual([made.path, 'work/From elsewhere.md']);
		expect(files.find((file) => file.path === pulled.path)?.content).toBe(
			'# From elsewhere\n\nas it came\n'
		);
		expect(files.find((file) => file.path === made.path)).toEqual({
			path: made.path,
			content: noteFile(made),
			modifiedAt: made.updatedAt,
		});
		expect(made.path.endsWith('.md')).toBe(true);
	});

	it('orders two notes at one path by id, so the numbered one is always the same one', () => {
		const note = (id: string, body: string): NoteRecord => ({
			id,
			connectionId: 'dropbox-1',
			path: 'a.md',
			title: 'A',
			body,
			frontmatter: null,
			tags: [],
			contentHash: 'h',
			source: body,
			dirty: 1,
			deletedLocally: 0,
			createdAt: 1,
			updatedAt: 1,
		});
		const one = note('1111', 'one');
		const two = note('2222', 'two');

		const either = [zipOf(filesOf([one, two])), zipOf(filesOf([two, one]))];

		expect(either[0]).toEqual(either[1]);
		expect(pathsAndContents(either[0] ?? new Uint8Array())).toEqual([
			{ path: 'a.md', content: 'one' },
			{ path: 'a (2).md', content: 'two' },
		]);
	});

	it('hands the browser one archive through a link it clicks and takes away again', async () => {
		const db = freshDatabase();
		const note = await importNoteFile(db, { ...scope, path: 'a.md', source: '# A\n' });

		const blobs: Blob[] = [];
		const createObjectURL = vi.fn((blob: Blob) => {
			blobs.push(blob);
			return 'blob:skysa/1';
		});
		const revokeObjectURL = vi.fn();
		// jsdom has neither, and nothing else here asks `URL` for anything.
		vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
		// Heard at the document, so the link was in the page when it was clicked;
		// and stopped there, since jsdom cannot follow it.
		const clicked: { href: string | null; download: string | null }[] = [];
		const onClick = (event: Event) => {
			event.preventDefault();
			const link = event.target as HTMLAnchorElement;
			clicked.push({
				href: link.getAttribute('href'),
				download: link.getAttribute('download'),
			});
		};
		document.addEventListener('click', onClick);
		listening.push(() => {
			document.removeEventListener('click', onClick);
		});

		// Only from here, and not for long: fake-indexeddb runs on the same timers
		// a fake clock stops.
		vi.useFakeTimers();
		downloadNotes([note], 'my notes.zip');

		expect(clicked).toEqual([{ href: 'blob:skysa/1', download: 'my notes.zip' }]);
		expect(document.querySelector('a[download]')).toBeNull();
		// Kept until the browser has had time to read it, then let go.
		expect(revokeObjectURL).not.toHaveBeenCalled();
		vi.advanceTimersByTime(DOWNLOAD_GRACE_MS - 1);
		expect(revokeObjectURL).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:skysa/1');
		vi.useRealTimers();

		expect(blobs[0]?.type).toBe('application/zip');
		const bytes = new Uint8Array(await (blobs[0] ?? new Blob()).arrayBuffer());
		expect(pathsAndContents(bytes)).toEqual([{ path: 'a.md', content: '# A\n' }]);
	});

	it('takes the link away and lets the blob go even when the click throws', () => {
		const revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { createObjectURL: () => 'blob:skysa/3', revokeObjectURL });
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
			throw new Error('the browser said no');
		});
		listening.push(() => {
			click.mockRestore();
		});

		vi.useFakeTimers();
		expect(() => {
			downloadNotes([]);
		}).toThrow('the browser said no');

		expect(document.querySelector('a[download]')).toBeNull();
		vi.advanceTimersByTime(DOWNLOAD_GRACE_MS);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:skysa/3');
	});

	it('makes nothing to let go of when the archive cannot be written', () => {
		const createObjectURL = vi.fn(() => 'blob:skysa/4');
		vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: () => undefined });
		const note = { path: `${'a'.repeat(0x10000)}.md`, source: 'x', id: '1', updatedAt: 1 };

		expect(() => {
			downloadNotes([note as NoteRecord]);
		}).toThrow(RangeError);

		expect(createObjectURL).not.toHaveBeenCalled();
		expect(document.querySelector('a[download]')).toBeNull();
	});

	it("names the archive by the day on the user's clock, not the one in Greenwich", () => {
		vi.stubGlobal('URL', {
			createObjectURL: () => 'blob:skysa/5',
			revokeObjectURL: () => undefined,
		});
		const names: (string | null)[] = [];
		const onClick = (event: Event) => {
			event.preventDefault();
			names.push((event.target as HTMLAnchorElement).getAttribute('download'));
		};
		document.addEventListener('click', onClick);
		listening.push(() => {
			document.removeEventListener('click', onClick);
		});

		// Half an hour into the local day, and half an hour before its end: in
		// any zone but UTC itself, one of the two is another day in Greenwich.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 19, 0, 30));
		downloadNotes([]);
		vi.setSystemTime(new Date(2026, 8, 19, 23, 30));
		downloadNotes([]);

		expect(names).toEqual(['notes-2026-09-19.zip', 'notes-2026-09-19.zip']);
	});

	it('names the archive by the day when it is not told a name', () => {
		vi.stubGlobal('URL', {
			createObjectURL: () => 'blob:skysa/2',
			revokeObjectURL: () => undefined,
		});
		const names: (string | null)[] = [];
		const onClick = (event: Event) => {
			event.preventDefault();
			names.push((event.target as HTMLAnchorElement).getAttribute('download'));
		};
		document.addEventListener('click', onClick);
		listening.push(() => {
			document.removeEventListener('click', onClick);
		});

		downloadNotes([]);

		expect(names[0]).toMatch(/^notes-\d{4}-\d{2}-\d{2}\.zip$/);
	});

	it('hands a whole source over as one archive, its empty notebooks with it', () => {
		const made: Blob[] = [];
		vi.stubGlobal('URL', {
			createObjectURL: (blob: Blob) => {
				made.push(blob);
				return 'blob:skysa/3';
			},
			revokeObjectURL: () => undefined,
		});
		const onClick = (event: Event) => {
			event.preventDefault();
		};
		document.addEventListener('click', onClick);
		listening.push(() => {
			document.removeEventListener('click', onClick);
		});
		const note: NoteRecord = {
			id: '1111',
			connectionId: LOCAL_CONNECTION_ID,
			path: 'Work/a.md',
			title: 'A',
			body: 'a',
			frontmatter: null,
			tags: [],
			contentHash: 'h',
			source: 'a',
			dirty: 1,
			deletedLocally: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		const library: Library = { notes: [note], folders: [{ path: 'Ideas' }, { path: 'Work' }] };

		downloadLibrary(library);

		expect(made).toHaveLength(1);
		expect(made[0]?.size).toBe(zipOf(filesOf([note]), library.folders).length);
	});
});

describe('a whole source', () => {
	const opened: NotesDatabase[] = [];
	const withdrawn: (() => void)[] = [];

	afterEach(async () => {
		withdrawn.splice(0).forEach((withdraw) => {
			withdraw();
		});
		await Promise.all(opened.splice(0).map((db) => db.delete()));
	});

	const freshDatabase = (): NotesDatabase => {
		const db = createDatabase(`library-${crypto.randomUUID()}`);
		opened.push(db);
		return db;
	};

	it("is its live notes and every notebook, and nothing of another source's", async () => {
		const db = freshDatabase();
		const scope = { connectionId: 'dropbox-1' };
		await createFolder(db, { ...scope, name: 'Work' });
		await createFolder(db, { ...scope, name: 'Empty' });
		const kept = await createNote(db, {
			...scope,
			folderPath: 'Work',
			title: 'Kept',
			body: 'k\n',
		});
		const gone = await createNote(db, {
			...scope,
			folderPath: 'Work',
			title: 'Gone',
			body: 'g\n',
		});
		await deleteNote(db, gone.id, scope);
		await createFolder(db, { connectionId: 'dropbox-2', name: 'Theirs' });
		await createNote(db, { connectionId: 'dropbox-2', title: 'Theirs', body: 't\n' });

		const library = await libraryOf(db, scope.connectionId);

		expect(library.notes.map((note) => note.id)).toEqual([kept.id]);
		expect(library.folders.map((folder) => folder.path)).toEqual(['Empty', 'Work']);
	});

	it('holds something once it has a notebook or a note, and not for a deleted one', async () => {
		const db = freshDatabase();
		const scope = { connectionId: LOCAL_CONNECTION_ID };

		expect(await holdsAnything(db, LOCAL_CONNECTION_ID)).toBe(false);
		const note = await createNote(db, { ...scope, title: 'Loose', body: 'x\n' });
		expect(await holdsAnything(db, LOCAL_CONNECTION_ID)).toBe(true);
		await deleteNote(db, note.id, scope);
		expect(await holdsAnything(db, LOCAL_CONNECTION_ID)).toBe(false);
		await createFolder(db, { ...scope, name: 'Work' });
		expect(await holdsAnything(db, LOCAL_CONNECTION_ID)).toBe(true);
		expect(await holdsAnything(db, 'dropbox-1')).toBe(false);
	});

	it('is read after the editors have written what they were holding', async () => {
		const db = freshDatabase();
		const note = await createNote(db, { title: 'Typing', body: 'before\n' });
		withdrawn.push(
			beforeClosing(async () => {
				await saveNoteBody(db, note.id, 'typed a moment ago\n');
			})
		);
		const given: Library[] = [];

		await downloadSource(db, LOCAL_CONNECTION_ID, (library) => {
			given.push(library);
		});

		expect(given).toHaveLength(1);
		expect(given[0]?.notes.map((each) => each.body)).toEqual(['typed a moment ago\n']);
	});

	it('comes out of a device with nothing connected as the files a push puts in the folder', async () => {
		const db = freshDatabase();
		await createFolder(db, { name: 'Work' });
		await createFolder(db, { parentPath: 'Work', name: 'Deep' });
		await createFolder(db, { name: 'Ideas' });
		await createFolder(db, { parentPath: 'Ideas', name: 'Later' });
		await createNote(db, {
			folderPath: 'Work',
			title: 'Plan',
			body: '# Plan\n\n- [ ] ship it\n',
		});
		await createNote(db, {
			folderPath: 'Work/Deep',
			title: 'Überschrift 日本語',
			body: 'naïve\n',
		});
		await createNote(db, { title: 'Loose', body: 'at the root\n' });
		const pulled = await importNoteFile(db, {
			path: 'Work/From elsewhere.md',
			source: '# From elsewhere\n\nno frontmatter, and none added\n',
		});
		await saveNoteBody(db, pulled.id, '# From elsewhere\n\nedited here\n');

		const library = await libraryOf(db, LOCAL_CONNECTION_ID);
		const archived = readZip(zipOf(filesOf(library.notes), library.folders)).entries;

		// The same library, pushed to a folder by the engine that syncs it.
		await bindConnection(db, {
			connectionId: 'dropbox-1',
			provider: 'dropbox',
			accountId: 'dbid:1',
		});
		const provider = createFakeProvider();
		await provider.ensureRoot();
		await createSyncEngine({
			provider,
			store: createDexieSyncStore(db, { connectionId: 'dropbox-1' }),
		}).sync();
		const pushed = provider.snapshot().filter((entry) => !isHidden(entry.path));
		const files = pushed.filter((entry) => entry.kind === 'file');
		const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);

		expect(
			archived
				.filter((entry) => !entry.path.endsWith('/'))
				.map(({ path, content }) => ({ path, content }))
				.sort(byPath)
		).toEqual(
			files
				.map((entry) => ({ path: entry.path, content: provider.contentAt(entry.path) }))
				.sort(byPath)
		);
		// And each folder the push made with nothing in it is a folder of the
		// archive's own; every other one is there by the files inside it.
		expect(
			archived
				.filter((entry) => entry.path.endsWith('/'))
				.map((entry) => entry.path)
				.sort()
		).toEqual(
			pushed
				.filter(
					(entry) =>
						entry.kind === 'folder' &&
						!files.some((file) => file.path.startsWith(`${entry.path}/`))
				)
				.map((entry) => `${entry.path}/`)
				.sort()
		);
		expect(files).toHaveLength(4);
	});
});
