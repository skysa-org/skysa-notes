import { describe, expect, it } from 'vitest';

import { NOTES_FOLDER } from '../src/config.js';
import { buildMarker, parseMarker, serializeMarker } from '../src/marker.js';

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

	it('reads the marker 1.0 wrote, and writes the same', () => {
		// The marker's reading and writing go to the shared kit
		// (docs/decisions/0018-the-shared-kit.md), and every library connected
		// since 1.0 holds one at its root, which every device since reads. As 1.0
		// wrote it, byte for byte, so that a change there that stops this app
		// reading its own folders, or a 1.0 device reading a new one's, fails
		// here.
		const written = [
			'{',
			'  "schemaVersion": 1,',
			'  "app": "skysa-notes",',
			'  "createdAt": "2026-10-08T09:14:03.512Z",',
			'  "createdBy": {',
			'    "appVersion": "1.0.0",',
			'    "provider": "gdrive",',
			'    "clientId": "018f3c4e-0000-7000-8000-000000000000",',
			'    "userAgent": "Mozilla/5.0 (test)"',
			'  }',
			'}',
			'',
		].join('\n');

		expect(parseMarker(written, NOTES_FOLDER.marker).status).toBe('ok');
		expect(
			serializeMarker(
				buildMarker({
					marker: NOTES_FOLDER.marker,
					appVersion: '1.0.0',
					provider: 'gdrive',
					clientId: '018f3c4e-0000-7000-8000-000000000000',
					userAgent: 'Mozilla/5.0 (test)',
					now: new Date('2026-10-08T09:14:03.512Z'),
				})
			)
		).toBe(written);
	});
});
