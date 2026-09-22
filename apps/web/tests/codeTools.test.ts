import { type Editor } from '@milkdown/kit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createCodeDisplayStore } from '../src/editor/codeDisplay.js';
import { lineStarts, NUMBERED_LINE_LIMIT } from '../src/editor/codeTools.js';
import { createRichEditor } from '../src/editor/rich.js';

/**
 * Where the numbers go, and where they stop.
 *
 * `lineStarts` is what puts each number against its own line, so it is asked
 * about the awkward shapes directly: a block ending in a newline has a last
 * line that is empty and still a line, and a block that is one long line has
 * exactly one place to put a number in.
 */

const editors: Editor[] = [];

afterEach(async () => {
	await Promise.all(editors.splice(0).map((editor) => editor.destroy()));
	document.body.replaceChildren();
});

describe('lineStarts', () => {
	it('gives one offset per line', () => {
		expect(lineStarts('one\ntwo\nthree')).toEqual([0, 4, 8]);
	});

	it('counts the empty line after a trailing break', () => {
		expect(lineStarts('one\n')).toEqual([0, 4]);
	});

	it('has a place for the first number even in an empty block', () => {
		expect(lineStarts('')).toEqual([0]);
	});
});

/**
 * A block past the limit is a pasted file, and a decoration per line of it is a
 * cost paid on every keystroke in the note for a gutter nobody is reading the
 * bottom of. The block is still shown; only the numbers are not.
 */
describe('the numbering limit', () => {
	it('leaves a very long block unnumbered', async () => {
		const root = document.createElement('div');
		document.body.append(root);
		const lines = Array.from(
			{ length: NUMBERED_LINE_LIMIT + 1 },
			(_, at) => `line ${String(at)}`
		);
		const editor = await createRichEditor({
			root,
			body: `\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
			onUserEdit: () => undefined,
			display: createCodeDisplayStore({ wrap: false, lineNumbers: true }),
		}).create();
		editors.push(editor);

		expect(root.querySelectorAll('.code-line-number')).toHaveLength(0);
		expect(root.querySelector('.code-block')?.textContent).toContain('line 2000');
	});
});
