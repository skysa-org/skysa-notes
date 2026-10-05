import { MAX_CONNECT_CODE } from '@skysa/core';

/**
 * A code the operator's policy accepted at the connect gate
 * (`ConnectGate.connectCode` and `EntitlementProvider.checkCode` in
 * `@skysa/core`), held for as long as the policy said it is good, and no
 * longer.
 *
 * It has to outlive the page. Connecting leaves the app for the provider's
 * consent screen and comes back as a fresh load, and a code good for several
 * accounts that had to be typed again for each would be one the gate forgot.
 * So it is kept in `localStorage` beside the time it stops being good: closing
 * the tab or the installed app and coming back inside that time finds it, and
 * a read after it finds nothing and lets it go. It was `sessionStorage` while
 * the app could not know how long a code was good for, because a code kept for
 * later visits would have outlived what it meant; the end the policy gives is
 * what keeps that from happening now.
 *
 * It is none of the three kinds of secret (CLAUDE.md). The operator issued it
 * to the person typing it, it is worth only what their policy decides, and the
 * server carries it no further than that policy. It is not a credential to
 * anything this app holds.
 *
 * What is held may instead be what the policy gave in exchange for the code
 * (`ConnectCodeCheck.hold`): a pass for this device, kept for as long as the
 * policy says, up to a year, and renewed each time the app loads and asks
 * about it again. That is still none of the three kinds — it reaches no
 * storage and no credential — but it is a bearer to the operator's policy:
 * whoever copies it out of this browser can connect what the policy would let
 * this device connect, until the policy stops taking it. It shares the third
 * kind's exposure, then, and what keeps it is the same `script-src 'self'`. It
 * is never shown: the gate names a held value only when it is what was typed.
 *
 * Every access is guarded: a browser with storage turned off throws on the
 * property itself. The code is then held in memory instead, which is enough to
 * send it with the connect it was accepted for, and forgotten on the way back.
 */

const KEY = 'skysa.connectCode';

interface Held {
	readonly code: string;
	/** When it stops being good, by this device's clock. */
	readonly until: number;
	/** Whether it is what the person typed, and so theirs to see; not, when it is the policy's `hold`. */
	readonly shown: boolean;
}

/** Told after every change to what is held, so a gate showing it can follow. */
const watchers = new Set<() => void>();

/** Where the code is when storage is refused, and never read otherwise. */
const memory: { current: Held | undefined } = { current: undefined };

/** What was stored, if it is something this app stored: anything else is nothing. */
const parse = (raw: string | null): Held | undefined => {
	if (raw === null) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== 'object' || value === null) return undefined;
		const { code, until, shown } = value as Record<string, unknown>;
		return typeof code === 'string' &&
			code !== '' &&
			code.length <= MAX_CONNECT_CODE &&
			typeof until === 'number' &&
			Number.isFinite(until)
			? // A code kept before there were holds was typed, so it may be shown.
				{ code, until, shown: shown !== false }
			: undefined;
	} catch {
		return undefined;
	}
};

const read = (): Held | undefined => {
	try {
		return parse(globalThis.localStorage.getItem(KEY));
	} catch {
		return memory.current;
	}
};

const write = (held: Held | undefined): void => {
	memory.current = held;
	try {
		if (held === undefined) globalThis.localStorage.removeItem(KEY);
		else globalThis.localStorage.setItem(KEY, JSON.stringify(held));
	} catch {
		// Kept in memory above.
	}
	watchers.forEach((watcher) => {
		watcher();
	});
};

/** The code while it is good, and its end. One past its end is let go of as it is read. */
const current = (now: number): Held | undefined => {
	const held = read();
	if (held === undefined) return undefined;
	if (held.until > now) return held;
	write(undefined);
	return undefined;
};

export const heldConnectCode = (now = Date.now()): string | undefined => current(now)?.code;

/** When the held code stops being good, so a gate showing it can go back to asking. */
export const connectCodeHeldUntil = (now = Date.now()): number | undefined => current(now)?.until;

/** Whether what is held is what the person typed, which the gate may show; false for a `hold`. */
export const heldConnectCodeShown = (now = Date.now()): boolean => current(now)?.shown === true;

/** Calls `watcher` after every change to what is held, here; the returned function stops it. */
export const watchConnectCode = (watcher: () => void): (() => void) => {
	watchers.add(watcher);
	return () => {
		watchers.delete(watcher);
	};
};

const hold = (value: string, expiresIn: number, shown: boolean, now: number): void => {
	const code = value.trim().slice(0, MAX_CONNECT_CODE);
	write(
		code === '' || !(expiresIn > 0) ? undefined : { code, until: now + expiresIn * 1000, shown }
	);
};

/**
 * Held trimmed and bounded, as the server takes it, for `expiresIn` seconds
 * from `now`: what the policy said when it accepted it. A blank one, or one
 * good for no time at all, is none.
 */
export const holdConnectCode = (typed: string, expiresIn: number, now = Date.now()): void => {
	hold(typed, expiresIn, true, now);
};

/**
 * What the policy said, accepting `sent`, held as it said: its `hold` in place
 * of what was sent where it gave one, never shown; otherwise `sent` itself,
 * shown as it was if it is what is held already (a value asked about again as
 * the app loads) and as typed if not.
 */
export const holdAcceptedCode = (
	sent: string,
	answer: Readonly<{ expiresIn: number; hold?: string }>,
	now = Date.now()
): void => {
	if (answer.hold !== undefined) {
		hold(answer.hold, answer.expiresIn, false, now);
		return;
	}
	const held = current(now);
	hold(sent, answer.expiresIn, held?.code === sent.trim() ? held.shown : true, now);
};

export const dropConnectCode = (): void => {
	write(undefined);
};
