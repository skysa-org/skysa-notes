import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	defaultValueCtx,
	Editor,
	editorViewCtx,
	remarkStringifyOptionsCtx,
	rootCtx,
	serializerCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { sameMarkdownStructure, STRINGIFY_OPTIONS } from '@skysa/core';
import { describe, expect, it } from 'vitest';

/**
 * The second fidelity layer from docs/ARCHITECTURE.md §7.
 *
 * `core`'s round-trip suite proves the remark pipeline keeps everything. This
 * one proves the *editor* does: the same corpus is loaded into a real Milkdown
 * instance and serialized back out of its ProseMirror document, which is a
 * narrower model than mdast and is where anything that gets dropped would be
 * dropped. The corpus is deliberately the same files, so a construct that one
 * layer covers and the other loses cannot hide.
 */

const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../packages/core/tests/markdown/fixtures'
);

const fixtures = readdirSync(fixturesDir)
	.filter((name) => name.endsWith('.md'))
	.map((name) => ({ name, source: readFileSync(join(fixturesDir, name), 'utf8') }));

/** Load markdown into a real editor and read it back out. */
const throughEditor = async (markdown: string): Promise<string> => {
	const root = document.createElement('div');
	document.body.append(root);

	const editor = await Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, root);
			ctx.set(defaultValueCtx, markdown);
			ctx.set(remarkStringifyOptionsCtx, STRINGIFY_OPTIONS);
		})
		.use(commonmark)
		.use(gfm)
		.create();

	const out = editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));

	await editor.destroy();
	root.remove();
	return out;
};

it('has a corpus to check', () => {
	expect(fixtures.length).toBeGreaterThan(5);
});

describe.each(fixtures)('$name', ({ source }) => {
	it('keeps every construct through the rich editor', async () => {
		expect(sameMarkdownStructure(source, await throughEditor(source))).toBe(true);
	});
});
