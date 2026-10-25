import type { FakeProvider } from '../../../src/providers/fake.js';
import type { RemoteEntry } from '../../../src/providers/types.js';

/** What the remote holds at a path, if anything. */
export const remoteAt = (provider: FakeProvider, path: string): RemoteEntry | undefined =>
	provider.snapshot().find((entry) => entry.path === path);

/** What the remote holds at a path, for a test that cannot go on without it. */
export const entryAt = (provider: FakeProvider, path: string): RemoteEntry => {
	const found = remoteAt(provider, path);
	if (found === undefined) throw new Error(`nothing on the remote at ${path}`);
	return found;
};
