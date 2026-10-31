import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { NodeSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { iconElement, type IconName } from './icons.js';

/** A button in the bar under a chip — or over a picture (`image.ts`) — selected whole. */
export const barButton = (icon: IconName, label: string): HTMLButtonElement => {
	const element = document.createElement('button');
	element.setAttribute('type', 'button');
	element.setAttribute('class', 'attachment-action');
	element.setAttribute('aria-label', label);
	element.setAttribute('title', label);
	element.append(iconElement(icon));
	return element;
};

/**
 * The bar of buttons a node selected whole shows — under a chip, over a
 * picture (`image.ts`), with a secret (`secretBlock.ts`) — and what each of
 * them needs of it: hidden until the node is selected, kept from taking the
 * selection when pressed, Escape back to the node from a button reached with
 * Tab, and a press in it the bar's own rather than an edit.
 */
export interface NodeBar {
	readonly dom: HTMLElement;
	/** For the view's `selectNode`. */
	readonly show: () => void;
	/** For the view's `deselectNode`. */
	readonly hide: () => void;
	/** For the view's `stopEvent`: whether the event is in the bar. */
	readonly holds: (event: Event) => boolean;
}

/** A bar of `buttons`, with a class of its own for the node's look besides. */
export const nodeBar = (
	view: EditorView,
	buttons: readonly HTMLElement[],
	className?: string
): NodeBar => {
	const dom = document.createElement('span');
	dom.setAttribute(
		'class',
		className === undefined ? 'attachment-actions' : `attachment-actions ${className}`
	);
	dom.setAttribute('hidden', '');
	dom.append(...buttons);
	dom.addEventListener('mousedown', (event) => {
		// The node stays selected, and with it the bar.
		event.preventDefault();
	});
	// Back to the node, still selected, from a bar reached with Tab.
	dom.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		view.focus();
	});
	return {
		dom,
		show: () => {
			dom.removeAttribute('hidden');
		},
		hide: () => {
			dom.setAttribute('hidden', '');
		},
		holds: (event) => event.target instanceof Node && dom.contains(event.target),
	};
};

/**
 * Take the node a view draws out of the note, from a button of its own — a
 * bar's, or a code block's tools: an edit like any other, so the note is dirty
 * and saved, and undone as one.
 */
export const removeNode =
	(view: EditorView, getPos: () => number | undefined, node: () => ProseNode) => (): void => {
		const at = getPos();
		if (at === undefined) return;
		view.dispatch(view.state.tr.delete(at, at + node().nodeSize));
		view.focus();
	};

/** What the keyboard can do with a chip, a picture or a secret selected whole (`selectedKey`). */
export interface SelectedKeys {
	/** Open it, answering whether it does: a picture on the web opens nothing. */
	readonly open: () => boolean;
	readonly toBar: () => void;
}

/**
 * Each chip's, picture's and secret's, by the element its view draws: the
 * editor's props have only the view to ask. A node selected whole takes Enter
 * and Tab only where its view has put its keys here (`selectedKey`).
 */
export const selectedKeys = new WeakMap<Node, SelectedKeys>();

/**
 * The keys a chip or a picture selected whole takes: Enter opens it, as Enter
 * on a link does anywhere else, and Tab goes into its bar, which is the
 * keyboard's way to Download and Remove (Escape comes back). Asked before the
 * keymaps (an editor prop, not a plugin's): `splitBlock` would otherwise split
 * the paragraph in front of it, and in a list Tab would indent the item. Only the key alone:
 * Mod+Enter ticks a task, and Shift+Tab is still the list's.
 */
export const selectedKey = (view: EditorView, event: KeyboardEvent): boolean => {
	if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
	if (event.key !== 'Enter' && event.key !== 'Tab') return false;
	const { selection } = view.state;
	if (!(selection instanceof NodeSelection)) return false;
	const at = view.nodeDOM(selection.from);
	if (at === null) return false;
	// Only a node whose view says what they do: a chip, a picture, a secret.
	const keys = selectedKeys.get(at);
	if (keys === undefined) return false;
	if (event.key === 'Enter') return keys.open();
	keys.toBar();
	return true;
};
