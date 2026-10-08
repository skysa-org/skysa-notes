/**
 * Makes the smaller copies of pictures (#276) on a thread of its own, so a
 * 48 MP photo is decoded and drawn down without the page stopping for it.
 * One picture at a time, as `shrinker.ts` sends them.
 *
 * The browser's own decoder does the work: nothing here reads a picture's
 * bytes, and nothing is compiled from them (`docs/ARCHITECTURE.md` §9).
 */

import type { ShrinkAnswer, ShrinkRequest } from './shrinker.js';
import { COPY_QUALITY, copyType, scaledTo } from './steps.js';

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
 * as the spec asks of it: Safari never has (WebKit bug 226950). Asked once.
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

/**
 * The decoded picture on a canvas `width` wide. It is that wide already where
 * the browser scaled it as it decoded it, as every one with a canvas off the
 * page does; drawn to it in one step where not.
 */
const drawn = (decoded: ImageBitmap, width: number): OffscreenCanvas => {
	const size = scaledTo(decoded, width);
	const canvas = new OffscreenCanvas(size.width, size.height);
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('No 2D context to draw a copy on');
	// eslint-disable-next-line functional/immutable-data -- a context is set up by assigning to it
	context.imageSmoothingQuality = 'high';
	context.drawImage(decoded, 0, 0, size.width, size.height);
	return canvas;
};

const shrink = async ({
	picture,
	width,
	alpha,
}: ShrinkRequest): Promise<Omit<Extract<ShrinkAnswer, { copy: Blob }>, 'id'>> => {
	// Scaled as it is decoded, which can spare the browser the whole picture's
	// pixels, to the width alone: its height follows from the picture as the
	// browser turns it, the way its camera said, which is every browser's
	// default. Named, `imageOrientation: 'from-image'` is refused outright
	// before Safari 17.2, Chrome 111 and Firefox 111.
	const decoded = await createImageBitmap(picture, {
		resizeWidth: width,
		resizeQuality: 'high',
	});
	const canvas = (() => {
		try {
			return drawn(decoded, width);
		} finally {
			decoded.close();
		}
	})();
	try {
		const copy = await canvas.convertToBlob({
			type: copyType(await writesWebp, alpha),
			quality: COPY_QUALITY,
		});
		return { copy, width: canvas.width, height: canvas.height };
	} finally {
		empty(canvas);
	}
};

scope.addEventListener('message', ({ data }) => {
	shrink(data).then(
		(made) => {
			scope.postMessage({ id: data.id, ...made });
		},
		(error: unknown) => {
			scope.postMessage({ id: data.id, error: String(error) });
		}
	);
});
