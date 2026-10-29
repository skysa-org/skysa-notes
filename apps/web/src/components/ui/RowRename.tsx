import { type ReactNode, useEffect, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';

/**
 * Where a row's name starts: in from the pane's edge by the gutter, by a step
 * per level it is nested, and by the room a notebook's chevron takes
 * (`--disclosure`), which a list with nothing nested in it does not set aside.
 */
export const rowIndent = (depth: number): string =>
	`calc(var(--gutter) + var(--disclosure, 0rem) + ${String(depth * 0.85)}rem)`;

/**
 * A row's name, being typed: a notebook's in the sidebar, a source's in a
 * compact window's source dropdown, and a source tab's in the bar
 * (`className`). The row stays as it was — its box, its highlight, its count —
 * and only the name in it becomes a field, so nothing moves when it becomes
 * editable. Not the row's own button with a field in it, which HTML does not
 * allow, but a box drawn as the row is (`.row-editing`), or as the tab is.
 *
 * Each keystroke is told (`onDraft`), so what else shows the name can say what
 * is typed (`store/renaming.ts`).
 *
 * Escape abandons it and Enter takes it, which is the pair every rename in
 * this app has. Blur takes it too: a click somewhere else is not "cancel", and
 * a field that threw the name away because the user looked at the note they
 * were naming it after would be its own bug report.
 *
 * The text starts selected. A rename is nearly always a replacement — "Dropbox
 * 2" into "Work" — and the alternative is every user clearing the field by
 * hand before they can start.
 */
export const RowRename = ({
	name,
	depth = 0,
	selected,
	count,
	maxLength,
	mark,
	className,
	width = 0,
	onDraft,
	onDone,
}: {
	name: string;
	depth?: number;
	selected: boolean;
	count?: number;
	maxLength?: number;
	/** In front of the field, where it is in front of the name on the row: a source's. */
	mark?: ReactNode;
	/**
	 * A box of the caller's own instead of the row's: the source tab's, which
	 * the field stands in for and whose classes it wears, so it has the tab's
	 * padding, type and lit edge. No indent and no count, and the mark straight
	 * in front of the field, as it is in the tab.
	 */
	className?: string;
	/**
	 * The box's width, pinned: the tab's own, measured on the way in. An input
	 * is as wide as its `size`, not its text, so a box left to its content
	 * would jump to a width of its own and push every tab after it sideways.
	 * Nothing is pinned at 0, which is all jsdom ever measures.
	 */
	width?: number;
	onDraft?: (text: string) => void;
	/** The chosen name, or nothing at all when the rename was abandoned. */
	onDone: (chosen?: string) => void;
}) => {
	const [draft, setDraft] = useState(name);
	const field = useRef<HTMLInputElement>(null);
	const done = useRef(false);

	useEffect(() => {
		// Focus first, and not `select()` alone: `select()` focuses as a side
		// effect in a browser and does not everywhere, which leaves a field that
		// looks ready and swallows the first thing typed into it.
		field.current?.focus();
		field.current?.select();
	}, []);

	// Once. Escape blurs the field, and a blur handler that had not been told
	// the rename was abandoned would put the typed name back in.
	const finish = (chosen?: string) => {
		if (done.current) return;
		done.current = true;
		onDone(chosen);
	};

	const input = (
		<input
			ref={field}
			className="row-rename"
			aria-label={t('rows.rename', { name })}
			value={draft}
			{...(maxLength === undefined ? {} : { maxLength })}
			onChange={(event) => {
				setDraft(event.target.value);
				onDraft?.(event.target.value);
			}}
			onKeyDown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					finish(draft);
				}
				if (event.key === 'Escape') {
					event.preventDefault();
					finish();
				}
			}}
			onBlur={() => {
				finish(draft);
			}}
		/>
	);

	if (className !== undefined) {
		return (
			<span
				className={className}
				{...(width > 0 ? { style: { width: `${String(width)}px` } } : {})}
			>
				{mark}
				{input}
			</span>
		);
	}

	return (
		<span
			className={selected ? 'row-editing selected' : 'row-editing'}
			style={{ paddingInlineStart: rowIndent(depth) }}
		>
			{mark === undefined ? (
				input
			) : (
				<span className="row-marked">
					{mark}
					{input}
				</span>
			)}
			{count !== undefined && count > 0 && <span className="count">{count}</span>}
		</span>
	);
};
