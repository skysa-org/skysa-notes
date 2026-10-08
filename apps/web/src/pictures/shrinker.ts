/**
 * Smaller copies of pictures (#276), made on a worker of their own
 * (`shrink.worker.ts`): the seam the app asks through, and what answers it in
 * a browser that has what a copy is made with.
 */

export interface ShrinkRequest {
	readonly id: number;
	readonly picture: Blob;
	/** The copy's width. Its height is the picture's shape, as the browser turns it. */
	readonly width: number;
	/** The picture may have pixels that are not opaque, which the copy keeps. */
	readonly alpha: boolean;
}

export type ShrinkAnswer =
	| Readonly<{ id: number; copy: Blob; width: number; height: number }>
	| Readonly<{ id: number; error: string }>;

/** What asking for a copy comes to. */
export type Shrunk =
	/** The copy, at the size it came out. */
	| Readonly<{ kind: 'made'; copy: Blob; width: number; height: number }>
	/** The browser could not read or draw this picture: it is shown as it is. */
	| Readonly<{ kind: 'refused' }>
	/**
	 * No answer this time — a worker that failed, was too slow or could not be
	 * started, or a request withdrawn while it waited — and worth asking again
	 * another time. Never a verdict on the picture: a phone that put the app
	 * away in the middle of a copy misses it.
	 */
	| Readonly<{ kind: 'missed' }>;

export interface PictureShrinker {
	/**
	 * A copy of `picture` `width` wide, turned as its camera said.
	 *
	 * `alpha` is true unless the picture is known to be opaque: where the
	 * browser writes no WebP the copy is a JPEG, which turns pixels that are not
	 * opaque black. `signal` withdraws a request still waiting its turn; one
	 * already being drawn is finished.
	 */
	readonly shrink: (
		picture: Blob,
		want: Readonly<{ width: number; alpha: boolean; signal?: AbortSignal }>
	) => Promise<Shrunk>;
}

const MISSED: Shrunk = { kind: 'missed' };

/**
 * No copies: where there is no worker, or no canvas off the page, to make
 * them with — jsdom, an old browser — every picture is shown as it is.
 */
export const noShrinker: PictureShrinker = { shrink: () => Promise.resolve(MISSED) };

/**
 * How long one copy may take before its worker is taken to be stuck and is
 * replaced. A 48 MP photo takes a few seconds on a slow phone.
 */
export const SHRINK_TIMEOUT_MS = 30_000;

/**
 * How long a worker with nothing to do is kept. Starting one costs little; a
 * phone that keeps one idle keeps its memory.
 */
export const SHRINKER_IDLE_MS = 20_000;

/**
 * Workers that fail one after another before a page stops starting them. One
 * whose file cannot be loaded — a build replaced under a page left open —
 * would otherwise be started again, and fail again, for every picture.
 */
export const SHRINKER_FAILURES = 3;

/** The worker as the app starts it: a module of the app's own, as `worker-src 'self'` allows. */
const startWorker = (): Worker =>
	new Worker(new URL('./shrink.worker.ts', import.meta.url), { type: 'module' });

export const workerShrinker = (
	start: () => Worker = startWorker,
	timeoutMs: number = SHRINK_TIMEOUT_MS,
	idleMs: number = SHRINKER_IDLE_MS
): PictureShrinker => {
	const worker: { current: Worker | undefined } = { current: undefined };
	const asked = { current: 0 };
	const failures = { current: 0 };
	// One copy at a time: each decodes a whole picture, and two at once on a
	// phone are two pictures at once in its memory.
	const queue: { current: Promise<unknown> } = { current: Promise.resolve() };
	const idle: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };

	/** Let a worker go, and forget it if it is still the one asked next. */
	const retire = (which: Worker) => {
		which.terminate();
		if (worker.current === which) worker.current = undefined;
	};

	const once = (request: ShrinkRequest): Promise<Shrunk> =>
		new Promise((resolve) => {
			clearTimeout(idle.current);
			const running = worker.current ?? start();
			worker.current = running;
			const timer: { current: ReturnType<typeof setTimeout> | undefined } = {
				current: undefined,
			};
			const done = (shrunk: Shrunk) => {
				clearTimeout(timer.current);
				running.removeEventListener('message', answered);
				running.removeEventListener('error', failed);
				running.removeEventListener('messageerror', failed);
				idle.current = setTimeout(() => {
					retire(running);
				}, idleMs);
				resolve(shrunk);
			};
			const answered = ({ data }: MessageEvent<ShrinkAnswer>) => {
				if (data.id !== request.id) return;
				failures.current = 0;
				done(
					'copy' in data
						? { kind: 'made', copy: data.copy, width: data.width, height: data.height }
						: { kind: 'refused' }
				);
			};
			// A worker that failed, or does not answer, is started again for
			// the next picture; this one is shown as it is, this time.
			const failed = () => {
				failures.current += 1;
				retire(running);
				done(MISSED);
			};
			timer.current = setTimeout(failed, timeoutMs);
			running.addEventListener('message', answered);
			running.addEventListener('error', failed);
			running.addEventListener('messageerror', failed);
			try {
				running.postMessage(request);
			} catch {
				failed();
			}
		});

	return {
		shrink: (picture, { width, alpha, signal }) => {
			asked.current += 1;
			const request = {
				id: asked.current,
				picture,
				width: Math.max(1, Math.round(width)),
				alpha,
			};
			const turn = queue.current
				.then(() =>
					// Withdrawn while it waited, or nothing left to start it on.
					signal?.aborted === true || failures.current >= SHRINKER_FAILURES
						? MISSED
						: once(request)
				)
				// A worker that cannot be started at all.
				.catch(() => {
					failures.current += 1;
					return MISSED;
				});
			// The queue waits on the turn, without keeping the copy it made.
			queue.current = turn.then(() => undefined);
			return turn;
		},
	};
};

const shared: { current: PictureShrinker | undefined } = { current: undefined };

/**
 * The app's, one for every view that shows pictures, so that a note, the
 * cards and the clipboard wait for one another: a worker's, where the browser
 * has what a copy is made with, and none where not.
 */
export const pictureShrinker = (): PictureShrinker => {
	shared.current ??=
		typeof Worker === 'undefined' ||
		typeof OffscreenCanvas === 'undefined' ||
		typeof createImageBitmap === 'undefined'
			? noShrinker
			: workerShrinker();
	return shared.current;
};
