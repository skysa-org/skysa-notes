import { createContext, type ReactNode, useContext } from 'react';

import { db as appDb, type NotesDatabase } from './db.js';

/**
 * The database a component reads and writes (#455): the app's own, unless a
 * provider above it names another — a test's, made for it alone
 * (`freshDatabase`). Not handed down as a prop, which reached a component
 * three ways and left what it read through its own hooks the app's database
 * whatever it had been handed.
 */
const DatabaseContext = createContext<NotesDatabase>(appDb);

export const DatabaseProvider = ({ db, children }: { db: NotesDatabase; children: ReactNode }) => (
	<DatabaseContext.Provider value={db}>{children}</DatabaseContext.Provider>
);

/** The database the component is drawn over: the app's, outside a provider. */
export const useDb = (): NotesDatabase => useContext(DatabaseContext);
