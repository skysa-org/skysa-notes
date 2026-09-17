import { ROOT } from '@skysa/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { type FolderNode, LOOSE_NOTES_LABEL } from '../store/tree.js';

/**
 * The notebook tree. Folders are real directories on the provider, so this is a
 * view of the user's actual directory structure, not an app-only abstraction.
 *
 * Only notebooks are listed. The root is where notebooks live, not a notebook
 * itself, so it has no row of its own — except when it actually holds notes,
 * which a remote folder can arrive already doing. Then one row appears below
 * the notebooks and names exactly what it holds. It is not the "All notes" row
 * we removed: that one always showed and misdescribed its contents.
 */

export interface SidebarProps {
	tree: FolderNode[] | undefined;
	/** Undefined until the tree has loaded, and when there are no notebooks. */
	selectedFolder: string | undefined;
	onSelectFolder: (path: string) => void;
	/** A new notebook goes inside the open one, or at the root when there is none. */
	onCreateFolder: (parentPath: string | undefined, name: string) => void;
	/**
	 * Notes sitting at the root, in no notebook. Undefined while loading; zero
	 * in the normal case, and then there is no row.
	 */
	looseNoteCount: number | undefined;
	/** Below the tree: where the storage account lives. */
	footer?: ReactNode;
}

/**
 * Inline rather than a `prompt()`: a modal browser dialog blocks the page, is
 * unstyleable, and behaves badly in an installed PWA.
 */
interface NewFolderFieldProps {
	onCancel: () => void;
	onSubmit: (name: string) => void;
}

const NewFolderField = ({ onCancel, onSubmit }: NewFolderFieldProps) => {
	const [name, setName] = useState('');
	const field = useRef<HTMLInputElement>(null);

	// The field appears in response to a click, so moving focus into it is what
	// the user asked for — unlike `autoFocus` on page load, which jsx-a11y
	// rightly rejects. A keyboard user would otherwise have to hunt for the
	// field they just opened.
	useEffect(() => {
		field.current?.focus();
	}, []);

	const submit = () => {
		const trimmed = name.trim();
		if (trimmed === '') {
			onCancel();
			return;
		}
		onSubmit(trimmed);
	};

	return (
		<input
			className="new-folder"
			aria-label="New notebook name"
			placeholder="Notebook name"
			ref={field}
			value={name}
			onChange={(event) => {
				setName(event.target.value);
			}}
			onBlur={submit}
			onKeyDown={(event) => {
				if (event.key === 'Enter') submit();
				if (event.key === 'Escape') onCancel();
			}}
		/>
	);
};

interface FolderRowsProps {
	nodes: FolderNode[];
	depth: number;
	selectedFolder: string | undefined;
	onSelectFolder: (path: string) => void;
}

const FolderRows = ({ nodes, depth, selectedFolder, onSelectFolder }: FolderRowsProps) => (
	<>
		{nodes.map((node) => (
			<li key={node.path}>
				<button
					type="button"
					className={node.path === selectedFolder ? 'row selected' : 'row'}
					style={{ paddingInlineStart: `${String(0.75 + depth * 0.85)}rem` }}
					onClick={() => {
						onSelectFolder(node.path);
					}}
					aria-current={node.path === selectedFolder ? 'true' : undefined}
				>
					<span className="row-label">{node.name}</span>
					{node.noteCount > 0 && <span className="count">{node.noteCount}</span>}
				</button>
				{node.children.length > 0 && (
					<ul>
						<FolderRows
							nodes={node.children}
							depth={depth + 1}
							selectedFolder={selectedFolder}
							onSelectFolder={onSelectFolder}
						/>
					</ul>
				)}
			</li>
		))}
	</>
);

export const Sidebar = ({
	tree,
	selectedFolder,
	onSelectFolder,
	onCreateFolder,
	looseNoteCount,
	footer,
}: SidebarProps) => {
	const [creating, setCreating] = useState(false);

	return (
		<nav className="sidebar" aria-label="Notebooks">
			<div className="pane-header">
				<h2>Notebooks</h2>
				<button
					type="button"
					className="icon"
					title="New notebook"
					aria-label="New notebook"
					onClick={() => {
						setCreating(true);
					}}
				>
					+
				</button>
			</div>

			{creating && (
				<NewFolderField
					onCancel={() => {
						setCreating(false);
					}}
					onSubmit={(name) => {
						setCreating(false);
						// The root is not a notebook, so a notebook created while
						// the loose notes are open goes alongside them, not inside.
						onCreateFolder(selectedFolder === ROOT ? undefined : selectedFolder, name);
					}}
				/>
			)}

			<ul className="tree">
				{/* With no notebooks and the loose notes not yet counted there is
					nothing here to say — but "nothing" reads as an empty sidebar
					beside a note list that says it is still loading. */}
				{(tree === undefined || (tree.length === 0 && looseNoteCount === undefined)) && (
					<li className="muted placeholder">Loading…</li>
				)}
				{tree?.length === 0 && looseNoteCount === 0 && (
					<li className="muted placeholder">No notebooks yet. Create one to start.</li>
				)}
				{tree !== undefined && (
					<FolderRows
						nodes={tree}
						depth={0}
						selectedFolder={selectedFolder}
						onSelectFolder={onSelectFolder}
					/>
				)}
				{looseNoteCount !== undefined && looseNoteCount > 0 && (
					<li>
						<button
							type="button"
							className={selectedFolder === ROOT ? 'row selected' : 'row'}
							style={{ paddingInlineStart: '0.75rem' }}
							onClick={() => {
								onSelectFolder(ROOT);
							}}
							aria-current={selectedFolder === ROOT ? 'true' : undefined}
						>
							<span className="row-label">{LOOSE_NOTES_LABEL}</span>
							<span className="count">{looseNoteCount}</span>
						</button>
					</li>
				)}
			</ul>

			{footer}
		</nav>
	);
};
