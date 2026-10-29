import { createRootRoute, Outlet } from '@tanstack/react-router';

import { useFileDropGuard } from '../components/clipboard/useFileDropGuard';
import { ErrorScreen } from '../components/shell/ErrorScreen';
import { UpdatePrompt } from '../components/shell/UpdatePrompt';

const RootLayout = () => {
	useFileDropGuard();
	return (
		<div className="app">
			<Outlet />
			<UpdatePrompt />
		</div>
	);
};

export const Route = createRootRoute({
	component: RootLayout,
	// The last boundary there is: a route without one of its own lands here, and
	// so does anything the layout itself throws.
	errorComponent: ErrorScreen,
});
