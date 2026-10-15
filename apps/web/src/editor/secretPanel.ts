import { t } from '../i18n/t.js';

/**
 * A secret's words, revealed (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * a plain-text field of its own, outside the note's document, with Cancel,
 * Copy and Done, in that order, as every dialog's row is (`DialogActions`).
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
export interface Caret {
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
}

const button = (label: string, className: string, press: () => void): HTMLButtonElement => {
	const element = document.createElement('button');
	element.setAttribute('type', 'button');
	element.setAttribute('class', className);
	element.append(label);
	element.addEventListener('click', press);
	return element;
};

/** Lines enough for the words, and one to type on: from 2 to 12. */
const rowsFor = (words: string): string =>
	String(Math.min(12, Math.max(2, words.split('\n').length + 1)));

export const createSecretPanel = ({
	words,
	onInput,
	onDone,
	onCancel,
	onCopy,
}: SecretPanelOptions): SecretPanel => {
	const kept = { current: words };
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
	dom.append(field, said, actions);

	// The field's keys are its own, and the note's editor never hears them
	// (the view stops them). Escape is Cancel, as in every dialog (the owner's
	// rule, 2026-10-15), and Mod+Enter is Done.
	dom.addEventListener('keydown', (event) => {
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
	};
};
