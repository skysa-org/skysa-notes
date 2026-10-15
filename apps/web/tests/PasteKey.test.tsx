import { encodeIdentity, recoveryKeyGroups } from '@skysa/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PasteKey, typedIn } from '../src/components/PasteKey.js';
import type { Scanner } from '../src/components/ScanKey.js';
import { generateIdentity } from '../src/secrets/age.js';

/**
 * A recovery key typed back in its twelve groups, as it is shown and printed:
 * each group goes on to the next as it fills, and a key pasted whole fills
 * them all.
 */

afterEach(() => {
	cleanup();
});

const EMPTY: readonly string[] = Array.from({ length: 12 }, () => '');

describe('typing into a group', () => {
	it('goes on to the next group once one is full', () => {
		expect(typedIn(EMPTY, 0, 'abcd')).toEqual({
			groups: ['ABCD', ...EMPTY.slice(1)],
			focus: 0,
		});
		expect(typedIn(EMPTY, 0, 'ab-cd e')).toEqual({
			groups: ['ABCDE', ...EMPTY.slice(1)],
			focus: 1,
		});
	});

	it('takes more than a group holds on into the ones after it', () => {
		const typed = typedIn(EMPTY, 1, 'ABCDEFGHIJK');
		expect(typed.groups.slice(0, 5)).toEqual(['', 'ABCDE', 'FGHIJ', 'K', '']);
		expect(typed.focus).toBe(3);
	});

	it('holds three in the last group, and stays there once it is full', () => {
		expect(typedIn(EMPTY, 11, 'XYZW')).toEqual({
			groups: [...EMPTY.slice(0, 11), 'XYZ'],
			focus: 11,
		});
	});

	it('empties only the group that was emptied', () => {
		const full = typedIn(EMPTY, 0, 'ABCDEFGHIJ').groups;
		expect(typedIn(full, 0, '')).toEqual({
			groups: ['', 'FGHIJ', ...EMPTY.slice(2)],
			focus: 0,
		});
	});

	it('reads a whole key pasted into any group, with its prefix, from the first', () => {
		const identity = generateIdentity();
		const groups = recoveryKeyGroups(identity);
		const scattered = typedIn(EMPTY, 3, 'QQQ').groups;

		expect(typedIn(scattered, 6, `AGE-SECRET-KEY-1 ${groups.join(' ')}`)).toEqual({
			groups,
			focus: 11,
		});
		expect(typedIn(scattered, 6, encodeIdentity(identity).toLowerCase()).groups).toEqual(
			groups
		);
		// Without it, as long as it is whole.
		expect(typedIn(scattered, 6, groups.join('')).groups).toEqual(groups);
	});

	it('starts again where the prefix is typed out, a character at a time', () => {
		const first = typedIn(EMPTY, 0, 'AGE-S').groups;
		const second = typedIn(first, 1, 'ECRET').groups;
		expect(typedIn(second, 2, 'KEY-1')).toEqual({ groups: EMPTY, focus: 0 });
	});
});

describe('PasteKey', () => {
	const harness = (check?: (identity: Uint8Array) => Promise<string | undefined>) => {
		const onKey = vi.fn();
		render(
			<PasteKey
				text="Type the key."
				busy={false}
				onKey={onKey}
				{...(check === undefined ? {} : { check })}
			/>
		);
		return { onKey, user: userEvent.setup() };
	};
	const group = (number: number) => screen.getByLabelText(`Group ${String(number)}`);

	it('asks for the key in its twelve groups, numbered, after its prefix', () => {
		harness();

		expect(screen.getByRole('group', { name: 'Recovery key' })).toBeTruthy();
		expect(screen.getByText('AGE-SECRET-KEY-1')).toBeTruthy();
		expect(screen.getAllByRole('textbox')).toHaveLength(12);
		expect(group(12).closest('label')?.textContent).toBe('12');
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(
			true
		);
	});

	it('takes a key typed group after group, going on as each fills', async () => {
		const h = harness();
		const identity = generateIdentity();
		const groups = recoveryKeyGroups(identity);

		await h.user.type(group(1), groups.join('').toLowerCase());
		expect(
			screen.getAllByRole('textbox').map((field) => (field as HTMLInputElement).value)
		).toEqual(groups);
		expect(document.activeElement).toBe(group(12));
		await h.user.keyboard('{Enter}');

		expect(h.onKey).toHaveBeenCalledWith(identity);
	});

	it('takes a key pasted whole into any group', async () => {
		const h = harness();
		const identity = generateIdentity();
		await h.user.click(group(7));
		await h.user.paste(`AGE-SECRET-KEY-1 ${recoveryKeyGroups(identity).join('-')}`);
		await h.user.click(screen.getByRole('button', { name: 'Continue' }));

		expect(h.onKey).toHaveBeenCalledWith(identity);
	});

	it('types over a group it goes on to, and Backspace goes back from an empty one', async () => {
		const h = harness();
		await h.user.type(group(1), 'ABCDEFGHIJ');
		await h.user.click(group(1));
		await h.user.keyboard('{Control>}a{/Control}VWXYZ');
		// Group 2's own were selected as the cursor came to it, and are typed over.
		await h.user.keyboard('KLMNO');
		expect((group(2) as HTMLInputElement).value).toBe('KLMNO');
		expect(document.activeElement).toBe(group(3));

		await h.user.keyboard('{Backspace}{Backspace}');
		expect(document.activeElement).toBe(group(2));
		expect((group(2) as HTMLInputElement).value).toBe('KLMN');
		expect((group(1) as HTMLInputElement).value).toBe('VWXYZ');
	});

	it('says a key cut short or mistyped is not one', async () => {
		const h = harness();
		await h.user.type(group(1), 'ABCDEFG');
		await h.user.click(screen.getByRole('button', { name: 'Continue' }));

		expect(screen.getByRole('alert').textContent).toBe(
			'That is not a recovery key. Check each group for a mistyped character.'
		);
		expect(h.onKey).not.toHaveBeenCalled();
	});

	it('fills a key that is not the one wanted with zeros as it is turned away', async () => {
		const seen: Uint8Array[] = [];
		const h = harness((identity) => {
			seen.push(identity);
			return Promise.resolve('Not this one.');
		});
		await h.user.click(group(1));
		await h.user.paste(encodeIdentity(generateIdentity()));
		await h.user.click(screen.getByRole('button', { name: 'Continue' }));

		expect((await screen.findByRole('alert')).textContent).toBe('Not this one.');
		expect(seen[0]?.every((byte) => byte === 0)).toBe(true);
		expect(h.onKey).not.toHaveBeenCalled();
	});
});

/**
 * A key read from its QR code with the camera, in place of typing it: a fake
 * camera here, whose frames say what each test has them say.
 */
describe('scanning a key’s QR code', () => {
	/** A camera whose frames read, one after another, as `frames`, and then as nothing. */
	const camera = (frames: readonly (string | undefined)[], refused?: string) => {
		const stop = vi.fn();
		const left = [...frames];
		const scanner: Scanner = {
			camera: () =>
				refused === undefined
					? Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
					: Promise.reject(new DOMException('No', refused)),
			reader: () => Promise.resolve(() => left.shift()),
		};
		return { scanner, stop };
	};
	const harness = (scanner?: Scanner) => {
		const onKey = vi.fn();
		render(<PasteKey text="Type the key." busy={false} onKey={onKey} scanner={scanner} />);
		return { onKey, user: userEvent.setup() };
	};
	const scan = () => screen.queryByRole('button', { name: 'Scan QR code' });
	const values = () =>
		screen.getAllByRole('textbox').map((field) => (field as HTMLInputElement).value);

	it('is offered only where there is a camera to ask', () => {
		harness();
		expect(scan()).toBeNull();
		cleanup();

		harness(camera([]).scanner);
		expect(scan()).not.toBeNull();
		// Another way to fill the groups, by them: the row is Continue's.
		expect(scan()?.closest('.dialog-tools')).not.toBeNull();
		expect(scan()?.closest('.dialog-actions')).toBeNull();
	});

	it('fills the groups from a key’s code, lets the camera go, and moves on to Continue', async () => {
		const identity = generateIdentity();
		const { scanner, stop } = camera([undefined, encodeIdentity(identity)]);
		const h = harness(scanner);

		await h.user.click(scan() as HTMLElement);
		expect(screen.getByRole('status').textContent).toBe(
			'Hold the recovery key’s QR code up to the camera.'
		);
		await vi.waitFor(() => {
			expect(values()).toEqual(recoveryKeyGroups(identity));
		});

		expect(stop).toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: 'Cancel scanning' })).toBeNull();
		const proceed = screen.getByRole('button', { name: 'Continue' });
		expect(document.activeElement).toBe(proceed);
		await h.user.click(proceed);
		expect(h.onKey).toHaveBeenCalledWith(identity);
	});

	it('says a code that is not a key, and goes on scanning', async () => {
		const { scanner } = camera(['https://example.com', undefined, undefined, undefined]);
		const h = harness(scanner);

		await h.user.click(scan() as HTMLElement);

		expect((await screen.findByText('That QR code is not a recovery key.')).textContent).toBe(
			'That QR code is not a recovery key.'
		);
		expect(values().every((value) => value === '')).toBe(true);
		expect(screen.getByRole('button', { name: 'Cancel scanning' })).toBeTruthy();
	});

	it('says where the camera was refused, or there is none to use', async () => {
		const refused = harness(camera([], 'NotAllowedError').scanner);
		await refused.user.click(scan() as HTMLElement);
		expect(
			await screen.findByText('Camera access was refused. Type the key instead.')
		).toBeTruthy();
		cleanup();

		const none = harness(camera([], 'NotFoundError').scanner);
		await none.user.click(scan() as HTMLElement);
		expect(
			await screen.findByText('No camera could be used. Type the key instead.')
		).toBeTruthy();
	});

	it('lets the camera go with Cancel scanning, back to Scan QR code', async () => {
		const { scanner, stop } = camera([]);
		const h = harness(scanner);
		await h.user.click(scan() as HTMLElement);
		const cancel = await screen.findByRole('button', { name: 'Cancel scanning' });
		expect(document.activeElement).toBe(cancel);
		expect(stop).not.toHaveBeenCalled();

		await h.user.click(cancel);

		expect(stop).toHaveBeenCalled();
		expect(document.activeElement).toBe(scan());
	});

	it('takes Escape for its own Cancel, before the dialog it is in hears it', async () => {
		const { scanner, stop } = camera([]);
		const h = harness(scanner);
		await h.user.click(scan() as HTMLElement);
		const cancel = await screen.findByRole('button', { name: 'Cancel scanning' });

		const heard = fireEvent.keyDown(cancel, { key: 'Escape' });

		expect(heard).toBe(false);
		expect(stop).toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: 'Cancel scanning' })).toBeNull();
	});

	it('lets the camera go when it goes, a key read or not', async () => {
		const { scanner, stop } = camera([]);
		const h = harness(scanner);
		await h.user.click(scan() as HTMLElement);
		await screen.findByRole('button', { name: 'Cancel scanning' });
		await Promise.resolve();

		cleanup();

		expect(stop).toHaveBeenCalled();
	});
});
