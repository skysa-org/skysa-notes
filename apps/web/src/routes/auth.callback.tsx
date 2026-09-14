import { createFileRoute } from '@tanstack/react-router';

/**
 * Landing route the backend redirects to after an OAuth flow completes. The
 * code exchange happens server-side; this page only reports the outcome and
 * hands control back to the app.
 */
const AuthCallback = () => {
	const { status, message } = Route.useSearch();

	return (
		<main className="shell">
			<h1>{status === 'ok' ? 'Connected' : 'Connection failed'}</h1>
			<p className="muted">
				{message ?? 'You can close this page and return to your notes.'}
			</p>
		</main>
	);
};

export const Route = createFileRoute('/auth/callback')({
	validateSearch: (search: Record<string, unknown>) => ({
		status: search.status === 'error' ? ('error' as const) : ('ok' as const),
		message: typeof search.message === 'string' ? search.message : undefined,
	}),
	component: AuthCallback,
});
