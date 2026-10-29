import type { DragEvent, MouseEvent } from 'react';

import { type MenuPoint, menuPoint } from './OptionsMenu.js';

/**
 * What makes a row something to pick up and move, and to right-click for its
 * menu: a notebook's in the sidebar and a note's in the list alike. With no
 * `onPickUp` the row is not dragged; with no `onMenu` a right-click opens the
 * browser's own menu.
 */
export const pickUpProps = ({
	text,
	onPickUp,
	onCancelMove,
	onMenu,
}: {
	/** What another application receives if the row is dropped outside the window. */
	text: string;
	onPickUp: (() => void) | undefined;
	/** The drag ended without a drop. */
	onCancelMove: () => void;
	onMenu: ((at: MenuPoint) => void) | undefined;
}) => ({
	draggable: onPickUp !== undefined,
	onDragStart: (event: DragEvent<HTMLElement>) => {
		if (onPickUp === undefined) return;
		// Firefox starts no drag at all without data on it.
		// eslint-disable-next-line functional/immutable-data -- a drag is told what it allows by assigning it
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', text);
		onPickUp();
	},
	onDragEnd: onCancelMove,
	onContextMenu: (event: MouseEvent<HTMLElement>) => {
		if (onMenu === undefined) return;
		event.preventDefault();
		onMenu(menuPoint(event));
	},
});
