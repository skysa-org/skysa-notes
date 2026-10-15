import jsQR from 'jsqr';

/**
 * What a drawn QR code says, as a camera would read it: its squares painted
 * at `scale` pixels a module, dark on white, and read with the same jsQR a
 * scan reads with. Read from the path `RecoveryQr` draws, so what is checked
 * is what is on the screen and the page.
 */
export const readQr = (svg: Element | null | undefined, scale = 4): string | undefined => {
	const box = svg?.getAttribute('viewBox')?.split(' ').map(Number);
	const squares = svg?.querySelector('path')?.getAttribute('d') ?? '';
	const size = box?.[2] ?? 0;
	if (size === 0) return undefined;
	const width = size * scale;
	const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
	[...squares.matchAll(/M(\d+) (\d+)h1v1h-1z/gu)].forEach(([, x = '0', y = '0']) => {
		Array.from({ length: scale * scale }, (_, at) => {
			const px = Number(x) * scale + (at % scale);
			const py = Number(y) * scale + Math.floor(at / scale);
			const offset = (py * width + px) * 4;
			pixels.fill(0, offset, offset + 3);
			return offset;
		});
	});
	return jsQR(pixels, width, width)?.data;
};
