import type { Editor } from '@milkdown/kit/core';

import { createRichEditor, type RichEditorSetup } from '../../src/editor/rich/createRichEditor.js';

const editors: Editor[] = [];

/**
 * A rich editor (Milkdown) on a root of its own in the page. `onUserEdit`
 * defaults to nothing, for a test that only reads the document back. Destroyed
 * by `destroyRichEditors`, which the file calls from its `afterEach`: an editor
 * left running keeps its timers and listeners going into the next test.
 */
export const mountRich = async ({
	onUserEdit = () => undefined,
	...setup
}: Omit<RichEditorSetup, 'root' | 'onUserEdit'> & Partial<Pick<RichEditorSetup, 'onUserEdit'>>) => {
	const root = document.createElement('div');
	document.body.append(root);
	const editor = await createRichEditor({ ...setup, root, onUserEdit }).create();
	editors.push(editor);
	return { editor, root };
};

export const destroyRichEditors = async (): Promise<void> => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
};
