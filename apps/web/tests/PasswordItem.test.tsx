import {
	readVaultPayload,
	VAULT_FOLDER,
	vaultArmor,
	vaultBody,
	type VaultFields,
	vaultPayload,
} from '@skysa/core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NoteDraft } from '../src/components/NoteView.js';
import { PasswordItem } from '../src/components/PasswordItem.js';
import type { SecretHost } from '../src/editor/secretHost.js';
import { openSecret } from '../src/secrets/age.js';
import { db, LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote, draftNote, getNote } from '../src/store/notes.js';
import { fakeHost, identity, sealed, sealedForAnother } from './secretHostFake.js';

/**
 * A password in the vault, in the note's column (docs/ARCHITECTURE.md §7,
 * "Passwords in the vault"): opened as it is shown, its fields copied and its
 * password shown, edited as it is typed, put back by Cancel, closed by the
 * lock, and a new one stored at its first change.
 */

afterEach(async () => {
	cleanup();
	await db.notes.clear();
	await db.folders.clear();
	await db.opQueue.clear();
});

const scope = { connectionId: LOCAL_CONNECTION_ID };

const FIELDS: VaultFields = { username: 'ada@example.com', password: 'c0rrect horse', notes: '' };

const item = (title: string, fields: VaultFields = FIELDS, body?: string) =>
	createNote(db, {
		...scope,
		folderPath: VAULT_FOLDER,
		title,
		body: body ?? vaultBody(sealed(vaultPayload(fields))),
	});

/** What an item's body opens to now, as the store has it. */
const storedFields = async (id: string) => {
	const stored = await getNote(db, id, scope);
	const armor = vaultArmor(stored?.body ?? '');
	return armor === undefined
		? undefined
		: readVaultPayload(openSecret(armor, [identity]))?.fields;
};

const Harness = ({
	id,
	host,
	draft,
	onDelete = () => undefined,
	onClose = () => undefined,
}: {
	id: string;
	host: SecretHost;
	draft?: NoteDraft;
	onDelete?: (note: NoteRecord) => void;
	onClose?: () => void;
}) => {
	const note = useNote(id);
	return note === undefined ? null : (
		<PasswordItem
			note={note}
			draft={draft}
			host={host}
			onProblem={() => undefined}
			onDelete={onDelete}
			onClose={onClose}
			onOpen={() => undefined}
		/>
	);
};

const show = async (
	note: NoteRecord,
	host: SecretHost,
	more: Partial<Parameters<typeof Harness>[0]> = {}
) => {
	const user = userEvent.setup();
	render(<Harness id={note.id} host={host} {...more} />);
	await screen.findByRole('heading', { name: note.title });
	return user;
};

describe('a password, opened', () => {
	it('shows its username and notes, and its password as dots whatever its length', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub', { ...FIELDS, notes: 'Recovery codes in the safe.' });
		await show(note, host);

		expect(await screen.findByText('ada@example.com')).toBeDefined();
		expect(screen.getByText('Recovery codes in the safe.')).toBeDefined();
		expect(screen.getByLabelText('Hidden').textContent).toBe('••••••••');
		expect(screen.queryByText('c0rrect horse')).toBeNull();
		// Opened as it was shown, asking nothing.
		expect(host.open).toHaveBeenCalledTimes(1);
	});

	it('shows the password, and hides it again', async () => {
		const { host } = fakeHost();
		const user = await show(await item('GitHub'), host);

		await user.click(await screen.findByRole('button', { name: 'Show password' }));
		expect(screen.getByText('c0rrect horse')).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'Hide password' }));
		expect(screen.queryByText('c0rrect horse')).toBeNull();
	});

	it('copies the username and the password, and says so', async () => {
		const { host } = fakeHost();
		const user = await show(await item('GitHub'), host);

		await user.click(await screen.findByRole('button', { name: 'Copy password' }));
		expect(host.copy).toHaveBeenLastCalledWith('c0rrect horse');
		expect(await screen.findByText('Copied.')).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'Copy username' }));
		expect(host.copy).toHaveBeenLastCalledWith('ada@example.com');
	});

	it('is not written by being looked at', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		await db.notes.update([LOCAL_CONNECTION_ID, note.id], { dirty: 0 });
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Show password' }));
		await user.click(screen.getByRole('button', { name: 'Copy password' }));

		const stored = await getNote(db, note.id, scope);
		expect(stored?.body).toBe(note.body);
		expect(stored?.dirty).toBe(0);
	});
});

describe('a password that does not open', () => {
	it('says it is locked where the unlock was not given, and asks again on Unlock', async () => {
		const { host } = fakeHost();
		vi.mocked(host.open).mockResolvedValueOnce({ state: 'locked' });
		const user = await show(await item('GitHub'), host);

		await user.click(await screen.findByRole('button', { name: 'Unlock' }));

		expect(await screen.findByText('ada@example.com')).toBeDefined();
		expect(host.open).toHaveBeenCalledTimes(2);
		// Nothing to delete or edit while what it is has not been seen.
	});

	it('offers to add its key where it was made with another', async () => {
		const { host } = fakeHost();
		const note = await item(
			'GitHub',
			FIELDS,
			vaultBody(sealedForAnother(vaultPayload(FIELDS)))
		);
		const user = await show(note, host);

		await user.click(await screen.findByRole('button', { name: 'Add its key' }));

		expect(host.addKey).toHaveBeenCalledWith(vaultArmor(note.body));
		expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
	});

	it.each([
		[
			'words beside its fence',
			`${vaultBody(sealed(vaultPayload(FIELDS)))}\nAdded elsewhere.\n`,
		],
		['a fence that opens to no object', vaultBody(sealed('hunter2'))],
		['no fence at all', 'Just words.\n'],
	])('says it cannot be read, with Delete and no Edit, for %s', async (_, body) => {
		const { host } = fakeHost();
		await show(await item('GitHub', FIELDS, body), host);

		expect(
			await screen.findByText('This password cannot be read by this version of the app.')
		).toBeDefined();
		expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
	});
});

describe('editing a password', () => {
	it('keeps each change as it is typed, encrypted, and renames the file once, on Done', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));

		const username = screen.getByLabelText('Username');
		await user.clear(username);
		await user.type(username, 'grace');
		await waitFor(async () => {
			expect((await storedFields(note.id))?.username).toBe('grace');
		});
		const typed = await getNote(db, note.id, scope);
		// Encrypted, not written as typed.
		expect(typed?.body).not.toContain('grace');
		expect(typed?.dirty).toBe(1);

		const label = screen.getByLabelText('Label');
		await user.clear(label);
		await user.type(label, 'GitHub work');
		await waitFor(async () => {
			expect((await getNote(db, note.id, scope))?.title).toBe('GitHub work');
		});
		// Not renamed at every character.
		expect((await getNote(db, note.id, scope))?.path).toBe(note.path);

		await user.click(screen.getByRole('button', { name: 'Done' }));
		await waitFor(async () => {
			expect((await getNote(db, note.id, scope))?.path).toBe(
				`${VAULT_FOLDER}/github-work.md`
			);
		});
		expect(await screen.findByText('grace')).toBeDefined();
	});

	it('is put back as it was opened by Cancel, its armor byte for byte', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(screen.getByLabelText('Password'), '!');
		await user.type(screen.getByLabelText('Label'), ' old');
		await waitFor(async () => {
			expect((await storedFields(note.id))?.password).toBe('c0rrect horse!');
		});

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(async () => {
			const stored = await getNote(db, note.id, scope);
			expect(stored?.body).toBe(note.body);
			expect(stored?.title).toBe('GitHub');
		});
		expect(screen.getByRole('heading', { name: 'GitHub' })).toBeDefined();
	});

	it('is closed by the lock, with what was typed already in the item', async () => {
		const fake = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, fake.host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(screen.getByLabelText('Notes'), 'PIN 1234');

		act(() => {
			fake.lock();
		});

		expect(await screen.findByRole('button', { name: 'Unlock' })).toBeDefined();
		expect(screen.queryByLabelText('Notes')).toBeNull();
		expect(screen.queryByText('PIN 1234')).toBeNull();
		await waitFor(async () => {
			expect((await storedFields(note.id))?.notes).toBe('PIN 1234');
		});
	});

	it('keeps what a later version wrote beside the fields', async () => {
		const { host } = fakeHost();
		const later = JSON.stringify({ totp: 'otpauth://x', ...FIELDS });
		const note = await item('GitHub', FIELDS, vaultBody(sealed(later)));
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(screen.getByLabelText('Username'), 'x');

		await waitFor(async () => {
			const stored = await getNote(db, note.id, scope);
			const opened = openSecret(vaultArmor(stored?.body ?? '') ?? '', [identity]);
			expect(JSON.parse(opened)).toEqual({
				totp: 'otpauth://x',
				...FIELDS,
				username: 'ada@example.comx',
			});
		});
	});
});

describe('a new password', () => {
	const begun = () =>
		draftNote({
			...scope,
			connectionId: LOCAL_CONNECTION_ID,
			folderPath: VAULT_FOLDER,
			taken: [],
		});

	/** The draft's harness: the note shown is the draft until it is stored, as the route has it. */
	const New = ({
		draft,
		host,
		onClose,
	}: {
		draft: NoteRecord;
		host: SecretHost;
		onClose: () => void;
	}) => {
		const stored = useNote(draft.id);
		return (
			<PasswordItem
				note={stored ?? draft}
				draft={{
					store: () =>
						createNote(db, { ...scope, folderPath: VAULT_FOLDER, id: draft.id }).then(
							() => true
						),
					setMode: () => undefined,
				}}
				host={host}
				onProblem={() => undefined}
				onDelete={() => undefined}
				onClose={onClose}
				onOpen={() => undefined}
			/>
		);
	};

	it('opens to be filled in, and is stored, encrypted, at its first change', async () => {
		const { host } = fakeHost();
		const draft = begun();
		const user = userEvent.setup();
		render(<New draft={draft} host={host} onClose={() => undefined} />);

		await user.type(await screen.findByLabelText('Password'), 'pw');
		await user.type(screen.getByLabelText('Label'), 'Bank');
		await waitFor(async () => {
			expect((await storedFields(draft.id))?.password).toBe('pw');
		});
		await user.click(screen.getByRole('button', { name: 'Done' }));

		await waitFor(async () => {
			const stored = await getNote(db, draft.id, scope);
			expect(stored?.path).toBe(`${VAULT_FOLDER}/bank.md`);
			expect(stored?.title).toBe('Bank');
		});
		expect(host.begin).toHaveBeenCalledTimes(1);
		// Sealed by the begin's sealer, with no unlock asked.
		expect(host.open).not.toHaveBeenCalled();
	});

	it('is let go quietly by Cancel, stored or not', async () => {
		const { host } = fakeHost();
		const draft = begun();
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(<New draft={draft} host={host} onClose={onClose} />);
		await user.type(await screen.findByLabelText('Username'), 'a');
		await waitFor(async () => {
			expect(await getNote(db, draft.id, scope)).toBeDefined();
		});

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
		expect((await getNote(db, draft.id, scope))?.deletedLocally).toBe(1);
	});

	it('is let go by Done with nothing in it, and never stored', async () => {
		const { host } = fakeHost();
		const draft = begun();
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(<New draft={draft} host={host} onClose={onClose} />);

		await user.click(await screen.findByRole('button', { name: 'Done' }));

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
		expect(await getNote(db, draft.id, scope)).toBeUndefined();
	});

	it('is not begun where the source cannot take one, and says nothing itself', async () => {
		const { host } = fakeHost(false);
		const onClose = vi.fn();
		render(<New draft={begun()} host={host} onClose={onClose} />);

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
		expect(screen.queryByLabelText('Password')).toBeNull();
	});
});

describe('deleting a password', () => {
	it('asks the route, which keeps the undo', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const onDelete = vi.fn();
		const user = await show(note, host, { onDelete });

		await user.click(
			within(await screen.findByRole('region', { name: 'GitHub' })).getByRole('button', {
				name: 'Delete',
			})
		);

		expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: note.id }));
	});
});
