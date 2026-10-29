import { AgeError, cell } from '@skysa/core';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AttachmentProblem } from '../../editor/attachHost.js';
import type { Opened, Sealer, SecretHost } from '../../editor/secretHost.js';
import { t } from '../../i18n/t.js';
import { type Age, loadAge } from '../../secrets/loadAge.js';
import type { SecretsLock } from '../../secrets/lock.js';
import { notEnrolled, notHere, type Why } from '../../secrets/sealHere.js';
import { tabLock } from '../../secrets/tabLock.js';
import { connectedSources } from '../../store/connection.js';
import {
	db as appDb,
	type NoteRecord,
	type NotesDatabase,
	type UnlockKind,
} from '../../store/db.js';
import { enrolment, type UnlockedKeys } from '../../store/secretKeys.js';
import { tabName, UNKNOWN_LABEL } from '../../sync/account.js';
import type { KeyFileSync } from '../../sync/keyFile.js';
import { syncScheduler } from '../../sync/runtime.js';
import { copyText } from '../clipboard/systemClipboard.js';
import { AddKeyDialog } from './AddKeyDialog.js';
import { SecretsDialog } from './SecretsDialog.js';
import { UnlockDialog } from './UnlockDialog.js';

/**
 * The secrets in one open note, for its editor (docs/ARCHITECTURE.md §7,
 * "Secrets in a note"): `SecretHost`, answered from the note's source, this
 * device's keys for it, the source's key file as last read, and this tab's
 * lock.
 *
 * Opening a secret on a locked device asks for its unlock over the note
 * (`UnlockDialog`), once however many secrets ask at the same time. The
 * identities are copied for each opening and the copies wiped after it, so
 * the lock wiping its own meanwhile cannot make a secret look made with
 * another key; and a secret opened as the lock closed is not shown. A
 * secret none of the device's keys opens can have its key added here, over
 * the note (`AddKeyDialog`). Setting a source up, and enrolling a device, are
 * the source's Vault dialog's: where either is wanted, the host says so with
 * a button that opens it over the note (`SecretsDialog`), rather than sending
 * the user to the source's menu for it (2026-10-15, the owner's ask). So does
 * Use the recovery key, in the unlock asked for here, without the detour.
 */

export interface NoteSecretsOptions {
	/** Where a problem the editor has nowhere to show goes: a toast. */
	report?: (problem: AttachmentProblem) => void;
	db?: NotesDatabase;
	lock?: SecretsLock;
	age?: () => Promise<Age>;
	/** Words to the system clipboard. */
	copy?: (text: string) => Promise<void>;
	/** The source's key file, read again and written, for its Vault dialog. */
	keyFile?: Pick<KeyFileSync, 'refresh' | 'write'>;
}

export interface NoteSecrets {
	readonly host: SecretHost;
	/** The unlock asked for over the note, while it is. */
	readonly dialog: ReactNode;
	/** The palette's "Insert secret": a new secret in the editor open now, if it offers one. */
	readonly insert: () => void;
}

/** An unlock asked for, and whoever is waiting on it. */
interface Asking {
	readonly connectionId: string;
	readonly kind: UnlockKind;
	readonly answer: (unlocked: boolean) => void;
}

/** A secret's key asked for, and whoever is waiting on it. */
interface Adding {
	readonly connectionId: string;
	readonly armor: string;
	readonly answer: (added: boolean) => void;
}

const warning = (message: string): AttachmentProblem => ({ message, tone: 'warning' });

/** What the source is called, as its tab calls it, for its key's printed page. */
const nameOf = async (database: NotesDatabase, connectionId: string): Promise<string> => {
	const all = await connectedSources(database);
	const source = all.find((each) => each.connectionId === connectionId);
	return source === undefined ? UNKNOWN_LABEL : tabName(source, all);
};

/** What opening needs of the keys, copied: the lock wipes its own in place. */
interface Held {
	readonly identities: Uint8Array[];
	readonly recipient: string;
}

const copied = (keys: UnlockedKeys | undefined): Held | undefined =>
	keys === undefined
		? undefined
		: {
				identities: keys.identities.map((identity) => identity.slice()),
				recipient: keys.recipient,
			};

/** What opening came to, from what it threw. */
const failedOpening = (error: unknown): Opened =>
	error instanceof AgeError && error.failure === 'no match'
		? { state: 'other' }
		: { state: 'unreadable' };

/** Sealing to `recipient`, with the age code loaded. */
const sealerOf = (age: Age, recipient: string): Sealer | undefined => {
	const to = age.parseRecipient(recipient);
	return to === undefined ? undefined : (words) => age.sealSecret(words, to);
};

export const useNoteSecrets = (
	note: Pick<NoteRecord, 'connectionId'>,
	{
		report = () => undefined,
		db = appDb,
		lock = tabLock,
		age = loadAge,
		copy = copyText,
		keyFile = syncScheduler.keyFile,
	}: NoteSecretsOptions = {}
): NoteSecrets => {
	// Read when asked, not when the host was made: the editor keeps the host
	// it was built with for as long as the note is open.
	const latest = useRef({ connectionId: note.connectionId, report, db, lock, age, copy });
	useEffect(() => {
		latest.current = { connectionId: note.connectionId, report, db, lock, age, copy };
	});

	const [asking, setAsking] = useState<Asking | null>(null);
	const [adding, setAdding] = useState<Adding | null>(null);
	/** The unlock being asked for, which a second secret waits on too. */
	const waiting = useRef<Promise<boolean> | undefined>(undefined);
	/** The editor open now, offering itself for "Insert secret". */
	const receiver = useRef<(() => void) | undefined>(undefined);
	/** The source's Vault dialog, open over the note, and what the source is called. */
	const [secretsOf, setSecretsOf] = useState<Readonly<{
		connectionId: string;
		name: string;
	}> | null>(null);

	const openSecrets = useCallback(() => {
		const { connectionId, db: database } = latest.current;
		void nameOf(database, connectionId)
			.catch(() => UNKNOWN_LABEL)
			.then((name) => {
				setSecretsOf({ connectionId, name });
			});
	}, []);

	/** `why`, as a warning, with the way to the Vault dialog where that is the way on. */
	const said = useCallback(
		({ message, way }: Why): AttachmentProblem =>
			way === undefined
				? warning(message)
				: {
						...warning(message),
						action: {
							label:
								way === 'setUp'
									? t('editor.secret.setUp')
									: t('editor.secret.open'),
							onChoose: openSecrets,
						},
					},
		[openSecrets]
	);

	/** Whether the source is unlocked, the unlock asked for over the note where it is not. */
	const unlockedNow = useCallback(async (): Promise<boolean> => {
		const { connectionId, lock: held, db: database, report: say } = latest.current;
		if (held.isUnlocked(connectionId)) return true;
		const enrolled = await enrolment(database, connectionId);
		if (enrolled === undefined) {
			say(said(notEnrolled()));
			return false;
		}
		waiting.current ??= new Promise<boolean>((resolve) => {
			setAsking({
				connectionId,
				kind: enrolled.unlock,
				answer: (answered) => {
					waiting.current = undefined;
					setAsking(null);
					resolve(answered);
				},
			});
		});
		return waiting.current;
	}, [said]);

	/**
	 * Copies of this device's keys for the source, unlocked first where they
	 * are locked; or none. Copied as they are read, with nothing awaited
	 * between: the lock wipes its own in place, the moment the page hides.
	 */
	const unlocked = useCallback(async (): Promise<Held | undefined> => {
		const { connectionId, lock: held } = latest.current;
		const keys = held.keys(connectionId);
		if (keys !== undefined) return copied(keys);
		return (await unlockedNow()) ? copied(held.keys(connectionId)) : undefined;
	}, [unlockedNow]);

	/** `held`'s words for `armor`, and how to seal what they become; wiped after. */
	const opening = useCallback(async (armor: string, held: Held): Promise<Opened> => {
		const { connectionId, lock, report: say } = latest.current;
		try {
			const loaded = await latest.current.age();
			const seal = sealerOf(loaded, held.recipient);
			if (seal === undefined) return { state: 'unreadable' };
			const words = loaded.openSecret(armor, held.identities);
			// Locked while the age code loaded: the words are not to be shown.
			if (!lock.isUnlocked(connectionId)) return { state: 'locked' };
			return { state: 'opened', words, seal };
		} catch (error) {
			if (error instanceof AgeError) return failedOpening(error);
			say(warning(t('secrets.failed')));
			return { state: 'locked' };
		} finally {
			held.identities.forEach((identity) => identity.fill(0));
		}
	}, []);

	const host = useMemo<SecretHost>(
		() => ({
			begin: async () => {
				const { connectionId, db: database, report: say } = latest.current;
				try {
					const [file, enrolled] = await Promise.all([
						database.keyFiles.get(connectionId),
						enrolment(database, connectionId),
					]);
					const why = notHere(file, enrolled);
					if (why !== undefined || enrolled === undefined) {
						say(said(why ?? notEnrolled()));
						return undefined;
					}
					// To the recipient this device enrolled with, which needs no
					// unlock.
					const seal = sealerOf(await latest.current.age(), enrolled.recipient);
					if (seal === undefined) say(warning(t('secrets.failed')));
					return seal;
				} catch {
					say(warning(t('secrets.failed')));
					return undefined;
				}
			},
			open: async (armor) => {
				const held = await unlocked().catch(() => {
					latest.current.report(warning(t('secrets.failed')));
					return undefined;
				});
				return held === undefined ? { state: 'locked' } : opening(armor, held);
			},
			copy: (words) =>
				latest.current.copy(words).then(
					() => true,
					() => false
				),
			addKey: async (armor) => {
				// Unlocked first: the key is sealed with the ones the device holds.
				const ready = await unlockedNow().catch(() => {
					latest.current.report(warning(t('secrets.failed')));
					return false;
				});
				if (!ready) return false;
				const { connectionId } = latest.current;
				return new Promise<boolean>((resolve) => {
					setAdding({
						connectionId,
						armor,
						answer: (added) => {
							setAdding(null);
							resolve(added);
						},
					});
				});
			},
			locked: (listener) => {
				const { connectionId, lock: held } = latest.current;
				const was = cell(held.isUnlocked(connectionId));
				return held.subscribe(() => {
					const now = held.isUnlocked(connectionId);
					if (was.current && !now) listener();
					was.current = now;
				});
			},
			receive: (insert) => {
				receiver.current = insert;
				return () => {
					if (receiver.current === insert) receiver.current = undefined;
				};
			},
		}),
		[opening, unlocked, unlockedNow, said]
	);

	const insert = useCallback(() => {
		receiver.current?.();
	}, []);

	const keyDialog =
		adding === null ? null : (
			<AddKeyDialog
				database={db}
				connectionId={adding.connectionId}
				armor={adding.armor}
				lock={lock}
				age={age}
				onAdded={() => {
					adding.answer(true);
				}}
				onCancel={() => {
					adding.answer(false);
				}}
			/>
		);

	const secretsDialog =
		secretsOf === null ? null : (
			<SecretsDialog
				database={db}
				connectionId={secretsOf.connectionId}
				sourceName={secretsOf.name}
				keyFile={keyFile}
				lock={lock}
				age={age}
				copy={copy}
				onClose={() => {
					setSecretsOf(null);
				}}
			/>
		);

	const dialog =
		asking === null ? (
			(keyDialog ?? secretsDialog)
		) : (
			<UnlockDialog
				database={db}
				connectionId={asking.connectionId}
				kind={asking.kind}
				lock={lock}
				onUnlocked={() => {
					asking.answer(true);
				}}
				onRecovery={() => {
					// The device's copy is gone: what is left is the source's dialog,
					// opened in the unlock's place.
					asking.answer(false);
					openSecrets();
				}}
				onCancel={() => {
					asking.answer(false);
				}}
			/>
		);

	return { host, dialog, insert };
};
