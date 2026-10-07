import { type Catalog } from '../catalog.js';
import { account } from './account.js';
import { attachedFiles } from './attachedFiles.js';
import { clipboard } from './clipboard.js';
import { common } from './common.js';
import { connect } from './connect.js';
import { editor } from './editor.js';
import { exporting } from './exporting.js';
import { firstImport } from './firstImport.js';
import { importing } from './importing.js';
import { notebooks } from './notebooks.js';
import { notes } from './notes.js';
import { rows } from './rows.js';
import { scheduler } from './scheduler.js';
import { scratchpad } from './scratchpad.js';
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
	account,
	connect,
	importing,
	exporting,
	clipboard,
	scratchpad,
	notebooks,
	notes,
	rows,
	attachedFiles,
	sources,
	unsent,
	firstImport,
	scheduler,
	editor,
} as const satisfies Catalog;
