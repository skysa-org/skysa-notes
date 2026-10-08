/**
 * How a smaller copy of a picture is drawn and kept (#276), worked out apart
 * from the worker that draws it (`shrink.worker.ts`), so that it can be
 * tested where there is no canvas.
 */

export interface Size {
	readonly width: number;
	readonly height: number;
}

export type CopyType = 'image/webp' | 'image/png' | 'image/jpeg';

/**
 * What a copy is kept as: WebP where the browser can write it, which keeps
 * alpha and is the smallest of the three; where it cannot, PNG for a picture
 * with alpha, which JPEG would lose, and JPEG for one without.
 */
export const copyType = (webp: boolean, alpha: boolean): CopyType => {
	if (webp) return 'image/webp';
	return alpha ? 'image/png' : 'image/jpeg';
};

/** How much of the picture a lossy copy keeps: a photo's grain and a screenshot's text alike. */
export const COPY_QUALITY = 0.82;

const half = ({ width, height }: Size): Size => ({
	width: Math.round(width / 2),
	height: Math.round(height / 2),
});

/**
 * The sizes a picture is drawn through on its way down to `to`, where the
 * browser did not scale it as it decoded it: halved while it is still more
 * than twice as large, then `to`. Drawn down in one step, a picture is
 * sampled rather than averaged, and fine lines and small text break up; each
 * halving averages four pixels into one.
 */
export const halvings = (from: Size, to: Size): Size[] =>
	from.width > to.width * 2 && from.height > to.height * 2
		? [half(from), ...halvings(half(from), to)]
		: [to];
