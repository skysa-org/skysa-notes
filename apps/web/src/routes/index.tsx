import { APP_FOLDER_NAME } from '@skysa/core';
import { createFileRoute } from '@tanstack/react-router';

const Home = () => (
	<main className="shell">
		<h1>skysa-notes</h1>
		<p>
			Local-first markdown notes. Your notes sync to a folder named{' '}
			<code>{APP_FOLDER_NAME}</code> in your own cloud storage; nothing is stored on the
			server.
		</p>
		<p className="muted">
			Scaffold only — the note store and editor arrive in Phase 1 (see{' '}
			<code>docs/PLAN.md</code>).
		</p>
	</main>
);

export const Route = createFileRoute('/')({
	component: Home,
});
