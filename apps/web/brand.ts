import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type HtmlTagDescriptor, type Plugin } from 'vite';
import { z } from 'zod';

/**
 * The brand: what the app is called and how it looks, read when the app is
 * built (docs/ARCHITECTURE.md §8, "Brand").
 *
 * A deployment points `NOTES_BRAND` at its own `brand.json` and gets its own
 * name, colours, icons and fonts without changing anything in this repo.
 * Without it, the build uses `brand/brand.json`: "Notes", in gray, on the
 * system fonts. It is a build input and not something `/api/config` answers,
 * because the manifest, the home-screen title and icon, the precache and the
 * first paint are all settled before the app could ask.
 *
 * The brand is never data identity. The app folder, its marker, the IndexedDB
 * name and the lock and cookie names stay as they are whatever this says, or
 * every library already connected would stop being found.
 */

/** The icons, by the names the page and the manifest ask for, and their size. */
export const BRAND_ICONS = [
	{ file: 'favicon-16x16.png', size: 16 },
	{ file: 'favicon-32x32.png', size: 32 },
	{ file: 'apple-touch-icon.png', size: 180 },
	{ file: 'pwa-192x192.png', size: 192 },
	{ file: 'pwa-512x512.png', size: 512 },
	{ file: 'pwa-maskable-512x512.png', size: 512 },
] as const;

export type BrandIconFile = (typeof BRAND_ICONS)[number]['file'];

// Not `new URL(…, import.meta.url)`, which Vite would read as an asset to serve.
export const DEFAULT_BRAND = join(dirname(fileURLToPath(import.meta.url)), 'brand/brand.json');

/** The stacks the app used before it had a brand, and still uses without fonts. */
const SANS_STACK = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO_STACK = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace";

const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour is #RRGGBB');

const scheme = z.strictObject({
	brand: colour.describe('Filled buttons, links and the progress bar.'),
	onBrand: colour.describe('Text on `brand`.'),
	theme: colour.describe("The browser's and the installed app's title bar."),
});

const fontFile = z.strictObject({
	src: z
		.string()
		.regex(/\.woff2$/, 'a font file is .woff2')
		.describe('The .woff2 file, relative to this file.'),
	weight: z
		.union([z.number().int().min(1).max(1000), z.string().regex(/^\d{1,4} \d{1,4}$/)])
		.default(400)
		.describe('A weight, or a variable font\'s range such as "100 900".'),
	style: z.enum(['normal', 'italic']).default('normal'),
	unicodeRange: z
		.string()
		.regex(/^[Uu]\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?(,\s*[Uu]\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?)*$/)
		.optional()
		.describe('The characters this file covers, as CSS writes it.'),
});

const font = z.strictObject({
	family: z
		.string()
		.regex(/^[\w ]+$/, 'a family name is letters, digits and spaces')
		.describe('The family name the files are declared under.'),
	files: z.array(fontFile).min(1),
});

export const brandSchema = z.strictObject({
	$schema: z.string().optional(),
	name: z
		.string()
		.trim()
		.min(1)
		.describe("The app's name: the page title and the install prompt."),
	shortName: z
		.string()
		.trim()
		.min(1)
		.max(12, 'shortName is cut off under a home-screen icon past 12 characters')
		.describe('The name under the icon on a home screen, 12 characters at most.'),
	description: z.string().trim().min(1).describe("The page's and the manifest's description."),
	colors: z.strictObject({
		light: scheme,
		dark: scheme,
		background: colour.describe('The splash screen behind the icon while the app opens.'),
	}),
	icons: z
		.string()
		.min(1)
		.describe(
			'A folder, relative to this file, holding favicon-16x16.png, favicon-32x32.png, apple-touch-icon.png (180), pwa-192x192.png, pwa-512x512.png and pwa-maskable-512x512.png.'
		),
	fonts: z
		.strictObject({ sans: font.optional(), mono: font.optional() })
		.optional()
		.describe('Either, both or neither; a family left out keeps the system stack.'),
});

export interface BrandScheme {
	readonly brand: string;
	readonly onBrand: string;
	readonly theme: string;
}

export interface BrandIcon {
	readonly file: BrandIconFile;
	readonly size: number;
	readonly path: string;
}

export interface BrandFace {
	/** Where the file is on disk. */
	readonly path: string;
	/** Where the app serves it, named by its content so it can be cached forever. */
	readonly url: string;
	readonly weight: number | string;
	readonly style: 'normal' | 'italic';
	readonly unicodeRange?: string;
}

export interface BrandFont {
	readonly family: string;
	readonly faces: readonly BrandFace[];
}

export interface Brand {
	readonly name: string;
	readonly shortName: string;
	readonly description: string;
	readonly colors: Readonly<{ light: BrandScheme; dark: BrandScheme; background: string }>;
	readonly icons: readonly BrandIcon[];
	readonly fonts: Readonly<{ sans?: BrandFont; mono?: BrandFont }>;
}

const digest = (content: string | Buffer): string =>
	createHash('sha256').update(content).digest('hex').slice(0, 12);

/** Width and height out of a PNG's IHDR chunk, which is always the first one. */
const pngSize = (path: string): Readonly<{ width: number; height: number }> | undefined => {
	const bytes = readFileSync(path);
	if (bytes.length < 24 || bytes.subarray(1, 4).toString('ascii') !== 'PNG') return undefined;
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/**
 * Reads and checks a brand file, by default the one in `brand/`. Anything
 * wrong stops the build with what and where: a build that went ahead would
 * install without an icon, or not offer to install at all, and say nothing.
 */
export const loadBrand = (path?: string): Brand => {
	const file = resolve(path ?? DEFAULT_BRAND);
	const fail = (problem: string): never => {
		throw new Error(`Brand file ${file}: ${problem}`);
	};
	if (!existsSync(file)) return fail('there is no such file');
	const parsed = brandSchema.safeParse(parseJson(readFileSync(file, 'utf8')));
	if (!parsed.success) {
		return fail(
			parsed.error.issues
				.map((issue) => `${issue.path.join('.') || 'the file'}: ${issue.message}`)
				.join('; ')
		);
	}
	const input = parsed.data;
	const near = (relative: string): string => resolve(dirname(file), relative);

	const icons = BRAND_ICONS.map(({ file: name, size }): BrandIcon => {
		const at = join(near(input.icons), name);
		if (!existsSync(at)) return fail(`icons: ${name} is missing from ${near(input.icons)}`);
		const found = pngSize(at) ?? fail(`icons: ${name} is not a PNG`);
		if (found.width !== size || found.height !== size) {
			return fail(
				`icons: ${name} is ${String(found.width)}x${String(found.height)}, not ${String(size)}x${String(size)}`
			);
		}
		return { file: name, size, path: at };
	});

	const resolveFont = (
		role: 'sans' | 'mono',
		given: z.infer<typeof font> | undefined
	): BrandFont | undefined =>
		given === undefined
			? undefined
			: {
					family: given.family,
					faces: given.files.map((face): BrandFace => {
						const at = near(face.src);
						if (!existsSync(at)) return fail(`fonts.${role}: ${face.src} is missing`);
						return {
							path: at,
							url: `/brand/${digest(readFileSync(at))}.woff2`,
							weight: face.weight,
							style: face.style,
							...(face.unicodeRange === undefined
								? {}
								: { unicodeRange: face.unicodeRange }),
						};
					}),
				};

	const sans = resolveFont('sans', input.fonts?.sans);
	const mono = resolveFont('mono', input.fonts?.mono);
	return {
		name: input.name,
		shortName: input.shortName,
		description: input.description,
		colors: input.colors,
		icons,
		fonts: { ...(sans === undefined ? {} : { sans }), ...(mono === undefined ? {} : { mono }) },
	};
};

/** The JSON Schema for a brand file, for an editor to complete it with. */
export const brandJsonSchema = (): unknown => z.toJSONSchema(brandSchema, { io: 'input' });

const fontFace = (family: string, face: BrandFace): string =>
	[
		'@font-face {',
		`\tfont-family: '${family}';`,
		`\tsrc: url('${face.url}') format('woff2');`,
		`\tfont-weight: ${String(face.weight)};`,
		`\tfont-style: ${face.style};`,
		'\tfont-display: swap;',
		...(face.unicodeRange === undefined ? [] : [`\tunicode-range: ${face.unicodeRange};`]),
		'}',
	].join('\n');

const stack = (given: BrandFont | undefined, fallback: string): string =>
	given === undefined ? fallback : `'${given.family}', ${fallback}`;

/**
 * The brand as a stylesheet: the fonts, and the custom properties `styles.css`
 * reads for them and for the brand colour. A file of its own on this origin,
 * so the Content-Security-Policy needs nothing new.
 */
export const brandCss = (brand: Brand): string => {
	const { light, dark } = brand.colors;
	const faces = [brand.fonts.sans, brand.fonts.mono].flatMap((given) =>
		given === undefined ? [] : given.faces.map((face) => fontFace(given.family, face))
	);
	return `${[
		...faces,
		[
			':root {',
			`\t--brand: ${light.brand};`,
			`\t--on-brand: ${light.onBrand};`,
			`\t--font-sans: ${stack(brand.fonts.sans, SANS_STACK)};`,
			`\t--font-mono: ${stack(brand.fonts.mono, MONO_STACK)};`,
			'}',
		].join('\n'),
		[
			'@media (prefers-color-scheme: dark) {',
			'\t:root {',
			`\t\t--brand: ${dark.brand};`,
			`\t\t--on-brand: ${dark.onBrand};`,
			'\t}',
			'}',
		].join('\n'),
	].join('\n\n')}\n`;
};

/** Where the brand's stylesheet is served, named by its content. */
export const brandCssUrl = (brand: Brand): string => `/brand/brand-${digest(brandCss(brand))}.css`;

const escapeHtml = (text: string): string =>
	text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');

/** The tags the page's head gets from the brand. No script: the CSP allows none inline. */
export const brandTags = (brand: Brand): readonly HtmlTagDescriptor[] => {
	const attrs = (given: Readonly<Record<string, string>>): Record<string, string> =>
		Object.fromEntries(Object.entries(given).map(([key, value]) => [key, escapeHtml(value)]));
	const tag = (name: string, given: Readonly<Record<string, string>>): HtmlTagDescriptor => ({
		tag: name,
		attrs: attrs(given),
		injectTo: 'head',
	});
	return [
		{ tag: 'title', children: escapeHtml(brand.name), injectTo: 'head' },
		tag('meta', { name: 'description', content: brand.description }),
		tag('meta', {
			name: 'theme-color',
			media: '(prefers-color-scheme: light)',
			content: brand.colors.light.theme,
		}),
		tag('meta', {
			name: 'theme-color',
			media: '(prefers-color-scheme: dark)',
			content: brand.colors.dark.theme,
		}),
		tag('link', { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' }),
		tag('link', { rel: 'icon', href: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' }),
		tag('link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }),
		tag('link', { rel: 'stylesheet', href: brandCssUrl(brand) }),
	];
};

interface BrandAsset {
	readonly type: string;
	readonly source: () => string | Buffer;
}

/** Every file the brand adds to the app, by the path it is served at. */
export const brandAssets = (brand: Brand): ReadonlyMap<string, BrandAsset> =>
	new Map<string, BrandAsset>([
		[brandCssUrl(brand), { type: 'text/css', source: () => brandCss(brand) }],
		...brand.icons.map((icon): [string, BrandAsset] => [
			`/${icon.file}`,
			{ type: 'image/png', source: () => readFileSync(icon.path) },
		]),
		...[brand.fonts.sans, brand.fonts.mono]
			.flatMap((given) => given?.faces ?? [])
			.map((face): [string, BrandAsset] => [
				face.url,
				{ type: 'font/woff2', source: () => readFileSync(face.path) },
			]),
	]);

/**
 * Puts the brand into the build: its tags into the page, and its stylesheet,
 * icons and fonts into `dist/` beside the app, where the service worker's
 * precache picks them up. The dev server answers for the same paths.
 */
export const brandPlugin = (brand: Brand): Plugin => {
	const assets = brandAssets(brand);
	return {
		name: 'notes-brand',
		transformIndexHtml: () => [...brandTags(brand)],
		configureServer: (server) => {
			server.middlewares.use((request, response, next) => {
				const asset = assets.get((request.url ?? '').split('?')[0] ?? '');
				if (asset === undefined) {
					next();
					return;
				}
				response.setHeader('Content-Type', asset.type);
				response.end(asset.source());
			});
		},
		generateBundle() {
			assets.forEach((asset, url) => {
				// eslint-disable-next-line functional/no-this-expressions -- Rollup hands a plugin its context as `this`, and emitting a file needs it.
				this.emitFile({ type: 'asset', fileName: url.slice(1), source: asset.source() });
			});
		},
	};
};
