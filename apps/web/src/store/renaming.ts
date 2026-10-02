import { useSyncExternalStore } from 'react';

/**
 * A notebook or a source being renamed, as it is typed, so that everything on
 * screen naming it — the note list's heading, the bar's dropdowns, the open
 * note's path — says what the field says, and not what it said before Enter.
 * The notebook's own row is the field; everything else reads this.
 *
 * One at a time: a rename field takes the focus, so there is never a second.
 * Laid over what the store says for display and never written anywhere, the
 * same as a note's name (`liveEdits.ts`), and a store for the same reason: a
 * keystroke redraws what shows the name, not every pane in the app.
 *
 * A name given stays until the store has caught up with it, rather than going
 * when the rename's write resolves. Gone then, everything showing it would
 * show the old name for the moment the store takes to bring the new one, and
 * the name would flicker back to what it was.
 */
export interface Renaming {
	readonly kind: 'notebook' | 'source';
	/** The notebook's path, or the source's connection id. */
	readonly key: string;
	readonly text: string;
	/**
	 * Given, and waiting for the store: what the store called it then. A source
	 * the store calls something else has caught up (`shownSourceName`). A
	 * notebook's path is its name, so the route lets go of one once the open
	 * notebook is no longer at it.
	 */
	readonly given?: Readonly<{ was: string }>;
}

export interface Renamings {
	get: () => Renaming | undefined;
	subscribe: (listener: () => void) => () => void;
	/** The field says `text`. */
	typed: (kind: Renaming['kind'], key: string, text: string) => void;
	/** The name was given, over what the store called it then. */
	give: (kind: Renaming['kind'], key: string, was: string) => void;
	/** Done with — given up, or caught up with — if it is still this one. */
	clear: (kind: Renaming['kind'], key: string) => void;
}

export const createRenamings = (): Renamings => {
	const held: { current: Renaming | undefined } = { current: undefined };
	const listeners = new Set<() => void>();
	const put = (renaming: Renaming | undefined) => {
		held.current = renaming;
		listeners.forEach((listener) => {
			listener();
		});
	};
	const holds = (kind: Renaming['kind'], key: string) =>
		held.current?.kind === kind && held.current.key === key;

	return {
		get: () => held.current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		typed: (kind, key, text) => {
			put({ kind, key, text });
		},
		give: (kind, key, was) => {
			if (held.current !== undefined && holds(kind, key))
				put({ ...held.current, given: { was } });
		},
		clear: (kind, key) => {
			if (holds(kind, key)) put(undefined);
		},
	};
};

const nothing = () => () => undefined;

/** The rename being typed, or `undefined` with no store to read. */
export const useRenaming = (renamings: Renamings | undefined): Renaming | undefined =>
	useSyncExternalStore(renamings?.subscribe ?? nothing, () => renamings?.get());

/** What is typed, once there is something: an empty name is never given. */
const typed = (renaming: Renaming): string | undefined => {
	const text = renaming.text.trim();
	return text === '' ? undefined : text;
};

/**
 * A path as the user is seeing it: with the notebook being renamed under its
 * new name, when the path is that notebook or anything inside it.
 */
export const shownFolder = (path: string, renaming: Renaming | undefined): string => {
	if (renaming?.kind !== 'notebook') return path;
	const text = typed(renaming);
	const { key } = renaming;
	if (text === undefined || !(path === key || path.startsWith(`${key}/`))) return path;
	return `${key.slice(0, key.lastIndexOf('/') + 1)}${text}${path.slice(key.length)}`;
};

/**
 * A source's name as the user is seeing it: what is typed while it is typed,
 * and once given, until the store calls it something other than it did.
 */
export const shownSourceName = (
	connectionId: string,
	name: string,
	renaming: Renaming | undefined
): string => {
	if (renaming?.kind !== 'source' || renaming.key !== connectionId) return name;
	if (renaming.given !== undefined && renaming.given.was !== name) return name;
	return typed(renaming) ?? name;
};
