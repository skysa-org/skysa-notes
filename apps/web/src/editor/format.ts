import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list';
import type { EditorState } from '@milkdown/kit/prose/state';

import { LINK_MARK } from './commands.js';
import { listAround, type ListKind } from './lists.js';

/**
 * What the editor's selection is, in the terms the toolbar draws itself in.
 *
 * A pure reading of a ProseMirror state, so the part worth testing — which
 * button is lit, which is disabled, which style the menu says the block is —
 * can be tested against a real document without a toolbar to look at.
 */

export interface FormatState {
	/** 0 when the block is plain text, otherwise the heading level. */
	level: number;
	/** The names of the marks the selection carries. */
	marks: readonly string[];
	/** The kind of list the selection is in, if it is in one. */
	list: ListKind | null;
	/** Whether the list item could be nested one deeper. */
	canIndent: boolean;
	/** Whether the list item could be lifted one out. */
	canOutdent: boolean;
	/** The URL of the link the selection is in, if it is in one. */
	link: string | null;
}

/** What an editor that has not been built yet, or a note that has none, is. */
export const NO_FORMAT: FormatState = {
	level: 0,
	marks: [],
	list: null,
	canIndent: false,
	canOutdent: false,
	link: null,
};

const HEADING = 'heading';
const LIST_ITEM = 'list_item';

/** Every mark the toolbar has a button for. */
const MARKS = ['strong', 'emphasis', 'strike_through', 'inlineCode', LINK_MARK];

/**
 * A mark is active where the selection carries it anywhere — which is exactly
 * when pressing the button would take it *off*, because `toggleMark` asks the
 * same question of the same range. A lit button and the press that follows it
 * therefore agree, which matters more here than a stricter reading would: over
 * a bold word and half a plain one, "bold" is what the next press undoes.
 *
 * With nothing selected the question is instead what typing on would produce,
 * and that is what `storedMarks` holds: pressing bold on a collapsed cursor
 * changes no text, and the button has to be able to show that it did anything
 * at all.
 */
const activeMarks = (state: EditorState): readonly string[] => {
	const { from, to, empty, $from } = state.selection;
	const here = state.storedMarks ?? $from.marks();

	return MARKS.filter((name) => {
		const type = state.schema.marks[name];
		if (type === undefined) return false;
		if (empty) return here.some((mark) => mark.type === type);
		return state.doc.rangeHasMark(from, to, type);
	});
};

const headingLevel = (state: EditorState): number => {
	const { $from } = state.selection;
	if ($from.parent.type.name !== HEADING) return 0;
	const level: unknown = $from.parent.attrs.level;
	return typeof level === 'number' ? level : 0;
};

const linkAt = (state: EditorState): string | null => {
	const type = state.schema.marks[LINK_MARK];
	if (type === undefined) return null;

	const { $from } = state.selection;
	const mark =
		(state.storedMarks ?? $from.marks()).find((held) => held.type === type) ??
		$from.nodeAfter?.marks.find((held) => held.type === type);

	const href: unknown = mark?.attrs.href;
	return typeof href === 'string' ? href : null;
};

/**
 * Whether the indent buttons would do anything, asked of the commands
 * themselves rather than guessed at from the selection: `sinkListItem` refuses
 * the first item of a list, because there is nothing above it to nest under,
 * and a button that is lit and does nothing is worse than one that is grey.
 * Called without a dispatch, so it only answers.
 */
const indentable = (state: EditorState): { canIndent: boolean; canOutdent: boolean } => {
	const item = state.schema.nodes[LIST_ITEM];
	if (item === undefined) return { canIndent: false, canOutdent: false };
	return { canIndent: sinkListItem(item)(state), canOutdent: liftListItem(item)(state) };
};

/** Read the toolbar's state out of the editor's. */
export const readFormat = (state: EditorState): FormatState => ({
	level: headingLevel(state),
	marks: activeMarks(state),
	list: listAround(state)?.kind ?? null,
	link: linkAt(state),
	...indentable(state),
});

const sameMarks = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((name, index) => name === b[index]);

/** Whether two readings say the same thing, so that most keystrokes redraw nothing. */
export const sameFormat = (a: FormatState, b: FormatState): boolean =>
	a.level === b.level &&
	a.list === b.list &&
	a.link === b.link &&
	a.canIndent === b.canIndent &&
	a.canOutdent === b.canOutdent &&
	sameMarks(a.marks, b.marks);

/**
 * Where the toolbar reads its state from.
 *
 * The toolbar is not a ProseMirror plugin view — it sits above the editor
 * rather than floating over the text — so the editor cannot hand it a state on
 * every transaction the way it does the selection toolbar. This is the seam
 * instead: the editor pushes, the toolbar subscribes, and `useSyncExternalStore`
 * redraws only the toolbar rather than the component the editor is mounted in.
 */
export interface FormatStore {
	get: () => FormatState;
	set: (state: FormatState) => void;
	subscribe: (listener: () => void) => () => void;
}

export const createFormatStore = (): FormatStore => {
	const held = { current: NO_FORMAT };
	const listeners = new Set<() => void>();

	return {
		get: () => held.current,
		// A reading equal to the one held is not a change, and saying it is would
		// redraw the toolbar on every keystroke.
		set: (next) => {
			if (sameFormat(held.current, next)) return;
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
