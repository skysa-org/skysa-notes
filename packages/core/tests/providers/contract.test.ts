import { createDropboxProvider } from '../../src/providers/dropbox.js';
import {
	createFakeProvider,
	type FakeProvider,
	type FakeProviderOptions,
} from '../../src/providers/fake.js';
import { createGDriveProvider } from '../../src/providers/gdrive.js';
import { createOneDriveProvider } from '../../src/providers/onedrive.js';
import { describeProviderContract } from './contract.js';
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
		backing.writeBytes(path, bytes);
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

// One entry per page, so the adapter's `has_more` loops — in `list` and in
// `changes` — are walked rather than assumed.
describeProviderContract(
	'dropbox over a stubbed transport, one entry per page',
	() => {
		const stub = createDropboxStub({ pageSize: 1 });
		return {
			provider: createDropboxProvider({
				fetch: stub.fetch,
				getAccessToken: () => Promise.resolve('stub-token'),
				appVersion: '0.1.0',
				clientId: 'stub-client',
			}),
			...beneath(stub.backing),
		};
	},
	{ staleVersion: DROPBOX_STALE_REV }
);

describeProviderContract(
	'dropbox over a stubbed transport',
	() => {
		const stub = createDropboxStub();
		return {
			provider: createDropboxProvider({
				fetch: stub.fetch,
				getAccessToken: () => Promise.resolve('stub-token'),
				appVersion: '0.1.0',
				clientId: 'stub-client',
			}),
			...beneath(stub.backing),
		};
	},
	{ staleVersion: DROPBOX_STALE_REV }
);

// Graph's feed carries no paths and does not report a renamed folder's
// contents, so the adapter keeps the tree in its cursor. One entry per page
// splits that tree across pages, which is where it is easiest to get wrong.
describeProviderContract('onedrive over a stubbed transport, one entry per page', () => {
	const stub = createOneDriveStub({ pageSize: 1 });
	return {
		provider: createOneDriveProvider({
			fetch: stub.fetch,
			getAccessToken: () => Promise.resolve('stub-token'),
			appVersion: '0.1.0',
			clientId: 'stub-client',
		}),
		...beneath(stub.backing),
	};
});

describeProviderContract('onedrive over a stubbed transport', () => {
	const stub = createOneDriveStub();
	return {
		provider: createOneDriveProvider({
			fetch: stub.fetch,
			getAccessToken: () => Promise.resolve('stub-token'),
			appVersion: '0.1.0',
			clientId: 'stub-client',
		}),
		...beneath(stub.backing),
	};
});

// Drive's feed names no paths and lists no parents, and nothing on Drive is
// conditional, so the adapter walks names, checks before and after it writes,
// and lists what arrives. One entry per page splits the scan and the feed.
describeProviderContract('gdrive over a stubbed transport, one entry per page', () => {
	const stub = createGDriveStub({ pageSize: 1 });
	return {
		provider: createGDriveProvider({
			fetch: stub.fetch,
			getAccessToken: () => Promise.resolve('stub-token'),
			appVersion: '0.1.0',
			clientId: 'stub-client',
		}),
		...beneath(stub.backing),
	};
});

describeProviderContract('gdrive over a stubbed transport', () => {
	const stub = createGDriveStub();
	return {
		provider: createGDriveProvider({
			fetch: stub.fetch,
			getAccessToken: () => Promise.resolve('stub-token'),
			appVersion: '0.1.0',
			clientId: 'stub-client',
		}),
		...beneath(stub.backing),
	};
});

/**
 * The same scenarios against a real Dropbox account. Skipped unless asked for,
 * because it needs an app registration and a throwaway account — it empties the
 * app folder between scenarios. See docs/ARCHITECTURE.md §5.3.
 *
 *   PROVIDER_LIVE_TESTS=1 DROPBOX_TEST_TOKEN=... pnpm test
 */
const liveToken =
	process.env.PROVIDER_LIVE_TESTS === '1' ? (process.env.DROPBOX_TEST_TOKEN ?? '') : '';

if (liveToken !== '') {
	describeProviderContract(
		'dropbox (live account)',
		() => {
			const provider = createDropboxProvider({
				fetch: globalThis.fetch.bind(globalThis),
				getAccessToken: () => Promise.resolve(liveToken),
				appVersion: '0.1.0',
				clientId: 'live-test',
			});
			return {
				provider,
				cleanup: async () => {
					const entries = await provider.list('');
					await Promise.all(entries.map((entry) => provider.delete(entry)));
				},
			};
		},
		{ staleVersion: DROPBOX_STALE_REV, timeout: 30_000 }
	);
}

/**
 * The same scenarios against a real OneDrive account, with a Graph access token
 * carrying `Files.ReadWrite.AppFolder`. Empties the app folder between
 * scenarios, so use a throwaway account. See docs/ARCHITECTURE.md §5.2.
 *
 *   PROVIDER_LIVE_TESTS=1 ONEDRIVE_TEST_TOKEN=... pnpm test
 */
const liveGraphToken =
	process.env.PROVIDER_LIVE_TESTS === '1' ? (process.env.ONEDRIVE_TEST_TOKEN ?? '') : '';

if (liveGraphToken !== '') {
	describeProviderContract(
		'onedrive (live account)',
		() => {
			const provider = createOneDriveProvider({
				fetch: globalThis.fetch.bind(globalThis),
				getAccessToken: () => Promise.resolve(liveGraphToken),
				appVersion: '0.1.0',
				clientId: 'live-test',
			});
			return {
				provider,
				cleanup: async () => {
					const entries = await provider.list('');
					await Promise.all(entries.map((entry) => provider.delete(entry)));
				},
			};
		},
		{ timeout: 30_000 }
	);
}

/**
 * The same scenarios against a real Google Drive account, with an access token
 * carrying `drive.file`. Empties the app folder between scenarios, so use a
 * throwaway account. See docs/ARCHITECTURE.md §5.1.
 *
 *   PROVIDER_LIVE_TESTS=1 GDRIVE_TEST_TOKEN=... pnpm test
 */
const liveGoogleToken =
	process.env.PROVIDER_LIVE_TESTS === '1' ? (process.env.GDRIVE_TEST_TOKEN ?? '') : '';

if (liveGoogleToken !== '') {
	describeProviderContract(
		'gdrive (live account)',
		() => {
			const provider = createGDriveProvider({
				fetch: globalThis.fetch.bind(globalThis),
				getAccessToken: () => Promise.resolve(liveGoogleToken),
				appVersion: '0.1.0',
				clientId: 'live-test',
			});
			return {
				provider,
				cleanup: async () => {
					const entries = await provider.list('');
					await Promise.all(entries.map((entry) => provider.delete(entry)));
					// And wait for Drive to agree that they are gone. Its search
					// index keeps listing a deleted file for a moment, and the
					// next scenario's cold-start scan then finds files whose
					// parent this cleanup has already removed — unplaceable, so
					// reported as deletions by id, in a scan that is supposed to
					// report current state and nothing else. That is this
					// harness emptying a shared folder between scenarios, not
					// something a user can do to themselves, but it fails the
					// scenario all the same.
					for (let round = 0; round < 20; round += 1) {
						if ((await provider.list('')).length === 0) return;
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
				},
			};
		},
		// Drive's change feed lags a write by a couple of seconds (measured
		// 1.4–2.8s, docs/ARCHITECTURE.md §5.1), so every read of it in the suite waits
		// first. Dropbox's and Graph's are immediate and take the default of 0.
		{ changesLagMs: 5_000, timeout: 60_000 }
	);
}
