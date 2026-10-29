import { ancestorPaths, basename } from '@skysa/core';
import { useState } from 'react';

import { useCommand } from '../../commands/context.js';
import { t } from '../../i18n/t.js';
import type { NotebookPin } from '../../store/pins.js';
import type { Moving } from '../../store/rearrange.js';
import type { Renamings } from '../../store/renaming.js';
import type { FolderNode } from '../../store/tree.js';
import type { MenuPoint, OptionsMenuItem } from '../OptionsMenu.js';
import { type NotebookActions, notebookMenuItems } from './NotebookMenu.js';

const nodeAt = (nodes: readonly FolderNode[], path: string): FolderNode | undefined =>
	nodes.reduce<FolderNode | undefined>(
		(found, node) => found ?? (node.path === path ? node : nodeAt(node.children, path)),
		undefined
	);

interface NotebookMenuOptions {
	tree: FolderNode[] | undefined;
	/** The notebook the palette's commands are about (`notebookOpen`). */
	open: string | undefined;
	moving: Moving | null;
	pickUp: (moving: Moving) => void;
	/** Open these notebooks, so that a row about to become a field is listed. */
	openThese: (...paths: string[]) => void;
	/** Make a notebook inside this one: the sidebar's field, which it keeps. */
	onNewInside: (path: string) => void;
	onRenameFolder: ((path: string, name: string) => void) | undefined;
	onPinFolder: ((path: string, pin: NotebookPin | undefined) => void) | undefined;
	renamings: Renamings | undefined;
	onReveal: (() => void) | undefined;
}

/**
 * What can be done to a notebook, and what of it is under way: a rename, a
 * delete being asked about, its files listed, its menu open where its row was
 * right-clicked. Asked for from the row's `⋯`, a right-click on the row, or
 * the palette, whose commands are about the notebook open. The sidebar draws
 * what this holds.
 */
export const useNotebookMenu = ({
	tree,
	open,
	moving,
	pickUp,
	openThese,
	onNewInside,
	onRenameFolder,
	onPinFolder,
	renamings,
	onReveal,
}: NotebookMenuOptions) => {
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [listing, setListing] = useState<string | null>(null);
	/** A notebook's row right-clicked, and where: its menu is open there. */
	const [menu, setMenu] = useState<{ path: string; at: MenuPoint } | null>(null);

	const manageable = open !== undefined && moving === null;
	const going = deleting === null ? undefined : nodeAt(tree ?? [], deleting);

	/** Pinned or not, and the way to change it, where the route keeps pins. */
	const pinning = (
		path: string,
		node: FolderNode | undefined
	): Pick<NotebookActions, 'pinned' | 'onPin'> => {
		if (onPinFolder === undefined) return {};
		return {
			pinned: node?.pinned,
			onPin: (pin) => {
				onPinFolder(path, pin);
			},
		};
	};

	/**
	 * What the menu does to a notebook, from its row's `⋯` or a right-click on
	 * the row. One set of actions, so the two menus cannot drift.
	 */
	const actionsFor = (path: string): NotebookActions => {
		const node = nodeAt(tree ?? [], path);
		return {
			...pinning(path, node),
			onNewInside: () => {
				onNewInside(path);
			},
			onRename: () => {
				setRenaming(path);
			},
			onMove: () => {
				pickUp({ kind: 'notebook', path, name: basename(path) });
			},
			onFiles:
				(node?.fileCount ?? 0) === 0
					? undefined
					: () => {
							setListing(path);
						},
			onDelete: () => {
				setDeleting(path);
			},
		};
	};

	const renamed = (path: string, chosen?: string) => {
		setRenaming(null);
		const trimmed = chosen?.trim();
		// Nothing typed, Escape, or the name it already had: all of them are the
		// user changing their mind, and none of them is worth a move on the
		// provider — `moveFolder` answers a rename to the same name with nothing
		// at all, but the queue and the toast are cheaper not to reach.
		if (
			trimmed === undefined ||
			trimmed === '' ||
			trimmed === basename(path) ||
			onRenameFolder === undefined
		) {
			renamings?.clear('notebook', path);
			return;
		}
		// Shown as given until the route has the notebook at its new path.
		renamings?.give('notebook', path, path);
		onRenameFolder(path, trimmed);
	};

	useCommand({
		id: 'notebook.rename',
		label: t('notebooks.commands.rename'),
		group: t('shell.commands.group.notebook'),
		enabled: manageable,
		run: () => {
			setRenaming(open ?? null);
			// The row becomes the field, so it has to be listed: a notebook inside
			// a shut one is not, and its name would wait there for whenever that
			// one is opened next, and take the focus then.
			if (open !== undefined) openThese(...ancestorPaths(open));
			onReveal?.();
		},
	});

	useCommand({
		id: 'notebook.delete',
		label: t('notebooks.commands.delete'),
		group: t('shell.commands.group.notebook'),
		enabled: manageable,
		run: () => {
			setDeleting(open ?? null);
			onReveal?.();
		},
	});

	return {
		/** The notebook whose row is its name's field, or null. */
		renaming,
		renamed,
		/** The notebook being asked about going, or null, and its node. */
		deleting,
		going,
		stopDeleting: () => {
			setDeleting(null);
		},
		/** The notebook whose files are listed, or null. */
		listing,
		stopListing: () => {
			setListing(null);
		},
		menu,
		openMenu: (path: string, at: MenuPoint) => {
			setMenu({ path, at });
		},
		closeMenu: () => {
			setMenu(null);
		},
		/** A notebook's menu, for its `⋯` and for a right-click on its row alike. */
		itemsFor: (path: string): OptionsMenuItem[] =>
			notebookMenuItems(basename(path), actionsFor(path)),
	};
};
