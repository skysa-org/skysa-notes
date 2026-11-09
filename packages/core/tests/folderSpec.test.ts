import { describe, expect, it } from 'vitest';

import { NOTES_FOLDER } from '../src/config.js';

describe('NOTES_FOLDER', () => {
	it('names what every library connected since 1.0 already holds', () => {
		// The folder's name, Drive's tag on it and the marker in it are in the
		// user's storage, not in this repo: a library is found by them, so a
		// change here is a library the app no longer finds, or one it takes for
		// another app's. Written out rather than built from the constants, so
		// that an edit to those shows up here as a failure.
		expect(NOTES_FOLDER).toEqual({
			name: 'skysa-notes',
			driveTag: 'notesapp',
			marker: { file: '.notesapp.json', app: 'skysa-notes', version: 1 },
		});
	});
});
