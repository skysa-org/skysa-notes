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

/** `from` at `width`, its shape kept: never less than a pixel either way. */
export const scaledTo = (from: Size, width: number): Size => ({
	width,
	height: Math.max(1, Math.round((from.height * width) / from.width)),
});
