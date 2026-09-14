import { describe, expect, it } from 'vitest';

import {
	DEFAULT_EDITOR_MODE,
	isEditorMode,
	isModeToggleShortcut,
	otherMode,
} from '../src/editor/mode.js';

const chord = (overrides: Partial<Parameters<typeof isModeToggleShortcut>[0]> = {}) => ({
	key: 'e',
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	...overrides,
});

describe('editor mode', () => {
	it('opens in rich text unless told otherwise', () => {
		expect(DEFAULT_EDITOR_MODE).toBe('rich');
	});

	it('toggles between the two modes', () => {
		expect(otherMode('rich')).toBe('raw');
		expect(otherMode('raw')).toBe('rich');
	});

	it('rejects a stored value that is not a mode', () => {
		expect(isEditorMode('rich')).toBe(true);
		expect(isEditorMode('raw')).toBe(true);
		expect(isEditorMode('wysiwyg')).toBe(false);
		expect(isEditorMode(undefined)).toBe(false);
	});
});

describe('isModeToggleShortcut', () => {
	it('accepts Cmd+E and Ctrl+E', () => {
		expect(isModeToggleShortcut(chord({ metaKey: true }))).toBe(true);
		expect(isModeToggleShortcut(chord({ ctrlKey: true }))).toBe(true);
	});

	it('accepts a capital E, which is what a keyboard reports with caps lock on', () => {
		expect(isModeToggleShortcut(chord({ key: 'E', metaKey: true }))).toBe(true);
	});

	it('ignores E on its own', () => {
		expect(isModeToggleShortcut(chord())).toBe(false);
	});

	it('ignores chords that mean something else', () => {
		// Ctrl+Alt+E and Cmd+Shift+E are other applications' shortcuts.
		expect(isModeToggleShortcut(chord({ ctrlKey: true, altKey: true }))).toBe(false);
		expect(isModeToggleShortcut(chord({ metaKey: true, shiftKey: true }))).toBe(false);
		expect(isModeToggleShortcut(chord({ key: 'r', metaKey: true }))).toBe(false);
	});
});
