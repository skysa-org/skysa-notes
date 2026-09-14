import { createRootRoute, Outlet } from '@tanstack/react-router';

import { UpdatePrompt } from '../components/UpdatePrompt';

const RootLayout = () => (
	<div className="app">
		<Outlet />
		<UpdatePrompt />
	</div>
);

export const Route = createRootRoute({
	component: RootLayout,
});
