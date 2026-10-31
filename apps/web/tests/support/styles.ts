import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles');

/** The whole stylesheet as text, in the order `styles/index.css` imports it. */
export const allStyles = (): string =>
	[...readFileSync(join(FOLDER, 'index.css'), 'utf8').matchAll(/@import '\.\/(.+)';/g)]
		.map((match) => readFileSync(join(FOLDER, match[1] ?? ''), 'utf8'))
		.join('\n');
