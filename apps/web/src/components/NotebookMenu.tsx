import { useEffect, useRef, useState } from 'react';

import { useEscape } from './useEscape.js';

/**
 * What can be done to the open notebook, behind one button in the pane header.
 *
 * In the header rather than on every row. The rows are drag sources now, and a
 * button inside a button is not a thing HTML has — each row would have to
 * become a wrapper holding two controls, which is a lot of chrome and a lot of
 * hit area taken from the thing the row is for. The open notebook is already
 * the subject of the pane beside it ("New note" puts one there), so it is the
 * subject here too, and opening a notebook to act on it costs one click that
 * changes nothing.
 *
 * `role="group"` and plain buttons rather than `role="menu"` and `menuitem`,
 * which is the same choice `SourceTabs` made about `tablist`: the ARIA menu
 * pattern owes arrow-key navigation and a roving `tabindex`, and a handful of
 * buttons a user can Tab through already works for everyone. Escape closes it,
 * a press anywhere else closes it, and the button says whether it is open.
 *
 * The items are props rather than children. A `children(close)` render prop
 * reads better from the outside and hands the close out to be called while the
 * items are still rendering, which is exactly what it must not be; four named
 * actions cost nothing here, since this menu is about one thing.
 */

export interface NotebookMenuProps {
	/** The open notebook's name, which every item is about. */
	name: string;
	/** No notebook open, or the loose notes, which are not a notebook. */
	disabled: boolean;
	onNewInside: () => void;
	onRename: () => void;
	onMove: () => void;
	onDelete: () => void;
}

export const NotebookMenu = ({
	name,
	disabled,
	onNewInside,
	onRename,
	onMove,
	onDelete,
}: NotebookMenuProps) => {
	const [open, setOpen] = useState(false);
	const frame = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	/** Whether closing should put the focus back where it came from. */
	const handBack = useRef(false);

	const close = () => {
		setOpen(false);
	};

	useEscape(frame, open, close);

	/**
	 * The items have gone, and focus left on a removed element is a keyboard
	 * user back at the top of the document. Not done inside `close`, so that a
	 * press somewhere else on the page — which closes this too — is not
	 * answered by snatching the focus back here.
	 */
	useEffect(() => {
		if (open) {
			handBack.current = true;
			return;
		}
		if (!handBack.current) return;
		handBack.current = false;
		button.current?.focus();
	}, [open]);

	useEffect(() => {
		if (!open) return undefined;
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && frame.current?.contains(target) === true) return;
			handBack.current = false;
			setOpen(false);
		};
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('pointerdown', away);
		};
	}, [open]);

	const chose = (act: () => void) => () => {
		close();
		act();
	};

	return (
		<div ref={frame} className="notebook-menu">
			<button
				ref={button}
				type="button"
				className="icon"
				// Named for the notebook, so a screen-reader user knows what the
				// menu is about before opening it — there is one of these and it
				// changes subject as they move around the tree.
				aria-label={disabled ? 'Notebook options' : `Options for “${name}”`}
				title="Notebook options"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => {
					setOpen((was) => !was);
				}}
			>
				{'⋯'}
			</button>
			{open && (
				<div className="notebook-menu-items" role="group" aria-label={`Notebook “${name}”`}>
					<button type="button" onClick={chose(onNewInside)}>
						{`New notebook inside “${name}”`}
					</button>
					<button type="button" onClick={chose(onRename)}>
						Rename
					</button>
					<button type="button" onClick={chose(onMove)}>
						Move
					</button>
					<button type="button" className="danger" onClick={chose(onDelete)}>
						Delete
					</button>
				</div>
			)}
		</div>
	);
};
