import { basename, drawsFromData, safeOpenType } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef } from 'react';

import type { AttachmentHost, Shown } from '../editor/attachHost.js';
import { createObjectUrlCache, type ObjectUrlCache } from '../editor/objectUrls.js';
import { db as appDb, type NoteRecord, type NotesDatabase } from '../store/db.js';
import { heldFile } from '../store/fileCache.js';
import { fileForLink, listFilePaths } from '../store/files.js';
import type { FileRead } from '../sync/fileReads.js';
import { syncScheduler } from '../sync/runtime.js';

/**
 * The files beside one open note, for its editor (#187): `AttachmentHost`,
 * answered from the note as it is now, the device's store and the sync
 * scheduler.
 *
 * A link is resolved from where the note is at the moment it is asked, so a
 * note moved or renamed while open shows its pictures from its new folder. A
 * picture's bytes become a URL once, shared by every view of it and let go of
 * when none shows it (`editor/objectUrls.ts`); an SVG is drawn from a `data:`
 * URL instead, never a `blob:` one (`drawsFromData` says why).
 */

/**
 * A picture larger than this is downloaded only when asked to: one held on the
 * device is shown whatever its size, and one over this on a phone's data plan
 * is the user's call. Most photos a phone takes are well under it.
 */
export const LARGE_PICTURE_BYTES = 8 * 1024 * 1024;

export interface NoteAttachmentsOptions {
	db: NotesDatabase;
	/** The note as it is now: where it is, in which source. */
	note: () => Pick<NoteRecord, 'connectionId' | 'path'>;
	readFile: (connectionId: string, fileId: string, signal?: AbortSignal) => Promise<FileRead>;
	urls?: ObjectUrlCache;
	now?: () => number;
}

export interface NoteAttachments extends AttachmentHost {
	/** Tell every view that what links resolve to may have changed. */
	readonly notify: () => void;
	/** Let go of every URL made for this note. */
	readonly dispose: () => void;
}

/** What a read that did not end in bytes is to a picture. */
const SHOWN: Readonly<Record<Exclude<FileRead['state'], 'ready'>, Shown>> = {
	gone: { state: 'missing' },
	offline: { state: 'offline' },
	unavailable: { state: 'unavailable' },
	failed: { state: 'failed' },
	aborted: { state: 'aborted' },
};

const dataUrl = (blob: Blob): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener('load', () => {
			const { result } = reader;
			if (typeof result === 'string') resolve(result);
			else reject(new Error('The picture could not be read'));
		});
		reader.addEventListener('error', () => {
			reject(reader.error ?? new Error('The picture could not be read'));
		});
		reader.readAsDataURL(blob);
	});

export const createNoteAttachments = ({
	db,
	note,
	readFile,
	urls = createObjectUrlCache(),
	now = Date.now,
}: NoteAttachmentsOptions): NoteAttachments => {
	const listeners = new Set<() => void>();

	/**
	 * The bytes of a file, from the device where they are, and otherwise as
	 * asked; or what to show instead.
	 */
	const bytesOf = async (
		connectionId: string,
		file: { id: string; size: number },
		signal: AbortSignal,
		large: boolean
	): Promise<{ bytes: ArrayBuffer } | Shown> => {
		const held = await heldFile(db, connectionId, file.id, now());
		if (held?.bytes !== undefined) return { bytes: held.bytes };
		if (!large && file.size > LARGE_PICTURE_BYTES) return { state: 'large', size: file.size };
		const read = await readFile(connectionId, file.id, signal);
		return read.state === 'ready' ? { bytes: read.bytes } : SHOWN[read.state];
	};

	return {
		show: async (href, { signal, large = false }) => {
			const { connectionId, path } = note();
			const file = await fileForLink(db, { connectionId, notePath: path, href });
			if (file === undefined) return { state: 'missing' };
			const name = basename(file.path);
			const svg = drawsFromData(name);
			// The bytes, not only the file: a version the remote has moved on to
			// is another picture, under another URL.
			const key = [connectionId, file.id, file.remoteVersion ?? 'held'].join('\u0000');
			const reused = svg ? undefined : urls.reuse(key);
			if (reused !== undefined) return { state: 'ready', ...reused };
			const read = await bytesOf(connectionId, file, signal, large);
			if ('state' in read) return read;
			const blob = new Blob([read.bytes], {
				type: svg ? 'image/svg+xml' : safeOpenType(name),
			});
			if (svg) return { state: 'ready', url: await dataUrl(blob), release: () => undefined };
			return { state: 'ready', ...urls.acquire(key, () => blob) };
		},

		changed: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		notify: () => {
			listeners.forEach((listener) => {
				listener();
			});
		},

		dispose: () => {
			urls.clear();
		},
	};
};

/**
 * The host for the note open now, one per note: the same note moved, renamed
 * or bound to a source keeps it, and its views are told to look again
 * (`notify`) rather than rebuilt. Told as well when the source's files change —
 * a picture that was missing may have arrived with a pull — and when the
 * network comes back.
 */
export const useNoteAttachments = (
	note: NoteRecord,
	readFile: NoteAttachmentsOptions['readFile'] = syncScheduler.readFile,
	db: NotesDatabase = appDb
): NoteAttachments => {
	const current = useRef<Pick<NoteRecord, 'connectionId' | 'path'>>(note);
	useEffect(() => {
		current.current = note;
	}, [note]);
	const read = useRef(readFile);
	useEffect(() => {
		read.current = readFile;
	}, [readFile]);

	const host = useMemo(
		() =>
			createNoteAttachments({
				db,
				note: () => current.current,
				readFile: (...args) => read.current(...args),
			}),
		// One per note, whatever else of it changes.
		[note.id, db]
	);
	useEffect(
		() => () => {
			host.dispose();
		},
		[host]
	);

	const files = useLiveQuery(
		async () => (await listFilePaths(db, { connectionId: note.connectionId })).join('\n'),
		[db, note.connectionId]
	);
	useEffect(() => {
		host.notify();
	}, [host, note.connectionId, note.path, files]);

	useEffect(() => {
		const online = () => {
			host.notify();
		};
		window.addEventListener('online', online);
		return () => {
			window.removeEventListener('online', online);
		};
	}, [host]);

	return host;
};
