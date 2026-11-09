import type { DocumentFormat } from '../documentFormat.js';
import { type EntryRef, type StorageProvider, UnreadableError } from '../providers/types.js';

/**
 * A document's text and version, read from the provider: `read`, with the
 * format's one rule more (`DocumentFormat.isDocumentText`). A file whose text
 * the format says is not a document is answered as one that will not decode
 * as UTF-8 is (`UnreadableError`): listed, left alone, never rewritten
 * (docs/ARCHITECTURE.md §7). Used wherever the engine reads a file to hold or
 * compare it as a document; a read that asks only for a version, or whether
 * bytes are the ones last synced, asks the provider.
 */
export const readDocument = (
	provider: StorageProvider,
	ref: EntryRef,
	document: DocumentFormat
): Promise<{ content: string; version: string }> =>
	provider.read(ref).then((file) => {
		if (document.isDocumentText?.(file.content) === false) throw new UnreadableError(ref.path);
		return file;
	});
