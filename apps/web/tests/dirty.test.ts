import { EditorState, type Transaction } from '@codemirror/state';
import { type Node as ProseNode, Schema } from '@milkdown/kit/prose/model';
import { EditorState as ProseState, TextSelection } from '@milkdown/kit/prose/state';
import { describe, expect, it } from 'vitest';

import {
	isUserEdit,
	isUserTransaction,
	programmatic,
	PROGRAMMATIC_META,
	ProgrammaticChange,
	userEditKey,
	userEditPlugin,
} from '../src/editor/dirty.js';

/**
 * The rule these tests defend: opening a note, switching modes, or taking a
 * change from sync must never mark the note dirty. Only typing does.
 */

const state = EditorState.create({ doc: 'hello' });

const userTransaction = (): Transaction => state.update({ changes: { from: 5, insert: ' world' } });

const programmaticTransaction = (): Transaction =>
	state.update({ changes: { from: 0, to: 5, insert: 'loaded' }, ...programmatic });

describe('isUserEdit', () => {
	it('is true for a change the user typed', () => {
		const transaction = userTransaction();
		expect(isUserEdit({ docChanged: true, transactions: [transaction] })).toBe(true);
	});

	it('is false for a change the app loaded in', () => {
		const transaction = programmaticTransaction();
		expect(isUserEdit({ docChanged: true, transactions: [transaction] })).toBe(false);
	});

	it('is false when the document did not change', () => {
		// A cursor move or a selection change is not an edit.
		const selectionOnly = state.update({ selection: { anchor: 2 } });
		expect(isUserEdit({ docChanged: false, transactions: [selectionOnly] })).toBe(false);
	});

	it('is false when no transaction actually changed the document', () => {
		const selectionOnly = state.update({ selection: { anchor: 2 } });
		expect(isUserEdit({ docChanged: true, transactions: [selectionOnly] })).toBe(false);
	});

	it('counts a batch that mixes both as a user edit, rather than losing the edit', () => {
		expect(
			isUserEdit({
				docChanged: true,
				transactions: [programmaticTransaction(), userTransaction()],
			})
		).toBe(true);
	});

	it('ignores a programmatic transaction that changed nothing', () => {
		const marked = state.update({ selection: { anchor: 1 }, ...programmatic });
		expect(marked.annotation(ProgrammaticChange)).toBe(true);
		expect(isUserEdit({ docChanged: true, transactions: [marked] })).toBe(false);
	});
});

describe('the same rule for the rich editor', () => {
	const schema = new Schema({
		nodes: {
			doc: { content: 'paragraph+' },
			paragraph: { content: 'text*', toDOM: () => ['p', 0] },
			text: {},
		},
	});

	const stateWith = (notify: (doc: ProseNode) => void) =>
		ProseState.create({
			schema,
			doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('a')])]),
			plugins: [userEditPlugin(notify)],
		});

	const typed = (state: ProseState) => state.tr.insertText('b', 1);

	it('counts a change the user made', () => {
		const state = stateWith(() => undefined);
		const after = state.apply(typed(state));
		expect(userEditKey.getState(after)).toBe(1);
	});

	it('does not count a change the app made', () => {
		const state = stateWith(() => undefined);
		const after = state.apply(typed(state).setMeta(PROGRAMMATIC_META, true));
		expect(userEditKey.getState(after)).toBe(0);
	});

	it('does not count a transaction that changed nothing', () => {
		const state = stateWith(() => undefined);
		const after = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
		expect(userEditKey.getState(after)).toBe(0);
	});

	it('keeps counting, so an edit is not hidden by what follows it', () => {
		const state = stateWith(() => undefined);
		const once = state.apply(typed(state));
		const twice = once.apply(typed(once));
		// A plugin appending a transaction of its own must not roll the count
		// back and swallow the edit that came before it.
		const appended = twice.apply(twice.tr.setMeta('some-plugin', true));

		expect(userEditKey.getState(twice)).toBe(2);
		expect(userEditKey.getState(appended)).toBe(2);
	});

	describe('isUserTransaction', () => {
		it('is true only for an unmarked change to the document', () => {
			const state = stateWith(() => undefined);
			expect(isUserTransaction(typed(state))).toBe(true);
			expect(isUserTransaction(typed(state).setMeta(PROGRAMMATIC_META, true))).toBe(false);
			expect(isUserTransaction(state.tr)).toBe(false);
		});

		it('ignores a marker that is not ours', () => {
			const state = stateWith(() => undefined);
			expect(isUserTransaction(typed(state).setMeta('addToHistory', false))).toBe(true);
		});
	});
});
