import { render as renderBare, type RenderResult } from '@testing-library/react';
import type { ComponentType, ReactElement, ReactNode } from 'react';

import { type Notice, NoticesProvider, NoticesTo } from '../../src/components/ui/notices.js';

/**
 * Testing Library's `render`, inside the provider a component says things
 * through (`useNotices`), as the shell draws it: without one, saying anything
 * throws. `notices` is another provider, for a test that reads what was said
 * (`hearNotices`).
 */
export const render = (
	ui: ReactElement,
	{ notices = NoticesProvider }: { notices?: ComponentType<{ children: ReactNode }> } = {}
): RenderResult => renderBare(ui, { wrapper: notices });

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
