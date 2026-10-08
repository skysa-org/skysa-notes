import {
	bytesHash,
	CLIPBOARD_ITEMS,
	clipName,
	clipStamp,
	MAX_ATTACHMENT_BYTES,
	readClipName,
} from '@skysa/core';

import { t } from '../i18n/t.js';
import {
	type ClipRecord,
	type ClipThumbRecord,
	type NotesDatabase,
	type SyncStateRecord,
} from './db.js';
import { updateLive } from './detached.js';

/**
 * A source's clipboard on this device (docs/ARCHITECTURE.md §7, "The
 * clipboard"): what is pasted goes in at once, as a pending row holding its
 * bytes, and `sync/clipboard.ts` sends it when it can. Every rule about which
 * items stay is applied here, as the user pastes, so the list on screen is the
 * one the remote is about to have: an item pasted again moves to the top, and
 * past `CLIPBOARD_ITEMS` the oldest go.
 */

/** What a paste brings: text, or a file's bytes and what it was called. */
export type ClipInput =
	| Readonly<{ kind: 'text'; text: string }>
	| Readonly<{
			kind: 'file';
			name: string;
			type: string;
			bytes: ArrayBuffer;
			/** From the clipboard rather than a file the user chose: a picture's own name says nothing. */
			pasted?: boolean;
	  }>;

export interface AddedClips {
	/** The names the items were given, in the order they came. */
	readonly added: readonly string[];
	/** What was refused as larger than an item may be, by what it was called. */
	readonly tooLarge: readonly string[];
}

/** How much of a text the list shows, kept on the row so that showing it reads no bytes. */
export const PREVIEW_CHARS = 500;

const encoder = new TextEncoder();

/** Whether a source shows its clipboard on this device. */
export const showsClipboard = (state: SyncStateRecord | undefined): boolean =>
	state !== undefined && state.detached === undefined && state.clipboard === true;

/** A source's own row, if it is one the clipboard can belong to: live, not detached. */
const liveState = async (
	db: NotesDatabase,
	connectionId: string
): Promise<SyncStateRecord | undefined> => {
	const state = await db.syncState.get(connectionId);
	return state?.detached === undefined ? state : undefined;
};

/** Show the clipboard for a source on this device, or stop. Items stay where they are. */
export const setClipboardShown = (
	db: NotesDatabase,
	connectionId: string,
	shown: boolean
): Promise<void> =>
	updateLive(db, connectionId, ({ clipboard: _clipboard, ...state }) =>
		shown ? { ...state, clipboard: true } : state
	);

interface Prepared {
	readonly input: ClipInput;
	readonly bytes: ArrayBuffer;
	readonly hash: string;
}

const labelOf = (input: ClipInput): string =>
	input.kind === 'text' ? t('clipboard.text') : input.name;

const bytesOf = (input: ClipInput): ArrayBuffer =>
	input.kind === 'text' ? encoder.encode(input.text).slice().buffer : input.bytes;

/** The name an item takes, stamped `at`. */
const nameFor = ({ input, hash }: Prepared, at: number): string =>
	input.kind === 'text'
		? clipName({ at, hash, text: true })
		: clipName({ at, hash, name: input.name, type: input.type, pasted: input.pasted });

/** The hash a name carries, or nothing for a name the app did not write. */
const hashIn = (name: string): string | undefined => readClipName(name)?.hash;

/**
 * Of the items a source holds and those just pasted, the ones to let go of:
 * an older copy of anything held again — compared by the hash the name
 * carries, at the length the shorter one has — and whatever is past the cap,
 * newest first.
 */
const leaving = (rows: readonly ClipRecord[]): ClipRecord[] => {
	const newestFirst = [...rows].sort((a, b) => b.name.localeCompare(a.name));
	const kept = newestFirst.reduce<ClipRecord[]>((sofar, row) => {
		const hash = hashIn(row.name);
		const again = sofar.some((held) => {
			const other = hashIn(held.name);
			return hash !== undefined && other !== undefined && sameHash(hash, other);
		});
		return again ? sofar : [...sofar, row];
	}, []);
	const staying = new Set(kept.slice(0, CLIPBOARD_ITEMS).map((row) => row.name));
	return newestFirst.filter((row) => !staying.has(row.name));
};

const sameHash = (a: string, b: string): boolean =>
	a.length <= b.length ? b.startsWith(a) : a.startsWith(b);

/**
 * An item that is going: a pending one is simply forgotten, since the remote
 * never had it; one the remote has is marked to be removed there, and its
 * bytes let go of now.
 */
const letGo = async (db: NotesDatabase, row: ClipRecord): Promise<void> => {
	await db.clipBytes.delete([row.connectionId, row.name]);
	await db.clipThumbs.delete([row.connectionId, row.name]);
	if (row.state === 'pending') {
		await db.clips.delete([row.connectionId, row.name]);
		return;
	}
	await db.clips.put({ ...row, state: 'removing' });
};

/**
 * Put what was pasted on a source's clipboard. Anything over the size an item
 * may be (`MAX_ATTACHMENT_BYTES`, as for a file beside a note) is refused and
 * named; the rest go in newest last, each stamped after the newest item this
 * device knows of (`clipStamp`). Nothing goes in for a source that is not live.
 */
export const addClips = async (
	db: NotesDatabase,
	connectionId: string,
	inputs: readonly ClipInput[],
	now: number = Date.now()
): Promise<AddedClips> => {
	const sized = inputs.map((input) => ({ input, bytes: bytesOf(input) }));
	const tooLarge = sized
		.filter(({ bytes }) => bytes.byteLength > MAX_ATTACHMENT_BYTES)
		.map(({ input }) => labelOf(input));
	// Outside the transaction, which the digest would otherwise hold open for
	// up to 25 MB an item. Over a view, as `addAttachment` does: jsdom hands
	// WebCrypto an `ArrayBuffer` of the page's realm, which it refuses.
	const prepared: Prepared[] = await Promise.all(
		sized
			.filter(({ bytes }) => bytes.byteLength <= MAX_ATTACHMENT_BYTES)
			.map(async ({ input, bytes }) => ({
				input,
				bytes,
				hash: await bytesHash(new Uint8Array(bytes)),
			}))
	);
	const added = await db.transaction(
		'rw',
		[db.syncState, db.clips, db.clipBytes, db.clipThumbs],
		async () => {
			if ((await liveState(db, connectionId)) === undefined) return [];
			const held = await db.clips.where('connectionId').equals(connectionId).toArray();
			const newest = held.reduce<number | undefined>((latest, row) => {
				const at = readClipName(row.name)?.at;
				return at === undefined || (latest !== undefined && latest >= at) ? latest : at;
			}, undefined);
			const first = clipStamp(now, newest);
			const items = prepared.map((item, index) => ({
				row: {
					connectionId,
					name: nameFor(item, first + index),
					state: 'pending',
					size: item.bytes.byteLength,
					...(item.input.kind === 'text'
						? { preview: item.input.text.slice(0, PREVIEW_CHARS) }
						: {}),
				} satisfies ClipRecord,
				bytes: item.bytes,
			}));
			const rows = items.map(({ row }) => row);
			await db.clips.bulkAdd(rows);
			await db.clipBytes.bulkAdd(
				items.map(({ row, bytes }) => ({ connectionId, name: row.name, bytes }))
			);
			const shown = [...held.filter((row) => row.state !== 'removing'), ...rows];
			await Promise.all(leaving(shown).map((row) => letGo(db, row)));
			return rows.map((row) => row.name);
		}
	);
	return { added, tooLarge };
};

/** Take an item off a source's clipboard, here at once and on the remote when it can be. */
export const removeClip = (db: NotesDatabase, connectionId: string, name: string): Promise<void> =>
	db.transaction('rw', [db.clips, db.clipBytes, db.clipThumbs], async () => {
		const row = await db.clips.get([connectionId, name]);
		if (row === undefined || row.state === 'removing') return;
		await letGo(db, row);
	});

/** A source's clipboard as it is shown: newest first, without what is on its way out. */
export const listClips = async (db: NotesDatabase, connectionId: string): Promise<ClipRecord[]> =>
	(await db.clips.where('connectionId').equals(connectionId).toArray())
		.filter((row) => row.state !== 'removing')
		.sort((a, b) => b.name.localeCompare(a.name));

/**
 * Keep the thumb made of a picture on the clipboard (#276), or that it is
 * drawn as it is (`thumb` absent), while its item is still there. Answers
 * whether it was kept.
 */
export const keepClipThumb = (db: NotesDatabase, record: ClipThumbRecord): Promise<boolean> =>
	db.transaction('rw', [db.clips, db.clipThumbs], async () => {
		const row = await db.clips.get([record.connectionId, record.name]);
		if (row === undefined || row.state === 'removing') return false;
		await db.clipThumbs.put(record);
		return true;
	});
