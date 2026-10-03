import { useEffect } from 'react';

/**
 * A file dragged over the app where nothing takes it is refused, rather than
 * left to the browser — which opens a dropped file in place of the app, and a
 * note being written goes with it (#187). The editors take files, and
 * whatever else takes a drop says so first (`preventDefault`), so the guard
 * stands aside for both: for anything already taken, and for anything inside
 * an editor, which CodeMirror accepts without saying so (an editable element
 * takes a drop by default).
 */

const carriesFiles = (event: DragEvent): boolean =>
	event.dataTransfer?.types.includes('Files') === true;

const inEditor = (target: EventTarget | null): boolean =>
	target instanceof Element && target.closest('[contenteditable="true"]') !== null;

const refuse = (event: DragEvent): void => {
	if (event.defaultPrevented || !carriesFiles(event) || inEditor(event.target)) return;
	event.preventDefault();
	// The browser reads the answer back off the event: there is nothing to return.
	// eslint-disable-next-line functional/immutable-data
	if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none';
};

export const useFileDropGuard = (): void => {
	useEffect(() => {
		window.addEventListener('dragover', refuse);
		window.addEventListener('drop', refuse);
		return () => {
			window.removeEventListener('dragover', refuse);
			window.removeEventListener('drop', refuse);
		};
	}, []);
};
