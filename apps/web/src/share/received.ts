import { z } from 'zod';

import { type ClipInput } from '../store/clipboard.js';

/**
 * What the share target kept for the page (docs/ARCHITECTURE.md §8, "Shared to
 * the app"): written by the service worker's `receiveShare` (`pwa.ts`), which
 * goes into `sw.js` as its own source and so cannot import this. The two agree
 * by `tests/share.test.ts`, which runs the one into the other.
 *
 * In Cache Storage, under `SHARE_CACHE`: `/share/<id>`, a listing of what came,
 * and `/share/<id>/<n>`, each file's bytes. The listing is written last.
 */
export const SHARE_CACHE = 'skysa-share';

/** An id as the worker makes them, `crypto.randomUUID()`. Anything else in the URL is no share. */
const SHARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isShareId = (value: string): boolean => SHARE_ID.test(value);

const listing = z.object({
	text: z.string(),
	files: z.array(
		z.object({
			name: z.string(),
			type: z.string(),
			size: z.number(),
			/** Where its bytes are, or `null` for one too large to keep. */
			part: z.number().int().nonnegative().nullable(),
		})
	),
});

/** What was shared, as the clipboard takes it, and the names of what was too large to. */
export interface Received {
	readonly inputs: readonly ClipInput[];
	readonly tooLarge: readonly string[];
}

const keyOf = (id: string, part?: number): string =>
	part === undefined ? `/share/${id}` : `/share/${id}/${String(part)}`;

const defaultStorage = (): CacheStorage | undefined =>
	typeof caches === 'undefined' ? undefined : caches;

/**
 * The share kept under `id`, or `undefined` where there is none: taken
 * already, by this tab or another, or an id the worker never made.
 */
export const readShare = async (
	id: string,
	storage: CacheStorage | undefined = defaultStorage()
): Promise<Received | undefined> => {
	if (storage === undefined || !isShareId(id)) return undefined;
	const cache = await storage.open(SHARE_CACHE);
	const listed = await cache.match(keyOf(id));
	if (listed === undefined) return undefined;
	const parsed = listing.safeParse(await listed.json().catch(() => undefined));
	if (!parsed.success) return undefined;
	const { text, files } = parsed.data;
	const kept = await Promise.all(
		files.map(async ({ name, type, part }): Promise<ClipInput | undefined> => {
			if (part === null) return undefined;
			const bytes = await cache.match(keyOf(id, part));
			return bytes === undefined
				? undefined
				: { kind: 'file', name, type, bytes: await bytes.arrayBuffer() };
		})
	);
	return {
		inputs: [
			...(text === '' ? [] : [{ kind: 'text', text } as const]),
			...kept.filter((input): input is ClipInput => input !== undefined),
		],
		tooLarge: files.filter(({ part }) => part === null).map(({ name }) => name),
	};
};

/** Let go of the share kept under `id`, its listing and its files. */
export const forgetShare = async (
	id: string,
	storage: CacheStorage | undefined = defaultStorage()
): Promise<void> => {
	if (storage === undefined || !isShareId(id)) return;
	const cache = await storage.open(SHARE_CACHE);
	const prefix = keyOf(id);
	const keys = await cache.keys();
	await Promise.all(
		keys
			.filter((request) => {
				const { pathname } = new URL(request.url);
				return pathname === prefix || pathname.startsWith(`${prefix}/`);
			})
			.map((request) => cache.delete(request))
	);
};
