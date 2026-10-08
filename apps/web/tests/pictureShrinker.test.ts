import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	noShrinker,
	pictureShrinker,
	SHRINK_TIMEOUT_MS,
	type ShrinkAnswer,
	SHRINKER_FAILURES,
	SHRINKER_IDLE_MS,
	type ShrinkRequest,
	workerShrinker,
} from '../src/pictures/shrinker.js';
import { copyType, scaledTo } from '../src/pictures/steps.js';

/**
 * The seam the app asks for smaller copies of pictures through (#276), with a
 * worker that answers as it is told to. The worker itself draws on a canvas
 * off the page, which jsdom has none of; it is tried in a browser.
 */

type Listener = (event: Partial<MessageEvent<ShrinkAnswer>>) => void;

interface FakeWorker {
	readonly sent: ShrinkRequest[];
	readonly terminated: { current: boolean };
	readonly emit: (type: string, event?: Partial<MessageEvent<ShrinkAnswer>>) => void;
	readonly answer: (answer: ShrinkAnswer) => void;
}

/** The workers started, each keeping what it is sent and answering when a test says. */
const started: FakeWorker[] = [];

const start = ({ refusesPost = false } = {}): Worker => {
	const sent: ShrinkRequest[] = [];
	const terminated = { current: false };
	const listeners = new Map<string, Set<Listener>>();
	const emit = (type: string, event: Partial<MessageEvent<ShrinkAnswer>> = {}) => {
		[...(listeners.get(type) ?? [])].forEach((listener) => {
			listener(event);
		});
	};
	started.push({ sent, terminated, emit, answer: (data) => emit('message', { data }) });
	return {
		addEventListener: (type: string, listener: Listener) => {
			listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
		},
		removeEventListener: (type: string, listener: Listener) => {
			listeners.get(type)?.delete(listener);
		},
		postMessage: (request: ShrinkRequest) => {
			if (refusesPost) throw new DOMException('Not cloneable', 'DataCloneError');
			sent.push(request);
		},
		terminate: () => {
			terminated.current = true;
		},
	} as unknown as Worker;
};

const starts = () => start();

const picture = new Blob(['picture']);
const copy = new Blob(['copy']);
const want = { width: 1280, alpha: false };
const made = { kind: 'made', copy, width: 1280, height: 960 } as const;

/** Lets the queue's promises run on, as they do between a worker's messages. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	started.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a shrinker on a worker', () => {
	it('starts its worker when first asked, and hands back the copy it answers with', async () => {
		const shrinker = workerShrinker(starts);
		expect(started).toHaveLength(0);

		const asked = shrinker.shrink(picture, { width: 1279.6, alpha: true });
		await settle();
		const [worker] = started;
		expect(worker?.sent).toEqual([{ id: 1, picture, width: 1280, alpha: true }]);

		worker?.answer({ id: 1, copy, width: 1280, height: 960 });
		expect(await asked).toEqual(made);
	});

	it('sends one picture at a time, the next once the one before is answered', async () => {
		const shrinker = workerShrinker(starts);
		const first = shrinker.shrink(picture, want);
		const second = shrinker.shrink(picture, { width: 960, alpha: true });
		await settle();
		const [worker] = started;
		expect(worker?.sent.map(({ id }) => id)).toEqual([1]);

		worker?.answer({ id: 1, copy, width: 1280, height: 960 });
		await settle();
		expect(worker?.sent.map(({ id }) => id)).toEqual([1, 2]);
		worker?.answer({ id: 2, copy, width: 960, height: 720 });

		expect(await first).toEqual(made);
		expect(await second).toEqual({ kind: 'made', copy, width: 960, height: 720 });
		expect(started).toHaveLength(1);
	});

	it('says a picture the worker could not copy is refused, and goes on with the same worker', async () => {
		const shrinker = workerShrinker(starts);
		const failed = shrinker.shrink(picture, want);
		await settle();
		const [worker] = started;
		worker?.answer({ id: 1, error: 'EncodingError' });
		expect(await failed).toEqual({ kind: 'refused' });

		const next = shrinker.shrink(picture, want);
		await settle();
		worker?.answer({ id: 2, copy, width: 1280, height: 960 });
		expect(await next).toEqual(made);
		expect(worker?.terminated.current).toBe(false);
	});

	it('replaces a worker that does not answer in time, or fails, and says the picture was missed', async () => {
		const shrinker = workerShrinker(starts);
		const stuck = shrinker.shrink(picture, want);
		await settle();
		await vi.advanceTimersByTimeAsync(SHRINK_TIMEOUT_MS);
		expect(await stuck).toEqual({ kind: 'missed' });
		expect(started[0]?.terminated.current).toBe(true);

		const crashed = shrinker.shrink(picture, want);
		await settle();
		expect(started).toHaveLength(2);
		started[1]?.emit('error');
		expect(await crashed).toEqual({ kind: 'missed' });
		expect(started[1]?.terminated.current).toBe(true);

		const garbled = shrinker.shrink(picture, want);
		await settle();
		started[2]?.emit('messageerror');
		expect(await garbled).toEqual({ kind: 'missed' });
		expect(started[2]?.terminated.current).toBe(true);
	});

	it('gives each picture the whole of its time, however long it waited its turn', async () => {
		const shrinker = workerShrinker(starts);
		const first = shrinker.shrink(picture, want);
		const second = shrinker.shrink(picture, want);
		await settle();
		const [worker] = started;
		await vi.advanceTimersByTimeAsync(SHRINK_TIMEOUT_MS - 1_000);
		worker?.answer({ id: 1, copy, width: 1280, height: 960 });
		expect(await first).toEqual(made);

		await vi.advanceTimersByTimeAsync(SHRINK_TIMEOUT_MS - 1_000);
		expect(worker?.terminated.current).toBe(false);
		worker?.answer({ id: 2, copy, width: 1280, height: 960 });
		expect(await second).toEqual(made);
	});

	it('takes no answer meant for another picture', async () => {
		const shrinker = workerShrinker(starts);
		const asked = shrinker.shrink(picture, want);
		await settle();
		const [worker] = started;
		worker?.answer({ id: 7, copy: new Blob(['other']), width: 1, height: 1 });
		worker?.answer({ id: 1, copy, width: 1280, height: 960 });
		expect(await asked).toEqual(made);
	});

	it('lets its worker go when it has had nothing to do for a while, and not while it has', async () => {
		const shrinker = workerShrinker(starts);
		const asked = shrinker.shrink(picture, want);
		await settle();
		const [worker] = started;
		worker?.answer({ id: 1, copy, width: 1280, height: 960 });
		await asked;

		await vi.advanceTimersByTimeAsync(SHRINKER_IDLE_MS - 1);
		const busy = shrinker.shrink(picture, want);
		await settle();
		await vi.advanceTimersByTimeAsync(SHRINKER_IDLE_MS);
		expect(worker?.terminated.current).toBe(false);
		worker?.answer({ id: 2, copy, width: 1280, height: 960 });
		await busy;

		await vi.advanceTimersByTimeAsync(SHRINKER_IDLE_MS);
		expect(worker?.terminated.current).toBe(true);
		const again = shrinker.shrink(picture, want);
		await settle();
		expect(started).toHaveLength(2);
		started[1]?.answer({ id: 3, copy, width: 1280, height: 960 });
		expect(await again).toEqual(made);
	});

	it('passes over a picture withdrawn while it waited its turn', async () => {
		const shrinker = workerShrinker(starts);
		const first = shrinker.shrink(picture, want);
		const leaving = new AbortController();
		const withdrawn = shrinker.shrink(picture, { ...want, signal: leaving.signal });
		const third = shrinker.shrink(picture, want);
		await settle();
		leaving.abort();
		const [worker] = started;
		worker?.answer({ id: 1, copy, width: 1280, height: 960 });
		await first;

		expect(await withdrawn).toEqual({ kind: 'missed' });
		await settle();
		expect(worker?.sent.map(({ id }) => id)).toEqual([1, 3]);
		worker?.answer({ id: 3, copy, width: 1280, height: 960 });
		expect(await third).toEqual(made);
	});

	it('misses a picture that cannot be handed to the worker, and leaves the next one its worker', async () => {
		const shrinker = workerShrinker(
			vi
				.fn<() => Worker>()
				.mockImplementationOnce(() => start({ refusesPost: true }))
				.mockImplementation(starts)
		);
		expect(await shrinker.shrink(picture, want)).toEqual({ kind: 'missed' });

		const next = shrinker.shrink(picture, want);
		await settle();
		// Long past the first one's time: nothing of it is left to end this one.
		await vi.advanceTimersByTimeAsync(SHRINK_TIMEOUT_MS - 1);
		expect(started[1]?.terminated.current).toBe(false);
		started[1]?.answer({ id: 2, copy, width: 1280, height: 960 });
		expect(await next).toEqual(made);
	});

	it('misses a picture where no worker can be started, and asks again for the next', async () => {
		const refused = vi
			.fn<() => Worker>()
			.mockImplementationOnce(() => {
				throw new DOMException('Refused', 'SecurityError');
			})
			.mockImplementation(starts);
		const shrinker = workerShrinker(refused);
		expect(await shrinker.shrink(picture, want)).toEqual({ kind: 'missed' });

		const next = shrinker.shrink(picture, want);
		await settle();
		started[0]?.answer({ id: 2, copy, width: 1280, height: 960 });
		expect(await next).toEqual(made);
	});

	it('stops starting workers once that many in a row have failed', async () => {
		const failing = vi.fn<() => Worker>().mockImplementation(starts);
		const shrinker = workerShrinker(failing);
		await Array.from({ length: SHRINKER_FAILURES }).reduce<Promise<unknown>>(async (before) => {
			await before;
			const asked = shrinker.shrink(picture, want);
			await settle();
			started.at(-1)?.emit('error');
			return asked;
		}, Promise.resolve());
		expect(failing).toHaveBeenCalledTimes(SHRINKER_FAILURES);

		expect(await shrinker.shrink(picture, want)).toEqual({ kind: 'missed' });
		expect(failing).toHaveBeenCalledTimes(SHRINKER_FAILURES);
	});
});

describe('no shrinker', () => {
	it('makes no copy, so every picture is shown as it is', async () => {
		expect(await noShrinker.shrink(picture, want)).toEqual({ kind: 'missed' });
	});

	it('is the one the app has where there is no worker, however often it is asked for', () => {
		expect(pictureShrinker()).toBe(noShrinker);
		expect(pictureShrinker()).toBe(pictureShrinker());
	});
});

describe('a copy', () => {
	it('is WebP where the browser writes it, and else PNG where it has alpha and JPEG where not', () => {
		expect(copyType(true, false)).toBe('image/webp');
		expect(copyType(true, true)).toBe('image/webp');
		expect(copyType(false, true)).toBe('image/png');
		expect(copyType(false, false)).toBe('image/jpeg');
	});

	it('keeps the shape of the picture it is drawn from, whatever width it is drawn at', () => {
		expect(scaledTo({ width: 4032, height: 3024 }, 1280)).toEqual({ width: 1280, height: 960 });
		expect(scaledTo({ width: 3000, height: 4500 }, 960)).toEqual({ width: 960, height: 1440 });
		expect(scaledTo({ width: 30_000, height: 10 }, 960)).toEqual({ width: 960, height: 1 });
	});
});
