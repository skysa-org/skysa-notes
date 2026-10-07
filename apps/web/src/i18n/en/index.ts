import { type Catalog } from '../catalog.js';
import { clipboard } from './clipboard.js';
import { common } from './common.js';
import { editor } from './editor.js';
import { exporting } from './exporting.js';
import { importing } from './importing.js';
import { scratchpad } from './scratchpad.js';
import { shell } from './shell.js';

/**
 * The English catalog, and the one every other is checked against: its keys
 * are the app's message keys, and its placeholders and tags are what a
 * translation has to keep.
 */
export const en = {
	common,
	shell,
	importing,
	exporting,
	clipboard,
	scratchpad,
	editor,
} as const satisfies Catalog;
