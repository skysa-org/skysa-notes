import { useEffect, useRef, useState } from 'react';

/**
 * A row's name, being typed: a notebook's in the sidebar, a source's in a
 * compact window's source dropdown. The same shape the source tabs use: the
 * row stays as it was — its box, its highlight, its count — and only the name
 * in it becomes a field, so nothing moves when it becomes editable. Not the
 * row's own button with a field in it, which HTML does not allow, but a box
 * drawn as the row is (`.row-editing`).
 *
 * Each keystroke is told (`onDraft`), so what else shows the name can say what
 * is typed (`store/renaming.ts`).
 */
export const RowRename = ({
	name,
	depth = 0,
	selected,
	count,
	maxLength,
	onDraft,
	onDone,
}: {
	name: string;
	depth?: number;
	selected: boolean;
	count?: number;
	maxLength?: number;
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

	return (
		<span
			className={selected ? 'row-editing selected' : 'row-editing'}
			style={{ paddingInlineStart: `calc(var(--gutter) + ${String(depth * 0.85)}rem)` }}
		>
			<input
				ref={field}
				className="row-rename"
				aria-label={`Rename ${name}`}
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
			{count !== undefined && count > 0 && <span className="count">{count}</span>}
		</span>
	);
};
