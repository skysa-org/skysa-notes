import { describe, expect, it } from 'vitest';

import { conflictContent } from '../../src/markdown/conflictCopy.js';
import { NOTE_FORMAT } from '../../src/markdown/format.js';

describe('NOTE_FORMAT', () => {
	it('names a note as every library since 1.0 holds it, and uploads it as markdown', () => {
		// The extension is in every file name already synced: another one and
		// the engine would take every note for a file that is not one.
		expect(NOTE_FORMAT.extension).toBe('.md');
		expect(NOTE_FORMAT.mediaType).toBe('text/markdown');
	});

	it('reads the id a note claims from its frontmatter', () => {
		expect(NOTE_FORMAT.claimedId('---\nid: n1\n---\nbody\n')).toBe('n1');
		expect(NOTE_FORMAT.claimedId('body\n')).toBeUndefined();
	});

	it('makes a conflict copy as the app does', () => {
		expect(NOTE_FORMAT.conflictContent).toBe(conflictContent);
	});

	it('takes any text for a note', () => {
		expect(NOTE_FORMAT.isDocumentText).toBeUndefined();
	});
});
