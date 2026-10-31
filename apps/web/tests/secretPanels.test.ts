import { describe, expect, it, vi } from 'vitest';

import { NO_SECRETS } from '../src/editor/features/secrets/secretHost.js';
import { createSecretPanel } from '../src/editor/features/secrets/secretPanel.js';
import {
	createSecretPanels,
	type NotRevealed,
	revealControl,
	type SecretDocument,
	secretSession,
} from '../src/editor/features/secrets/secretPanels.js';
import { t } from '../src/i18n/t.js';

/**
 * What both editors share of a secret, on its own: what `secretBlock.test.ts`
 * and `secretRaw.test.tsx` cannot see through an editor.
 */

const noop = (): void => undefined;

describe('secretSession', () => {
	it('lets go of every panel as it ends, and the words with them', () => {
		const panels = createSecretPanels();
		const panel = createSecretPanel({
			words: 'the words',
			label: '',
			onInput: noop,
			onLabel: noop,
			onDone: noop,
			onCancel: noop,
			onCopy: () => Promise.resolve(true),
		});
		panels.set('armor', { panel, from: 'armor', fromLabel: '', seal: () => 'sealed' });
		// Nothing asks anything of the document as it ends.
		const end = secretSession({}, {} as SecretDocument, NO_SECRETS, panels);

		end();

		expect(panels.all()).toEqual([]);
	});
});

describe('revealControl', () => {
	/** A control whose press waits to be answered, and how to answer it. */
	const control = (gone?: () => boolean) => {
		const answers: ((why: NotRevealed | undefined) => void)[] = [];
		const into = document.createElement('div');
		const { press } = revealControl({
			into,
			host: NO_SECRETS,
			armor: () => 'armor',
			press: () =>
				new Promise((resolve) => {
					answers.push(resolve);
				}),
			...(gone === undefined ? {} : { gone }),
		});
		const answer = async (why: NotRevealed | undefined) => {
			answers.shift()?.(why);
			await vi.waitFor(() => {
				expect(into.querySelector('.secret-reveal')?.hasAttribute('disabled')).toBe(false);
			});
		};
		return { into, press, answer };
	};
	const addKey = (into: HTMLElement) => into.querySelector('.secret-add-key');
	const said = (into: HTMLElement) => into.querySelector('.secret-note')?.textContent;

	it('offers its key for a secret made with another, and takes both back on the next press', async () => {
		const { into, press, answer } = control();
		press();
		await answer('other');
		expect(said(into)).toBe(t('editor.secret.differentKey'));
		expect(addKey(into)).not.toBeNull();

		press();

		expect(said(into)).toBe('');
		expect(addKey(into)).toBeNull();
		await answer(undefined);
	});

	it('asks for the key of the secret that was pressed, if a pull has changed it since', async () => {
		const addKeyFor = vi.fn(() => Promise.resolve(false));
		const answers: ((why: NotRevealed | undefined) => void)[] = [];
		const armor = { current: 'pressed' };
		const into = document.createElement('div');
		const { press } = revealControl({
			into,
			host: { ...NO_SECRETS, addKey: addKeyFor },
			armor: () => armor.current,
			press: () =>
				new Promise((resolve) => {
					answers.push(resolve);
				}),
		});
		press();
		armor.current = 'pulled';

		answers.shift()?.('other');
		const button = await vi.waitFor(() => {
			const found = addKey(into);
			if (!(found instanceof HTMLElement)) throw new Error('no Add its key yet');
			return found;
		});
		button.click();

		expect(addKeyFor).toHaveBeenCalledWith('pressed');
	});

	it('offers no key once its block has gone', async () => {
		const { into, press, answer } = control(() => true);
		press();
		await answer('other');

		expect(addKey(into)).toBeNull();
	});
});
