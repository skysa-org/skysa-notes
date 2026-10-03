import { useEffect } from 'react';

/**
 * A file dragged over the app where nothing takes it is refused, rather than
 * left to the browser — which opens a dropped file in place of the app, and a
 * note being written goes with it (#187). The editors take files, and
 * whatever else takes a drop says so first (`preventDefault`), so the guard
 * stands aside for both: for anything already taken, and for anything an
 * editor can be typed into, which CodeMirror accepts without saying so (an
 * editable element takes a drop by default).
 *
 * Editable as the browser reckons it: by the nearest `contenteditable`, so the
 * bars a rich editor puts inside its text (`contenteditable="false"`, which
 * ProseMirror leaves every event in to) are refused like anywhere else. And
 * from the element a text node is in, which Firefox can aim a drag at.
 */

const carriesFiles = (event: DragEvent): boolean =>
	event.dataTransfer?.types.includes('Files') === true;

const inEditor = (target: EventTarget | null): boolean => {
	const element =
		target instanceof Node && !(target instanceof Element) ? target.parentElement : target;
	return (
		element instanceof Element &&
		element.closest('[contenteditable]')?.getAttribute('contenteditable') === 'true'
	);
};

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
