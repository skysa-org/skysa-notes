import type { DocumentFormat } from '../../src/documentFormat.js';
import { documentNames } from '../../src/names/conflicts.js';

/** A leading block between `---` lines, and what is in it. */
const BLOCK = /^---\n([\s\S]*?)\n---(?:\n|$)/;

/**
 * The documents the engine's and the adapters' own tests sync when a test
 * names none: the fake's `TEST_FOLDER`'s partner, so that those tests assume
 * no app's format (docs/decisions/0018-the-shared-kit.md). Markdown files
 * claiming an id on an `id: <id>` line of a leading `---` block, read by a
 * line rather than by notes' frontmatter parser: every engine test passed on
 * it as it is, so none of them is about notes' format, which notes tests for
 * itself (`NOTE_FORMAT`, `tests/markdown/format.test.ts`).
 */
export const TEST_FORMAT: DocumentFormat = {
	extension: '.md',
	mediaType: 'text/markdown',
	claimedId: (content) => {
		const block = BLOCK.exec(content)?.[1];
		return block === undefined ? undefined : /^id: (\S+)$/m.exec(block)?.[1];
	},
	conflictContent: (localContent, id) => {
		const block = BLOCK.exec(localContent);
		if (block === null) return `---\nid: ${id}\n---\n${localContent}`;
		const rest = (block[1] ?? '').split('\n').filter((line) => !line.startsWith('id:'));
		return `---\n${[`id: ${id}`, ...rest].join('\n')}\n---\n${localContent.slice(block[0].length)}`;
	},
};

/** `TEST_FORMAT`'s names, as the engine and the adapters make them from its extension. */
export const { isDocumentName, conflictFilename, conflictPath } = documentNames(
	TEST_FORMAT.extension
);
