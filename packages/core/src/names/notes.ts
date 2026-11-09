import { NOTE_EXTENSION } from '../config.js';
import { documentNames } from './conflicts.js';

/**
 * This app's documents' names: a note's ends `.md` (`NOTE_FORMAT`), and a copy
 * of one keeps it. For the app's own code; the engine and the providers are
 * handed the format and ask it instead (docs/decisions/0018-the-shared-kit.md).
 */
export const {
	isDocumentName: isNoteName,
	conflictFilename,
	conflictPath,
} = documentNames(NOTE_EXTENSION);
