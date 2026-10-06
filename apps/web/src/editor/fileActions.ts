import { contentTypeOf, downloadName, opensInTab, safeOpenType } from '@skysa/core';

import { COARSE_POINTER } from '../components/layout.js';
import { DOWNLOAD_GRACE_MS } from '../store/exportNotes.js';
import type { AttachmentHost, AttachmentProblem, Fetched } from './attachHost.js';

/**
 * Opening and saving a file beside a note, from its chip (#187).
 *
 * **What may open in a tab is an allowlist** (`opensInTab`, `safeOpenType` in
 * `@skysa/core`): a `blob:` URL is this app's origin, so a file opened as HTML
 * or SVG would run whatever it holds as the app, with the storage credential in
 * reach. A picture, a PDF, a recording or a film opens in the browser's own
 * viewer; everything else is saved, never shown. That is the rule CLAUDE.md's
 * `sk1_` trade-off rests on, and docs/ARCHITECTURE.md §9 lists it as one.
 */

/** A tab opened for a file, before its bytes have come. */
export interface FileTab {
	readonly show: (url: string) => void;
	readonly close: () => void;
}

/** What opening and saving need of the browser: the seam a test stands in for. */
export interface FileBrowser {
	/** A new tab, or nothing where the browser refused one. */
	readonly openTab: () => FileTab | undefined;
	/** Hand a file to the user's disk, under `name`. */
	readonly save: (file: File, name: string) => void;
	/** Whether the system's share sheet would take it, on a touch screen. */
	readonly canShare: (file: File) => boolean;
	readonly share: (file: File) => Promise<void>;
	/** A URL for `blob`, let go of once whatever it was handed to has read it. */
	readonly urlFor: (blob: Blob) => string;
}

const revokeLater = (url: string): void => {
	setTimeout(() => {
		URL.revokeObjectURL(url);
	}, DOWNLOAD_GRACE_MS);
};

export const browserFiles: FileBrowser = {
	openTab: () => {
		const tab = window.open('about:blank', '_blank');
		if (tab === null) return undefined;
		return {
			show: (url) => {
				tab.location.replace(url);
			},
			close: () => {
				tab.close();
			},
		};
	},
	save: (file, name) => {
		const url = URL.createObjectURL(file);
		const link = document.createElement('a');
		try {
			link.setAttribute('href', url);
			link.setAttribute('download', name);
			link.setAttribute('hidden', '');
			document.body.append(link);
			link.click();
		} finally {
			link.remove();
			revokeLater(url);
		}
	},
	canShare: (file) =>
		window.matchMedia(COARSE_POINTER).matches &&
		typeof navigator.canShare === 'function' &&
		navigator.canShare({ files: [file] }),
	share: (file) => navigator.share({ files: [file] }),
	urlFor: (blob) => {
		const url = URL.createObjectURL(blob);
		revokeLater(url);
		return url;
	},
};

/** What to tell the user about a file that did not come, by its name. */
const PROBLEMS: Readonly<
	Record<Exclude<Fetched['state'], 'ready' | 'aborted'>, (label: string) => AttachmentProblem>
> = {
	missing: (label) => ({
		message: `${label} could not be found beside this note.`,
		tone: 'warning',
	}),
	offline: (label) => ({
		message: `${label} is not on this device, and this device is offline.`,
		tone: 'warning',
	}),
	unavailable: (label) => ({
		message: `${label} is not on this device, and its storage cannot be read from now.`,
		tone: 'warning',
	}),
	failed: (label) => ({ message: `${label} could not be downloaded.`, tone: 'error' }),
};

export interface FileRequest {
	readonly host: AttachmentHost;
	/** The link, as the note has it. */
	readonly href: string;
	/** What the chip calls it: the name the user knows it by. */
	readonly label: string;
	readonly browser?: FileBrowser;
}

/** The file's bytes, or nothing, the user told why. */
const fetched = async ({ host, href, label }: FileRequest): Promise<File | undefined> => {
	const got = await host.fetchFile(href);
	if (got.state === 'ready') return got.file;
	if (got.state !== 'aborted')
		host.report(PROBLEMS[got.state](label === '' ? 'That file' : label));
	return undefined;
};

/**
 * Whether the share sheet has dealt with the file: taken it, or been closed by
 * the user. Refused — the press that asked no longer counts once a download has
 * run long — it has not, and the file is saved instead.
 */
const sharedAway = async (browser: FileBrowser, file: File): Promise<boolean> => {
	if (!browser.canShare(file)) return false;
	try {
		await browser.share(file);
		return true;
	} catch (error) {
		return error instanceof DOMException && error.name === 'AbortError';
	}
};

/**
 * Hand the file over: to the share sheet on a touch screen that has one, which
 * is where a phone saves a file ("Save to Files"), and to the disk otherwise.
 * Under the name the user knows it by (`downloadName`), and shared as what it
 * is, since a share sheet sends it elsewhere rather than opening it here.
 */
const deliver = async (browser: FileBrowser, file: File, label: string): Promise<void> => {
	const name = downloadName(label, file.name);
	const shared = new File([file], name, {
		type: contentTypeOf(file.name) ?? 'application/octet-stream',
	});
	if (await sharedAway(browser, shared)) return;
	browser.save(file, name);
};

/** Save the file, whatever it is. */
export const saveFile = async (request: FileRequest): Promise<void> => {
	const file = await fetched(request);
	if (file === undefined) return;
	await deliver(request.browser ?? browserFiles, file, request.label);
};

/**
 * Save bytes this device already has, under the name the user knows them by:
 * an item on a source's clipboard, which no note links (docs/ARCHITECTURE.md
 * §7, "The clipboard"). `storedName` is what it is stored as, whose extension
 * `downloadName` holds the label to.
 */
export const saveBytes = (
	bytes: ArrayBuffer,
	label: string,
	storedName: string,
	browser: FileBrowser = browserFiles
): Promise<void> => deliver(browser, new File([bytes], storedName), label);

/** The file's name as the link has it, for deciding before the bytes come. */
const namedIn = (href: string): string => href.slice(href.lastIndexOf('/') + 1);

/**
 * Open the file: in a tab, for one a browser shows in a viewer of its own
 * (`opensInTab`), and saved otherwise.
 *
 * The tab is opened before anything is awaited, while the press that asked for
 * it still counts as the user's: one opened when the bytes arrive is a pop-up,
 * and blocked as one. It is closed again if no bytes come, or if they turn out
 * to be a file that does not open in one; where it was refused, the file is
 * saved instead.
 */
export const openFile = async (request: FileRequest): Promise<void> => {
	const browser = request.browser ?? browserFiles;
	const tab = opensInTab(namedIn(request.href)) ? browser.openTab() : undefined;
	const file = await fetched(request);
	if (file === undefined) {
		tab?.close();
		return;
	}
	if (tab !== undefined && opensInTab(file.name)) {
		// Typed here, where the tab is given it, rather than trusted from
		// whoever made the `File`: what this origin opens is the allowlist's.
		tab.show(browser.urlFor(new Blob([file], { type: safeOpenType(file.name) })));
		return;
	}
	tab?.close();
	await deliver(browser, file, request.label);
};
