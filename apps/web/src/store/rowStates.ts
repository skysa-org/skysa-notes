import { type NoteRecord } from './db.js';

/**
 * What state a row is in, asked by name rather than by its flag (#452). A note
 * deleted on this device stays as a row until the delete is sent: a tombstone,
 * which nothing but the sync and an undo should treat as a note.
 */

/** A note that is there to be shown and edited. `undefined`, which is no note, is not. */
export const isLive = (note: Pick<NoteRecord, 'deletedLocally'> | undefined): boolean =>
	note?.deletedLocally === 0;

/** A note deleted on this device, kept until the delete is sent. `undefined` is not one. */
export const isTombstone = (note: Pick<NoteRecord, 'deletedLocally'> | undefined): boolean =>
	note?.deletedLocally === 1;

/**
 * A source that syncs: not one detached, which is kept only for what it never
 * sent (`SyncStateRecord.detached`).
 */
export const isLiveSource = (source: Readonly<{ detached?: unknown }>): boolean =>
	source.detached === undefined;
