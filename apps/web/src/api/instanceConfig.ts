import { useEffect, useState } from 'react';

import type { ApiClient, InstanceConfig } from './client.js';

/** A server answer: still being asked, not reachable, or what it said. */
export type Asked<T> =
	{ kind: 'asking' } | { kind: 'unreachable' } | { kind: 'answered'; value: T };

export const answer = <T>(asked: Asked<T>): T | undefined =>
	asked.kind === 'answered' ? asked.value : undefined;

type Asking = Pick<ApiClient, 'config'>;

/**
 * One `/api/config` request per client, however many components want it.
 *
 * `/api/*` is `NetworkOnly` in the service worker and must stay that way —
 * binding follows what the server says and a cached answer is how a device
 * ends up acting on a connection that has gone (docs/ARCHITECTURE.md, Phase 2). So
 * nothing below us de-duplicates this, and two components each asking on mount
 * really are two round trips on every open.
 *
 * Keyed by the client rather than held in a single module-level slot, because
 * a slot would be shared between tests: each test builds its own client, and
 * the second one would be answered with the first one's config — or, worse,
 * with a promise made against a `fetch` that test has since torn down. A
 * `WeakMap` also lets the entry go when the client does.
 *
 * Deliberately not a retry. A config that could not be fetched leaves the app
 * working with what it already knows, and the next reload asks again; a hook
 * that retried on a timer would put a request loop behind every render of a
 * page the user may simply be reading offline.
 */
const asked = new WeakMap<Asking, Promise<InstanceConfig>>();

const configFor = (client: Asking): Promise<InstanceConfig> => {
	const already = asked.get(client);
	if (already !== undefined) return already;
	const asking = client.config();
	asked.set(client, asking);
	// A failure is not worth remembering: left in the map, one flight of
	// aeroplane mode would answer `unreachable` for the life of the tab.
	void asking.catch(() => {
		asked.delete(client);
	});
	return asking;
};

export const useInstanceConfig = (client: Asking): Asked<InstanceConfig> => {
	const [state, setState] = useState<Asked<InstanceConfig>>({ kind: 'asking' });

	useEffect(() => {
		// Each run's own: the component can go while the request is out, and
		// answering into one that has is a leak; and a new client's run must not
		// be answered by the old one's request settling late. A flag shared by
		// every run — the ref this used to be — is set again by the next run as
		// soon as the last is cleaned up, so it guarded the first and not the
		// second.
		const gone = new AbortController();
		void configFor(client)
			.then((value) => {
				if (!gone.signal.aborted) setState({ kind: 'answered', value });
			})
			.catch(() => {
				if (!gone.signal.aborted) setState({ kind: 'unreachable' });
			});
		return () => {
			gone.abort();
		};
	}, [client]);

	return state;
};
