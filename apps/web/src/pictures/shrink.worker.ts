/**
 * Makes the smaller copies of pictures (#276) on a thread of its own, so a
 * 48 MP photo is decoded and drawn down without the page stopping for it.
 * One picture at a time, as `shrinker.ts` sends them.
 *
 * The browser's own decoder does the work: nothing here reads a picture's
 * bytes, and nothing is compiled from them (`docs/ARCHITECTURE.md` §9).
 */

import type { ShrinkAnswer, ShrinkRequest } from './shrinker.js';
import { COPY_QUALITY, copyType, halvings, type Size } from './steps.js';

/**
 * The worker's global, as much of it as is used here: the app is typed
 * against the page's DOM, where `self` is a window.
 */
interface Scope {
	readonly addEventListener: (
		type: 'message',
		listener: (event: MessageEvent<ShrinkRequest>) => void
	) => void;
	readonly postMessage: (answer: ShrinkAnswer) => void;
}

const scope = globalThis as unknown as Scope;

/**
 * Whether this browser writes WebP. One that cannot hands back a PNG instead,
 * as the spec asks of it; Safari did until 17. Asked once.
 */
const writesWebp = (async () => {
	const probe = new OffscreenCanvas(1, 1);
	probe.getContext('2d');
	const made = await probe.convertToBlob({ type: 'image/webp' });
	return made.type === 'image/webp';
})();

/**
 * Let a canvas's pixels go now, rather than when it is collected: Safari
 * counts them against the page's memory until then.
 */
const empty = (canvas: OffscreenCanvas) => {
	// eslint-disable-next-line functional/immutable-data -- see above
	canvas.width = 0;
	// eslint-disable-next-line functional/immutable-data -- see above
	canvas.height = 0;
};

const draw = (from: OffscreenCanvas | ImageBitmap, size: Size): OffscreenCanvas => {
	const canvas = new OffscreenCanvas(size.width, size.height);
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('No 2D context to draw a copy on');
	// eslint-disable-next-line functional/immutable-data -- a context is set up by assigning to it
	context.imageSmoothingQuality = 'high';
	context.drawImage(from, 0, 0, size.width, size.height);
	return canvas;
};

const shrink = async ({ picture, width, height, alpha }: ShrinkRequest): Promise<Blob> => {
	const size = { width, height };
	// Scaled as it is decoded, where the browser does that, which can spare
	// it the whole picture's pixels; and turned as its camera said.
	const decoded = await createImageBitmap(picture, {
		resizeWidth: width,
		resizeHeight: height,
		resizeQuality: 'high',
		imageOrientation: 'from-image',
	});
	try {
		const scaled = decoded.width === width && decoded.height === height;
		const steps = scaled ? [size] : halvings(decoded, size);
		const copy = steps.reduce<OffscreenCanvas | ImageBitmap>((from, step) => {
			const next = draw(from, step);
			if (from instanceof OffscreenCanvas) empty(from);
			return next;
		}, decoded);
		if (!(copy instanceof OffscreenCanvas)) throw new Error('A copy was not drawn');
		try {
			return await copy.convertToBlob({
				type: copyType(await writesWebp, alpha),
				quality: COPY_QUALITY,
			});
		} finally {
			empty(copy);
		}
	} finally {
		decoded.close();
	}
};

scope.addEventListener('message', ({ data }) => {
	shrink(data).then(
		(copy) => {
			scope.postMessage({ id: data.id, copy });
		},
		(error: unknown) => {
			scope.postMessage({ id: data.id, error: String(error) });
		}
	);
});
