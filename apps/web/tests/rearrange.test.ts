import { ROOT } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import { canDrop, dropMove, type Moving } from '../src/store/rearrange.js';

/**
 * Which drops are allowed, decided without a DOM. Every refusal here is one a
 * pointer can really make — the rows are all next to each other — so each is
 * the answer to a gesture and not to a hypothetical.
 */

const notebook = (path: string): Moving => ({
	kind: 'notebook',
	path,
	name: path.split('/').at(-1) ?? path,
});

const note = (path: string): Moving => ({ kind: 'note', id: 'n1', path, name: 'A note' });

describe('dropping a notebook', () => {
	it('puts it inside the notebook it was dropped on, keeping its name', () => {
		expect(dropMove(notebook('Archive'), 'Work')).toEqual({
			kind: 'notebook',
			from: 'Archive',
			to: 'Work/Archive',
		});
	});

	it('takes it out to the top level', () => {
		expect(dropMove(notebook('Work/Ideas'), ROOT)).toEqual({
			kind: 'notebook',
			from: 'Work/Ideas',
			to: 'Ideas',
		});
	});

	it('refuses itself', () => {
		expect(dropMove(notebook('Work'), 'Work')).toBeUndefined();
	});

	it('refuses its own descendant, which is where it would disappear', () => {
		expect(dropMove(notebook('Work'), 'Work/Ideas')).toBeUndefined();
		expect(dropMove(notebook('Work'), 'Work/Ideas/2026')).toBeUndefined();
	});

	it('refuses the folder it is already in, which has nothing to do', () => {
		expect(dropMove(notebook('Work/Ideas'), 'Work')).toBeUndefined();
		expect(dropMove(notebook('Archive'), ROOT)).toBeUndefined();
	});

	it('allows a notebook whose name merely starts the same', () => {
		// `Workshop` is not inside `Work`, and a prefix test rather than a
		// segment test would have said it was.
		expect(dropMove(notebook('Work'), 'Workshop')).toEqual({
			kind: 'notebook',
			from: 'Work',
			to: 'Workshop/Work',
		});
	});

	it('leaves a name already taken at the destination to the store', () => {
		// The tree is not given to this module, and `moveFolder` refuses the
		// merge with the error the route already has words for. Saying no here
		// as well would mean two rules to keep in step.
		expect(dropMove(notebook('Archive'), 'Work')).toBeDefined();
	});
});

describe('dropping a note', () => {
	it('moves it into the notebook', () => {
		expect(dropMove(note('Work/one.md'), 'Archive')).toEqual({
			kind: 'note',
			id: 'n1',
			into: 'Archive',
		});
	});

	it('brings a loose note into a notebook', () => {
		expect(dropMove(note('one.md'), 'Work')).toEqual({
			kind: 'note',
			id: 'n1',
			into: 'Work',
		});
	});

	it('refuses the notebook it is already in', () => {
		expect(dropMove(note('Work/one.md'), 'Work')).toBeUndefined();
	});

	it('refuses the top level, which the app does not put notes at', () => {
		// Loose notes exist because a remote folder can arrive holding them, and
		// the app never makes one (docs/ARCHITECTURE.md §12.6). A drag out of a notebook
		// would be the app making one.
		expect(dropMove(note('Work/one.md'), ROOT)).toBeUndefined();
	});
});

describe('canDrop', () => {
	it('is the same question as dropMove, asked by a row deciding how to look', () => {
		expect(canDrop(notebook('Work'), 'Archive')).toBe(true);
		expect(canDrop(notebook('Work'), 'Work/Ideas')).toBe(false);
	});
});
