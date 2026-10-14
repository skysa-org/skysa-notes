import { AgeError } from '@skysa/core';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AttachmentProblem } from '../editor/attachHost.js';
import type { Opened, Sealed, SecretHost } from '../editor/secretHost.js';
import { t } from '../i18n/t.js';
import { type Age, loadAge } from '../secrets/loadAge.js';
import type { SecretsLock } from '../secrets/lock.js';
import { tabLock } from '../secrets/tabLock.js';
import { db as appDb, type NoteRecord, type NotesDatabase, type UnlockKind } from '../store/db.js';
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
 * another key. Setting a source up, and enrolling a device, are the source's
 * Secrets dialog's: where either is wanted, the host says where it is.
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

const copied = (keys: UnlockedKeys | undefined): Uint8Array[] | undefined =>
	keys?.identities.map((identity) => identity.slice());

/** What opening came to, from what it threw. */
const failedOpening = (error: unknown): Opened =>
	error instanceof AgeError && error.failure === 'no match'
		? { state: 'other' }
		: { state: 'unreadable' };

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
	const unlocked = useCallback(async (): Promise<Uint8Array[] | undefined> => {
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

	const host = useMemo<SecretHost>(
		() => ({
			sealable: async () => {
				const { connectionId, db: database, report: say } = latest.current;
				const [file, enrolled] = await Promise.all([
					database.keyFiles.get(connectionId),
					enrolment(database, connectionId),
				]);
				const why =
					file?.state !== 'ok'
						? t('editor.secret.notSetUp')
						: enrolled === undefined
							? t('editor.secret.notEnrolled')
							: enrolled.recipient === file.recipient
								? undefined
								: t('editor.secret.replaced');
				if (why !== undefined) say(warning(why));
				return why === undefined;
			},
			open: async (armor) => {
				const identities = await unlocked();
				if (identities === undefined) return { state: 'locked' };
				try {
					const loaded = await latest.current.age().catch(() => undefined);
					if (loaded === undefined) {
						latest.current.report(warning(t('secrets.failed')));
						return { state: 'locked' };
					}
					return { state: 'opened', words: await loaded.openSecret(armor, identities) };
				} catch (error) {
					return failedOpening(error);
				} finally {
					identities.forEach((identity) => identity.fill(0));
				}
			},
			// To the recipient this device enrolled with, which needs no unlock.
			// Where the key file names another, the key was replaced elsewhere;
			// words already revealed here are kept all the same, and opened by
			// this device, rather than lost.
			seal: async (words): Promise<Sealed> => {
				const { connectionId, db: database, report: say } = latest.current;
				const enrolled = await enrolment(database, connectionId);
				if (enrolled === undefined) {
					say(warning(t('editor.secret.notEnrolled')));
					return { state: 'refused' };
				}
				try {
					const { parseRecipient, sealSecret } = await latest.current.age();
					const recipient = parseRecipient(enrolled.recipient);
					if (recipient === undefined) throw new Error('not a recipient');
					return { state: 'sealed', armor: await sealSecret(words, recipient) };
				} catch {
					say(warning(t('editor.secret.notSealed')));
					return { state: 'refused' };
				}
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
		[unlocked]
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
