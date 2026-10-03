import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { closeHistory } from '@milkdown/kit/prose/history';
import { Fragment, type Node as ProseNode, type Schema, Slice } from '@milkdown/kit/prose/model';
import {
	type EditorState,
	Plugin,
	PluginKey,
	Selection,
	type Transaction,
} from '@milkdown/kit/prose/state';
import { dropPoint } from '@milkdown/kit/prose/transform';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';

import { settleAfter } from '../store/heldEdits.js';
import { addProblem, closedProblem, filesToAttach } from './addFiles.js';
import { type Added, attachHostCtx, type AttachmentHost } from './attachHost.js';
import { ATTACHMENT } from './attachment.js';
import { iconElement } from './icons.js';
import { pickFiles } from './pickFiles.js';

/**
 * Files pasted or dropped into the rich editor (#187): each added beside the
 * note through the host, then put in the note — a picture as a picture, any
 * other file as its chip — as the user's own edit, where it was put.
 *
 * Adding one takes a moment: its bytes are read and hashed, and kept here
 * until they are up. Meanwhile it is a placeholder where it is going, which is
 * a decoration and not the document, so a note is never dirty for a file that
 * is not in it yet, and one that is refused leaves nothing behind. Each is put
 * in once it is added, one after another in the order they came, in one
 * transaction each with no programmatic mark: the note is dirty and saved as
 * for anything typed.
 */

const pendingKey = new PluginKey<DecorationSet>('skysa-pending-files');

/** The spec each placeholder is made with, which ProseMirror types as `any`. */
type PendingSpec = Readonly<{ id?: symbol }>;

type PendingMeta =
	| Readonly<{
			add: readonly { id: symbol; name: string }[];
			at: number;
	  }>
	| Readonly<{ done: symbol }>;

const placeholder = (name: string) => (): HTMLElement => {
	const element = document.createElement('span');
	element.setAttribute('class', 'attachment-pending');
	element.setAttribute('aria-busy', 'true');
	element.append(iconElement('file'), `Adding ${name}…`);
	return element;
};

/** Where each file on its way is going, kept where it was through every edit meanwhile. */
export const pendingFiles = new Plugin<DecorationSet>({
	key: pendingKey,
	state: {
		init: () => DecorationSet.empty,
		apply: (tr, set) => {
			const mapped = set.map(tr.mapping, tr.doc);
			const meta = tr.getMeta(pendingKey) as PendingMeta | undefined;
			if (meta === undefined) return mapped;
			if ('done' in meta) {
				return mapped.remove(
					mapped.find(undefined, undefined, (spec: PendingSpec) => spec.id === meta.done)
				);
			}
			// In the order they came. Each sits after whatever is put in where it
			// is — what is typed there meanwhile, and an earlier file of the same
			// paste once that goes in.
			return mapped.add(
				tr.doc,
				meta.add.map(({ id, name }) =>
					Decoration.widget(meta.at, placeholder(name), { id, side: 1 })
				)
			);
		},
	},
	props: {
		decorations: (state) => pendingKey.getState(state),
	},
});

/** Where a file on its way is to go, or nothing where what was around it has gone. */
const placeOf = (state: EditorState, id: symbol): number | undefined =>
	pendingKey.getState(state)?.find(undefined, undefined, (spec: PendingSpec) => spec.id === id)[0]
		?.from;

/** What the note holds for an added file: a picture, or a file's chip. */
const nodeFor = (
	schema: Schema,
	added: Extract<Added, { state: 'added' }>
): ProseNode | undefined =>
	added.kind === 'image'
		? schema.nodes.image?.create({ src: added.href, alt: added.label })
		: schema.nodes[ATTACHMENT]?.create({ href: added.href, label: added.label });

/**
 * A place near `at` where a file can go: in the text there, or beside the
 * block it is in where that holds no file — a code block — or between blocks,
 * where it goes in a paragraph of its own. Between a table's cells, which is
 * nowhere a paragraph can go without being a cell of its own — a new column —
 * it is the text of the nearest cell.
 */
const placeNear = (doc: ProseNode, at: number): number => {
	const probe = doc.type.schema.nodes[ATTACHMENT]?.create({ href: 'probe.bin' });
	if (probe === undefined) return at;
	const $at = doc.resolve(at);
	// Back into the cell it is after, unless it is before them all: the end of
	// a cell, a row or the table is the cell just before it, never the next.
	const toward = $at.index() === 0 ? 1 : -1;
	const near =
		$at.parent.type.spec.tableRole === undefined ? at : Selection.near($at, toward).from;
	return dropPoint(doc, near, new Slice(Fragment.from(probe), 0, 0)) ?? near;
};

/**
 * Put one added file where its placeholder is, or say why it is not there.
 * Answers whether it was lost to the note closing first: added, and with
 * nowhere to go in.
 */
const place = (
	view: EditorView,
	host: AttachmentHost,
	file: File,
	id: symbol,
	added: Added
): boolean => {
	// Said even where the note has closed meanwhile: the page says it, not the note.
	const problem = addProblem(file.name, added);
	if (problem !== undefined) host.report(problem);
	if (view.isDestroyed) return added.state === 'added';
	const done = view.state.tr.setMeta(pendingKey, { done: id });
	const node = added.state === 'added' ? nodeFor(view.state.schema, added) : undefined;
	if (node === undefined) {
		view.dispatch(done);
		return false;
	}
	// Near, not at: what was around it may have become a code block meanwhile.
	const at = placeNear(view.state.doc, placeOf(view.state, id) ?? view.state.selection.from);
	// An undo step of its own, not one with what was typed beside it a moment ago.
	view.dispatch(closeHistory(done.insert(at, node)));
	return false;
};

/**
 * Add `files` to the note and put each in it at `at`, in the document as
 * `start` leaves it: a paste has emptied the selection there. Settling the
 * editors waits for it (`settleAfter`), so a note moved meanwhile is moved
 * with the files its body links once they are in.
 */
export const attachFiles = async (
	view: EditorView,
	host: AttachmentHost,
	files: readonly File[],
	{ start, at, pasted }: { start: Transaction; at: number; pasted: boolean }
): Promise<void> => {
	const pending = files.map((file) => ({ file, id: Symbol(file.name) }));
	view.dispatch(
		start.setMeta(pendingKey, {
			at: placeNear(start.doc, at),
			add: pending.map(({ file, id }) => ({ id, name: file.name })),
		})
	);
	// Once the note has closed, what is left is not added at all: kept beside
	// a note nothing will link it from, each would be one more file nobody put
	// in a note.
	const lost = await pending.reduce<Promise<readonly string[]>>(async (before, { file, id }) => {
		const missed = await before;
		if (view.isDestroyed) return [...missed, file.name];
		const added = await host.add(file, { pasted });
		return place(view, host, file, id, added) ? [...missed, file.name] : missed;
	}, Promise.resolve([]));
	if (lost.length > 0) host.report(closedProblem(lost));
};

/**
 * Files pasted into the note, in place of the selection. Decided from the
 * event's own `clipboardData`, not from the slice ProseMirror has made of it:
 * by then a picture the clipboard named by an address no page can load
 * (Safari's `webkit-fake-url:`) has been turned into its words
 * (`unloadablePicturesInWords`), while the file it came with is still here.
 */
export const attachOnPaste = (
	host: AttachmentHost,
	view: EditorView,
	event: ClipboardEvent
): boolean => {
	const files = filesToAttach(event.clipboardData, 'paste');
	if (files.length === 0) return false;
	const start = view.state.tr.deleteSelection();
	settleAfter(attachFiles(view, host, files, { start, at: start.selection.from, pasted: true }));
	return true;
};

/**
 * Files the user picked, put in the note where its selection is, in place of
 * what is selected — a paste from a dialog. The editor may have gone while
 * the picker was open, and then they are said to be for adding again.
 */
export const attachChosen = (
	view: EditorView,
	host: AttachmentHost,
	files: readonly File[]
): void => {
	if (view.isDestroyed) {
		host.report(closedProblem(files.map((file) => file.name)));
		return;
	}
	view.focus();
	const start = view.state.tr.deleteSelection();
	settleAfter(attachFiles(view, host, files, { start, at: start.selection.from, pasted: false }));
};

/**
 * Ask the user for files, and put them in the note (`attachChosen`): the
 * toolbar's paperclip and the slash menu's Image and File. `accept` is what
 * the picker offers — `image/*` brings up the camera and the photo library on
 * a phone.
 */
export const attachPicked =
	(accept?: string) =>
	(ctx: Ctx): void => {
		const view = ctx.get(editorViewCtx);
		const host = ctx.get(attachHostCtx.key);
		void pickFiles(accept === undefined ? {} : { accept }).then((files) => {
			if (files.length > 0) attachChosen(view, host, files);
		});
	};

/**
 * This editor, offered to the host as where files picked from outside it go
 * (`AttachmentHost.receive`), for as long as it is open.
 */
export const receivePicked = (ctx: Ctx): Plugin =>
	new Plugin({
		view: (view) => {
			const host = ctx.get(attachHostCtx.key);
			return {
				destroy: host.receive((files) => {
					attachChosen(view, host, files);
				}),
			};
		},
	});

/**
 * Files dropped on the note, where they were dropped. The DOM's `drop`, not
 * the view's `handleDrop`, which ProseMirror never asks where it cannot tell
 * what is under the pointer; and never a drag that began in the note, which
 * is ProseMirror's to move.
 */
export const attachOnDrop = (host: AttachmentHost, view: EditorView, event: DragEvent): boolean => {
	if (view.dragging !== null) return false;
	const files = filesToAttach(event.dataTransfer, 'drop');
	if (files.length === 0) return false;
	event.preventDefault();
	const at =
		view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
		view.state.selection.from;
	view.focus();
	settleAfter(attachFiles(view, host, files, { start: view.state.tr, at, pasted: false }));
	return true;
};
