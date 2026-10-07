import { type Catalog } from '../catalog.js';
import { common } from './common.js';
import { firstImport } from './firstImport.js';
import { scheduler } from './scheduler.js';
import { shell } from './shell.js';
import { sources } from './sources.js';
import { unsent } from './unsent.js';

/**
 * The English catalog, and the one every other is checked against: its keys
 * are the app's message keys, and its placeholders and tags are what a
 * translation has to keep.
 */
export const en = {
	common,
	shell,
	sources,
	unsent,
	firstImport,
	scheduler,
} as const satisfies Catalog;
