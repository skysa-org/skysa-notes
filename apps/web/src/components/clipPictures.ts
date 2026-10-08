import { imageInfo, pictureVariant, safeOpenType } from '@skysa/core';

import { oneAtATime, type Turns } from '../pictures/copies.js';
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

/** Thumbs made one at a time for each shrinker, which for the app is one (`oneAtATime`). */
const turnsOf = new WeakMap<PictureShrinker, Turns<ClipDrawable | undefined>>();

const turnsFor = (shrinker: PictureShrinker): Turns<ClipDrawable | undefined> => {
	const found = turnsOf.get(shrinker);
	if (found !== undefined) return found;
	const turns = oneAtATime<ClipDrawable | undefined>();
	turnsOf.set(shrinker, turns);
	return turns;
};

const keyOf = (connectionId: string, name: string, thumb: boolean): string =>
	[connectionId, name, ...(thumb ? ['thumb'] : [])].join('\u0000');

/**
 * A picture drawn as it is. Made here, apart from anything else a function
 * holds: a closure made beside another shares what either holds.
 */
const asItIs = (connectionId: string, name: string, bytes: ArrayBuffer): ClipDrawable => ({
	key: keyOf(connectionId, name, false),
	blob: () => new Blob([bytes], { type: safeOpenType(name) }),
});

/** A picture drawn from its thumb, holding nothing but the thumb (`asItIs`). */
const fromThumb = (
	connectionId: string,
	name: string,
	{ bytes, type }: NonNullable<ClipThumbRecord['thumb']>
): ClipDrawable => ({
	key: keyOf(connectionId, name, true),
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
	known: ClipThumbRecord
): Promise<ClipDrawable | undefined> => {
	const { connectionId, name, thumb } = known;
	if (thumb !== undefined) return fromThumb(connectionId, name, thumb);
	const bytes = await bytesOf(db, connectionId, name);
	return bytes === undefined ? undefined : asItIs(connectionId, name, bytes);
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
	connectionId: string,
	name: string
): Promise<ClipDrawable | undefined> => {
	const madeMeanwhile = await db.clipThumbs.get([connectionId, name]);
	if (madeMeanwhile !== undefined) return drawnAs(db, madeMeanwhile);
	const bytes = await bytesOf(db, connectionId, name);
	if (bytes === undefined) return undefined;
	const info = imageInfo(new Uint8Array(bytes));
	const wanted = info === undefined ? undefined : pictureVariant(info, 'thumb');
	if (info === undefined || wanted === undefined) {
		await keepClipThumb(db, { connectionId, name });
		return asItIs(connectionId, name, bytes);
	}
	const shrunk = await shrinker.shrink(new Blob([bytes], { type: safeOpenType(name) }), {
		width: wanted.width,
		alpha: info.alpha,
	});
	if (shrunk.kind === 'made') {
		const thumb = { bytes: await shrunk.copy.arrayBuffer(), type: shrunk.copy.type };
		await keepClipThumb(db, { connectionId, name, thumb });
		return fromThumb(connectionId, name, thumb);
	}
	// One the browser could not draw is not asked of it again; one missed is,
	// the next time it is shown.
	if (shrunk.kind === 'refused') await keepClipThumb(db, { connectionId, name });
	return asItIs(connectionId, name, bytes);
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
	connectionId: string,
	name: string,
	signal: AbortSignal
): Promise<ClipDrawable | undefined> => {
	const known = await db.clipThumbs.get([connectionId, name]);
	if (known !== undefined) return drawnAs(db, known);
	// Where the browser cannot make thumbs, nothing waits a turn for one.
	if (shrinker === noShrinker) {
		const bytes = await bytesOf(db, connectionId, name);
		return bytes === undefined ? undefined : asItIs(connectionId, name, bytes);
	}
	return turnsFor(shrinker)(keyOf(connectionId, name, true), signal, () =>
		makeThumb(db, shrinker, connectionId, name)
	);
};
