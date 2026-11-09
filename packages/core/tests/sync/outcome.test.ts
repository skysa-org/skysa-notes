import { describe, expect, it } from 'vitest';

import type { ChangeEntry } from '../../src/providers/types.js';
import { metIn, metOf } from '../../src/sync/outcome.js';

/**
 * What a pull says it met of the engine's watch (`sync/outcome.ts`). The
 * engine's tests (`engine/hiddenFolders.test.ts`) reach these through whole
 * pulls; these say what each answers.
 */

const at = (path: string): ChangeEntry => ({
	remoteId: path,
	path,
	kind: 'file',
	version: 'v1',
	modifiedAt: '',
});

const WATCH = {
	first: (path: string) => path.startsWith('.first/'),
	second: (path: string) => path === '.second',
};

describe('metIn', () => {
	it('names what the entries met, in the watch’s order', () => {
		expect(metIn(WATCH, [at('.second'), at('a.md'), at('.first/x')])).toEqual({
			met: ['first', 'second'],
		});
		expect(metIn(WATCH, [at('.second')])).toEqual({ met: ['second'] });
	});

	it('says nothing where nothing was met, or nothing is watched', () => {
		expect(metIn(WATCH, [at('a.md')])).toEqual({});
		expect(metIn({}, [{ deleted: true, remoteId: 'gone' }])).toEqual({});
	});

	it('names every test for a deletion by id alone, which may have been any', () => {
		expect(metIn(WATCH, [{ deleted: true, remoteId: 'gone' }])).toEqual({
			met: ['first', 'second'],
		});
	});
});

describe('metOf', () => {
	it('is every name either outcome met, each once, in the order first met', () => {
		expect(metOf({ met: ['second'] }, { met: ['first', 'second'] })).toEqual({
			met: ['second', 'first'],
		});
		expect(metOf({}, { met: ['first'] })).toEqual({ met: ['first'] });
		expect(metOf({ met: ['first'] }, {})).toEqual({ met: ['first'] });
	});

	it('says nothing where neither met anything', () => {
		expect(metOf({}, {})).toEqual({});
		expect(metOf()).toEqual({});
	});
});
