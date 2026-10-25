import { describe, expect, it, vi } from 'vitest';

import { MARKER_FILE } from '../../src/config.js';
import { parseMarker } from '../../src/marker.js';
import {
	isSelf,
	outsideRoot,
	readAsText,
	rootFolderEntry,
	writeMarkerOnce,
} from '../../src/providers/adapter.js';
import {
	ConflictError,
	NotFoundError,
	type RemoteEntry,
	UnreadableError,
} from '../../src/providers/types.js';

/**
 * The contract glue the HTTP adapters share (`providers/adapter.ts`). Every
 * adapter runs it through the contract suite; this is what each piece
 * promises on its own.
 */

const entry = (fields: Partial<RemoteEntry>): RemoteEntry => ({
	remoteId: '',
	path: 'a.md',
	kind: 'file',
	version: 'v1',
	modifiedAt: '',
	...fields,
});

const options = { provider: 'onedrive' as const, appVersion: '1.2.3', clientId: 'install-1' };

describe('writeMarkerOnce', () => {
	it('writes nothing where the marker is already there', async () => {
		const create = vi.fn(() => Promise.resolve());
		await writeMarkerOnce(options, () => Promise.resolve(true), create);
		expect(create).not.toHaveBeenCalled();
	});

	it('writes a marker naming the provider and install where there is none', async () => {
		const create = vi.fn((_path: string, _content: string) => Promise.resolve());
		await writeMarkerOnce(
			{ ...options, userAgent: 'agent' },
			() => Promise.resolve(false),
			create
		);

		expect(create).toHaveBeenCalledTimes(1);
		const [path, content] = create.mock.calls[0] ?? [];
		expect(path).toBe(MARKER_FILE);
		const parsed = parseMarker(content ?? '');
		expect(parsed.status).toBe('ok');
		if (parsed.status !== 'ok') return;
		expect(parsed.marker.createdBy).toEqual({
			appVersion: '1.2.3',
			provider: 'onedrive',
			clientId: 'install-1',
			userAgent: 'agent',
		});
	});

	it('lets a marker another device wrote meanwhile stand', async () => {
		const create = () => Promise.reject(new ConflictError(entry({ path: MARKER_FILE })));
		await expect(
			writeMarkerOnce(options, () => Promise.resolve(false), create)
		).resolves.toBeUndefined();
	});

	it('passes on any other failure', async () => {
		const create = () => Promise.reject(new Error('503'));
		await expect(
			writeMarkerOnce(options, () => Promise.resolve(false), create)
		).rejects.toThrow('503');
	});
});

describe('readAsText', () => {
	it('decodes the bytes as UTF-8 at the version they were read at', async () => {
		const read = readAsText(() =>
			Promise.resolve({ bytes: new TextEncoder().encode('# Hé'), version: 'v7' })
		);
		expect(await read({ remoteId: 'id', path: 'a.md' })).toEqual({
			content: '# Hé',
			version: 'v7',
		});
	});

	it('refuses bytes that are not UTF-8, naming the file', async () => {
		const read = readAsText(() =>
			Promise.resolve({ bytes: Uint8Array.from([0xff, 0xfe, 0x00]), version: 'v1' })
		);
		await expect(read({ remoteId: '', path: 'b.md' })).rejects.toBeInstanceOf(UnreadableError);
	});
});

describe('outsideRoot', () => {
	it('acts on the path as the contract normalizes it', async () => {
		const act = vi.fn((target: string) => Promise.resolve(target));
		expect(await outsideRoot('/notes//a.md', act)).toBe('notes/a.md');
	});

	it('refuses the root with a rejection, without acting', async () => {
		const act = vi.fn((target: string) => Promise.resolve(target));
		for (const root of ['', '/', '//']) {
			const answer = outsideRoot(root, act);
			expect(answer).toBeInstanceOf(Promise);
			await expect(answer).rejects.toBeInstanceOf(NotFoundError);
		}
		expect(act).not.toHaveBeenCalled();
	});
});

describe('rootFolderEntry', () => {
	it('is the root, as a folder, under the id given', () => {
		expect(rootFolderEntry('root-1')).toEqual({
			remoteId: 'root-1',
			path: '',
			kind: 'folder',
			version: '',
			modifiedAt: '',
		});
	});
});

describe('isSelf', () => {
	it('goes by id wherever both sides have one, whatever the paths say', () => {
		expect(isSelf({ remoteId: 'x', path: 'old.md' }, entry({ remoteId: 'x' }), 'exact')).toBe(
			true
		);
		expect(
			isSelf(
				{ remoteId: 'x', path: 'a.md' },
				entry({ remoteId: 'y', path: 'a.md' }),
				'folded'
			)
		).toBe(false);
	});

	it('goes by path where either side has no id: folded or exact, as asked', () => {
		const current = entry({ remoteId: 'x', path: 'Notes/A.md' });
		expect(isSelf({ remoteId: '', path: '/notes/a.md' }, current, 'folded')).toBe(true);
		expect(isSelf({ remoteId: '', path: '/notes/a.md' }, current, 'exact')).toBe(false);
		expect(isSelf({ remoteId: '', path: '/Notes/A.md' }, current, 'exact')).toBe(true);
		expect(
			isSelf({ remoteId: 'x', path: 'Notes/A.md' }, entry({ path: 'Notes/A.md' }), 'exact')
		).toBe(true);
	});
});
