import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ViteDevServer } from 'vite';
import { describe, expect, it } from 'vitest';

import {
	BRAND_ICONS,
	brandAssets,
	brandCss,
	brandCssUrl,
	brandJsonSchema,
	brandPlugin,
	brandTags,
	DEFAULT_BRAND,
	loadBrand,
} from '../brand.js';

/**
 * The brand: the one way a deployment names and colours the app without
 * changing this repo (docs/ARCHITECTURE.md §8, "Brand"). A mistake in a brand
 * file shows up nowhere in a build that goes ahead, only as an app that will
 * not install or installs without its icon, so each one has to stop the build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures/brand/brand.json');
const defaults = JSON.parse(readFileSync(DEFAULT_BRAND, 'utf8')) as Record<string, unknown>;

/** A brand file in a fresh folder, beside a copy of the default icons. */
const brandFile = (content: unknown, change?: (icons: string) => void): string => {
	const folder = mkdtempSync(join(tmpdir(), 'brand-'));
	const icons = join(folder, 'icons');
	mkdirSync(icons);
	BRAND_ICONS.forEach(({ file }) => {
		copyFileSync(join(dirname(DEFAULT_BRAND), 'icons', file), join(icons, file));
	});
	change?.(icons);
	const file = join(folder, 'brand.json');
	writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
	return file;
};

const refusal = (file: string): string => {
	try {
		loadBrand(file);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return 'loaded';
};

describe('the default brand', () => {
	const brand = loadBrand();

	it('is "Notes", in gray, carrying no one’s name', () => {
		expect(brand.name).toBe('Notes');
		expect(brand.shortName).toBe('Notes');
		expect(brand.colors.light.brand).toBe('#4B5563');
		expect(brand.colors.dark.brand).toBe('#9CA3AF');
		expect(JSON.stringify(defaults).toLowerCase()).not.toContain('skysa');
	});

	it('keeps the system fonts', () => {
		expect(brand.fonts).toEqual({});
		const css = brandCss(brand);
		expect(css).not.toContain('@font-face');
		expect(css).toContain('--font-sans: ui-sans-serif, system-ui');
		expect(css).toContain('--font-mono: ui-monospace, SFMono-Regular');
	});

	it('has all six icons', () => {
		expect(brand.icons.map((icon) => icon.file)).toEqual(BRAND_ICONS.map((icon) => icon.file));
	});

	it('is described by the committed JSON Schema', () => {
		const committed: unknown = JSON.parse(
			readFileSync(join(dirname(DEFAULT_BRAND), 'brand.schema.json'), 'utf8')
		);
		// Regenerate with `brandJsonSchema()` (brand/README.md) when the schema changes.
		expect(committed).toEqual(brandJsonSchema());
	});
});

describe('a brand file the build refuses', () => {
	it.each<[string, unknown, RegExp]>([
		['is not JSON', '{ "name": ', /the file: /],
		['leaves out the name', { ...defaults, name: undefined }, /name: /],
		[
			'has a colour that is not #RRGGBB',
			{ ...defaults, colors: { ...(defaults.colors as object), background: 'white' } },
			/colors\.background: a colour is #RRGGBB/,
		],
		[
			'has a short name a home screen would cut off',
			{ ...defaults, shortName: 'Thirteen char' },
			/shortName is cut off/,
		],
		['has a key it does not know', { ...defaults, colour: '#000000' }, /colour/],
		[
			'names a font that is not woff2',
			{ ...defaults, fonts: { sans: { family: 'X', files: [{ src: 'x.ttf' }] } } },
			/a font file is \.woff2/,
		],
		[
			'names a font family with quotes in it',
			{ ...defaults, fonts: { sans: { family: "X'; }", files: [{ src: 'x.woff2' }] } } },
			/a family name is letters/,
		],
	])('%s', (_, content, problem) => {
		const file = brandFile(content);
		expect(refusal(file)).toMatch(problem);
		expect(refusal(file)).toContain(file);
	});

	it('does not exist', () => {
		expect(refusal(join(tmpdir(), 'no-such-brand.json'))).toMatch(/there is no such file/);
	});

	it('has an icon at the wrong size', () => {
		const file = brandFile(defaults, (icons) => {
			copyFileSync(join(icons, 'pwa-192x192.png'), join(icons, 'pwa-512x512.png'));
		});
		expect(refusal(file)).toMatch(/pwa-512x512\.png is 192x192, not 512x512/);
	});

	it('has an icon that is not a PNG', () => {
		const file = brandFile(defaults, (icons) => {
			writeFileSync(join(icons, 'apple-touch-icon.png'), 'GIF89a');
		});
		expect(refusal(file)).toMatch(/apple-touch-icon\.png is not a PNG/);
	});

	it('points at an icon folder without them', () => {
		const file = brandFile({ ...defaults, icons: 'elsewhere' });
		expect(refusal(file)).toMatch(/favicon-16x16\.png is missing/);
	});

	it('names a font file that is not there', () => {
		const file = brandFile({
			...defaults,
			fonts: { mono: { family: 'Mono', files: [{ src: 'gone.woff2' }] } },
		});
		expect(refusal(file)).toMatch(/fonts\.mono: gone\.woff2 is missing/);
	});
});

describe('a brand of its own', () => {
	const brand = loadBrand(FIXTURE);

	it('names the app and its home-screen label', () => {
		expect(brand.name).toBe('Field & Notes');
		expect(brand.shortName).toBe('Field');
	});

	it('sets the brand colour for each theme', () => {
		const css = brandCss(brand);
		const [light = '', dark = ''] = css.split('@media (prefers-color-scheme: dark)');
		expect(light).toContain('--brand: #0F766E;');
		expect(light).toContain('--on-brand: #FFFFFF;');
		expect(dark).toContain('--brand: #5EEAD4;');
		expect(dark).toContain('--on-brand: #042F2E;');
	});

	it('declares its fonts and puts them first, ahead of the system stack', () => {
		const css = brandCss(brand);
		const [regular, bold] = brand.fonts.sans?.faces ?? [];
		expect(css.match(/@font-face/g)).toHaveLength(2);
		expect(css).toContain(`src: url('${regular?.url ?? ''}') format('woff2');`);
		expect(css).toContain('unicode-range: U+0000-00FF, U+2019;');
		expect(css).toContain('font-weight: 700;');
		expect(css).toContain("--font-sans: 'Fixture Sans', ui-sans-serif");
		// A family the brand leaves out keeps the system's.
		expect(css).toContain('--font-mono: ui-monospace');
		expect(regular?.url).not.toBe(bold?.url);
	});

	it('names each font file and the stylesheet by their content', () => {
		const [regular] = brand.fonts.sans?.faces ?? [];
		expect(regular?.url).toMatch(/^\/brand\/[0-9a-f]{12}\.woff2$/);
		expect(brandCssUrl(brand)).toMatch(/^\/brand\/brand-[0-9a-f]{12}\.css$/);
		expect(brandCssUrl(brand)).not.toBe(brandCssUrl(loadBrand()));
	});

	it('gives the page its title, theme colours, icons and stylesheet, and no script', () => {
		const tags = brandTags(brand);
		expect(tags.find((tag) => tag.tag === 'title')?.children).toBe('Field &amp; Notes');
		expect(
			tags.filter((tag) => tag.attrs?.name === 'theme-color').map((tag) => tag.attrs)
		).toEqual([
			{ name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#F0FDFA' },
			{ name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#042F2E' },
		]);
		expect(tags.filter((tag) => tag.tag === 'link').map((tag) => tag.attrs?.href)).toEqual([
			'/favicon-32x32.png',
			'/favicon-16x16.png',
			'/apple-touch-icon.png',
			brandCssUrl(brand),
		]);
		// The Content-Security-Policy allows no inline script (public/_headers).
		expect(tags.some((tag) => tag.tag === 'script')).toBe(false);
	});
});

describe('the build plugin', () => {
	const brand = loadBrand(FIXTURE);
	const plugin = brandPlugin(brand);
	const hook = <T>(value: T | { handler: T } | undefined): T => {
		expect(value).toBeDefined();
		return (
			typeof value === 'object' && value !== null && 'handler' in value
				? value.handler
				: value
		) as T;
	};

	it('writes the stylesheet, every icon and every font into the build', () => {
		const emitted = new Map<string, unknown>();
		const generate = hook(plugin.generateBundle) as (this: unknown) => void;
		generate.call({
			emitFile: ({ fileName, source }: { fileName: string; source: unknown }) =>
				emitted.set(fileName, source),
		});
		expect([...emitted.keys()].sort()).toEqual(
			[...brandAssets(brand).keys()].map((url) => url.slice(1)).sort()
		);
		expect(emitted.get(brandCssUrl(brand).slice(1))).toBe(brandCss(brand));
		expect(emitted.has('pwa-maskable-512x512.png')).toBe(true);
		expect(emitted.size).toBe(1 + BRAND_ICONS.length + 2);
	});

	it('answers for the same paths in dev, and passes everything else on', () => {
		const handlers: ((request: unknown, response: unknown, next: () => void) => void)[] = [];
		const configure = hook(
			plugin.configureServer as unknown as (server: ViteDevServer) => void
		);
		configure({ middlewares: { use: (handler: never) => handlers.push(handler) } } as never);
		const serve = (url: string) => {
			const sent = { type: '', body: undefined as unknown, passed: false };
			handlers[0]?.(
				{ url },
				{
					setHeader: (_: string, value: string) => (sent.type = value),
					end: (body: unknown) => (sent.body = body),
				},
				() => (sent.passed = true)
			);
			return sent;
		};
		expect(serve('/favicon-32x32.png?v=1').type).toBe('image/png');
		expect(serve(brandCssUrl(brand)).body).toBe(brandCss(brand));
		expect(serve(brand.fonts.sans?.faces[0]?.url ?? '').type).toBe('font/woff2');
		expect(serve('/src/main.tsx').passed).toBe(true);
	});

	it('puts the tags into the page', () => {
		const transform = hook(plugin.transformIndexHtml as unknown as () => unknown);
		expect(transform()).toEqual(brandTags(brand));
	});
});
