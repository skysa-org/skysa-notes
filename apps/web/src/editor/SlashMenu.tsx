import { SlashProvider } from '@milkdown/kit/plugin/slash';
import { useInstance } from '@milkdown/react';
import { usePluginViewContext } from '@prosemirror-adapter/react';
import { useEffect, useRef, useState } from 'react';

import { BLOCK_COMMANDS } from './commands.js';
import {
	matchCommands,
	moveHighlight,
	slashKeyAction,
	slashQuery,
	textBeforeCursor,
} from './slash.js';

/**
 * The `/` menu. `slash.ts` decides what the query matches and what a keypress
 * means; this renders that and runs the chosen command.
 *
 * Nothing here is remembered between renders except the highlight: the query is
 * read from the document every time, so the menu cannot drift out of step with
 * what the user has actually typed.
 */

export const SlashMenu = () => {
	const { view, prevState } = usePluginViewContext();
	const [loading, getEditor] = useInstance();

	const host = useRef<HTMLDivElement>(null);
	const provider = useRef<SlashProvider>(null);

	/** Paired with the query it belongs to, so a changed query resets it without an effect. */
	const [highlight, setHighlight] = useState<{ query: string; index: number }>({
		query: '',
		index: 0,
	});

	const query = slashQuery(textBeforeCursor(view));
	const items = query === undefined ? [] : matchCommands(query, BLOCK_COMMANDS);
	const open = query !== undefined && items.length > 0;
	const index = highlight.query === query ? Math.min(highlight.index, items.length - 1) : 0;

	useEffect(() => {
		const content = host.current;
		if (content === null) return;

		const instance = new SlashProvider({
			content,
			// The menu's own state is derived from the document on every render, so
			// a debounce here would only make the frame it is drawn in disagree
			// with the keys the user is pressing.
			debounce: 0,
			shouldShow: (current) => slashQuery(textBeforeCursor(current)) !== undefined,
		});
		provider.current = instance;

		return () => {
			instance.destroy();
			instance.element.remove();
			provider.current = null;
		};
	}, []);

	useEffect(() => {
		if (open) provider.current?.show();
		else provider.current?.hide();
		provider.current?.update(view, prevState);
	});

	const select = (position: number) => {
		const item = items[position];
		const editor = getEditor();
		if (item === undefined || query === undefined || editor === undefined || loading) return;

		// Take the "/query" out of the document first. It is the user's own text,
		// so this is an edit like any other — the note is meant to become dirty.
		const { state } = view;
		const to = state.selection.from;
		view.dispatch(state.tr.delete(to - (query.length + 1), to));

		editor.action(item.apply);
		view.focus();
	};

	useEffect(() => {
		// `open` is false unless there is a query, which narrows it for the rest.
		if (!open) return;

		const onKeyDown = (event: KeyboardEvent) => {
			const action = slashKeyAction(event.key);
			if (action.kind === 'ignore') return;

			// The editor must not also act on these: Enter would split the
			// paragraph out from under the command about to run.
			event.preventDefault();
			event.stopPropagation();

			if (action.kind === 'move')
				setHighlight({
					query,
					index: moveHighlight(index, action.delta, items.length),
				});
			if (action.kind === 'select') select(index);
			if (action.kind === 'close') provider.current?.hide();
		};

		view.dom.addEventListener('keydown', onKeyDown, true);
		return () => {
			view.dom.removeEventListener('keydown', onKeyDown, true);
		};
	});

	return (
		<div className="slash-menu" ref={host} role="listbox" aria-label="Insert">
			{items.map((item, position) => (
				<button
					type="button"
					key={item.id}
					className={position === index ? 'slash-item selected' : 'slash-item'}
					role="option"
					aria-selected={position === index}
					// The editor keeps focus, so this has to happen before the
					// browser moves it and collapses the selection.
					onMouseDown={(event) => {
						event.preventDefault();
						select(position);
					}}
					onMouseEnter={() => {
						setHighlight({ query: query ?? '', index: position });
					}}
				>
					{item.label}
				</button>
			))}
		</div>
	);
};
