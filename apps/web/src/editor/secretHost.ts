import { $ctx } from '@milkdown/kit/utils';

/**
 * What the editors ask of the app about secrets (docs/ARCHITECTURE.md §7,
 * "Secrets in a note").
 *
 * The editor deals only in a secret's armor and its words: opening one and
 * sealing one are the app's, which knows the note's source, this device's
 * keys, the source's key file and the lock. So the identities never reach
 * the editor at all, and a node view that outlives an unlock holds nothing
 * that unlock let out but the words it was shown.
 *
 * A Milkdown ctx slice, as the files' host is (`attachHost.ts`), since what
 * needs it — the node views, the commands — is built by Milkdown.
 */

/** What opening a secret came to. */
export type Opened =
	| Readonly<{ state: 'opened'; words: string }>
	/** The user did not unlock the device, or it holds no key for the source. */
	| Readonly<{ state: 'locked' }>
	/** None of this device's keys opens it: it was made with a different key. */
	| Readonly<{ state: 'other' }>
	/** It opens to something that is not text, or is not one this app can read. */
	| Readonly<{ state: 'unreadable' }>;

/** What sealing words came to. */
export type Sealed =
	| Readonly<{ state: 'sealed'; armor: string }>
	/** Why nothing can be sealed here: said to the user by the host already. */
	| Readonly<{ state: 'refused' }>;

export interface SecretHost {
	/** Whether a secret can be made here now, telling the user why not where it cannot. */
	readonly sealable: () => Promise<boolean>;
	/** A secret's words, unlocking the device first where it is locked. */
	readonly open: (armor: string) => Promise<Opened>;
	/** `words`, sealed to the source's key: the device need not be unlocked. */
	readonly seal: (words: string) => Promise<Sealed>;
	/** Words on the system clipboard, and nowhere else, answering whether they went. */
	readonly copy: (words: string) => Promise<boolean>;
	/**
	 * Called when this tab locks the note's source: a revealed secret is
	 * sealed where it was edited, and closed. Returns the way to stop.
	 */
	readonly locked: (listener: () => void) => () => void;
	/**
	 * Offer this editor as where the palette's "Insert secret" goes. The one
	 * open now offers itself; the returned function takes it back.
	 */
	readonly receive: (insert: () => void) => () => void;
}

/** The host of an editor nobody gave one: it makes and opens no secrets. */
export const NO_SECRETS: SecretHost = {
	sealable: () => Promise.resolve(false),
	open: () => Promise.resolve({ state: 'locked' }),
	seal: () => Promise.resolve({ state: 'refused' }),
	copy: () => Promise.resolve(false),
	locked: () => () => undefined,
	receive: () => () => undefined,
};

export const secretHostCtx = $ctx<SecretHost, 'skysaSecretHost'>(NO_SECRETS, 'skysaSecretHost');
