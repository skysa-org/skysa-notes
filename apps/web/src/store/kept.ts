/**
 * How long the app's lists have been, for the caches every row asks again on
 * every draw (#275): a row's opening (`visibleText`), a card's frontmatter
 * (`frontmatter`). A cache bounded under the rows drawn is no cache, since
 * drawing the list again asks for every row in the order the last draw put
 * them out, so each is kept for as many rows as the lists have shown, and a
 * quarter more for what is drawn beside them.
 */

/** How much more than the lists' rows is kept: what is drawn beside them. */
const ROOM = 1.25;

/**
 * The longest each list has been, by name. Summed, though only one is drawn at
 * a time, so going between a notebook and the scratchpad asks neither again.
 */
const lists = new Map<string, number>();

/**
 * Keep room for `list`'s `count` rows. Only ever grows: a list shown once is
 * likely shown again, and what is kept for it is of notes that are on the
 * device anyway.
 */
export const keepRows = (list: string, count: number): void => {
	if (count > (lists.get(list) ?? 0)) lists.set(list, count);
};

/** Room for every row the lists have shown, and a quarter more; `floor` at least. */
export const roomFor = (floor: number): number =>
	Math.max(floor, Math.ceil([...lists.values()].reduce((sum, each) => sum + each, 0) * ROOM));
