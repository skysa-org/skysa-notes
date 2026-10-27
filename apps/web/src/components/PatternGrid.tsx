import { cell } from '@skysa/core';
import { useEffect, useRef } from 'react';

import { t } from '../i18n/t.js';

/**
 * A pattern on a 3×3 grid of dots, for unlocking the vault on this device
 * (docs/ARCHITECTURE.md §7, "Secrets in a note"). Drawn by dragging across the
 * dots, as a phone's lock screen is; or a dot at a time, with a press, Enter or
 * Space on each, or by typing its number, 1 to 9, left to right and top to
 * bottom, for a keyboard or a screen reader.
 *
 * A dot is in a pattern once. Going from one dot to another across a dot not
 * yet in it takes that one in on the way, as Android does, so a pattern is
 * one a phone could have drawn: what the count of them in the design is of.
 */

const SIZE = 3;
const DOTS = SIZE * SIZE;

/** The dot halfway between two, where there is one: across a side, or through the middle. */
const between = (from: number, to: number): number | undefined => {
	const [row, column] = [Math.floor(from / SIZE), from % SIZE];
	const [toRow, toColumn] = [Math.floor(to / SIZE), to % SIZE];
	const [rows, columns] = [toRow - row, toColumn - column];
	if (Math.abs(rows) % 2 === 1 || Math.abs(columns) % 2 === 1) return undefined;
	return (row + rows / 2) * SIZE + column + columns / 2;
};

/** `dots` with `dot` added, and any dot it passed over that was not in them yet. */
export const drawTo = (dots: readonly number[], dot: number): number[] => {
	if (dots.includes(dot)) return [...dots];
	const last = dots.at(-1);
	const passed = last === undefined ? undefined : between(last, dot);
	return passed === undefined || dots.includes(passed) ? [...dots, dot] : [...dots, passed, dot];
};

/** Where a dot's centre is, in the drawing's own units, 0 to 300 each way. */
const centre = (dot: number) => ({
	x: (dot % SIZE) * 100 + 50,
	y: Math.floor(dot / SIZE) * 100 + 50,
});

/** The dot under a point on the page, if any. */
const dotAt = (event: PointerEvent): number | undefined => {
	const under = document.elementFromPoint(event.clientX, event.clientY);
	const dot = under instanceof HTMLElement ? under.closest<HTMLElement>('[data-dot]') : null;
	return dot === null ? undefined : Number(dot.dataset.dot);
};

export interface PatternGridProps {
	dots: readonly number[];
	onChange: (dots: number[]) => void;
	/** A drag let go of: the pattern is as it will be. */
	onDrawn?: (dots: number[]) => void;
	disabled?: boolean;
}

export const PatternGrid = ({ dots, onChange, onDrawn, disabled = false }: PatternGridProps) => {
	const grid = useRef<HTMLDivElement>(null);
	/** What the page's listeners, added once, need of the latest render. */
	const latest = useRef({ dots, onChange, onDrawn, disabled });
	useEffect(() => {
		latest.current = { dots, onChange, onDrawn, disabled };
	}, [dots, onChange, onDrawn, disabled]);

	// A drag is the grid's: it starts on a dot and goes on over the others,
	// where a dot's own press would end at its edge. Listened to here, as the
	// dots are the controls a keyboard or a screen reader is given.
	useEffect(() => {
		const element = grid.current;
		if (element === null) return undefined;
		const drawing = cell<number[] | undefined>(undefined);
		const add = (dot: number) => {
			const next = drawTo(drawing.current ?? latest.current.dots, dot);
			if (drawing.current !== undefined) drawing.current = next;
			latest.current.onChange(next);
		};
		const onDown = (event: PointerEvent) => {
			const dot = dotAt(event);
			if (latest.current.disabled || dot === undefined) return;
			event.preventDefault();
			// Held, so the drag goes on outside the grid and its end is heard.
			// Not every pointer can be (jsdom's cannot).
			if ('setPointerCapture' in element) element.setPointerCapture(event.pointerId);
			drawing.current = [dot];
			latest.current.onChange([dot]);
		};
		const onMove = (event: PointerEvent) => {
			const drawn = drawing.current;
			if (drawn === undefined) return;
			const dot = dotAt(event);
			if (dot !== undefined && !drawn.includes(dot)) add(dot);
		};
		const onUp = () => {
			const drawn = drawing.current;
			drawing.current = undefined;
			if (drawn !== undefined) latest.current.onDrawn?.(drawn);
		};
		const onCancel = () => {
			drawing.current = undefined;
		};
		const onKey = (event: KeyboardEvent) => {
			const number = Number(event.key);
			if (
				latest.current.disabled ||
				!Number.isInteger(number) ||
				number < 1 ||
				number > DOTS
			) {
				return;
			}
			event.preventDefault();
			add(number - 1);
		};
		element.addEventListener('pointerdown', onDown);
		element.addEventListener('pointermove', onMove);
		element.addEventListener('pointerup', onUp);
		element.addEventListener('pointercancel', onCancel);
		element.addEventListener('keydown', onKey);
		return () => {
			element.removeEventListener('pointerdown', onDown);
			element.removeEventListener('pointermove', onMove);
			element.removeEventListener('pointerup', onUp);
			element.removeEventListener('pointercancel', onCancel);
			element.removeEventListener('keydown', onKey);
		};
	}, []);

	const points = dots.map(centre);

	return (
		<div className="pattern">
			<div
				ref={grid}
				className="pattern-grid"
				// Where the pattern is drawn: a dialog's field, so its first dot has the focus.
				data-dialog-field=""
				role="group"
				aria-label={t('secrets.pattern.label')}
			>
				<svg className="pattern-lines" viewBox="0 0 300 300" aria-hidden="true">
					<polyline points={points.map(({ x, y }) => `${x},${y}`).join(' ')} />
				</svg>
				{Array.from({ length: DOTS }, (_, dot) => (
					<button
						key={dot}
						type="button"
						className="pattern-dot"
						data-dot={dot}
						aria-label={t('secrets.pattern.dot', { number: dot + 1 })}
						aria-pressed={dots.includes(dot)}
						disabled={disabled}
						onClick={(event) => {
							// A press is a pointer's, which `pointerdown` has taken
							// already; a click with no pointer is Enter or Space.
							if (event.detail === 0) onChange(drawTo(dots, dot));
						}}
					>
						<span />
					</button>
				))}
			</div>
			<p className="pattern-count" aria-live="polite">
				{dots.length > 0 && t('secrets.pattern.dots', { count: dots.length })}
			</p>
		</div>
	);
};
