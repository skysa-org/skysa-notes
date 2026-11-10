import type { DocumentFormat } from '../../../src/documentFormat.js';

/**
 * A document format that is not markdown: plain text, `.txt` files, claiming
 * an id on a first line `@id <id>`, refusing any that start `BINARY`. The
 * engine and the in-memory store are run with it as well as with
 * `TEST_FORMAT`, so that anything still reading markdown for itself shows
 * (docs/decisions/0018-the-shared-kit.md).
 */
export const TEXT_FORMAT: DocumentFormat = {
	extension: '.txt',
	mediaType: 'text/plain',
	claimedId: (content) => /^@id (\S+)\n/.exec(content)?.[1],
	conflictContent: (localContent, id) => `@id ${id}\n${localContent.replace(/^@id \S+\n/, '')}`,
	isDocumentText: (content) => !content.startsWith('BINARY'),
};
