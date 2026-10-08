import {
	basename,
	drawsFromData,
	imageInfo,
	type PictureInfo,
	type PictureVariant,
	pictureVariant,
	safeOpenType,
	showsInline,
} from '@skysa/core';
import { useEffect, useMemo, useRef } from 'react';

import { closedProblem } from '../editor/addFiles.js';
import type {
	Added,
	AttachmentHost,
	AttachmentProblem,
	Fetched,
	FileReceiver,
	PictureSize,
	Shown,
	ShowOptions,
} from '../editor/attachHost.js';
import { createObjectUrlCache, type HeldUrl, type ObjectUrlCache } from '../editor/objectUrls.js';
import { pickFiles } from '../editor/pickFiles.js';
import { copyTurns, nearestCopy } from '../pictures/copies.js';
import { noShrinker, type PictureShrinker, pictureShrinker } from '../pictures/shrinker.js';
import {
	db as appDb,
	type FileRecord,
	type NoteRecord,
	type NotesDatabase,
	type PictureRecord,
} from '../store/db.js';
import { heldFile, holdsBytes } from '../store/fileCache.js';
import {
	addAttachment,
	attachmentRefusal,
	AttachmentRefusedError,
	fileForLink,
} from '../store/files.js';
import { heldCopy, heldPicture, keepPicture, type MadeCopy } from '../store/pictures.js';
import { watchSourceFiles } from '../store/sourceFiles.js';
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
 * The URLs of every picture shown, app-wide (#276): the open note's editor and
 * each scratch card drawing the same picture draw it from one URL, made from
 * one copy of its bytes. Each host made its own, so a card open over its note
 * held the picture twice, two blobs and two decodes. A view lets go of what it
 * was given (`Shown.release`), and a host going away lets go of what it gave
 * out (`dispose`); a URL nothing holds is revoked after the cache's grace.
 */
export const pictureUrls: ObjectUrlCache = createObjectUrlCache();

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
	/** A file was put in the note, at `path` from the root of its source. */
	onAdded?: (path: string) => void;
	urls?: ObjectUrlCache;
	/** What smaller copies of pictures are made with (#276): the app's, unless given another. */
	shrinker?: PictureShrinker;
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
	/** Let go of every URL this host handed out and was not given back. */
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
const SHOWN: Readonly<
	Record<Exclude<FileRead['state'], 'ready'>, Exclude<Shown, { state: 'ready' }>>
> = {
	gone: { state: 'missing' },
	offline: { state: 'offline' },
	unavailable: { state: 'unavailable' },
	failed: { state: 'failed' },
	aborted: { state: 'aborted' },
};

/**
 * What a picture is drawn from, as making its copy came to: the key its URL
 * is kept under, the bytes to make one of where there is none yet, and the
 * picture's own size, where its header gave one.
 */
interface Drawable {
	readonly key: string;
	readonly blob: () => Blob;
	readonly size: PictureSize | undefined;
}

type Made = Drawable | Exclude<Shown, { state: 'ready' }>;

/**
 * Where the original cannot be had now, a copy of another size is shown in
 * place of the one wanted, rather than nothing. Not where the file is gone:
 * the link is to nothing, whatever the device still holds.
 */
const STANDS_IN: ReadonlySet<Shown['state']> = new Set([
	'large',
	'offline',
	'unavailable',
	'failed',
]);

/** Never stopped: work at its turn is finished for whoever is still waiting (`oneAtATime`). */
const UNSTOPPED = new AbortController().signal;

const sizeOf = ({ width, height }: PictureInfo): PictureSize => ({ width, height });

/** The key a picture's URL is kept under: its file, the bytes it is bound to, and which copy. */
const urlKey = (connectionId: string, file: FileRecord, variant?: PictureVariant): string =>
	[
		connectionId,
		file.id,
		file.remoteVersion ?? 'held',
		...(variant === undefined ? [] : [variant]),
	].join('\u0000');

/**
 * A picture drawn as it is, from its bytes. Made here, apart from anything
 * else a function holds: a closure made beside another shares what either
 * holds, and a copy's would keep the original it was made from.
 */
const asItIs = (
	key: string,
	bytes: ArrayBuffer,
	type: string,
	size: PictureSize | undefined
): Drawable => ({ key, blob: () => new Blob([bytes], { type }), size });

/** A picture drawn from a copy made of it, holding nothing but the copy (`asItIs`). */
const fromCopy = (key: string, copy: Blob, size: PictureSize): Drawable => ({
	key,
	blob: () => copy,
	size,
});

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
	onAdded = () => undefined,
	urls = pictureUrls,
	shrinker = pictureShrinker(),
	now = Date.now,
}: NoteAttachmentsOptions): NoteAttachments => {
	const listeners = new Set<() => void>();
	const turns = copyTurns<Made>(shrinker);
	// What this host has handed out and not been given back, let go of with it.
	const handedOut = new Set<HeldUrl>();
	const handOut = (held: HeldUrl, size?: PictureSize): Shown => {
		handedOut.add(held);
		return {
			state: 'ready',
			url: held.url,
			release: () => {
				handedOut.delete(held);
				held.release();
			},
			...size,
		};
	};
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
	): Promise<{ bytes: ArrayBuffer } | Exclude<Shown, { state: 'ready' }>> => {
		const held = await heldFile(db, connectionId, file.id, now());
		if (held?.bytes !== undefined) return { bytes: held.bytes };
		if (!large && file.size > LARGE_PICTURE_BYTES) return { state: 'large', size: file.size };
		const read = await readFile(connectionId, file.id, signal);
		return read.state === 'ready' ? { bytes: read.bytes } : SHOWN[read.state];
	};

	/** A copy this device holds, drawn from the URL there is for it or one made of its bytes. */
	const copyShown = async (
		connectionId: string,
		file: FileRecord,
		variant: PictureVariant,
		size: PictureSize
	): Promise<Shown | undefined> => {
		const key = urlKey(connectionId, file, variant);
		const reused = urls.reuse(key);
		if (reused !== undefined) return handOut(reused, size);
		const held = await heldCopy(db, connectionId, file.id, variant, now());
		if (held === undefined) return undefined;
		return handOut(
			urls.acquire(key, () => new Blob([held.bytes], { type: held.type })),
			size
		);
	};

	/** What stands in for a picture whose original cannot be had now: any copy held (`nearestCopy`). */
	const standIn = async (
		connectionId: string,
		file: FileRecord,
		known: PictureRecord | undefined,
		fit: NonNullable<ShowOptions['fit']>
	): Promise<Shown | undefined> => {
		if (known?.info === undefined || known.info === null) return undefined;
		const variant = nearestCopy(
			known.copies,
			pictureVariant(known.info, fit)?.width ?? Number.POSITIVE_INFINITY
		);
		return variant === undefined
			? undefined
			: copyShown(connectionId, file, variant, sizeOf(known.info));
	};

	/**
	 * The picture as it is, from one URL for every view of it. An SVG is
	 * drawn from a `data:` URL instead (`drawsFromData`). Where it cannot be
	 * had now, and a view said what it fits, a copy held stands in for it.
	 */
	const original = async (
		connectionId: string,
		file: FileRecord,
		name: string,
		{ signal, large = false, fit }: ShowOptions,
		known?: PictureRecord
	): Promise<Shown> => {
		const size =
			known?.info === undefined || known.info === null ? undefined : sizeOf(known.info);
		const svg = drawsFromData(name);
		// The bytes, not only the file: a version the remote has moved on to
		// is another picture, under another URL.
		const key = urlKey(connectionId, file);
		const reused = svg ? undefined : urls.reuse(key);
		if (reused !== undefined) return handOut(reused, size);
		const read = await bytesOf(connectionId, file, signal, large);
		if ('state' in read) {
			const stands =
				fit !== undefined && STANDS_IN.has(read.state)
					? await standIn(connectionId, file, known, fit)
					: undefined;
			return stands ?? read;
		}
		const blob = new Blob([read.bytes], {
			type: svg ? 'image/svg+xml' : safeOpenType(name),
		});
		if (svg) return { state: 'ready', url: await dataUrl(blob), release: () => undefined };
		return handOut(
			urls.acquire(key, () => blob),
			size ?? (fit === undefined ? undefined : await learn(file, known, read.bytes))
		);
	};

	/**
	 * What the header of a picture shown as it is says, kept the first time
	 * it is read, so its box is held at its size the next time it is shown
	 * (`size`), even where no copy is ever made of it.
	 */
	const learn = async (
		file: FileRecord,
		known: PictureRecord | undefined,
		bytes: ArrayBuffer
	): Promise<PictureSize | undefined> => {
		if (known !== undefined) return undefined;
		const info = imageInfo(new Uint8Array(bytes)) ?? null;
		await keep(file, { info });
		return info === null ? undefined : sizeOf(info);
	};

	/** Keep what was read of a picture, where it can be: a copy not kept is still shown. */
	const keep = (
		file: FileRecord,
		read: Readonly<{ info: PictureInfo | null; copy?: MadeCopy; refused?: boolean }>
	): Promise<boolean> => keepPicture(db, file, read, now()).catch(() => false);

	/** The copy of `file` this device holds for `fit`, where it holds one now. */
	const heldFor = async (
		connectionId: string,
		file: FileRecord,
		known: PictureRecord | undefined,
		fit: NonNullable<ShowOptions['fit']>
	): Promise<Drawable | undefined> => {
		if (known?.info === undefined || known.info === null) return undefined;
		const wanted = pictureVariant(known.info, fit);
		if (wanted === undefined) return undefined;
		const held = await heldCopy(db, connectionId, file.id, wanted.variant, now());
		return held === undefined
			? undefined
			: {
					key: urlKey(connectionId, file, wanted.variant),
					blob: () => new Blob([held.bytes], { type: held.type }),
					size: sizeOf(known.info),
				};
	};

	/**
	 * At its turn: the copy of `file` that fits `fit`, made from the
	 * original's bytes and kept; or the original, where no copy is worth
	 * having or none could be made this time; or why neither can be had.
	 * Another view may have made the copy while this one waited.
	 */
	const makeCopy = async (
		connectionId: string,
		file: FileRecord,
		name: string,
		fit: NonNullable<ShowOptions['fit']>,
		large: boolean
	): Promise<Made> => {
		const known = await heldPicture(db, connectionId, file.id);
		const madeMeanwhile = await heldFor(connectionId, file, known, fit);
		if (madeMeanwhile !== undefined) return madeMeanwhile;
		const read = await bytesOf(connectionId, file, UNSTOPPED, large);
		if ('state' in read) return read;
		const type = safeOpenType(name);
		const info =
			known === undefined ? (imageInfo(new Uint8Array(read.bytes)) ?? null) : known.info;
		const shownAsItIs = () =>
			asItIs(
				urlKey(connectionId, file),
				read.bytes,
				type,
				info === null ? undefined : sizeOf(info)
			);
		const wanted =
			info === null || known?.refused === true ? undefined : pictureVariant(info, fit);
		if (info === null || wanted === undefined) {
			if (known === undefined) await keep(file, { info });
			return shownAsItIs();
		}
		const shrunk = await shrinker.shrink(new Blob([read.bytes], { type }), {
			width: wanted.width,
			alpha: info.alpha,
		});
		if (shrunk.kind === 'made') {
			await keep(file, {
				info,
				copy: {
					variant: wanted.variant,
					bytes: await shrunk.copy.arrayBuffer(),
					type: shrunk.copy.type,
					width: shrunk.width,
					height: shrunk.height,
				},
			});
			return fromCopy(urlKey(connectionId, file, wanted.variant), shrunk.copy, sizeOf(info));
		}
		// One the browser could not draw is not asked of it again, until its
		// file is other bytes; one missed is, next time it is shown.
		await keep(file, shrunk.kind === 'refused' ? { info, refused: true } : { info });
		return shownAsItIs();
	};

	/**
	 * A picture where a view has said how large it draws it (`fit`): from the
	 * copy this device holds for that, made at its turn where there is none,
	 * and else as it is.
	 */
	const fitted = async (
		connectionId: string,
		file: FileRecord,
		name: string,
		options: ShowOptions & { fit: NonNullable<ShowOptions['fit']> }
	): Promise<Shown> => {
		const { signal, large = false, fit } = options;
		const known = await heldPicture(db, connectionId, file.id);
		// Where the browser cannot make copies, nothing waits a turn for one.
		if (shrinker === noShrinker) return original(connectionId, file, name, options, known);
		if (known !== undefined) {
			if (known.info === null || known.refused === true) {
				return original(connectionId, file, name, options, known);
			}
			const wanted = pictureVariant(known.info, fit);
			if (wanted === undefined) return original(connectionId, file, name, options, known);
			const held = await copyShown(connectionId, file, wanted.variant, sizeOf(known.info));
			if (held !== undefined) return held;
		}
		// Too large to download unasked, and not on this device: said at once,
		// not at a turn behind every copy asked for before it.
		if (!large && file.size > LARGE_PICTURE_BYTES && !(await holdsBytes(db, file))) {
			const said: Shown = { state: 'large', size: file.size };
			return (await standIn(connectionId, file, known, fit)) ?? said;
		}
		const made = await turns(
			[
				urlKey(connectionId, file),
				fit === 'thumb' ? fit : String(fit.width),
				String(large),
			].join('\u0000'),
			signal,
			() => makeCopy(connectionId, file, name, fit, large)
		);
		if (made === undefined) return { state: 'aborted' };
		if ('key' in made) return handOut(urls.acquire(made.key, made.blob), made.size);
		const stands = STANDS_IN.has(made.state)
			? await standIn(connectionId, file, known, fit)
			: undefined;
		return stands ?? made;
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
			onAdded(added.path);
			return { state: 'added', ...added };
		} catch (error) {
			if (error instanceof AttachmentRefusedError) {
				return { state: 'refused', reason: error.reason };
			}
			return { state: 'failed' };
		}
	};

	return {
		show: async (href, options) => {
			const { connectionId, path } = note();
			const file = await fileForLink(db, { connectionId, notePath: path, href });
			if (file === undefined) return { state: 'missing' };
			const name = basename(file.path);
			if (!showsInline(name)) return { state: 'unsupported' };
			const { fit } = options;
			// An SVG is drawn at any size from what it is.
			return fit === undefined || drawsFromData(name)
				? original(connectionId, file, name, options)
				: fitted(connectionId, file, name, { ...options, fit });
		},

		size: async (href) => {
			const { connectionId, path } = note();
			try {
				const file = await fileForLink(db, { connectionId, notePath: path, href });
				if (file === undefined) return undefined;
				const known = await heldPicture(db, connectionId, file.id);
				return known?.info === undefined || known.info === null
					? undefined
					: sizeOf(known.info);
			} catch {
				return undefined;
			}
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
			handedOut.forEach((held) => {
				held.release();
			});
			handedOut.clear();
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
	/** Hears of each file put in the note (`NoteAttachmentsOptions.onAdded`). */
	readonly onAdded?: ((path: string) => void) | undefined;
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
		onAdded,
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
	const adding = useRef(onAdded);
	useEffect(() => {
		adding.current = onAdded;
	}, [onAdded]);

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
				onAdded: (path) => {
					adding.current?.(path);
				},
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

	useEffect(() => {
		host.notify();
	}, [host, note.connectionId, note.path]);
	useEffect(
		() =>
			watchSourceFiles(db, note.connectionId, () => {
				host.notify();
			}),
		[host, db, note.connectionId]
	);

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
