import type { DocumentFormat } from '@skysa/storage';

import { NOTE_EXTENSION } from '../config.js';
import { conflictContent } from './conflictCopy.js';
import { parseNoteFile } from './note.js';

/**
 * This app's documents, as the sync engine and the adapters are handed them
 * (docs/decisions/0018-the-shared-kit.md): markdown files, each claiming its
 * id in frontmatter (docs/ARCHITECTURE.md §3), and a conflict copy claiming a
 * fresh one. Any text is a note, so it says nothing of `isDocumentText`: a
 * file that will not decode as UTF-8 is unreadable already.
 */
export const NOTE_FORMAT: DocumentFormat = {
	extension: NOTE_EXTENSION,
	mediaType: 'text/markdown',
	claimedId: (content) => parseNoteFile(content).id,
	conflictContent,
};
