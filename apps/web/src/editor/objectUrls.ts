/**
 * Object URLs for the files beside a note (#187), one per file however many
 * views show it, and let go of once nothing does.
 *
 * A `blob:` URL holds its bytes in memory until it is revoked, for as long as
 * the tab lives, so every one made has to be let go of. But not the moment its
 * last view goes: the rich editor rebuilds its node views when a body is
 * adopted (an incoming pull, a mode switch), and a picture whose URL was
 * revoked between its old view and its new one is a picture that flickers, or
 * fails to load. So a URL nothing holds lives for `graceMs` more, and one asked
 * for again inside that is the same URL.
 *
 * `create` and `revoke` are the seam: jsdom has no blob URLs.
 */

export interface ObjectUrlFactory {
	readonly create: (blob: Blob) => string;
	readonly revoke: (url: string) => void;
}

export const browserObjectUrls: ObjectUrlFactory = {
	create: (blob) => URL.createObjectURL(blob),
	revoke: (url) => {
		URL.revokeObjectURL(url);
	},
};

/** One view's hold on a URL. */
export interface HeldUrl {
	readonly url: string;
	/** Let go of it. Once: a second call does nothing. */
	readonly release: () => void;
}

export interface ObjectUrlCache {
	/**
	 * The URL for `key`, made from `blob()` if there is none: `blob` is only
	 * called then, so a caller can hand over bytes it has not wrapped yet.
	 */
	readonly acquire: (key: string, blob: () => Blob) => HeldUrl;
	/** Revoke every URL now, held or not. For a whole editor going away. */
	readonly clear: () => void;
}

/** How long a URL nothing holds is kept, for a view rebuilt in the meantime. */
export const OBJECT_URL_GRACE_MS = 5000;

interface Entry {
	readonly url: string;
	/** Holds on it now. */
	readonly holds: { current: number };
	/** The revoke waiting out the grace, while nothing holds it. */
	readonly pending: { current: ReturnType<typeof setTimeout> | undefined };
}

export const createObjectUrlCache = (
	factory: ObjectUrlFactory = browserObjectUrls,
	graceMs: number = OBJECT_URL_GRACE_MS
): ObjectUrlCache => {
	const entries = new Map<string, Entry>();

	const forget = (key: string, entry: Entry) => {
		clearTimeout(entry.pending.current);
		entries.delete(key);
		factory.revoke(entry.url);
	};

	const entryFor = (key: string, blob: () => Blob): Entry => {
		const known = entries.get(key);
		if (known !== undefined) return known;
		const made: Entry = {
			url: factory.create(blob()),
			holds: { current: 0 },
			pending: { current: undefined },
		};
		entries.set(key, made);
		return made;
	};

	return {
		acquire: (key, blob) => {
			const entry = entryFor(key, blob);
			clearTimeout(entry.pending.current);
			entry.pending.current = undefined;
			entry.holds.current += 1;
			const released = new Set<'once'>();
			return {
				url: entry.url,
				release: () => {
					if (released.has('once')) return;
					released.add('once');
					entry.holds.current -= 1;
					// Cleared meanwhile, or held again by someone else.
					if (entries.get(key) !== entry || entry.holds.current > 0) return;
					entry.pending.current = setTimeout(() => {
						forget(key, entry);
					}, graceMs);
				},
			};
		},
		clear: () => {
			entries.forEach((entry, key) => {
				forget(key, entry);
			});
		},
	};
};
