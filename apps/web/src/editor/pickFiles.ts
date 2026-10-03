/**
 * Files the user picks to add to a note (#187), through the browser's own
 * picker: a file input, never on screen, clicked for them.
 *
 * Called from inside the press that asked for it — a toolbar button, a slash
 * menu item, a palette row — and before anything is awaited: a browser opens
 * its picker only for a page the user has just acted on. Answers the files
 * chosen, or none when the picker is closed without a choice.
 *
 * The input is in the page while the picker is open, which is what Safari asks
 * of an input it is to open, and gone once it answers. A browser that does not
 * say when its picker was closed without a choice (`cancel`) leaves the input
 * there: the next pick takes the one before it away, so there is never more
 * than one.
 */

/** How to give up on the pick before, where its picker never said it closed. */
const waiting: { current?: () => void } = {};

export const pickFiles = ({
	accept,
	within = document,
}: { accept?: string; within?: Document } = {}): Promise<File[]> =>
	new Promise((resolve) => {
		waiting.current?.();
		const input = within.createElement('input');
		input.setAttribute('type', 'file');
		input.setAttribute('multiple', '');
		input.setAttribute('hidden', '');
		if (accept !== undefined) input.setAttribute('accept', accept);
		// Once: a promise keeps the first answer, and the input is gone after it.
		const answer = (files: File[]): void => {
			input.remove();
			resolve(files);
		};
		waiting.current = () => {
			answer([]);
		};
		input.addEventListener('change', () => {
			answer(Array.from(input.files ?? []));
		});
		input.addEventListener('cancel', () => {
			answer([]);
		});
		within.body.append(input);
		input.click();
	});
