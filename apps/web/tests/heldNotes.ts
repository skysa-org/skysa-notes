/**
 * Another tab's write on the notes that does not finish until it is let go:
 * how a frozen tab held a phone's reads up (2026-10-10). Every read of the
 * notes made meanwhile waits behind it, as it did there.
 */
export const holdTheNotes = async (name: string): Promise<() => void> => {
	const other = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onsuccess = () => {
			resolve(request.result);
		};
		request.onerror = () => {
			reject(request.error ?? new Error('open failed'));
		};
	});
	const store = other.transaction('notes', 'readwrite').objectStore('notes');
	const held = { going: true };
	const again = () => {
		if (held.going) store.count().onsuccess = again;
	};
	again();
	return () => {
		held.going = false;
		other.close();
	};
};
