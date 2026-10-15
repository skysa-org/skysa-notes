import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { drawTo, PatternGrid } from '../src/components/PatternGrid.js';
import { SecretsModal, UnlockDialog, UnlockForm } from '../src/components/UnlockDialog.js';
import { ChooseUnlock } from '../src/components/UnlockEntry.js';
import type { Answer, DeviceLock } from '../src/secrets/deviceLock.js';
import { createSecretsLock } from '../src/secrets/lock.js';
import { createDatabase, type NotesDatabase, type UnlockKind } from '../src/store/db.js';
import { enrol, FREE_TRIES, MAX_TRIES, TRY_WAIT_MS, type Unlock } from '../src/store/secretKeys.js';

/**
 * Entering an unlock (docs/ARCHITECTURE.md §7, "Secrets in a note"): a
 * pattern drawn or keyed in, one chosen and entered twice, and one tried
 * against this device's keys, with what a wrong try comes to.
 */

const opened: NotesDatabase[] = [];

afterEach(async () => {
	cleanup();
	document.body.replaceChildren();
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

describe('a pattern', () => {
	it('takes in a dot it passed over, as a phone does, and no dot twice', () => {
		expect(drawTo([0], 2)).toEqual([0, 1, 2]);
		expect(drawTo([0], 8)).toEqual([0, 4, 8]);
		expect(drawTo([6], 2)).toEqual([6, 4, 2]);
		expect(drawTo([1], 7)).toEqual([1, 4, 7]);
		// A knight's move passes over no dot.
		expect(drawTo([0], 5)).toEqual([0, 5]);
		// One already in it is not taken again.
		expect(drawTo([4, 0], 8)).toEqual([4, 0, 8]);
		expect(drawTo([0, 1], 1)).toEqual([0, 1]);
	});

	const Drawn = ({ onDrawn }: { onDrawn?: (dots: number[]) => void }) => {
		const [dots, setDots] = useState<readonly number[]>([]);
		return <PatternGrid dots={dots} onChange={setDots} {...(onDrawn ? { onDrawn } : {})} />;
	};

	const pressed = () =>
		screen
			.getAllByRole('button')
			.filter((dot) => dot.getAttribute('aria-pressed') === 'true')
			.map((dot) => dot.getAttribute('aria-label'));

	/** jsdom lays nothing out: the dot under the pointer is the one the test names. */
	const pointingAt = (dot: Element | null) => {
		document.elementFromPoint = () => dot;
	};

	afterEach(() => {
		Reflect.deleteProperty(document, 'elementFromPoint');
	});

	const dot = (n: number) => screen.getByRole('button', { name: `Dot ${n}` });

	it('takes a pressed dot once, and is keyed in a dot at a time, by its number or with Enter on it', async () => {
		const user = userEvent.setup();
		render(<Drawn />);
		pointingAt(dot(1));
		await user.click(dot(1));
		expect(pressed()).toEqual(['Dot 1']);

		dot(3).focus();
		await user.keyboard('{Enter}');
		await user.keyboard('9');
		expect(pressed()).toEqual(['Dot 1', 'Dot 2', 'Dot 3', 'Dot 6', 'Dot 9']);
		expect(screen.getByText('5 dots')).toBeTruthy();
	});

	it('is drawn by dragging across the dots, and is entered once let go of', () => {
		const onDrawn = vi.fn();
		render(<Drawn onDrawn={onDrawn} />);
		const grid = screen.getByRole('group');
		const at = (n: number) => {
			pointingAt(dot(n));
			return { pointerId: 1 };
		};

		fireEvent.pointerDown(grid, at(1));
		fireEvent.pointerMove(grid, at(3));
		fireEvent.pointerMove(grid, at(6));
		fireEvent.pointerUp(grid);

		expect(pressed()).toEqual(['Dot 1', 'Dot 2', 'Dot 3', 'Dot 6']);
		expect(onDrawn).toHaveBeenCalledWith([0, 1, 2, 5]);

		// A move with no drag under way draws nothing.
		fireEvent.pointerMove(grid, at(9));
		expect(pressed()).toHaveLength(4);
	});

	it('draws nothing where it is disabled, or from off the dots', () => {
		const onChange = vi.fn();
		const { rerender } = render(<PatternGrid dots={[]} onChange={onChange} disabled />);
		const grid = screen.getByRole('group');
		pointingAt(dot(1));
		fireEvent.pointerDown(grid, { pointerId: 1 });
		fireEvent.keyDown(grid, { key: '5' });

		rerender(<PatternGrid dots={[]} onChange={onChange} />);
		pointingAt(grid);
		fireEvent.pointerDown(grid, { pointerId: 1 });
		fireEvent.keyDown(grid, { key: '0' });
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe('choosing an unlock', () => {
	it('takes it entered the same way twice, and starts again where it was not', async () => {
		const user = userEvent.setup();
		const onChosen = vi.fn();
		render(<ChooseUnlock onChosen={onChosen} />);

		const next = screen.getByRole('button', { name: 'Next' });
		await user.type(screen.getByLabelText('PIN'), '123');
		expect(next.hasAttribute('disabled')).toBe(true);
		await user.type(screen.getByLabelText('PIN'), '4{Enter}');
		expect(screen.getByText('Again, to confirm.')).toBeTruthy();
		await user.type(screen.getByLabelText('PIN'), '4321{Enter}');
		expect(screen.getByRole('alert').textContent).toBe('That is not the same. Start again.');
		expect(onChosen).not.toHaveBeenCalled();

		await user.type(screen.getByLabelText('PIN'), '1234{Enter}');
		await user.type(screen.getByLabelText('PIN'), '1234{Enter}');
		expect(onChosen).toHaveBeenCalledWith({ kind: 'pin', digits: '1234' });
	});

	it('offers the device’s own lock only where it is offered, which is entered nowhere', async () => {
		const user = userEvent.setup();
		const onChosen = vi.fn();
		const { rerender } = render(<ChooseUnlock onChosen={onChosen} />);
		expect(screen.queryByRole('radio', { name: 'This device’s lock' })).toBeNull();

		rerender(<ChooseUnlock onChosen={onChosen} device />);
		await user.click(screen.getByRole('radio', { name: 'This device’s lock' }));

		expect(screen.queryByLabelText('PIN')).toBeNull();
		const said = screen.getByText(
			/Your device asks for your fingerprint, face or screen lock/u
		);
		const set = screen.getByRole('button', { name: 'Set unlock' });
		// What pressing it asks of the device is read out with it.
		expect(set.getAttribute('aria-describedby')).toBe(said.id);
		await user.click(set);
		expect(onChosen).toHaveBeenCalledWith({ kind: 'device' });
	});

	it('goes back to the PIN where the device’s lock is no longer offered, as making its passkey found', async () => {
		const user = userEvent.setup();
		const { rerender } = render(<ChooseUnlock onChosen={vi.fn()} device />);
		await user.click(screen.getByRole('radio', { name: 'This device’s lock' }));

		rerender(<ChooseUnlock onChosen={vi.fn()} device={false} error="Choose another way." />);

		expect(screen.getByRole('radio', { name: 'PIN' }).getAttribute('aria-checked')).toBe(
			'true'
		);
		expect(screen.getByLabelText('PIN')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toBe('Choose another way.');
	});
});

describe('unlocking', () => {
	const PIN: Unlock = { kind: 'pin', digits: '2468' };

	const setup = async (unlock: Unlock = PIN) => {
		const db = createDatabase(`unlock-form-${crypto.randomUUID()}`);
		opened.push(db);
		await db.syncState.put({ connectionId: 'c1', clientId: 'install', rootId: 'root' });
		const identity = new Uint8Array(32).fill(7);
		await enrol(db, {
			connectionId: 'c1',
			recipient: 'age1…',
			identities: [identity],
			unlock,
			rounds: 1000,
		});
		const lock = createSecretsLock({
			target: {
				visibilityState: 'visible',
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			},
		});
		const clock = { now: 1_000_000 };
		const onUnlocked = vi.fn();
		const onRecovery = vi.fn();
		const user = userEvent.setup();
		const form = (kind: UnlockKind) => (
			<UnlockForm
				database={db}
				connectionId="c1"
				kind={kind}
				lock={lock}
				onUnlocked={onUnlocked}
				onRecovery={onRecovery}
				now={() => clock.now}
			/>
		);
		const { rerender } = render(form(unlock.kind));
		const tryPin = async (digits: string) => {
			await user.type(screen.getByLabelText('PIN'), `${digits}{Enter}`);
		};
		return {
			db,
			lock,
			clock,
			onUnlocked,
			onRecovery,
			user,
			tryPin,
			/** Shown again as a parent that reads the kind as it is would show it. */
			shownAs: (kind: UnlockKind) => {
				rerender(form(kind));
			},
		};
	};

	it('holds the keys it unlocked', async () => {
		const h = await setup();
		await h.tryPin('2468');
		await vi.waitFor(() => {
			expect(h.onUnlocked).toHaveBeenCalledTimes(1);
		});
		expect(h.lock.keys('c1')?.identities[0]?.[0]).toBe(7);
	});

	it('says a try that failed in the device’s storage, and can be tried again', async () => {
		const h = await setup();
		vi.spyOn(h.db.secretKeys, 'get').mockRejectedValueOnce(new Error('closing'));
		await h.tryPin('2468');
		expect(await screen.findByText('That did not work. Try again.')).toBeTruthy();
		expect(h.onUnlocked).not.toHaveBeenCalled();

		await h.tryPin('2468');
		await vi.waitFor(() => {
			expect(h.onUnlocked).toHaveBeenCalledTimes(1);
		});
	});

	it('tries a pattern as it is let go of', async () => {
		const h = await setup({ kind: 'pattern', dots: [0, 4, 8, 5] });
		const grid = screen.getByRole('group', { name: 'Pattern' });
		const at = (n: number) => {
			const dot = screen.getByRole('button', { name: `Dot ${n}` });
			document.elementFromPoint = () => dot;
			return { pointerId: 1 };
		};
		// In one go, as a quick swipe is: let go of before the page has drawn
		// the last dot taken, so what is tried is what was drawn, not what is shown.
		act(() => {
			fireEvent.pointerDown(grid, at(1));
			fireEvent.pointerMove(grid, at(9));
			fireEvent.pointerMove(grid, at(6));
			fireEvent.pointerUp(grid);
		});
		Reflect.deleteProperty(document, 'elementFromPoint');

		await vi.waitFor(() => {
			expect(h.onUnlocked).toHaveBeenCalledTimes(1);
		});
	});

	it('says how many tries are left once they are few, and to wait', async () => {
		const h = await setup();
		await h.tryPin('1111');
		expect(await screen.findByText('That is not right.')).toBeTruthy();
		expect(screen.queryByText(/more wrong tries/u)).toBeNull();

		for (let tried = 1; tried < FREE_TRIES; tried += 1) {
			// Once the last is counted and the field is back: one typed while a
			// try is still being checked goes nowhere.
			await vi.waitFor(async () => {
				expect((await h.db.secretKeys.get('c1'))?.tries).toBe(tried);
				expect(screen.getByLabelText('PIN').hasAttribute('disabled')).toBe(false);
			});
			await h.tryPin('1111');
		}
		expect(
			await screen.findByText(
				`${MAX_TRIES - FREE_TRIES} more wrong tries remove this device’s copy of the key.`
			)
		).toBeTruthy();
		expect(
			await screen.findByText(
				`Too many wrong tries. Try again in ${TRY_WAIT_MS / 1000} seconds.`
			)
		).toBeTruthy();
		expect(screen.getByLabelText('PIN').hasAttribute('disabled')).toBe(true);
	});

	it('asks for the new unlock, counting nothing, where it was changed in another tab since the form was shown', async () => {
		const h = await setup();
		await h.tryPin('1111');
		expect(await screen.findByText('That is not right.')).toBeTruthy();
		await vi.waitFor(() => {
			expect(screen.getByLabelText('PIN').hasAttribute('disabled')).toBe(false);
		});
		await enrol(h.db, {
			connectionId: 'c1',
			recipient: 'age1…',
			identities: [new Uint8Array(32).fill(7)],
			unlock: { kind: 'password', text: 'correct horse' },
			rounds: 1000,
		});

		await h.tryPin('2468');

		expect(
			await screen.findByText(
				'This device’s unlock was just changed. Unlock with the new one.'
			)
		).toBeTruthy();
		expect(screen.queryByLabelText('PIN')).toBeNull();
		expect(screen.queryByText('That is not right.')).toBeNull();
		expect((await h.db.secretKeys.get('c1'))?.tries).toBe(0);
		await h.user.type(screen.getByLabelText('Password'), 'wrong horse{Enter}');
		expect(await screen.findByText('That is not right.')).toBeTruthy();
		expect(screen.queryByText(/was just changed/u)).toBeNull();
		await vi.waitFor(() => {
			expect(screen.getByLabelText('Password').hasAttribute('disabled')).toBe(false);
		});
		await h.user.type(screen.getByLabelText('Password'), 'correct horse{Enter}');
		await vi.waitFor(() => {
			expect(h.onUnlocked).toHaveBeenCalledTimes(1);
		});
	});

	it('says nothing of the change once it is given the new unlock', async () => {
		const h = await setup();
		await enrol(h.db, {
			connectionId: 'c1',
			recipient: 'age1…',
			identities: [new Uint8Array(32).fill(7)],
			unlock: { kind: 'password', text: 'correct horse' },
			rounds: 1000,
		});
		await h.tryPin('2468');
		await screen.findByText('This device’s unlock was just changed. Unlock with the new one.');

		h.shownAs('password');

		expect(screen.queryByText(/was just changed/u)).toBeNull();
		expect(screen.getByLabelText('Password')).toBeTruthy();
	});

	it('leaves only the recovery key once the device’s copy is gone', async () => {
		const h = await setup();
		await h.db.secretKeys.delete('c1');
		await h.tryPin('2468');
		expect(
			await screen.findByText(
				'This device has no key for this source’s secrets. Type the recovery key to set it up.'
			)
		).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Use the recovery key' }));
		expect(h.onRecovery).toHaveBeenCalledTimes(1);
	});
});

describe('unlocking with the device’s own lock', () => {
	const credentialId = new Uint8Array([1, 2, 3]).buffer;
	const salt = new Uint8Array(32).fill(5).buffer;
	const RIGHT = 0x42;

	/** A device whose passkey answers with `fill`, or not at all, noting whether the app was prompting as it was asked. */
	const deviceAnswering = (
		fill: number | undefined,
		prompting: Readonly<{ current: boolean }>,
		whilePrompting: (was: boolean) => void
	) => {
		const asked = vi.fn((id: ArrayBuffer, given: Uint8Array): Promise<Answer> => {
			whilePrompting(prompting.current);
			expect(new Uint8Array(id)).toEqual(new Uint8Array(credentialId));
			expect(given).toEqual(new Uint8Array(salt));
			return Promise.resolve(fill === undefined ? 'refused' : new Uint8Array(32).fill(fill));
		});
		const device: DeviceLock = {
			offered: () => Promise.resolve(true),
			create: () => Promise.resolve({ state: 'refused' }),
			answer: asked,
			forget: vi.fn(() => Promise.resolve()),
		};
		return device;
	};

	const setup = async (fill: number | undefined) => {
		const db = createDatabase(`unlock-device-${crypto.randomUUID()}`);
		opened.push(db);
		await db.syncState.put({ connectionId: 'c1', clientId: 'install', rootId: 'root' });
		await enrol(db, {
			connectionId: 'c1',
			recipient: 'age1…',
			identities: [new Uint8Array(32).fill(7)],
			unlock: { kind: 'device', credentialId, salt, answer: new Uint8Array(32).fill(RIGHT) },
		});
		const lock = createSecretsLock({
			target: {
				visibilityState: 'visible',
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			},
		});
		const inPrompt = { current: false };
		const prompting = vi.spyOn(lock, 'prompting').mockImplementation(async (work) => {
			inPrompt.current = true;
			try {
				return await work();
			} finally {
				inPrompt.current = false;
			}
		});
		const whilePrompting = vi.fn();
		const deviceLock = deviceAnswering(fill, inPrompt, whilePrompting);
		const onUnlocked = vi.fn();
		const onRecovery = vi.fn();
		const user = userEvent.setup();
		render(
			<UnlockForm
				database={db}
				connectionId="c1"
				kind="device"
				lock={lock}
				onUnlocked={onUnlocked}
				onRecovery={onRecovery}
				deviceLock={deviceLock}
			/>
		);
		return { db, lock, prompting, whilePrompting, deviceLock, onUnlocked, onRecovery, user };
	};

	it('asks the device only when Unlock is pressed, as a prompt of the app’s own, and holds the keys', async () => {
		const h = await setup(RIGHT);
		expect(screen.getByText('Unlock with this device’s lock.')).toBeTruthy();
		expect(h.deviceLock.answer).not.toHaveBeenCalled();

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));

		await vi.waitFor(() => {
			expect(h.onUnlocked).toHaveBeenCalledTimes(1);
		});
		expect(h.prompting).toHaveBeenCalledTimes(1);
		expect(h.whilePrompting).toHaveBeenCalledWith(true);
		expect(h.lock.keys('c1')?.identities[0]?.[0]).toBe(7);
		// What the device answered is let go of once the keys are open.
		const given = (await vi.mocked(h.deviceLock.answer).mock.results[0]?.value) as Uint8Array;
		expect(given).toHaveLength(32);
		expect(given.every((byte) => byte === 0)).toBe(true);
	});

	it('offers the recovery key beside another try, where the device’s lock did not answer', async () => {
		const h = await setup(undefined);
		expect(screen.queryByRole('button', { name: 'Use the recovery key' })).toBeNull();

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(
			await screen.findByText(
				'Your device’s lock did not answer. Try again, or use the recovery key.'
			)
		).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
		await h.user.click(screen.getByRole('button', { name: 'Use the recovery key' }));
		expect(h.onRecovery).toHaveBeenCalledTimes(1);
		expect(h.onUnlocked).not.toHaveBeenCalled();
		expect((await h.db.secretKeys.get('c1'))?.tries).toBe(0);
	});

	it('leaves only the recovery key where what the device answers no longer opens the keys', async () => {
		const h = await setup(0x43);

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(
			await screen.findByText(
				'This device’s lock no longer opens its key for these secrets. Type the recovery key to set this device up again.'
			)
		).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
		await h.user.click(screen.getByRole('button', { name: 'Use the recovery key' }));
		expect(h.onRecovery).toHaveBeenCalledTimes(1);
		expect(await h.db.secretKeys.get('c1')).toBeDefined();
	});

	it('asks nothing of the device, and asks for the PIN, where the device was changed to one since', async () => {
		const h = await setup(RIGHT);
		await enrol(h.db, {
			connectionId: 'c1',
			recipient: 'age1…',
			identities: [new Uint8Array(32).fill(7)],
			unlock: { kind: 'pin', digits: '2468' },
			rounds: 1000,
		});

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(
			await screen.findByText(
				'This device’s unlock was just changed. Unlock with the new one.'
			)
		).toBeTruthy();
		expect(h.deviceLock.answer).not.toHaveBeenCalled();
		await h.user.type(screen.getByLabelText('PIN'), '2468{Enter}');
		await vi.waitFor(() => {
			expect(h.onUnlocked).toHaveBeenCalledTimes(1);
		});
	});

	it('says so, and asks the new passkey on the next try, where another was made while it asked', async () => {
		const h = await setup(RIGHT);
		const other = new Uint8Array([4, 5, 6]).buffer;
		const asked: ArrayBuffer[] = [];
		vi.mocked(h.deviceLock.answer).mockImplementation(async (id) => {
			asked.push(id);
			if (asked.length === 1) {
				await enrol(h.db, {
					connectionId: 'c1',
					recipient: 'age1…',
					identities: [new Uint8Array(32).fill(7)],
					unlock: {
						kind: 'device',
						credentialId: other,
						salt,
						answer: new Uint8Array(32).fill(9),
					},
				});
			}
			return new Uint8Array(32).fill(asked.length === 1 ? RIGHT : 9);
		});

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));
		expect(
			await screen.findByText(
				'This device’s unlock was just changed. Unlock with the new one.'
			)
		).toBeTruthy();
		expect(h.onUnlocked).not.toHaveBeenCalled();
		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));

		await vi.waitFor(() => {
			expect(h.onUnlocked).toHaveBeenCalledTimes(1);
		});
		expect(asked.map((id) => [...new Uint8Array(id)])).toEqual([
			[1, 2, 3],
			[4, 5, 6],
		]);
	});

	it('leaves only the recovery key where the passkey answers nothing for the salt now', async () => {
		const h = await setup(RIGHT);
		vi.mocked(h.deviceLock.answer).mockResolvedValue('unsupported');

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(
			await screen.findByText(
				'This device’s lock no longer opens its key for these secrets. Type the recovery key to set this device up again.'
			)
		).toBeTruthy();
	});

	it('asks nothing of the device where it holds no keys, and says so', async () => {
		const h = await setup(RIGHT);
		await h.db.secretKeys.delete('c1');

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));

		expect(
			await screen.findByText(
				'This device has no key for this source’s secrets. Type the recovery key to set it up.'
			)
		).toBeTruthy();
		expect(h.deviceLock.answer).not.toHaveBeenCalled();
	});

	it('says a try that failed in the device’s storage, and can be tried again', async () => {
		const h = await setup(RIGHT);
		vi.spyOn(h.db.secretKeys, 'get').mockRejectedValueOnce(new Error('closing'));

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));
		expect(await screen.findByText('That did not work. Try again.')).toBeTruthy();

		await h.user.click(screen.getByRole('button', { name: 'Unlock' }));
		await vi.waitFor(() => {
			expect(h.onUnlocked).toHaveBeenCalledTimes(1);
		});
	});
});

describe('in a dialog', () => {
	/** The buttons in the row Cancel is in. */
	const rowOfCancel = () => {
		const row = screen.getByRole('button', { name: 'Cancel' }).parentElement;
		expect(row?.className).toBe('modal-actions');
		return [...(row?.querySelectorAll('button') ?? [])].map((button) => button.textContent);
	};

	it('has Unlock and Cancel side by side, in one row, as the app’s other dialogs do', async () => {
		const db = createDatabase(`unlock-dialog-${crypto.randomUUID()}`);
		opened.push(db);
		await enrol(db, {
			connectionId: 'c1',
			recipient: 'age1…',
			identities: [new Uint8Array(32).fill(7)],
			unlock: { kind: 'pin', digits: '2468' },
			rounds: 1000,
		});
		const onCancel = vi.fn();
		render(
			<UnlockDialog
				database={db}
				connectionId="c1"
				kind="pin"
				lock={createSecretsLock({
					target: {
						visibilityState: 'visible',
						addEventListener: () => undefined,
						removeEventListener: () => undefined,
					},
				})}
				onUnlocked={() => undefined}
				onRecovery={() => undefined}
				onCancel={onCancel}
			/>
		);

		expect(rowOfCancel()).toEqual(['Unlock', 'Cancel']);
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('has choosing a pattern’s Next beside Cancel', async () => {
		render(
			<SecretsModal title="Secrets" onClose={() => undefined}>
				<ChooseUnlock onChosen={() => undefined} />
			</SecretsModal>
		);
		await userEvent.click(screen.getByRole('radio', { name: 'Pattern' }));

		expect(rowOfCancel()).toEqual(['Next', 'Cancel']);
	});
});
