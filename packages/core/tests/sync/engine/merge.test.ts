import { describe, expect, it, vi } from 'vitest';

import type { MergeInput } from '../../../src/sync/engine.js';
import type { SyncStore } from '../../../src/sync/store.js';
import { entryAt } from '../kit/remote.js';
import { editHere, renameHere } from '../kit/userActions.js';
import { syncWorld } from '../kit/world.js';

/**
 * An app's merge, asked before the conflict rule (docs/ARCHITECTURE.md §7,
 * "Merge before the copy"). This app passes none, and every other engine test
 * runs without one; memoriam's merges a passage practised on two devices.
 * These run with a merge of their own, so the hook is held to what the kit
 * promises whichever app hands one in.
 */
const { world, engineWith, copyId, noteAt, pulledNote } = syncWorld();

const linesOf = (text: string): string[] => text.split('\n').filter((line) => line !== '');

/**
 * Lists under a first line both sides keep, merged as their union: this
 * device's lines, then the remote's it lacks. Two lists under different first
 * lines are not one list, and are not merged.
 */
const unionOfLines = ({ local, remote }: MergeInput): string | undefined => {
	const mine = linesOf(local);
	const theirs = linesOf(remote);
	if (mine[0] !== theirs[0]) return undefined;
	return `${[...mine, ...theirs.filter((line) => !mine.includes(line))].join('\n')}\n`;
};

const merging = (on: SyncStore = world.store) =>
	engineWith({ store: on, merge: unionOfLines, newId: copyId });

/** A list synced to this device, then edited here and, unseen, on another. */
const bothChanged = async (local: string, remote: string) => {
	const { note } = await pulledNote('list.md', '# List\napples\n');
	editHere(world.store, note, local);
	await world.provider.write('list.md', remote, {
		expectedVersion: entryAt(world.provider, 'list.md').version,
	});
};

const MINE = '# List\napples\nbread\n';
const THEIRS = '# List\napples\npears\n';
const BOTH = '# List\napples\nbread\npears\n';

describe('an engine handed a merge', () => {
	it('merges on a pull, and sends the merge', async () => {
		await bothChanged(MINE, THEIRS);

		expect(await merging().sync()).toMatchObject({ status: 'ok', conflicts: [] });

		expect(world.provider.contentAt('list.md')).toBe(BOTH);
		expect(noteAt('list.md')).toMatchObject({ content: BOTH, dirty: false });
		expect(world.store.notes()).toHaveLength(1);
	});

	it('merges when a push finds the remote moved on', async () => {
		await bothChanged(MINE, THEIRS);

		expect(await merging().push()).toMatchObject({ status: 'ok', pushed: 1, conflicts: [] });

		expect(world.provider.contentAt('list.md')).toBe(BOTH);
		expect(noteAt('list.md')).toMatchObject({ content: BOTH, dirty: false });
		expect(await world.store.pendingOps()).toEqual([]);
	});

	it('sends nothing on a sync where the remote already holds the merge', async () => {
		await bothChanged('# List\n', THEIRS);
		const writes = () => world.provider.callLog().filter((call) => call.op === 'write').length;
		const before = writes();

		expect(await merging().sync()).toMatchObject({ status: 'ok', conflicts: [] });

		expect(noteAt('list.md')).toMatchObject({ content: THEIRS, dirty: false });
		expect(writes()).toBe(before);
	});

	it('sends nothing on a push where the merge is the remote, and drops the write', async () => {
		await bothChanged('# List\n', THEIRS);
		const { version } = entryAt(world.provider, 'list.md');

		// The write the remote refuses is the only one sent.
		expect(await merging().push()).toMatchObject({ status: 'ok', pushed: 0, conflicts: [] });

		expect(entryAt(world.provider, 'list.md').version).toBe(version);
		expect(noteAt('list.md')).toMatchObject({ content: THEIRS, dirty: false });
		expect(await world.store.pendingOps()).toEqual([]);
	});

	it('leaves the merge at the name a rename queued here gave it', async () => {
		// Renamed here and not yet pushed: the merge is made where the note is
		// now, not moved back to the name the remote still has it under.
		await bothChanged(MINE, THEIRS);
		const note = noteAt('list.md');
		if (note === undefined) throw new Error('not pulled');
		renameHere(world.store, note, 'renamed.md');

		expect(await merging().pull()).toMatchObject({ status: 'ok', conflicts: [] });
		expect(noteAt('list.md')).toBeUndefined();
		expect(noteAt('renamed.md')?.content).toBe(BOTH);

		expect(await merging().push()).toMatchObject({ status: 'ok', conflicts: [] });
		expect(world.provider.contentAt('list.md')).toBeUndefined();
		expect(world.provider.contentAt('renamed.md')).toBe(BOTH);
	});

	it('merges again from an edit made while the first merge was on its way', async () => {
		// The store refuses a merge made from what the note no longer holds, the
		// pull rolls back with its cursor, and the next one merges the newer edit.
		await bothChanged(MINE, THEIRS);
		const cursor = world.store.storedCursor();
		const edited = { done: false };
		const editing: SyncStore = {
			...world.store,
			applyChanges: (batch) => {
				const note = noteAt('list.md');
				if (!edited.done && note !== undefined) {
					world.store.put({ ...note, content: '# List\napples\nbread\nmilk\n' });
				}
				edited.done = true;
				return world.store.applyChanges(batch);
			},
		};

		expect((await merging(editing).pull()).status).toBe('retry');
		expect(world.store.storedCursor()).toBe(cursor);

		expect(await merging(editing).sync()).toMatchObject({ status: 'ok', conflicts: [] });
		expect(world.provider.contentAt('list.md')).toBe('# List\napples\nbread\nmilk\npears\n');
	});

	it('keeps both, as a conflict copy, where the merge makes none', async () => {
		await bothChanged(MINE, '# Other\npears\n');

		const result = await merging().sync();

		expect(result.conflicts).toHaveLength(1);
		expect(world.store.notes()).toHaveLength(2);
	});

	it.each([
		['without a merge', undefined],
		[
			'with a merge that throws',
			() => {
				throw new Error('no');
			},
		],
	])('keeps both, as this app does, %s', async (_, merge) => {
		await bothChanged(MINE, THEIRS);

		const result = await engineWith({
			newId: copyId,
			...(merge === undefined ? {} : { merge }),
		}).sync();

		expect(result.conflicts).toHaveLength(1);
		expect(world.store.notes()).toHaveLength(2);
	});

	it.each(['pull', 'push'] as const)(
		'asks on a %s with the remote’s path and both texts',
		async (run) => {
			await bothChanged(MINE, THEIRS);
			const merge = vi.fn(() => undefined);

			await engineWith({ newId: copyId, merge })[run]();

			expect(merge).toHaveBeenCalledWith({ path: 'list.md', local: MINE, remote: THEIRS });
		}
	);
});
