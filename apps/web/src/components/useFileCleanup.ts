import { basename, linkedFiles } from '@skysa/core';
import { useCallback, useEffect, useRef } from 'react';

import { type NoteRecord, noteRef } from '../store/db.js';
import { type FileCleanup, fileCleanup } from '../store/fileCleanup.js';
import { namesFile } from '../store/fileLinks.js';

/**
 * What a visit to a note may have taken out of it, handed to the cleanup as the
 * note is left (`store/fileCleanup.ts`): the files it linked when it was
 * opened, and the ones put in it since — a picture pasted and deleted again is
 * the commonest file nothing links — less any the note still names as it is
 * left. Nothing, for a visit with no edit in it.
 *
 * As it is left: as last typed — saved or not, since autosave waits — or, where
 * a pull has replaced the body since (`bodyOrigin`), as that too. A note
 * edited and then deleted still names its files, and keeps them: a note's
 * delete can be undone, and deleting one deletes none of its files.
 *
 * A visit is the note open under one `noteRef`: another note, the note moved
 * to another source, or the view gone, and it is left. Its links are read as
 * the note was when it was opened, against where it was then; the cleanup
 * reads every note as it is when the time is up.
 */

interface Visit {
	ref: string;
	/** The body as the user last left it, and the pull it was typed over. */
	typed?: { body: string; origin: string };
	added: readonly string[];
}

export interface FileCleanupVisit {
	/** The user edited the note's body to `body`, over the pull `origin` (`bodyOrigin`). */
	readonly edited: (body: string, origin: string) => void;
	/** A file was put in the note, at `path` from the root of its source. */
	readonly added: (path: string) => void;
}

export const useFileCleanup = (
	note: NoteRecord | undefined,
	cleanup: FileCleanup = fileCleanup
): FileCleanupVisit => {
	const ref = note === undefined ? undefined : noteRef(note);
	const latest = useRef(note);
	useEffect(() => {
		latest.current = note;
	}, [note]);
	const visit = useRef<Visit | undefined>(undefined);

	useEffect(() => {
		const opened = latest.current;
		if (ref === undefined || opened === undefined) return undefined;
		cleanup.opened(ref);
		const before = linkedFiles(opened.body, opened.path);
		visit.current = { ref, added: [] };
		return () => {
			const ended = visit.current?.ref === ref ? visit.current : undefined;
			visit.current = undefined;
			const typed = ended?.typed;
			if (ended === undefined || typed === undefined) {
				cleanup.left(ref, opened.connectionId, []);
				return;
			}
			const now = latest.current;
			const pulled = now !== undefined && (now.bodyOrigin ?? '') !== typed.origin;
			const bodies = pulled ? [typed.body, now.body] : [typed.body];
			const gone = [...new Set([...before, ...ended.added])].filter(
				(path) => !bodies.some((body) => namesFile(body, basename(path)))
			);
			cleanup.left(ref, opened.connectionId, gone);
		};
	}, [ref, cleanup]);

	const edited = useCallback((body: string, origin: string) => {
		if (visit.current !== undefined)
			visit.current = { ...visit.current, typed: { body, origin } };
	}, []);
	const added = useCallback((path: string) => {
		if (visit.current !== undefined)
			visit.current = { ...visit.current, added: [...visit.current.added, path] };
	}, []);
	return { edited, added };
};
