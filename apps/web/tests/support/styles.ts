import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STYLES_FOLDER = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'src',
	'styles'
);

/** The files `styles/index.css` imports, in order, however each import goes on to be qualified. */
export const importedStyles = (): readonly string[] => {
	const imported = [
		...readFileSync(join(STYLES_FOLDER, 'index.css'), 'utf8').matchAll(
			/@import\s+['"]\.\/([^'"]+)['"]/g
		),
	].map((match) => match[1] ?? '');
	// A test that reads no rules would pass whatever they say.
	if (imported.length === 0) throw new Error('styles/index.css imports nothing');
	return imported;
};

/** The whole stylesheet as text, in the order `styles/index.css` imports it. */
export const allStyles = (): string =>
	importedStyles()
		.map((file) => readFileSync(join(STYLES_FOLDER, file), 'utf8'))
		.join('\n');
