import { basename, isWithin, joinPath, normalizePath, parentPath, ROOT } from '@skysa/core';

/**
 * What a drop would do, worked out without rendering anything.
 *
 * The tree is the user's actual directory structure, so re-arranging it is
 * moving files and directories on the provider — not reordering a list. There
 * is no manual order to change: notebooks sort by name and notes by when they
 * were last edited (docs/ARCHITECTURE.md §7, "Re-arranging is moving"), and nothing on
 * any provider records a position for a directory entry. Dragging therefore
 * answers "where does this live", which is a question the store already has
 * `moveFolder` and `moveNote` for, and this module is only the rules about
 * which drops are allowed.
 *
 * Kept out of the components because those rules are the part worth testing:
 * a notebook dropped inside itself and a note dropped where it already is are
 * both drops the user can make with the pointer, and both have to be refused
 * before the store is asked.
 */

/** The thing being moved, by a drag or by the keyboard. */
export type Moving =
	| Readonly<{
			kind: 'notebook';
			path: string;
			/** What the row says, for the announcement and the destination labels. */
			name: string;
	  }>
	| Readonly<{ kind: 'note'; id: string; path: string; name: string }>;

/** The move a drop would make: what the route hands to the store. */
export type Move =
	| Readonly<{ kind: 'notebook'; from: string; to: string }>
	| Readonly<{ kind: 'note'; id: string; into: string }>;

/**
 * The move dropping `moving` on the notebook at `into` would make, or undefined
 * when that drop is not allowed. `ROOT` is the top level of the tree.
 *
 * Three refusals, and each one is a drop the pointer can really make:
 *
 * - A notebook into itself or into one of its own descendants. `moveFolder`
 *   throws on this, but a drop is not a way to find out: the row has to say no
 *   while the pointer is over it, before anything is asked.
 * - Anything into the folder it is already in. Nothing to do, and the store
 *   would queue a move, an `mkdir` and an `rmdir` for it.
 * - A note onto the top level. Notes outside a notebook exist — a remote folder
 *   can arrive holding them — but the app never *makes* one (docs/ARCHITECTURE.md
 *   §12.6), and a drag that did would be the app creating the shape it says it
 *   does not create. So loose notes can be dragged into a notebook and not back
 *   out, which is the direction the user wants anyway.
 *
 * A destination already holding a notebook of that name is *not* refused here.
 * That is a collision the tree this module is not given would have to answer,
 * and `moveFolder` already answers it with the `FolderExistsError` the route
 * renders for a duplicate name elsewhere — the same mistake in the same words.
 */
export const dropMove = (moving: Moving, into: string): Move | undefined => {
	const target = normalizePath(into);

	if (moving.kind === 'note') {
		if (target === ROOT) return undefined;
		if (parentPath(moving.path) === target) return undefined;
		return { kind: 'note', id: moving.id, into: target };
	}

	const source = normalizePath(moving.path);
	// `isWithin` is true of a folder against itself, which is the same refusal.
	if (isWithin(target, source)) return undefined;
	if (parentPath(source) === target) return undefined;
	return { kind: 'notebook', from: source, to: joinPath(target, basename(source)) };
};

/** Whether a row should offer itself as a destination. */
export const canDrop = (moving: Moving, into: string): boolean =>
	dropMove(moving, into) !== undefined;
