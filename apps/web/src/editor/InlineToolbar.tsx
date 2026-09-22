import { TooltipProvider } from '@milkdown/kit/plugin/tooltip';
import { useInstance } from '@milkdown/react';
import { usePluginViewContext } from '@prosemirror-adapter/react';
import { useEffect, useRef } from 'react';

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

export const InlineToolbar = () => {
	const { view, prevState } = usePluginViewContext();
	const [loading, getEditor] = useInstance();

	const host = useRef<HTMLDivElement>(null);
	const provider = useRef<TooltipProvider>(null);

	useEffect(() => {
		const content = host.current;
		if (content === null) return;

		const instance = new TooltipProvider({ content, debounce: 20, offset: 8 });
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
