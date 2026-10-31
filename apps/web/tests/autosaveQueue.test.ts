import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	type Attempt,
	AUTOSAVE_RETRY_MS,
	createHeld,
	type Save,
} from '../src/editor/shared/autosaveQueue.js';

/**
 * The queue on its own, with no hook around it: what is kept, what is tried
 * again, and what a later edit lets go of. `useAutosave.test.tsx` covers the
 * same promises through the hook, with a debounce and a render in the way of
 * every order of events; here a test can say which write comes back when.
 */

/** A write that comes back when the test says. */
const out = () => {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	return { promise, works: () => resolve(), fails: () => reject(new Error('refused')) };
};

/** Time for what a settled write set off to have run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

const queue = ({
	supersedes,
	mounted = true,
}: { supersedes?: (next: string, pending: string) => boolean; mounted?: boolean } = {}) => {
	const failing = vi.fn<(now: boolean) => void>();
	const again = vi.fn<() => void>();
	const held = createHeld<string>({
		supersedes: () => supersedes,
		failing,
		mounted: () => mounted,
		again,
	});
	/** One edit of note `a` in the first sitting, unless it says otherwise. */
	const issue = (
		value: string,
		save: Save<string>,
		edit: Partial<Pick<Attempt<string>, 'key' | 'sitting' | 'overtaken'>> = {},
		tried = new Set<Attempt<string>>()
	) => {
		held.issue({ value, save, key: 'a', sitting: 1, ...edit }, tried);
	};
	return { held, issue, failing, again };
};

const refuses: Save<string> = () => Promise.reject(new Error('refused'));

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('createHeld', () => {
	it('writes an edit at once and keeps nothing once it is stored', () => {
		const { held, issue, failing } = queue();
		const save = vi.fn<Save<string>>();

		issue('one', save);

		expect(save).toHaveBeenCalledExactlyOnceWith('one');
		expect(failing).toHaveBeenLastCalledWith(false);
		expect(held.unstored()).toEqual([]);
	});

	it('holds what a save threw on as it does what one refused', async () => {
		const { held, issue, failing } = queue();

		issue('one', () => {
			throw new Error('refused');
		});
		expect(held.unstored()).toEqual(['a']);
		expect(failing).toHaveBeenLastCalledWith(true);

		issue('other', refuses, { key: 'b' });
		await settle();
		expect(held.unstored()).toEqual(['a', 'b']);
	});

	it('names a note once, however many of its edits are held', async () => {
		const { held, issue } = queue({ supersedes: () => false });

		issue('one', refuses);
		await settle();
		issue('two', refuses);
		await settle();

		expect(held.unstored()).toEqual(['a']);
	});

	it('runs the retry timer while something is failing, and stops when nothing is', async () => {
		const { held, issue, again } = queue();

		issue('one', refuses);
		await settle();
		await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MS - 1);
		expect(again).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(again).toHaveBeenCalledTimes(1);

		held.forget('a');
		await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MS * 3);
		expect(again).toHaveBeenCalledTimes(1);
	});

	it('runs no retry timer once the editor has gone', async () => {
		const { issue, again } = queue({ mounted: false });

		issue('one', refuses);
		await settle();
		await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MS * 3);

		expect(again).not.toHaveBeenCalled();
	});

	it('stops the retry timer when told to', async () => {
		const { held, issue, again } = queue();

		issue('one', refuses);
		await settle();
		held.stop();
		await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MS * 3);

		expect(again).not.toHaveBeenCalled();
	});
});

describe('createHeld, when a newer edit stands for an older one', () => {
	it('lets a failed edit go as soon as a newer one is issued', async () => {
		const { held, issue, failing } = queue();

		issue('one', refuses);
		await settle();
		issue('two', vi.fn<Save<string>>());

		expect(held.unstored()).toEqual([]);
		expect(failing).toHaveBeenLastCalledWith(false);
	});

	it('lets an older write that fails late go, once a newer one is stored', async () => {
		const { held, issue } = queue();
		const first = out();

		issue('one', () => first.promise);
		issue('two', vi.fn<Save<string>>());
		first.fails();
		await settle();

		expect(held.unstored()).toEqual([]);
	});

	it('lets an older write that fails late go while the newer one is still out', async () => {
		const { held, issue } = queue();
		const first = out();
		const second = out();

		issue('one', () => first.promise);
		issue('two', () => second.promise);
		first.fails();
		await settle();
		expect(held.unstored()).toEqual([]);

		// And the newer one failing is held in its turn, so the text is never without cover.
		second.fails();
		await settle();
		expect(held.unstored()).toEqual(['a']);
	});

	it('keeps an edit a newer one does not stand for, and says it is displaced', async () => {
		const { held, issue } = queue({ supersedes: () => false });
		const first = vi.fn<Save<string>>(() => Promise.reject(new Error('refused')));

		issue('one', first);
		await settle();
		issue('two', vi.fn<Save<string>>());
		expect(held.unstored()).toEqual(['a']);

		first.mockImplementation(() => undefined);
		held.retry(new Set());
		await settle();

		expect(first).toHaveBeenLastCalledWith('one', { displaced: true });
		expect(held.unstored()).toEqual([]);
	});

	it('does not stand for an edit of another note', async () => {
		const { held, issue } = queue();

		issue('one', refuses);
		await settle();
		issue('other', vi.fn<Save<string>>(), { key: 'b' });

		expect(held.unstored()).toEqual(['a']);
	});

	it('does not stand for an edit of another sitting', async () => {
		const { held, issue } = queue();

		issue('one', refuses);
		await settle();
		issue('two', vi.fn<Save<string>>(), { sitting: 2 });

		expect(held.unstored()).toEqual(['a']);
	});

	it('writes an edit overtaken by a body from outside as displaced from the start', () => {
		const { issue } = queue();
		const save = vi.fn<Save<string>>();

		issue('one', save, { overtaken: true });

		expect(save).toHaveBeenCalledExactlyOnceWith('one', { displaced: true });
	});
});

describe('createHeld, trying again', () => {
	it('tries an edit with the save it was made for, not the last one issued', async () => {
		const { held, issue } = queue();
		const mine = vi.fn<Save<string>>(() => Promise.reject(new Error('refused')));
		const another = vi.fn<Save<string>>();

		issue('one', mine);
		await settle();
		issue('other', another, { key: 'b' });
		mine.mockClear();
		another.mockClear();

		held.retry(new Set());

		expect(mine).toHaveBeenCalledExactlyOnceWith('one');
		expect(another).not.toHaveBeenCalled();
	});

	it('tries each failed edit once a round', async () => {
		const { held, issue } = queue();
		const save = vi.fn<Save<string>>(() => Promise.reject(new Error('refused')));

		issue('one', save);
		await settle();
		save.mockClear();

		const tried = new Set<Attempt<string>>();
		held.retry(tried);
		held.retry(tried);
		await settle();
		held.retry(tried);

		expect(save).toHaveBeenCalledExactlyOnceWith('one');
	});

	it('does not try an edit whose note has a write out', async () => {
		const { held, issue } = queue({ supersedes: () => false });
		const first = vi.fn<Save<string>>(() => Promise.reject(new Error('refused')));
		const second = out();

		issue('one', first);
		await settle();
		first.mockClear();
		issue('two', () => second.promise);

		held.retry(new Set());
		expect(first).not.toHaveBeenCalled();

		second.works();
		await settle();
		held.retry(new Set());
		expect(first).toHaveBeenCalledTimes(1);
	});

	it('carries a round on as writes come back, until the failed have had their turn', async () => {
		const { held, issue } = queue({ supersedes: () => false });
		const first = vi.fn<Save<string>>(() => Promise.reject(new Error('refused')));
		const second = out();

		issue('one', first);
		await settle();
		first.mockClear();
		issue('two', () => second.promise);

		const tried = new Set<Attempt<string>>();
		held.retry(tried);
		const done = vi.fn<() => void>();
		void held.follow(tried, false).then(done);
		await settle();
		expect(done).not.toHaveBeenCalled();
		expect(first).not.toHaveBeenCalled();

		second.works();
		await settle();
		expect(first).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalled();
	});

	it('waits for every write out only when asked for all', async () => {
		const { held, issue } = queue();
		const write = out();

		issue('one', () => write.promise);

		const some = vi.fn<() => void>();
		const all = vi.fn<() => void>();
		void held.follow(new Set(), false).then(some);
		void held.follow(new Set(), true).then(all);
		await settle();
		expect(some).toHaveBeenCalled();
		expect(all).not.toHaveBeenCalled();

		write.works();
		await settle();
		expect(all).toHaveBeenCalled();
	});
});

describe('createHeld, asked to forget a note', () => {
	it('answers with the newest it let go, and never tries it again', async () => {
		const { held, issue, failing } = queue({ supersedes: () => false });
		const save = vi.fn<Save<string>>(() => Promise.reject(new Error('refused')));

		issue('one', save);
		await settle();
		issue('two', save);
		await settle();
		save.mockClear();

		expect(held.forget('a')).toEqual({ value: 'two', displaced: false });
		expect(failing).toHaveBeenLastCalledWith(false);
		held.retry(new Set());
		expect(save).not.toHaveBeenCalled();
	});

	it('says so when what it let go is not the newest for the note', () => {
		const { held, issue } = queue({ supersedes: () => false });
		const first = out();

		issue('one', () => first.promise);
		issue('two', vi.fn<Save<string>>());

		expect(held.forget('a')).toEqual({ value: 'one', displaced: true });
	});

	it('answers with nothing where everything was stored', () => {
		const { held, issue } = queue();

		issue('one', vi.fn<Save<string>>());

		expect(held.forget('a')).toBeUndefined();
	});

	it('keeps a write that was out from being tried again if it then fails', async () => {
		const { held, issue } = queue();
		const write = out();
		const save = vi.fn<Save<string>>(() => write.promise);

		issue('one', save);
		held.forget('a');
		write.fails();
		await settle();
		save.mockClear();

		expect(held.unstored()).toEqual([]);
		held.retry(new Set());
		expect(save).not.toHaveBeenCalled();
	});

	it('leaves another note alone', async () => {
		const { held, issue } = queue();

		issue('one', refuses);
		await settle();
		issue('other', refuses, { key: 'b' });
		await settle();
		held.forget('a');

		expect(held.unstored()).toEqual(['b']);
	});
});
