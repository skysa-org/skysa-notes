import { TooltipProvider } from '@milkdown/kit/plugin/tooltip';
import { TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { useInstance } from '@milkdown/react';
import { usePluginViewContext } from '@prosemirror-adapter/react';
import { useEffect, useRef } from 'react';

import { codeBlockAround } from './codeTools.js';
import { INLINE_COMMANDS } from './commands.js';

/**
 * Formatting for the current selection, shown where the selection is.
 *
 * Only marks the markdown can hold, so there is nothing here that would be lost
 * on the way to the file.
 *
 * Named apart from the bar across the top of the editor (`FormatToolbar`),
 * which is also a toolbar and also formats: two of them answering to
 * "Formatting" would leave a screen reader with no way to say which one it had
 * reached.
 */

/**
 * When the toolbar is worth showing.
 *
 * The first rule is this app's: a code block holds no marks, so selecting a few
 * words of a code sample brings up nothing that could be pressed — the bar
 * across the top greys those buttons for the same reason, and one that floats
 * over the words has no way to say "not here" except by not appearing.
 *
 * The rest is Milkdown's own answer, restated rather than extended, because a
 * `shouldShow` passed to the provider *replaces* its predicate instead of
 * adding to it. Each line of it is a case this toolbar would otherwise appear
 * for: a caret that has selected nothing, an empty block the cursor happens to
 * be in, a note being read rather than edited, and a click that took focus
 * somewhere else entirely — anywhere but into the toolbar itself, where focus
 * belongs while one of its own buttons is being pressed.
 */
export const shouldShowInlineToolbar =
	(content: HTMLElement) =>
	(view: EditorView): boolean => {
		const { state } = view;
		const { selection } = state;

		if (codeBlockAround(state) !== null) return false;

		if (!view.editable) return false;
		if (!view.hasFocus() && !content.contains(document.activeElement)) return false;
		if (selection.empty) return false;
		return (
			state.doc.textBetween(selection.from, selection.to).length > 0 ||
			!(selection instanceof TextSelection)
		);
	};

export const InlineToolbar = () => {
	const { view, prevState } = usePluginViewContext();
	const [loading, getEditor] = useInstance();

	const host = useRef<HTMLDivElement>(null);
	const provider = useRef<TooltipProvider>(null);

	useEffect(() => {
		const content = host.current;
		if (content === null) return;

		const instance = new TooltipProvider({
			content,
			debounce: 20,
			offset: 8,
			shouldShow: shouldShowInlineToolbar(content),
		});
		provider.current = instance;

		return () => {
			instance.destroy();
			instance.element.remove();
			provider.current = null;
		};
	}, []);

	useEffect(() => {
		provider.current?.update(view, prevState);
	});

	return (
		<div className="inline-toolbar" ref={host} role="toolbar" aria-label="Selection formatting">
			{INLINE_COMMANDS.map((command) => (
				<button
					type="button"
					key={command.id}
					className="toolbar-button"
					title={command.label}
					aria-label={command.label}
					// Before the browser moves focus and drops the selection.
					onMouseDown={(event) => {
						event.preventDefault();
						const editor = getEditor();
						if (editor === undefined || loading) return;
						editor.action(command.apply);
					}}
				>
					{command.label}
				</button>
			))}
		</div>
	);
};
