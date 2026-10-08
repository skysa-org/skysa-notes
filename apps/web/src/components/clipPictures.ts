import { imageInfo, pictureVariant, safeOpenType } from '@skysa/core';

import { copyTurns } from '../pictures/copies.js';
import { noShrinker, type PictureShrinker } from '../pictures/shrinker.js';
import { keepClipThumb } from '../store/clipboard.js';
import { type ClipThumbRecord, type NotesDatabase } from '../store/db.js';

/**
 * The pictures on a source's clipboard, as its panel draws them (#276): from
 * thumbs made on this device, one at a time, and kept with their items, so the
 * panel never decodes ten photos to draw them 6rem tall. The items' bytes are
 * downloaded as they come all the same (docs/ARCHITECTURE.md §7, "The
 * clipboard"), since one is pasted whole; only what draws them changes.
 */

/** What a picture on the clipboard is drawn from: the key its URL is kept under, and its bytes. */
export interface ClipDrawable {
	readonly key: string;
	readonly blob: () => Blob;
}

/**
 * Which picture: the item, and the version of it this device has, none before
 * it has gone up. The version is in what its URL and its turn are kept by, as
 * a picture beside a note has its file's (`urlKey`): one written over on
 * another device is the same name, and drawn from the URL or the work under
 * the old version it would be the old picture.
 */
export interface ClipAt {
	readonly connectionId: string;
	readonly name: string;
	readonly version: string | undefined;
}

const keyOf = ({ connectionId, name, version }: ClipAt, thumb: boolean): string =>
	[connectionId, name, version ?? '', ...(thumb ? ['thumb'] : [])].join('\u0000');

/**
 * A picture drawn as it is. Made here, apart from anything else a function
 * holds: a closure made beside another shares what either holds.
 */
const asItIs = (at: ClipAt, bytes: ArrayBuffer): ClipDrawable => ({
	key: keyOf(at, false),
	blob: () => new Blob([bytes], { type: safeOpenType(at.name) }),
});

/** A picture drawn from its thumb, holding nothing but the thumb (`asItIs`). */
const fromThumb = (
	at: ClipAt,
	{ bytes, type }: NonNullable<ClipThumbRecord['thumb']>
): ClipDrawable => ({
	key: keyOf(at, true),
	blob: () => new Blob([bytes], { type }),
});

/** An item's bytes, where this device holds them. */
const bytesOf = async (
	db: NotesDatabase,
	connectionId: string,
	name: string
): Promise<ArrayBuffer | undefined> => (await db.clipBytes.get([connectionId, name]))?.bytes;

/** Drawn as what was kept of it says: from its thumb, or as it is. */
const drawnAs = async (
	db: NotesDatabase,
	at: ClipAt,
	{ thumb }: ClipThumbRecord
): Promise<ClipDrawable | undefined> => {
	if (thumb !== undefined) return fromThumb(at, thumb);
	const bytes = await bytesOf(db, at.connectionId, at.name);
	return bytes === undefined ? undefined : asItIs(at, bytes);
};

/**
 * At its turn: the thumb of the picture `name`, made from its bytes and kept;
 * or, where a thumb would be no smaller or the browser could not make one,
 * the picture as it is, which is kept said. Another panel may have made it
 * while this one waited.
 */
const makeThumb = async (
	db: NotesDatabase,
	shrinker: PictureShrinker,
	at: ClipAt
): Promise<ClipDrawable | undefined> => {
	const { connectionId, name } = at;
	const madeMeanwhile = await db.clipThumbs.get([connectionId, name]);
	if (madeMeanwhile !== undefined) return drawnAs(db, at, madeMeanwhile);
	// The version the bytes are, read before them.
	const version = (await db.clips.get([connectionId, name]))?.version;
	const bytes = await bytesOf(db, connectionId, name);
	if (bytes === undefined) return undefined;
	// Kept where it can be; drawn where it cannot, a full device's too.
	const keep = (record: ClipThumbRecord) => keepClipThumb(db, record, version).catch(() => false);
	const info = imageInfo(new Uint8Array(bytes));
	const wanted = info === undefined ? undefined : pictureVariant(info, 'thumb');
	if (info === undefined || wanted === undefined) {
		await keep({ connectionId, name });
		return asItIs(at, bytes);
	}
	const shrunk = await shrinker.shrink(new Blob([bytes], { type: safeOpenType(name) }), {
		width: wanted.width,
		alpha: info.alpha,
	});
	if (shrunk.kind === 'made') {
		const thumb = { bytes: await shrunk.copy.arrayBuffer(), type: shrunk.copy.type };
		await keep({ connectionId, name, thumb });
		return fromThumb(at, thumb);
	}
	// One the browser could not draw is not asked of it again; one missed is,
	// the next time it is shown.
	if (shrunk.kind === 'refused') await keep({ connectionId, name });
	return asItIs(at, bytes);
};

/**
 * What the picture `name` on a source's clipboard is drawn from: its thumb,
 * made at its turn where there is none yet, or its bytes as they are where a
 * thumb is not worth having or cannot be made. Nothing where neither is on
 * this device, or the asker stopped waiting.
 */
export const clipPicture = async (
	db: NotesDatabase,
	shrinker: PictureShrinker,
	at: ClipAt,
	signal: AbortSignal
): Promise<ClipDrawable | undefined> => {
	const known = await db.clipThumbs.get([at.connectionId, at.name]);
	if (known !== undefined) return drawnAs(db, at, known);
	// Where the browser cannot make thumbs, nothing waits a turn for one.
	if (shrinker === noShrinker) {
		const bytes = await bytesOf(db, at.connectionId, at.name);
		return bytes === undefined ? undefined : asItIs(at, bytes);
	}
	// In the app's one order of copies, behind a note's and the cards'.
	return copyTurns<ClipDrawable | undefined>(shrinker)(
		['clip', keyOf(at, true)].join('\u0000'),
		signal,
		() => makeThumb(db, shrinker, at)
	);
};
