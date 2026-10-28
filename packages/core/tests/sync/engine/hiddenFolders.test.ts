import { describe, expect, it } from 'vitest';

import { syncWorld } from '../kit/world.js';

/**
 * The hidden folders a round meets — the clipboard's, the secrets key file,
 * the scratchpad's and the vault's — and what the engine makes of them
 * (`names`).
 */
const { world, pullNow, remoteFile, noteAt } = syncWorld();

describe("the clipboard's folder", () => {
	// Items a connection's devices share through `.clipboard/` (§7, "The
	// clipboard"). The engine decides nothing about them, as about any hidden
	// path; it only says it met one, so the clipboard is read again.
	const clip = (name: string) =>
		world.provider.createFile(`.clipboard/${name}`, new TextEncoder().encode('copied'));

	it('says a round met it, and makes nothing of it', async () => {
		await world.engine.pull();
		await world.provider.createFolder('.clipboard');
		await clip('20261006T153012123Z-text-3f9a1c2b.txt');

		const result = await world.engine.pull();

		expect(result).toMatchObject({ status: 'ok', pulled: 0, clipboard: true });
		expect(world.store.notes()).toEqual([]);
		expect(world.store.files()).toEqual([]);
		expect(world.store.folders()).toEqual([]);
	});

	it('says a scan met it', async () => {
		await world.provider.createFolder('.clipboard');
		await clip('20261006T153012123Z-pasted-image-3f9a1c2b.png');

		expect(await world.engine.pull()).toMatchObject({ status: 'ok', clipboard: true });
		expect(world.store.files()).toEqual([]);
	});

	it('says an item went', async () => {
		await world.provider.createFolder('.clipboard');
		const item = await clip('20261006T153012123Z-text-3f9a1c2b.txt');
		await world.engine.pull();
		await world.provider.delete(item);

		expect(await world.engine.pull()).toMatchObject({ pulled: 0, clipboard: true });
	});

	it('says it may have met it, for something gone by its id alone', async () => {
		// An id feed's path comes from its tree, and an item this device sent
		// is not in it until the feed reports it back: let go of on another
		// device first, it is an id and nothing else.
		await world.engine.pull();

		const result = await pullNow([{ deleted: true, remoteId: 'an-item-pasted-here' }]);

		expect(result).toMatchObject({ status: 'ok', pulled: 0, clipboard: true });
	});

	it('says nothing of a round that did not meet it', async () => {
		await world.provider.createFolder('.clipboard');
		await world.engine.pull();
		await remoteFile('a.md', 'x\n');
		await world.provider.write('.cache', 'binary\n', {});

		const result = await world.engine.pull();

		expect(result.pulled).toBe(1);
		expect(result.clipboard).toBeUndefined();
	});

	it('carries it through a whole sync', async () => {
		await world.engine.pull();
		await world.provider.createFolder('.clipboard');

		expect((await world.engine.sync()).clipboard).toBe(true);
	});
});

describe('the key file for secrets', () => {
	// `.encryption.json` at the root holds the public half of the source's key
	// (§7, "Secrets in a note"). The engine decides nothing about it, as about
	// any hidden path; it says it met it, so the device reads it again.
	const keyFile = '{"schemaVersion":1,"recipient":"age1…","setAt":"2026-10-14T00:00:00Z"}\n';

	it('says a round met it, and makes nothing of it', async () => {
		await world.engine.pull();
		await world.provider.write('.encryption.json', keyFile, {});

		const result = await world.engine.pull();

		expect(result).toMatchObject({ status: 'ok', pulled: 0, encryption: true });
		expect(result.clipboard).toBeUndefined();
		expect(world.store.notes()).toEqual([]);
		expect(world.store.files()).toEqual([]);
	});

	it('says a scan met it', async () => {
		await world.provider.write('.encryption.json', keyFile, {});

		expect(await world.engine.pull()).toMatchObject({ status: 'ok', encryption: true });
	});

	it('says it may have met it, for something gone by its id alone', async () => {
		await world.engine.pull();

		const result = await pullNow([{ deleted: true, remoteId: 'gone-by-id' }]);

		expect(result).toMatchObject({ status: 'ok', clipboard: true, encryption: true });
	});

	it('says nothing of a round that did not meet it', async () => {
		await world.provider.write('.encryption.json', keyFile, {});
		await world.engine.pull();
		await remoteFile('a.md', 'x\n');
		await world.provider.createFolder('notes');
		await world.provider.write('notes/.encryption.json', keyFile, {});

		const result = await world.engine.pull();

		expect(result.pulled).toBeGreaterThan(0);
		expect(result.encryption).toBeUndefined();
	});

	it('carries it through a whole sync', async () => {
		await world.engine.pull();
		await world.provider.write('.encryption.json', keyFile, {});

		expect((await world.engine.sync()).encryption).toBe(true);
	});
});

describe("the scratchpad's folder", () => {
	// Notes the scratchpad shows, in `.scratchpad/` (§7, "The scratchpad"):
	// hidden from the notebooks by its dot, but notes all the same, synced as
	// any are. The clipboard's folder beside it stays hidden.
	it('brings a scratch note and its folder in', async () => {
		await world.provider.createFolder('.scratchpad');
		await remoteFile('.scratchpad/untitled.md', 'milk, eggs\n');

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(noteAt('.scratchpad/untitled.md')?.content).toBe('milk, eggs\n');
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['.scratchpad']);
		expect(result.clipboard).toBeUndefined();
	});

	it('sends one written here', async () => {
		world.store.put({
			id: 'n1',
			path: '.scratchpad/untitled.md',
			content: 'mine\n',
			dirty: true,
		});
		world.store.queue({ op: 'write', noteId: 'n1', path: '.scratchpad/untitled.md' });

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.contentAt('.scratchpad/untitled.md')).toBe('mine\n');
		expect(noteAt('.scratchpad/untitled.md')?.dirty).toBe(false);
	});

	it('passes over what is hidden inside it', async () => {
		await world.provider.createFolder('.scratchpad');
		await remoteFile('.scratchpad/.draft.md', 'x\n');

		await world.engine.pull();

		expect(world.store.notes()).toEqual([]);
	});
});

describe("the vault's passwords' folder", () => {
	// Passwords in the vault, in `.vault/` (§7, "Passwords in the vault"):
	// hidden from the notebooks by its dot, but notes all the same, synced as
	// any are, as the scratchpad's are.
	it('brings an item and its folder in', async () => {
		await world.provider.createFolder('.vault');
		await remoteFile('.vault/github.md', '---\ntitle: GitHub\n---\n');

		expect((await world.engine.pull()).status).toBe('ok');
		expect(noteAt('.vault/github.md')?.content).toBe('---\ntitle: GitHub\n---\n');
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['.vault']);
	});

	it('sends one written here', async () => {
		world.store.put({ id: 'n1', path: '.vault/github.md', content: 'mine\n', dirty: true });
		world.store.queue({ op: 'write', noteId: 'n1', path: '.vault/github.md' });

		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.contentAt('.vault/github.md')).toBe('mine\n');
	});

	it('passes over what is hidden inside it', async () => {
		await world.provider.createFolder('.vault');
		await remoteFile('.vault/.draft.md', 'x\n');

		await world.engine.pull();

		expect(world.store.notes()).toEqual([]);
	});
});
