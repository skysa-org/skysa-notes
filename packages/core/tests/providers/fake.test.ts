import { describe, expect, it } from 'vitest';

import { createFakeProvider } from '../../src/providers/fake.js';
import { AuthError, NotFoundError, UnreadableError } from '../../src/providers/types.js';
import { drainChanges } from './contract.js';

/**
 * What the contract suite cannot assert, because real providers disagree about
 * it — plus the knobs the sync-engine tests will lean on. The fake is a test
 * fixture, so its own behaviour needs pinning as much as any adapter's.
 */

const ready = async (options = {}) => {
	const provider = createFakeProvider(options);
	await provider.ensureRoot();
	return provider;
};

describe('strictness the contract cannot require', () => {
	it('refuses to create a file in a folder that does not exist', async () => {
		// Dropbox would create the missing folder and WebDAV answers 409, so the
		// contract stays quiet. Being strict here is what forces the engine to
		// queue the `mkdir` its op queue already has a slot for.
		const provider = await ready();
		await expect(provider.write('Nowhere/a.md', 'x\n', {})).rejects.toThrow(NotFoundError);
	});

	it('refuses to create a folder under one that does not exist', async () => {
		const provider = await ready();
		await expect(provider.createFolder('Nowhere/Deep')).rejects.toThrow(NotFoundError);
	});

	it('does not resolve a deleted id to whatever now holds the path', async () => {
		// Ids are never reused here, so a caller naming a deleted one is naming
		// a file that is gone. An id-addressed provider (Drive, Graph) answers
		// 404; falling back to the path would quietly act on a stranger's file,
		// and a fake that forgives that hides engine bugs rather than finding
		// them.
		const provider = await ready();
		const first = await provider.write('a.md', 'one\n', {});
		await provider.delete(first);
		await provider.write('a.md', 'two\n', {});

		await expect(provider.read({ remoteId: first.remoteId, path: 'a.md' })).rejects.toThrow(
			NotFoundError
		);
		await expect(
			provider.move({ remoteId: first.remoteId, path: 'a.md' }, 'b.md')
		).rejects.toThrow(NotFoundError);
	});

	it('gives a new version to every write, even one that changes nothing', async () => {
		const provider = await ready();
		const first = await provider.write('a.md', 'same\n', {});
		const second = await provider.write('a.md', 'same\n', { expectedVersion: first.version });

		expect(second.version).not.toBe(first.version);
	});

	it('never reuses an id after a delete', async () => {
		const provider = await ready();
		const first = await provider.write('a.md', 'x\n', {});
		await provider.delete(first);
		const second = await provider.write('a.md', 'x\n', {});

		expect(second.remoteId).not.toBe(first.remoteId);
	});

	it('resolves a stale path through the id', async () => {
		// This is the whole reason a note stores an id alongside its path: some
		// other client moved the file, and the local record has not caught up.
		const provider = await ready();
		const entry = await provider.write('a.md', 'body\n', {});
		await provider.move(entry, 'b.md');

		expect((await provider.read({ remoteId: entry.remoteId, path: 'a.md' })).content).toBe(
			'body\n'
		);
	});

	it('refuses to move a folder inside itself', async () => {
		const provider = await ready();
		const folder = await provider.createFolder('Work');
		await expect(provider.move(folder, 'Work/Nested')).rejects.toThrow(/inside itself/);
	});
});

describe('deletions', () => {
	it('passes the id along when it has one', async () => {
		// `DeletedEntry.remoteId` is optional because Dropbox has none to give.
		// A provider that does know it must still report it, or the field is
		// dead weight in the type.
		const provider = await ready();
		const entry = await provider.write('a.md', 'x\n', {});
		const { cursor } = await drainChanges(provider);

		await provider.delete(entry);
		const { entries } = await drainChanges(provider, cursor);

		expect(entries).toContainEqual({
			path: 'a.md',
			deleted: true,
			remoteId: entry.remoteId,
		});
	});
});

describe('pagination', () => {
	it('walks a cold start one entry at a time and lands on the same set', async () => {
		const seed = async (pageSize: number) => {
			const provider = await ready({ pageSize });
			await provider.createFolder('Work');
			await provider.write('Work/a.md', 'a\n', {});
			await provider.write('Work/b.md', 'b\n', {});
			return provider;
		};

		const paged = await seed(1);
		const whole = await seed(Number.POSITIVE_INFINITY);

		const first = await paged.changes();
		expect(first.entries).toHaveLength(1);
		expect(first.more).toBe(true);

		const all = await drainChanges(paged);
		expect(all.entries.map((e) => e.path).sort()).toEqual(
			(await drainChanges(whole)).entries.map((e) => e.path).sort()
		);
	});

	it('stops reporting more once the page is the last one', async () => {
		const provider = await ready({ pageSize: 1 });
		const { cursor } = await drainChanges(provider);
		const after = await provider.changes(cursor);

		expect(after.entries).toEqual([]);
		expect(after.more).toBe(false);
	});
});

describe('how much of a subtree a change reports', () => {
	it('reports only the folder by default', async () => {
		// Google Drive behaves this way: the engine has to rebase the descendants
		// itself rather than waiting to be told about each one.
		const provider = await ready();
		const folder = await provider.createFolder('Work');
		await provider.write('Work/a.md', 'a\n', {});
		const { cursor } = await drainChanges(provider);

		await provider.move(folder, 'Archive');
		const { entries } = await drainChanges(provider, cursor);

		expect(entries.map((e) => e.path)).toEqual(['Archive']);
	});

	it('reports every entry underneath when asked to', async () => {
		const provider = await ready({ folderChanges: 'recursive' });
		const folder = await provider.createFolder('Work');
		await provider.write('Work/a.md', 'a\n', {});
		const { cursor } = await drainChanges(provider);

		await provider.move(folder, 'Archive');
		const { entries } = await drainChanges(provider, cursor);

		expect(entries.map((e) => e.path).sort()).toEqual(['Archive', 'Archive/a.md']);
	});
});

describe('fault injection', () => {
	it('fails only the attempt the test asks for', async () => {
		const provider = await ready();
		provider.setFault((call) =>
			call.op === 'write' && call.attempt === 1 ? new AuthError() : undefined
		);

		await expect(provider.write('a.md', 'x\n', {})).rejects.toThrow(AuthError);
		await expect(provider.write('a.md', 'x\n', {})).resolves.toMatchObject({ path: 'a.md' });
	});

	it('leaves the store untouched when it fails', async () => {
		const provider = await ready();
		provider.setFault(() => new AuthError());

		await expect(provider.write('a.md', 'x\n', {})).rejects.toThrow(AuthError);
		provider.setFault(undefined);
		expect(provider.contentAt('a.md')).toBeUndefined();
	});

	it('records every call, so a test can assert what was not done', async () => {
		const provider = await ready();
		await provider.write('a.md', 'x\n', {});
		await provider.list('');

		expect(provider.callLog().map((call) => call.op)).toEqual(['ensureRoot', 'write', 'list']);
	});
});

describe('determinism', () => {
	it('gives the same timestamps to the same sequence of operations', async () => {
		const run = async () => {
			const provider = await ready();
			await provider.createFolder('Work');
			return (await provider.write('Work/a.md', 'x\n', {})).modifiedAt;
		};

		expect(await run()).toBe(await run());
	});

	it('advances the clock so later writes are strictly later', async () => {
		const provider = await ready();
		const first = await provider.write('a.md', 'x\n', {});
		const second = await provider.write('b.md', 'y\n', {});

		expect(Date.parse(second.modifiedAt)).toBeGreaterThan(Date.parse(first.modifiedAt));
	});
});

/**
 * The way a test puts a file there that no `write` could: one that is not
 * UTF-8. It has to behave as another tool saving into the folder does, or the
 * engine tests built on it prove nothing about a real one.
 */
describe('a file written as bytes', () => {
	const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);

	it('keeps the id of the file it saves over, renews the version, and is in the feed', async () => {
		const provider = await ready();
		const first = await provider.write('a.md', 'one\n', {});
		const { cursor } = await drainChanges(provider);

		const saved = provider.writeBytes('a.md', LATIN1);

		expect(saved.remoteId).toBe(first.remoteId);
		expect(saved.version).not.toBe(first.version);
		expect(saved.size).toBe(LATIN1.length);
		const { entries } = await drainChanges(provider, cursor);
		expect(entries).toEqual([saved]);
	});

	it('is a new file where there was none, and needs its folder like any other', async () => {
		const provider = await ready();

		expect(provider.writeBytes('a.md', LATIN1).remoteId).not.toBe('');
		expect(() => provider.writeBytes('Nowhere/a.md', LATIN1)).toThrow(NotFoundError);
	});

	it('is unreadable as text and whole as bytes', async () => {
		const provider = await ready();
		const saved = provider.writeBytes('a.md', LATIN1);

		await expect(provider.read(saved)).rejects.toThrow(UnreadableError);
		expect((await provider.readBytes(saved)).bytes).toEqual(LATIN1);
		expect(provider.bytesAt('a.md')).toEqual(LATIN1);
		expect(provider.contentAt('a.md')).toBeUndefined();
	});

	it('is text again once text is written over it', async () => {
		const provider = await ready();
		const saved = provider.writeBytes('a.md', LATIN1);

		const fixed = await provider.write('a.md', 'café\n', { expectedVersion: saved.version });

		expect((await provider.read(fixed)).content).toBe('café\n');
		expect(provider.contentAt('a.md')).toBe('café\n');
		expect(provider.bytesAt('a.md')).toEqual(new TextEncoder().encode('café\n'));
	});

	it('reads through the same faults and the same not-found as `read`', async () => {
		const provider = await ready();
		const saved = provider.writeBytes('a.md', LATIN1);
		provider.setFault((call) => (call.op === 'read' ? new AuthError('expired') : undefined));
		await expect(provider.readBytes(saved)).rejects.toThrow(AuthError);

		provider.setFault(undefined);
		await provider.delete(saved);
		await expect(provider.readBytes(saved)).rejects.toThrow(NotFoundError);
	});

	it('refuses text holding a NUL that `write` put there, as an adapter would', async () => {
		// Decoded from the bytes whoever wrote them: the fake stays the strictest
		// provider, so an engine that pushed a NUL finds out here.
		const provider = await ready();
		const entry = await provider.write('a.md', 'a\u0000b\n', {});

		await expect(provider.read(entry)).rejects.toThrow(UnreadableError);
	});
});
