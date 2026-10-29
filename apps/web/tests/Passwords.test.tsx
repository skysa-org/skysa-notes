import { VAULT_FOLDER } from '@skysa/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Passwords } from '../src/components/passwords/Passwords.js';
import { LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import { draftNote } from '../src/store/notes.js';
import { byLabel } from '../src/store/vault.js';

/**
 * The passwords' list (docs/ARCHITECTURE.md §7, "Passwords in the vault"):
 * labels A to Z as the user's language sorts them, a field that narrows them,
 * and `+` for a new one.
 */

const item = (title: string, at = title.toLowerCase()): NoteRecord => ({
	...draftNote({
		connectionId: LOCAL_CONNECTION_ID,
		folderPath: VAULT_FOLDER,
		taken: [],
	}),
	title,
	path: `${VAULT_FOLDER}/${at}.md`,
});

const labels = () =>
	within(screen.getByRole('region', { name: 'Passwords' }))
		.queryAllByRole('listitem')
		.map((row) => row.textContent);

const list = (items: readonly NoteRecord[], more: Partial<Parameters<typeof Passwords>[0]> = {}) =>
	render(
		<Passwords
			items={[...items].sort(byLabel)}
			selectedId={undefined}
			onSelect={() => undefined}
			onAdd={() => undefined}
			{...more}
		/>
	);

describe('the passwords’ list', () => {
	it('is the labels, A to Z, case and numbers as a reader sorts them', () => {
		list([
			item('zoom'),
			item('Bank 10'),
			item('apple'),
			item('Bank 9'),
			item('Éclair', 'eclair'),
		]);

		expect(labels()).toEqual(['apple', 'Bank 9', 'Bank 10', 'Éclair', 'zoom']);
	});

	it('narrows as the filter is typed in, case and accents let go of', async () => {
		const user = userEvent.setup();
		list([item('GitHub'), item('Gitea'), item('Éclair Bank', 'eclair-bank'), item('Mail')]);

		await user.type(screen.getByRole('searchbox', { name: 'Filter passwords' }), 'git');
		expect(labels()).toEqual(['Gitea', 'GitHub']);

		await user.clear(screen.getByRole('searchbox', { name: 'Filter passwords' }));
		await user.type(screen.getByRole('searchbox', { name: 'Filter passwords' }), 'ECLAIR');
		expect(labels()).toEqual(['Éclair Bank']);

		await user.clear(screen.getByRole('searchbox', { name: 'Filter passwords' }));
		await user.type(screen.getByRole('searchbox', { name: 'Filter passwords' }), 'nothing');
		expect(labels()).toEqual([]);
		expect(screen.getByText('No password’s label has “nothing” in it.')).toBeDefined();
	});

	it('is let go of its filter by Escape', async () => {
		const user = userEvent.setup();
		list([item('GitHub'), item('Mail')]);
		const filter = screen.getByRole('searchbox', { name: 'Filter passwords' });
		await user.type(filter, 'git');

		await user.keyboard('{Escape}');

		expect(labels()).toEqual(['GitHub', 'Mail']);
	});

	it('says what it is for with nothing in it, and offers no filter', () => {
		list([]);

		expect(
			screen.getByText(
				'Passwords you add here are encrypted with this source’s vault, as secrets in notes are.'
			)
		).toBeDefined();
		expect(screen.queryByRole('searchbox')).toBeNull();
	});

	it('opens an item, marks the one open, and begins a new one with +', async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		const onAdd = vi.fn();
		const github = item('GitHub');
		list([github, item('Mail')], { onSelect, onAdd, selectedId: github.id });

		expect(screen.getByRole('button', { name: 'GitHub' }).getAttribute('aria-current')).toBe(
			'true'
		);
		await user.click(screen.getByRole('button', { name: 'Mail' }));
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail' }));

		await user.click(screen.getByRole('button', { name: 'New password' }));
		expect(onAdd).toHaveBeenCalledTimes(1);
	});
});
