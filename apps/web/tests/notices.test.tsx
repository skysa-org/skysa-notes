import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { NoticesProvider, useNotices, useShownNotices } from '../src/components/ui/notices.js';
import { HomeToasts } from '../src/routes/-home/HomeToasts.js';

/**
 * What the shell says over the page (#455), in its two kinds: what was said
 * about the last thing asked for, which goes as the user moves on, and what
 * stays until it is read — how an import went (2026-10-29).
 */

const wrapper = ({ children }: { children: ReactNode }) => (
	<NoticesProvider>{children}</NoticesProvider>
);

const both = () => renderHook(() => ({ ...useNotices(), ...useShownNotices() }), { wrapper });

describe('notices', () => {
	it('says one thing of each kind at once, the later in place of the earlier', () => {
		const { result } = both();

		act(() => {
			result.current.say({ message: 'Not renamed.', tone: 'error' });
			result.current.say({ message: 'Imported.', tone: 'success', stays: true });
			result.current.say({ message: 'Not moved.', tone: 'error' });
		});

		expect(result.current.passing?.message).toBe('Not moved.');
		expect(result.current.staying?.message).toBe('Imported.');
	});

	it('takes down what was said as the user moves on, and leaves what stays', () => {
		const { result } = both();
		act(() => {
			result.current.say({ message: 'Not renamed.', tone: 'error' });
			result.current.say({ message: 'Imported.', tone: 'success', stays: true });
		});

		act(() => {
			result.current.moveOn();
		});

		expect(result.current.passing).toBeNull();
		expect(result.current.staying?.message).toBe('Imported.');

		act(() => {
			result.current.dismissStaying();
		});
		expect(result.current.staying).toBeNull();
	});

	it('does not draw a saying component again as notices come and go', () => {
		const seen = { draws: 0, say: (): void => undefined };
		const Saying = () => {
			const { say } = useNotices();
			seen.draws += 1;
			seen.say = () => {
				say({ message: 'Hello.', tone: 'success' });
			};
			return null;
		};
		const Shown = () => {
			const { passing } = useShownNotices();
			return passing?.message ?? null;
		};
		const { container } = render(
			<NoticesProvider>
				<Saying />
				<Shown />
			</NoticesProvider>
		);
		const before = seen.draws;

		act(() => {
			seen.say();
		});

		expect(container.textContent).toBe('Hello.');
		expect(seen.draws).toBe(before);
	});

	it('is shown in the shell’s stack, both kinds at once', () => {
		const seen = { say: (): void => undefined };
		const Saying = () => {
			const { say } = useNotices();
			seen.say = () => {
				say({ message: 'Not moved.', tone: 'error' });
				say({ message: 'Imported.', tone: 'success', stays: true });
			};
			return null;
		};
		render(
			<NoticesProvider>
				<Saying />
				<HomeToasts
					deleted={null}
					undoDelete={() => undefined}
					dismissDeleted={() => undefined}
					undoFailed={null}
					connectNotice={undefined}
					dismissConnect={() => undefined}
				/>
			</NoticesProvider>
		);

		act(() => {
			seen.say();
		});

		expect(screen.getByText('Not moved.')).toBeDefined();
		expect(screen.getByText('Imported.')).toBeDefined();
	});

	it('will not say anything where nothing shows it', () => {
		expect(() => renderHook(useNotices)).toThrow(/NoticesProvider/);
	});
});
