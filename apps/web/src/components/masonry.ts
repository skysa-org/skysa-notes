/**
 * Where each scratchpad card goes (docs/ARCHITECTURE.md §7, "The scratchpad"):
 * columns of cards of their own heights, each card in turn put at the foot of
 * the shortest column, so the wall reads across and then down in the order the
 * cards come in — the pinned, then the newest — and no column runs on far past
 * the others. Pure, so the rules are tested without a layout engine.
 *
 * CSS has no masonry that ships (`grid-template-rows: masonry` is behind a
 * flag), and CSS columns fill one column top to bottom before the next, which
 * would put the newest card first and the second newest at the foot of a
 * column, a screen away.
 */

/** The widest a card is drawn. */
export const CARD_MAX = 240;

/** The room between two cards, across and down. */
export const CARD_GAP = 12;

/**
 * How many columns there are in a wall `width` pixels across: as many cards at
 * their widest as fit, and never fewer than two, which on a small phone is two
 * cards narrower than their widest.
 */
export const columnCount = (width: number): number =>
	Math.max(2, Math.floor((width + CARD_GAP) / (CARD_MAX + CARD_GAP)));

export interface Placed {
	readonly x: number;
	readonly y: number;
}

export interface Wall {
	readonly places: readonly Placed[];
	/** Every card's width. */
	readonly cardWidth: number;
	/** Where the first column starts, the columns being centred. */
	readonly left: number;
	/** The wall's height: its tallest column. */
	readonly height: number;
}

/**
 * Each card's place, for cards of these heights in a wall `width` pixels
 * across, the columns centred in it. Ties go to the leftmost column, so cards
 * of one height fill a row left to right.
 */
export const placeCards = (heights: readonly number[], width: number): Wall => {
	const columns = columnCount(width);
	const cardWidth = Math.min(CARD_MAX, (width - CARD_GAP * (columns - 1)) / columns);
	const across = cardWidth * columns + CARD_GAP * (columns - 1);
	const left = Math.max(0, (width - across) / 2);
	const start = {
		places: [] as readonly Placed[],
		tops: Array.from({ length: columns }, () => 0) as readonly number[],
	};
	const { places, tops } = heights.reduce((wall, height) => {
		const shortest = wall.tops.indexOf(Math.min(...wall.tops));
		const top = wall.tops[shortest] ?? 0;
		return {
			places: [...wall.places, { x: left + shortest * (cardWidth + CARD_GAP), y: top }],
			tops: wall.tops.map((each, at) => (at === shortest ? each + height + CARD_GAP : each)),
		};
	}, start);
	return { places, cardWidth, left, height: Math.max(0, Math.max(...tops) - CARD_GAP) };
};

/**
 * A card's height before it has been drawn to be measured: a guess from how
 * much text it holds, at the width it will have, so the first frame is near
 * enough to the second that nothing is seen to jump.
 */
export const guessHeight = (
	card: Readonly<{ title: boolean; lines: readonly string[] }>,
	cardWidth: number
): number => {
	const perLine = Math.max(8, Math.floor((cardWidth - 24) / 7.5));
	const lines = card.lines.reduce(
		(count, line) => count + Math.max(1, Math.ceil(line.length / perLine)),
		0
	);
	return 24 + (card.title ? 24 : 0) + Math.max(1, lines) * 21;
};
