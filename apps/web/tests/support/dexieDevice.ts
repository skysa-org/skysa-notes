import type { AppSchedulerOptions, ClientDevice } from '@skysa/client/testing';
import { NOTE_FORMAT, syncsHidden } from '@skysa/core';

import { bindConnection, detachConnection, showConnection } from '../../src/store/connection.js';
import type { NoteRecord } from '../../src/store/db.js';
import { addAttachment } from '../../src/store/files.js';
import { createNote, noteFileContents, saveNoteBody } from '../../src/store/notes.js';
import { clientStoreOf } from '../../src/sync/dexiePorts.js';
import { SYNC_LOCK } from '../../src/sync/lock.js';
import { createNotesSync } from '../../src/sync/notesSync.js';
import { lazily } from '../noteRows.js';
import { holdCredential } from './connection.js';
import { watchedDatabase } from './db.js';
import { holding, otherTab } from './otherTab.js';

/**
 * A note as another device of this app has it, but for its id and body: named,
 * so its title is written, and at fixed times, so its file is the same each
 * time it is written.
 */
const ELSEWHERE: Omit<NoteRecord, 'id' | 'body'> = {
	connectionId: 'elsewhere',
	path: 'Elsewhere.md',
	title: 'Elsewhere',
	frontmatter: null,
	tags: [],
	contentHash: '',
	dirty: 0,
	deletedLocally: 0,
	createdAt: 0,
	updatedAt: 0,
};

/** What this app hands its scheduler of its own. */
const APP: AppSchedulerOptions = { lockName: SYNC_LOCK, document: NOTE_FORMAT, syncsHidden };

/**
 * A device over this app's database, fresh for each call: the client's
 * suites (`ClientDevice`, `@skysa/client/testing`) run over it as the app runs
 * them, through the ports in `sync/dexiePorts.ts`. Its scheduler is the app's, with the
 * clipboard, the key file and the files beside notes attached; a document is
 * a note, made and saved as the editor makes and saves one; an op is queued
 * as a row of the queue, the shape every writer in `store/` leaves. The
 * database is watched, as the app's is, so a suite can see what a tab waits on.
 */
export const dexieDevice = (): ClientDevice => {
	const db = watchedDatabase();
	return {
		store: clientStoreOf(db),
		app: APP,
		schedule: (options) => createNotesSync({ ...APP, ...options, db }),
		// A note's file as another device writes one (`noteFileContents`): its id,
		// title and times in the frontmatter. Without an id it is no note of this
		// app's own making, and the body stands as it is, as a file put in the
		// folder by hand does.
		written: (body, id) =>
			id === undefined ? body : noteFileContents({ ...ELSEWHERE, id, body }),
		create: async (connectionId, name, body) => {
			const note = await createNote(db, { connectionId, title: name, body });
			return { id: note.id, path: note.path };
		},
		edit: async (connectionId, id, body, { lazy = false } = {}) => {
			// This app queues no write lazily; memoriam's way of doing it stands in.
			if (lazy) await lazily(db, id, body);
			else await saveNoteBody(db, id, body, undefined, { connectionId });
		},
		attach: async (connectionId, documentId, name, bytes) => {
			await addAttachment(db, {
				connectionId,
				noteId: documentId,
				name,
				bytes: bytes.buffer,
			});
		},
		queued: async (connectionId) =>
			(await db.opQueue.where('connectionId').equals(connectionId).sortBy('seq')).map(
				(op) => ({
					seq: op.seq ?? 0,
					lazy: op.lazy === true,
				})
			),
		lastSyncAt: async (connectionId) => (await db.syncState.get(connectionId))?.lastSyncAt,
		bind: async (connectionId, credential) => {
			await bindConnection(db, { connectionId, provider: 'dropbox' });
			await holdCredential(db, connectionId, credential === undefined ? {} : { credential });
		},
		show: async (connectionId) => {
			await showConnection(db, connectionId);
		},
		queue: (connectionId, op, { lazy = false } = {}) =>
			db.opQueue.add({
				...op,
				connectionId,
				attempts: 0,
				queuedAt: 0,
				...(lazy ? { lazy: true as const } : {}),
			}),
		keptToken: async (connectionId) => {
			const state = await db.syncState.get(connectionId);
			return state?.accessToken === undefined || state.accessTokenExpiresAt === undefined
				? undefined
				: { accessToken: state.accessToken, expiresAt: state.accessTokenExpiresAt };
		},
		keepElsewhere: async (connectionId, token) => {
			await db.syncState.update(connectionId, {
				accessToken: token.accessToken,
				accessTokenExpiresAt: token.expiresAt,
			});
		},
		letGo: async (connectionId, { unsent = false } = {}) => {
			// What keeps a source detached rather than forgotten is a note it never
			// sent: one is made here unless the test has queued something already.
			const queued = await db.opQueue.where('connectionId').equals(connectionId).count();
			if (unsent && queued === 0) await createNote(db, { connectionId, title: 'Unsent' });
			await detachConnection(db, { connectionId });
		},
		reconnect: (connectionId) =>
			// One transaction, which a live query may never show the middle of.
			db.transaction('rw', db.tables, async () => {
				await detachConnection(db, { connectionId });
				await bindConnection(db, { connectionId, provider: 'dropbox' });
				await holdCredential(db, connectionId);
			}),
		connection: async (connectionId) => {
			const state = await db.syncState.get(connectionId);
			if (state === undefined) return undefined;
			if (state.detached !== undefined) return 'detached';
			return state.resumeUnverified === true ? 'resumed' : 'live';
		},
		importing: async (connectionId) =>
			(await db.syncState.get(connectionId))?.importing !== undefined,
		holdUp: async () => {
			const other = await otherTab(db);
			return holding(other, [...other.objectStoreNames], 'readwrite');
		},
		dropCredential: async (connectionId) => {
			await db.credentials.delete(connectionId);
		},
	};
};
