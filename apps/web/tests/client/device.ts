import type { AccessToken } from '../../src/api/client.js';
import type { CredentialStore } from '../../src/store/credentials.js';
import type { TokenStates } from '../../src/sync/tokens.js';

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
	/** Where the device's credentials are held. */
	readonly credentials: CredentialStore;
	/** Where a connection's token is kept between loads. */
	readonly tokens: TokenStates;
	/**
	 * Bound to the connection and holding its credential: what a connect
	 * leaves. The credential is `sk1_` and the connection's id unless given.
	 */
	readonly bind: (connectionId: string, credential?: string) => Promise<void>;
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
