import {
	isVaultPath,
	PASSWORD_LENGTH,
	readVaultPayload,
	VAULT_FOLDER,
	vaultArmor,
	vaultBody,
	type VaultFields,
	vaultPayload,
} from '@skysa/core';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { NoteDraft } from '../src/components/note/types.js';
import { PasswordItem } from '../src/components/passwords/PasswordItem.js';
import { editedAt } from '../src/components/ui/editedAt.js';
import { FLASH_MS } from '../src/components/ui/useFlash.js';
import type { SecretHost } from '../src/editor/secretHost.js';
import { openSecret } from '../src/secrets/age.js';
import { db, LOCAL_CONNECTION_ID, type NoteRecord } from '../src/store/db.js';
import { useNote } from '../src/store/hooks.js';
import { createNote, draftNote, getNote } from '../src/store/notes.js';
import { GENERATOR_DEFAULT, getGeneratorOptions } from '../src/store/vault.js';
import { updateNote } from './noteRows.js';
import { fakeHost, identity, sealed, sealedForAnother } from './secretHostFake.js';
import { render } from './support/notices.js';

/**
 * A password in the vault, in the note's column (docs/ARCHITECTURE.md §7,
 * "Passwords in the vault"): opened as it is shown, its fields copied and its
 * password shown, edited as it is typed, put back by Cancel, closed by the
 * lock, and a new one stored at its first change.
 */

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
const storedPayload = async (id: string) => {
	const stored = await getNote(db, id, scope);
	const armor = vaultArmor(stored?.body ?? '');
	return armor === undefined ? undefined : readVaultPayload(openSecret(armor, [identity]));
};

const storedFields = async (id: string) => (await storedPayload(id))?.fields;

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
			onDelete={onDelete}
			onClose={onClose}
			onOpen={() => undefined}
		/>
	);
};

/** The vault's items, as they are on the device and not deleted. */
const liveItems = async () =>
	(await db.notes.toArray()).filter((row) => row.deletedLocally === 0 && isVaultPath(row.path));

/** Long enough for what was queued to be written. */
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

/** The item as the route held it when it was opened, and never read again: a write or more behind. */
const Behind = ({ note, host }: { note: NoteRecord; host: SecretHost }) => (
	<PasswordItem
		note={note}
		draft={undefined}
		host={host}
		onDelete={() => undefined}
		onClose={() => undefined}
		onOpen={() => undefined}
	/>
);

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
		expect(screen.getByRole('img', { name: 'Hidden' }).textContent).toBe('••••••••');
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

	it('says it has copied for a moment, and then says nothing', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const { host } = fakeHost();
			const user = await show(await item('GitHub'), host);

			await user.click(await screen.findByRole('button', { name: 'Copy password' }));
			expect(await screen.findByText('Copied.')).toBeDefined();

			act(() => {
				vi.advanceTimersByTime(FLASH_MS);
			});
			expect(screen.queryByText('Copied.')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('shows the passwords an Update replaced, each hidden until shown, and copies them', async () => {
		const { host } = fakeHost();
		const replacedAt = '2026-10-16T12:00:00.000Z';
		const previousPasswords = [
			{ password: 'older one', replacedAt },
			{ password: 'oldest one', replacedAt: 'not a date' },
		];
		const note = await item(
			'GitHub',
			FIELDS,
			vaultBody(sealed(vaultPayload(FIELDS, { previousPasswords })))
		);
		const user = await show(note, host);

		expect(
			await screen.findByText(`Previous password, until ${editedAt(Date.parse(replacedAt))}`)
		).toBeDefined();
		expect(screen.getByText('Previous password')).toBeDefined();
		expect(screen.queryByText('older one')).toBeNull();

		const [newest] = screen.getAllByRole('button', { name: 'Show previous password' });
		if (newest === undefined) throw new Error('no previous password');
		await user.click(newest);
		expect(screen.getByText('older one')).toBeDefined();
		expect(screen.queryByText('oldest one')).toBeNull();

		const [copyNewest] = screen.getAllByRole('button', { name: 'Copy previous password' });
		if (copyNewest === undefined) throw new Error('no previous password');
		await user.click(copyNewest);
		expect(host.copy).toHaveBeenLastCalledWith('older one');
	});

	it('shows none from before where they are kept in a shape this version does not know', async () => {
		const { host } = fakeHost();
		const note = await item(
			'GitHub',
			FIELDS,
			vaultBody(sealed(vaultPayload(FIELDS, { previousPasswords: 'not a list' })))
		);
		await show(note, host);

		expect(await screen.findByText('ada@example.com')).toBeDefined();
		expect(screen.queryByText(/^Previous password/u)).toBeNull();
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

		const username = await screen.findByLabelText('Username');
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

	it('opens at the label, draws the password as dots in a text field, and closes to Edit', async () => {
		const { host } = fakeHost();
		const user = await show(await item('GitHub'), host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));

		const label = await screen.findByLabelText('Label');
		await waitFor(() => {
			expect(document.activeElement).toBe(label);
		});
		// Not a password field, whose words a browser offers to save.
		const password = screen.getByLabelText<HTMLInputElement>('Password');
		expect(password.type).toBe('text');
		expect(password.classList.contains('password-masked')).toBe(true);
		await user.click(screen.getByRole('button', { name: 'Show password' }));
		expect(password.classList.contains('password-masked')).toBe(false);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' }));
		});
	});

	it('is put back as it was opened by Cancel, its armor byte for byte', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(await screen.findByLabelText('Password'), '!');
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
		// The heading is the item as the route has it, a render behind the store.
		expect(await screen.findByRole('heading', { name: 'GitHub' })).toBeDefined();
	});

	it('is closed by the lock, with what was typed already in the item', async () => {
		const fake = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, fake.host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(await screen.findByLabelText('Notes'), 'PIN 1234');

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
		await user.type(await screen.findByLabelText('Username'), 'x');

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

describe('editing a password, the store moving under it', () => {
	it('opens a second Edit on what the first wrote, though the item shown is behind it', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = userEvent.setup();
		render(<Behind note={note} host={host} />);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(await screen.findByLabelText('Password'), '!');
		await waitFor(async () => {
			expect((await storedFields(note.id))?.password).toBe('c0rrect horse!');
		});
		await user.click(screen.getByRole('button', { name: 'Done' }));

		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(await screen.findByLabelText('Label'), ' work');

		await waitFor(async () => {
			expect((await getNote(db, note.id, scope))?.title).toBe('GitHub work');
		});
		// The label changed, and the password was not put back as it was.
		expect((await storedFields(note.id))?.password).toBe('c0rrect horse!');
	});

	it('is not put back by Cancel over what a pull brought since, nor beside it', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(await screen.findByLabelText('Password'), '!');
		await waitFor(async () => {
			expect((await storedFields(note.id))?.password).toBe('c0rrect horse!');
		});
		const pulled = vaultBody(sealed(vaultPayload({ ...FIELDS, username: 'grace' })));
		await updateNote(db, note.id, { body: pulled, bodyOrigin: 'pulled' });

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(await screen.findByText('grace')).toBeDefined();
		await settle();
		expect((await liveItems()).map((row) => row.body)).toEqual([pulled]);
	});

	it('takes away, on Cancel, the copy its edit went into after a pull replaced the item', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		const pulled = vaultBody(sealed(vaultPayload({ ...FIELDS, username: 'grace' })));
		await updateNote(db, note.id, { body: pulled, bodyOrigin: 'pulled' });
		await user.type(await screen.findByLabelText('Password'), '!');
		await waitFor(async () => {
			expect(await liveItems()).toHaveLength(2);
		});

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(async () => {
			expect((await liveItems()).map((row) => row.id)).toEqual([note.id]);
		});
		expect((await getNote(db, note.id, scope))?.body).toBe(pulled);
	});

	it('does not name its file over a label pulled since', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(await screen.findByLabelText('Label'), ' work');
		await waitFor(async () => {
			expect((await getNote(db, note.id, scope))?.title).toBe('GitHub work');
		});
		await updateNote(db, note.id, { title: 'GitHub (phone)', bodyOrigin: 'pulled' });

		await user.click(screen.getByRole('button', { name: 'Done' }));
		await settle();

		const after = await getNote(db, note.id, scope);
		expect(after?.title).toBe('GitHub (phone)');
		expect(after?.path).toBe(note.path);
	});

	it('is named after its label where it is left with the form open', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(await screen.findByLabelText('Label'), ' work');
		await waitFor(async () => {
			expect((await getNote(db, note.id, scope))?.title).toBe('GitHub work');
		});

		cleanup();

		await waitFor(async () => {
			expect((await getNote(db, note.id, scope))?.path).toBe(
				`${VAULT_FOLDER}/github-work.md`
			);
		});
	});
});

describe('a password made by Generate', () => {
	const generate = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Generate' });

	/** Edit pressed, and the form open with its generator ready: what was chosen last read. */
	const ready = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await waitFor(() => {
			expect(generate().disabled).toBe(false);
		});
	};
	it('fills the password, shows it, and is kept as any change is', async () => {
		const { host } = fakeHost();
		const note = await item('GitHub');
		const user = await show(note, host);
		await ready(user);

		await user.click(screen.getByRole('button', { name: 'Generate' }));

		const made = screen.getByLabelText<HTMLInputElement>('Password');
		expect(made.type).toBe('text');
		expect(made.value).toHaveLength(PASSWORD_LENGTH.initial);
		await waitFor(async () => {
			expect((await storedFields(note.id))?.password).toBe(made.value);
		});
	});

	it('is made at the length and with the symbols chosen, which this device keeps', async () => {
		const { host } = fakeHost();
		const user = await show(await item('GitHub'), host);
		await ready(user);
		const length = screen.getByLabelText('Length');
		await user.clear(length);
		await user.type(length, '12');
		await user.click(screen.getByRole('checkbox', { name: 'Symbols' }));

		await user.click(screen.getByRole('button', { name: 'Generate' }));

		const made = screen.getByLabelText<HTMLInputElement>('Password').value;
		expect(made).toMatch(/^[a-zA-Z\d]{12}$/u);
		await waitFor(async () => {
			expect(await getGeneratorOptions(db)).toEqual({ length: 12, symbols: false });
		});
	});

	it('holds a length out of reach to 8 to 64 once it is left', async () => {
		const { host } = fakeHost();
		const user = await show(await item('GitHub'), host);
		await ready(user);
		const length = screen.getByLabelText<HTMLInputElement>('Length');
		await user.clear(length);
		await user.type(length, '500');
		await user.tab();

		await waitFor(() => {
			expect(length.value).toBe(String(PASSWORD_LENGTH.max));
		});
	});

	it('leaves the length as it was for a box left empty or holding no number', async () => {
		const { host } = fakeHost();
		const user = await show(await item('GitHub'), host);
		await ready(user);
		await user.clear(screen.getByLabelText('Length'));

		await user.click(screen.getByRole('button', { name: 'Generate' }));

		expect(screen.getByLabelText<HTMLInputElement>('Password').value).toHaveLength(
			PASSWORD_LENGTH.initial
		);
		expect(screen.getByLabelText<HTMLInputElement>('Length').value).toBe(
			String(PASSWORD_LENGTH.initial)
		);
		expect(await getGeneratorOptions(db)).toEqual(GENERATOR_DEFAULT);
		expect(screen.getByText('A new password was made, and is shown above.')).toBeDefined();
	});

	it('keeps a length entered with Enter, and the form open', async () => {
		const { host } = fakeHost();
		const user = await show(await item('GitHub'), host);
		await ready(user);
		const length = screen.getByLabelText('Length');
		await user.clear(length);
		await user.type(length, '32{Enter}');

		await waitFor(async () => {
			expect((await getGeneratorOptions(db)).length).toBe(32);
		});
		expect(screen.getByRole('group', { name: 'Make a new password' })).toBeDefined();
		expect(screen.getByLabelText('Label')).toBeDefined();
	});

	it('stores a new item it fills in', async () => {
		const { host } = fakeHost();
		const draft = draftNote({ ...scope, folderPath: VAULT_FOLDER, taken: [] });
		const user = userEvent.setup();
		render(
			<PasswordItem
				note={draft}
				draft={{
					store: () =>
						createNote(db, { ...scope, folderPath: VAULT_FOLDER, id: draft.id }).then(
							() => true
						),
					setMode: () => undefined,
				}}
				host={host}
				onDelete={() => undefined}
				onClose={() => undefined}
				onOpen={() => undefined}
			/>
		);

		await waitFor(() => {
			expect(generate().disabled).toBe(false);
		});
		await user.click(generate());

		const made = screen.getByLabelText<HTMLInputElement>('Password').value;
		await waitFor(async () => {
			expect((await storedFields(draft.id))?.password).toBe(made);
		});
	});
});

describe('a label that is a web address', () => {
	it('opens from the item, locked or not, and is not offered for words', async () => {
		const { host } = fakeHost();
		vi.mocked(host.open).mockResolvedValue({ state: 'locked' });
		await show(await item('github.com/login'), host);

		const open = await screen.findByRole('button', { name: 'Open github.com/login' });
		expect(open.getAttribute('title')).toBe('https://github.com/login');
		cleanup();

		await show(await item('My bank', FIELDS), host);
		await screen.findByRole('button', { name: 'Unlock' });
		expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
	});

	it('is not offered while the item is edited', async () => {
		const { host } = fakeHost();
		const user = await show(await item('github.com'), host);
		await screen.findByRole('button', { name: 'Open github.com' });

		await user.click(await screen.findByRole('button', { name: 'Edit' }));

		await screen.findByLabelText('Label');
		expect(screen.queryByRole('button', { name: 'Open github.com' })).toBeNull();
	});
});

describe('a password’s site', () => {
	const withSites = (urls: unknown) => vaultBody(sealed(JSON.stringify({ ...FIELDS, urls })));

	it('is kept encrypted as it is typed, and taken out where it is emptied', async () => {
		const { host } = fakeHost();
		const note = await item('Work');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));

		await user.type(await screen.findByLabelText('Site'), 'login.example.com');

		await waitFor(async () => {
			expect((await storedPayload(note.id))?.kept.urls).toEqual(['login.example.com']);
		});
		expect((await getNote(db, note.id, scope))?.body).not.toContain('example');
		expect((await storedFields(note.id))?.username).toBe(FIELDS.username);

		await user.clear(screen.getByLabelText('Site'));
		await waitFor(async () => {
			expect((await storedPayload(note.id))?.kept).not.toHaveProperty('urls');
		});
	});

	it('edits the first site, and keeps the others a later version may write', async () => {
		const { host } = fakeHost();
		const note = await item('Work', FIELDS, withSites(['a.example', 'b.example']));
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));

		const site = await screen.findByLabelText('Site');
		expect((site as HTMLInputElement).value).toBe('a.example');
		await user.clear(site);
		await user.type(site, 'c.example');

		await waitFor(async () => {
			expect((await storedPayload(note.id))?.kept.urls).toEqual(['c.example', 'b.example']);
		});
	});

	it('is not edited where it is a shape this version does not know, which is kept', async () => {
		const { host } = fakeHost();
		const note = await item('Work', FIELDS, withSites({ main: 'a.example' }));
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));

		await user.type(await screen.findByLabelText('Username'), 'x');

		expect(screen.queryByLabelText('Site')).toBeNull();
		await waitFor(async () => {
			expect((await storedFields(note.id))?.username).toBe(`${FIELDS.username}x`);
		});
		expect((await storedPayload(note.id))?.kept.urls).toEqual({ main: 'a.example' });
	});

	it('is offered from a label that is a web address, while it is empty', async () => {
		const { host } = fakeHost();
		const note = await item('github.com/login');
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));

		await user.click(await screen.findByRole('button', { name: 'Use github.com as the site' }));

		await waitFor(async () => {
			expect((await storedPayload(note.id))?.kept.urls).toEqual(['https://github.com']);
		});
		expect(screen.getByLabelText<HTMLInputElement>('Site').value).toBe('https://github.com');
		expect(screen.queryByRole('button', { name: /^Use .* as the site$/u })).toBeNull();
	});

	it('is not offered from a label that is words', async () => {
		const { host } = fakeHost();
		const user = await show(await item('My bank'), host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));

		await screen.findByLabelText('Site');
		expect(screen.queryByRole('button', { name: /^Use .* as the site$/u })).toBeNull();
	});

	it('says where what is in it is not a web address', async () => {
		const { host } = fakeHost();
		const user = await show(await item('Work'), host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		const site = await screen.findByLabelText('Site');
		expect(screen.getByText(/^The web address it fills in on/u)).toBeDefined();

		await user.type(site, 'My bank');

		expect(await screen.findByText('Not a web address, so it fills in nowhere.')).toBeDefined();
		expect(site.getAttribute('aria-describedby')).toBe(
			screen.getByText('Not a web address, so it fills in nowhere.').id
		);
	});

	it('is put back by Cancel', async () => {
		const { host } = fakeHost();
		const note = await item('Work', FIELDS, withSites(['a.example']));
		const user = await show(note, host);
		await user.click(await screen.findByRole('button', { name: 'Edit' }));
		await user.type(await screen.findByLabelText('Site'), 'x');
		await waitFor(async () => {
			expect((await storedPayload(note.id))?.kept.urls).toEqual(['a.examplex']);
		});

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		await waitFor(async () => {
			expect((await getNote(db, note.id, scope))?.body).toBe(note.body);
		});
		expect(await screen.findByRole('button', { name: 'Open a.example' })).toBeDefined();
	});

	it('opens from the item once it is opened, in place of the label’s address', async () => {
		const { host } = fakeHost();
		const note = await item('github.com', FIELDS, withSites(['https://login.example.com/in']));
		await show(note, host);

		const open = await screen.findByRole('button', { name: 'Open login.example.com/in' });
		expect(open.getAttribute('title')).toBe('https://login.example.com/in');
		expect(screen.queryByRole('button', { name: 'Open github.com' })).toBeNull();
	});

	it('is not there while the item is locked, whose label’s address is', async () => {
		const { host } = fakeHost();
		vi.mocked(host.open).mockResolvedValue({ state: 'locked' });
		await show(await item('github.com', FIELDS, withSites(['login.example.com'])), host);

		await screen.findByRole('button', { name: 'Unlock' });
		expect(screen.getByRole('button', { name: 'Open github.com' })).toBeDefined();
		expect(screen.queryByRole('button', { name: /login\.example\.com/u })).toBeNull();
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
	const storeOf = (draft: NoteRecord) => () =>
		createNote(db, { ...scope, folderPath: VAULT_FOLDER, id: draft.id }).then(() => true);

	const New = ({
		draft,
		host,
		onClose,
		store = storeOf(draft),
	}: {
		draft: NoteRecord;
		host: SecretHost;
		onClose: () => void;
		store?: () => Promise<boolean>;
	}) => {
		const stored = useNote(draft.id);
		return (
			<PasswordItem
				note={stored ?? draft}
				draft={{ store, setMode: () => undefined }}
				host={host}
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

	it('is kept by Done with only a site in it', async () => {
		const { host } = fakeHost();
		const draft = begun();
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(<New draft={draft} host={host} onClose={onClose} />);

		await user.type(await screen.findByLabelText('Site'), 'example.com');
		await waitFor(async () => {
			expect((await storedPayload(draft.id))?.kept.urls).toEqual(['example.com']);
		});
		await user.click(screen.getByRole('button', { name: 'Done' }));
		await settle();

		expect(onClose).not.toHaveBeenCalled();
		expect((await getNote(db, draft.id, scope))?.deletedLocally).toBe(0);
	});

	const NOT_STORED =
		'This password is not saved yet. Press Done to try again, or copy what you typed somewhere safe.';

	it('stays open on what was typed where the device could not keep it, and Done tries again', async () => {
		const { host } = fakeHost();
		const draft = begun();
		const refusing = { current: true };
		const store = vi.fn(() => (refusing.current ? Promise.resolve(false) : storeOf(draft)()));
		const user = userEvent.setup();
		render(<New draft={draft} host={host} onClose={() => undefined} store={store} />);

		await user.type(await screen.findByLabelText('Password'), 'pw');
		expect(await screen.findByText(NOT_STORED)).toBeDefined();
		await user.click(screen.getByRole('button', { name: 'Done' }));
		await settle();
		expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('pw');

		refusing.current = false;
		await user.click(screen.getByRole('button', { name: 'Done' }));

		await waitFor(async () => {
			expect((await storedFields(draft.id))?.password).toBe('pw');
		});
		await waitFor(() => {
			expect(screen.queryByLabelText('Password')).toBeNull();
		});
		expect(screen.queryByText(NOT_STORED)).toBeNull();
	});

	it('is not closed by the lock while the device cannot keep what was typed', async () => {
		const fake = fakeHost();
		const draft = begun();
		const user = userEvent.setup();
		render(
			<New
				draft={draft}
				host={fake.host}
				onClose={() => undefined}
				store={() => Promise.resolve(false)}
			/>
		);
		await user.type(await screen.findByLabelText('Password'), 'pw');
		await screen.findByText(NOT_STORED);

		act(() => {
			fake.lock();
		});
		await settle();

		expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('pw');
	});

	it('shows what was written once Done, while the route still holds the draft', async () => {
		const { host } = fakeHost();
		const draft = begun();
		const user = userEvent.setup();
		// The route a render behind: the draft, with no body, though the store has it.
		render(
			<PasswordItem
				note={draft}
				draft={{ store: storeOf(draft), setMode: () => undefined }}
				host={host}
				onDelete={() => undefined}
				onClose={() => undefined}
				onOpen={() => undefined}
			/>
		);
		await user.type(await screen.findByLabelText('Username'), 'ada');
		await waitFor(async () => {
			expect((await storedFields(draft.id))?.username).toBe('ada');
		});

		await user.click(screen.getByRole('button', { name: 'Done' }));

		expect(await screen.findByText('ada')).toBeDefined();
		expect(
			screen.queryByText('This password cannot be read by this version of the app.')
		).toBeNull();
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

		// Found once the item has opened: until then the region holds only
		// "Opening…".
		await user.click(
			await within(await screen.findByRole('region', { name: 'GitHub' })).findByRole(
				'button',
				{ name: 'Delete' }
			)
		);

		expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: note.id }));
	});
});
