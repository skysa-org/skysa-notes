import { type CredentialRecord, type NotesDatabase } from '../../src/store/db.js';

/**
 * The credential a bound device holds for a source (docs/ARCHITECTURE.md §6,
 * "Per-connection credentials"): without one nothing can mint a token. The
 * secret is `sk1_` and the connection's id unless the test needs another.
 */
export const holdCredential = (
	db: NotesDatabase,
	connectionId: string,
	{
		credential = `sk1_${connectionId}`,
		provider = 'dropbox',
		createdAt = 0,
	}: Partial<Omit<CredentialRecord, 'id'>> = {}
) => db.credentials.put({ id: connectionId, credential, provider, createdAt });
