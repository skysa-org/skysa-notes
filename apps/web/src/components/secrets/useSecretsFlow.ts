import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { t } from '../../i18n/t.js';
import { type DeviceLock, setUpDeviceLock } from '../../secrets/deviceLock.js';
import { sameIdentity, wipe } from '../../secrets/keys.js';
import type { Age } from '../../secrets/loadAge.js';
import {
	changeUnlock,
	enrol,
	enrolment,
	forgetKeys,
	replaceKeys,
	type Unlock,
	type UnlockedKeys,
} from '../../store/secretKeys.js';
import { getPasswordsShown } from '../../store/vault.js';
import type { Making, SecretsDialogProps, Step } from './types.js';
import type { Chosen } from './UnlockEntry.js';
import { useDeviceLock } from './useDeviceLock.js';

/**
 * The vault dialog's flow: where it is (`step`, or none to start from what the
 * folder and the device hold), whether it is busy and what it says, and every
 * step's work — setting the source up, enrolling, unlocking, replacing and
 * removing keys. Keys it makes or reads from what was typed are its own
 * (`own`), filled with zeros once they are kept, sealed, on the device, and as
 * the dialog closes; the lock's copies are the lock's to wipe. Should the
 * source leave the device while its keys are being kept, it closes the dialog.
 */
export const useSecretsFlow = ({
	database,
	connectionId,
	sourceName,
	keyFile,
	lock,
	rounds,
	age,
	givenDeviceLock,
	onClose,
}: Pick<
	SecretsDialogProps,
	'database' | 'connectionId' | 'sourceName' | 'keyFile' | 'lock' | 'onClose'
> & {
	rounds: number;
	age: () => Promise<Age>;
	givenDeviceLock: DeviceLock | undefined;
}) => {
	const [read, setRead] = useState(false);
	const [step, setStep] = useState<Step | null>(null);
	const [busy, setBusy] = useState(false);
	/** What is under way, said while it is; nothing where that is quick. */
	const [doing, setDoing] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const record = useLiveQuery(
		() => database.keyFiles.get(connectionId),
		[database, connectionId]
	);
	const enrolled = useLiveQuery(
		() => enrolment(database, connectionId).then((found) => found ?? null),
		[database, connectionId]
	);
	const unlocked = useSyncExternalStore(lock.subscribe, () => lock.isUnlocked(connectionId));
	const passwordsShown = useLiveQuery(
		() => getPasswordsShown(database, connectionId),
		[database, connectionId]
	);

	/**
	 * The keys this dialog made or read from what was typed: filled with zeros
	 * once they are kept, sealed, on the device, and as it closes. Its own
	 * copies only; the lock's are the lock's to wipe.
	 */
	const owned = useRef(new Set<Uint8Array>());
	const own = (identity: Uint8Array): Uint8Array => {
		owned.current.add(identity);
		return identity;
	};
	const wipeOwned = () => {
		wipe(owned.current);
	};
	useEffect(() => {
		const identities = owned.current;
		return () => {
			wipe(identities);
		};
	}, []);

	const { deviceLock, deviceOffered, setDeviceOffered } = useDeviceLock(givenDeviceLock);

	useEffect(() => {
		// What the folder says now, which another device may have changed.
		void keyFile.refresh(connectionId).finally(() => {
			setRead(true);
		});
	}, [keyFile, connectionId]);

	const go = (next: Step | null) => {
		setError(undefined);
		setStep(next);
	};

	/**
	 * `work`, with the dialog busy until it ends, however it ends: one that
	 * fails says so, rather than leaving every button disabled and nothing said.
	 */
	const run = async (work: () => Promise<void>, saying?: string) => {
		setBusy(true);
		setDoing(saying);
		try {
			await work();
		} catch {
			setError(t('secrets.failed'));
		} finally {
			setBusy(false);
			setDoing(undefined);
		}
	};

	/** The secrets `identities` would leave locked, said where there are any; and on, where not. */
	const scanned = (identities: readonly Uint8Array[]) =>
		run(async () => {
			const { scanSecrets } = await age();
			const scan = await scanSecrets(database, connectionId, identities);
			go(
				scan.others > 0
					? {
							kind: 'different',
							identities,
							secrets: scan.others,
							notes: scan.otherNotes,
						}
					: { kind: 'choose', identities, then: 'setUp' }
			);
		}, t('secrets.scanning'));

	/**
	 * Whether the key file names `recipient` now: written here, where it named
	 * none, or `over`, the source's key being replaced; or already. A write
	 * refused because another device wrote first goes back to where the
	 * dialog starts, which is decided by what the folder says now.
	 */
	const setUp = async (recipient: string, over?: string): Promise<boolean> => {
		const written = await (over === undefined
			? keyFile.write(connectionId, recipient)
			: keyFile.write(connectionId, recipient, over));
		if (written.status === 'written') return true;
		if (written.status === 'changed') {
			// Written by this dialog on a try that failed after it.
			const now = await database.keyFiles.get(connectionId);
			if (now?.state === 'ok' && now.recipient === recipient) return true;
			go(null);
			setError(
				over === undefined ? t('secrets.written.changed') : t('secrets.rekey.changed')
			);
			return false;
		}
		if (written.status === 'unavailable') setError(t('secrets.unavailable'));
		else setError(over === undefined ? t('secrets.written.failed') : t('secrets.rekey.failed'));
		return false;
	};

	/**
	 * What `chosen` unlocks with: as it was entered, or the device's own lock,
	 * its passkey made and checked now (`setUpDeviceLock`). Nothing where that
	 * could not be, which is said; a device whose lock cannot keep a key in
	 * this browser is not offered it again.
	 */
	const unlockFor = async (chosen: Chosen): Promise<Unlock | undefined> => {
		if (chosen.kind !== 'device') return chosen;
		const name = t('secrets.device.passkeyName', { source: sourceName });
		// The device's prompt is the app's own: the page hidden behind it does not lock.
		const set = await lock.prompting(() => setUpDeviceLock(deviceLock, name));
		if (set.state === 'set') return set.unlock;
		if (set.state === 'unsupported') setDeviceOffered(false);
		setError(
			set.state === 'unsupported'
				? t('secrets.choose.deviceUnsupported')
				: t('secrets.choose.deviceRefused')
		);
		return undefined;
	};

	/** The passkey this device unlocks with now, where it unlocks with one. */
	const passkeyNow = async () => (await enrolment(database, connectionId))?.device?.credentialId;

	/**
	 * A passkey no unlock is sealed under any more, let go of
	 * (`DeviceLock.forget`): one left in a password manager looks like one
	 * that still unlocks.
	 */
	const forgetPasskey = (credentialId: ArrayBuffer | undefined) => {
		if (credentialId !== undefined) void deviceLock.forget(credentialId);
	};

	/**
	 * What `keeping` the keys under `unlock` comes to. What the device's lock
	 * answered is let go of however it ends, and its passkey too where the
	 * keys were not kept under it.
	 */
	const settled = async (
		unlock: Unlock,
		keeping: () => Promise<UnlockedKeys | undefined>
	): Promise<UnlockedKeys | undefined> => {
		const keys = await keeping().catch((error: unknown) => {
			letGo(unlock, false);
			throw error;
		});
		letGo(unlock, keys !== undefined);
		return keys;
	};

	const letGo = (unlock: Unlock, kept: boolean) => {
		if (unlock.kind !== 'device') return;
		unlock.answer.fill(0);
		if (!kept) forgetPasskey(unlock.credentialId);
	};

	/**
	 * The device's keys kept under `unlock`, the key file written first where
	 * the source is being set up, and the passkey of the unlock they replace
	 * let go of. Nothing where they were not kept: that is said, or, where the
	 * source was let go of meanwhile, the dialog closes.
	 */
	const keptUnder = async (
		identities: readonly Uint8Array[],
		first: Uint8Array,
		then: 'setUp' | 'enrol',
		unlock: Unlock
	): Promise<UnlockedKeys | undefined> => {
		const { recipientOf } = await age();
		const recipient = recipientOf(first);
		if (then === 'setUp' && !(await setUp(recipient))) return undefined;
		const before = await passkeyNow();
		const keys = await enrol(database, { connectionId, recipient, identities, unlock, rounds });
		if (keys === undefined) onClose();
		else forgetPasskey(before);
		return keys;
	};

	/** The device's keys kept under the unlock chosen (`keptUnder`). */
	const keep = (identities: readonly Uint8Array[], then: 'setUp' | 'enrol', chosen: Chosen) =>
		run(async () => {
			const [first] = identities;
			if (first === undefined) return;
			const unlock = await unlockFor(chosen);
			if (unlock === undefined) return;
			const keys = await settled(unlock, () => keptUnder(identities, first, then, unlock));
			if (keys === undefined) return;
			wipeOwned();
			lock.hold(keys);
			go({
				kind: 'done',
				said: then === 'setUp' ? t('secrets.done.setUp') : t('secrets.done.enrolled'),
			});
		}, t('secrets.written.saving'));

	/**
	 * The source's new key kept with the keys this device holds, under the
	 * unlock it has: unlocked first where it is locked.
	 */
	const replaceWith = (identity: Uint8Array) =>
		run(async () => {
			const { recipientOf } = await age();
			// Read after that wait, and handed on with none: `replaceKeys`
			// copies them before its own, and the lock can wipe them at either.
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				go({ kind: 'unlock', then: 'replace', identity });
				return;
			}
			const held = keys.identities.filter((each) => !sameIdentity(each, identity));
			const replaced = await replaceKeys(database, keys, recipientOf(identity), [
				identity,
				...held,
			]);
			if (replaced === undefined) {
				lock.lock(connectionId);
				go(null);
				setError(t('secrets.device.changedElsewhere'));
				return;
			}
			wipeOwned();
			lock.hold(replaced);
			go({ kind: 'done', said: t('secrets.done.replaced') });
		});

	const changeTo = (chosen: Chosen) =>
		run(async () => {
			// Locked meanwhile: unlocked again, and asked again.
			if (!lock.isUnlocked(connectionId)) {
				go({ kind: 'unlock', then: 'change' });
				return;
			}
			const unlock = await unlockFor(chosen);
			if (unlock === undefined) return;
			const before = await passkeyNow().catch((error: unknown) => {
				letGo(unlock, false);
				throw error;
			});
			// Read after the device's lock was asked, and handed on with none
			// between: `changeUnlock` copies them before its own.
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				letGo(unlock, false);
				go({ kind: 'unlock', then: 'change' });
				return;
			}
			const changed = await settled(unlock, () =>
				changeUnlock(database, keys, unlock, rounds)
			);
			if (changed !== undefined) forgetPasskey(before);
			if (changed === undefined) {
				lock.lock(connectionId);
				go(null);
				setError(t('secrets.device.changedElsewhere'));
				return;
			}
			lock.hold(changed);
			go({ kind: 'done', said: t('secrets.done.changed') });
		}, t('secrets.written.saving'));

	/** The recipients of the keys the source has had, which this device holds: the ones replacing the key encrypts afresh. */
	const sourceRecipients = (keys: UnlockedKeys): readonly string[] => [
		keys.recipient,
		...(enrolled?.former ?? []),
	];

	/** What replacing the source's key with `identity` would do, said before it is done. */
	const rekeyScanned = (identity: Uint8Array) =>
		run(async () => {
			const { keysFor, scanReplacing } = await age();
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				go({ kind: 'unlock', then: 'rekey', identity });
				return;
			}
			// Copies, taken as they are read: the lock wipes its own as the page hides.
			const old = keysFor(keys.identities, sourceRecipients(keys)).map((each) =>
				Uint8Array.from(each)
			);
			try {
				const scan = await scanReplacing(database, connectionId, [identity], old);
				go({ kind: 'rekeyReady', identity, scan });
			} finally {
				old.forEach((each) => each.fill(0));
			}
		}, t('secrets.scanning'));

	/**
	 * The source's key replaced by `identity` (docs/ARCHITECTURE.md §7,
	 * "Replacing the key"). The key file first, written over the recipient
	 * this device has, so a replacement made on another device meanwhile
	 * refuses this one before anything changes; from then on, new secrets
	 * everywhere are made with the new key. Then the device's keys, the new
	 * one first and the ones it held kept beside it. Then every secret the
	 * source's old keys open, encrypted to the new one. Where that stops
	 * short, the device locked or a write failed, the rest still opens here
	 * and is encrypted afresh on a later unlock.
	 */
	const rekey = (identity: Uint8Array) =>
		run(async () => {
			const { recipientOf, keysFor, resealSecrets } = await age();
			const before = lock.keys(connectionId);
			if (before === undefined) {
				go({ kind: 'unlock', then: 'rekey', identity });
				return;
			}
			const old = sourceRecipients(before);
			const recipient = recipientOf(identity);
			if (!(await setUp(recipient, before.recipient))) return;
			// Read after that wait, and handed on with none: `replaceKeys`
			// copies them before its own, and the lock can wipe them at either.
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				go({ kind: 'unlock', then: 'rekey', identity });
				return;
			}
			const held = keys.identities.filter((each) => !sameIdentity(each, identity));
			const replaced = await replaceKeys(database, keys, recipient, [identity, ...held]);
			if (replaced === undefined) {
				lock.lock(connectionId);
				go(null);
				setError(t('secrets.device.changedElsewhere'));
				return;
			}
			// Copies to encrypt with, taken before anything is awaited.
			const [fresh = new Uint8Array(), ...kept] = replaced.identities.map((each) =>
				Uint8Array.from(each)
			);
			const former = keysFor(kept, old);
			lock.hold(replaced);
			wipeOwned();
			setDoing(t('secrets.rekey.encrypting'));
			const resealed = await resealSecrets(database, connectionId, {
				fresh: [fresh],
				recipient,
				old: former,
				going: () => lock.isUnlocked(connectionId),
			})
				.catch(() => undefined)
				.finally(() => {
					[fresh, ...kept].forEach((each) => each.fill(0));
				});
			const said = (() => {
				if (resealed === undefined || resealed.stopped)
					return t('secrets.done.rekeyedPart');
				if (resealed.secrets === 0) return t('secrets.done.rekeyedNone');
				return t('secrets.done.rekeyed', { count: resealed.secrets });
			})();
			go({ kind: 'done', said });
		}, t('secrets.written.saving'));

	const make = (making: Making) =>
		run(async () => {
			const { generateIdentity } = await age();
			go({ kind: 'show', identity: own(generateIdentity()), making });
		});

	const putBack = (recipient: string) =>
		run(async () => {
			if (await setUp(recipient)) go({ kind: 'done', said: t('secrets.lost.done') });
		});

	const remove = () =>
		run(async () => {
			lock.lock(connectionId);
			const before = await passkeyNow();
			await forgetKeys(database, connectionId);
			forgetPasskey(before);
			go(null);
		});

	/** A recovery key typed, taken on by what it was typed for. */
	const typed = (at: Extract<Step, { kind: 'paste' }>, identity: Uint8Array) => {
		own(identity);
		if (at.purpose === 'setup') {
			void scanned([identity]);
			return;
		}
		if (at.purpose === 'rekey') {
			void rekeyScanned(identity);
			return;
		}
		// The keys this device holds are kept beside the new one: unlocked
		// first, where it is locked.
		if (at.purpose === 'replaced' && enrolled !== null && enrolled !== undefined) {
			void replaceWith(identity);
			return;
		}
		if (at.purpose !== 'another') {
			go({ kind: 'choose', identities: [identity], then: 'enrol' });
			return;
		}
		const base = at.base ?? [];
		const known = base.some((held) => sameIdentity(held, identity));
		go({ kind: 'choose', identities: known ? base : [...base, identity], then: 'setUp' });
	};

	return {
		read,
		step,
		busy,
		doing,
		error,
		record,
		enrolled,
		unlocked,
		passwordsShown,
		deviceLock,
		deviceOffered,
		go,
		scanned,
		keep,
		replaceWith,
		changeTo,
		rekeyScanned,
		rekey,
		make,
		putBack,
		remove,
		typed,
	};
};
