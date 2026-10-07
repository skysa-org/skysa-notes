import { ROOT, SCRATCHPAD_FOLDER } from '@skysa/core';
import { describe, expect, it } from 'vitest';

import {
	findNamedPlace,
	fragmentOf,
	heldPlace,
	noteLink,
	placeFolder,
	placeHash,
	placeState,
	placeTitle,
	readPlaceHash,
	urlSlug,
} from '../src/routes/place.js';

/**
 * The hash is where a link, a bookmark or an address typed says where to go.
 * It spells names as slugs, which read well and can be two names at once, so
 * what matters is that every place the app can be is found again from it, and
 * that a slug two names share opens one of them and always the same one.
 */

describe('a name in the hash', () => {
	it.each([
		['Work Stuff', 'work-stuff'],
		['R&D (2026)', 'r-d-2026'],
		['  Plans -- final.  ', 'plans-final'],
		['q3-plan', 'q3-plan'],
		['Café Ünïcode', 'café-ünïcode'],
		['日本語 メモ', '日本語-メモ'],
		['हिन्दी नोट्स', 'हिन्दी-नोट्स'],
		['!!!', '!!!'],
	])('spells %j as %j', (name, slug) => {
		expect(urlSlug(name)).toBe(slug);
	});

	it('is its own slug, so a typed address reads as one the app wrote', () => {
		for (const name of ['Work Stuff', 'R&D (2026)', '日本語 メモ', '!!!']) {
			expect(urlSlug(urlSlug(name))).toBe(urlSlug(name));
		}
	});
});

describe('the hash', () => {
	it('names a note by its notebooks and its name, as slugs, without `.md`', () => {
		expect(placeHash('Work Stuff/Projects', 'Work Stuff/Projects/q3-plan.md')).toBe(
			'/work-stuff/projects/q3-plan'
		);
		expect(readPlaceHash('/work-stuff/projects/q3-plan')).toEqual({
			folder: 'work-stuff/projects',
			note: 'q3-plan',
		});
	});

	it('names a notebook with nothing open in it by a closing slash', () => {
		expect(placeHash('Work Stuff', undefined)).toBe('/work-stuff/');
		expect(readPlaceHash('/work-stuff/')).toEqual({ folder: 'work-stuff' });
	});

	it('tells a loose note from a notebook of the same name', () => {
		expect(placeHash(ROOT, 'Work.md')).toBe('/work');
		expect(readPlaceHash('/work')).toEqual({ folder: ROOT, note: 'work' });
		expect(readPlaceHash('/work/')).toEqual({ folder: 'work' });
	});

	it('spells the loose notes with nothing open as `/`', () => {
		// The root is `''`, which no hash could tell from no hash at all.
		expect(placeHash(ROOT, undefined)).toBe('/');
		expect(readPlaceHash('/')).toEqual({ folder: ROOT });
	});

	it('names the note, not the notebook above it that is open', () => {
		// The notebook open above the note's own is held by the history entry.
		expect(placeHash('Work', 'Work/Projects/q3-plan.md')).toBe('/work/projects/q3-plan');
	});

	it('names nothing when nothing is open', () => {
		expect(placeHash(undefined, undefined)).toBe('');
		expect(readPlaceHash('')).toEqual({});
	});

	it('reads an address typed with the names as they are', () => {
		expect(readPlaceHash('/Work%20Stuff/Q3%20Plan.md')).toEqual({
			folder: 'work-stuff',
			note: 'q3-plan',
		});
		expect(readPlaceHash('/Work Stuff/')).toEqual({ folder: 'work-stuff' });
	});

	it('escapes nothing in a name of letters, digits and spaces', () => {
		expect(placeHash('Work Stuff', 'Work Stuff/My Big Plan.md')).toBe(
			'/work-stuff/my-big-plan'
		);
	});

	it('is written in characters no browser rewrites, so it reads back as written', () => {
		expect(placeHash('Work Stuff', 'Work Stuff/日本.md')).toMatch(/^[\w\-.!~*'()%/]*$/);
		expect(placeHash('!!!', '!!!/?#.md')).toMatch(/^[\w\-.!~*'()%/]*$/);
	});

	it.each([
		['an anchor', 'section-2'],
		['an empty name', '/work//plan'],
		['a hidden name', '/.clipboard/x'],
		['a broken escape', '/100%/plan'],
	])('names nothing for %s', (_, fragment) => {
		expect(readPlaceHash(fragment)).toEqual({});
	});

	it('is read from an href exactly as written', () => {
		expect(fragmentOf('/?connect=ok#/work-stuff/plan')).toBe('/work-stuff/plan');
		expect(fragmentOf('/?connect=ok')).toBe('');
		expect(fragmentOf('/#/a#b')).toBe('/a#b');
	});
});

describe('the place a hash names, among a source’s', () => {
	const folders = ['Archive', 'Work Stuff', 'Work Stuff/Projects', 'work-stuff', '.clipboard'];
	const note = (path: string) => ({ id: path, path });
	const notes = [
		note('Work Stuff/q3-plan.md'),
		note('Work Stuff/Projects/Big Plan.md'),
		note('work-stuff/agenda.md'),
		note('Scratch Pad.md'),
		note('.clipboard/clip.md'),
	];
	const found = (fragment: string) => findNamedPlace(readPlaceHash(fragment), folders, notes);

	it.each([
		['/work-stuff/q3-plan', 'Work Stuff', 'Work Stuff/q3-plan.md'],
		['/work-stuff/projects/big-plan', 'Work Stuff/Projects', 'Work Stuff/Projects/Big Plan.md'],
		['/scratch-pad', '', 'Scratch Pad.md'],
	])('finds the note %s', (fragment, folder, path) => {
		expect(found(fragment)).toEqual({ folder, note: note(path) });
	});

	it('finds every place the app writes a hash for', () => {
		for (const each of notes.slice(0, 4)) {
			const folder = each.path.includes('/')
				? each.path.slice(0, each.path.lastIndexOf('/'))
				: '';
			expect(found(placeHash(folder, each.path)).note).toEqual(each);
		}
		for (const folder of folders.slice(0, 3)) {
			expect(found(placeHash(folder, undefined)).folder).toBe(folder);
		}
	});

	it('finds a note in whichever of two notebooks spelled alike holds it', () => {
		expect(found('/work-stuff/agenda')).toEqual({
			folder: 'work-stuff',
			note: note('work-stuff/agenda.md'),
		});
	});

	it('opens the first by path of two notebooks spelled alike', () => {
		expect(found('/work-stuff/')).toEqual({ folder: 'Work Stuff' });
	});

	it('leaves the notebook where the note is not there', () => {
		expect(found('/archive/renamed-since')).toEqual({ folder: 'Archive' });
	});

	it('leaves nothing where the notebook is not there either', () => {
		expect(found('/gone/plan')).toEqual({});
		expect(found('/gone/')).toEqual({});
	});

	it('never finds what is hidden', () => {
		expect(found('/clipboard/clip')).toEqual({});
		expect(found('/clipboard/')).toEqual({});
	});

	it('leaves the loose notes for a loose note that is not there', () => {
		expect(found('/gone')).toEqual({ folder: '' });
	});
});

describe('the place a history entry holds', () => {
	it('is taken back as it was written', () => {
		const state = placeState('c1', { folder: 'Work', note: 'n1' });
		expect(heldPlace(state)).toEqual({ connectionId: 'c1', folder: 'Work', note: 'n1' });
	});

	it('holds the loose notes as the root', () => {
		expect(heldPlace(placeState('c1', { folder: ROOT }))).toEqual({
			connectionId: 'c1',
			folder: ROOT,
		});
	});

	it('writes no key for what it does not name', () => {
		expect(placeState('c1', { folder: undefined, note: undefined })).toStrictEqual({
			place: { connectionId: 'c1' },
		});
	});

	it.each([
		['no state', null],
		['the router’s own keys alone', { key: 'k', __TSR_index: 0 }],
		['no source', { place: { folder: 'Work' } }],
		['a note that is not an id', { place: { connectionId: 'c1', note: { a: 1 } } }],
		['a folder that is not a path', { place: { connectionId: 'c1', folder: 7 } }],
	])('is nothing for %s', (_, state) => {
		expect(heldPlace(state)).toBeUndefined();
	});

	it('goes with a link to a note: the note by path, and by id in its source', () => {
		const link = noteLink({ id: 'n1', connectionId: 'c1', path: 'Work/plan.md' });
		expect(link.hash).toBe('/work/plan');
		expect(heldPlace(link.state)).toEqual({ connectionId: 'c1', folder: 'Work', note: 'n1' });
	});
});

describe('the page title', () => {
	it('is the notebooks a note is in, then its title', () => {
		expect(placeTitle({ path: 'Work/Projects/q3-plan.md', title: 'Q3 plan' }, 'Notes')).toBe(
			'Work > Projects > Q3 plan'
		);
	});

	it('is a loose note’s title alone', () => {
		expect(placeTitle({ path: 'scratch.md', title: 'Scratch' }, 'Notes')).toBe('Scratch');
	});

	it('is the app’s name with no note open', () => {
		expect(placeTitle(undefined, 'Notes')).toBe('Notes');
	});
});

describe('the scratchpad’s place', () => {
	const notes = [
		{ id: 's1', path: '.scratchpad/shopping.md' },
		{ id: 's2', path: '.scratchpad/untitled-2.md' },
		{ id: 'n1', path: 'Shopping/shopping.md' },
	];
	const found = (fragment: string) =>
		findNamedPlace(readPlaceHash(fragment), ['Shopping', '.scratchpad'], notes);

	it('is `#scratchpad`, and a card open in it its name after a slash', () => {
		expect(placeHash(SCRATCHPAD_FOLDER, undefined)).toBe('scratchpad');
		expect(placeHash(SCRATCHPAD_FOLDER, '.scratchpad/Shopping List.md')).toBe(
			'scratchpad/shopping-list'
		);
	});

	it('is read back from its hash, a card and all', () => {
		expect(found('scratchpad')).toEqual({ folder: SCRATCHPAD_FOLDER });
		expect(found('scratchpad/shopping')).toEqual({ folder: SCRATCHPAD_FOLDER, note: notes[0] });
		expect(found('scratchpad/untitled-2')).toEqual({
			folder: SCRATCHPAD_FOLDER,
			note: notes[1],
		});
	});

	it('is the scratchpad itself for a card that is not there, or a hash it cannot read', () => {
		expect(found('scratchpad/gone')).toEqual({ folder: SCRATCHPAD_FOLDER });
		expect(found('scratchpad/a/b')).toEqual({ folder: SCRATCHPAD_FOLDER });
		expect(found('scratchpad/')).toEqual({ folder: SCRATCHPAD_FOLDER });
	});

	it('is never reached by a notebook’s hash, nor a notebook by its', () => {
		expect(found('/scratchpad/')).toEqual({});
		expect(found('/shopping/shopping')).toEqual({ folder: 'Shopping', note: notes[2] });
	});

	it('is where a link to a scratch note goes', () => {
		const link = noteLink({ id: 's1', connectionId: 'c1', path: '.scratchpad/shopping.md' });
		expect(link.hash).toBe('scratchpad/shopping');
		expect(heldPlace(link.state)).toEqual({
			connectionId: 'c1',
			folder: SCRATCHPAD_FOLDER,
			note: 's1',
		});
		expect(placeFolder('.scratchpad/deeper/note.md')).toBe(SCRATCHPAD_FOLDER);
		expect(placeFolder('Work/plan.md')).toBe('Work');
	});

	it('is titled "Scratchpad", and after it the name of a card open that has one', () => {
		expect(placeTitle(undefined, 'Notes', SCRATCHPAD_FOLDER)).toBe('Scratchpad');
		expect(
			placeTitle({ path: '.scratchpad/trip.md', title: 'Trip', named: true }, 'Notes')
		).toBe('Scratchpad > Trip');
		expect(
			placeTitle(
				{ path: '.scratchpad/untitled.md', title: 'Untitled', named: false },
				'Notes'
			)
		).toBe('Scratchpad');
	});
});
