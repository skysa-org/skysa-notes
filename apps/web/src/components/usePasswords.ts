import { basename, VAULT_FOLDER } from '@skysa/core';
import { useLayoutEffect } from 'react';

import type { Place } from '../routes/place.js';
import type { NoteRecord } from '../store/db.js';
import { useVaultItems } from '../store/hooks.js';
import type { Pane } from './CompactBar.js';

type Select = (next: Place, how?: { replace?: boolean; note?: NoteRecord }) => void;

/**
 * What the route does in the passwords (docs/ARCHITECTURE.md §7, "Passwords
 * in the vault"): list them, open one, and begin a new one. The place is
 * `{folder: VAULT_FOLDER}`, and an item open in it `{folder, note}`, pushed,
 * so Back goes from an item to the list.
 */
export const usePasswords = ({
	active,
	connectionId,
	noteId,
	begin,
	select,
	compact,
	setPanel,
	setRest,
}: {
	/** Whether the passwords are open. */
	active: boolean;
	connectionId: string | undefined;
	noteId: string | undefined;
	begin: (folderPath: string, taken: readonly string[]) => NoteRecord | undefined;
	select: Select;
	compact: boolean;
	setPanel: (pane: Pane | null) => void;
	/** What a compact window shows as a pane over it is shut (`usePanel`). */
	setRest: (pane: Pane | null) => void;
}) => {
	const items = useVaultItems(active ? connectionId : undefined);

	// In a compact window the list is the notes' pane, and with no item open
	// it is all there is to show, as the scratchpad's wall is: the pane the
	// place rests on, not a dropdown open over it. Let go of in a cleanup, so
	// the scratchpad's, set as this is let go, is not cleared after it.
	const resting = active && compact && noteId === undefined;
	useLayoutEffect(() => {
		if (!resting) return undefined;
		setRest('notes');
		return () => {
			setRest(null);
		};
	}, [resting, setRest]);

	/**
	 * Open the passwords, from their row or as they are shown: a step, unless
	 * they are open already with no item, when it is the dropdown over them
	 * that shuts.
	 */
	const show = () => {
		if (!active || noteId !== undefined) select({ folder: VAULT_FOLDER, note: undefined });
		else setPanel(null);
	};

	const choose = (note: NoteRecord) => {
		select({ folder: VAULT_FOLDER, note: note.id }, { note });
	};

	/** Begin a new item. Stored at its first change, as any draft is. */
	const add = () => {
		if (!active) return;
		const made = begin(
			VAULT_FOLDER,
			(items ?? []).map((note) => basename(note.path))
		);
		if (made !== undefined) select({ folder: VAULT_FOLDER, note: made.id }, { note: made });
	};

	return { items, show, choose, add };
};
