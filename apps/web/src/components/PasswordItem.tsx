import {
	EMPTY_VAULT_FIELDS,
	isEmptyVaultFields,
	readVaultPayload,
	vaultArmor,
	vaultBody,
	type VaultFields,
	vaultPayload,
} from '@skysa/core';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import type { AttachmentProblem } from '../editor/attachHost.js';
import { Icon } from '../editor/icons.js';
import type { Opened, Sealer, SecretHost } from '../editor/secretHost.js';
import { t } from '../i18n/t.js';
import { db, type NoteRecord } from '../store/db.js';
import {
	deleteNote,
	type EditBase,
	getNote,
	isUnnamed,
	renameVaultItem,
	restoreVaultItem,
	saveVaultItem,
} from '../store/notes.js';
import { titleShown } from '../store/titles.js';
import { useNoteSecrets } from './noteSecrets.js';
import type { NoteDraft } from './NoteView.js';

/**
 * A password in the vault, in the note's column (docs/ARCHITECTURE.md §7,
 * "Passwords in the vault"): its label, in plain text, and what its one
 * secret holds — a username, a password and notes — opened through the host
 * the editor's secrets use (`useNoteSecrets`), so the unlock, "Add its key"
 * and the way to the Vault dialog are theirs.
 *
 * It opens as it is shown, the unlock asked for straight away where the device
 * is locked. Edited, it is kept as typed, as a secret's panel is: each change
 * is encrypted then and there and written with the label (`saveVaultItem`), so
 * nothing typed is ever only in the form. Cancel puts it back as it was
 * opened; Done renames the file after the label, once. Locking closes the form
 * and lets go of what it showed.
 */

/** What the item shows, as opening it came to. */
type Shown =
	| Readonly<{ state: 'opening' }>
	| Readonly<{
			state: 'opened';
			fields: VaultFields;
			/** The object as opened, whose other keys an edit keeps (`vaultPayload`). */
			kept: Readonly<Record<string, unknown>>;
			seal: Sealer;
	  }>
	| Readonly<{ state: 'locked' }>
	| Readonly<{ state: 'other' }>
	| Readonly<{ state: 'unreadable' }>;

/** The form, while it is open. */
interface Editing {
	readonly label: string;
	/** The body as last written: as opened, until a field changes. Empty for a new item until then. */
	readonly body: string;
	/** What Cancel puts back. */
	readonly start: Readonly<{ label: string; body: string; fields: VaultFields }>;
	/** Whether anything has been written since the form opened. */
	readonly changed: boolean;
	/** The last change could not be encrypted, and is not in the item. */
	readonly sealFailed: boolean;
}

/** A password's dots, as many whatever its length, which they do not give away. */
const MASK = '••••••••';

/** The label as the form takes it: none for an item still at its fallback name. */
const labelOf = (note: NoteRecord): string => (isUnnamed(note) ? '' : note.title);

const shownOf = (opened: Opened): Shown => {
	if (opened.state !== 'opened') return opened;
	const payload = readVaultPayload(opened.words);
	return payload === undefined
		? { state: 'unreadable' }
		: { state: 'opened', fields: payload.fields, kept: payload.kept, seal: opened.seal };
};

/** The body `fields` are sealed into, or `undefined` where they could not be. */
const sealedBody = (
	seal: Sealer,
	fields: VaultFields,
	kept: Readonly<Record<string, unknown>>
): string | undefined => {
	try {
		return vaultBody(seal(vaultPayload(fields, kept)));
	} catch {
		return undefined;
	}
};

/** Kept out of the fields: spelling, suggestions, and the password managers that would fill them. */
const KEEP_OUT = {
	spellCheck: false,
	autoComplete: 'off',
	autoCapitalize: 'off',
	autoCorrect: 'off',
	writingsuggestions: 'false',
	'data-1p-ignore': '',
	'data-lpignore': 'true',
} as const;

export interface PasswordItemProps {
	note: NoteRecord;
	/** Given while `note` is a new item, begun and not stored (`NoteDraft`). */
	draft: NoteDraft | undefined;
	onProblem: (problem: AttachmentProblem) => void;
	/** Delete it, with the route's undo. */
	onDelete: (note: NoteRecord) => void;
	/** It is no longer one to show: a new item let go. */
	onClose: () => void;
	/** The edit went into another note, a copy beside this one, which is the one to show now. */
	onOpen: (note: NoteRecord) => void;
	/** The secrets host, in place of the note's own (`useNoteSecrets`): for tests. */
	host?: SecretHost;
}

/** A field shown, with its button. */
const Field = ({
	label,
	children,
	actions,
}: {
	label: string;
	children: ReactNode;
	actions?: ReactNode;
}) => (
	<div className="password-field">
		<dt>{label}</dt>
		<dd>
			<span className="password-value">{children}</span>
			{actions}
		</dd>
	</div>
);

/** A field's button: its icon, its name in the tooltip. */
const FieldButton = ({
	icon,
	label,
	onClick,
}: {
	icon: 'copy' | 'eye' | 'eye-off';
	label: string;
	onClick: () => void;
}) => (
	<button type="button" className="icon" title={label} aria-label={label} onClick={onClick}>
		<Icon name={icon} />
	</button>
);

export const PasswordItem = ({
	note,
	draft,
	onProblem,
	onDelete,
	onClose,
	onOpen,
	host: givenHost,
}: PasswordItemProps) => {
	const secrets = useNoteSecrets(note, { report: onProblem });
	const host = givenHost ?? secrets.host;
	/** A new item, until Done keeps it. */
	const [fresh, setFresh] = useState(draft !== undefined);
	/** Opening again where it was cancelled: the Unlock button, and a key added. */
	const [attempt, setAttempt] = useState(0);
	/** What opening came to, for which armor, at which attempt. */
	const [shown, setShown] = useState<
		Readonly<{ armor: string | undefined; attempt: number; is: Shown }>
	>({ armor: undefined, attempt: 0, is: { state: 'opening' } });
	/**
	 * Every armor this view opened or wrote: the item it shows already, which
	 * is not opened again as the store catches up with what was typed.
	 */
	const [own, setOwn] = useState<ReadonlySet<string>>(new Set());
	const [editing, setEditing] = useState<Editing | null>(null);
	const [revealed, setRevealed] = useState(false);
	const [said, setSaid] = useState<string | undefined>();
	/** A new item the store could not take: the form stays open on it (`write`). */
	const [unstored, setUnstored] = useState(false);
	const ids = {
		label: useId(),
		hint: useId(),
		username: useId(),
		password: useId(),
		notes: useId(),
	};

	/** What the edits are written over (`EditBase`), moved on as each is written. */
	const base = useRef<EditBase>({ origin: note.bodyOrigin ?? '', note });
	/** The new item, until the store has it: from its first change, or the one after where that failed. */
	const toStore = useRef<NoteDraft | undefined>(draft);
	/** Writes, one after another, in the order they were typed. */
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	/** Let go of, a new item cancelled: what is still queued for it is not written. */
	const gone = useRef(false);
	/** How many times the device has locked, so a form is not opened across one. */
	const locks = useRef(0);
	/** `shown` as last drawn, for what reads it once the writes before it are made. */
	const showing = useRef(shown);
	const latest = useRef({ onProblem, onClose, onOpen });
	useEffect(() => {
		latest.current = { onProblem, onClose, onOpen };
		showing.current = shown;
	});
	const labelField = useRef<HTMLInputElement>(null);
	const editButton = useRef<HTMLButtonElement>(null);

	const notSaved = () => {
		latest.current.onProblem({ message: t('passwords.item.notSaved'), tone: 'error' });
	};

	const write = (typed: { title: string; body: string }) => {
		queue.current = queue.current
			.then(async () => {
				if (gone.current) return;
				const storing = toStore.current;
				if (storing !== undefined) {
					// Let go of only once it is stored. Where it could not be, the
					// route says why (`onStoreFailed`), and the form stays open on
					// what was typed, which is nowhere else, until the next change
					// or Done tries again (`finish`).
					if (!(await storing.store())) {
						setUnstored(true);
						return;
					}
					toStore.current = undefined;
					setUnstored(false);
				}
				const saved = await saveVaultItem(db, typed, base.current);
				base.current = { origin: saved.bodyOrigin ?? '', note: saved };
			})
			.catch(notSaved);
	};

	/** Let a new item go, stored or not, without an undo: nothing in it was kept. */
	const discard = () => {
		gone.current = true;
		queue.current = queue.current
			.then(() =>
				// Stored by a change before: taken away again.
				toStore.current === undefined
					? deleteNote(db, base.current.note.id, {
							connectionId: base.current.note.connectionId,
						})
					: undefined
			)
			.catch(() => undefined)
			.then(() => {
				latest.current.onClose();
			});
	};

	/**
	 * Name the item's file after its label, where that changed: once, as the
	 * form closes, rather than at every character. Only while the item is the
	 * one the edit was made over, so a label pulled from another device since
	 * is not written over (`renameVaultItem`).
	 */
	const rename = (ending: Editing) => {
		const label = ending.label.trim();
		if (label === '' || label === ending.start.label) return;
		queue.current = queue.current
			.then(async () => {
				if (gone.current || toStore.current !== undefined) return;
				const renamed = await renameVaultItem(db, label, base.current);
				if (renamed !== undefined) {
					base.current = { origin: renamed.bodyOrigin ?? '', note: renamed };
				}
			})
			.catch(notSaved);
	};

	/** Close the form on what is in the item. */
	const close = (ending: Editing) => {
		setEditing(null);
		setRevealed(false);
		setFresh(false);
		rename(ending);
		queue.current = queue.current.then(() => {
			// A copy beside the item holds the edit, the item having been
			// replaced meanwhile: it is the one to show.
			if (base.current.note.id !== note.id) latest.current.onOpen(base.current.note);
		});
	};

	/**
	 * Done: close the form, keeping what is in the item, or let a new one go
	 * that has nothing in it. A new one the store has not taken, or not yet,
	 * stays open until it has, since what is typed in it is in no other place;
	 * one it could not take is tried again.
	 */
	const finish = (ending: Editing, fields: VaultFields) => {
		if (fresh && ending.label.trim() === '' && isEmptyVaultFields(fields)) {
			setEditing(null);
			setRevealed(false);
			discard();
			return;
		}
		if (toStore.current === undefined) {
			close(ending);
			return;
		}
		if (unstored && ending.body !== '') write({ title: ending.label, body: ending.body });
		queue.current = queue.current.then(() => {
			if (toStore.current === undefined) finishing.current();
		});
	};
	const finishing = useRef<() => void>(() => undefined);
	/** Left with the form open: named as Done would have. What was typed is in the item already. */
	const leaving = useRef<() => void>(() => undefined);
	useEffect(() => {
		finishing.current = () => {
			if (editing !== null && shown.is.state === 'opened') finish(editing, shown.is.fields);
		};
		leaving.current = () => {
			if (editing !== null) rename(editing);
		};
	});
	// Back, another item, or the passwords hidden, with the form open.
	useEffect(
		() => () => {
			// The latest, as it is left: the form as it was then.
			leaving.current();
		},
		[]
	);

	// A new item: sealed to the source's key, which needs the device enrolled
	// and not unlocked. Where it cannot be made, the host has said why.
	useEffect(() => {
		if (!fresh) return undefined;
		const live = { current: true };
		void host.begin().then((seal) => {
			if (!live.current) return;
			if (seal === undefined) {
				latest.current.onClose();
				return;
			}
			setShown({
				armor: undefined,
				attempt: 0,
				is: { state: 'opened', fields: EMPTY_VAULT_FIELDS, kept: {}, seal },
			});
			setEditing({
				label: '',
				body: '',
				start: { label: '', body: '', fields: EMPTY_VAULT_FIELDS },
				changed: false,
				sealFailed: false,
			});
		});
		return () => {
			live.current = false;
		};
		// Once, as it is begun: a new item stays one until Done.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Opened as it is shown, and again where another device changed it. Not
	// while the form is open, whose edits a change from elsewhere is written
	// beside (`saveVaultItem`); not for what this view opened or wrote; and
	// not while it is locked, until Unlock is pressed, so a change arriving
	// from elsewhere does not ask for the unlock by itself.
	// A new item stored and not read back yet is still the draft here, with no
	// body: what it holds is what was written.
	const armor = vaultArmor(note.body) ?? (draft === undefined ? undefined : shown.armor);
	const inForm = editing !== null;
	const known =
		armor !== undefined &&
		(own.has(armor) || shown.armor === armor || shown.is.state === 'locked');
	const settled = known && shown.attempt === attempt;
	useEffect(() => {
		if (fresh || inForm || armor === undefined || settled) return undefined;
		const live = { current: true };
		void host.open(armor).then((opened) => {
			if (!live.current) return;
			const is = shownOf(opened);
			if (is.state === 'opened') setOwn((before) => new Set([...before, armor]));
			setShown({ armor, attempt, is });
		});
		return () => {
			live.current = false;
		};
	}, [fresh, inForm, armor, settled, attempt, host]);

	/** What the item shows now: as opened, or opening, or a body it cannot read. */
	const view: Shown =
		fresh || inForm
			? shown.is
			: armor === undefined
				? { state: 'unreadable' }
				: known
					? shown.is
					: { state: 'opening' };

	// Locked: the form closes, with everything typed already in the item, and
	// what was shown is let go of.
	// A new item is locked once the store has what was typed, and where it
	// cannot take it, stays open on it, as it is in no other place.
	useEffect(
		() =>
			host.locked(() => {
				locks.current += 1;
				const lock = () => {
					finishing.current();
					setShown((before) => ({ ...before, is: { state: 'locked' } }));
					setRevealed(false);
				};
				if (toStore.current === undefined) {
					lock();
					return;
				}
				queue.current = queue.current.then(() => {
					if (toStore.current === undefined) lock();
				});
			}),
		[host]
	);

	// Into the form at its first field, and back to Edit as it closes.
	const wasInForm = useRef(false);
	useEffect(() => {
		if (inForm === wasInForm.current) return;
		wasInForm.current = inForm;
		(inForm ? labelField.current : editButton.current)?.focus();
	}, [inForm]);

	// "Copied." for a moment, then nothing.
	useEffect(() => {
		if (said === undefined) return undefined;
		const timer = setTimeout(() => {
			setSaid(undefined);
		}, 3000);
		return () => {
			clearTimeout(timer);
		};
	}, [said]);

	const copy = (text: string) => {
		void host.copy(text).then((copied) => {
			setSaid(copied ? t('passwords.item.copied') : t('passwords.item.notCopied'));
		});
	};

	/**
	 * Open the form on the item as the store has it, once the writes before are
	 * made: `note` can be a write or two behind them, and a form opened on it
	 * would write the old password back with the next change to the label.
	 */
	const edit = () => {
		if (view.state !== 'opened') return;
		const lock = locks.current;
		queue.current = queue.current
			.then(async () => {
				const stored = await getNote(db, note.id, { connectionId: note.connectionId });
				const at = showing.current;
				// Locked meanwhile, or changed from elsewhere and not yet opened
				// again: what the view shows is not what the item holds.
				if (
					stored === undefined ||
					stored.deletedLocally === 1 ||
					locks.current !== lock ||
					at.is.state !== 'opened' ||
					vaultArmor(stored.body) !== at.armor
				) {
					return;
				}
				const label = labelOf(stored);
				base.current = { origin: stored.bodyOrigin ?? '', note: stored };
				setEditing({
					label,
					body: stored.body,
					start: { label, body: stored.body, fields: at.is.fields },
					changed: false,
					sealFailed: false,
				});
			})
			.catch(() => undefined);
	};

	const change = (next: { label?: string; fields?: VaultFields }) => {
		const opened = shown.is;
		if (editing === null || opened.state !== 'opened') return;
		const label = next.label ?? editing.label;
		const fields = next.fields ?? opened.fields;
		// The item keeps its armor byte for byte until a field changes; a new
		// one is sealed at its first change, whatever it is.
		const body =
			next.fields !== undefined || editing.body === ''
				? sealedBody(opened.seal, fields, opened.kept)
				: editing.body;
		if (body === undefined) {
			setShown({ ...shown, is: { ...opened, fields } });
			setEditing({ ...editing, label, sealFailed: true });
			return;
		}
		const written = vaultArmor(body);
		setShown({ armor: written, attempt, is: { ...opened, fields } });
		if (written !== undefined) setOwn((before) => new Set([...before, written]));
		setEditing({ ...editing, label, body, changed: true, sealFailed: false });
		write({ title: label, body });
	};

	const cancel = () => {
		const opened = shown.is;
		if (editing === null || opened.state !== 'opened') return;
		setRevealed(false);
		if (fresh) {
			setEditing(null);
			discard();
			return;
		}
		const { start } = editing;
		setEditing(null);
		setShown({
			armor: vaultArmor(start.body),
			attempt,
			is: { ...opened, fields: start.fields },
		});
		if (editing.changed) restore(start);
	};

	/**
	 * Put the item back as the form opened on it, where it still is that item
	 * (`restoreVaultItem`). Where a pull replaced it while the form was open,
	 * the edit went into a copy beside it, which held nothing else and goes.
	 */
	const restore = (start: Editing['start']) => {
		queue.current = queue.current
			.then(async () => {
				const at = base.current.note;
				if (at.id !== note.id) {
					await deleteNote(db, at.id, { connectionId: at.connectionId });
					base.current = { origin: note.bodyOrigin ?? '', note };
					return;
				}
				const put = await restoreVaultItem(
					db,
					{ title: start.label, body: start.body },
					base.current
				);
				if (put !== undefined) base.current = { origin: put.bodyOrigin ?? '', note: put };
			})
			.catch(notSaved);
	};

	const heading =
		editing !== null
			? editing.label.trim() === ''
				? t('passwords.item.new')
				: editing.label.trim()
			: titleShown(note.title);

	const body = (() => {
		if (view.state === 'opening') {
			return (
				<p className="muted placeholder" role="status">
					{t('passwords.item.opening')}
				</p>
			);
		}
		if (view.state === 'locked') {
			return (
				<div className="password-said">
					<p>{t('passwords.item.locked')}</p>
					<button
						type="button"
						onClick={() => {
							setAttempt((count) => count + 1);
						}}
					>
						{t('passwords.item.unlock')}
					</button>
				</div>
			);
		}
		if (view.state === 'other') {
			return (
				<div className="password-said">
					<p>{t('passwords.item.differentKey')}</p>
					<button
						type="button"
						onClick={() => {
							if (armor === undefined) return;
							void host.addKey(armor).then((added) => {
								if (added) setAttempt((count) => count + 1);
							});
						}}
					>
						{t('passwords.item.addKey')}
					</button>
				</div>
			);
		}
		if (view.state === 'unreadable') {
			return (
				<div className="password-said">
					<p>{t('passwords.item.unreadable')}</p>
				</div>
			);
		}
		const { fields } = view;
		if (editing !== null) {
			const field = (key: keyof VaultFields) => (value: string) => {
				change({ fields: { ...fields, [key]: value } });
			};
			return (
				<form
					className="password-form"
					aria-label={t('passwords.item.editing', { label: heading })}
					onSubmit={(event) => {
						event.preventDefault();
						finish(editing, fields);
					}}
				>
					<label htmlFor={ids.label}>{t('passwords.item.label')}</label>
					<input
						ref={labelField}
						id={ids.label}
						type="text"
						value={editing.label}
						aria-describedby={ids.hint}
						{...KEEP_OUT}
						onChange={(event) => {
							change({ label: event.target.value });
						}}
					/>
					<p id={ids.hint} className="password-hint">
						{t('passwords.item.labelHint')}
					</p>
					<label htmlFor={ids.username}>{t('passwords.item.username')}</label>
					<input
						id={ids.username}
						type="text"
						value={fields.username}
						{...KEEP_OUT}
						onChange={(event) => {
							field('username')(event.target.value);
						}}
					/>
					<label htmlFor={ids.password}>{t('passwords.item.password')}</label>
					<div className="password-entry">
						{/* Text drawn as dots, not a password field: a browser offers to
						    save what is typed into one, and this is kept here alone. */}
						<input
							id={ids.password}
							type="text"
							className={revealed ? undefined : 'password-masked'}
							value={fields.password}
							{...KEEP_OUT}
							onChange={(event) => {
								field('password')(event.target.value);
							}}
						/>
						<FieldButton
							icon={revealed ? 'eye-off' : 'eye'}
							label={revealed ? t('passwords.item.hide') : t('passwords.item.show')}
							onClick={() => {
								setRevealed((now) => !now);
							}}
						/>
					</div>
					<label htmlFor={ids.notes}>{t('passwords.item.notes')}</label>
					<textarea
						id={ids.notes}
						rows={4}
						value={fields.notes}
						{...KEEP_OUT}
						onChange={(event) => {
							field('notes')(event.target.value);
						}}
					/>
					{editing.sealFailed && (
						<p className="password-hint" role="alert">
							{t('passwords.item.notSealed')}
						</p>
					)}
					{unstored && (
						<p className="password-hint" role="alert">
							{t('passwords.item.notStored')}
						</p>
					)}
					<div className="password-actions">
						<button type="button" onClick={cancel}>
							{t('passwords.item.cancel')}
						</button>
						<button type="submit" className="primary">
							{t('passwords.item.done')}
						</button>
					</div>
				</form>
			);
		}
		const blank = <span className="muted">{t('passwords.item.blank')}</span>;
		return (
			<>
				<dl className="password-fields">
					<Field
						label={t('passwords.item.username')}
						actions={
							fields.username === '' ? undefined : (
								<FieldButton
									icon="copy"
									label={t('passwords.item.copyUsername')}
									onClick={() => {
										copy(fields.username);
									}}
								/>
							)
						}
					>
						{fields.username === '' ? blank : fields.username}
					</Field>
					<Field
						label={t('passwords.item.password')}
						actions={
							fields.password === '' ? undefined : (
								<>
									<FieldButton
										icon={revealed ? 'eye-off' : 'eye'}
										label={
											revealed
												? t('passwords.item.hide')
												: t('passwords.item.show')
										}
										onClick={() => {
											setRevealed((now) => !now);
										}}
									/>
									<FieldButton
										icon="copy"
										label={t('passwords.item.copyPassword')}
										onClick={() => {
											copy(fields.password);
										}}
									/>
								</>
							)
						}
					>
						{fields.password === '' ? (
							blank
						) : revealed ? (
							<code className="password-shown">{fields.password}</code>
						) : (
							<span role="img" aria-label={t('passwords.item.hidden')}>
								{MASK}
							</span>
						)}
					</Field>
					<Field label={t('passwords.item.notes')}>
						{fields.notes === '' ? (
							blank
						) : (
							<span className="password-notes">{fields.notes}</span>
						)}
					</Field>
				</dl>
				<p className="password-said" role="status">
					{said}
				</p>
			</>
		);
	})();

	// Deleted from what it shows, whatever it holds, but not while it is
	// opening or locked, when what it is has not been seen.
	const deletable = editing === null && view.state !== 'opening' && view.state !== 'locked';

	return (
		<section className="note-view password-item" aria-label={heading}>
			<div className="note-header">
				<h2 className="password-label">
					<Icon name="key" />
					<span>{heading}</span>
				</h2>
				{deletable && (
					<div className="password-header-actions">
						{view.state === 'opened' && (
							<button ref={editButton} type="button" onClick={edit}>
								{t('passwords.item.edit')}
							</button>
						)}
						<button
							type="button"
							className="danger"
							onClick={() => {
								onDelete(note);
							}}
						>
							{t('passwords.item.delete')}
						</button>
					</div>
				)}
			</div>
			<div className="password-body">{body}</div>
			{secrets.dialog}
		</section>
	);
};
