/**
 * Work over a whole library, done on the main thread a slice at a time (#275):
 * search's index, and every file of an import or a pull read before the
 * transaction that writes them. Done in one piece, it was a second, or ten,
 * on a phone, in which nothing the user did was answered.
 */

/**
 * How long a slice holds the thread, in milliseconds. A key pressed meanwhile
 * waits for at most one slice, where it waited for the whole of the work when
 * that was one piece.
 */
export const SLICE_MS = 8;

/**
 * The thread handed back for a turn, so whatever is waiting — a key, a frame —
 * goes before the next slice. A message rather than `setTimeout(0)`, which
 * browsers hold back to 4 ms once timeouts have nested five deep: work of a
 * hundred slices would spend half as long again doing nothing.
 */
export const handBack = (): Promise<void> =>
	new Promise((resolve) => {
		const { port1, port2 } = new MessageChannel();
		port1.addEventListener(
			'message',
			() => {
				port1.close();
				resolve();
			},
			{ once: true }
		);
		port1.start();
		port2.postMessage(null);
	});

/**
 * The most items a slice takes, however fast they go: each slice copies the
 * items it may take, and copying all of those left, slice after slice, is
 * work that grows with the square of them.
 */
const SLICE_ITEMS = 256;

/**
 * `work` done to every item from `from` on, in order, the thread handed back
 * after each `SLICE_MS`, or `SLICE_ITEMS`. The first slice is done before this
 * returns, so a handful of items is done at once.
 */
export const eachInSlices = async <T>(
	items: readonly T[],
	work: (item: T) => void,
	from = 0
): Promise<void> => {
	const until = performance.now() + SLICE_MS;
	const next = { current: from };
	items.slice(from, from + SLICE_ITEMS).some((item) => {
		work(item);
		next.current += 1;
		return performance.now() >= until;
	});
	if (next.current >= items.length) return;
	await handBack();
	await eachInSlices(items, work, next.current);
};
