import { type Catalog } from '../catalog.js';
import { account } from './account.js';
import { common } from './common.js';
import { connect } from './connect.js';
import { shell } from './shell.js';

/**
 * The English catalog, and the one every other is checked against: its keys
 * are the app's message keys, and its placeholders and tags are what a
 * translation has to keep.
 */
export const en = {
	common,
	shell,
	account,
	connect,
} as const satisfies Catalog;
