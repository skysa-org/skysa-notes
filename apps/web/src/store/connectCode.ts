import { MAX_CONNECT_CODE } from '@skysa/core';

/**
 * What was typed into the connect gate's code field (`ConnectGate.connectCode`
 * in `@skysa/core`), held for as long as this tab is open.
 *
 * It has to outlive the page. Connecting leaves the app for the provider's
 * consent screen and comes back as a fresh load, and a code good for several
 * accounts that had to be typed again for each would be one the field forgot.
 * So `sessionStorage`: it survives that round trip in the tab that made it and
 * goes when the tab does. Not IndexedDB, which would keep it for every later
 * visit, long after the operator's code has stopped meaning anything.
 *
 * It is none of the three kinds of secret (CLAUDE.md). The operator issued it
 * to the person typing it, it is worth only what their policy decides, and the
 * server carries it no further than that policy. It is not a credential to
 * anything this app holds.
 *
 * Every access is guarded: a browser with storage turned off throws on the
 * property itself. The code is then held in memory instead, which is enough to
 * send it with the connect it was typed for, and forgotten on the way back.
 */

const KEY = 'skysa.connectCode';

/** Where the code is when storage is refused, and never read otherwise. */
const memory: { current: string | undefined } = { current: undefined };

const nonBlank = (code: string | null | undefined): string | undefined => {
	const trimmed = code?.trim();
	return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

export const heldConnectCode = (): string | undefined => {
	try {
		return nonBlank(globalThis.sessionStorage.getItem(KEY));
	} catch {
		return nonBlank(memory.current);
	}
};

/** Kept as typed, up to the bound. A blank one is dropped. */
export const holdConnectCode = (typed: string): void => {
	const code = nonBlank(typed) === undefined ? undefined : typed.slice(0, MAX_CONNECT_CODE);
	memory.current = code;
	try {
		if (code === undefined) globalThis.sessionStorage.removeItem(KEY);
		else globalThis.sessionStorage.setItem(KEY, code);
	} catch {
		// Kept in memory above.
	}
};

export const dropConnectCode = (): void => {
	holdConnectCode('');
};
