import { t } from '../i18n/t.js';
import type { Sealer, SecretHost } from './secretHost.js';
import { createSecretPanel, LABEL_MAX, type SecretPanel } from './secretPanel.js';

/**
 * The panels a note's editor has open, and what Done, Cancel, leaving, the
 * lock and a pull do with them (docs/ARCHITECTURE.md §7, "Secrets in a
 * note"). The same in both editors, which differ only in how a secret is in
 * their document (`SecretDocument`): an atom in rich mode (`secretBlock.ts`),
 * a fence's lines in raw mode (`secretRaw.ts`).
 *
 * **The words never enter the document.** Revealed, they are in a panel
 * (`secretPanel.ts`) held here, by the armor of the block it shows. What is
 * typed is kept as it is typed: sealed again, then and there, and put in the
 * block's place — a user edit, so the note is dirty then and only then, and
 * saved as anything typed in it is. Nothing typed is ever in a panel and not
 * in the note, so the editor closing, the tab locking and a pull have no
 * words to lose. Done closes the panel; Cancel puts the block back as it was
 * revealed. A new secret ("Insert secret") is a panel where it will go, and
 * nothing typed in it inserts nothing.
 *
 * A secret's label is not sealed: it is plain text on its fence, and kept as
 * it is typed by changing only that. A new secret's waits for its first
 * words, which put its block in the note.
 */

/** The key a new secret's panel is held under, which no armor can be. */
export const DRAFT = '';

/**
 * A panel open. `from` is the armor its block had when it was revealed, and
 * `fromLabel` its label, which Cancel puts back; none for a new secret, whose
 * Cancel takes out the block its words were kept in, if any were. `seal` is
 * how its words are kept.
 */
export interface Open {
	readonly panel: SecretPanel;
	readonly from: string | undefined;
	readonly fromLabel: string;
	readonly seal: Sealer;
}

/**
 * What a label typed is written as, on the line that opens the fence: one line,
 * with no backtick, which would end a fence's info string, and no longer than
 * the field allows.
 */
export const labelToWrite = (typed: string): string =>
	typed.replace(/\s+/gu, ' ').replaceAll('`', '').trim().slice(0, LABEL_MAX).trim();

/**
 * The panels open in one editor, by the armor of the block each shows — or
 * `DRAFT`, for a new secret's until its words are first kept. Apart from
 * whatever draws them, which the editor may draw again: drawn again, a block
 * shows the panel it had.
 */
export interface SecretPanels {
	readonly get: (key: string) => Open | undefined;
	readonly set: (key: string, open: Open) => void;
	/** Where `panel` is held, and what with. */
	readonly find: (panel: SecretPanel) => readonly [string, Open] | undefined;
	/**
	 * `panel` held under another key: its block's armor changed, by its own
	 * words. Said to no one: the block is changed next, and is drawn again
	 * with it, still showing it.
	 */
	readonly rekey: (panel: SecretPanel, key: string) => void;
	readonly remove: (panel: SecretPanel) => void;
	/** Every panel open, by its key, and none after. */
	readonly takeAll: () => readonly (readonly [string, Open])[];
	readonly all: () => readonly (readonly [string, Open])[];
	/** Whatever draws them asked to again: where the blocks are has changed. */
	readonly refresh: () => void;
	readonly subscribe: (listener: () => void) => () => void;
}

export const createSecretPanels = (): SecretPanels => {
	const open = new Map<string, Open>();
	const listeners = new Set<() => void>();
	const changed = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};
	const find = (panel: SecretPanel) =>
		[...open.entries()].find(([, each]) => each.panel === panel);
	return {
		get: (key) => open.get(key),
		set: (key, held) => {
			open.set(key, held);
			changed();
		},
		find,
		rekey: (panel, key) => {
			const found = find(panel);
			if (found === undefined) return;
			open.delete(found[0]);
			open.set(key, found[1]);
		},
		remove: (panel) => {
			const found = find(panel);
			if (found === undefined) return;
			open.delete(found[0]);
			changed();
		},
		takeAll: () => {
			const all = [...open.entries()];
			open.clear();
			if (all.length > 0) changed();
			return all;
		},
		all: () => [...open.entries()],
		refresh: changed,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};

/** What the panels need of one editor's document. Every change it makes is the user's edit. */
export interface SecretDocument {
	/** Whether the editor has gone. */
	readonly closed: () => boolean;
	/** Whether a block with the armor `key` is in the document. */
	readonly has: (key: string) => boolean;
	/**
	 * `armor` in place of the block with the armor `key`, its label as it is;
	 * or — a new secret's first words — as a block of its own called `label`
	 * where `at` says, which `draftAt` gave, or at the end of the note.
	 */
	readonly put: (key: string, armor: string, at: number | undefined, label: string) => void;
	/**
	 * The block with the armor `key` changed back to `from` and `label`, or,
	 * with no `from`, taken out.
	 */
	readonly putBack: (key: string, from: string | undefined, label: string) => void;
	/** The label of the block with the armor `key`, as its fence says it; none where it has none. */
	readonly label: (key: string) => string;
	/** The block with the armor `key` called `label`, its armor as it is. */
	readonly relabel: (key: string, label: string) => void;
	/** Where a new secret's panel is, if one is begun. */
	readonly draftAt: () => number | undefined;
	/** A new secret begun at the cursor. */
	readonly beginDraft: () => void;
	/** The new secret's place let go of. */
	readonly endDraft: () => void;
	readonly focus: () => void;
}

/** The panels whose words could not be sealed the last time they were typed in. */
const unsaved = new WeakSet<SecretPanel>();

/**
 * What is in `panel` kept, where it is new: sealed, and put in its block as
 * the user's edit, then and there.
 */
const keep = (doc: SecretDocument, panels: SecretPanels, panel: SecretPanel): void => {
	const found = panels.find(panel);
	if (found === undefined || !panel.changed() || doc.closed()) return;
	const [key, { seal }] = found;
	const words = panel.words();
	const armor = (() => {
		try {
			return seal(words);
		} catch {
			return undefined;
		}
	})();
	if (armor === undefined) {
		unsaved.add(panel);
		panel.say(t('editor.secret.notSealed'));
		return;
	}
	if (unsaved.delete(panel)) panel.say(undefined);
	// A new secret's panel moves to its block as that is drawn, which takes
	// the focus from it.
	const caret = panel.caret();
	panel.mark(words);
	// Held under the new armor first: the block changes under the panel as it
	// is put in, and what draws it looks for it by that.
	panels.rekey(panel, armor);
	const label = panel.label();
	doc.put(key, armor, doc.draftAt(), labelToWrite(label));
	if (key === DRAFT) panel.markLabel(label);
	if (caret !== undefined) {
		queueMicrotask(() => {
			panel.focus(caret);
		});
	}
};

/**
 * What is in `panel`'s label kept, where it is new: the block's fence changed
 * to say it, as the user's edit, with nothing sealed. A new secret's waits for
 * its words (`keep`).
 */
const keepLabel = (doc: SecretDocument, panels: SecretPanels, panel: SecretPanel): void => {
	const found = panels.find(panel);
	if (found === undefined || !panel.labelChanged() || doc.closed()) return;
	const [key] = found;
	if (key === DRAFT) return;
	const typed = panel.label();
	panel.markLabel(typed);
	const label = labelToWrite(typed);
	if (labelToWrite(doc.label(key)) !== label) doc.relabel(key, label);
};

/**
 * Done: the panel closed, its words in the note already. A new secret
 * emptied before it is none, as one never typed in is. Where the last words
 * could not be sealed, the panel stays open: closed, they would be lost.
 */
const done = (doc: SecretDocument, panels: SecretPanels, panel: SecretPanel): void => {
	keep(doc, panels, panel);
	keepLabel(doc, panels, panel);
	const found = panels.find(panel);
	if (found === undefined || panel.changed()) return;
	const [key, { from }] = found;
	panels.remove(panel);
	if (key === DRAFT && doc.draftAt() !== undefined) doc.endDraft();
	if (key !== DRAFT && from === undefined && panel.words() === '')
		doc.putBack(key, undefined, '');
	doc.focus();
};

/** Cancel: the panel closed, and its block put back as it was revealed. */
const cancel = (doc: SecretDocument, panels: SecretPanels, panel: SecretPanel): void => {
	const found = panels.find(panel);
	panels.remove(panel);
	if (found === undefined) return;
	const [key, { from, fromLabel }] = found;
	if (key === DRAFT && doc.draftAt() !== undefined) doc.endDraft();
	// Typed in since it was revealed, its words or its label.
	if (key !== DRAFT && (key !== from || doc.label(key) !== fromLabel))
		doc.putBack(key, from, fromLabel);
	doc.focus();
};

/** A panel showing `words`, kept, closed and put back through `doc`. */
const panelFor = (
	doc: SecretDocument,
	host: SecretHost,
	panels: SecretPanels,
	words: string,
	label: string
): SecretPanel => {
	const panel: SecretPanel = createSecretPanel({
		words,
		label,
		onInput: () => {
			keep(doc, panels, panel);
		},
		onLabel: () => {
			keepLabel(doc, panels, panel);
		},
		onDone: () => {
			done(doc, panels, panel);
		},
		onCancel: () => {
			cancel(doc, panels, panel);
		},
		onCopy: host.copy,
	});
	return panel;
};

/**
 * The secret with `armor` revealed: its words opened, unlocking the device
 * where it is locked, and shown in a panel; one already shown, focused. Why
 * it could not be, where that is to be said on the block: the user who did
 * not unlock knows why.
 */
export const reveal = async (
	doc: SecretDocument,
	host: SecretHost,
	panels: SecretPanels,
	armor: string
): Promise<NotRevealed | undefined> => {
	const shown = panels.get(armor);
	if (shown !== undefined) {
		shown.panel.focus();
		return undefined;
	}
	const opened = await host.open(armor);
	if (opened.state === 'locked') return undefined;
	if (opened.state !== 'opened') return opened.state;
	// Revealed meanwhile, by a second press: one panel. Or gone meanwhile, as
	// a pull changed it under the unlock: a panel for no block would hold the
	// words, undrawn, until the next edit closed it.
	if (panels.get(armor) !== undefined || doc.closed() || !doc.has(armor)) return undefined;
	const fromLabel = doc.label(armor);
	const panel = panelFor(doc, host, panels, opened.words, fromLabel.trim());
	panels.set(armor, { panel, from: armor, fromLabel, seal: opened.seal });
	panel.focus();
	return undefined;
};

/** Why a secret could not be revealed: made with another key, or not one this app reads. */
export type NotRevealed = 'other' | 'unreadable';

/** Why a secret could not be revealed, said where it is. */
export const NOT_REVEALED: Readonly<Record<NotRevealed, () => string>> = {
	other: () => t('editor.secret.differentKey'),
	unreadable: () => t('editor.secret.unreadable'),
};

/**
 * "Add its key", for a secret made with a key the device does not have:
 * pressed, the host asks for that key, and `added` runs once it is kept.
 */
export const addKeyButton = (
	host: SecretHost,
	armor: string,
	added: () => void
): HTMLButtonElement => {
	const button = document.createElement('button');
	button.setAttribute('type', 'button');
	button.setAttribute('class', 'secret-add-key');
	button.append(t('editor.secret.addKey'));
	button.addEventListener('click', () => {
		button.setAttribute('disabled', '');
		void host
			.addKey(armor)
			.catch(() => false)
			.then((kept) => {
				button.removeAttribute('disabled');
				if (kept) added();
			});
	});
	return button;
};

/**
 * Begin a new secret at the cursor: a panel where it will go, empty. Only
 * where one can be sealed: the host says why not, where not.
 */
export const insertSecret = async (
	doc: SecretDocument,
	host: SecretHost,
	panels: SecretPanels
): Promise<void> => {
	const begun = () => {
		const open = panels.get(DRAFT);
		open?.panel.focus();
		return open !== undefined;
	};
	if (begun()) return;
	const seal = await host.begin();
	if (seal === undefined || doc.closed() || begun()) return;
	const panel = panelFor(doc, host, panels, '', '');
	panels.set(DRAFT, { panel, from: undefined, fromLabel: '', seal });
	doc.beginDraft();
	panel.focus();
};

/**
 * What is in every panel kept: all of it is in the note already, but for a
 * character an input method is still composing.
 */
export const keepAll = (doc: SecretDocument, panels: SecretPanels): void => {
	panels.all().forEach(([, { panel }]) => {
		keep(doc, panels, panel);
		keepLabel(doc, panels, panel);
	});
};

/**
 * Every panel closed as the tab locks, at once: what the lock is for is that
 * the words are not on screen. What is typed in them is kept first.
 */
export const lockAll = (doc: SecretDocument, panels: SecretPanels): void => {
	keepAll(doc, panels);
	const draft = doc.draftAt();
	panels.takeAll();
	if (draft !== undefined) doc.endDraft();
};

/**
 * Panels whose block is no longer in the document, closed, however it went:
 * deleted by the user, or changed or removed by a pull. Its words went into
 * the note as they were typed, so they are where anything typed in the note
 * would be: in the undo history, or saved, and a pull over an edit not yet
 * synced keeps it as a conflicted copy.
 */
export const leftBehind = (doc: SecretDocument, panels: SecretPanels): void => {
	panels.all().forEach(([key, { panel }]) => {
		if (key !== DRAFT && !doc.has(key)) panels.remove(panel);
	});
};
