import { render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
	ShellProvider,
	ShellTo,
	useLiveEdits,
	useRenamings,
	useShell,
} from '../src/components/shell/context.js';
import { createLiveEdits } from '../src/store/liveEdits.js';
import { createRenamings } from '../src/store/renaming.js';

/**
 * What the shell holds for the panes drawn inside it: one of each for its
 * life, and nothing outside it, which every reader takes as nothing typed and
 * nothing being renamed.
 */

const inShell = ({ children }: { children: ReactNode }) => (
	<ShellProvider>{children}</ShellProvider>
);

const useBoth = () => ({ liveEdits: useLiveEdits(), renamings: useRenamings() });

describe('the shell', () => {
	it('holds nothing outside a provider, and the shell itself says so', () => {
		expect(renderHook(useBoth).result.current).toEqual({
			liveEdits: undefined,
			renamings: undefined,
		});
		expect(() => renderHook(useShell)).toThrow(/ShellProvider/);
	});

	it('holds one of each for its life, the same to every reader', () => {
		const { result, rerender } = renderHook(() => ({ ...useBoth(), shell: useShell() }), {
			wrapper: inShell,
		});
		const first = result.current;
		expect(first.liveEdits).toBeDefined();
		expect(first.renamings).toBeDefined();
		expect(first.shell).toEqual({ liveEdits: first.liveEdits, renamings: first.renamings });

		rerender();

		expect(result.current.liveEdits).toBe(first.liveEdits);
		expect(result.current.renamings).toBe(first.renamings);
	});

	it('is a new one for each shell', () => {
		const seen: unknown[] = [];
		const Reader = () => {
			seen.push(useLiveEdits());
			return null;
		};
		render(
			<>
				<ShellProvider>
					<Reader />
				</ShellProvider>
				<ShellProvider>
					<Reader />
				</ShellProvider>
			</>
		);
		expect(seen[0]).not.toBe(seen[1]);
	});

	it('follows what a test gives it, and keeps its own for what it does not', () => {
		const first = createLiveEdits();
		const second = createLiveEdits();
		let given = first;
		const { result, rerender } = renderHook(useBoth, {
			wrapper: ({ children }: { children: ReactNode }) => (
				<ShellTo liveEdits={given}>{children}</ShellTo>
			),
		});
		const renamings = result.current.renamings;
		expect(result.current.liveEdits).toBe(first);

		given = second;
		rerender();

		expect(result.current.liveEdits).toBe(second);
		expect(result.current.renamings).toBe(renamings);
	});

	it('is a test’s own where one is given', () => {
		const liveEdits = createLiveEdits();
		const renamings = createRenamings();
		const { result } = renderHook(useBoth, {
			wrapper: ({ children }: { children: ReactNode }) => (
				<ShellTo liveEdits={liveEdits} renamings={renamings}>
					{children}
				</ShellTo>
			),
		});
		expect(result.current.liveEdits).toBe(liveEdits);
		expect(result.current.renamings).toBe(renamings);
	});
});
