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

/**
 * What `make` answers for a key, kept by the key for the next time it is asked,
 * at most `most()` of them. The least recently asked goes first, not the
 * first kept: a list drawn again asks for every row, and anything else asked in
 * between — a search answer, a card's new frontmatter — is what should go.
 *
 * `keep: false` answers without keeping, for a key asked once and never again
 * (a body being typed): one kept per keystroke would push every row out.
 */
export const keptAnswers = <Answer>(
	most: () => number
): ((key: string, make: (key: string) => Answer, keep?: boolean) => Answer) => {
	const seen = new Map<string, Answer>();
	return (key, make, keep = true) => {
		const known = seen.get(key);
		if (known !== undefined) {
			// To the back of the queue: asked again, so kept longest.
			seen.delete(key);
			seen.set(key, known);
			return known;
		}
		const answer = make(key);
		if (!keep) return answer;
		seen.set(key, answer);
		if (seen.size > most()) {
			const oldest = seen.keys().next();
			if (oldest.done !== true) seen.delete(oldest.value);
		}
		return answer;
	};
};
