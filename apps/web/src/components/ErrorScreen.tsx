import type { ErrorComponentProps } from '@tanstack/react-router';

import { t } from '../i18n/t.js';

/**
 * What is shown when rendering throws — a live query the store refused (quota,
 * an IndexedDB upgrade blocked by another tab), an editor that could not draw a
 * note. Without it the router's own fallback replaces the whole app with an
 * unstyled "Something went wrong!" and no way out but the address bar.
 *
 * What it says about the notes is the part that matters to somebody watching
 * their app disappear, and it is true of anything that can land here: a render
 * error writes nothing, the notes are rows in IndexedDB that outlive the page,
 * and an edit still waiting on autosave is flushed as the editor unmounts.
 *
 * The message and never the stack. Nothing in this app puts a credential in an
 * error message, and this is not the place that would find out if something
 * did: it is kept folded away, and nothing here logs or sends it anywhere.
 */
export const ErrorScreen = ({ error, reset }: ErrorComponentProps) => {
	// `throw` takes anything, and a boundary is the one place that must not
	// throw over what it was handed.
	const message = error instanceof Error ? error.message : String(error);

	return (
		<main className="error-screen" role="alert">
			<h1>{t('shell.error.title')}</h1>
			<p>{t('shell.error.text')}</p>
			<div className="error-actions">
				{/* Renders the same screen again, which is enough when what failed has
			    since passed — the other tab closed, the space freed. */}
				<button type="button" onClick={reset}>
					{t('common.tryAgain')}
				</button>
				<button
					type="button"
					onClick={() => {
						window.location.reload();
					}}
				>
					{t('common.reload')}
				</button>
			</div>
			{message !== '' && (
				<details>
					<summary>{t('shell.error.details')}</summary>
					<pre>{message}</pre>
				</details>
			)}
		</main>
	);
};
