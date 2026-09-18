import { EditorState, type Transaction } from '@codemirror/state';
import { type Node as ProseNode, Schema } from '@milkdown/kit/prose/model';
import { EditorState as ProseState, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { describe, expect, it, vi } from 'vitest';

import {
	holdUserEdits,
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

	/**
	 * A plugin that tidies the document after every change, the way
	 * `prosemirror-tables` squares up a table: appended to whatever came first.
	 */
	const tidies = new Plugin({
		appendTransaction: (transactions, _before, after) =>
			transactions.some((transaction) => transaction.docChanged) &&
			after.doc.textContent.endsWith('!') === false
				? after.tr.insertText('!', after.doc.content.size - 1)
				: null,
	});

	const tidiedStateWith = (notify: (doc: ProseNode) => void) =>
		ProseState.create({
			schema,
			doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('a')])]),
			plugins: [userEditPlugin(notify), tidies],
		});

	describe('a change appended by another plugin', () => {
		it("is the app's when it follows a change the app made", () => {
			const state = tidiedStateWith(() => undefined);
			const { state: after, transactions } = state.applyTransaction(
				typed(state).setMeta(PROGRAMMATIC_META, true)
			);

			expect(transactions).toHaveLength(2);
			expect(after.doc.textContent).toBe('ba!');
			expect(userEditKey.getState(after)).toBe(0);
		});

		it("is the user's when it follows a change the user made", () => {
			const state = tidiedStateWith(() => undefined);
			const { state: after, transactions } = state.applyTransaction(typed(state));

			expect(transactions).toHaveLength(2);
			expect(userEditKey.getState(after)).toBe(2);
		});

		it("is the user's when what it follows changed nothing but the selection", () => {
			// The root is not programmatic, so the change is nobody's but theirs.
			const state = tidiedStateWith(() => undefined);
			const selection = state.tr.setSelection(TextSelection.create(state.doc, 2));
			const appended = state.tr.insertText('!', 2).setMeta('appendedTransaction', selection);

			expect(isUserTransaction(appended)).toBe(true);
		});
	});

	/**
	 * The follow-up that is *not* appended: a plugin view answering a changed
	 * document with a dispatch of its own, as Milkdown's heading-id plugin does —
	 * from its constructor for the document the editor opens with, and from
	 * inside the app's dispatch after that. The reporting plugin is deliberately
	 * listed first, which is the order in which both used to be reported.
	 */
	describe('a change another plugin dispatches for itself', () => {
		const answers = new Plugin({
			view: (view) => {
				const answer = () => {
					if (view.state.doc.textContent.endsWith('!')) return;
					view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1));
				};
				answer();
				return { update: answer };
			},
		});

		const build = () => {
			const notify = vi.fn();
			const reports = userEditPlugin(notify);
			const built = holdUserEdits(reports);
			const view = new ProseView(document.createElement('div'), {
				state: ProseState.create({
					schema,
					doc: schema.node('doc', null, [
						schema.node('paragraph', null, [schema.text('a')]),
					]),
					plugins: [reports, answers],
				}),
			});
			built();
			return { notify, reports, view };
		};

		it('is not reported while the view is being built', () => {
			const { notify, view } = build();
			expect(view.state.doc.textContent).toBe('a!');
			expect(notify).not.toHaveBeenCalled();
			view.destroy();
		});

		it('is not reported inside a dispatch the app is holding', () => {
			const { notify, reports, view } = build();

			const release = holdUserEdits(reports);
			view.dispatch(
				view.state.tr
					.replaceWith(1, view.state.doc.content.size - 1, schema.text('pulled'))
					.setMeta(PROGRAMMATIC_META, true)
			);
			release();

			expect(view.state.doc.textContent).toBe('pulled!');
			expect(notify).not.toHaveBeenCalled();
			view.destroy();
		});

		it('is reported once every hold is let go', () => {
			const { notify, reports, view } = build();

			const release = holdUserEdits(reports);
			const other = holdUserEdits(reports);
			release();
			view.dispatch(view.state.tr.insertText('b', 1));
			expect(notify).not.toHaveBeenCalled();

			other();
			view.dispatch(view.state.tr.insertText('c', 1));
			expect(notify).toHaveBeenCalled();
			view.destroy();
		});

		it("is the user's when it answers the user", () => {
			const { notify, view } = build();

			view.dispatch(
				view.state.tr.replaceWith(1, view.state.doc.content.size - 1, schema.text('typed'))
			);

			expect(view.state.doc.textContent).toBe('typed!');
			expect(notify).toHaveBeenCalled();
			view.destroy();
		});
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
