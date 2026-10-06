import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FloatingMenu, OptionsMenu } from '../src/components/OptionsMenu.js';

/**
 * Everything that moves, moving alike: the stylesheet's motion is spelled in
 * its tokens, which the system's "reduce motion" takes to nothing, and the
 * menus that open are placed by their size and not by the box they are drawn
 * in while they do.
 */

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const styles = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.css'),
	'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `transition` and `animation` declaration, longhands included. */
const motion = (): string[] =>
	[...styles.matchAll(/(?:^|[\s;{])((?:transition|animation)[\w-]*\s*:[^;]+);/g)].map(
		(match) => match[1] ?? ''
	);

/** The custom properties a block of the stylesheet sets, by name. */
const custom = (block: string): Map<string, string> =>
	new Map(
		[...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
			match[1] ?? '',
			(match[2] ?? '').trim(),
		])
	);

describe('the stylesheet’s motion', () => {
	it('is timed and eased only by the tokens', () => {
		const declarations = motion();
		expect(declarations.length).toBeGreaterThan(10);
		for (const declaration of declarations) {
			// A spinner's lap is a loop, not a step of motion, and is stopped
			// outright when less motion is asked for.
			if (declaration.includes('infinite')) continue;
			expect(declaration).not.toMatch(/(?<![\w-])\d*\.?\d+m?s\b/);
			// Nor a curve of its own: a bare keyword, not a token's name.
			expect(declaration).not.toMatch(
				/cubic-bezier|(?<![\w-])ease(?:-in-out|-in|-out)?(?![\w-])/
			);
		}
		// The curves are written once, where they are named.
		const curves = styles.split('\n').filter((line) => line.includes('cubic-bezier('));
		expect(curves.every((line) => /^\s*--ease-[\w-]+:/.test(line))).toBe(true);
	});

	it('names only keyframes it defines', () => {
		const defined = new Set([...styles.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]));
		const used = motion()
			.filter((declaration) => /^animation(?:-name)?\s*:/.test(declaration))
			.map((declaration) => /:\s*([\w-]+)/.exec(declaration)?.[1]);
		expect(used.length).toBeGreaterThan(5);
		for (const name of used) expect(defined).toContain(name);
	});

	it('goes to nothing when the system asks for less, but for a colour changing', () => {
		const root = custom(/:root \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? '');
		const reduced = custom(
			/@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/.exec(styles)?.[1] ??
				''
		);
		const steps = [...root.keys()].filter((name) => name.startsWith('--duration-'));
		expect(steps).toContain('--duration-state');
		for (const step of steps) {
			if (step === '--duration-state') {
				expect(reduced.has(step)).toBe(false);
			} else {
				expect(reduced.get(step)).toBe('0ms');
			}
		}
	});
});

describe('a menu opening', () => {
	it('is placed by its laid-out size, not by the smaller box it is drawn in as it arrives', () => {
		// Drawn at 98% while it opens: a placement from that box would leave a
		// card at the window's right edge a few pixels short of it.
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
			new DOMRect(0, 0, 196, 98)
		);
		render(
			<FloatingMenu
				at={{ x: 600, y: 400 }}
				align="end"
				rises
				label="Things"
				items={[{ label: 'One', onChoose: () => undefined }]}
				onClose={() => undefined}
			/>
		);
		const card = screen.getByRole('group', { name: 'Things' });
		expect(card.style.left).toBe('400px');
		expect(card.style.top).toBe('300px');
	});

	it('says which way it opens, so it arrives from the button it opened from', async () => {
		const user = userEvent.setup();
		const menu = (rises: boolean) => (
			<OptionsMenu
				label={rises ? 'Up' : 'Down'}
				title=""
				groupLabel={rises ? 'Rising' : 'Hanging'}
				triggerClassName="icon"
				trigger="⋯"
				rises={rises}
				items={[{ label: 'One', onChoose: () => undefined }]}
			/>
		);
		render(
			<>
				{menu(false)}
				{menu(true)}
			</>
		);
		await user.click(screen.getByRole('button', { name: 'Down' }));
		expect(screen.getByRole('group', { name: 'Hanging' }).classList).not.toContain(
			'options-menu-rises'
		);
		await user.click(screen.getByRole('button', { name: 'Up' }));
		expect(screen.getByRole('group', { name: 'Rising' }).classList).toContain(
			'options-menu-rises'
		);
	});
});
