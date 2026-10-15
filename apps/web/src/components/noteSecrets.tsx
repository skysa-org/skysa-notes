import { AgeError } from '@skysa/core';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AttachmentProblem } from '../editor/attachHost.js';
import type { Opened, Sealer, SecretHost } from '../editor/secretHost.js';
import { t } from '../i18n/t.js';
import { type Age, loadAge } from '../secrets/loadAge.js';
import type { SecretsLock } from '../secrets/lock.js';
import { tabLock } from '../secrets/tabLock.js';
import {
	db as appDb,
	type KeyFileRecord,
	type NoteRecord,
	type NotesDatabase,
	type UnlockKind,
} from '../store/db.js';
import { enrolment, type UnlockedKeys } from '../store/secretKeys.js';
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
 * another key; and a secret opened as the lock closed is not shown. Setting
 * a source up, and enrolling a device, are the source's Secrets dialog's:
 * where either is wanted, the host says where it is.
 */

export interface NoteSecretsOptions {
	/** Where a problem the editor has nowhere to show goes: a toast. */
	report?: (problem: AttachmentProblem) => void;
	db?: NotesDatabase;
	lock?: SecretsLock;
	age?: () => Promise<Age>;
	/** Words to the system clipboard. */
	copy?: (text: string) => Promise<void>;
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

const copyText = (text: string): Promise<void> => navigator.clipboard.writeText(text);

const warning = (message: string): AttachmentProblem => ({ message, tone: 'warning' });

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

/**
 * Why a new secret cannot be made in a source, for its key file as last read
 * and this device's keys; none where it can. The recipient sealed to is the
 * one the device enrolled with, so a key file that names another means the
 * key was replaced on another device.
 */
const notHere = (
	file: KeyFileRecord | undefined,
	enrolled: Awaited<ReturnType<typeof enrolment>>
): string | undefined => {
	if (file?.state === 'newer') return t('secrets.newer');
	if (file?.state === 'invalid') return t('secrets.invalid');
	if (enrolled === undefined) {
		return file?.state === 'ok' ? t('editor.secret.notEnrolled') : t('editor.secret.notSetUp');
	}
	if (file?.state !== 'ok') return t('editor.secret.lost');
	return enrolled.recipient === file.recipient ? undefined : t('editor.secret.replaced');
};

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
	}: NoteSecretsOptions = {}
): NoteSecrets => {
	// Read when asked, not when the host was made: the editor keeps the host
	// it was built with for as long as the note is open.
	const latest = useRef({ connectionId: note.connectionId, report, db, lock, age, copy });
	useEffect(() => {
		latest.current = { connectionId: note.connectionId, report, db, lock, age, copy };
	});

	const [asking, setAsking] = useState<Asking | null>(null);
	/** The unlock being asked for, which a second secret waits on too. */
	const waiting = useRef<Promise<boolean> | undefined>(undefined);
	/** The editor open now, offering itself for "Insert secret". */
	const receiver = useRef<(() => void) | undefined>(undefined);

	/**
	 * Copies of this device's keys for the source, unlocked first where they
	 * are locked; or none. Copied as they are read, with nothing awaited
	 * between: the lock wipes its own in place, the moment the page hides.
	 */
	const unlocked = useCallback(async (): Promise<Held | undefined> => {
		const { connectionId, lock: held, db: database, report: say } = latest.current;
		const keys = held.keys(connectionId);
		if (keys !== undefined) return copied(keys);
		const enrolled = await enrolment(database, connectionId);
		if (enrolled === undefined) {
			say(warning(t('editor.secret.notEnrolled')));
			return undefined;
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
		return (await waiting.current) ? copied(held.keys(connectionId)) : undefined;
	}, []);

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
						say(warning(why ?? t('editor.secret.notEnrolled')));
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
			locked: (listener) => {
				const { connectionId, lock: held } = latest.current;
				const was = { current: held.isUnlocked(connectionId) };
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
		[opening, unlocked]
	);

	const insert = useCallback(() => {
		receiver.current?.();
	}, []);

	const dialog =
		asking === null ? null : (
			<UnlockDialog
				database={db}
				connectionId={asking.connectionId}
				kind={asking.kind}
				lock={lock}
				onUnlocked={() => {
					asking.answer(true);
				}}
				onRecovery={() => {
					// The device's copy is gone: what is left is the source's dialog.
					asking.answer(false);
					latest.current.report(warning(t('editor.secret.notEnrolled')));
				}}
				onCancel={() => {
					asking.answer(false);
				}}
			/>
		);

	return { host, dialog, insert };
};
