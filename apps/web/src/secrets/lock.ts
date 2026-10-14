import { type UnlockedKeys } from '../store/secretKeys.js';

/**
 * Which sources this tab holds unlocked for secrets, and their keys
 * (docs/ARCHITECTURE.md §7, "Secrets in a note"). In memory and per tab: each
 * tab unlocks and locks for itself.
 *
 * Locking fills the identities with zeros and lets go of them, and of the key
 * they were sealed under. A tab locks when its page is hidden, unless the app
 * hid it with a prompt of its own (`prompting`): the device's lock, or Print.
 * And it locks after `idleMs` with no key, pointer, touch or scroll in it. It
 * listens for those only while something is unlocked.
 *
 * A revealed secret's panel hears the lock (`subscribe`) and closes, sealing an
 * edit first, which takes only the recipient: no edit is lost to it.
 */

/** The page, as the lock needs it: whether it is hidden, and its events. */
export interface LockTarget {
	readonly visibilityState: DocumentVisibilityState;
	readonly addEventListener: (
		type: string,
		listener: () => void,
		options?: AddEventListenerOptions
	) => void;
	readonly removeEventListener: (
		type: string,
		listener: () => void,
		options?: EventListenerOptions
	) => void;
}

export interface SecretsLockOptions {
	readonly target: LockTarget;
	/** How long with nothing done in the page before it locks. */
	readonly idleMs?: number;
	readonly now?: () => number;
}

export interface SecretsLock {
	/** The keys this tab holds for a source, while it is unlocked. */
	readonly keys: (connectionId: string) => UnlockedKeys | undefined;
	readonly isUnlocked: (connectionId: string) => boolean;
	/** Hold the keys a source was just unlocked or enrolled with, until the tab locks. */
	readonly hold: (keys: UnlockedKeys) => void;
	/** Lock one source, or every one. */
	readonly lock: (connectionId?: string) => void;
	/** Called after every unlock and lock. Returns the way to unsubscribe. */
	readonly subscribe: (listener: () => void) => () => void;
	/** `work`, a prompt of the app's own, during which the page being hidden does not lock it. */
	readonly prompting: <T>(work: () => Promise<T>) => Promise<T>;
}

/** The owner's choice (2026-10-14). */
export const IDLE_MS = 30_000;

/** What counts as something done in the page. Heard as they start, before anything handles them. */
const ACTIVITY = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel', 'scroll'];
const HEARD: AddEventListenerOptions = { capture: true, passive: true };

const wipe = (keys: UnlockedKeys): void => {
	keys.identities.forEach((identity) => {
		identity.fill(0);
	});
};

export const createSecretsLock = (options: SecretsLockOptions): SecretsLock => {
	const { target } = options;
	const idleMs = options.idleMs ?? IDLE_MS;
	const now = options.now ?? (() => Date.now());
	const held = new Map<string, UnlockedKeys>();
	const listeners = new Set<() => void>();
	const prompts = new Map<'open', number>();
	const last = new Map<'activity', number>();
	const timer = new Map<'idle', ReturnType<typeof setTimeout>>();

	const notify = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};

	const isPrompting = () => (prompts.get('open') ?? 0) > 0;

	const stopTimer = () => {
		clearTimeout(timer.get('idle'));
		timer.delete('idle');
	};

	const lock = (connectionId?: string): void => {
		const going = [...held.keys()].filter(
			(id) => connectionId === undefined || id === connectionId
		);
		if (going.length === 0) return;
		going.forEach((id) => {
			const keys = held.get(id);
			if (keys !== undefined) wipe(keys);
			held.delete(id);
		});
		if (held.size === 0) stopListening();
		notify();
	};

	const onVisibility = () => {
		if (target.visibilityState === 'hidden' && !isPrompting()) lock();
	};

	const onActivity = () => {
		last.set('activity', now());
	};

	/** Locked once the page has been idle `idleMs`, and otherwise looked at again when it would be. */
	const check = () => {
		timer.delete('idle');
		if (held.size === 0) return;
		const idle = now() - (last.get('activity') ?? now());
		if (idle >= idleMs && !isPrompting()) {
			lock();
			return;
		}
		schedule(idle >= idleMs ? idleMs : idleMs - idle);
	};

	const schedule = (ms: number) => {
		stopTimer();
		timer.set('idle', setTimeout(check, ms));
	};

	const startListening = () => {
		target.addEventListener('visibilitychange', onVisibility);
		ACTIVITY.forEach((type) => {
			target.addEventListener(type, onActivity, HEARD);
		});
		onActivity();
		schedule(idleMs);
	};

	const stopListening = () => {
		target.removeEventListener('visibilitychange', onVisibility);
		ACTIVITY.forEach((type) => {
			target.removeEventListener(type, onActivity, HEARD);
		});
		stopTimer();
	};

	const hold = (keys: UnlockedKeys): void => {
		const before = held.get(keys.connectionId);
		if (before !== undefined && before !== keys) wipe(before);
		const first = held.size === 0;
		held.set(keys.connectionId, keys);
		if (first) startListening();
		else onActivity();
		notify();
	};

	const prompting = async <T>(work: () => Promise<T>): Promise<T> => {
		prompts.set('open', (prompts.get('open') ?? 0) + 1);
		try {
			return await work();
		} finally {
			prompts.set('open', (prompts.get('open') ?? 1) - 1);
			// Answering it was something done in the page; and a page left
			// hidden once it closed is hidden by the user, not the app.
			onActivity();
			onVisibility();
		}
	};

	return {
		keys: (connectionId) => held.get(connectionId),
		isUnlocked: (connectionId) => held.has(connectionId),
		hold,
		lock,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		prompting,
	};
};
