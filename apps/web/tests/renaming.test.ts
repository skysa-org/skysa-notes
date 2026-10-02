import { describe, expect, it } from 'vitest';

import {
	createRenamings,
	type Renaming,
	shownFolder,
	shownSourceName,
} from '../src/store/renaming.js';

/**
 * A notebook or source being renamed, for everything else on screen that names
 * it (`store/renaming.ts`): what they show while it is typed, and when they let
 * go of it.
 */

const notebook = (key: string, text: string): Renaming => ({ kind: 'notebook', key, text });

describe('a notebook’s path, while the notebook is being renamed', () => {
	it('names the notebook, and everything inside it, by what is typed', () => {
		const renaming = notebook('Work', 'Projects');
		expect(shownFolder('Work', renaming)).toBe('Projects');
		expect(shownFolder('Work/Minutes', renaming)).toBe('Projects/Minutes');
		expect(shownFolder('Work/minutes.md', renaming)).toBe('Projects/minutes.md');
	});

	it('renames only the last part of a notebook inside another', () => {
		expect(shownFolder('Work/Minutes/standup.md', notebook('Work/Minutes', 'Notes'))).toBe(
			'Work/Notes/standup.md'
		);
	});

	it('leaves alone a notebook whose name only starts the same', () => {
		expect(shownFolder('Workshop', notebook('Work', 'Projects'))).toBe('Workshop');
	});

	it('says what is stored while nothing is typed, since an empty name is never given', () => {
		expect(shownFolder('Work', notebook('Work', '  '))).toBe('Work');
		expect(shownFolder('Work', undefined)).toBe('Work');
		expect(shownFolder('Work', { kind: 'source', key: 'Work', text: 'Projects' })).toBe('Work');
	});
});

describe('a source’s name, while it is being renamed', () => {
	it('is what is typed, for that source only', () => {
		const renaming: Renaming = { kind: 'source', key: 'c1', text: ' Work ' };
		expect(shownSourceName('c1', 'Dropbox', renaming)).toBe('Work');
		expect(shownSourceName('c2', 'OneDrive', renaming)).toBe('OneDrive');
	});

	it('stays what was given until the store calls it something else', () => {
		const renaming: Renaming = {
			kind: 'source',
			key: 'c1',
			text: 'Work',
			given: { was: 'Dropbox' },
		};
		// The store has not caught up yet.
		expect(shownSourceName('c1', 'Dropbox', renaming)).toBe('Work');
		// It has, and what it says wins.
		expect(shownSourceName('c1', 'Work, again', renaming)).toBe('Work, again');
	});
});

describe('the store', () => {
	it('holds one rename, and tells its listeners each keystroke', () => {
		const renamings = createRenamings();
		const heard: (Renaming | undefined)[] = [];
		const stop = renamings.subscribe(() => heard.push(renamings.get()));

		renamings.typed('notebook', 'Work', 'P');
		renamings.typed('notebook', 'Work', 'Pr');
		expect(heard.map((each) => each?.text)).toEqual(['P', 'Pr']);
		stop();
		renamings.typed('notebook', 'Work', 'Pro');
		expect(heard).toHaveLength(2);
	});

	it('marks it given over what it was called, and lets go only of the one it holds', () => {
		const renamings = createRenamings();
		renamings.typed('source', 'c1', 'Work');
		// Another rename's answers do nothing to this one.
		renamings.give('source', 'c2', 'OneDrive');
		renamings.clear('notebook', 'c1');
		expect(renamings.get()?.given).toBeUndefined();

		renamings.give('source', 'c1', 'Dropbox');
		expect(renamings.get()).toEqual({
			kind: 'source',
			key: 'c1',
			text: 'Work',
			given: { was: 'Dropbox' },
		});
		renamings.clear('source', 'c1');
		expect(renamings.get()).toBeUndefined();
	});
});
