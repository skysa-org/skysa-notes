import { describe, expect, it } from 'vitest';

import { type ChordEvent, chordLabel, matchesChord, parseChord } from '../src/commands/chord.js';

/**
 * A shortcut has to be two things that agree: what the app listens for, and
 * what it tells the user it listens for. These are about the first, and about
 * the second being the same chord spelled for the keyboard in front of them.
 */

const press = (key: string, held: Partial<ChordEvent> = {}): ChordEvent => ({
	key,
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	...held,
});

describe('reading a chord', () => {
	it('takes the last part as the key and the rest as modifiers', () => {
		expect(parseChord('Mod+Shift+P')).toEqual({ key: 'p', mod: true, shift: true, alt: false });
	});

	it('is a bare key when nothing is held', () => {
		expect(parseChord('/')).toEqual({ key: '/', mod: false, shift: false, alt: false });
	});
});

describe('matching a keystroke', () => {
	const modK = parseChord('Mod+K');

	it('accepts either Cmd or Ctrl for Mod', () => {
		// Not a platform sniff: on a Mac the Ctrl chord is free and on Windows
		// the Meta one belongs to the OS, so taking both costs nothing and a
		// browser reporting an unexpected platform still gets a shortcut.
		expect(matchesChord(modK, press('k', { metaKey: true }))).toBe(true);
		expect(matchesChord(modK, press('k', { ctrlKey: true }))).toBe(true);
	});

	it('ignores the case the keyboard reports', () => {
		expect(matchesChord(modK, press('K', { metaKey: true }))).toBe(true);
	});

	it('does not fire on a modifier the chord did not ask for', () => {
		// `Mod+Shift+K` is a different chord, and possibly somebody else's. A
		// shortcut that swallows it is one key doing two things at random.
		expect(matchesChord(modK, press('k', { metaKey: true, shiftKey: true }))).toBe(false);
		expect(matchesChord(modK, press('k', { metaKey: true, altKey: true }))).toBe(false);
	});

	it('does not fire on the bare key', () => {
		expect(matchesChord(modK, press('k'))).toBe(false);
	});

	it('wants the modifier absent when the chord has none', () => {
		expect(matchesChord(parseChord('/'), press('/'))).toBe(true);
		expect(matchesChord(parseChord('/'), press('/', { ctrlKey: true }))).toBe(false);
	});
});

describe('printing a chord', () => {
	it('uses the platform symbols on an Apple keyboard, and runs them together', () => {
		expect(chordLabel(parseChord('Mod+K'), true)).toBe('⌘K');
		expect(chordLabel(parseChord('Mod+Shift+P'), true)).toBe('⌘⇧P');
	});

	it('uses words and separators everywhere else', () => {
		expect(chordLabel(parseChord('Mod+K'), false)).toBe('Ctrl+K');
		expect(chordLabel(parseChord('Mod+Shift+P'), false)).toBe('Ctrl+Shift+P');
	});

	it('names the keys that have no printable character', () => {
		expect(chordLabel(parseChord('Escape'), false)).toBe('Esc');
		expect(chordLabel(parseChord('Enter'), true)).toBe('↵');
	});
});
