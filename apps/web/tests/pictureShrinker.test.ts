import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	noShrinker,
	SHRINK_TIMEOUT_MS,
	type ShrinkAnswer,
	SHRINKER_IDLE_MS,
	type ShrinkRequest,
	workerShrinker,
} from '../src/pictures/shrinker.js';
import { copyType, halvings } from '../src/pictures/steps.js';

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

const start = (): Worker => {
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
			sent.push(request);
		},
		terminate: () => {
			terminated.current = true;
		},
	} as unknown as Worker;
};

const picture = new Blob(['picture']);
const copy = new Blob(['copy']);
const size = { width: 1280, height: 960 };

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
		const shrinker = workerShrinker(start);
		expect(started).toHaveLength(0);

		const asked = shrinker.shrink(picture, size, false);
		await settle();
		const [worker] = started;
		expect(worker?.sent).toEqual([{ id: 1, picture, width: 1280, height: 960, alpha: false }]);

		worker?.answer({ id: 1, copy });
		expect(await asked).toBe(copy);
	});

	it('sends one picture at a time, the next once the one before is answered', async () => {
		const shrinker = workerShrinker(start);
		const first = shrinker.shrink(picture, size, false);
		const second = shrinker.shrink(picture, { width: 960, height: 720 }, true);
		await settle();
		const [worker] = started;
		expect(worker?.sent.map(({ id }) => id)).toEqual([1]);

		worker?.answer({ id: 1, copy });
		await settle();
		expect(worker?.sent.map(({ id }) => id)).toEqual([1, 2]);
		worker?.answer({ id: 2, copy });

		expect(await first).toBe(copy);
		expect(await second).toBe(copy);
		expect(started).toHaveLength(1);
	});

	it('shows a picture as it is where the worker could not copy it, and goes on with the same worker', async () => {
		const shrinker = workerShrinker(start);
		const failed = shrinker.shrink(picture, size, false);
		await settle();
		const [worker] = started;
		worker?.answer({ id: 1, error: 'EncodingError' });
		expect(await failed).toBeUndefined();

		const next = shrinker.shrink(picture, size, false);
		await settle();
		worker?.answer({ id: 2, copy });
		expect(await next).toBe(copy);
		expect(worker?.terminated.current).toBe(false);
	});

	it('replaces a worker that does not answer in time, or fails', async () => {
		const shrinker = workerShrinker(start);
		const stuck = shrinker.shrink(picture, size, false);
		await settle();
		await vi.advanceTimersByTimeAsync(SHRINK_TIMEOUT_MS);
		expect(await stuck).toBeUndefined();
		expect(started[0]?.terminated.current).toBe(true);

		const crashed = shrinker.shrink(picture, size, false);
		await settle();
		expect(started).toHaveLength(2);
		started[1]?.emit('error');
		expect(await crashed).toBeUndefined();
		expect(started[1]?.terminated.current).toBe(true);

		const after = shrinker.shrink(picture, size, false);
		await settle();
		started[2]?.answer({ id: 3, copy });
		expect(await after).toBe(copy);
	});

	it('takes no answer meant for another picture', async () => {
		const shrinker = workerShrinker(start);
		const asked = shrinker.shrink(picture, size, false);
		await settle();
		const [worker] = started;
		worker?.answer({ id: 7, copy: new Blob(['other']) });
		worker?.answer({ id: 1, copy });
		expect(await asked).toBe(copy);
	});

	it('lets its worker go when it has had nothing to do for a while', async () => {
		const shrinker = workerShrinker(start);
		const asked = shrinker.shrink(picture, size, false);
		await settle();
		const [worker] = started;
		worker?.answer({ id: 1, copy });
		await asked;

		await vi.advanceTimersByTimeAsync(SHRINKER_IDLE_MS - 1);
		expect(worker?.terminated.current).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(worker?.terminated.current).toBe(true);

		const again = shrinker.shrink(picture, size, false);
		await settle();
		expect(started).toHaveLength(2);
		started[1]?.answer({ id: 2, copy });
		expect(await again).toBe(copy);
	});

	it('shows a picture as it is where no worker can be started, and asks again for the next', async () => {
		const refused = vi
			.fn<() => Worker>()
			.mockImplementationOnce(() => {
				throw new DOMException('Refused', 'SecurityError');
			})
			.mockImplementation(start);
		const shrinker = workerShrinker(refused);
		expect(await shrinker.shrink(picture, size, false)).toBeUndefined();

		const next = shrinker.shrink(picture, size, false);
		await settle();
		started[0]?.answer({ id: 2, copy });
		expect(await next).toBe(copy);
	});
});

describe('no shrinker', () => {
	it('makes no copy, so every picture is shown as it is', async () => {
		expect(await noShrinker.shrink(picture, size, false)).toBeUndefined();
	});
});

describe('a copy', () => {
	it('is WebP where the browser writes it, and else PNG where it has alpha and JPEG where not', () => {
		expect(copyType(true, false)).toBe('image/webp');
		expect(copyType(true, true)).toBe('image/webp');
		expect(copyType(false, true)).toBe('image/png');
		expect(copyType(false, false)).toBe('image/jpeg');
	});

	it('is drawn down by halves while more than twice its size, then to it', () => {
		expect(halvings({ width: 8000, height: 6000 }, { width: 1280, height: 960 })).toEqual([
			{ width: 4000, height: 3000 },
			{ width: 2000, height: 1500 },
			{ width: 1280, height: 960 },
		]);
		expect(halvings({ width: 2000, height: 1500 }, { width: 1280, height: 960 })).toEqual([
			{ width: 1280, height: 960 },
		]);
	});
});
