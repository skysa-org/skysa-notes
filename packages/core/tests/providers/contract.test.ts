import { createDropboxProvider } from '../../src/providers/dropbox.js';
import {
	createFakeProvider,
	type FakeProvider,
	type FakeProviderOptions,
} from '../../src/providers/fake.js';
import { createGDriveProvider } from '../../src/providers/gdrive/index.js';
import type { FetchLike } from '../../src/providers/http.js';
import { createOneDriveProvider } from '../../src/providers/onedrive.js';
import type { StorageProvider } from '../../src/providers/types.js';
import { describeProviderContract, type ProviderContractOptions } from './contract.js';
import { createDropboxStub } from './dropboxStub.js';
import { createGDriveStub } from './gdriveStub.js';
import { createOneDriveStub } from './onedriveStub.js';

/**
 * The registry CLAUDE.md names: every provider adapter is registered here and
 * runs the same scenarios. Adapters that talk to a real account register a
 * second time behind `PROVIDER_LIVE_TESTS=1`, so CI stays offline.
 */

/**
 * The way in beneath an adapter, for the scenarios about a file that is not
 * UTF-8 (`ProviderHarness.plant`): straight into the fake every one of these
 * is backed by.
 */
const beneath = (backing: FakeProvider) => ({
	plant: (path: string, bytes: Uint8Array) => {
		backing.plantBytes(path, bytes);
		return Promise.resolve();
	},
	bytesAt: (path: string) => Promise.resolve(backing.bytesAt(path)),
});

const fake = (options: FakeProviderOptions = {}) => {
	const provider = createFakeProvider(options);
	return { provider, ...beneath(provider) };
};

describeProviderContract('in-memory fake', () => fake());

// The fake's own change feed is coalescing-free and paginates one entry at a
// time here, which is the weakest feed any real provider gives. An adapter that
// passes this also passes against a friendlier one.
describeProviderContract('in-memory fake, one entry per page', () => fake({ pageSize: 1 }));

describeProviderContract('in-memory fake, provider reports whole subtrees', () =>
	fake({ folderChanges: 'recursive' })
);

/**
 * Well-formed for Dropbox and certain not to be current: a `rev` is lowercase
 * hex of at least 9 characters, and all-`f` sorts above any real one. The
 * suite's default is an opaque string Dropbox refuses at parameter validation
 * with a 400, which is neither of the answers that scenario is checking for.
 */
const DROPBOX_STALE_REV = 'ffffffffffffffff';

/** What every adapter is made from: one shape, so one table registers them all. */
type CreateAdapter = (options: {
	fetch: FetchLike;
	getAccessToken: () => Promise<string>;
	appVersion: string;
	clientId: string;
}) => StorageProvider;

interface Adapter {
	name: string;
	create: CreateAdapter;
	stub: (options: { pageSize?: number }) => { fetch: FetchLike; backing: FakeProvider };
	options?: ProviderContractOptions;
	/** The variable a live run reads its access token from. */
	liveToken: string;
	live: ProviderContractOptions;
	/** Waits, after a live scenario empties the app folder, until it reads as empty. */
	settle?: (provider: StorageProvider) => Promise<void>;
}

const adapters: readonly Adapter[] = [
	{
		// One entry per page, so the adapter's `has_more` loops — in `list` and
		// in `changes` — are walked rather than assumed.
		name: 'dropbox',
		create: createDropboxProvider,
		stub: createDropboxStub,
		options: { staleVersion: DROPBOX_STALE_REV },
		// Needs an app registration and a throwaway account. See
		// docs/ARCHITECTURE.md §5.3.
		liveToken: 'DROPBOX_TEST_TOKEN',
		live: { staleVersion: DROPBOX_STALE_REV, timeout: 30_000 },
	},
	{
		// Graph's feed carries no paths and does not report a renamed folder's
		// contents, so the adapter keeps the tree in its cursor. One entry per
		// page splits that tree across pages, which is where it is easiest to
		// get wrong.
		name: 'onedrive',
		create: createOneDriveProvider,
		stub: createOneDriveStub,
		// A Graph access token carrying `Files.ReadWrite.AppFolder`. See
		// docs/ARCHITECTURE.md §5.2.
		liveToken: 'ONEDRIVE_TEST_TOKEN',
		live: { timeout: 30_000 },
	},
	{
		// Drive's feed names no paths and lists no parents, and nothing on Drive
		// is conditional, so the adapter walks names, checks before and after it
		// writes, and lists what arrives. One entry per page splits the scan and
		// the feed.
		name: 'gdrive',
		create: createGDriveProvider,
		stub: createGDriveStub,
		// An access token carrying `drive.file`. See docs/ARCHITECTURE.md §5.1.
		liveToken: 'GDRIVE_TEST_TOKEN',
		// Drive's change feed lags a write by a couple of seconds (measured
		// 1.4–2.8s, docs/ARCHITECTURE.md §5.1), so every read of it in the suite
		// waits first. Dropbox's and Graph's are immediate and take the default
		// of 0.
		live: { changesLagMs: 5_000, timeout: 60_000 },
		// Drive's search index keeps listing a deleted file for a moment, and the
		// next scenario's cold-start scan then finds files whose parent the
		// cleanup has already removed — unplaceable, so reported as deletions by
		// id, in a scan that is supposed to report current state and nothing
		// else. That is this harness emptying a shared folder between scenarios,
		// not something a user can do to themselves, but it fails the scenario
		// all the same.
		settle: async (provider) => {
			for (let round = 0; round < 20; round += 1) {
				if ((await provider.list('')).length === 0) return;
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		},
	},
];

for (const adapter of adapters) {
	for (const [suffix, stubOptions] of [
		[', one entry per page', { pageSize: 1 }],
		['', {}],
	] as const) {
		describeProviderContract(
			`${adapter.name} over a stubbed transport${suffix}`,
			() => {
				const stub = adapter.stub(stubOptions);
				return {
					provider: adapter.create({
						fetch: stub.fetch,
						getAccessToken: () => Promise.resolve('stub-token'),
						appVersion: '0.1.0',
						clientId: 'stub-client',
					}),
					...beneath(stub.backing),
				};
			},
			adapter.options
		);
	}
}

/**
 * The same scenarios against a real account, for each adapter whose token is
 * given. Skipped unless asked for, because each empties the app folder between
 * scenarios: use a throwaway account.
 *
 *   PROVIDER_LIVE_TESTS=1 DROPBOX_TEST_TOKEN=... pnpm test
 */
for (const adapter of adapters) {
	const token =
		process.env.PROVIDER_LIVE_TESTS === '1' ? (process.env[adapter.liveToken] ?? '') : '';
	if (token === '') continue;
	describeProviderContract(
		`${adapter.name} (live account)`,
		() => {
			const provider = adapter.create({
				fetch: globalThis.fetch.bind(globalThis),
				getAccessToken: () => Promise.resolve(token),
				appVersion: '0.1.0',
				clientId: 'live-test',
			});
			return {
				provider,
				cleanup: async () => {
					const entries = await provider.list('');
					await Promise.all(entries.map((entry) => provider.delete(entry)));
					await adapter.settle?.(provider);
				},
			};
		},
		adapter.live
	);
}
