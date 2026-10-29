import { render as renderBare, type RenderResult } from '@testing-library/react';
import { type ComponentType, type ReactElement, type ReactNode, useEffect } from 'react';

import { type Notice, NoticesProvider, useShownNotices } from '../../src/components/ui/notices.js';

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
 * What a component drawn without the shell says over the page, in the order it
 * said it, for a test to read where the shell would show it. `Notices` is the
 * provider to draw it in.
 */
export const hearNotices = () => {
	const said: Notice[] = [];
	const Listening = () => {
		const { passing, staying } = useShownNotices();
		useEffect(() => {
			if (passing !== null) said.push(passing);
		}, [passing]);
		useEffect(() => {
			if (staying !== null) said.push(staying);
		}, [staying]);
		return null;
	};
	const Notices = ({ children }: { children: ReactNode }) => (
		<NoticesProvider>
			{children}
			<Listening />
		</NoticesProvider>
	);
	return { said, Notices };
};
