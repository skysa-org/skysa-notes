/**
 * Cache Storage, as much of it as the share target uses: neither jsdom nor
 * Node has one. Keys are resolved against `origin`, as a page or a worker there
 * resolves a relative one, and each match is a fresh copy, as the real one's
 * is.
 */
export const fakeCaches = (origin = 'https://notes.example/') => {
	const stores = new Map<string, Map<string, Response>>();
	const urlOf = (key: RequestInfo | URL): string =>
		new URL(key instanceof Request ? key.url : String(key), origin).href;
	const open = (name: string) => {
		const store = stores.get(name) ?? new Map<string, Response>();
		stores.set(name, store);
		return {
			put: async (key: RequestInfo | URL, response: Response) => {
				// Read whole now, as the real one does before `put` settles.
				const bytes = await response.arrayBuffer();
				store.set(urlOf(key), new Response(bytes, { headers: response.headers }));
			},
			match: (key: RequestInfo | URL) => Promise.resolve(store.get(urlOf(key))?.clone()),
			keys: () => Promise.resolve([...store.keys()].map((url) => new Request(url))),
			delete: (key: RequestInfo | URL) => Promise.resolve(store.delete(urlOf(key))),
		};
	};
	const storage = { open: (name: string) => Promise.resolve(open(name)) };
	/** Every URL kept under `name`, sorted. */
	const urls = (name: string): string[] => [...(stores.get(name)?.keys() ?? [])].sort();
	return { storage: storage as unknown as CacheStorage, urls, stores };
};
