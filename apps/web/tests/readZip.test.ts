import { deflateRawSync } from 'node:zlib';

import { MAX_ATTACHMENT_BYTES } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import { crc32, zipOf } from '../src/store/exportNotes.js';
import { readZip, type ZipEntry, ZipUnreadableError } from '../src/store/readZip.js';

const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const u32 = (value: number): number[] => [...u16(value & 0xffff), ...u16(value >>> 16)];

interface Written {
	name: string;
	content?: string | Uint8Array;
	/** 0 stored, 8 deflated, or anything else to test refusing it. */
	method?: number;
	flags?: number;
	/** What the headers claim, where a test lies about it. */
	size?: number;
	crc?: number;
	/** Raw name bytes, for a name not written as UTF-8. */
	nameBytes?: Uint8Array;
}

/**
 * An archive the way other tools write one, which the exporter does not: each
 * entry deflated (method 8) unless told otherwise, as Finder, Windows and `zip`
 * do. Built by hand, so a test can lie in any field it likes.
 */
const archive = (entries: readonly Written[], comment = ''): ArrayBuffer => {
	const parts: number[] = [];
	const central: number[] = [];
	entries.forEach((entry) => {
		const name = entry.nameBytes ?? new TextEncoder().encode(entry.name);
		const raw =
			typeof entry.content === 'string'
				? new TextEncoder().encode(entry.content)
				: (entry.content ?? new Uint8Array());
		const method = entry.method ?? 8;
		const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
		const described = [
			...u16(entry.flags ?? 0x0800),
			...u16(method),
			...u16(0),
			...u16(0x21),
			...u32(entry.crc ?? crc32(raw)),
			...u32(data.length),
			...u32(entry.size ?? raw.length),
			...u16(name.length),
			...u16(0),
		];
		const offset = parts.length;
		parts.push(...u32(0x04034b50), ...u16(20), ...described, ...name, ...data);
		central.push(
			...u32(0x02014b50),
			...u16(20),
			...u16(20),
			...described,
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(0),
			...u32(offset),
			...name
		);
	});
	const start = parts.length;
	const note = new TextEncoder().encode(comment);
	const bytes = [
		...parts,
		...central,
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(entries.length),
		...u16(entries.length),
		...u32(central.length),
		...u32(start),
		...u16(note.length),
		...note,
	];
	return Uint8Array.from(bytes).buffer;
};

const text = (entry: ZipEntry | undefined): string | undefined =>
	entry?.kind === 'file' ? new TextDecoder().decode(entry.bytes) : undefined;

describe('readZip', () => {
	it('reads back what the export writes, empty notebooks included', async () => {
		const written = zipOf(
			[
				{ path: 'Work/plan.md', content: '# Plan\n' },
				{ path: 'Work/photo.png', content: Uint8Array.from([1, 2, 3]) },
			],
			[{ path: 'Empty' }]
		);

		const entries = await readZip(written.buffer);

		expect(entries.map((entry) => [entry.kind, entry.name])).toEqual([
			['folder', 'Empty/'],
			['file', 'Work/plan.md'],
			['file', 'Work/photo.png'],
		]);
		expect(text(entries[1])).toBe('# Plan\n');
		expect(entries[2]?.kind === 'file' && [...entries[2].bytes]).toEqual([1, 2, 3]);
	});

	it('inflates what other tools deflate', async () => {
		const body = `# Mici\n\n${'A recipe line. '.repeat(500)}\n`;
		const entries = await readZip(
			archive([{ name: 'Recipes/Food/02 - Mici.md', content: body }])
		);

		expect(entries).toHaveLength(1);
		expect(text(entries[0])).toBe(body);
	});

	it('inflates an entry fed to the decompressor in many slices', async () => {
		// Bytes that do not compress, so the deflated entry is many times a slice.
		const seed = { current: 1 };
		const body = Uint8Array.from({ length: 200_000 }, () => {
			seed.current = (seed.current * 1103515245 + 12345) % 2 ** 31;
			return seed.current >>> 23;
		});

		const entries = await readZip(archive([{ name: 'noise.bin', content: body }]));

		expect(entries[0]?.kind === 'file' && entries[0].bytes).toEqual(body);
	});

	it('reads a name ending in a backslash as a folder, as PowerShell writes one', async () => {
		const entries = await readZip(
			archive([
				{ name: 'Work\\', method: 0 },
				{ name: 'Work\\a.md', content: 'A' },
			])
		);

		expect(entries.map((entry) => [entry.kind, entry.name])).toEqual([
			['folder', 'Work\\'],
			['file', 'Work\\a.md'],
		]);
	});

	it('finds the table of contents behind a comment', async () => {
		const entries = await readZip(
			archive([{ name: 'a.md', content: 'hi' }], 'made by a tool, PK\u0005\u0006 and all')
		);

		expect(text(entries[0])).toBe('hi');
	});

	it('reads a name not marked UTF-8 that is UTF-8, as macOS writes it', async () => {
		const entries = await readZip(archive([{ name: 'café.md', content: 'x', flags: 0 }]));

		expect(entries[0]?.name).toBe('café.md');
	});

	it('reads a name that is not UTF-8 as the old code page it most likely is', async () => {
		const entries = await readZip(
			archive([
				{
					name: '',
					nameBytes: Uint8Array.from([0x63, 0x61, 0x66, 0xe9]),
					content: 'x',
					flags: 0,
				},
			])
		);

		expect(entries[0]?.name).toBe('café');
	});

	it('lists what it cannot read, and reads the rest', async () => {
		const entries = await readZip(
			archive([
				{ name: 'secret.md', content: 'x', flags: 0x0801 },
				{ name: 'bzip.md', content: 'x', method: 12 },
				{ name: 'wrong.md', content: 'x', crc: 1 },
				{ name: 'fine.md', content: 'fine' },
			])
		);

		expect(
			entries.map((entry) => (entry.kind === 'unreadable' ? entry.reason : entry.kind))
		).toEqual(['encrypted', 'method', 'damaged', 'file']);
		expect(text(entries[3])).toBe('fine');
	});

	it('does not inflate an entry past what a file may be', async () => {
		const entries = await readZip(
			archive([{ name: 'huge.png', content: 'x', size: MAX_ATTACHMENT_BYTES + 1 }])
		);

		expect(entries[0]).toEqual({ kind: 'unreadable', name: 'huge.png', reason: 'too-large' });
	});

	it('stops inflating at the size the entry declared', async () => {
		// A megabyte of zeros deflates to about a kilobyte, and says it is ten bytes.
		const entries = await readZip(
			archive([{ name: 'bomb.md', content: new Uint8Array(1024 * 1024), size: 10 }])
		);

		expect(entries[0]).toEqual({ kind: 'unreadable', name: 'bomb.md', reason: 'damaged' });
	});

	it('refuses what is not an archive at all', async () => {
		await expect(readZip(new TextEncoder().encode('# just a note').buffer)).rejects.toEqual(
			new ZipUnreadableError('not-zip')
		);
		await expect(readZip(new ArrayBuffer(0))).rejects.toBeInstanceOf(ZipUnreadableError);
	});

	it('refuses a ZIP64 archive rather than misread it', async () => {
		const bytes = new Uint8Array(archive([{ name: 'a.md', content: 'x' }]));
		// The end record's entry counts, set to "look in the ZIP64 record".
		bytes.set([0xff, 0xff, 0xff, 0xff], bytes.length - 22 + 8);

		await expect(readZip(bytes.buffer)).rejects.toEqual(new ZipUnreadableError('zip64'));
	});
});
