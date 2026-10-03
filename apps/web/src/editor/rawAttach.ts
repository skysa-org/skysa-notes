import { type Extension, StateEffect, StateField, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { extensionOf } from '@skysa/core';

import { settleAfter } from '../store/heldEdits.js';
import { addProblem, closedProblem, filesToAttach } from './addFiles.js';
import type { Added, AttachmentHost } from './attachHost.js';

/**
 * Files pasted or dropped into raw mode (#187): added beside the note as in
 * rich mode, and put in as the markdown that links them, as the user's own
 * edit. A paste takes the selection at once, as in rich mode. Raw mode shows
 * text, so a file on its way shows nothing; where it is going is kept through
 * whatever is typed meanwhile — what is typed there goes before it, as it would
 * before rich mode's placeholder — and every file of one paste or drop goes in
 * there together once they have all been added, an undo step of its own.
 *
 * A drop of nothing but notes is left to CodeMirror, which puts a dropped
 * text file's words in where it lands, as it always has here.
 */

const track = StateEffect.define<Readonly<{ id: symbol; at: number }>>();
const untrack = StateEffect.define<symbol>();

/** Where each paste or drop on its way is going, through every change meanwhile. */
const spots = StateField.define<ReadonlyMap<symbol, number>>({
	create: () => new Map(),
	update: (value, tr) => {
		const mapped = new Map(
			[...value].map(([id, at]) => [id, tr.changes.mapPos(at, 1)] as const)
		);
		tr.effects.forEach((effect) => {
			if (effect.is(track)) mapped.set(effect.value.id, effect.value.at);
			if (effect.is(untrack)) mapped.delete(effect.value);
		});
		return mapped;
	},
});

const addAll = async (
	view: EditorView,
	host: AttachmentHost,
	files: readonly File[],
	{ start, at, how }: { start: TransactionSpec; at: number; how: 'paste' | 'drop' }
): Promise<void> => {
	const id = Symbol(how);
	view.dispatch(start, { effects: track.of({ id, at }) });
	// Gone with the note: CodeMirror takes its element out of the page. What is
	// left once it has gone is not added, as in rich mode.
	const closed = () => !view.dom.isConnected;
	const answers = await files.reduce<Promise<readonly (readonly [File, Added | undefined])[]>>(
		async (sofar, file) => {
			const done = await sofar;
			if (closed()) return [...done, [file, undefined]];
			const answer = await host.add(file, { pasted: how === 'paste' });
			const problem = addProblem(file.name, answer);
			if (problem !== undefined) host.report(problem);
			return [...done, [file, answer]];
		},
		Promise.resolve([])
	);
	if (closed()) {
		const lost = answers.filter(
			([, answer]) => answer === undefined || answer.state === 'added'
		);
		if (lost.length > 0) host.report(closedProblem(lost.map(([file]) => file.name)));
		return;
	}
	const links = answers.flatMap(([, answer]) => (answer?.state === 'added' ? [answer] : []));
	const insert = links.map((each) => each.markdown).join('');
	if (insert === '') {
		view.dispatch({ effects: untrack.of(id) });
		return;
	}
	const changes = view.state.changes({
		from: view.state.field(spots).get(id) ?? at,
		insert,
	});
	view.dispatch({
		changes,
		// A cursor left where they went goes after them, as after anything
		// pasted; one taken elsewhere meanwhile stays there.
		selection: view.state.selection.map(changes, 1),
		effects: untrack.of(id),
		userEvent: how === 'paste' ? 'input.paste' : 'input.drop',
		scrollIntoView: true,
	});
};

/** Raw mode's paste and drop of files, through the host the editor is given now. */
export const rawAttachments = (host: () => AttachmentHost): Extension => [
	spots,
	EditorView.domEventHandlers({
		paste: (event, view) => {
			const files = filesToAttach(event.clipboardData, 'paste');
			if (files.length === 0) return false;
			const { from, to } = view.state.selection.main;
			const start = { changes: { from, to }, userEvent: 'input.paste' };
			settleAfter(addAll(view, host(), files, { start, at: from, how: 'paste' }));
			return true;
		},
		drop: (event, view) => {
			const files = filesToAttach(event.dataTransfer, 'drop');
			if (files.every((file) => extensionOf(file.name) === 'md')) return false;
			const at =
				view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
				view.state.selection.main.head;
			settleAfter(addAll(view, host(), files, { start: {}, at, how: 'drop' }));
			return true;
		},
	}),
];
