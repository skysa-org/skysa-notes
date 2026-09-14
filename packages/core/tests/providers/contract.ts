import { describe, expect, it } from 'vitest';

import { isHidden, MARKER_FILE, parseMarker } from '../../src/index.js';
import {
	type ChangeEntry,
	ConflictError,
	CursorResetError,
	NotFoundError,
	type RemoteEntry,
	type StorageProvider,
} from '../../src/providers/types.js';

/**
 * The scenario suite every adapter has to pass — see CLAUDE.md. It is a helper
 * rather than a test file so that `tests/providers/contract.test.ts` can
 * register several adapters against it; Vitest collects only `*.test.ts`, so
 * this module is never picked up on its own.
 *
 * It asserts only what all four providers can honour. Where they genuinely
 * differ — whether a move keeps the file's id, whether a move changes its
 * version — the suite pins the weaker invariant and the difference is either a
 * harness capability or left to the adapter's own tests.
 */

export interface ProviderHarness {
	provider: StorageProvider;
	/**
	 * Empty the app folder. Live adapters need this between scenarios; an
	 * in-memory fake built fresh per test does not.
	 */
	cleanup?: () => Promise<void>;
}

export interface ProviderContractOptions {
	/**
	 * False for path-based providers, where `remoteId` *is* the path and so
	 * cannot survive a move. WebDAV re-links renames through frontmatter `id`
	 * instead (docs/PLAN.md §5.4).
	 */
	stableIds?: boolean;
	/** Live accounts are slow. */
	timeout?: number;
}

/** Follow `more` to the end, the way the sync engine has to. */
export const drainChanges = async (
	provider: StorageProvider,
	from?: string
): Promise<{ entries: ChangeEntry[]; cursor: string }> => {
	const first = await provider.changes(from);
	const all = [...first.entries];
	let cursor = first.cursor;
	let more = first.more;

	while (more) {
		const next = await provider.changes(cursor);
		all.push(...next.entries);
		cursor = next.cursor;
		more = next.more;
	}

	return { entries: all, cursor };
};

const paths = (entries: readonly RemoteEntry[]): string[] =>
	entries.map((entry) => entry.path).sort();

const at = (entries: readonly ChangeEntry[], path: string): ChangeEntry | undefined =>
	entries.filter((entry) => entry.path === path).at(-1);

export const describeProviderContract = (
	name: string,
	createHarness: () => ProviderHarness | Promise<ProviderHarness>,
	options: ProviderContractOptions = {}
): void => {
	const { stableIds = true, timeout } = options;
	const config = timeout === undefined ? undefined : { timeout };

	describe(`StorageProvider contract: ${name}`, () => {
		/** Fresh root for every scenario, so no test can depend on another's leftovers. */
		const open = async (): Promise<StorageProvider> => {
			const harness = await createHarness();
			await harness.cleanup?.();
			await harness.provider.ensureRoot();
			return harness.provider;
		};

		const seedFile = async (
			provider: StorageProvider,
			path: string,
			content = 'hello\n'
		): Promise<RemoteEntry> => provider.write(path, content, {});

		describe('ensureRoot', () => {
			it('returns a non-empty root id and writes a valid marker', config, async () => {
				const provider = await open();

				const { rootId } = await provider.ensureRoot();
				expect(rootId).not.toBe('');

				const entries = await provider.list('');
				const marker = entries.find((entry) => entry.path === MARKER_FILE);
				expect(marker).toBeDefined();

				const read = await provider.read(marker!);
				expect(parseMarker(read.content).status).toBe('ok');
			});

			it('is idempotent and never rewrites the marker', config, async () => {
				// A second device must not overwrite the first device's provenance,
				// so a repeat call leaves the file — and its version — untouched.
				const provider = await open();
				const before = (await provider.list('')).find((e) => e.path === MARKER_FILE)!;
				const first = await provider.read(before);

				const { rootId } = await provider.ensureRoot();
				const after = (await provider.list('')).find((e) => e.path === MARKER_FILE)!;

				expect(rootId).not.toBe('');
				expect(after.version).toBe(before.version);
				expect((await provider.read(after)).content).toBe(first.content);
			});
		});

		describe('write and read', () => {
			it('creates a file and reads back the exact bytes', config, async () => {
				const provider = await open();
				const body = '# Heading\n\nBody with é, 中文, and an emoji 🙂.\n';

				const entry = await seedFile(provider, 'note.md', body);
				expect(entry.kind).toBe('file');
				expect(entry.remoteId).not.toBe('');
				expect(entry.version).not.toBe('');
				expect(Number.isNaN(Date.parse(entry.modifiedAt))).toBe(false);

				const read = await provider.read(entry);
				expect(read.content).toBe(body);
				expect(read.version).toBe(entry.version);
			});

			it('round-trips an empty file', config, async () => {
				const provider = await open();
				const entry = await seedFile(provider, 'empty.md', '');
				expect((await provider.read(entry)).content).toBe('');
			});

			it('normalizes the path at its edge', config, async () => {
				const provider = await open();
				await provider.createFolder('Work');

				const entry = await provider.write('/Work//Notes/../a.md', 'x\n', {});
				expect(entry.path).toBe('Work/a.md');
				expect(paths(await provider.list('Work'))).toContain('Work/a.md');
			});

			it('updates in place when the expected version matches', config, async () => {
				const provider = await open();
				const first = await seedFile(provider, 'note.md', 'one\n');

				const second = await provider.write('note.md', 'two\n', {
					expectedVersion: first.version,
				});

				expect(second.version).not.toBe(first.version);
				expect((await provider.read(second)).content).toBe('two\n');
				if (stableIds) expect(second.remoteId).toBe(first.remoteId);
			});

			it('refuses a stale expected version', config, async () => {
				const provider = await open();
				const first = await seedFile(provider, 'note.md', 'one\n');
				const second = await provider.write('note.md', 'two\n', {
					expectedVersion: first.version,
				});

				await expect(
					provider.write('note.md', 'three\n', { expectedVersion: first.version })
				).rejects.toThrow(ConflictError);

				// The conflict carries the current entry, so the caller can apply the
				// conflict rule without a second round trip.
				const error = await provider
					.write('note.md', 'three\n', { expectedVersion: first.version })
					.catch((e: unknown) => e);
				expect(error).toBeInstanceOf(ConflictError);
				expect((error as ConflictError).remote.version).toBe(second.version);

				expect((await provider.read(second)).content).toBe('two\n');
			});

			it('compares versions for equality, not order', config, async () => {
				// `version` is opaque. A value that happens to sort higher is still
				// simply "not the one I expected".
				const provider = await open();
				await seedFile(provider, 'note.md', 'one\n');

				await expect(
					provider.write('note.md', 'two\n', { expectedVersion: 'zzzz-9999' })
				).rejects.toThrow(ConflictError);
			});

			it('refuses to create over a file that already exists', config, async () => {
				// No expected version means "I expect nothing here". Without this,
				// re-creating a note that was deleted remotely would silently clobber
				// whatever came back in the meantime.
				const provider = await open();
				await seedFile(provider, 'note.md', 'one\n');

				await expect(provider.write('note.md', 'two\n', {})).rejects.toThrow(ConflictError);
				expect((await provider.read({ remoteId: '', path: 'note.md' })).content).toBe(
					'one\n'
				);
			});

			it('reports a missing file when an expected version is given', config, async () => {
				const provider = await open();
				await expect(
					provider.write('ghost.md', 'x\n', { expectedVersion: 'v1' })
				).rejects.toThrow(NotFoundError);
			});
		});

		describe('folders and listing', () => {
			it('creates a folder and lists one level only', config, async () => {
				const provider = await open();
				const folder = await provider.createFolder('Work');
				expect(folder.kind).toBe('folder');

				await provider.createFolder('Work/Meetings');
				await seedFile(provider, 'Work/a.md');
				await seedFile(provider, 'Work/Meetings/b.md');

				expect(paths(await provider.list('Work'))).toEqual(['Work/Meetings', 'Work/a.md']);
			});

			it('creates a folder idempotently', config, async () => {
				// A queued `mkdir` op has to be safe to replay.
				const provider = await open();
				const first = await provider.createFolder('Work');
				const again = await provider.createFolder('Work');
				expect(again.path).toBe(first.path);
			});

			it('lists an empty folder as empty', config, async () => {
				const provider = await open();
				await provider.createFolder('Empty');
				expect(await provider.list('Empty')).toEqual([]);
			});

			it('does not hide the marker file', config, async () => {
				// Providers never filter; the engine needs to see `.notesapp.json`,
				// and the UI filters with `isHidden`.
				const provider = await open();
				const entries = await provider.list('');
				expect(paths(entries)).toContain(MARKER_FILE);
				expect(isHidden(MARKER_FILE)).toBe(true);
			});

			it('reports a missing folder rather than an empty listing', config, async () => {
				const provider = await open();
				await expect(provider.list('Nowhere')).rejects.toThrow(NotFoundError);
			});
		});

		describe('move', () => {
			it('renames a file, keeping its content', config, async () => {
				const provider = await open();
				const entry = await seedFile(provider, 'old.md', 'body\n');

				const moved = await provider.move(entry, 'new.md');
				expect(moved.path).toBe('new.md');
				expect((await provider.read(moved)).content).toBe('body\n');
				expect(paths(await provider.list(''))).not.toContain('old.md');
				if (stableIds) expect(moved.remoteId).toBe(entry.remoteId);
			});

			it('returns an entry whose version is the one that reads back', config, async () => {
				// Dropbox keeps the `rev` across a move, OneDrive does not. Neither is
				// asserted — only that the returned entry is authoritative, so a caller
				// that stores it is correct on both.
				const provider = await open();
				const entry = await seedFile(provider, 'old.md');
				const moved = await provider.move(entry, 'new.md');
				expect((await provider.read(moved)).version).toBe(moved.version);
			});

			it('moves a file into another folder', config, async () => {
				const provider = await open();
				await provider.createFolder('Work');
				const entry = await seedFile(provider, 'loose.md');

				const moved = await provider.move(entry, 'Work/loose.md');
				expect(paths(await provider.list('Work'))).toContain('Work/loose.md');
				expect(paths(await provider.list(''))).not.toContain('loose.md');
				expect(moved.path).toBe('Work/loose.md');
			});

			it('moves a folder and rebases everything under it', config, async () => {
				const provider = await open();
				const folder = await provider.createFolder('Work');
				await provider.createFolder('Work/Meetings');
				const note = await seedFile(provider, 'Work/Meetings/b.md', 'deep\n');

				await provider.move(folder, 'Archive');

				expect(paths(await provider.list('Archive'))).toEqual(['Archive/Meetings']);
				expect(paths(await provider.list('Archive/Meetings'))).toEqual([
					'Archive/Meetings/b.md',
				]);
				if (stableIds) {
					const [moved] = await provider.list('Archive/Meetings');
					expect(moved?.remoteId).toBe(note.remoteId);
				}
			});

			it('refuses to move onto an occupied path', config, async () => {
				const provider = await open();
				const a = await seedFile(provider, 'a.md');
				await seedFile(provider, 'b.md');

				await expect(provider.move(a, 'b.md')).rejects.toThrow(ConflictError);
			});
		});

		describe('delete', () => {
			it('removes a file', config, async () => {
				const provider = await open();
				const entry = await seedFile(provider, 'note.md');

				await provider.delete(entry);
				expect(paths(await provider.list(''))).not.toContain('note.md');
				await expect(provider.read(entry)).rejects.toThrow(NotFoundError);
			});

			it('is idempotent', config, async () => {
				// A push queue that crashed mid-drain replays its ops.
				const provider = await open();
				const entry = await seedFile(provider, 'note.md');

				await provider.delete(entry);
				await expect(provider.delete(entry)).resolves.toBeUndefined();
			});

			it('removes a folder and everything under it', config, async () => {
				const provider = await open();
				const folder = await provider.createFolder('Work');
				await seedFile(provider, 'Work/a.md');

				await provider.delete(folder);
				expect(paths(await provider.list(''))).not.toContain('Work');
				await expect(provider.list('Work')).rejects.toThrow(NotFoundError);
			});
		});

		describe('changes', () => {
			it('reports current state on a cold start, with no deletions', config, async () => {
				const provider = await open();
				await provider.createFolder('Work');
				await seedFile(provider, 'Work/a.md');

				const { entries, cursor } = await drainChanges(provider);

				expect(paths(entries)).toEqual([MARKER_FILE, 'Work', 'Work/a.md']);
				expect(entries.some((entry) => entry.deleted === true)).toBe(false);
				expect(typeof cursor).toBe('string');
				expect(cursor).not.toBe('');
			});

			it('does not replay history a new device never saw', config, async () => {
				// A cold start is a scan of what is there now, not the log. A device
				// joining today must never be told about a note that was deleted
				// last week, or it would resurrect it.
				const provider = await open();
				const gone = await seedFile(provider, 'gone.md');
				await provider.delete(gone);
				await seedFile(provider, 'here.md');

				const { entries } = await drainChanges(provider);

				expect(paths(entries)).not.toContain('gone.md');
				expect(paths(entries)).toContain('here.md');
				expect(entries.some((entry) => entry.deleted === true)).toBe(false);
			});

			it('reports nothing when nothing has happened since', config, async () => {
				const provider = await open();
				const { cursor } = await drainChanges(provider);
				expect((await drainChanges(provider, cursor)).entries).toEqual([]);
			});

			it('survives being persisted and read back', config, async () => {
				// The cursor lives in IndexedDB between sessions.
				const provider = await open();
				const { cursor } = await drainChanges(provider);
				const revived = JSON.parse(JSON.stringify({ cursor })) as { cursor: string };

				await seedFile(provider, 'note.md');
				expect(paths((await drainChanges(provider, revived.cursor)).entries)).toContain(
					'note.md'
				);
			});

			it('reflects a write, a move and a delete in turn', config, async () => {
				const provider = await open();
				const start = await drainChanges(provider);

				const created = await seedFile(provider, 'note.md', 'one\n');
				const afterWrite = await drainChanges(provider, start.cursor);
				expect(at(afterWrite.entries, 'note.md')?.version).toBe(created.version);

				const moved = await provider.move(created, 'renamed.md');
				const afterMove = await drainChanges(provider, afterWrite.cursor);
				expect(at(afterMove.entries, 'renamed.md')).toBeDefined();

				await provider.delete(moved);
				const afterDelete = await drainChanges(provider, afterMove.cursor);
				const gone = at(afterDelete.entries, 'renamed.md');
				expect(gone?.deleted).toBe(true);
				if (stableIds) expect(gone?.remoteId).toBe(created.remoteId);
			});

			it('hands back entries that can be read directly', config, async () => {
				// Whatever `changes` yields has to be usable as an `EntryRef` without
				// a lookup, or every pull would cost an extra round trip.
				const provider = await open();
				await seedFile(provider, 'note.md', 'body\n');

				const { entries } = await drainChanges(provider);
				const note = at(entries, 'note.md')!;
				expect((await provider.read(note)).content).toBe('body\n');
			});

			it('rejects a cursor it cannot use', config, async () => {
				const provider = await open();
				await expect(provider.changes('not-a-cursor')).rejects.toThrow(CursorResetError);
			});
		});
	});
};
