/**
 * Installing the app from the page (docs/ARCHITECTURE.md §8, "Installing from
 * the browser"): what the browser has said about it, kept from the moment the
 * page loads, for the banner that offers it (`InstallBanner.tsx`).
 *
 * Chromium alone says, with `beforeinstallprompt`: the app can be installed
 * now, and here is the prompt to do it with. The event comes once, whenever
 * Chromium decides, which can be before any component that would listen has
 * mounted, so the listener is put on as `main.tsx` loads and holds the event
 * until the banner asks. Its default — Chromium's own install bubble — is
 * prevented, so the banner is the one way it is offered.
 * https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent
 *
 * Its `prompt()` may be called once. After an answer the event is spent, and
 * Chromium sends a fresh one when it would offer the install again.
 */

/** Chromium's install event, which TypeScript's DOM types do not have. */
export interface InstallPromptEvent extends Event {
	readonly prompt: () => Promise<unknown>;
	readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** What the browser has said: nothing, that it can install now, or that it has. */
export type InstallState =
	| Readonly<{ kind: 'none' }>
	| Readonly<{ kind: 'ready'; install: () => Promise<'accepted' | 'dismissed'> }>
	| Readonly<{ kind: 'installed' }>;

export interface InstallPrompt {
	readonly state: () => InstallState;
	readonly subscribe: (changed: () => void) => () => void;
}

const NONE: InstallState = { kind: 'none' };
const INSTALLED: InstallState = { kind: 'installed' };

const isInstallPrompt = (event: Event): event is InstallPromptEvent =>
	'prompt' in event && typeof event.prompt === 'function' && 'userChoice' in event;

export const createInstallPrompt = (target: EventTarget | undefined): InstallPrompt => {
	const current = new Map<'state', InstallState>([['state', NONE]]);
	const listeners = new Set<() => void>();
	const become = (next: InstallState) => {
		current.set('state', next);
		listeners.forEach((changed) => {
			changed();
		});
	};

	target?.addEventListener('beforeinstallprompt', (event) => {
		if (!isInstallPrompt(event)) return;
		event.preventDefault();
		const install = async () => {
			// Spent from the moment it is asked, whatever the answer.
			become(NONE);
			await event.prompt();
			const { outcome } = await event.userChoice;
			if (outcome === 'accepted') become(INSTALLED);
			return outcome;
		};
		become({ kind: 'ready', install });
	});
	target?.addEventListener('appinstalled', () => {
		become(INSTALLED);
	});

	return {
		state: () => current.get('state') ?? NONE,
		subscribe: (changed) => {
			listeners.add(changed);
			return () => {
				listeners.delete(changed);
			};
		},
	};
};

/** The page's own, listening from the moment `main.tsx` imports it. */
export const installPrompt = createInstallPrompt(
	typeof window === 'undefined' ? undefined : window
);
