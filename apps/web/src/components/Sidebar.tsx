import { ROOT } from '@skysa/core';
import { useEffect, useRef, useState } from 'react';

import { type FolderNode } from '../store/tree.js';

/**
 * The notebook tree. Folders are real directories on the provider, so this is a
 * view of the user's actual directory structure, not an app-only abstraction.
 */

export interface SidebarProps {
	tree: FolderNode[] | undefined;
	selectedFolder: string;
	onSelectFolder: (path: string) => void;
	onCreateFolder: (parentPath: string, name: string) => void;
	rootNoteCount: number;
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
	selectedFolder: string;
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
	rootNoteCount,
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
						onCreateFolder(selectedFolder, name);
					}}
				/>
			)}

			<ul className="tree">
				<li>
					<button
						type="button"
						className={selectedFolder === ROOT ? 'row selected' : 'row'}
						onClick={() => {
							onSelectFolder(ROOT);
						}}
						aria-current={selectedFolder === ROOT ? 'true' : undefined}
					>
						<span className="row-label">All notes</span>
						{rootNoteCount > 0 && <span className="count">{rootNoteCount}</span>}
					</button>
				</li>
				{tree === undefined ? (
					<li className="muted placeholder">Loading…</li>
				) : (
					<FolderRows
						nodes={tree}
						depth={1}
						selectedFolder={selectedFolder}
						onSelectFolder={onSelectFolder}
					/>
				)}
			</ul>
		</nav>
	);
};
