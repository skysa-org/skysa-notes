import type { SyncNote } from '../../../src/sync/store.js';
import type { MemoryStore } from '../memoryStore.js';

/**
 * What the web app's `store/queue.ts` leaves in the store when the user acts,
 * at its simplest: the row changed and the op queued. `overProviders.test.ts`
 * models more of it — moves folded into one, notebooks made on the way —
 * for devices left to act at random.
 */

/** The user's edit. */
export const editHere = (store: MemoryStore, note: SyncNote, content: string): void => {
	store.put({ ...note, content, dirty: true });
	store.queue({ op: 'write', noteId: note.id, path: note.path });
};

/** The user's rename of a note that has a file. */
export const renameHere = (store: MemoryStore, note: SyncNote, to: string): void => {
	store.put({ ...note, path: to });
	store.queue({ op: 'move', noteId: note.id, path: note.path, targetPath: to });
};
