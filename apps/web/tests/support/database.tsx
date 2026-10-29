import type { ReactNode } from 'react';

import { DatabaseProvider } from '../../src/store/database.js';
import type { NotesDatabase } from '../../src/store/db.js';

/**
 * Testing Library's options for drawing a component over a database of the
 * test's own (`freshDatabase`), as the app would hand it one: inside a
 * `DatabaseProvider`, which `rerender` keeps. A component that says anything
 * over the page is drawn with `render` from `./notices.js` instead, which
 * takes the database as `db`.
 */
export const over = (db: NotesDatabase) => ({
	wrapper: ({ children }: { children: ReactNode }) => (
		<DatabaseProvider db={db}>{children}</DatabaseProvider>
	),
});
