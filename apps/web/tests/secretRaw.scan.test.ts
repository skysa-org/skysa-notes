import { markdown } from '@codemirror/lang-markdown';
import { type ChangeSpec, EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';

import {
	allSecrets,
	findRawSecret,
	placeFor,
	rearmor,
	secretsIn,
	writtenAt,
} from '../src/editor/secretRaw.js';
import { sealed } from './secretHostFake.js';

/**
 * Where raw mode finds a secret (docs/ARCHITECTURE.md §7, "Secrets in a
 * note"): an `age` fence whose lines, with the marks of the list or quote
 * around it taken off, read as armor, as remark reads them for rich mode.
 */

const stateOf = (doc: string) => EditorState.create({ doc, extensions: [markdown()] });

/** `armor` with each line after the first begun by `prefix`, as it is written in a list or quote. */
const within = (armor: string, prefix: string) => armor.split('\n').join(`\n${prefix}`);

const edited = (state: EditorState, change: ChangeSpec) =>
	state.update({ changes: change }).state.doc.toString();

describe('finding a secret', () => {
	it('finds one at the top of the note, and where its parts are', () => {
		const armor = sealed('one');
		const doc = `Before\n\n\`\`\`age\n${armor}\n\`\`\`\n\nAfter\n`;
		const [found] = allSecrets(stateOf(doc));

		expect(found?.armor).toBe(armor);
		expect(found?.opening).toBe(doc.indexOf('```age') + 6);
		expect(doc.slice(found?.from, found?.to)).toBe(armor);
		expect(doc.slice(0, found?.end).endsWith(`${armor}\n\`\`\``)).toBe(true);
		expect(found?.prefix).toBe('');
	});

	it('finds one in a list and in a quote, without their marks', () => {
		const armor = sealed('two');
		const listed = `- item\n\n  \`\`\`age\n  ${within(armor, '  ')}\n  \`\`\`\n`;
		const quoted = `> \`\`\`age\n> ${within(armor, '> ')}\n> \`\`\`\n`;
		const bare = `> \`\`\`age\n>${within(armor, '>')}\n> \`\`\`\n`;

		expect(allSecrets(stateOf(listed)).map((each) => [each.armor, each.prefix])).toEqual([
			[armor, '  '],
		]);
		expect(allSecrets(stateOf(quoted)).map((each) => [each.armor, each.prefix])).toEqual([
			[armor, '> '],
		]);
		expect(allSecrets(stateOf(bare)).map((each) => each.armor)).toEqual([armor]);
	});

	it('finds one with tildes, and with words after `age`, and one left unclosed', () => {
		const armor = sealed('three');

		expect(allSecrets(stateOf(`~~~age\n${armor}\n~~~\n`))).toHaveLength(1);
		expect(allSecrets(stateOf(`\`\`\`age note\n${armor}\n\`\`\`\n`))).toHaveLength(1);
		const open = `\`\`\`age\n${armor}\n`;
		const [unclosed] = allSecrets(stateOf(open));
		expect(unclosed?.armor).toBe(armor);
		expect(unclosed?.end).toBe(open.length - 1);
	});

	it('finds none where the fence says something else, or holds something else', () => {
		const armor = sealed('four');

		expect(allSecrets(stateOf(`\`\`\`text\n${armor}\n\`\`\`\n`))).toEqual([]);
		expect(allSecrets(stateOf(`\`\`\`ages\n${armor}\n\`\`\`\n`))).toEqual([]);
		expect(allSecrets(stateOf('```age\nnot armor\n```\n'))).toEqual([]);
		expect(allSecrets(stateOf(`    ${within(armor, '    ')}\n`))).toEqual([]);
		// Inside another fence, it is that fence's text.
		expect(allSecrets(stateOf(`\`\`\`\`md\n\`\`\`age\n${armor}\n\`\`\`\n\`\`\`\`\n`))).toEqual(
			[]
		);
	});

	it('finds one far down a long note, which the parser had not reached', () => {
		const armor = sealed('far down');
		const doc = `${'A line of words.\n\n'.repeat(30_000)}\`\`\`age\n${armor}\n\`\`\`\n`;

		expect(allSecrets(stateOf(doc)).map((each) => each.armor)).toEqual([armor]);
	});

	it('finds one however slowly the note is parsed, as on a slow phone', () => {
		const armor = sealed('far down');
		const doc = `${'A line of words.\n\n'.repeat(3_000)}\`\`\`age\n${armor}\n\`\`\`\n`;
		const state = stateOf(doc);
		// Each look at the clock a second later than the last.
		const clock = { now: Date.now() };
		const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock.now += 1000));
		try {
			expect(allSecrets(state).map((each) => each.armor)).toEqual([armor]);
		} finally {
			now.mockRestore();
		}
	});

	it('finds only what is in the range asked for', () => {
		const first = sealed('first');
		const second = sealed('second');
		const doc = `\`\`\`age\n${first}\n\`\`\`\n\ntext\n\n\`\`\`age\n${second}\n\`\`\`\n`;
		const state = stateOf(doc);

		expect(secretsIn(state, doc.indexOf('text'), doc.length).map((each) => each.armor)).toEqual(
			[second]
		);
		expect(findRawSecret(state, second)?.from).toBe(doc.indexOf(second));
		expect(findRawSecret(state, 'nothing')).toBeUndefined();
	});
});

describe('writing a secret', () => {
	it('puts new armor in a secret’s place, inside its list or quote', () => {
		const armor = sealed('old');
		const next = sealed('new words, which make a longer secret than the old');
		const listed = `- item\n\n  \`\`\`age\n  ${within(armor, '  ')}\n  \`\`\`\n`;
		const state = stateOf(listed);
		const [found] = allSecrets(state);
		if (found === undefined) throw new Error('not found');

		const after = edited(state, rearmor(found, next));

		expect(after).toBe(`- item\n\n  \`\`\`age\n  ${within(next, '  ')}\n  \`\`\`\n`);
		expect(allSecrets(stateOf(after)).map((each) => each.armor)).toEqual([next]);
	});

	/** `doc` with a new secret put where the cursor at `at` puts one, and the secrets found in it then. */
	const inserted = (doc: string, at: number, armor: string) => {
		const state = stateOf(doc);
		const place = placeFor(state, at);
		const after = edited(state, {
			from: place.from,
			to: place.to,
			insert: writtenAt(place, armor),
		});
		return { after, found: allSecrets(stateOf(after)).map((each) => each.armor) };
	};

	it('puts a new secret after the paragraph the cursor is in, or in place of an empty line', () => {
		const armor = sealed('new');
		const doc = 'First line\nsame paragraph\n\nSecond paragraph\n';
		const fenced = `\`\`\`age\n${armor}\n\`\`\``;

		expect(inserted(doc, 3, armor).after).toBe(
			`First line\nsame paragraph\n\n${fenced}\n\nSecond paragraph\n`
		);
		expect(inserted(doc, doc.indexOf('\n\n') + 1, armor).after).toBe(
			`First line\nsame paragraph\n\n${fenced}\n\nSecond paragraph\n`
		);
		expect(inserted(doc, doc.length, armor).after).toBe(`${doc}\n${fenced}\n`);
	});

	it('puts a new secret after a fence or heading the cursor is in, not inside it', () => {
		const armor = sealed('new');
		const fenced = `\`\`\`age\n${armor}\n\`\`\``;

		const code = '```js\nlet a;\n```\n';
		expect(inserted(code, code.indexOf('let'), armor).after).toBe(
			`${code.trimEnd()}\n\n${fenced}\n`
		);
		const heading = 'Title\n=====\nmore\n';
		expect(inserted(heading, 2, armor).after).toBe(`Title\n=====\n\n${fenced}\n\nmore\n`);
	});

	it('puts a new secret in the list item or quote the cursor is in, as one of its blocks', () => {
		const armor = sealed('new');

		const listed = '- one\n  more of one\n- two\n';
		const inList = inserted(listed, 3, armor);
		expect(inList.after).toBe(
			`- one\n  more of one\n\n  \`\`\`age\n  ${within(armor, '  ')}\n  \`\`\`\n\n- two\n`
		);
		expect(inList.found).toEqual([armor]);

		const quoted = '> a\n> b\n\nAfter\n';
		const inQuote = inserted(quoted, 2, armor);
		expect(inQuote.after).toBe(
			`> a\n> b\n>\n> \`\`\`age\n> ${within(armor, '> ')}\n> \`\`\`\n\nAfter\n`
		);
		expect(inQuote.found).toEqual([armor]);
	});

	it.each([
		['a fence left open', 'Text\n\n```js\ncode\n', 'code'],
		['a comment left open', 'Text\n\n<!-- note\nmore\n', 'more'],
		['a secret left open', `Text\n\n\`\`\`age\n${sealed('old')}\n`, 'BEGIN'],
	])('puts a new secret before %s, which runs to the note’s end', (_, doc, inside) => {
		const armor = sealed('new');
		const { after, found } = inserted(doc, doc.indexOf(inside), armor);

		expect(after).toBe(doc.replace('Text\n\n', `Text\n\n\`\`\`age\n${armor}\n\`\`\`\n\n`));
		expect(found).toContain(armor);
		expect(found).toHaveLength(doc.includes('```age') ? 2 : 1);
	});

	it('leaves a quote’s empty line under the block as it is, not doubled', () => {
		const armor = sealed('new');
		const quoted = '> a\n>\n> b\n';

		expect(inserted(quoted, 2, armor).after).toBe(
			`> a\n>\n> \`\`\`age\n> ${within(armor, '> ')}\n> \`\`\`\n>\n> b\n`
		);
	});

	it('goes after the whole block in a quote, where the cursor is at the end of a mark', () => {
		const armor = sealed('new');
		const quoted = '> Para *one*\n> more\n';
		const { after, found } = inserted(quoted, quoted.indexOf('\n'), armor);

		expect(after).toBe(
			`> Para *one*\n> more\n>\n> \`\`\`age\n> ${within(armor, '> ')}\n> \`\`\`\n`
		);
		expect(found).toEqual([armor]);
	});

	it('parts a new secret from the paragraph right above a fence left open', () => {
		const armor = sealed('new');
		const doc = 'Text\n```js\ncode\n';
		const { after, found } = inserted(doc, doc.indexOf('code'), armor);

		expect(after).toBe(`Text\n\n\`\`\`age\n${armor}\n\`\`\`\n\n\`\`\`js\ncode\n`);
		expect(found).toEqual([armor]);
	});

	it('keeps a new secret in the list item that holds a fence left open, before the fence', () => {
		const armor = sealed('new');
		const doc = '- item\n\n  ```js\n  code\n';
		const { after, found } = inserted(doc, doc.indexOf('code'), armor);

		expect(after).toBe(
			`- item\n\n  \`\`\`age\n  ${within(armor, '  ')}\n  \`\`\`\n\n  \`\`\`js\n  code\n`
		);
		expect(found).toEqual([armor]);
	});

	it('puts a new secret at the note’s start, before a fence left open on its first line', () => {
		const armor = sealed('new');
		const doc = '```js\ncode';
		const { after, found } = inserted(doc, doc.length, armor);

		expect(after).toBe(`\`\`\`age\n${armor}\n\`\`\`\n\n${doc}`);
		expect(found).toEqual([armor]);
	});
});
