import type { NewSyncOp } from '@skysa/core';

import type { AccessToken } from '../../src/api/client.js';
import type { ClientStore, SyncScheduler, SyncSchedulerOptions } from '../../src/sync/scheduler.js';

/** What the app hands its scheduler of its own: its lock, its documents, its hidden paths. */
export type AppSchedulerOptions = Pick<
	SyncSchedulerOptions,
	'lockName' | 'document' | 'syncsHidden'
>;

/** What a test hands a scheduler: everything but the device's and the app's. */
export type ScheduleOptions = Omit<
	SyncSchedulerOptions,
	'store' | 'watch' | keyof AppSchedulerOptions
>;

/** A document on the device: its id, and where it is. */
interface DeviceDocument {
	readonly id: string;
	readonly path: string;
}

/**
 * A device as the sync client's tests see it: the ports the client is
 * handed, and what a test does to the device around them. The client goes to
 * the shared kit and reaches the device only through its ports
 * (docs/decisions/0018-the-shared-kit.md), so its tests are suites over this,
 * as core's store contract is over a store: the kit runs each over the ports
 * in memory (`memoryDevice.ts`), and an app over its own database, which this
 * app does in `tests/support/dexieDevice.ts`.
 *
 * It grows as the suites over it do.
 */
export interface ClientDevice {
	/**
	 * The scheduler's side of the device (`ClientStore`), which carries the
	 * credentials and the token states the token source and the relay are
	 * handed too.
	 */
	readonly store: ClientStore;
	/** What the app hands its scheduler of its own (`AppSchedulerOptions`). */
	readonly app: AppSchedulerOptions;
	/**
	 * The scheduler, made as the app makes it: over `store`, with what the app
	 * hands it, and with whatever the app attaches to it attached.
	 */
	readonly schedule: (options: ScheduleOptions) => SyncScheduler;
	/**
	 * Bound to the connection and holding its credential, and showing it: what
	 * a connect leaves. The credential is `sk1_` and the connection's id unless
	 * given. One the device has never held starts its first import
	 * (`importing`); one a detach kept is resumed (`connection`).
	 */
	readonly bind: (connectionId: string, credential?: string) => Promise<void>;
	/** The source the app shows, as the user choosing it makes it. */
	readonly show: (connectionId: string) => Promise<void>;
	/**
	 * An op queued for the connection, as the app queues one; `lazy`, as a
	 * write queued to go with the next sync is. Answers its seq.
	 */
	readonly queue: (
		connectionId: string,
		op: NewSyncOp,
		options?: { lazy?: boolean }
	) => Promise<number>;
	/**
	 * A document made as the user makes one, named `name`, holding `body`, with
	 * its write queued.
	 */
	readonly create: (connectionId: string, name: string, body: string) => Promise<DeviceDocument>;
	/**
	 * A document changed as the user changes one, its write queued by the app's
	 * rule: one already waiting carries the change, except that an edit finding
	 * only a write queued lazily puts one that is not in its place, at the back.
	 */
	readonly edit: (
		connectionId: string,
		id: string,
		body: string,
		options?: { lazy?: boolean }
	) => Promise<void>;
	/** The ops queued for the connection, in order, and which of them are lazy. */
	readonly queued: (
		connectionId: string
	) => Promise<readonly Readonly<{ seq: number; lazy: boolean }>[]>;
	/** When a pull of the connection last reached the end, as a reload finds it. */
	readonly lastSyncAt: (connectionId: string) => Promise<number | undefined>;
	/** The token kept for the connection, as a reload would find it. */
	readonly keptToken: (connectionId: string) => Promise<AccessToken | undefined>;
	/** A token kept as another tab keeps one, over whatever was kept. */
	readonly keepElsewhere: (connectionId: string, token: AccessToken) => Promise<void>;
	/**
	 * The connection let go, its credential and its token with it. With
	 * `unsent`, it had work it never sent, and is kept, detached, to hold it.
	 */
	readonly letGo: (connectionId: string, options?: { unsent?: boolean }) => Promise<void>;
	/**
	 * Let go and bound again, to the same account, in one step, as another tab
	 * can do it: the client may never see it let go. What it never sent is kept
	 * through it, and it is resumed.
	 */
	readonly reconnect: (connectionId: string) => Promise<void>;
	/**
	 * What the device has of the connection: synced; resumed, bound again over
	 * what a detach kept, its remote not checked yet (`ClientStore.verifyResume`),
	 * where any of that names a file; kept detached; or nothing.
	 */
	readonly connection: (
		connectionId: string
	) => Promise<'live' | 'resumed' | 'detached' | undefined>;
	/** Whether the connection's first import is still going (`ClientStore.finishImport`). */
	readonly importing: (connectionId: string) => Promise<boolean>;
	/**
	 * Another tab holding the device's storage, as a frozen one can: what the
	 * device does waits until it lets go, and `store.heldUp()` says so. Answers
	 * the way to let go.
	 */
	readonly holdUp: () => Promise<() => void>;
	/** The credential gone from under the client: revoked from another device. */
	readonly dropCredential: (connectionId: string) => Promise<void>;
}
