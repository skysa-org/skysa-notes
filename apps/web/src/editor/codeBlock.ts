import { codeBlockSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';

import type { CodeDisplayStore } from './codeDisplay.js';
import { iconElement, type IconName } from './icons.js';
import { CODE_LANGUAGES, findCodeLanguage } from './languages.js';

/**
 * The code block, and the bar of tools that floats under the one you are in.
 *
 * Nothing sits above the code. A block is mostly read, and a row of controls
 * across the top of every one of them is a row of controls in the way of every
 * one of them — so the tools appear under the block the cursor is in, over
 * whatever is beneath, and are gone again the moment the cursor leaves. Which
 * block that is comes from `editor/codeTools.ts` as a class, because the node
 * view cannot see the selection.
 *
 * The text stays ProseMirror's. A nested CodeMirror inside the block is the
 * other way to do this — it is what Milkdown's own code-block component does —
 * and it would put the note's code outside the document the rest of the app
 * reasons about: find and replace walks the ProseMirror doc, the dirty rule
 * reads ProseMirror transactions, and undo is one history. Colour is worth none
 * of that, so the colouring is decorations over the real text instead
 * (`editor/highlight.ts`).
 */

/**
 * What the picker says about a block that names no language — and what it
 * promises, since `editor/autoLanguage.ts` is watching such a block and will
 * fill it in the moment the text says what it is.
 */
const DETECT = 'Detect language';

/** The word in the file, which may be an alias or something never heard of. */
const languageOf = (node: ProseNode): string => {
	const language: unknown = node.attrs.language;
	return typeof language === 'string' ? language : '';
};

/**
 * The option that word picks out. A fence saying `js` is JavaScript and the
 * picker says so, but the file keeps the word the author wrote — a select that
 * showed "Detect language" because it had no option called `js` would be lying
 * about a block it is perfectly able to colour.
 */
const selectedOf = (node: ProseNode): string => {
	const language = languageOf(node);
	return findCodeLanguage(language)?.id ?? language;
};

/**
 * Every language, with the block's own marked as chosen.
 *
 * The mark is the option's `selected` attribute rather than an assignment to
 * the select's `value` afterwards, which is the same thing said in one place
 * instead of two — and one of the two could be a value with no option to match
 * it, which a `<select>` answers by silently showing the first one instead.
 */
const languageOptions = (node: ProseNode): readonly HTMLOptionElement[] => {
	const current = selectedOf(node);
	const chosen = (value: string) => value === current;

	const known = [
		new Option(DETECT, '', chosen(''), chosen('')),
		...CODE_LANGUAGES.map(
			(language) =>
				new Option(language.label, language.id, chosen(language.id), chosen(language.id))
		),
	];

	// A fence can say anything, and a word this app does not know is still the
	// author's. `mermaid` or `jsonnet` keeps its place in the list — and so its
	// place in the file — rather than being silently turned into plain text by
	// a select that could not show it.
	const unknown = findCodeLanguage(current) === undefined && current !== '';
	return unknown ? [...known, new Option(current, current, true, true)] : known;
};

/** A button on the bar. Built by hand, since none of this is React. */
const toolButton = (
	label: string,
	icon: IconName,
	press: () => void,
	options: Readonly<{ pressed?: boolean }> = {}
): HTMLButtonElement => {
	const button = document.createElement('button');
	button.setAttribute('type', 'button');
	button.setAttribute('class', 'code-tool');
	button.setAttribute('title', label);
	button.setAttribute('aria-label', label);
	if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed));
	button.append(iconElement(icon));

	// Before the browser moves focus and drops the selection — the same reason
	// the formatting toolbar's buttons act on `mousedown` (`FormatToolbar.tsx`).
	// It also keeps the block "active", so the bar does not vanish under the
	// pointer as it is being clicked.
	button.addEventListener('mousedown', (event) => {
		event.preventDefault();
		press();
	});
	return button;
};

const codeBlockView =
	(display: CodeDisplayStore) =>
	(initial: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
		// The node the view is currently showing. Held rather than closed over,
		// because ProseMirror hands the view a new one whenever the block changes
		// and the tools have to answer for the block as it is now.
		const held = { current: initial };

		const picker = document.createElement('select');
		// Attributes rather than properties, which is how the repo's rules would
		// rather a DOM object were built (`editor/tasks.ts` says the same).
		picker.setAttribute('class', 'code-tool-language');
		picker.setAttribute('aria-label', 'Code block language');
		picker.replaceChildren(...languageOptions(held.current));
		picker.addEventListener('change', () => {
			const at = getPos();
			if (at === undefined) return;

			view.dispatch(
				view.state.tr.setNodeMarkup(at, undefined, {
					...held.current.attrs,
					language: picker.value,
				})
			);
			// Back to the text, where the user was: the picker is a detour, not a
			// destination.
			view.focus();
		});

		const copy = toolButton('Copy code', 'copy', () => {
			// Asked for rather than assumed, the way the sync scheduler asks for
			// `navigator.locks`: the type says every browser has one, and a test
			// environment and an older browser both look like none.
			if (!('clipboard' in navigator)) return;

			// `writeText` can be refused — a browser without permission, an
			// insecure origin — and there is nothing useful to say about that
			// beyond not having said "Copied".
			void navigator.clipboard
				.writeText(held.current.textContent)
				.then(() => {
					copy.setAttribute('data-copied', 'true');
					setTimeout(() => {
						copy.removeAttribute('data-copied');
					}, 1500);
				})
				.catch(() => undefined);
		});

		const remove = toolButton('Delete code block', 'trash', () => {
			const at = getPos();
			if (at === undefined) return;
			view.dispatch(view.state.tr.delete(at, at + held.current.nodeSize));
			view.focus();
		});

		const wrap = toolButton(
			'Wrap long lines',
			'wrap',
			() => {
				display.set({ ...display.get(), wrap: !display.get().wrap });
			},
			{ pressed: display.get().wrap }
		);

		const numbers = toolButton(
			'Line numbers',
			'line-numbers',
			() => {
				display.set({ ...display.get(), lineNumbers: !display.get().lineNumbers });
			},
			{ pressed: display.get().lineNumbers }
		);

		const bar = document.createElement('div');
		bar.setAttribute('class', 'code-block-tools');
		bar.setAttribute('role', 'group');
		bar.setAttribute('aria-label', 'Code block');
		// Nothing in the bar is part of the note, so it is not part of the
		// editable surface either: a cursor must not be able to land in it, and
		// its own DOM changes are not document changes.
		bar.setAttribute('contenteditable', 'false');
		bar.append(picker, wrap, numbers, copy, remove);

		// The block's own rendering, rather than `codeBlockAttr`'s: that ctx exists
		// for a theme to dress the default `<pre>`, and this view replaces it.
		const code = document.createElement('code');
		const pre = document.createElement('pre');
		pre.append(code);

		const dom = document.createElement('div');
		dom.setAttribute('class', 'code-block');
		dom.setAttribute('data-language', languageOf(held.current));
		dom.append(pre, bar);

		/**
		 * The display settings, on the block and on the buttons that set them.
		 *
		 * Toggled one class at a time rather than written as a whole `class`
		 * attribute, because this element's classes are not all this view's:
		 * `codeActivePlugin` puts `code-block-active` on the very same node, and
		 * rewriting the attribute would take it off again — which is to say the
		 * bar would vanish the moment a button on it was pressed.
		 */
		const paint = () => {
			const { wrap: wrapping, lineNumbers } = display.get();
			dom.classList.toggle('code-block-wrap', wrapping);
			dom.classList.toggle('code-block-numbered', lineNumbers);
			wrap.setAttribute('aria-pressed', String(wrapping));
			numbers.setAttribute('aria-pressed', String(lineNumbers));
		};
		paint();
		const unsubscribe = display.subscribe(paint);

		return {
			dom,
			contentDOM: code,

			update: (node) => {
				if (node.type !== held.current.type) return false;
				held.current = node;

				dom.setAttribute('data-language', languageOf(node));
				// Rebuilt rather than assigned to, because the language may be one
				// this app does not know — a body arriving from sync can say
				// anything — and an option for it has to exist before it can be
				// shown as chosen.
				if (picker.value !== selectedOf(node)) {
					picker.replaceChildren(...languageOptions(node));
				}
				return true;
			},

			/** Using the tools is not editing the document, whatever the DOM thinks. */
			stopEvent: (event) => event.target instanceof Node && bar.contains(event.target),

			ignoreMutation: (mutation) => bar.contains(mutation.target),

			destroy: unsubscribe,
		};
	};

export const codeBlockViewPlugin = (display: CodeDisplayStore) =>
	$view(codeBlockSchema.node, () => codeBlockView(display));
