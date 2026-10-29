import type { RefObject } from 'react';

import type { ReplaceScan } from '../../secrets/age.js';
import type { DeviceLock } from '../../secrets/deviceLock.js';
import type { Age } from '../../secrets/loadAge.js';
import type { SecretsLock } from '../../secrets/lock.js';
import type { NotesDatabase } from '../../store/db.js';
import type { enrolment } from '../../store/secretKeys.js';
import type { KeyFileSync } from '../../sync/keyFile.js';

export type Enrolled = NonNullable<Awaited<ReturnType<typeof enrolment>>>;

/** Why a recovery key is being typed. */
export type Purpose = 'setup' | 'enrol' | 'replaced' | 'another' | 'rekey';

/** What a new key is made for: setting the source up, or replacing its key. */
export type Making = 'setUp' | 'rekey';

export type Step =
	| Readonly<{ kind: 'show'; identity: Uint8Array; making: Making }>
	| Readonly<{
			kind: 'check';
			identity: Uint8Array;
			groups: readonly [number, number];
			making: Making;
	  }>
	| Readonly<{ kind: 'paste'; purpose: Purpose; base?: readonly Uint8Array[] }>
	| Readonly<{
			kind: 'different';
			identities: readonly Uint8Array[];
			secrets: number;
			notes: number;
	  }>
	/** Choosing how this device unlocks, then keeping the keys: `setUp` writes the key file first. */
	| Readonly<{ kind: 'choose'; identities: readonly Uint8Array[]; then: 'setUp' | 'enrol' }>
	| Readonly<{ kind: 'unlock'; then: 'device' | 'change' }>
	/** The source's new key typed, and the device locked: unlocked, to keep what it holds beside it. */
	| Readonly<{ kind: 'unlock'; then: 'replace'; identity: Uint8Array }>
	/** Replacing the source's key, and the device locked: unlocked, to begin, or to go on with the key chosen. */
	| Readonly<{ kind: 'unlock'; then: 'rekey'; identity?: Uint8Array }>
	| Readonly<{ kind: 'change' }>
	/** Replacing the source's key: what it does, and the two ways to begin. */
	| Readonly<{ kind: 'rekey' }>
	/** The new key chosen, and what replacing the key with it will do, said before it is done. */
	| Readonly<{ kind: 'rekeyReady'; identity: Uint8Array; scan: ReplaceScan }>
	| Readonly<{ kind: 'remove' }>
	| Readonly<{ kind: 'done'; said: string }>;

/** Where the dialog is when no flow is under way, as a step or a state to say. */
export type Home =
	Step | 'checking' | 'unavailable' | 'intro' | 'newer' | 'invalid' | 'device' | 'lost';

export interface SecretsDialogProps {
	database: NotesDatabase;
	connectionId: string;
	/** What the source is called: printed above its key, and in the name of a passkey made for it. */
	sourceName: string;
	keyFile: Pick<KeyFileSync, 'refresh' | 'write'>;
	lock: SecretsLock;
	onClose: () => void;
	returnFocus?: RefObject<HTMLElement | null>;
	/** PBKDF2's rounds; fewer in a test, where the full count takes most of a second. */
	rounds?: number;
	age?: () => Promise<Age>;
	/** Which two groups of a new key are asked back, counted from 0. */
	pickGroups?: () => readonly [number, number];
	print?: () => Promise<void>;
	copy?: (text: string) => Promise<void>;
	/** The device's own lock, offered where it can keep a key (`secrets/deviceLock.ts`). */
	deviceLock?: DeviceLock;
}
