import { MAX_ATTACHMENT_BYTES } from '@skysa/core';
import { useState } from 'react';

import { pickFiles } from '../editor/pickFiles.js';
import { type NotesDatabase } from '../store/db.js';
import {
	bringsAnything,
	importLibrary,
	type ImportOutcome,
	type ImportPlan,
	ImportRefusedError,
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

const counted = (count: number, one: string, many: string): string =>
	`${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/** "a, b, c and 4 more": enough to find them by, not a wall of paths. */
const NAMED = 3;
const named = (paths: readonly string[]): string => {
	const shown = paths.slice(0, NAMED).join(', ');
	const more = paths.length - NAMED;
	return more > 0 ? `${shown} and ${String(more)} more` : shown;
};

const WHY: Record<SkipReason, (count: number) => string> = {
	'not-text': (count) =>
		`${counted(count, 'note is', 'notes are')} not UTF-8 text, which this app leaves alone. Save ${count === 1 ? 'it' : 'them'} as UTF-8 and import again`,
	hidden: (count) =>
		`${counted(count, 'note has', 'notes have')} a name, or ${count === 1 ? 'is' : 'are'} in a folder, beginning with a dot, which this app keeps hidden`,
	'too-large': (count) =>
		`${counted(count, 'file is', 'files are')} over ${String(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB, the most a file beside a note can be`,
	unreadable: (count) =>
		`${counted(count, 'file', 'files')} could not be read from ${count === 1 ? 'its' : 'their'} archive`,
};

/** One line per reason anything stays out, each naming a few of them. */
export const leftOut = (skipped: readonly Skipped[]): string[] =>
	(Object.keys(WHY) as SkipReason[]).flatMap((reason) => {
		const paths = skipped.filter((each) => each.reason === reason).map((each) => each.path);
		return paths.length === 0
			? []
			: [`Left out: ${WHY[reason](paths.length)}: ${named(paths)}.`];
	});

/** What an import would bring, as the user is asked about it. */
export const importQuestion = (plan: ImportPlan, label: string): string[] => {
	const things = [
		...(plan.notes.length > 0 ? [counted(plan.notes.length, 'note', 'notes')] : []),
		...(plan.files.length > 0 ? [counted(plan.files.length, 'file', 'files')] : []),
	];
	const what =
		things.length === 0
			? counted(plan.folders.length, 'empty notebook', 'empty notebooks')
			: `${things.join(' and ')}${plan.folders.length > 0 ? `, in ${counted(plan.folders.length, 'notebook', 'notebooks')},` : ''}`;
	return [
		`${what} will be added to ${label}, beside what is there. Nothing there is changed or replaced; a name that is taken gets a number.`,
		...leftOut(plan.skipped),
		...(plan.renamed.length > 0
			? [
					`${counted(plan.renamed.length, 'name has', 'names have')} a character storage providers refuse, changed to _: ${named(plan.renamed)}.`,
				]
			: []),
	];
};

/** What to say once an import is through. */
export const importOutcome = (outcome: ImportOutcome, label: string, syncs: boolean): string => {
	const things = [
		...(outcome.notes > 0 ? [counted(outcome.notes, 'note', 'notes')] : []),
		...(outcome.files > 0 ? [counted(outcome.files, 'file', 'files')] : []),
	];
	const what =
		things.length === 0
			? `Imported ${counted(outcome.folders, 'notebook', 'notebooks')}.`
			: `Imported ${things.join(' and ')}.`;
	return [
		what,
		...(syncs ? [`They go up to ${label} as it syncs.`] : []),
		...(outcome.numbered > 0
			? [
					`${counted(outcome.numbered, 'note', 'notes')} took a numbered name, a note there having ${outcome.numbered === 1 ? 'its' : 'theirs'} already.`,
				]
			: []),
		...(outcome.present > 0
			? [`${counted(outcome.present, 'file was', 'files were')} there already.`]
			: []),
	].join(' ');
};

/** Said when what was picked holds nothing to bring in. */
export const nothingToImport = (plan: ImportPlan): string =>
	['Nothing to import: no notes or files were found.', ...leftOut(plan.skipped)].join(' ');

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
			.catch(() => {
				setStep({ kind: 'idle' });
				setSaid('The files could not be read, so nothing was imported.');
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
						? `${label} cannot take an import now, so nothing was imported.`
						: 'The notes could not be imported, so nothing was changed. Try again.'
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
		label: 'Import a folder…',
		onChoose: () => {
			importing.start('folder');
		},
		disabled: importing.busy,
	},
	{
		label: 'Import files…',
		onChoose: () => {
			importing.start('files');
		},
		disabled: importing.busy,
	},
];

/**
 * The import's buttons, where the panel has buttons rather than a menu, and
 * what it says: that it is working, the question, and how it went.
 */
export const ImportNotes = ({ importing, buttons }: { importing: Importing; buttons: boolean }) => {
	const { step, said } = importing;
	return (
		<>
			{buttons && (
				<div className="account-import" role="group" aria-label="Import notes">
					{importItems(importing).map((item) => (
						<button
							key={item.label}
							type="button"
							disabled={item.disabled}
							onClick={item.onChoose}
						>
							{item.label}
						</button>
					))}
				</div>
			)}
			{step.kind === 'reading' && (
				<p className="muted" role="status">
					Reading the files…
				</p>
			)}
			{step.kind === 'importing' && (
				<p className="muted" role="status">
					Importing…
				</p>
			)}
			{said !== null && step.kind === 'idle' && (
				<p className="muted wrap-anywhere" role="alert">
					{said}
				</p>
			)}
			{step.kind === 'asking' && (
				<ConfirmDialog
					title={`Import into ${importing.label}?`}
					confirmLabel="Import"
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
