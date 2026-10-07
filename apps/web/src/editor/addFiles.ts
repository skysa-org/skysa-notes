import { MAX_ATTACHMENT_BYTES } from '@skysa/core';

import { t } from '../i18n/t.js';
import type { Added, AttachmentProblem } from './attachHost.js';

/**
 * Files arriving in a note by paste or by drop (#187), whichever editor they
 * arrive in: which of what arrived are files to add, and what to say about one
 * that could not be.
 */

/** As much of a `DataTransfer` as is asked of it. */
export interface Carried {
	readonly files: ArrayLike<File>;
	readonly getData: (format: string) => string;
}

/** The last segment of a path, by either separator. */
const named = (line: string): string => line.split(/[\\/]/).at(-1) ?? line;

/**
 * The files to add, of what a paste or a drop carries: none where what the
 * user means is not the files.
 *
 * A drop is its files. A paste is too, unless it carries words of its own:
 * Excel, Numbers and Word put a picture of the cells or the text beside the
 * text itself, and what the user copied was the text. Words that only name the
 * files — what Finder puts beside a file it copies — are not words of its own.
 */
export const filesToAttach = (data: Carried | null, how: 'paste' | 'drop'): File[] => {
	if (data === null) return [];
	const files = Array.from(data.files);
	if (how === 'drop' || files.length === 0) return files;
	const names = new Set(files.map((file) => file.name));
	const words = data
		.getData('text/plain')
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '');
	return words.every((line) => names.has(named(line))) ? files : [];
};

const MEGABYTES = MAX_ATTACHMENT_BYTES / (1024 * 1024);

/** One file by its name, where it has one; several counted. */
const closedMessage = (names: readonly string[]): string => {
	const [name] = names;
	if (names.length !== 1 || name === undefined) {
		return t('editor.attach.closed.several', { count: names.length });
	}
	return name === ''
		? t('editor.attach.closed.unnamed')
		: t('editor.attach.closed.named', { name });
};

/**
 * What to tell the user about files a paste, drop or pick put in an editor that
 * closed before they could go in, by their names: the note was left, or the
 * other editor chosen. Each is beside the note or never got there; either way,
 * adding it again puts it in — the same bytes are the same file, so no second
 * copy is made.
 */
export const closedProblem = (names: readonly string[]): AttachmentProblem => ({
	message: closedMessage(names),
	tone: 'warning',
});

/** What to tell the user about a file that was not added, by its name; nothing where it was. */
export const addProblem = (name: string, added: Added): AttachmentProblem | undefined => {
	if (added.state === 'failed') {
		return {
			message:
				name === ''
					? t('editor.attach.failed.unnamed')
					: t('editor.attach.failed.named', { name }),
			tone: 'error',
		};
	}
	if (added.state !== 'refused') return undefined;
	if (added.reason === 'too-large') {
		return {
			message:
				name === ''
					? t('editor.attach.tooLarge.unnamed', { size: MEGABYTES })
					: t('editor.attach.tooLarge.named', { name, size: MEGABYTES }),
			tone: 'warning',
		};
	}
	return {
		message:
			name === ''
				? t('editor.attach.isNote.unnamed')
				: t('editor.attach.isNote.named', { name }),
		tone: 'warning',
	};
};
