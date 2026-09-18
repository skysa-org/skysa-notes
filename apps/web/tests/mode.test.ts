import { describe, expect, it } from 'vitest';

import { DEFAULT_EDITOR_MODE, isEditorMode, otherMode } from '../src/editor/mode.js';

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
