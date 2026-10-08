/**
 * Smaller copies of pictures (#276), made on a worker of their own
 * (`shrink.worker.ts`): the seam the app asks through, and what answers it in
 * a browser that has what a copy is made with.
 */

export interface ShrinkRequest {
	readonly id: number;
	readonly picture: Blob;
	readonly width: number;
	readonly height: number;
	/** The picture may have pixels that are not opaque, which the copy keeps. */
	readonly alpha: boolean;
}

export type ShrinkAnswer =
	Readonly<{ id: number; copy: Blob }> | Readonly<{ id: number; error: string }>;

export interface PictureShrinker {
	/**
	 * A copy of `picture` drawn at `size`, turned as its camera said, or
	 * `undefined` where none could be made: the picture is then shown as it is.
	 */
	readonly shrink: (
		picture: Blob,
		size: Readonly<{ width: number; height: number }>,
		alpha: boolean
	) => Promise<Blob | undefined>;
}

/**
 * No copies: where there is no worker, or no canvas off the page, to make
 * them with — jsdom, an old browser — every picture is shown as it is.
 */
export const noShrinker: PictureShrinker = { shrink: () => Promise.resolve(undefined) };

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
	// One copy at a time: each decodes a whole picture, and two at once on a
	// phone are two pictures at once in its memory.
	const queue: { current: Promise<unknown> } = { current: Promise.resolve() };
	const idle: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };

	const stop = () => {
		worker.current?.terminate();
		worker.current = undefined;
	};

	const once = (request: ShrinkRequest): Promise<Blob | undefined> =>
		new Promise((resolve) => {
			clearTimeout(idle.current);
			const running = worker.current ?? start();
			worker.current = running;
			const timer: { current: ReturnType<typeof setTimeout> | undefined } = {
				current: undefined,
			};
			const done = (copy: Blob | undefined) => {
				clearTimeout(timer.current);
				running.removeEventListener('message', answered);
				running.removeEventListener('error', failed);
				running.removeEventListener('messageerror', failed);
				idle.current = setTimeout(stop, idleMs);
				resolve(copy);
			};
			const answered = ({ data }: MessageEvent<ShrinkAnswer>) => {
				if (data.id !== request.id) return;
				done('copy' in data ? data.copy : undefined);
			};
			// A worker that failed, or does not answer, is started again for
			// the next picture; this one is shown as it is.
			const failed = () => {
				stop();
				done(undefined);
			};
			timer.current = setTimeout(failed, timeoutMs);
			running.addEventListener('message', answered);
			running.addEventListener('error', failed);
			running.addEventListener('messageerror', failed);
			running.postMessage(request);
		});

	return {
		shrink: (picture, { width, height }, alpha) => {
			asked.current += 1;
			const request = { id: asked.current, picture, width, height, alpha };
			// A worker that cannot be started shows this picture as it is,
			// and leaves the queue to the next.
			const turn = queue.current.then(() => once(request)).catch(() => undefined);
			queue.current = turn;
			return turn;
		},
	};
};

/** The app's: a worker's, where the browser has what a copy is made with, and none where not. */
export const pictureShrinker = (): PictureShrinker =>
	typeof Worker === 'undefined' ||
	typeof OffscreenCanvas === 'undefined' ||
	typeof createImageBitmap === 'undefined'
		? noShrinker
		: workerShrinker();
