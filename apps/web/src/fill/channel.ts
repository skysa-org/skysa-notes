import { pageSite, type Site } from '@skysa/core';

import {
	BOOKMARKLET_REVISION,
	FILL_MESSAGE,
	FILL_VERSION,
	type Hello,
	helloSchema,
	messageSchema,
	type WindowMessage,
} from './protocol.js';

/**
 * The fill window's side of what it and the bookmarklet say (`protocol.ts`,
 * docs/ARCHITECTURE.md §7, "Filling in on a site", and §9).
 *
 * The page a `hello` came from is the origin the browser stamped on it,
 * never anything the page says about itself: a page cannot make the browser
 * say another origin, so it is offered only its own logins. A `hello` is
 * taken only from this window's opener, from a page on the web and not the
 * app's own, and only the first: the origin is fixed by it, and every
 * message after it is let be. A login is sent back to that origin alone, so
 * an opener that has gone on to another site since does not get it.
 *
 * Opened at the start, before anything else on the page, so the `hello` the
 * `ready` asks for cannot come before there is something to hear it.
 */

/** What the window knows of the page it is filling in. */
export type ChannelState =
	/** Asked, and not answered yet; `slow` once it has been a while. */
	| Readonly<{ state: 'waiting'; slow: boolean }>
	/** Opened by no page, or cut off from the one that opened it (`Cross-Origin-Opener-Policy`). */
	| Readonly<{ state: 'alone' }>
	/** Answered by a bookmarklet newer than the app, whose `hello` this one does not read. */
	| Readonly<{ state: 'newer' }>
	/** Answered by a bookmarklet older than any this app reads. */
	| Readonly<{ state: 'older' }>
	/** Answered: the page's origin, as the browser said it, its site, and what it said. */
	| Readonly<{
			state: 'hello';
			origin: string;
			site: Site;
			hello: Hello;
			/** By a bookmarklet that still works, of an older revision than this app's. */
			outdated: boolean;
	  }>;

/** The opener, as far as the window may reach a page of another origin. */
interface Opener {
	readonly closed?: boolean;
	readonly postMessage: (message: WindowMessage, targetOrigin: string) => void;
}

/** The window, as the channel needs it. */
export interface ChannelWindow {
	readonly opener: Opener | null;
	readonly location: Readonly<{ origin: string }>;
	readonly addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
}

export interface FillChannel {
	readonly current: () => ChannelState;
	/** Called on every change of state. Returns the way to unsubscribe. */
	readonly subscribe: (listener: () => void) => () => void;
	/** Send the login to the page, as it was when it said `hello`; whether there was one to send it to. */
	readonly fill: (login: Readonly<{ username: string; password: string }>) => boolean;
}

/** How long a `hello` takes before the window says it is waiting. It goes on listening. */
export const SLOW_MS = 3000;

export interface ChannelOptions {
	readonly slowMs?: number;
	readonly setTimer?: (run: () => void, ms: number) => unknown;
}

export const openChannel = (win: ChannelWindow, options: ChannelOptions = {}): FillChannel => {
	const { slowMs = SLOW_MS, setTimer = setTimeout } = options;
	const listeners = new Set<() => void>();
	const at: { current: ChannelState } = {
		current: win.opener === null ? { state: 'alone' } : { state: 'waiting', slow: false },
	};

	const set = (next: ChannelState) => {
		at.current = next;
		listeners.forEach((listener) => {
			listener();
		});
	};

	const hear = (event: MessageEvent) => {
		if (at.current.state !== 'waiting') return;
		if (event.source === null || event.source !== win.opener) return;
		const { origin } = event;
		const site = origin === win.location.origin ? undefined : pageSite(origin);
		if (site === undefined) return;
		const message = messageSchema.safeParse(event.data);
		if (!message.success || message.data.step !== 'hello') return;
		if (message.data.v > FILL_VERSION) {
			set({ state: 'newer' });
			return;
		}
		if (message.data.v < FILL_VERSION) {
			set({ state: 'older' });
			return;
		}
		const hello = helloSchema.safeParse(event.data);
		if (!hello.success) return;
		set({
			state: 'hello',
			origin,
			site,
			hello: hello.data,
			outdated: hello.data.b < BOOKMARKLET_REVISION,
		});
	};

	win.addEventListener('message', hear);
	if (win.opener !== null) {
		// To any origin: it says nothing but that the window is here, and whose
		// page the opener is is what the answer tells.
		win.opener.postMessage({ type: FILL_MESSAGE, v: FILL_VERSION, step: 'ready' }, '*');
		setTimer(() => {
			if (at.current.state === 'waiting') set({ state: 'waiting', slow: true });
		}, slowMs);
	}

	return {
		current: () => at.current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		fill: (login) => {
			const now = at.current;
			const opener = win.opener;
			if (now.state !== 'hello' || opener === null || opener.closed === true) return false;
			// The origin as the browser said it, not as it is read back: a page
			// whose origin ends in a dot is that origin, and no other.
			opener.postMessage(
				{
					type: FILL_MESSAGE,
					v: FILL_VERSION,
					step: 'fill',
					username: login.username,
					password: login.password,
				},
				now.origin
			);
			return true;
		},
	};
};
