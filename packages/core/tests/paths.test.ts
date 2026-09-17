import { describe, expect, it } from 'vitest';

import {
	basename,
	isHidden,
	isWithin,
	joinPath,
	normalizePath,
	parentPath,
	pathSegments,
	rebasePath,
	replaceBasename,
	ROOT,
} from '../src/paths.js';

describe('normalizePath', () => {
	it('trims and collapses separators', () => {
		expect(normalizePath('/work//meetings/')).toBe('work/meetings');
	});

	it('drops . segments', () => {
		expect(normalizePath('work/./meetings')).toBe('work/meetings');
	});

	it('resolves ..', () => {
		expect(normalizePath('work/meetings/../notes')).toBe('work/notes');
	});

	it('keeps names that only look like . and .. segments', () => {
		expect(normalizePath('.notesapp.json')).toBe('.notesapp.json');
		expect(normalizePath('a../...b/.../..c')).toBe('a../...b/.../..c');
		expect(normalizePath('work/..')).toBe(ROOT);
		expect(normalizePath('./work')).toBe('work');
		expect(normalizePath('work/.')).toBe('work');
	});

	it('never lets a path escape the app folder', () => {
		expect(normalizePath('../../etc/passwd')).toBe('etc/passwd');
		expect(normalizePath('work/../../..')).toBe(ROOT);
	});

	it('maps every spelling of the root to the empty string', () => {
		expect(normalizePath('')).toBe(ROOT);
		expect(normalizePath('/')).toBe(ROOT);
		expect(normalizePath('.')).toBe(ROOT);
	});
});

describe('joinPath', () => {
	it('joins and normalizes in one step', () => {
		expect(joinPath('work', 'meetings', 'standup.md')).toBe('work/meetings/standup.md');
	});

	it('treats the root as no prefix', () => {
		expect(joinPath('', 'note.md')).toBe('note.md');
	});
});

describe('pathSegments', () => {
	it('splits a path', () => {
		expect(pathSegments('work/meetings')).toEqual(['work', 'meetings']);
	});

	it('gives the root no segments', () => {
		expect(pathSegments('')).toEqual([]);
	});
});

describe('parentPath', () => {
	it('returns the containing folder', () => {
		expect(parentPath('work/meetings/standup.md')).toBe('work/meetings');
	});

	it('returns the root for a top-level entry', () => {
		expect(parentPath('note.md')).toBe(ROOT);
	});
});

describe('basename and replaceBasename', () => {
	it('reads the final segment', () => {
		expect(basename('work/standup.md')).toBe('standup.md');
		expect(basename('')).toBe(ROOT);
	});

	it('swaps the final segment, keeping the parent', () => {
		expect(replaceBasename('work/old.md', 'new.md')).toBe('work/new.md');
		expect(replaceBasename('old.md', 'new.md')).toBe('new.md');
	});
});

describe('isHidden', () => {
	it('hides anything under a dot segment', () => {
		expect(isHidden('.notesapp.json')).toBe(true);
		expect(isHidden('.trash/old.md')).toBe(true);
		expect(isHidden('work/.hidden.md')).toBe(true);
	});

	it('leaves ordinary paths visible', () => {
		expect(isHidden('work/standup.md')).toBe(false);
	});
});

describe('isWithin', () => {
	it('matches the folder itself and anything beneath it', () => {
		expect(isWithin('work', 'work')).toBe(true);
		expect(isWithin('work/meetings/a.md', 'work')).toBe(true);
	});

	it('does not match a sibling with a shared prefix', () => {
		expect(isWithin('workshop/a.md', 'work')).toBe(false);
	});

	it('treats the root as containing everything', () => {
		expect(isWithin('anything/at/all.md', ROOT)).toBe(true);
	});
});

describe('rebasePath', () => {
	it('moves a path from one folder to another', () => {
		expect(rebasePath('work/meetings/a.md', 'work', 'archive/work')).toBe(
			'archive/work/meetings/a.md'
		);
	});

	it('rebases the folder itself', () => {
		expect(rebasePath('work', 'work', 'archive')).toBe('archive');
	});

	it('leaves a path outside the moved folder alone', () => {
		expect(rebasePath('personal/a.md', 'work', 'archive')).toBe('personal/a.md');
	});

	it('does not catch a sibling with a shared prefix', () => {
		expect(rebasePath('workshop/a.md', 'work', 'archive')).toBe('workshop/a.md');
	});

	it('can move a folder up to the root', () => {
		expect(rebasePath('archive/work/a.md', 'archive/work', '')).toBe('a.md');
	});
});
