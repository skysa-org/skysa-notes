import { t } from '../i18n/t.js';

/**
 * A secret's words, revealed (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * a plain-text field of its own, outside the note's document, with Done,
 * Copy and Cancel. The same panel under a revealed block and where a new
 * secret is being written, in either editor. What is typed in it is kept as
 * the focus leaves it, as what is typed in the note is.
 *
 * Built by hand, as the code block's bar is (`codeBlock.ts`): what holds it
 * is a node view or a widget, not React. The field keeps the browser's
 * helpers out of the words: spell check, which in Chrome's enhanced mode
 * sends text to Google, and autocomplete, autocorrect, capitalising and
 * writing suggestions.
 */

export interface SecretPanelOptions {
	/** The words it opens with: a revealed secret's, or none for a new one. */
	readonly words: string;
	/** Done, or Escape: what is in the field is to be kept, and the panel closed. */
	readonly onDone: () => void;
	/** The focus left the panel: what is in the field is to be kept, and the panel left open. */
	readonly onLeave: () => void;
	/** Cancel: the secret is put back as it was revealed. */
	readonly onCancel: () => void;
	/** Copy: the words to the system clipboard, answering whether they went. */
	readonly onCopy: (words: string) => Promise<boolean>;
}

export interface SecretPanel {
	readonly dom: HTMLElement;
	/** What is in the field now. */
	readonly words: () => string;
	/** Whether that is not what was last kept, or what it opened with. */
	readonly changed: () => boolean;
	/** `words` kept: what is in the field is new only where it is not them. */
	readonly mark: (words: string) => void;
	readonly focus: () => void;
	/** Something said under the field, or nothing. */
	readonly say: (message: string | undefined) => void;
	/** While Done is sealing the words: nothing in it can be pressed or typed. */
	readonly busy: (on: boolean) => void;
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
	onDone,
	onLeave,
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
	field.addEventListener('input', () => {
		field.setAttribute('rows', rowsFor(field.value));
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
	const done = button(t('editor.secret.done'), 'secret-done', onDone);

	const actions = document.createElement('div');
	actions.setAttribute('class', 'secret-actions');
	actions.append(copy, cancel, done);

	const dom = document.createElement('div');
	dom.setAttribute('class', 'secret-panel');
	dom.setAttribute('role', 'group');
	dom.setAttribute('aria-label', t('editor.secret.panel'));
	dom.append(field, said, actions);

	// The field's keys are its own, and the note's editor never hears them
	// (the view stops them). Escape keeps what was typed, as Done does: a key
	// pressed to get out of a field is not a request to lose what is in it.
	dom.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
			event.preventDefault();
			onDone();
		}
	});
	// Out of the panel, not between its own controls: the Copy button is still
	// the panel, and a press on Cancel is not a reason to keep anything.
	dom.addEventListener('focusout', (event) => {
		if (event.relatedTarget instanceof Node && dom.contains(event.relatedTarget)) return;
		onLeave();
	});

	return {
		dom,
		words: () => field.value,
		changed: () => field.value !== kept.current,
		mark: (words) => {
			kept.current = words;
		},
		focus: () => {
			field.focus();
		},
		say,
		busy: (on) => {
			[field, copy, cancel, done].forEach((control) => {
				control.toggleAttribute('disabled', on);
			});
			dom.toggleAttribute('aria-busy', on);
		},
	};
};
