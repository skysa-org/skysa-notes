// Large JPEGs without an image library: drawn on a canvas in Chromium, with
// seeded noise so they compress about as badly as a phone photo does, and
// encoded by the browser. Made once per (size, target, seed) and kept in
// $PERF_DIR/images.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_DIR, playwright } from './paths.mjs';

const DIR = join(PERF_DIR, 'images');

/** In the page: a picture of `width`×`height` with noise of `amplitude`, as JPEG bytes in base64. */
const draw = async ({ width, height, amplitude, seed }) => {
	let state = seed >>> 0;
	const random = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext('2d');
	const sky = context.createLinearGradient(0, 0, width, height);
	sky.addColorStop(0, `hsl(${Math.floor(random() * 360)} 60% 60%)`);
	sky.addColorStop(1, `hsl(${Math.floor(random() * 360)} 50% 30%)`);
	context.fillStyle = sky;
	context.fillRect(0, 0, width, height);
	for (let i = 0; i < 40; i += 1) {
		context.fillStyle = `hsl(${Math.floor(random() * 360)} 70% ${30 + Math.floor(random() * 50)}% / 0.6)`;
		context.beginPath();
		context.arc(random() * width, random() * height, (random() * width) / 6, 0, Math.PI * 2);
		context.fill();
	}
	// Noise a row band at a time, so the page never holds a second copy of the whole picture.
	const band = 256;
	for (let y = 0; y < height; y += band) {
		const rows = Math.min(band, height - y);
		const image = context.getImageData(0, y, width, rows);
		const { data } = image;
		for (let i = 0; i < data.length; i += 4) {
			const n = (random() - 0.5) * amplitude;
			data[i] += n;
			data[i + 1] += n * 0.9;
			data[i + 2] += n * 1.1;
		}
		context.putImageData(image, 0, y);
	}
	const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const parts = [];
	for (let i = 0; i < bytes.length; i += 0x8000) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
	}
	return btoa(parts.join(''));
};

/**
 * `count` distinct JPEGs of `width`×`height`, each near `bytes` long.
 * Returns `[{ file, size }]`.
 */
export const makeJpegs = async ({ width, height, count, bytes, seed }) => {
	mkdirSync(DIR, { recursive: true });
	const fileOf = (at) =>
		join(DIR, `${width}x${height}-${Math.round(bytes / 1e5)}-${seed}-${at}.jpg`);
	const missing = Array.from({ length: count }, (_, at) => at).filter(
		(at) => !existsSync(fileOf(at))
	);
	if (missing.length > 0) {
		const { chromium } = playwright();
		const browser = await chromium.launch();
		const page = await browser.newPage();
		// Amplitude to size is close to linear over this range; a few tries land within 15%.
		let amplitude = 60;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const size = Buffer.from(
				await page.evaluate(draw, { width, height, amplitude, seed: seed * 1000 }),
				'base64'
			).length;
			if (Math.abs(size - bytes) / bytes < 0.15) break;
			amplitude = Math.max(2, Math.min(255, amplitude * (bytes / size)));
		}
		for (const at of missing) {
			const jpeg = Buffer.from(
				await page.evaluate(draw, { width, height, amplitude, seed: seed * 1000 + at + 1 }),
				'base64'
			);
			writeFileSync(fileOf(at), jpeg);
			process.stderr.write(
				`  ${width}x${height} #${at + 1}: ${(jpeg.length / 1e6).toFixed(1)} MB\n`
			);
		}
		await browser.close();
	}
	return Array.from({ length: count }, (_, at) => ({
		file: fileOf(at),
		size: statSync(fileOf(at)).size,
	}));
};
