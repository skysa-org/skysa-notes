import { useState } from 'react';

import { t } from '../../i18n/t.js';
import type { NotesDatabase } from '../../store/db.js';
import {
	downloadNotice,
	downloadProblem,
	downloadSource,
	type Library,
} from '../../store/exportNotes.js';
import type { OptionsMenuItem } from '../OptionsMenu.js';

/**
 * The whole of one source, as one archive of markdown files: the tree a push
 * would make in its folder (docs/ARCHITECTURE.md §14). Offered once there is
 * something to put in it, and not before, when all it could make is an empty
 * archive.
 *
 * What went wrong is said here, where it was asked for: a download that fails
 * without a word is one the user goes on waiting for. So is an archive handed
 * over without the text an editor could not save (`downloadSource`).
 */
export const useDownloadAll = (
	database: NotesDatabase,
	connectionId: string,
	downloadAll: (library: Library) => void
) => {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const start = () => {
		setBusy(true);
		setProblem(null);
		void downloadSource(database, connectionId, downloadAll)
			.then((answer) => {
				setProblem(downloadNotice(answer));
			})
			.catch((error: unknown) => {
				setProblem(downloadProblem(error));
			})
			.finally(() => {
				setBusy(false);
			});
	};
	return { busy, problem, start };
};

export type Downloading = ReturnType<typeof useDownloadAll>;

/** What went wrong with the download, said where it was asked for. */
export const DownloadAll = ({
	holds,
	downloading,
}: {
	/** `holdsAnything`, as the panel has read it: undefined until it has. */
	holds: boolean | undefined;
	downloading: Downloading;
}) =>
	holds === true && downloading.problem !== null ? (
		<p className="muted" role="alert">
			{downloading.problem}
		</p>
	) : null;

/** The way to start it, as an item of the gear's menu or the `⋯`. */
export const downloadItem = (
	holds: boolean | undefined,
	downloading: Downloading
): OptionsMenuItem[] =>
	holds === true
		? [
				{
					label: t('account.menu.downloadAll'),
					onChoose: downloading.start,
					disabled: downloading.busy,
				},
			]
		: [];
