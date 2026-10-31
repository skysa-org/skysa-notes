import { $ctx } from '@milkdown/kit/utils';

/**
 * What the editors ask of the app about secrets (docs/ARCHITECTURE.md §7,
 * "Secrets in a note").
 *
 * The editor deals only in a secret's armor and its words: opening one and
 * sealing one are the app's, which knows the note's source, this device's
 * keys, the source's key file and the lock. So the identities never reach
 * the editor at all, and a node view that outlives an unlock holds nothing
 * that unlock let out but the words it was shown. What it seals with holds
 * the recipient, the key's public half, and nothing else.
 *
 * A Milkdown ctx slice, as the files' host is (`attachHost.ts`), since what
 * needs it — the node views, the commands — is built by Milkdown.
 */

/**
 * Words sealed to the source's key, then and there: what a panel's words are
 * kept by, as they are typed. It throws where they cannot be.
 */
export type Sealer = (words: string) => string;

/** What opening a secret came to. */
export type Opened =
	/** Its words, and how what they become is sealed again. */
	| Readonly<{ state: 'opened'; words: string; seal: Sealer }>
	/** The user did not unlock the device, it holds no key for the source, or it locked meanwhile. */
	| Readonly<{ state: 'locked' }>
	/** None of this device's keys opens it: it was made with a different key. */
	| Readonly<{ state: 'other' }>
	/** It opens to something that is not text, or is not one this app can read. */
	| Readonly<{ state: 'unreadable' }>;

export interface SecretHost {
	/**
	 * How a new secret is sealed here, where one can be made now: the device
	 * enrolled, not unlocked. Where not, none, the user told why.
	 */
	readonly begin: () => Promise<Sealer | undefined>;
	/** A secret's words, unlocking the device first where it is locked. */
	readonly open: (armor: string) => Promise<Opened>;
	/** Words on the system clipboard, and nowhere else, answering whether they went. */
	readonly copy: (words: string) => Promise<boolean>;
	/**
	 * The key a secret none of this device's keys opens was made with, asked
	 * for and kept on this device beside the source's own ("Add its key"),
	 * answering whether it was.
	 */
	readonly addKey: (armor: string) => Promise<boolean>;
	/**
	 * Called when this tab locks the note's source: every revealed secret is
	 * closed. Returns the way to stop.
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
	begin: () => Promise.resolve(undefined),
	open: () => Promise.resolve({ state: 'locked' }),
	copy: () => Promise.resolve(false),
	addKey: () => Promise.resolve(false),
	locked: () => () => undefined,
	receive: () => () => undefined,
};

export const secretHostCtx = $ctx<SecretHost, 'skysaSecretHost'>(NO_SECRETS, 'skysaSecretHost');
