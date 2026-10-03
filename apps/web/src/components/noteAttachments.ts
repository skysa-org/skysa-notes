import { basename, drawsFromData, safeOpenType, showsInline } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef } from 'react';

import { closedProblem } from '../editor/addFiles.js';
import type {
	Added,
	AttachmentHost,
	AttachmentProblem,
	Fetched,
	FileReceiver,
	Shown,
} from '../editor/attachHost.js';
import { createObjectUrlCache, type ObjectUrlCache } from '../editor/objectUrls.js';
import { pickFiles } from '../editor/pickFiles.js';
import { db as appDb, type NoteRecord, type NotesDatabase } from '../store/db.js';
import { heldFile } from '../store/fileCache.js';
import {
	addAttachment,
	attachmentRefusal,
	AttachmentRefusedError,
	fileForLink,
	listFilePaths,
} from '../store/files.js';
import type { FileRead } from '../sync/fileReads.js';
import { syncScheduler } from '../sync/runtime.js';
import type { SyncScheduler } from '../sync/scheduler.js';

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
	/** The note as it is now: which it is, where it is, in which source. */
	note: () => Pick<NoteRecord, 'connectionId' | 'id' | 'path'>;
	readFile: (connectionId: string, fileId: string, signal?: AbortSignal) => Promise<FileRead>;
	/** Where a problem the editor has nowhere to show goes: a toast. */
	report?: (problem: AttachmentProblem) => void;
	/**
	 * Store the note, where it is a draft stored nowhere yet (`NoteDraft.store`):
	 * a file added to it is an edit, and goes beside a note that is there.
	 * Resolves to whether it is stored.
	 */
	store?: () => Promise<boolean>;
	urls?: ObjectUrlCache;
	now?: () => number;
}

export interface NoteAttachments extends AttachmentHost {
	/**
	 * Ask the user for files, and put them in the editor open now, where its
	 * selection is (`receive`). From inside the press that asked for it: the
	 * browser opens its picker only then (`pickFiles`).
	 */
	readonly pick: () => void;
	/** Tell every view that what links resolve to may have changed. */
	readonly notify: () => void;
	/** Let go of every URL made for this note. */
	readonly dispose: () => void;
}

/** What a read that did not end in bytes is, to a file asked for whole. */
const FETCHED: Readonly<Record<Exclude<FileRead['state'], 'ready'>, Fetched>> = {
	gone: { state: 'missing' },
	offline: { state: 'offline' },
	unavailable: { state: 'unavailable' },
	failed: { state: 'failed' },
	aborted: { state: 'aborted' },
};

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
	report = () => undefined,
	store = () => Promise.resolve(true),
	urls = createObjectUrlCache(),
	now = Date.now,
}: NoteAttachmentsOptions): NoteAttachments => {
	const listeners = new Set<() => void>();
	// Every editor that has offered itself and not gone, in the order they
	// offered. The last is the one open now. More than one only while one
	// editor is giving way to another, and that can go either way round: the
	// new one can be built before the old one has gone, and a rich editor
	// still being built when it is let go of is built — and offers itself —
	// before it goes.
	const receivers = new Set<FileReceiver>();

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

	/**
	 * A file asked for whole, to open or save: `readFile` answers from the
	 * device where it can, and nothing waits on a size, since the user asked.
	 */
	const fetchFile = async (href: string, signal?: AbortSignal): Promise<Fetched> => {
		const { connectionId, path } = note();
		const file = await fileForLink(db, { connectionId, notePath: path, href });
		if (file === undefined) return { state: 'missing' };
		const read = await readFile(connectionId, file.id, signal);
		if (read.state !== 'ready') return FETCHED[read.state];
		const name = basename(file.path);
		return { state: 'ready', file: new File([read.bytes], name, { type: safeOpenType(name) }) };
	};

	/**
	 * A file the user has put in the note, beside it. One that is refused is
	 * refused before its bytes are read, which for a film could be more than
	 * the page can hold.
	 *
	 * A draft is stored only once nothing is left to refuse the file or fail to
	 * read it: a draft stored for a file that never went in would be an empty
	 * note in the user's folder. And the note is the one open when the file was
	 * put in, read before anything is awaited — the host's note follows the one
	 * open now, which may be another by the time the draft is stored.
	 */
	const add = async (file: File, pasted: boolean): Promise<Added> => {
		const refused = attachmentRefusal(file);
		if (refused !== undefined) return { state: 'refused', reason: refused };
		const { connectionId, id } = note();
		try {
			const bytes = await file.arrayBuffer();
			if (!(await store())) return { state: 'failed' };
			const added = await addAttachment(db, {
				connectionId,
				noteId: id,
				name: file.name,
				bytes,
				type: file.type,
				pasted,
			});
			return { state: 'added', ...added };
		} catch (error) {
			if (error instanceof AttachmentRefusedError) {
				return { state: 'refused', reason: error.reason };
			}
			return { state: 'failed' };
		}
	};

	return {
		show: async (href, { signal, large = false }) => {
			const { connectionId, path } = note();
			const file = await fileForLink(db, { connectionId, notePath: path, href });
			if (file === undefined) return { state: 'missing' };
			const name = basename(file.path);
			if (!showsInline(name)) return { state: 'unsupported' };
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

		fetchFile: (href, signal) =>
			fetchFile(href, signal).catch((): Fetched => ({ state: 'failed' })),

		report,

		add: (file, { pasted }) => add(file, pasted),

		receive: (receiver) => {
			receivers.add(receiver);
			return () => {
				receivers.delete(receiver);
			};
		},

		pick: () => {
			void pickFiles().then((files) => {
				if (files.length === 0) return;
				// The editor open when they were chosen, which is the one the
				// user is looking at; none, where the note has gone meanwhile.
				const into = [...receivers].at(-1);
				if (into === undefined) report(closedProblem(files.map((file) => file.name)));
				else into(files);
			});
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

export interface NoteAttachmentsSources {
	readonly readFile?: NoteAttachmentsOptions['readFile'];
	readonly db?: NotesDatabase;
	/** Where to hear that a sync has run: the scheduler's status. */
	readonly subscribe?: SyncScheduler['subscribe'];
	/** Where a problem the editor has nowhere to show goes (`NoteViewProps.onProblem`). */
	readonly report?: (problem: AttachmentProblem) => void;
	/** Store the note first, while it is a draft (`NoteViewProps.draft`). */
	readonly store?: (() => Promise<boolean>) | undefined;
}

/**
 * The host for the note open now, one per note: the same note moved, renamed
 * or bound to a source keeps it, and its views are told to look again
 * (`notify`) rather than rebuilt. Told as well when the source's files change —
 * a picture that was missing may have arrived with a pull — when the network
 * comes back, and when a sync has run to the end of a pull: a source that
 * could not be read from, its token refused or its account reconnected, can
 * be now.
 */
export const useNoteAttachments = (
	note: NoteRecord,
	{
		readFile = syncScheduler.readFile,
		db = appDb,
		subscribe = syncScheduler.subscribe,
		report,
		store,
	}: NoteAttachmentsSources = {}
): NoteAttachments => {
	const current = useRef<Pick<NoteRecord, 'connectionId' | 'id' | 'path'>>(note);
	useEffect(() => {
		current.current = note;
	}, [note]);
	const read = useRef(readFile);
	useEffect(() => {
		read.current = readFile;
	}, [readFile]);
	const told = useRef(report);
	useEffect(() => {
		told.current = report;
	}, [report]);
	const storing = useRef(store);
	useEffect(() => {
		storing.current = store;
	}, [store]);

	const host = useMemo(
		() =>
			createNoteAttachments({
				db,
				note: () => current.current,
				readFile: (...args) => read.current(...args),
				report: (problem) => {
					told.current?.(problem);
				},
				store: () => storing.current?.() ?? Promise.resolve(true),
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

	useEffect(() => {
		const synced: { current?: number } = {};
		return subscribe(({ lastSyncAt }) => {
			if (lastSyncAt === synced.current) return;
			synced.current = lastSyncAt;
			host.notify();
		});
	}, [host, subscribe]);

	return host;
};
