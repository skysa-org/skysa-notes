import { markdown } from '@codemirror/lang-markdown';
import { type ChangeSpec, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
	allSecrets,
	fenceAt,
	findRawSecret,
	lineFor,
	rearmor,
	secretsIn,
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

	it('puts a new secret after the cursor’s line, or in place of an empty one', () => {
		const armor = sealed('new');
		const doc = 'First line\n\nSecond line\n';
		const state = stateOf(doc);

		expect(edited(state, fenceAt(state, lineFor(state, 3), armor))).toBe(
			`First line\n\n\`\`\`age\n${armor}\n\`\`\`\n\nSecond line\n`
		);
		expect(edited(state, fenceAt(state, lineFor(state, doc.indexOf('\n\n') + 1), armor))).toBe(
			`First line\n\n\`\`\`age\n${armor}\n\`\`\`\n\nSecond line\n`
		);
		expect(edited(state, fenceAt(state, lineFor(state, doc.length), armor))).toBe(
			`First line\n\nSecond line\n\n\`\`\`age\n${armor}\n\`\`\`\n`
		);
	});

	it('puts a new secret after a fence the cursor is in, not inside it', () => {
		const armor = sealed('new');
		const doc = '```js\nlet a;\n```\n';
		const state = stateOf(doc);

		expect(edited(state, fenceAt(state, lineFor(state, doc.indexOf('let')), armor))).toBe(
			`\`\`\`js\nlet a;\n\`\`\`\n\n\`\`\`age\n${armor}\n\`\`\`\n`
		);
	});
});
