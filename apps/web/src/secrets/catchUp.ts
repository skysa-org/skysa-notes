import { activeConnectionId, type NotesDatabase } from '../store/db.js';
import { enrolment } from '../store/secretKeys.js';
import { type SchedulerStatus } from '../sync/scheduler.js';
import { type Age, loadAge } from './loadAge.js';
import { type SecretsLock } from './lock.js';

/**
 * Secrets still made with a key a source had before, encrypted afresh to the
 * key it has now (docs/ARCHITECTURE.md §7, "Replacing the key"): what a
 * replacement left when it stopped short, and what another device made with
 * the old key, offline, while the key was being replaced.
 *
 * A device does this for the sources whose earlier keys it holds
 * (`SecretKeyRecord.former`), once a tab for each source and those keys, as
 * the source is unlocked. Only where the folder names the key the device has,
 * since encrypting to a key that was itself replaced would only make more to
 * catch up. And only once the source's sync has reached the end of a pull: a
 * note read before a pull brings another device's work would be encrypted
 * again beside it, and the two would meet as a conflict. A note a pull
 * changes while this runs is read again as it is written (`rewriteNoteBody`),
 * so nothing is written over.
 *
 * It stops where the device locks, and goes on at the next unlock. A device
 * that holds no earlier key never loads the age code for this.
 *
 * Framework-free, as the wake lock is (`sync/wakeLock.ts`).
 */

export interface CatchUpOptions {
	readonly db: NotesDatabase;
	readonly lock: SecretsLock;
	/** The sync scheduler, whose status covers the source shown. */
	readonly scheduler: Readonly<{
		status: () => SchedulerStatus;
		subscribe: (listener: (status: SchedulerStatus) => void) => () => void;
	}>;
	readonly age?: () => Promise<Age>;
}

/** Starts following the lock and the scheduler. Returns the way to stop. */
export const catchUpSecrets = ({
	db,
	lock,
	scheduler,
	age = loadAge,
}: CatchUpOptions): (() => void) => {
	/** Each source caught up in this tab, by the earlier keys it held then. */
	const done = new Map<string, string>();
	const running = new Set<string>();

	const pass = async (connectionId: string): Promise<void> => {
		const [enrolled, file] = await Promise.all([
			enrolment(db, connectionId),
			db.keyFiles.get(connectionId),
		]);
		if (enrolled === undefined || enrolled.former.length === 0) return;
		if (file?.state !== 'ok' || file.recipient !== enrolled.recipient) return;
		const former = enrolled.former.join(' ');
		if (done.get(connectionId) === former) return;
		const { keysFor, resealSecrets } = await age();
		const keys = lock.keys(connectionId);
		if (keys?.recipient !== enrolled.recipient) return;
		// Copies, taken as they are read: the lock wipes its own as the page hides.
		const fresh = keysFor(keys.identities, [keys.recipient]).map((key) => Uint8Array.from(key));
		const old = keysFor(keys.identities, enrolled.former).map((key) => Uint8Array.from(key));
		try {
			const resealed = await resealSecrets(db, connectionId, {
				fresh,
				recipient: keys.recipient,
				old,
				going: () => lock.isUnlocked(connectionId),
			});
			if (!resealed.stopped) done.set(connectionId, former);
		} finally {
			[...fresh, ...old].forEach((key) => key.fill(0));
		}
	};

	const follow = () => {
		if (scheduler.status().phase !== 'idle') return;
		void activeConnectionId(db)
			.then(async (connectionId) => {
				if (running.has(connectionId) || !lock.isUnlocked(connectionId)) return;
				running.add(connectionId);
				try {
					await pass(connectionId);
				} finally {
					running.delete(connectionId);
				}
			})
			// Tried again at the next unlock, or the next sync's end.
			.catch(() => undefined);
	};

	const unsubscribe = [lock.subscribe(follow), scheduler.subscribe(follow)];
	return () => {
		unsubscribe.forEach((each) => {
			each();
		});
	};
};
