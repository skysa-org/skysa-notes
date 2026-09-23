/**
 * Which of the toolbar's controls fit, and which go into the overflow menu.
 *
 * Pure arithmetic over widths the toolbar has measured, so that it can be
 * tested without a layout engine — jsdom has none — and so the component is
 * left with measuring and nothing else.
 *
 * Controls are given up least-used first (`order`), not right to left. A
 * right-to-left overflow would bury the link, which people reach for, to keep
 * the indentation buttons, which they mostly do with Tab; the order is the
 * editor's judgement of what is used, and the bar keeps its left-to-right
 * arrangement of whatever is left.
 */

export interface FitSlot {
	id: string;
	/** The group the slot is drawn in, whose separator goes when it empties. */
	group: string;
	/** Its width on screen, as last measured. */
	width: number;
}

export interface FitInput {
	/** Every slot that could be shown, in the order they are drawn. */
	slots: readonly FitSlot[];
	/**
	 * What a group costs beyond its slots — its padding, its separator, the
	 * gaps between its slots — for each group as last measured. Charged in full
	 * while any of the group is shown, which over-counts a gap or two once
	 * part of it has gone: erring towards one more slot in the menu rather than
	 * one slot hanging off the end of the bar.
	 */
	groupCost: ReadonlyMap<string, number>;
	/** The gap between one group and the next. */
	gap: number;
	/** The room there is, inside the bar's padding. */
	available: number;
	/** The overflow button's width, charged only when it is shown. */
	overflowWidth: number;
	/** Slot ids, first to be given up first. A slot not named here stays. */
	order: readonly string[];
}

const required = (input: FitInput, hidden: ReadonlySet<string>): number => {
	const groups = input.slots
		.filter((slot) => !hidden.has(slot.id))
		.reduce(
			(widths, slot) => widths.set(slot.group, (widths.get(slot.group) ?? 0) + slot.width),
			new Map<string, number>()
		);
	const shown = [...groups].reduce(
		(sum, [group, width]) => sum + width + (input.groupCost.get(group) ?? 0),
		0
	);
	const overflowing = hidden.size > 0;
	// One more item on the bar when the overflow button is on it.
	const items = groups.size + (overflowing ? 1 : 0);
	return shown + Math.max(0, items - 1) * input.gap + (overflowing ? input.overflowWidth : 0);
};

/** The ids of the slots that do not fit, in no particular order. */
export const fitToolbar = (input: FitInput): ReadonlySet<string> => {
	const candidates = input.order.filter((id) => input.slots.some((slot) => slot.id === id));
	// The shortest run from the front of the order that leaves the rest fitting;
	// all of it, if nothing does.
	const count =
		Array.from({ length: candidates.length + 1 }, (_, at) => at).find(
			(at) => required(input, new Set(candidates.slice(0, at))) <= input.available
		) ?? candidates.length;
	return new Set(candidates.slice(0, count));
};

/** Whether two answers are the same, so a bar that fits is not redrawn. */
export const sameFit = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
	a.size === b.size && [...a].every((id) => b.has(id));
