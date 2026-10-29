import { render as renderBare, type RenderResult } from '@testing-library/react';
import type { ComponentType, ReactElement, ReactNode } from 'react';

import { type Notice, NoticesProvider, NoticesTo } from '../../src/components/ui/notices.js';
import { DatabaseProvider } from '../../src/store/database.js';
import type { NotesDatabase } from '../../src/store/db.js';

/**
 * Testing Library's `render`, inside the provider a component says things
 * through (`useNotices`), as the shell draws it: without one, saying anything
 * throws. `notices` is another provider, for a test that reads what was said
 * (`hearNotices`); `db` a database of the test's own, which the component is
 * drawn over (`DatabaseProvider`).
 */
export const render = (
	ui: ReactElement,
	{
		notices: Notices = NoticesProvider,
		db,
	}: { notices?: ComponentType<{ children: ReactNode }>; db?: NotesDatabase } = {}
): RenderResult =>
	renderBare(ui, {
		wrapper: ({ children }: { children: ReactNode }) =>
			db === undefined ? (
				<Notices>{children}</Notices>
			) : (
				<DatabaseProvider db={db}>
					<Notices>{children}</Notices>
				</DatabaseProvider>
			),
	});

/**
 * What a component drawn without the shell says over the page, said or kept,
 * each time it says it and in that order, for a test to read where the shell
 * would show it. `Notices` is the provider to draw it in.
 */
export const hearNotices = () => {
	const said: Notice[] = [];
	const hear = (notice: Notice) => {
		said.push(notice);
	};
	const heard = { say: hear, keep: hear, moveOn: () => undefined };
	const Notices = ({ children }: { children: ReactNode }) => (
		<NoticesTo notices={heard}>{children}</NoticesTo>
	);
	return { said, Notices };
};
