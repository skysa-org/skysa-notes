import { createDropboxProvider } from '../../src/providers/dropbox.js';
import { createFakeProvider } from '../../src/providers/fake.js';
import { createOneDriveProvider } from '../../src/providers/onedrive.js';
import { describeProviderContract } from './contract.js';
import { createDropboxStub } from './dropboxStub.js';
import { createOneDriveStub } from './onedriveStub.js';

/**
 * The registry CLAUDE.md names: every provider adapter is registered here and
 * runs the same scenarios. Adapters that talk to a real account register a
 * second time behind `PROVIDER_LIVE_TESTS=1`, so CI stays offline.
 */

describeProviderContract('in-memory fake', () => ({ provider: createFakeProvider() }));

// The fake's own change feed is coalescing-free and paginates one entry at a
// time here, which is the weakest feed any real provider gives. An adapter that
// passes this also passes against a friendlier one.
describeProviderContract('in-memory fake, one entry per page', () => ({
	provider: createFakeProvider({ pageSize: 1 }),
}));

describeProviderContract('in-memory fake, provider reports whole subtrees', () => ({
	provider: createFakeProvider({ folderChanges: 'recursive' }),
}));

// One entry per page, so the adapter's `has_more` loops — in `list` and in
// `changes` — are walked rather than assumed.
describeProviderContract('dropbox over a stubbed transport, one entry per page', () => {
	const stub = createDropboxStub({ pageSize: 1 });
	return {
		provider: createDropboxProvider({
			fetch: stub.fetch,
			getAccessToken: () => Promise.resolve('stub-token'),
			appVersion: '0.1.0',
			clientId: 'stub-client',
		}),
	};
});

describeProviderContract('dropbox over a stubbed transport', () => {
	const stub = createDropboxStub();
	return {
		provider: createDropboxProvider({
			fetch: stub.fetch,
			getAccessToken: () => Promise.resolve('stub-token'),
			appVersion: '0.1.0',
			clientId: 'stub-client',
		}),
	};
});

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
	};
});

/**
 * The same scenarios against a real Dropbox account. Skipped unless asked for,
 * because it needs an app registration and a throwaway account — it empties the
 * app folder between scenarios. See docs/PLAN.md §5.3.
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
		{ timeout: 30_000 }
	);
}

/**
 * The same scenarios against a real OneDrive account, with a Graph access token
 * carrying `Files.ReadWrite.AppFolder`. Empties the app folder between
 * scenarios, so use a throwaway account. See docs/PLAN.md §5.2.
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
