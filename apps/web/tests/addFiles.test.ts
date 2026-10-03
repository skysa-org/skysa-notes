import { describe, expect, it } from 'vitest';

import { addProblem, type Carried, closedProblem, filesToAttach } from '../src/editor/addFiles.js';

/**
 * Which of what a paste or a drop carries are files to add (#187), and what to
 * say about one that was not added.
 */

const fileNamed = (name: string) => new File(['bytes'], name);

const carrying = (files: File[], text = ''): Carried => ({
	files,
	getData: (format) => (format === 'text/plain' ? text : ''),
});

describe('what a paste carries', () => {
	it('is its files, where it carries nothing else', () => {
		const shot = fileNamed('image.png');

		expect(filesToAttach(carrying([shot]), 'paste')).toEqual([shot]);
	});

	it('is its words, where it carries words of its own beside a picture of them', () => {
		// What Excel puts on the clipboard for a range of cells.
		const cells = carrying([fileNamed('image.png')], 'Q1\t120\nQ2\t140\n');

		expect(filesToAttach(cells, 'paste')).toEqual([]);
	});

	it('is its files, where its words only name them', () => {
		const report = fileNamed('Q3 report.pdf');
		const notes = fileNamed('notes.txt');

		// What Finder puts beside the files it copies; a path, in some browsers.
		expect(
			filesToAttach(carrying([report, notes], 'Q3 report.pdf\rnotes.txt'), 'paste')
		).toEqual([report, notes]);
		expect(filesToAttach(carrying([report], '/Users/me/Q3 report.pdf\n'), 'paste')).toEqual([
			report,
		]);
		expect(filesToAttach(carrying([report], 'C:\\Users\\me\\Q3 report.pdf'), 'paste')).toEqual([
			report,
		]);
	});

	it('is its files, where its words are only space', () => {
		const shot = fileNamed('image.png');

		expect(filesToAttach(carrying([shot], ' \n\t\n'), 'paste')).toEqual([shot]);
	});

	it('is nothing, where it carries no files', () => {
		expect(filesToAttach(carrying([], 'words'), 'paste')).toEqual([]);
		expect(filesToAttach(null, 'paste')).toEqual([]);
	});
});

describe('what a drop carries', () => {
	it('is its files, whatever words come with them', () => {
		const photo = fileNamed('photo.jpg');

		expect(filesToAttach(carrying([photo], 'something else'), 'drop')).toEqual([photo]);
		expect(filesToAttach(null, 'drop')).toEqual([]);
	});
});

describe('what is said about a file not added', () => {
	it.each([
		[
			{ state: 'refused', reason: 'too-large' } as const,
			{
				message: 'film.mov is over 25 MB, the most a file beside a note can be.',
				tone: 'warning',
			},
		],
		[
			{ state: 'refused', reason: 'note' } as const,
			{
				message: 'film.mov cannot be added: a .md file beside a note is another note.',
				tone: 'warning',
			},
		],
		[
			{ state: 'failed' } as const,
			{ message: 'film.mov could not be added to the note.', tone: 'error' },
		],
	])('says why: %o', (added, problem) => {
		expect(addProblem('film.mov', added)).toEqual(problem);
	});

	it('says nothing of a file added, or where there was nowhere to add it', () => {
		expect(addProblem('a.pdf', { state: 'unavailable' })).toBeUndefined();
		expect(
			addProblem('a.pdf', {
				state: 'added',
				fileId: 'f',
				href: 'a.pdf',
				label: 'a.pdf',
				kind: 'file',
				markdown: '[a.pdf](a.pdf)',
			})
		).toBeUndefined();
	});

	it('says that the note closed before the files could go in, and to add them again', () => {
		expect(closedProblem(['a.pdf'])).toEqual({
			message: 'The note closed before a.pdf could go in. Add it again to put it in.',
			tone: 'warning',
		});
		expect(closedProblem(['a.pdf', 'b.pdf', 'c.pdf']).message).toBe(
			'The note closed before 3 files could go in. Add them again to put them in.'
		);
		expect(closedProblem(['']).message).toBe(
			'The note closed before the file could go in. Add it again to put it in.'
		);
	});

	it('names a file with no name by what it is', () => {
		expect(addProblem('', { state: 'failed' })?.message).toBe(
			'That file could not be added to the note.'
		);
	});
});
