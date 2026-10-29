import '../src/jitless.js';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FillSetupDialog } from '../src/components/passwords/FillSetupDialog.js';
import { Passwords } from '../src/components/passwords/Passwords.js';
import { bookmarkletUrl } from '../src/fill/bookmarklet.js';

/**
 * Fill on sites, in Passwords (docs/ARCHITECTURE.md §7, "Filling in on a
 * site"): the bookmarklet's link, to drag to the bookmarks bar, never run in
 * the app; Copy, for a phone; and what it says of where it works.
 */

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
});

const ORIGIN = 'https://notes.example';

const shown = (props: Partial<Parameters<typeof FillSetupDialog>[0]> = {}) => {
	const copy = vi.fn((_text: string) => Promise.resolve());
	const onClose = vi.fn();
	render(
		<FillSetupDialog onClose={onClose} copy={copy} origin={ORIGIN} appName="Notes" {...props} />
	);
	return { copy, onClose, user: userEvent.setup() };
};

const link = () => {
	const found = document.querySelector<HTMLAnchorElement>('a.fill-bookmarklet');
	if (found === null) throw new Error('no link');
	return found;
};

describe('Fill on sites', () => {
	it('shows the bookmarklet for this app as a link, named for the bookmark it becomes', () => {
		shown();

		expect(screen.getByRole('heading', { name: 'Fill on sites' })).toBeDefined();
		expect(link().getAttribute('href')).toBe(bookmarkletUrl(ORIGIN));
		expect(link().textContent).toBe('Fill with Notes');
		expect(
			screen.getByText('It works with the app at https://notes.example only.')
		).toBeDefined();
	});

	it('names it plainly where the app has no name of its own', () => {
		shown({ appName: undefined });

		expect(link().textContent).toBe('Fill in');
	});

	it('runs nothing when the link is pressed in the app, and says to drag it', () => {
		shown();

		const pressed = fireEvent.click(link());

		// `fireEvent` answers false where the press was refused.
		expect(pressed).toBe(false);
		expect(screen.getByRole('status').textContent).toBe(
			'Drag it to your bookmarks bar instead. Here, in the app, it does nothing.'
		);
	});

	it('copies the bookmarklet, for a phone, and says so', async () => {
		const { copy, user } = shown();

		await user.click(screen.getByRole('button', { name: 'Copy bookmarklet' }));

		expect(copy).toHaveBeenCalledWith(bookmarkletUrl(ORIGIN));
		expect(screen.getByRole('status').textContent).toBe(
			'Copied. Paste it as a bookmark’s address.'
		);
	});

	it('says where it could not be copied', async () => {
		const { user } = shown({ copy: () => Promise.reject(new Error('refused')) });

		await user.click(screen.getByRole('button', { name: 'Copy bookmarklet' }));

		expect(screen.getByRole('status').textContent).toBe(
			'That could not be put on the clipboard.'
		);
	});

	it('says the fill window never asks for the recovery key, and where it does not work', () => {
		shown();

		expect(
			screen.getByText(/^The fill window never asks for your recovery key/u)
		).toBeDefined();
		expect(screen.getByText(/^Chrome and Edge run it on every site/u)).toBeDefined();
		expect(screen.getByText(/Home Screen or the Dock/u)).toBeDefined();
	});

	it('is closed by its ✕, with nothing else to answer', async () => {
		const { onClose, user } = shown();

		expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
		await user.click(screen.getByRole('button', { name: 'Close' }));

		expect(onClose).toHaveBeenCalled();
	});
});

describe('Passwords', () => {
	it('opens Fill on sites from its header, and closes it', async () => {
		const user = userEvent.setup();
		render(
			<Passwords
				items={[]}
				selectedId={undefined}
				onSelect={() => undefined}
				onAdd={() => undefined}
			/>
		);

		await user.click(screen.getByRole('button', { name: 'Fill on sites' }));
		expect(screen.getByRole('dialog', { name: 'Fill on sites' })).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'Close' }));
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
