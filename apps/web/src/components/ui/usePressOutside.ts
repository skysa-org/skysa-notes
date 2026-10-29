import { cell } from '@skysa/core';
import { type RefObject, useEffect } from 'react';

/**
 * A press on the page around a dialog, begun there and let go there, is its
 * way out (#455): not one begun in the dialog — a drag across a field's text,
 * or a pattern's, or a row of the command palette's — that ends outside it,
 * nor one begun outside that ends in it. Not while `busy`: what the dialog is
 * doing is not to be walked away from.
 */
export const usePressOutside = (
	backdrop: RefObject<HTMLElement | null>,
	onClose: (() => void) | undefined,
	busy: boolean | undefined
): void => {
	useEffect(() => {
		const element = backdrop.current;
		if (element === null || onClose === undefined) return undefined;
		const began = cell(false);
		const onDown = (event: PointerEvent) => {
			began.current = event.target === element;
		};
		const onClick = (event: MouseEvent) => {
			const outside = began.current && event.target === element;
			began.current = false;
			if (outside && busy !== true) onClose();
		};
		element.addEventListener('pointerdown', onDown);
		element.addEventListener('click', onClick);
		return () => {
			element.removeEventListener('pointerdown', onDown);
			element.removeEventListener('click', onClick);
		};
	}, [backdrop, onClose, busy]);
};
