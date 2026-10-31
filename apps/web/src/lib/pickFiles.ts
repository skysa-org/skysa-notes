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
 * of an input it is to open, and gone once it answers. Each pick is its own:
 * Chrome queues a picker asked for while another is open, so a paperclip
 * pressed twice is two pickers, one after the other, and the first one's
 * choice is still the user's. A browser that does not say when its picker was
 * closed without a choice (`cancel`, which every current browser does) leaves
 * its input in the page, hidden, until the page is left.
 */

export const pickFiles = ({
	accept,
	folder = false,
	within = document,
}: {
	accept?: string;
	/**
	 * A folder rather than files: everything in it, at every depth, each with
	 * its path from the folder in `webkitRelativePath`. For an import
	 * (`store/importLibrary.ts`). Every desktop browser takes the attribute,
	 * unprefixed name or not; a browser that does not opens a picker of files.
	 * https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory
	 */
	folder?: boolean;
	within?: Document;
} = {}): Promise<File[]> =>
	new Promise((resolve) => {
		const input = within.createElement('input');
		input.setAttribute('type', 'file');
		input.setAttribute('multiple', '');
		input.setAttribute('hidden', '');
		if (accept !== undefined) input.setAttribute('accept', accept);
		if (folder) input.setAttribute('webkitdirectory', '');
		// Once: a promise keeps the first answer, and the input is gone after it.
		const answer = (files: File[]): void => {
			input.remove();
			resolve(files);
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
