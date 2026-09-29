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
 * Every access is guarded: a browser with storage turned off throws on the
 * property itself. The code is then held in memory instead, which is enough to
 * send it with the connect it was accepted for, and forgotten on the way back.
 */

const KEY = 'skysa.connectCode';

interface Held {
	readonly code: string;
	/** When it stops being good, by this device's clock. */
	readonly until: number;
}

/** Where the code is when storage is refused, and never read otherwise. */
const memory: { current: Held | undefined } = { current: undefined };

/** What was stored, if it is something this app stored: anything else is nothing. */
const parse = (raw: string | null): Held | undefined => {
	if (raw === null) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== 'object' || value === null) return undefined;
		const { code, until } = value as Record<string, unknown>;
		return typeof code === 'string' &&
			code !== '' &&
			code.length <= MAX_CONNECT_CODE &&
			typeof until === 'number' &&
			Number.isFinite(until)
			? { code, until }
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

/**
 * Held trimmed and bounded, as the server takes it, for `expiresIn` seconds
 * from `now`: what the policy said when it accepted it. A blank one, or one
 * good for no time at all, is none.
 */
export const holdConnectCode = (typed: string, expiresIn: number, now = Date.now()): void => {
	const code = typed.trim().slice(0, MAX_CONNECT_CODE);
	write(code === '' || !(expiresIn > 0) ? undefined : { code, until: now + expiresIn * 1000 });
};

export const dropConnectCode = (): void => {
	write(undefined);
};
