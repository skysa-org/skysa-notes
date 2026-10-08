import { type PictureInfo, type PictureVariant } from '@skysa/core';

import {
	type FileRecord,
	type NotesDatabase,
	type PictureCopyRecord,
	type PictureRecord,
} from './db.js';
import { TOUCH_AFTER_MS } from './fileCache.js';
import { fileKey } from './files.js';

/**
 * Smaller copies of the pictures beside notes (#276), made on this device and
 * kept here, so that a phone shows a 48 MP photo from a copy as wide as its
 * screen, and a card from one the size of the card; and what each picture's
 * header says, so its box is the right size before anything is drawn in it.
 *
 * Nothing here is anybody's work. It is never sent, exported or counted as
 * unsent, and whatever is missing is made again from the original. So it is
 * kept apart from `files` and `fileBytes`, under a budget of its own, and
 * only for as long as the row it was read for is bound to the same bytes:
 * the remote id and version it is stamped with (`pictureIsCurrent`).
 */

/**
 * How much of copies one device keeps: some thousands of a card's thumb, or
 * some hundreds of copies a phone's width. Apart from the originals' budget
 * (`CACHE_BUDGET_BYTES`), so that a phone which lets a 25 MB photo go keeps the
 * copy of a few hundred KB it was being shown from.
 */
export const PICTURE_BUDGET_BYTES = 96 * 1024 * 1024;

/**
 * The share of the budget the thumbs are let go of last within: the newest of
 * them, up to that much. Past it the oldest go as any copy does, least
 * recently used first, or a device with thousands of cards would keep no copy
 * of a note's pictures beyond the one it had just made.
 */
export const THUMB_SHARE = 0.75;

/** What a row is bound to: the bytes of a remote version, or none while it is only here. */
type Bound = Pick<FileRecord, 'remoteId' | 'remoteVersion'>;

/** Whether what is kept of a picture was read from the bytes its row is bound to now. */
export const pictureIsCurrent = (
	file: Bound,
	picture: Pick<PictureRecord, 'remoteId' | 'version'>
): boolean => picture.remoteId === file.remoteId && picture.version === file.remoteVersion;

const stampOf = ({ remoteId, remoteVersion }: Bound) => ({
	...(remoteId === undefined ? {} : { remoteId }),
	...(remoteVersion === undefined ? {} : { version: remoteVersion }),
});

type Key = [string, string];

const keyOf = (picture: Pick<PictureRecord, 'connectionId' | 'fileId'>): Key => [
	picture.connectionId,
	picture.fileId,
];

/**
 * What is kept for the picture `fileId` is, where it was read from the bytes
 * its row is bound to now. `undefined` where nothing is, or what is was read
 * from bytes the row has since moved on from.
 */
export const heldPicture = (
	db: NotesDatabase,
	connectionId: string,
	fileId: string
): Promise<PictureRecord | undefined> =>
	db.transaction('r', db.files, db.pictures, async () => {
		const file = await db.files.get([connectionId, fileId]);
		const picture = await db.pictures.get([connectionId, fileId]);
		return file !== undefined && picture !== undefined && pictureIsCurrent(file, picture)
			? picture
			: undefined;
	});

/** A copy as it is shown. */
export interface HeldCopy {
	readonly bytes: ArrayBuffer;
	readonly type: string;
	readonly width: number;
	readonly height: number;
}

/**
 * Write a use back, read again inside its own transaction so nothing written
 * since is put back over. To the record, which is small: never to the bytes.
 */
const touch = (db: NotesDatabase, key: Key, variant: PictureVariant, now: number): Promise<void> =>
	db.transaction('rw', db.pictures, async () => {
		const picture = await db.pictures.get(key);
		const copy = picture?.copies[variant];
		if (picture === undefined || copy === undefined || now - copy.lastUsedAt < TOUCH_AFTER_MS)
			return;
		await db.pictures.put({
			...picture,
			copies: { ...picture.copies, [variant]: { ...copy, lastUsedAt: now } },
		});
	});

/**
 * The copy `variant` of the picture `fileId` is, where one is kept for the
 * bytes its row is bound to now, with the use written back once it is
 * `TOUCH_AFTER_MS` stale, as `heldFile` does for an original.
 */
export const heldCopy = async (
	db: NotesDatabase,
	connectionId: string,
	fileId: string,
	variant: PictureVariant,
	now: number
): Promise<HeldCopy | undefined> => {
	const found = await db.transaction('r', db.files, db.pictures, db.pictureBytes, async () => {
		const file = await db.files.get([connectionId, fileId]);
		const picture = await db.pictures.get([connectionId, fileId]);
		if (file === undefined || picture === undefined || !pictureIsCurrent(file, picture))
			return undefined;
		const copy = picture.copies[variant];
		const held =
			copy === undefined
				? undefined
				: await db.pictureBytes.get([connectionId, fileId, variant]);
		return copy === undefined || held === undefined ? undefined : { copy, bytes: held.bytes };
	});
	if (found === undefined) return undefined;
	const { copy, bytes } = found;
	if (now - copy.lastUsedAt >= TOUCH_AFTER_MS) {
		await touch(db, [connectionId, fileId], variant, now).catch(() => undefined);
	}
	return { bytes, type: copy.type, width: copy.width, height: copy.height };
};

/** A copy just made, to keep. */
export interface MadeCopy extends HeldCopy {
	readonly variant: PictureVariant;
}

/**
 * Every record and copy kept for these files, inside the caller's transaction:
 * where a file's row goes, what was read of it goes with it.
 *
 * Dexie's own promise, not an `async` function's, as `forgetClips` has it in
 * `store/connection.ts`: it is called inside transactions there.
 */
export const dropPictures = (
	db: Pick<NotesDatabase, 'pictures' | 'pictureBytes'>,
	keys: readonly Key[]
): Promise<unknown> =>
	db.pictures.bulkDelete([...keys]).then(() =>
		db.pictureBytes
			.where('[connectionId+fileId]')
			.anyOf([...keys])
			.delete()
	);

/** Everything kept for the pictures of these sources, as `forgetClips` lets their clipboards go. */
export const forgetPictures = (
	db: Pick<NotesDatabase, 'pictures' | 'pictureBytes'>,
	connectionIds: readonly string[]
): Promise<unknown> =>
	db.pictures
		.where('connectionId')
		.anyOf([...connectionIds])
		.delete()
		.then(() =>
			db.pictureBytes
				.where('connectionId')
				.anyOf([...connectionIds])
				.delete()
		);

/**
 * What is kept of a picture whose row has been bound to the same bytes under
 * another name — uploaded at last, moved, or cut loose from its remote copy —
 * inside the caller's transaction. Only what was current for `from`: what was
 * read from other bytes stays as it was, and is let go of by `evictPictures`.
 */
export const restampPicture = async (
	db: Pick<NotesDatabase, 'pictures'>,
	key: Key,
	from: Bound,
	to: Bound
): Promise<void> => {
	const picture = await db.pictures.get(key);
	if (picture === undefined || !pictureIsCurrent(from, picture)) return;
	const { remoteId: _remoteId, version: _version, ...rest } = picture;
	await db.pictures.put({ ...rest, ...stampOf(to) });
};

/** One copy of one picture: the one just kept, which its own keeping never lets go of. */
type CopyKey = Readonly<{ key: Key; variant: PictureVariant }>;

/** The thumbs let go of last: the newest, as many as fit `THUMB_SHARE` of the budget. */
const sheltered = <T extends { variant: PictureVariant; copy: PictureCopyRecord }>(
	copies: readonly T[],
	budget: number
): ReadonlySet<T> => {
	const room = { current: THUMB_SHARE * budget };
	return new Set(
		copies
			.filter(({ variant }) => variant === 'thumb')
			.toSorted((a, b) => b.copy.lastUsedAt - a.copy.lastUsedAt)
			.filter(({ copy }) => {
				if (copy.size > room.current) return false;
				room.current -= copy.size;
				return true;
			})
	);
};

/**
 * Let go of what is kept for pictures until the copies fit `budget`: first
 * every record whose row has gone or moved on to other bytes, then copies,
 * the least recently used first. The newest thumbs, up to `THUMB_SHARE` of
 * the budget, go after the copies a note is shown from, since a whole wall of
 * cards needs its thumbs at once. `spare`, the copy just kept, never goes. A
 * record with no copies left is kept, for its header: it costs a few bytes,
 * and keeps a picture's box the right size.
 *
 * One transaction, so a copy kept while this runs is either counted or not
 * there yet. Answers how many records and copies it let go of.
 */
export const evictPictures = (
	db: NotesDatabase,
	budget: number = PICTURE_BUDGET_BYTES,
	spare?: CopyKey
): Promise<number> =>
	db.transaction('rw', db.files, db.pictures, db.pictureBytes, async () => {
		const pictures = await db.pictures.toArray();
		const rows = await db.files.bulkGet(pictures.map(keyOf));
		const current = new Set(
			pictures.filter((picture, at) => {
				const row = rows[at];
				return row !== undefined && pictureIsCurrent(row, picture);
			})
		);
		const stale = pictures.filter((picture) => !current.has(picture));
		const copies = [...current].flatMap((picture) =>
			Object.entries(picture.copies).map(([variant, copy]) => ({
				picture,
				variant: variant as PictureVariant,
				copy,
			}))
		);
		const last = sheltered(copies, budget);
		const spared = ({ picture, variant }: (typeof copies)[number]) =>
			spare !== undefined &&
			variant === spare.variant &&
			picture.connectionId === spare.key[0] &&
			picture.fileId === spare.key[1];
		const order = copies
			.filter((each) => !spared(each))
			.toSorted(
				(a, b) =>
					Number(last.has(a)) - Number(last.has(b)) ||
					a.copy.lastUsedAt - b.copy.lastUsedAt
			);
		// Written to as it goes, in the order they are let go of.
		const left = { current: copies.reduce((sum, { copy }) => sum + copy.size, 0) };
		const evicted = order.filter(({ copy }) => {
			if (left.current <= budget) return false;
			left.current -= copy.size;
			return true;
		});
		const going = new Map<PictureRecord, Set<string>>();
		evicted.forEach(({ picture, variant }) => {
			going.set(picture, (going.get(picture) ?? new Set()).add(variant));
		});
		await db.pictures.bulkPut(
			[...going].map(([picture, variants]) => ({
				...picture,
				copies: Object.fromEntries(
					Object.entries(picture.copies).filter(([variant]) => !variants.has(variant))
				),
			}))
		);
		await db.pictureBytes.bulkDelete(
			evicted.map(({ picture, variant }): [string, string, PictureVariant] => [
				picture.connectionId,
				picture.fileId,
				variant,
			])
		);
		await dropPictures(db, stale.map(keyOf));
		return stale.length + evicted.length;
	});

/**
 * What the copies kept come to, stale ones included: from the records alone,
 * which are small, and without holding up the library's files.
 */
const heldSize = async (db: NotesDatabase): Promise<number> =>
	(await db.pictures.toArray()).reduce(
		(sum, picture) =>
			Object.values(picture.copies).reduce((more, copy) => more + copy.size, sum),
		0
	);

/**
 * Keep what was read of a picture: what its header says, and the copy made
 * of it, if one was, or that the browser refused to draw one (`refused`),
 * which stays said for as long as the record stands for these bytes. Only
 * while its row is still bound to the bytes it was read from, which are
 * `file`'s: a row deleted meanwhile, or bound to other bytes, is another
 * picture's. What was kept for other bytes goes now. So `file` is the row as
 * it was read *before* the bytes were — read after, it could be bound to
 * bytes newer than the ones the copy was made from.
 *
 * Then, where a copy was kept and the copies are over the budget, lets go of
 * others (`evictPictures`), never this one. Answers whether it was kept.
 */
export const keepPicture = async (
	db: NotesDatabase,
	file: FileRecord,
	read: Readonly<{ info: PictureInfo | null; copy?: MadeCopy; refused?: boolean }>,
	now: number,
	budget: number = PICTURE_BUDGET_BYTES
): Promise<boolean> => {
	const kept = await db.transaction('rw', db.files, db.pictures, db.pictureBytes, async () => {
		const row = await db.files.get(fileKey(file));
		if (row === undefined || !pictureIsCurrent(row, stampOf(file))) return false;
		const before = await db.pictures.get(fileKey(row));
		const still = before !== undefined && pictureIsCurrent(row, before) ? before : undefined;
		if (before !== undefined && still === undefined) await dropPictures(db, [fileKey(row)]);
		const { copy } = read;
		const copies: PictureRecord['copies'] =
			copy === undefined
				? (still?.copies ?? {})
				: {
						...still?.copies,
						[copy.variant]: {
							type: copy.type,
							width: copy.width,
							height: copy.height,
							size: copy.bytes.byteLength,
							lastUsedAt: now,
						} satisfies PictureCopyRecord,
					};
		await db.pictures.put({
			connectionId: row.connectionId,
			fileId: row.id,
			...stampOf(row),
			info: read.info,
			...(read.refused === true || still?.refused === true ? { refused: true } : {}),
			copies,
		});
		if (copy !== undefined) {
			await db.pictureBytes.put({
				connectionId: row.connectionId,
				fileId: row.id,
				variant: copy.variant,
				bytes: copy.bytes,
			});
		}
		return true;
	});
	const { copy } = read;
	if (kept && copy !== undefined && (await heldSize(db)) > budget) {
		await evictPictures(db, budget, { key: fileKey(file), variant: copy.variant });
	}
	return kept;
};
