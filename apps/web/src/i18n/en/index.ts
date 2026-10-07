import { type Catalog } from '../catalog.js';
import { common } from './common.js';
import { find } from './find.js';
import { install } from './install.js';
import { search } from './search.js';
import { share } from './share.js';
import { shell } from './shell.js';

/**
 * The English catalog, and the one every other is checked against: its keys
 * are the app's message keys, and its placeholders and tags are what a
 * translation has to keep.
 */
export const en = {
	common,
	shell,
	find,
	search,
	install,
	share,
} as const satisfies Catalog;
