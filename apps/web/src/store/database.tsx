import { createContext, Fragment, type ReactNode, useContext } from 'react';

import { db as appDb, type NotesDatabase } from './db.js';

/**
 * The database a component reads and writes (#455): the app's own, unless a
 * provider above it names another — a test's, made for it alone
 * (`freshDatabase`). Not handed down as a prop, which reached a component
 * three ways and left what it read through its own hooks the app's database
 * whatever it had been handed.
 */
const DatabaseContext = createContext<NotesDatabase>(appDb);

/**
 * What it holds is drawn afresh for another database, by its name (one name,
 * one database): a hook's answers, the rows it keeps to draw again as they
 * were (`keptRows`) and a search's index were all read from the one before,
 * and none of them is checked against which database it came from.
 */
export const DatabaseProvider = ({ db, children }: { db: NotesDatabase; children: ReactNode }) => (
	<DatabaseContext.Provider value={db}>
		<Fragment key={db.name}>{children}</Fragment>
	</DatabaseContext.Provider>
);

/** The database the component is drawn over: the app's, outside a provider. */
export const useDb = (): NotesDatabase => useContext(DatabaseContext);
