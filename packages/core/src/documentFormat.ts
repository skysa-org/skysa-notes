/**
 * What an app's synced files are: handed to the sync engine and the adapters
 * by the app rather than imported, so that the layers bound for the shared kit
 * know no file format of their own (docs/decisions/0018-the-shared-kit.md).
 * The engine moves a document's text whole and never its parts; these are the
 * only questions it asks of what is inside. This app's is `NOTE_FORMAT`, in
 * `markdown/format.ts`.
 */
export interface DocumentFormat {
	/**
	 * The extension a document's name ends with, lowercase, dot included. A
	 * name is a document's when it ends with this as `foldName` folds it, so a
	 * `Report.MD` from a Windows tool is one.
	 */
	readonly extension: string;
	/** What a provider is told a document is, where it is told (Google Drive's uploads). */
	readonly mediaType: string;
	/**
	 * The id a document's text claims, where it carries one. A file written by
	 * something else carries none, and the engine gives it one of its own.
	 */
	readonly claimedId: (content: string) => string | undefined;
	/**
	 * A conflict copy's text (docs/ARCHITECTURE.md §7, "Conflict rule
	 * (concrete)"): the local document's, claiming `id` instead, since two files
	 * claiming one id would be one document.
	 */
	readonly conflictContent: (localContent: string, id: string) => string;
	/**
	 * Whether text read from a document's file is one. A file that is not —
	 * misnamed, or written by a tool as something else — is held as one that
	 * will not decode is (`UnreadableError`): listed, left alone, never
	 * rewritten. Absent, any text is a document.
	 */
	readonly isDocumentText?: (content: string) => boolean;
}
