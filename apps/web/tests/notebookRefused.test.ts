import { describe, expect, it } from 'vitest';

import { t } from '../src/i18n/t.js';
import { notebookRefused } from '../src/routes/-home/useNotebookActions.js';
import { FolderExistsError } from '../src/store/folders.js';

/**
 * What a notebook the store refused says (`routes/-home/useNotebookActions.ts`), the one
 * rule for making, renaming and moving one.
 */

describe('notebookRefused', () => {
	const taken = new FolderExistsError('Work/Plans', 'Plans');

	it('says the name is taken here, or where it was going, as a warning', () => {
		expect(notebookRefused(taken, 'here', 'unused')).toEqual({
			message: t('shell.notebook.existsHere', { name: 'Plans' }),
			tone: 'warning',
		});
		expect(notebookRefused(taken, 'there', 'unused')).toEqual({
			message: t('shell.notebook.existsThere', { name: 'Plans' }),
			tone: 'warning',
		});
	});

	it('says anything else as the failure it was given, an error', () => {
		expect(notebookRefused(new Error('disk'), 'here', 'Not made.')).toEqual({
			message: 'Not made.',
			tone: 'error',
		});
	});
});
