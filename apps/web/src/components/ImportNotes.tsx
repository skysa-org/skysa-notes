import { MAX_ATTACHMENT_BYTES } from '@skysa/core';
import { useState } from 'react';

import { pickFiles } from '../editor/pickFiles.js';
import { t } from '../i18n/t.js';
import { type NotesDatabase } from '../store/db.js';
import {
	bringsAnything,
	importLibrary,
	type ImportOutcome,
	type ImportPlan,
	ImportRefusedError,
	ImportTooLargeError,
	MAX_IMPORT_BYTES,
	planImport,
	readPicked,
	type Skipped,
	type SkipReason,
} from '../store/importLibrary.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { type OptionsMenuItem } from './OptionsMenu.js';

/**
 * Notes brought in from a folder or a ZIP (docs/ARCHITECTURE.md §7, "Getting a
 * library in"), from the storage panel: picked, read, asked about — what comes
 * in, what stays out and why — and only then written.
 *
 * Asked about because it cannot be taken back in one step: a few thousand
 * notes in, each owed to the remote, is a few thousand notes to delete. And
 * because what stays out is the user's to know before anything happens, not
 * after.
 */

/** What the picker for files offers: archives, and notes picked on their own. */
const ACCEPT = '.zip,application/zip,.md,text/markdown';

type Pick = typeof pickFiles;

type Step =
	| { kind: 'idle' }
	| { kind: 'reading' }
	| { kind: 'asking'; plan: ImportPlan }
	| { kind: 'importing' };

/** "a, b, c and 4 more": enough to find them by, not a wall of paths. */
const NAMED = 3;
const named = (paths: readonly string[]): string => {
	const [first = '', second = '', third = ''] = paths;
	const more = paths.length - NAMED;
	// A second count, inside a sentence that counts the paths already: a plural
	// of its own, which that sentence is given as `{names}`.
	if (more > 0) return t('importing.named.andMore', { first, second, third, count: more });
	if (paths.length === NAMED) return t('importing.named.three', { first, second, third });
	if (paths.length === 2) return t('importing.named.pair', { first, second });
	return first;
};

const WHY: Record<SkipReason, (count: number, names: string) => string> = {
	'not-text': (count, names) => t('importing.leftOut.notText', { count, names }),
	hidden: (count, names) => t('importing.leftOut.hidden', { count, names }),
	'too-large': (count, names) =>
		t('importing.leftOut.tooLarge', {
			count,
			names,
			megabytes: MAX_ATTACHMENT_BYTES / (1024 * 1024),
		}),
	unreadable: (count, names) => t('importing.leftOut.unreadable', { count, names }),
};

/** One line per reason anything stays out, each naming a few of them. */
export const leftOut = (skipped: readonly Skipped[]): string[] =>
	(Object.keys(WHY) as SkipReason[]).flatMap((reason) => {
		const paths = skipped.filter((each) => each.reason === reason).map((each) => each.path);
		return paths.length === 0 ? [] : [WHY[reason](paths.length, named(paths))];
	});

/**
 * The question's first sentence: what comes in, and where. One that counts
 * two or three kinds of thing is chosen on the first of them, and is given the
 * others as plurals of their own (`importing.counts`).
 */
const whatComesIn = ({ notes, files, folders }: ImportPlan, label: string): string => {
	if (notes.length === 0 && files.length === 0) {
		return t('importing.question.emptyNotebooks', { count: folders.length, label });
	}
	const filesSaid = t('importing.counts.files', { count: files.length });
	if (folders.length === 0) {
		if (files.length === 0) {
			return t('importing.question.notes', { count: notes.length, label });
		}
		if (notes.length === 0) {
			return t('importing.question.files', { count: files.length, label });
		}
		return t('importing.question.notesAndFiles', {
			count: notes.length,
			files: filesSaid,
			label,
		});
	}
	const notebooks = t('importing.counts.notebooks', { count: folders.length });
	if (files.length === 0) {
		return t('importing.question.notesInNotebooks', { count: notes.length, notebooks, label });
	}
	if (notes.length === 0) {
		return t('importing.question.filesInNotebooks', { count: files.length, notebooks, label });
	}
	return t('importing.question.notesAndFilesInNotebooks', {
		count: notes.length,
		files: filesSaid,
		notebooks,
		label,
	});
};

/** What an import would bring, as the user is asked about it. */
export const importQuestion = (plan: ImportPlan, label: string): string[] => [
	`${whatComesIn(plan, label)} ${t('importing.question.unchanged')}`,
	...leftOut(plan.skipped),
	...(plan.renamed.length > 0
		? [
				t('importing.question.renamed', {
					count: plan.renamed.length,
					names: named(plan.renamed),
				}),
			]
		: []),
];

/** The first sentence once an import is through: what came in. */
const whatCameIn = ({ notes, files, folders }: ImportOutcome): string => {
	if (notes === 0 && files === 0) return t('importing.outcome.notebooks', { count: folders });
	if (files === 0) return t('importing.outcome.notes', { count: notes });
	if (notes === 0) return t('importing.outcome.files', { count: files });
	// Two counts: chosen on the notes, and given the files as a plural of their own.
	return t('importing.outcome.notesAndFiles', {
		count: notes,
		files: t('importing.counts.files', { count: files }),
	});
};

/** What to say once an import is through. */
export const importOutcome = (outcome: ImportOutcome, label: string, syncs: boolean): string =>
	[
		whatCameIn(outcome),
		...(syncs ? [t('importing.outcome.syncs', { label })] : []),
		...(outcome.numbered > 0
			? [t('importing.outcome.numbered', { count: outcome.numbered })]
			: []),
		...(outcome.present > 0
			? [t('importing.outcome.present', { count: outcome.present })]
			: []),
	].join(' ');

/** Said when what was picked holds nothing to bring in. */
export const nothingToImport = (plan: ImportPlan): string =>
	[t('importing.nothing'), ...leftOut(plan.skipped)].join(' ');

/**
 * Picking, reading, asking and importing, for one source. `start` is called
 * from inside the press that asked for it, and opens the picker before
 * anything is awaited: a browser opens one only for a page the user has just
 * acted on (`pickFiles`).
 *
 * `pick` is the seam a test replaces, since jsdom opens no picker.
 */
export const useImportNotes = (
	database: NotesDatabase,
	connectionId: string,
	{ label, syncs, pick = pickFiles }: { label: string; syncs: boolean; pick?: Pick }
) => {
	const [step, setStep] = useState<Step>({ kind: 'idle' });
	const [said, setSaid] = useState<string | null>(null);

	const start = (how: 'folder' | 'files') => {
		setSaid(null);
		void pick(how === 'folder' ? { folder: true } : { accept: ACCEPT })
			.then(async (files) => {
				if (files.length === 0) return;
				setStep({ kind: 'reading' });
				const plan = planImport(await readPicked(files, how));
				if (!bringsAnything(plan)) {
					setStep({ kind: 'idle' });
					setSaid(nothingToImport(plan));
					return;
				}
				setStep({ kind: 'asking', plan });
			})
			.catch((error: unknown) => {
				setStep({ kind: 'idle' });
				setSaid(
					error instanceof ImportTooLargeError
						? t('importing.tooLarge', { gigabytes: MAX_IMPORT_BYTES / 1024 ** 3 })
						: t('importing.unreadable')
				);
			});
	};

	const confirm = () => {
		if (step.kind !== 'asking') return;
		const { plan } = step;
		setStep({ kind: 'importing' });
		void importLibrary(database, connectionId, plan)
			.then((outcome) => {
				setSaid(importOutcome(outcome, label, syncs));
			})
			.catch((error: unknown) => {
				setSaid(
					error instanceof ImportRefusedError
						? t('importing.refused', { label })
						: t('importing.failed')
				);
			})
			.finally(() => {
				setStep({ kind: 'idle' });
			});
	};

	const cancel = () => {
		setStep({ kind: 'idle' });
	};

	return { step, said, busy: step.kind !== 'idle', start, confirm, cancel, label };
};

export type Importing = ReturnType<typeof useImportNotes>;

/** The two ways in, as items of a source's `⋯` menu. */
export const importItems = (importing: Importing): OptionsMenuItem[] => [
	{
		label: t('importing.importFolder'),
		onChoose: () => {
			importing.start('folder');
		},
		disabled: importing.busy,
	},
	{
		label: t('importing.importFiles'),
		onChoose: () => {
			importing.start('files');
		},
		disabled: importing.busy,
	},
];

/**
 * What an import says, wherever its source's panel is: that it is working, the
 * question, and how it went. The ways in are menu items (`importItems`).
 */
export const ImportNotes = ({ importing }: { importing: Importing }) => {
	const { step, said } = importing;
	return (
		<>
			{step.kind === 'reading' && (
				<p className="muted" role="status">
					{t('importing.reading')}
				</p>
			)}
			{step.kind === 'importing' && (
				<p className="muted" role="status">
					{t('importing.importing')}
				</p>
			)}
			{said !== null && step.kind === 'idle' && (
				<p className="muted wrap-anywhere" role="alert">
					{said}
				</p>
			)}
			{step.kind === 'asking' && (
				<ConfirmDialog
					title={t('importing.title', { label: importing.label })}
					confirmLabel={t('importing.confirm')}
					tone="primary"
					onConfirm={importing.confirm}
					onCancel={importing.cancel}
				>
					{importQuestion(step.plan, importing.label).map((line) => (
						<span key={line} className="import-line wrap-anywhere">
							{line}
						</span>
					))}
				</ConfirmDialog>
			)}
		</>
	);
};
