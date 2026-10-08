import { CLIPBOARD_ITEMS } from '@skysa/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clipPicture } from '../src/components/clipPictures.js';
import { copyTurns } from '../src/pictures/copies.js';
import { noShrinker, type PictureShrinker, type Shrunk } from '../src/pictures/shrinker.js';
import { addClips, keepClipThumb, removeClip } from '../src/store/clipboard.js';
import { bindConnection, detachConnection, releaseConnection } from '../src/store/connection.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { seenIn, unsyncedIn } from '../src/store/unsynced.js';

/**
 * The pictures on a source's clipboard as its panel draws them (#276): from a
 * thumb made once from the item's bytes and kept with it, or as they are.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const be32 = (value: number): number[] => [
	(value >>> 24) & 255,
	(value >>> 16) & 255,
	(value >>> 8) & 255,
	value & 255,
];

const chunk = (type: string, data: readonly number[] = []): number[] => [
	...be32(data.length),
	...[...type].map((char) => char.charCodeAt(0)),
	...data,
	0,
	0,
	0,
	0,
];

/** A PNG's header and nothing to draw: all `imageInfo` reads, which is all that reads it here. */
const pngOf = (width: number, height: number): ArrayBuffer =>
	new Uint8Array([
		...[...'\x89PNG\r\n\x1a\n'].map((char) => char.charCodeAt(0)),
		...chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
		...chunk('IDAT', [0]),
		...chunk('IEND'),
	]).buffer;

/** A thumb as the browser would make it: `want` wide, at a photo's shape. */
const madeAs = (want: { width: number }): Shrunk => ({
	kind: 'made',
	copy: new Blob(['thumb'], { type: 'image/webp' }),
	width: want.width,
	height: Math.round((want.width * 3) / 4),
});

/** A shrinker that answers as told, or at once with a thumb, keeping what it was asked. */
const shrinkerOf = (answer: (want: { width: number }) => Promise<Shrunk> | Shrunk = madeAs) => {
	const asked: { width: number; alpha: boolean }[] = [];
	const shrinker: PictureShrinker = {
		shrink: (_picture, { width, alpha }) => {
			asked.push({ width, alpha });
			return Promise.resolve(answer({ width }));
		},
	};
	return { shrinker, asked };
};

const setup = async () => {
	const db = createDatabase(`clip-pictures-${crypto.randomUUID()}`);
	opened.push(db);
	await db.syncState.put({
		connectionId: 'c1',
		clientId: 'install',
		rootId: 'root',
		clipboard: true,
	});
	/** A picture pasted, by the name it was given. */
	const pasted = async (bytes: ArrayBuffer = pngOf(4000, 3000)) => {
		const { added } = await addClips(db, 'c1', [
			{ kind: 'file', name: '', type: 'image/png', bytes, pasted: true },
		]);
		return added[0] ?? '';
	};
	return { db, pasted };
};

const asking = () => new AbortController().signal;

const drawn = async (
	db: NotesDatabase,
	shrinker: PictureShrinker,
	name: string,
	signal: AbortSignal = asking()
) => {
	const drawable = await clipPicture(db, shrinker, 'c1', name, signal);
	return drawable === undefined
		? undefined
		: { key: drawable.key.split('\u0000').slice(2), text: await drawable.blob().text() };
};

describe('a picture on the clipboard, as its panel draws it', () => {
	it('is drawn from a thumb made once from its bytes, and kept with it', async () => {
		const { db, pasted } = await setup();
		const { shrinker, asked } = shrinkerOf();
		const name = await pasted();

		expect(await drawn(db, shrinker, name)).toEqual({ key: ['thumb'], text: 'thumb' });
		expect(asked).toEqual([{ width: 512, alpha: false }]);
		expect(await db.clipThumbs.get(['c1', name])).toMatchObject({
			thumb: { type: 'image/webp' },
		});

		// Drawn again, from what was kept: the item's bytes are not read.
		const read = vi.spyOn(db.clipBytes, 'get');
		expect(await drawn(db, shrinker, name)).toEqual({ key: ['thumb'], text: 'thumb' });
		expect(asked).toHaveLength(1);
		expect(read).not.toHaveBeenCalled();
	});

	it('is drawn from its thumb at once, while another is being made', async () => {
		const { db, pasted } = await setup();
		// The first at once, the second when the test says.
		const later: (() => void)[] = [];
		const { shrinker, asked } = shrinkerOf((want) =>
			asked.length === 1
				? madeAs(want)
				: new Promise((resolve) => {
						later.push(() => {
							resolve(madeAs(want));
						});
					})
		);
		const kept = await pasted(pngOf(4000, 3001));
		await drawn(db, shrinker, kept);
		const making = drawn(db, shrinker, await pasted(pngOf(4000, 3002)));
		await vi.waitFor(() => {
			expect(later).toHaveLength(1);
		});

		expect(await drawn(db, shrinker, kept)).toEqual({ key: ['thumb'], text: 'thumb' });
		later[0]?.();
		expect((await making)?.key).toEqual(['thumb']);
	});

	it('is drawn from its thumb once its bytes are let go of', async () => {
		const { db, pasted } = await setup();
		const { shrinker } = shrinkerOf();
		const name = await pasted();
		await drawn(db, shrinker, name);

		await db.clipBytes.delete(['c1', name]);

		expect(await drawn(db, shrinker, name)).toEqual({ key: ['thumb'], text: 'thumb' });
	});

	it('is drawn as it is where a thumb would be no smaller, and that is kept', async () => {
		const { db, pasted } = await setup();
		const { shrinker, asked } = shrinkerOf();
		const small = pngOf(400, 300);
		const name = await pasted(small);

		const first = await drawn(db, shrinker, name);

		expect(first?.key).toEqual([]);
		expect(asked).toEqual([]);
		expect(await db.clipThumbs.get(['c1', name])).toEqual({ connectionId: 'c1', name });
	});

	it('is drawn as it is, and not asked of the browser again, where it could not make a thumb', async () => {
		const { db, pasted } = await setup();
		const { shrinker, asked } = shrinkerOf(() => ({ kind: 'refused' }));
		const name = await pasted();

		expect((await drawn(db, shrinker, name))?.key).toEqual([]);
		expect((await drawn(db, shrinker, name))?.key).toEqual([]);

		expect(asked).toHaveLength(1);
		expect(await db.clipThumbs.get(['c1', name])).toEqual({ connectionId: 'c1', name });
	});

	it('is drawn as it is where no thumb was made this time, and asked for again the next', async () => {
		const { db, pasted } = await setup();
		const { shrinker, asked } = shrinkerOf(() => ({ kind: 'missed' }));
		const name = await pasted();

		expect((await drawn(db, shrinker, name))?.key).toEqual([]);
		expect((await drawn(db, shrinker, name))?.key).toEqual([]);

		expect(asked).toHaveLength(2);
		expect(await db.clipThumbs.get(['c1', name])).toBeUndefined();
	});

	it('is drawn as it is, with nothing kept, where the browser makes no thumbs', async () => {
		const { db, pasted } = await setup();
		const name = await pasted();

		expect((await drawn(db, noShrinker, name))?.key).toEqual([]);
		expect(await db.clipThumbs.count()).toBe(0);
	});

	it('is nothing where neither its bytes nor its thumb are on this device', async () => {
		const { db, pasted } = await setup();
		const { shrinker, asked } = shrinkerOf();
		const name = await pasted();
		await db.clipBytes.delete(['c1', name]);

		expect(await drawn(db, shrinker, name)).toBeUndefined();
		expect(asked).toEqual([]);
	});

	it('is drawn from its thumb where the device could not keep it', async () => {
		const { db, pasted } = await setup();
		const { shrinker } = shrinkerOf();
		const name = await pasted();
		// A phone with its storage full.
		vi.spyOn(db.clipThumbs, 'put').mockRejectedValue(new Error('QuotaExceededError'));

		expect(await drawn(db, shrinker, name)).toEqual({ key: ['thumb'], text: 'thumb' });
		expect(await db.clipThumbs.count()).toBe(0);
	});

	it('waits its turn behind a copy a note or a card asked for first', async () => {
		const { db, pasted } = await setup();
		const { shrinker, asked } = shrinkerOf();
		const name = await pasted();
		const ahead = { finish: (): void => undefined };
		const noteCopy = copyTurns<string>(shrinker)(
			'c1\u0000notes/cat.png\u0000v1\u0000thumb\u0000false',
			asking(),
			() =>
				new Promise<string>((resolve) => {
					ahead.finish = () => {
						resolve('copy');
					};
				})
		);

		const shown = drawn(db, shrinker, name);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(asked).toEqual([]);
		ahead.finish();

		expect(await noteCopy).toBe('copy');
		expect((await shown)?.key).toEqual(['thumb']);
		expect(asked).toHaveLength(1);
	});

	it('is not kept where another device wrote over it while it was made', async () => {
		const { db, pasted } = await setup();
		const answers: (() => void)[] = [];
		const { shrinker } = shrinkerOf(
			(want) =>
				new Promise((resolve) => {
					answers.push(() => {
						resolve(madeAs(want));
					});
				})
		);
		const name = await pasted();
		await db.clips.update(['c1', name], { state: 'sent', version: 'v1' });

		const shown = drawn(db, shrinker, name);
		await vi.waitFor(() => {
			expect(answers).toHaveLength(1);
		});
		// As a pull takes the new version: bytes let go of, to be read again.
		await db.clips.update(['c1', name], { version: 'v2' });
		await db.clipBytes.delete(['c1', name]);
		answers[0]?.();

		expect((await shown)?.key).toEqual(['thumb']);
		expect(await db.clipThumbs.count()).toBe(0);
	});

	it('is kept where it went up while it was made, which changes none of its bytes', async () => {
		const { db, pasted } = await setup();
		const answers: (() => void)[] = [];
		const { shrinker } = shrinkerOf(
			(want) =>
				new Promise((resolve) => {
					answers.push(() => {
						resolve(madeAs(want));
					});
				})
		);
		const name = await pasted();

		const shown = drawn(db, shrinker, name);
		await vi.waitFor(() => {
			expect(answers).toHaveLength(1);
		});
		await db.clips.update(['c1', name], { state: 'sent', version: 'v1' });
		answers[0]?.();

		expect((await shown)?.key).toEqual(['thumb']);
		expect(await db.clipThumbs.count()).toBe(1);
	});

	it('is not made twice, where another made it while this one waited', async () => {
		const { db, pasted } = await setup();
		const { shrinker, asked } = shrinkerOf();
		const name = await pasted();
		await drawn(db, shrinker, name);
		// Asked as the other was being kept: nothing there yet when this one looked.
		vi.spyOn(db.clipThumbs, 'get').mockResolvedValueOnce(undefined);

		expect(await drawn(db, shrinker, name)).toEqual({ key: ['thumb'], text: 'thumb' });
		expect(asked).toHaveLength(1);
	});

	it('has no thumb kept once its item is removed while it was being made', async () => {
		const { db, pasted } = await setup();
		const answers: (() => void)[] = [];
		const { shrinker } = shrinkerOf(
			(want) =>
				new Promise((resolve) => {
					answers.push(() => {
						resolve(madeAs(want));
					});
				})
		);
		const pending = await pasted(pngOf(4000, 3001));
		// Sent: removed, it is marked to be removed there, and is still a row.
		const sent = await pasted(pngOf(4000, 3002));
		await db.clips.update(['c1', sent], { state: 'sent' });

		const shown = drawn(db, shrinker, pending);
		await vi.waitFor(() => {
			expect(answers).toHaveLength(1);
		});
		await removeClip(db, 'c1', pending);
		answers[0]?.();
		expect((await shown)?.key).toEqual(['thumb']);

		const again = drawn(db, shrinker, sent);
		await vi.waitFor(() => {
			expect(answers).toHaveLength(2);
		});
		await removeClip(db, 'c1', sent);
		answers[1]?.();
		expect((await again)?.key).toEqual(['thumb']);

		expect(await db.clipThumbs.count()).toBe(0);
	});
});

describe('a picture’s thumb on the clipboard', () => {
	it('goes with its item, removed or pushed out by newer ones', async () => {
		const { db, pasted } = await setup();
		const { shrinker } = shrinkerOf();
		const removed = await pasted(pngOf(4000, 3001));
		const oldest = await pasted(pngOf(4000, 3002));
		await drawn(db, shrinker, removed);
		await drawn(db, shrinker, oldest);

		await removeClip(db, 'c1', removed);
		expect(await db.clipThumbs.get(['c1', removed])).toBeUndefined();
		await addClips(
			db,
			'c1',
			Array.from({ length: CLIPBOARD_ITEMS }, (_, index) => ({
				kind: 'file',
				name: '',
				type: 'image/png',
				bytes: pngOf(10, index + 1),
				pasted: true,
			}))
		);

		expect(await db.clipThumbs.count()).toBe(0);
	});

	it('goes with a source the user lets go of', async () => {
		const db = createDatabase(`clip-pictures-${crypto.randomUUID()}`);
		opened.push(db);
		await bindConnection(db, {
			connectionId: 'c1',
			provider: 'dropbox',
			accountId: 'dbid:ada',
		});
		await db.clips.put({ connectionId: 'c1', name: 'picture.png', state: 'sent', size: 3 });
		await keepClipThumb(db, { connectionId: 'c1', name: 'picture.png' });
		expect(await db.clipThumbs.count()).toBe(1);
		await detachConnection(db, { connectionId: 'c1' });
		const seen = seenIn(await unsyncedIn(db, 'c1'));

		expect(await releaseConnection(db, { connectionId: 'c1', unsynced: 'discard', seen })).toBe(
			'released'
		);

		expect(await db.clipThumbs.count()).toBe(0);
	});
});
