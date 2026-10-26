import { cell } from '@skysa/core';

import { t } from '../i18n/t.js';

/**
 * A secret's words, revealed (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * a plain-text field of its own, outside the note's document, with Cancel,
 * Copy and Done, in that order, as every dialog's row is (`DialogActions`).
 * Over the words, its label: what the closed secret is called, which is not
 * encrypted, and says so.
 * The same panel under a revealed block and where a new secret is being
 * written, in either editor. What is typed in it is kept as it is typed, as
 * what is typed in the note is.
 *
 * Built by hand, as the code block's bar is (`codeBlock.ts`): what holds it
 * is a node view or a widget, not React. The field keeps the browser's
 * helpers out of the words: spell check, which in Chrome's enhanced mode
 * sends text to Google, and autocomplete, autocorrect, capitalising and
 * writing suggestions. Words dragged out of it go nowhere: dropped in the
 * note, they would be in it as they are.
 */

export interface SecretPanelOptions {
	/** The words it opens with: a revealed secret's, or none for a new one. */
	readonly words: string;
	/** The label it opens with: what its fence calls it, or nothing. */
	readonly label: string;
	/** What is in the label changed: it is to be kept, as the words are. */
	readonly onLabel: () => void;
	/**
	 * What is in the field changed: it is to be kept. Not while an input
	 * method is still composing a character, which is kept as it ends.
	 */
	readonly onInput: () => void;
	/** Done, or Mod+Enter: the panel closed. */
	readonly onDone: () => void;
	/** Cancel, or Escape: the secret is put back as it was revealed. */
	readonly onCancel: () => void;
	/** Copy: the words to the system clipboard, answering whether they went. */
	readonly onCopy: (words: string) => Promise<boolean>;
}

/** Where the caret is in the field. */
interface Caret {
	readonly start: number;
	readonly end: number;
}

export interface SecretPanel {
	readonly dom: HTMLElement;
	/** What is in the field now. */
	readonly words: () => string;
	/** Whether that is not what was last kept, or what it opened with. */
	readonly changed: () => boolean;
	/** `words` kept: what is in the field is new only where it is not them. */
	readonly mark: (words: string) => void;
	/** Where the caret is, while the field has the focus. */
	readonly caret: () => Caret | undefined;
	/** The focus in the field, the caret at `at` if the focus was not there already. */
	readonly focus: (at?: Caret) => void;
	/** Something said under the field, or nothing. */
	readonly say: (message: string | undefined) => void;
	/** What is in the label now, as typed. */
	readonly label: () => string;
	/** Whether that is not what was last kept, or what it opened with. */
	readonly labelChanged: () => boolean;
	/** `label` kept. */
	readonly markLabel: (label: string) => void;
	/**
	 * The label as the note now has it, changed there — undone, or pulled —
	 * and kept; not while it is being typed in, where what is typed is the
	 * label.
	 */
	readonly setLabel: (label: string) => void;
}

const button = (label: string, className: string, press: () => void): HTMLButtonElement => {
	const element = document.createElement('button');
	element.setAttribute('type', 'button');
	element.setAttribute('class', className);
	element.append(label);
	element.addEventListener('click', press);
	return element;
};

/** The longest label a secret is given: one line on its closed block. */
export const LABEL_MAX = 80;

/** Ids for each panel's label and what is said of it, apart from every other panel's. */
const panelIds = cell(0);

/** Lines enough for the words, and one to type on: from 2 to 12. */
const rowsFor = (words: string): string =>
	String(Math.min(12, Math.max(2, words.split('\n').length + 1)));

export const createSecretPanel = ({
	words,
	label,
	onLabel,
	onInput,
	onDone,
	onCancel,
	onCopy,
}: SecretPanelOptions): SecretPanel => {
	const kept = cell(words);
	panelIds.current += 1;
	const hintId = `secret-label-hint-${String(panelIds.current)}`;

	// The label: not secret, but the browser's helpers kept out of it all the
	// same, as a password manager would take it for a login's name.
	const keptLabel = cell(label);
	const name = document.createElement('input');
	name.setAttribute('type', 'text');
	name.setAttribute('class', 'secret-label-field');
	name.setAttribute('placeholder', t('editor.secret.label'));
	name.setAttribute('maxlength', String(LABEL_MAX));
	name.setAttribute('aria-describedby', hintId);
	name.setAttribute('spellcheck', 'false');
	name.setAttribute('autocomplete', 'off');
	name.setAttribute('data-1p-ignore', '');
	name.setAttribute('data-lpignore', 'true');
	name.setAttribute('value', label);
	name.addEventListener('input', (event) => {
		if (!(event instanceof InputEvent && event.isComposing)) onLabel();
	});
	name.addEventListener('compositionend', onLabel);

	const caption = document.createElement('label');
	caption.setAttribute('class', 'secret-label-row');
	caption.append(t('editor.secret.labelField'), name);

	const hint = document.createElement('p');
	hint.setAttribute('class', 'secret-label-hint');
	hint.setAttribute('id', hintId);
	hint.append(t('editor.secret.labelHint'));

	const field = document.createElement('textarea');
	field.setAttribute('class', 'secret-words');
	field.setAttribute('aria-label', t('editor.secret.words'));
	field.setAttribute('spellcheck', 'false');
	field.setAttribute('autocomplete', 'off');
	field.setAttribute('autocorrect', 'off');
	field.setAttribute('autocapitalize', 'off');
	field.setAttribute('writingsuggestions', 'false');
	field.setAttribute('data-1p-ignore', '');
	field.setAttribute('data-lpignore', 'true');
	field.setAttribute('rows', rowsFor(words));
	field.append(words);
	field.addEventListener('input', (event) => {
		field.setAttribute('rows', rowsFor(field.value));
		if (!(event instanceof InputEvent && event.isComposing)) onInput();
	});
	field.addEventListener('compositionend', onInput);
	field.addEventListener('dragstart', (event) => {
		event.preventDefault();
	});

	const said = document.createElement('p');
	said.setAttribute('class', 'secret-said');
	said.setAttribute('role', 'status');

	const say = (message: string | undefined) => {
		said.replaceChildren(message ?? '');
	};

	const copy = button(t('editor.secret.copy'), 'secret-copy', () => {
		void onCopy(field.value).then((went) => {
			say(went ? t('editor.secret.copied') : t('editor.secret.notCopied'));
		});
	});
	const cancel = button(t('editor.secret.cancel'), 'secret-cancel', onCancel);
	cancel.setAttribute('data-dialog-close', '');
	const done = button(t('editor.secret.done'), 'secret-done', onDone);
	const answer = document.createElement('span');
	answer.setAttribute('class', 'dialog-primary');
	answer.setAttribute('data-dialog-primary', '');
	answer.append(done);

	// The row every dialog has (`DialogActions`), built as it builds it.
	const actions = document.createElement('div');
	actions.setAttribute('class', 'dialog-actions');
	actions.append(cancel, copy, answer);

	const dom = document.createElement('div');
	dom.setAttribute('class', 'secret-panel');
	dom.setAttribute('role', 'group');
	dom.setAttribute('aria-label', t('editor.secret.panel'));
	dom.append(caption, hint, field, said, actions);

	// The field's keys are its own, and the note's editor never hears them
	// (the view stops them). Escape is Cancel, as in every dialog (the owner's
	// rule, 2026-10-15), and Mod+Enter is Done.
	dom.addEventListener('keydown', (event) => {
		// Enter in the label is on to the words, as a form's next field.
		if (
			event.target === name &&
			event.key === 'Enter' &&
			!event.isComposing &&
			!event.metaKey &&
			!event.ctrlKey
		) {
			event.preventDefault();
			field.focus();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			onCancel();
			return;
		}
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			onDone();
		}
	});

	return {
		dom,
		words: () => field.value,
		changed: () => field.value !== kept.current,
		mark: (words) => {
			kept.current = words;
		},
		caret: () =>
			document.activeElement === field
				? { start: field.selectionStart, end: field.selectionEnd }
				: undefined,
		focus: (at) => {
			if (document.activeElement === field) return;
			field.focus();
			if (at !== undefined) field.setSelectionRange(at.start, at.end);
		},
		say,
		label: () => name.value,
		labelChanged: () => name.value !== keptLabel.current,
		markLabel: (next) => {
			keptLabel.current = next;
		},
		setLabel: (next) => {
			if (document.activeElement === name || next === name.value) return;
			// eslint-disable-next-line functional/immutable-data -- what is in a field is set by assigning to it
			name.value = next;
			keptLabel.current = next;
		},
	};
};
