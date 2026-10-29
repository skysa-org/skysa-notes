import { cell } from '@skysa/core';
import { type RefObject, useEffect } from 'react';

import { useLatest } from '../../hooks/useLatest.js';

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
	busy?: boolean
): void => {
	// Read as the press ends, not subscribed on: a draw between its start and
	// its end — a parent's handler made anew — would forget where it began.
	const close = useLatest(onClose);
	const waiting = useLatest(busy);
	useEffect(() => {
		const element = backdrop.current;
		if (element === null) return undefined;
		const began = cell(false);
		const onDown = (event: PointerEvent) => {
			began.current = event.target === element;
		};
		// Let go on the dialog, the click still lands here, on what holds both.
		const onUp = (event: PointerEvent) => {
			if (event.target !== element) began.current = false;
		};
		const onClick = (event: MouseEvent) => {
			const outside = began.current && event.target === element;
			began.current = false;
			if (outside && waiting.current !== true) close.current?.();
		};
		element.addEventListener('pointerdown', onDown);
		element.addEventListener('pointerup', onUp);
		element.addEventListener('click', onClick);
		return () => {
			element.removeEventListener('pointerdown', onDown);
			element.removeEventListener('pointerup', onUp);
			element.removeEventListener('click', onClick);
		};
	}, [backdrop, close, waiting]);
};
