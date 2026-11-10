import type { NewSyncOp } from '@skysa/core';

import type { AccessToken } from '../../src/api/client.js';
import type { ClientStore } from '../../src/sync/scheduler.js';

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
	/**
	 * Bound to the connection and holding its credential, and showing it: what
	 * a connect leaves. The credential is `sk1_` and the connection's id unless
	 * given.
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
	/** The token kept for the connection, as a reload would find it. */
	readonly keptToken: (connectionId: string) => Promise<AccessToken | undefined>;
	/** A token kept as another tab keeps one, over whatever was kept. */
	readonly keepElsewhere: (connectionId: string, token: AccessToken) => Promise<void>;
	/**
	 * The connection let go, its credential and its token with it. With
	 * `unsent`, it had work it never sent, and is kept, detached, to hold it.
	 */
	readonly letGo: (connectionId: string, options?: { unsent?: boolean }) => Promise<void>;
	/** What the device has of the connection: synced, kept detached, or nothing. */
	readonly connection: (connectionId: string) => Promise<'live' | 'detached' | undefined>;
	/** The credential gone from under the client: revoked from another device. */
	readonly dropCredential: (connectionId: string) => Promise<void>;
}
