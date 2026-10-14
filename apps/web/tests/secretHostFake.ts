import { secretBlocksIn } from '@skysa/core';
import { vi } from 'vitest';

import type { SecretHost } from '../src/editor/secretHost.js';
import {
	generateIdentity,
	openSecret,
	parseRecipient,
	recipientOf,
	sealSecret,
} from '../src/secrets/age.js';

/**
 * A secret host over one key, for the editors' tests (`secretBlock.test.ts`,
 * `secretRaw.test.tsx`): it opens what it made, and is told when to lock.
 */

export const identity = generateIdentity();
const recipient = parseRecipient(recipientOf(identity));

export const sealed = (words: string): string => {
	if (recipient === undefined) throw new Error('not a recipient');
	return sealSecret(words, recipient);
};

/** Words sealed to a key the host does not have. */
export const sealedForAnother = (words: string): string => {
	const theirs = parseRecipient(recipientOf(generateIdentity()));
	if (theirs === undefined) throw new Error('not a recipient');
	return sealSecret(words, theirs);
};

export const fence = (armor: string) => `\`\`\`age\n${armor}\n\`\`\``;

/** The words each secret in `markdown` opens to, in order: at any depth, as remark finds them. */
export const openedIn = (markdown: string) =>
	secretBlocksIn(markdown).map((text) => openSecret(text, [identity]));

/**
 * A host over one key, which opens what it made, and is told when to lock.
 * `seal` is what every panel it opens or begins seals with.
 */
export const fakeHost = (sealable = true) => {
	const locks = new Set<() => void>();
	const receiving = { current: (): void => undefined };
	const seal = vi.fn(sealed);
	const host: SecretHost = {
		begin: vi.fn(() => Promise.resolve(sealable ? seal : undefined)),
		open: vi.fn((armor: string) => {
			try {
				const words = openSecret(armor, [identity]);
				return Promise.resolve({ state: 'opened' as const, words, seal });
			} catch {
				return Promise.resolve({ state: 'other' as const });
			}
		}),
		copy: vi.fn(() => Promise.resolve(true)),
		addKey: vi.fn(() => Promise.resolve(false)),
		locked: (listener) => {
			locks.add(listener);
			return () => {
				locks.delete(listener);
			};
		},
		receive: (insert) => {
			receiving.current = insert;
			return () => {
				receiving.current = () => undefined;
			};
		},
	};
	return {
		host,
		seal,
		lock: () => {
			locks.forEach((listener) => {
				listener();
			});
		},
		insert: () => {
			receiving.current();
		},
	};
};
