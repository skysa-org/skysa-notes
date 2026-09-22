/**
 * How code blocks are shown: wrapped or scrolling, numbered or not.
 *
 * Neither is part of a note. A fence can hold the word `js` and nothing else —
 * there is no way to write "wrap this one" in markdown — so these are the
 * app's, not the file's: one setting each, for every code block in every note,
 * kept in the prefs table beside the default editor mode (`store/prefs.ts`).
 * The buttons that change them sit on a block because that is where the reader
 * is when they want them, not because the block owns the answer.
 *
 * A store rather than a value, and the same shape as `editor/format.ts`'s, for
 * the same reason: the editor is not React, the toolbar is, and both have to
 * hear about a change. The editor plugins subscribe; `useCodeDisplay` loads the
 * stored value into it and writes changes back.
 */

export interface CodeDisplay {
	/** Long lines fold instead of scrolling sideways. */
	readonly wrap: boolean;
	/** A number in the gutter against every line. */
	readonly lineNumbers: boolean;
}

export const DEFAULT_CODE_DISPLAY: CodeDisplay = { wrap: false, lineNumbers: false };

export interface CodeDisplayStore {
	get: () => CodeDisplay;
	set: (next: CodeDisplay) => void;
	subscribe: (listener: () => void) => () => void;
}

const same = (a: CodeDisplay, b: CodeDisplay): boolean =>
	a.wrap === b.wrap && a.lineNumbers === b.lineNumbers;

export const createCodeDisplayStore = (
	initial: CodeDisplay = DEFAULT_CODE_DISPLAY
): CodeDisplayStore => {
	const held = { current: initial };
	const listeners = new Set<() => void>();

	return {
		get: () => held.current,
		// A value equal to the one held is not a change. It matters here rather
		// than merely being tidy: every listener redraws a block, and the stored
		// value arriving from IndexedDB on open is usually the value already in
		// hand.
		set: (next) => {
			if (same(held.current, next)) return;
			held.current = next;
			listeners.forEach((listener) => {
				listener();
			});
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};

/**
 * The one the app uses. A singleton because the setting is the app's and not a
 * note's: two editors open on two notes would still be showing one preference.
 * Everything that reads it takes it as an argument, so a test can hand over one
 * of its own.
 */
export const codeDisplay = createCodeDisplayStore();
