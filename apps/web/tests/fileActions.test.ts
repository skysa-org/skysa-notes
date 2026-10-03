import { describe, expect, it } from 'vitest';

import {
	type AttachmentHost,
	type AttachmentProblem,
	type Fetched,
	NO_ATTACHMENTS,
} from '../src/editor/attachHost.js';
import { type FileBrowser, openFile, saveFile } from '../src/editor/fileActions.js';

/**
 * Opening and saving a file beside a note (#187), against a browser that
 * records what it was asked to do, in the order it was asked.
 */

const fileNamed = (name: string, type = 'application/octet-stream') =>
	new File(['bytes'], name, { type });

/** A host whose file arrives when the test says, and that keeps what it was told. */
const fakeHost = () => {
	const told: AttachmentProblem[] = [];
	const answer = { current: (_: Fetched): void => undefined };
	const host: AttachmentHost = {
		...NO_ATTACHMENTS,
		fetchFile: () =>
			new Promise((resolve) => {
				answer.current = resolve;
			}),
		report: (problem) => {
			told.push(problem);
		},
	};
	return { host, told, answer: (fetched: Fetched) => answer.current(fetched) };
};

interface Options {
	tab?: boolean;
	share?: 'takes' | 'closed' | 'refused' | 'none';
}

const fakeBrowser = ({ tab = true, share = 'none' }: Options = {}) => {
	const did: string[] = [];
	const files: File[] = [];
	const browser: FileBrowser = {
		openTab: () => {
			did.push('open tab');
			if (!tab) return undefined;
			return {
				show: (url) => {
					did.push(`show ${url}`);
				},
				close: () => {
					did.push('close tab');
				},
			};
		},
		save: (file, name) => {
			files.push(file);
			did.push(`save ${name}`);
		},
		canShare: () => share !== 'none',
		share: (file) => {
			files.push(file);
			did.push(`share ${file.name} as ${file.type}`);
			if (share === 'closed') return Promise.reject(new DOMException('', 'AbortError'));
			if (share === 'refused') return Promise.reject(new DOMException('', 'NotAllowedError'));
			return Promise.resolve();
		},
		urlFor: (blob) => {
			files.push(blob instanceof File ? blob : fileNamed('blob'));
			return 'blob:test/1';
		},
	};
	return { browser, did, files };
};

describe('opening a file', () => {
	it('opens a tab before the bytes come, and shows the file in it once they have', async () => {
		const { host, answer } = fakeHost();
		const { browser, did, files } = fakeBrowser();

		const opening = openFile({ host, href: 'q3-1a2b3c4d.pdf', label: 'Q3.pdf', browser });
		// Still inside the press: the tab is already open.
		expect(did).toEqual(['open tab']);
		answer({ state: 'ready', file: fileNamed('q3-1a2b3c4d.pdf', 'application/pdf') });
		await opening;

		expect(did).toEqual(['open tab', 'show blob:test/1']);
		expect(files[0]?.type).toBe('application/pdf');
	});

	it('closes the tab, and says why, when the file does not come', async () => {
		const { host, told, answer } = fakeHost();
		const { browser, did } = fakeBrowser();

		const opening = openFile({ host, href: 'q3.pdf', label: 'Q3.pdf', browser });
		answer({ state: 'offline' });
		await opening;

		expect(did).toEqual(['open tab', 'close tab']);
		expect(told).toEqual([
			{
				message: 'Q3.pdf is not on this device, and this device is offline.',
				tone: 'warning',
			},
		]);
	});

	it.each([
		['missing', 'Q3.pdf could not be found beside this note.', 'warning'],
		[
			'unavailable',
			'Q3.pdf is not on this device, and its storage cannot be read from now.',
			'warning',
		],
		['failed', 'Q3.pdf could not be downloaded.', 'error'],
	] as const)('says so when it is %s', async (state, message, tone) => {
		const { host, told, answer } = fakeHost();
		const { browser } = fakeBrowser();

		const opening = openFile({ host, href: 'q3.pdf', label: 'Q3.pdf', browser });
		answer({ state });
		await opening;

		expect(told).toEqual([{ message, tone }]);
	});

	it('says nothing when the asking was given up', async () => {
		const { host, told, answer } = fakeHost();
		const { browser, did } = fakeBrowser();

		const opening = openFile({ host, href: 'q3.pdf', label: 'Q3.pdf', browser });
		answer({ state: 'aborted' });
		await opening;

		expect(told).toEqual([]);
		expect(did).toEqual(['open tab', 'close tab']);
	});

	it('names a file with no words by what it is', async () => {
		const { host, told, answer } = fakeHost();
		const { browser } = fakeBrowser();

		const opening = openFile({ host, href: 'q3.pdf', label: '', browser });
		answer({ state: 'missing' });
		await opening;

		expect(told[0]?.message).toBe('That file could not be found beside this note.');
	});

	it('saves, and opens no tab for, a file no tab may show', async () => {
		const { host, answer } = fakeHost();
		const { browser, did } = fakeBrowser();

		const opening = openFile({ host, href: 'page-1a2b3c4d.html', label: 'page.html', browser });
		answer({ state: 'ready', file: fileNamed('page-1a2b3c4d.html') });
		await opening;

		expect(did).toEqual(['save page.html']);
	});

	it('saves the file where the browser refused the tab', async () => {
		const { host, answer } = fakeHost();
		const { browser, did } = fakeBrowser({ tab: false });

		const opening = openFile({ host, href: 'q3.pdf', label: 'Q3.pdf', browser });
		answer({ state: 'ready', file: fileNamed('q3.pdf', 'application/pdf') });
		await opening;

		expect(did).toEqual(['open tab', 'save Q3.pdf']);
	});

	it('closes the tab, and saves, where the file turns out not to be one a tab may show', async () => {
		const { host, answer } = fakeHost();
		const { browser, did } = fakeBrowser();

		// The link says PDF; the file the note's folder has under it is not one.
		const opening = openFile({ host, href: 'odd.pdf', label: 'odd.pdf', browser });
		answer({ state: 'ready', file: fileNamed('odd.pdf.html') });
		await opening;

		expect(did).toEqual(['open tab', 'close tab', 'save odd.pdf.html']);
	});
});

describe('saving a file', () => {
	it('saves it under the name the user knows it by, as the bytes it is', async () => {
		const { host, answer } = fakeHost();
		const { browser, did, files } = fakeBrowser();

		const saving = saveFile({
			host,
			href: 'q3-report-1a2b3c4d.pdf',
			label: 'Q3 report.pdf',
			browser,
		});
		answer({ state: 'ready', file: fileNamed('q3-report-1a2b3c4d.pdf', 'application/pdf') });
		await saving;

		expect(did).toEqual(['save Q3 report.pdf']);
		expect(files[0]?.type).toBe('application/pdf');
	});

	it('keeps the stored name where the words no longer say what the file is', async () => {
		const { host, answer } = fakeHost();
		const { browser, did } = fakeBrowser();

		const saving = saveFile({ host, href: 'q3-1a2b3c4d.pdf', label: 'the figures', browser });
		answer({ state: 'ready', file: fileNamed('q3-1a2b3c4d.pdf') });
		await saving;

		expect(did).toEqual(['save q3-1a2b3c4d.pdf']);
	});

	it('hands it to the share sheet on a touch screen that has one, as what it is', async () => {
		const { host, answer } = fakeHost();
		const { browser, did } = fakeBrowser({ share: 'takes' });

		const saving = saveFile({ host, href: 'logo-1a2b3c4d.svg', label: 'logo.svg', browser });
		answer({ state: 'ready', file: fileNamed('logo-1a2b3c4d.svg') });
		await saving;

		expect(did).toEqual(['share logo.svg as image/svg+xml']);
	});

	it('does nothing more once the user closes the share sheet', async () => {
		const { host, answer } = fakeHost();
		const { browser, did } = fakeBrowser({ share: 'closed' });

		const saving = saveFile({ host, href: 'a.pdf', label: 'a.pdf', browser });
		answer({ state: 'ready', file: fileNamed('a.pdf') });
		await saving;

		expect(did).toEqual(['share a.pdf as application/pdf']);
	});

	it('saves it where the share sheet refused, the press having run out', async () => {
		const { host, answer } = fakeHost();
		const { browser, did } = fakeBrowser({ share: 'refused' });

		const saving = saveFile({ host, href: 'a.pdf', label: 'a.pdf', browser });
		answer({ state: 'ready', file: fileNamed('a.pdf') });
		await saving;

		expect(did).toEqual(['share a.pdf as application/pdf', 'save a.pdf']);
	});

	it('says why when there is nothing to save', async () => {
		const { host, told, answer } = fakeHost();
		const { browser, did } = fakeBrowser();

		const saving = saveFile({ host, href: 'a.pdf', label: 'a.pdf', browser });
		answer({ state: 'failed' });
		await saving;

		expect(did).toEqual([]);
		expect(told).toEqual([{ message: 'a.pdf could not be downloaded.', tone: 'error' }]);
	});
});
