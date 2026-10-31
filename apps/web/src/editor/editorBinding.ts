import { type RefObject, useLayoutEffect, useMemo } from 'react';

import { useLatest } from '../hooks/useLatest.js';
import { useIncomingBody } from './incoming.js';
import { keepSecrets } from './secretPanels.js';

/**
 * What became of a body handed to an editor: it already said what the editor
 * shows, it replaced the text, or the editor could not take it in.
 */
export type Adoption = 'same' | 'replaced' | 'refused';

interface EditorBindingOptions {
	/** Identity of the note being edited. */
	readonly noteId: string;
	readonly body: string;
	readonly origin: string | undefined;
	readonly onUserEdit: (body: string, origin: string) => void;
	readonly onAdopted: (() => void) | undefined;
	/** The view the editor's secret panels are under, while there is one. */
	readonly view: RefObject<object | null>;
}

interface EditorBinding {
	/** The user has made the text `markdown`. */
	readonly edited: (markdown: string) => void;
	/**
	 * `value`, arriving at the editor, taken in by `take` where it should be;
	 * the answer is whether it was asked to. Only a body the editor now holds
	 * moves what its edits are made against: one it refused under a new origin
	 * is asked about again. And only one that changed the text has replaced it:
	 * a body that already says what the document does leaves what the user
	 * typed where it was (#444).
	 */
	readonly adopt: (value: string, take: () => Adoption) => boolean;
}

/**
 * What an editor takes from outside and hands back, the same in both editors:
 * what is typed reported with the origin it was typed into, a body from outside
 * taken in only where it is new, and a secret's panel kept before the editor
 * goes. Each editor says only how it holds text, and which view its panels are
 * under.
 */
export const useEditorBinding = ({
	noteId,
	body,
	origin,
	onUserEdit,
	onAdopted,
	view,
}: EditorBindingOptions): EditorBinding => {
	// Read when called, so changing them does not rebuild the editor.
	const notify = useLatest(onUserEdit);
	const replaced = useLatest(onAdopted);
	const incoming = useIncomingBody(noteId, body, origin);

	// A word an input method is still composing in a secret's panel is not in
	// the note until then. A layout effect's cleanup, so it runs before any
	// passive one: the note's autosave flushes in its own as the note is left,
	// and must find the edit there.
	useLayoutEffect(
		() => () => {
			if (view.current !== null) keepSecrets(view.current);
		},
		[noteId, view]
	);

	return useMemo(
		() => ({
			edited: (markdown) => {
				incoming.emit(markdown);
				notify.current(markdown, incoming.base());
			},
			adopt: (value, take) => {
				if (!incoming.shouldAdopt(value)) return false;
				const adoption = take();
				if (adoption !== 'refused') incoming.adopted();
				if (adoption === 'replaced') replaced.current?.();
				return true;
			},
		}),
		[incoming, notify, replaced]
	);
};
