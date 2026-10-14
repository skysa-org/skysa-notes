import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
	type ChangeSpec,
	type EditorState,
	type Extension,
	StateEffect,
	StateField,
} from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from '@codemirror/view';
import { isSecretBlock, SECRET_LANGUAGE } from '@skysa/core';

import { t } from '../i18n/t.js';
import type { SecretHost } from './secretHost.js';
import type { SecretPanel } from './secretPanel.js';
import {
	createSecretPanels,
	DRAFT,
	insertSecret,
	leftBehind,
	lockAll,
	NOT_REVEALED,
	reveal,
	type SecretDocument,
	type SecretPanels,
} from './secretPanels.js';

/**
 * A secret in raw mode (docs/ARCHITECTURE.md §7, "Secrets in a note"): the
 * same `age` fence the rich editor draws as a closed block, shown here as it
 * is written, with Reveal on its opening line and the panel under it.
 *
 * A fence is what the markdown parser says is one, so a `` ```age `` inside
 * another fence is that fence's text. What it holds is its lines with the
 * marks of the list or quote around it taken off, as remark reads them for
 * the rich editor, and it is a secret where that reads as armor.
 *
 * The words are in a panel outside the text, as in rich mode, and kept,
 * closed and put back by the same steps (`secretPanels.ts`). Here a secret
 * is its armor's lines, and keeping new words rewrites them.
 */

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

export interface RawSecret {
	readonly armor: string;
	/** The end of the fence's opening line, where Reveal goes. */
	readonly opening: number;
	/** The armor's lines, from the start of the first to the end of the last. */
	readonly from: number;
	readonly to: number;
	/** The end of the block's last line, its closing fence's: where its panel goes. */
	readonly end: number;
	/** What each of its lines begins with: the list or quote it is in. */
	readonly prefix: string;
}

/**
 * What the lines of a fence opened after `lead` begin with: a quote's mark
 * stays, and a list's is as many spaces.
 */
const prefixFor = (lead: string): string => lead.replace(/[^>\s]/gu, ' ');

/** A line of a fence with its list's or quote's marks taken off, if it has them. */
const inside = (text: string, prefix: string): string | undefined => {
	if (text.startsWith(prefix)) return text.slice(prefix.length);
	// `>` with no space after it is still the quote.
	const bare = prefix.trimEnd();
	return text.startsWith(bare) ? text.slice(bare.length) : undefined;
};

/** The secret the fence `node` is, if it is one: one with the armor `wanted`, if asked. */
const secretAt = (state: EditorState, node: SyntaxNode, wanted?: string): RawSecret | undefined => {
	const info = node.getChild('CodeInfo');
	if (info === null) return undefined;
	// The first word, as remark reads a fence's language for the rich editor.
	const [language] = state.sliceDoc(info.from, info.to).trim().split(/\s+/u);
	if (language !== SECRET_LANGUAGE) return undefined;
	const { doc } = state;
	const open = doc.lineAt(node.from);
	const marks = node.getChildren('CodeMark');
	const closing = marks.length > 1 ? marks.at(-1) : undefined;
	// Unclosed, it runs to the end of what holds it, as the parser found.
	const last =
		closing === undefined
			? doc.lineAt(Math.max(open.to, node.to - 1))
			: doc.line(doc.lineAt(closing.from).number - 1);
	if (last.number <= open.number) return undefined;
	const prefix = prefixFor(open.text.slice(0, node.from - open.from));
	const lines = Array.from({ length: last.number - open.number }, (_, at) =>
		inside(doc.line(open.number + 1 + at).text, prefix)
	);
	if (lines.some((line) => line === undefined)) return undefined;
	const armor = lines.join('\n');
	if (wanted !== undefined && armor !== wanted) return undefined;
	if (!isSecretBlock(SECRET_LANGUAGE, armor)) return undefined;
	return {
		armor,
		opening: open.to,
		from: doc.line(open.number + 1).from,
		to: last.to,
		end: closing === undefined ? last.to : doc.lineAt(closing.from).to,
		prefix,
	};
};

/** The secrets from `from` to `to`, in the text the parser has reached: what is on screen. */
export const secretsIn = (
	state: EditorState,
	from: number,
	to: number,
	wanted?: string
): RawSecret[] => {
	const found = new Map<number, RawSecret>();
	syntaxTree(state).iterate({
		from,
		to,
		enter: (node) => {
			if (node.name !== 'FencedCode') return undefined;
			const secret = secretAt(state, node.node, wanted);
			if (secret !== undefined) found.set(node.from, secret);
			return false;
		},
	});
	return [...found.values()];
};

/**
 * Every secret in the note. The parser may not have reached the end of a long
 * one; it is asked to, for a moment, since a secret missed here would look
 * gone.
 */
export const allSecrets = (state: EditorState, wanted?: string): RawSecret[] => {
	const length = state.doc.length;
	return ensureSyntaxTree(state, length, 200) === null ? [] : secretsIn(state, 0, length, wanted);
};

/** The first secret in the note with `armor`. */
export const findRawSecret = (state: EditorState, armor: string): RawSecret | undefined =>
	allSecrets(state, armor).at(0);

/** `secret`'s armor replaced by `armor`, inside whatever holds it. */
export const rearmor = (secret: RawSecret, armor: string): ChangeSpec => ({
	from: secret.from,
	to: secret.to,
	insert: armor
		.split('\n')
		.map((line) => `${secret.prefix}${line}`)
		.join('\n'),
});

/** The fence a new secret is written as. */
const fence = (armor: string): string => `\`\`\`${SECRET_LANGUAGE}\n${armor}\n\`\`\``;

/**
 * Where a new secret goes for the cursor at `at`: after its line, or after
 * the fence it is in, since a fence written inside another would be its text.
 */
export const lineFor = (state: EditorState, at: number): number => {
	const clamped = Math.min(at, state.doc.length);
	const outer = (node: SyntaxNode | null): SyntaxNode | null => {
		if (node === null || node.name === 'FencedCode') return node;
		return outer(node.parent);
	};
	const code = outer(syntaxTree(state).resolveInner(clamped, 1));
	const line = state.doc.lineAt(clamped);
	return code === null ? line.to : state.doc.lineAt(Math.max(code.to, line.to)).to;
};

/**
 * A new secret with `armor`, as a block of its own at the line ending at
 * `end`: in place of that line, if it is empty, or after it, with a blank
 * line between it and what is either side.
 */
export const fenceAt = (state: EditorState, end: number, armor: string): ChangeSpec => {
	const { doc } = state;
	const line = doc.lineAt(end);
	const filled = (number: number) =>
		number >= 1 && number <= doc.lines && doc.line(number).text.trim() !== '';
	const after = filled(line.number + 1) ? '\n' : '';
	if (line.text.trim() !== '') return { from: line.to, insert: `\n\n${fence(armor)}${after}` };
	const before = filled(line.number - 1) ? '\n' : '';
	// The note's last line, empty: it still ends with a line break.
	const last = line.number === doc.lines && line.number > 1 ? '\n' : '';
	return { from: line.from, to: line.to, insert: `${before}${fence(armor)}${after}${last}` };
};

/**
 * `secret` taken out, with its lines: and a blank line either side of it made
 * one, as it was before a new secret went in between.
 */
const removal = (state: EditorState, secret: RawSecret): ChangeSpec => {
	const { doc } = state;
	const first = doc.lineAt(secret.opening);
	const last = doc.lineAt(secret.end);
	const above = first.number > 1 ? doc.line(first.number - 1) : undefined;
	const below = last.number < doc.lines ? doc.line(last.number + 1) : undefined;
	// The note's end: the line break before it goes, and a blank line above it.
	if (below === undefined) {
		if (above === undefined) return { from: first.from, to: last.to };
		const blankAbove = above.text.trim() === '' && above.number > 1;
		return { from: blankAbove ? doc.line(above.number - 1).to : above.to, to: last.to };
	}
	const blank = above !== undefined && above.text.trim() === '' && below.text.trim() === '';
	return { from: blank ? above.from : first.from, to: below.from };
};

/** Where a new secret's panel is: where the cursor was when it was begun. */
const setDraft = StateEffect.define<number | null>();

const draftField = StateField.define<number | null>({
	create: () => null,
	update: (at, tr) =>
		tr.effects.reduce<number | null>(
			(value, effect) => (effect.is(setDraft) ? effect.value : value),
			at === null ? null : tr.changes.mapPos(at)
		),
});

/** The panels open have changed: where each is drawn is to be worked out again. */
const panelsMoved = StateEffect.define<null>();

/**
 * Raw mode's text, as the panels ask for it. Every change is the user's edit:
 * not annotated as the app's, so the note is dirty, and saved, as when the
 * user types.
 */
const documentOf = (view: EditorView, gone: Readonly<{ current: boolean }>): SecretDocument => ({
	closed: () => gone.current,
	has: (key) => findRawSecret(view.state, key) !== undefined,
	put: (key, armor, at) => {
		const { state } = view;
		const block = key === DRAFT ? undefined : findRawSecret(state, key);
		view.dispatch({
			changes:
				block === undefined
					? fenceAt(state, lineFor(state, at ?? state.doc.length), armor)
					: rearmor(block, armor),
			effects: key === DRAFT ? setDraft.of(null) : [],
			userEvent: 'input',
		});
	},
	putBack: (key, from) => {
		const block = findRawSecret(view.state, key);
		if (block === undefined) return;
		view.dispatch({
			changes: from === undefined ? removal(view.state, block) : rearmor(block, from),
			userEvent: 'input',
		});
	},
	draftAt: () => view.state.field(draftField) ?? undefined,
	beginDraft: () => {
		view.dispatch({ effects: setDraft.of(view.state.selection.main.head) });
	},
	endDraft: () => {
		view.dispatch({ effects: setDraft.of(null) });
	},
	focus: () => {
		view.focus();
	},
});

/**
 * A widget drawing `draw()`. Its events are its own.
 *
 * CodeMirror keeps a widget's element only for the same widget, or one of the
 * same class that it `eq`s, and each of these is a class of its own: what is
 * to stay as it is drawn is kept and given again (`panelWidget`, `rawSecrets`).
 */
const widgetOf = (draw: () => HTMLElement): WidgetType => {
	class Shown extends WidgetType {
		// A method, as `WidgetType` declares it, not the function it calls.
		// eslint-disable-next-line functional/prefer-tacit
		toDOM() {
			return draw();
		}

		override ignoreEvent() {
			return true;
		}
	}
	return new Shown();
};

/**
 * Each panel's widget: one, so the panel is not drawn again as its block's
 * armor changes under it, which would take the focus from what is typed.
 */
const panelWidgets = new WeakMap<SecretPanel, WidgetType>();

/** A panel, under its secret's closing fence, or under the line a new secret goes after. */
const panelWidget = (panel: SecretPanel): WidgetType => {
	const kept = panelWidgets.get(panel);
	if (kept !== undefined) return kept;
	const widget = widgetOf(() => {
		const holder = document.createElement('div');
		holder.setAttribute('class', 'secret-raw-panel');
		holder.append(panel.dom);
		return holder;
	});
	panelWidgets.set(panel, widget);
	return widget;
};

const panelsIn = (state: EditorState, panels: SecretPanels): DecorationSet => {
	const open = panels.all();
	if (open.length === 0) return Decoration.none;
	const draft = state.field(draftField);
	return Decoration.set(
		open.flatMap(([key, { panel }]) => {
			const at =
				key === DRAFT
					? draft === null
						? undefined
						: lineFor(state, draft)
					: findRawSecret(state, key)?.end;
			if (at === undefined) return [];
			const widget = panelWidget(panel);
			return [Decoration.widget({ widget, block: true, side: 1 }).range(at)];
		}),
		true
	);
};

/** Reveal, and why it could not, at the end of a secret's opening line. */
const revealWidget = (
	armor: string,
	{ hidden, note }: { hidden: boolean; note: string },
	press: (armor: string) => Promise<void>
): WidgetType =>
	widgetOf(() => {
		const button = document.createElement('button');
		button.setAttribute('type', 'button');
		button.setAttribute('class', 'secret-reveal');
		button.toggleAttribute('hidden', hidden);
		button.append(t('editor.secret.reveal'));
		button.addEventListener('click', () => {
			button.setAttribute('disabled', '');
			void press(armor).finally(() => {
				button.removeAttribute('disabled');
			});
		});
		const said = document.createElement('span');
		said.setAttribute('class', 'secret-note');
		said.setAttribute('role', 'status');
		said.append(note);
		const bar = document.createElement('span');
		bar.setAttribute('class', 'secret-raw-bar');
		bar.append(button, said);
		return bar;
	});

/**
 * Secrets in raw mode, through the host the editor is given as it is made:
 * Reveal on each one on screen, its panel under it, a new secret begun from
 * the palette, and every panel closed as the tab locks.
 */
export const rawSecrets = (given: () => SecretHost): Extension => {
	const panels = createSecretPanels();
	const placed = StateField.define<DecorationSet>({
		create: (state) => panelsIn(state, panels),
		update: (value, tr) =>
			tr.docChanged ||
			tr.effects.some((effect) => effect.is(setDraft) || effect.is(panelsMoved))
				? panelsIn(tr.state, panels)
				: value,
		provide: (field) => EditorView.decorations.from(field),
	});
	const revealing = ViewPlugin.define(
		(view) => {
			const host = given();
			const gone = { current: false };
			const doc = documentOf(view, gone);
			/** Why a secret could not be revealed, by its armor, until it is pressed again. */
			const notes = new Map<string, string>();
			const said = () => {
				if (!gone.current) view.dispatch({ effects: panelsMoved.of(null) });
			};
			const press = async (armor: string) => {
				if (notes.delete(armor)) said();
				const problem = await reveal(doc, host, panels, armor);
				if (problem === undefined) return;
				notes.set(armor, NOT_REVEALED[problem]());
				said();
			};
			/** The Reveal bars drawn last, by what each shows: the same, drawn again, is kept. */
			const bars = { current: new Map<string, WidgetType>() };
			const draw = () => {
				const drawn = new Map<string, WidgetType>();
				const set = Decoration.set(
					view.visibleRanges.flatMap(({ from, to }) =>
						secretsIn(view.state, from, to).map((secret) => {
							const hidden =
								panels.get(secret.armor) !== undefined &&
								findRawSecret(view.state, secret.armor)?.opening === secret.opening;
							const note = notes.get(secret.armor) ?? '';
							const key = `${String(hidden)}:${note}:${secret.armor}`;
							const widget =
								bars.current.get(key) ??
								revealWidget(secret.armor, { hidden, note }, press);
							drawn.set(key, widget);
							return Decoration.widget({ widget, side: 1 }).range(secret.opening);
						})
					),
					true
				);
				bars.current = drawn;
				return set;
			};
			const shown = { current: draw() };
			const stopShowing = panels.subscribe(said);
			const stopLock = host.locked(() => {
				lockAll(doc, panels);
			});
			const stopReceiving = host.receive(() => {
				void insertSecret(doc, host, panels);
			});
			return {
				shown,
				press,
				update: (update: ViewUpdate) => {
					const moved = update.transactions.some((tr) =>
						tr.effects.some((effect) => effect.is(panelsMoved))
					);
					if (update.docChanged || update.viewportChanged || moved)
						shown.current = draw();
					if (!update.docChanged || panels.all().length === 0) return;
					// Not while CodeMirror is drawing: closing a panel draws again.
					queueMicrotask(() => {
						if (!gone.current) leftBehind(doc, panels);
					});
				},
				destroy: () => {
					gone.current = true;
					stopShowing();
					stopLock();
					stopReceiving();
					// The editor is going: the words with it.
					panels.takeAll();
				},
			};
		},
		{ decorations: (plugin) => plugin.shown.current }
	);
	return [
		draftField,
		placed,
		revealing,
		// Alt+Enter opens what the cursor is in, as on a link (`linkRaw.ts`).
		keymap.of([
			{
				key: 'Alt-Enter',
				run: (view) => {
					const plugin = view.plugin(revealing);
					const { head } = view.state.selection.main;
					const [secret] = secretsIn(view.state, head, head);
					if (plugin === null || secret === undefined) return false;
					void plugin.press(secret.armor);
					return true;
				},
			},
		]),
	];
};
