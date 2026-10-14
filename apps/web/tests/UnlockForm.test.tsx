import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { drawTo, PatternGrid } from '../src/components/PatternGrid.js';
import { UnlockForm } from '../src/components/UnlockDialog.js';
import { ChooseUnlock } from '../src/components/UnlockEntry.js';
import { createSecretsLock } from '../src/secrets/lock.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
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
		render(
			<UnlockForm
				database={db}
				connectionId="c1"
				kind={unlock.kind}
				lock={lock}
				onUnlocked={onUnlocked}
				onRecovery={onRecovery}
				now={() => clock.now}
			/>
		);
		const tryPin = async (digits: string) => {
			await user.type(screen.getByLabelText('PIN'), `${digits}{Enter}`);
		};
		return { db, lock, clock, onUnlocked, onRecovery, user, tryPin };
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
