import { EditorState, type Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { isUserEdit, programmatic, ProgrammaticChange } from '../src/editor/dirty.js';

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
