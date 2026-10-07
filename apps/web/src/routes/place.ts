import { basename, isScratchPath, parentPath, ROOT, SCRATCHPAD_FOLDER } from '@skysa/core';

import { SCRATCHPAD_LABEL } from '../store/scratchpad.js';

/**
 * Where the user is — which notebook is open, and which note — as the URL
 * carries it (docs/ARCHITECTURE.md §7, "Where the user is, in the URL").
 *
 * Twice over, because each half answers what the other cannot:
 *
 * - **The hash names it**, `#/work-stuff/projects/q3-plan`: each notebook and
 *   then the note, as a slug (`urlSlug`), or the notebooks alone with a
 *   closing `/`. That is what a person reads, and what a link, a bookmark or
 *   an address typed in brings. A fragment is never sent to the server, so
 *   neither are the names.
 * - **The history entry holds it by id** (`HeldPlace`), with the source it is
 *   a place in. A slug can be two names, and stops naming a note the moment
 *   it is renamed, here or on another device; an entry Back returns to may be
 *   hours old. The id does not move. It also carries what the hash cannot
 *   say: a notebook open above the note's own (`noteIsUnder`). A reload
 *   keeps it.
 *
 * An entry with a place of its own goes by that, and its hash follows the note
 * as it is renamed. One without — a link, or an address typed — is read by
 * name once (`findNamedPlace`), and holds the answer from then on.
 */

/** A notebook and the note open in it: what a history entry holds. */
export interface Place {
	/** The open notebook's path, `ROOT` for the loose notes. */
	folder?: string;
	/** The open note's id. */
	note?: string;
}

/** A place, with the source it is a place in: ids name nothing outside it. */
export interface HeldPlace extends Place {
	connectionId: string;
}

/** What a history entry carries for the app. */
export interface PlaceState {
	place?: HeldPlace;
}

declare module '@tanstack/react-router' {
	interface HistoryState {
		place?: HeldPlace;
	}
}

/** What a hash names, as it spells it: what an entry without a place is read by. */
export interface NamedPlace {
	/** The notebook's path, a slug for each name; `ROOT` for the loose notes. */
	folder?: string;
	/** The note's name, as a slug. */
	note?: string;
}

/**
 * A name as the hash spells it: lowercase, with every run of anything that is
 * not a letter or a digit one hyphen — `Work Stuff` is `work-stuff`, `R&D` is
 * `r-d`, and a note's filename, a slug already, mostly itself. Letters of every
 * script are kept, as note filenames keep them (`slugify` in core): a library
 * that turns names into ASCII drops or guesses at most of the world's.
 * A name with no letter or digit in it is kept whole, rather than be nothing.
 * Its own slug, so an address typed with names as they are reads the same.
 */
export const urlSlug = (name: string): string => {
	const slug = name
		.normalize('NFC')
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
	return slug === '' ? name : slug;
};

/** A note's filename without `.md`, which nobody reads as part of a name. */
const stem = (name: string): string => name.replace(/\.md$/i, '');

/** A path as slugs, still `/`-separated, without escapes. */
const slugPath = (path: string): string =>
	path === ROOT ? ROOT : path.split('/').map(urlSlug).join('/');

/** A path as the hash writes it: slugs, each escaped where a slug needs it. */
const spell = (path: string): string =>
	path
		.split('/')
		.map((name) => encodeURIComponent(urlSlug(name)))
		.join('/');

/**
 * The scratchpad's hash (docs/ARCHITECTURE.md §7, "The scratchpad"), with a
 * card's name after a `/` while one is open: `#scratchpad/shopping`. Outside
 * the `/` that begins every notebook's, so no notebook's name can be read as it.
 */
const SCRATCHPAD_HASH = 'scratchpad';

/**
 * The folder a note's place names: the notebook it is in, or the scratchpad
 * for a note in the scratchpad's folder, at whatever depth another tool put it.
 */
export const placeFolder = (notePath: string): string =>
	isScratchPath(notePath) ? SCRATCHPAD_FOLDER : parentPath(notePath);

/**
 * The hash, without its `#`, for a notebook and the path of the note open in
 * it: the note's path where there is one, since that says the notebook too,
 * and the notebook's with a closing `/` where there is not. `''` for neither.
 */
export const placeHash = (folder: string | undefined, notePath: string | undefined): string => {
	if (folder !== undefined && isScratchPath(folder)) {
		return notePath === undefined
			? SCRATCHPAD_HASH
			: `${SCRATCHPAD_HASH}/${spell(stem(basename(notePath)))}`;
	}
	if (notePath !== undefined) return `/${spell(stem(notePath))}`;
	if (folder === undefined) return '';
	return folder === ROOT ? '/' : `/${spell(folder)}/`;
};

/** Each name in a path as the hash spells it, or nothing for a `%` with no escape after it. */
const decodeNames = (spelled: string): string[] | undefined => {
	try {
		return spelled.split('/').map(decodeURIComponent);
	} catch {
		return undefined;
	}
};

/**
 * What a hash names, read back. Each name is made a slug again, so an address
 * typed with the names as they are — `#/Work Stuff/Q3 plan` — reads as the one
 * the app writes. Anything else that can be in a fragment — an anchor, an
 * empty or hidden name — names nothing, and the app opens where the user last
 * was, as it does with no hash at all.
 */
export const readPlaceHash = (fragment: string): NamedPlace => {
	if (fragment === SCRATCHPAD_HASH) return { folder: SCRATCHPAD_FOLDER };
	if (fragment.startsWith(`${SCRATCHPAD_HASH}/`)) {
		// One name, a card's; anything more or less is the scratchpad itself.
		const names = decodeNames(fragment.slice(SCRATCHPAD_HASH.length + 1));
		const name = names?.length === 1 ? names[0] : undefined;
		return name === undefined || name === ''
			? { folder: SCRATCHPAD_FOLDER }
			: { folder: SCRATCHPAD_FOLDER, note: urlSlug(stem(name)) };
	}
	if (!fragment.startsWith('/')) return {};
	if (fragment === '/') return { folder: ROOT };
	const notebook = fragment.endsWith('/');
	const names = decodeNames(fragment.slice(1, notebook ? -1 : undefined));
	if (names === undefined || names.some((name) => name === '' || name.startsWith('.'))) {
		return {};
	}
	if (notebook) return { folder: slugPath(names.join('/')) };
	const note = urlSlug(stem(names.at(-1) ?? ''));
	return { folder: slugPath(names.slice(0, -1).join('/')), note };
};

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Not in a hidden folder, nor hidden itself: the app shows nothing there. */
const shown = (path: string): boolean => !path.split('/').some((name) => name.startsWith('.'));

/**
 * The notebook and note a hash names, among a source's: each compared as the
 * hash spells it. Two names can read the same — `Work Stuff` and `work-stuff`
 * — and then the first by path is the one a link opens; within the app nothing
 * goes by the slug, only by the id the entry holds. A note that is not there
 * leaves its notebook, and a notebook that is not there leaves nothing.
 */
export const findNamedPlace = <Note extends { path: string }>(
	named: NamedPlace,
	folders: readonly string[],
	notes: readonly Note[]
): { folder?: string; note?: Note } => {
	if (named.folder === undefined) return {};
	if (named.folder === SCRATCHPAD_FOLDER) {
		const [note] = notes
			.filter(
				(each) =>
					isScratchPath(each.path) && urlSlug(stem(basename(each.path))) === named.note
			)
			.sort((a, b) => byPath(a.path, b.path));
		return note === undefined
			? { folder: SCRATCHPAD_FOLDER }
			: { folder: SCRATCHPAD_FOLDER, note };
	}
	if (named.note !== undefined) {
		const [note] = notes
			.filter(
				(each) =>
					shown(each.path) &&
					slugPath(parentPath(each.path)) === named.folder &&
					urlSlug(stem(basename(each.path))) === named.note
			)
			.sort((a, b) => byPath(a.path, b.path));
		if (note !== undefined) return { folder: parentPath(note.path), note };
	}
	if (named.folder === ROOT) return { folder: ROOT };
	const [folder] = folders
		.filter((path) => shown(path) && slugPath(path) === named.folder)
		.sort(byPath);
	return folder === undefined ? {} : { folder };
};

/** The fragment of an href, without its `#`, exactly as it is written. */
export const fragmentOf = (href: string): string => {
	const at = href.indexOf('#');
	return at === -1 ? '' : href.slice(at + 1);
};

const optionalString = (value: unknown): value is string | undefined =>
	value === undefined || typeof value === 'string';

/**
 * The place a history entry holds. Anything can be in `history.state` — an
 * entry an older build wrote, or one some other script pushed — so it is taken
 * only in the shape this module writes.
 */
export const heldPlace = (state: unknown): HeldPlace | undefined => {
	if (typeof state !== 'object' || state === null || !('place' in state)) return undefined;
	const { place } = state;
	if (typeof place !== 'object' || place === null) return undefined;
	const { connectionId, folder, note } = place as Record<string, unknown>;
	if (typeof connectionId !== 'string' || !optionalString(folder) || !optionalString(note)) {
		return undefined;
	}
	return {
		connectionId,
		...(folder === undefined ? {} : { folder }),
		...(note === undefined ? {} : { note }),
	};
};

/** A place as an entry holds it, without keys for what it does not name. */
export const placeState = (connectionId: string, place: Place): PlaceState => ({
	place: {
		connectionId,
		...(place.folder === undefined ? {} : { folder: place.folder }),
		...(place.note === undefined ? {} : { note: place.note }),
	},
});

/** Whether two places are one: the same notebook and the same note. */
export const samePlace = (a: Place | undefined, b: Place | undefined): boolean =>
	a?.folder === b?.folder && a?.note === b?.note;

/** What a link to a note carries: its path to read, and its place to hold. */
export const noteLink = (note: {
	id: string;
	connectionId: string;
	path: string;
}): { hash: string; state: PlaceState } => {
	const folder = placeFolder(note.path);
	return {
		hash: placeHash(folder, note.path),
		state: placeState(note.connectionId, { folder, note: note.id }),
	};
};

export const TITLE_SEPARATOR = ' > ';

/**
 * The page's title for the note open: the notebooks it is in, outermost first,
 * and its title — `Work > Projects > Q3 plan`. A loose note is its title alone,
 * as the root is not a notebook. With nothing open, the app's own name.
 *
 * In the scratchpad, `Scratchpad`, and `Scratchpad > Shopping` while a card
 * with a name is open: one without (`named: false`) is a card, not a title.
 */
export const placeTitle = (
	note: { path: string; title: string; named?: boolean } | undefined,
	appName: string,
	folder?: string
): string => {
	if (note !== undefined && isScratchPath(note.path)) {
		return note.named === false
			? SCRATCHPAD_LABEL
			: [SCRATCHPAD_LABEL, note.title].join(TITLE_SEPARATOR);
	}
	if (note === undefined) {
		return folder !== undefined && isScratchPath(folder) ? SCRATCHPAD_LABEL : appName;
	}
	const notebook = parentPath(note.path);
	const notebooks = notebook === ROOT ? [] : notebook.split('/');
	return [...notebooks, note.title].join(TITLE_SEPARATOR);
};
