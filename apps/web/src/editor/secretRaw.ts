import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language';
import {
	type ChangeSpec,
	EditorState,
	type Extension,
	StateEffect,
	StateField,
	Text,
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
import { armor as armorOf, isSecretBlock, SECRET_LANGUAGE } from '@skysa/core';

import { t } from '../i18n/t.js';
import type { SecretHost } from './secretHost.js';
import type { SecretPanel } from './secretPanel.js';
import {
	addKeyButton,
	createSecretPanels,
	DRAFT,
	insertSecret,
	keepAll,
	leftBehind,
	lockAll,
	NOT_REVEALED,
	type NotRevealed,
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

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = ReturnType<Tree['resolveInner']>;

export interface RawSecret {
	readonly armor: string;
	/** Where its fence begins, after the marks of whatever holds it. */
	readonly start: number;
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
		start: node.from,
		opening: open.to,
		from: doc.line(open.number + 1).from,
		to: last.to,
		end: closing === undefined ? last.to : doc.lineAt(closing.from).to,
		prefix,
	};
};

/**
 * The secrets from `from` to `to`, in `tree`: by default the state's own,
 * which is as far as the parser has reached — what is on screen.
 */
export const secretsIn = (
	state: EditorState,
	from: number,
	to: number,
	wanted?: string,
	tree: Tree = syntaxTree(state)
): RawSecret[] => {
	const found = new Map<number, RawSecret>();
	tree.iterate({
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

/** Every secret in a note, by the state it is in: worked out once for each. */
const known = new WeakMap<EditorState, RawSecret[]>();

/**
 * Every secret in the note: with the armor `wanted`, if asked. The parser may
 * not have reached the end of a long note; it is asked to, for a moment,
 * since a secret missed here would look gone, and the tree it reaches the end
 * with is read, not the state's own, which stays as the state was made.
 */
export const allSecrets = (state: EditorState, wanted?: string): RawSecret[] => {
	const all =
		known.get(state) ??
		(() => {
			const length = state.doc.length;
			const tree = ensureSyntaxTree(state, length, 200);
			if (tree === null) return [];
			const found = secretsIn(state, 0, length, undefined, tree);
			known.set(state, found);
			return found;
		})();
	return wanted === undefined ? all : all.filter((secret) => secret.armor === wanted);
};

/** The first secret in the note with `armor`. */
export const findRawSecret = (state: EditorState, armor: string): RawSecret | undefined =>
	allSecrets(state, armor).at(0);

/** `text`'s lines inside whatever holds them: an empty one with no space after a mark. */
const within = (text: string, prefix: string): string =>
	text
		.split('\n')
		.map((line) => (line === '' ? prefix.trimEnd() : `${prefix}${line}`))
		.join('\n');

/** `secret`'s armor replaced by `armor`, inside whatever holds it. */
export const rearmor = (secret: RawSecret, armor: string): ChangeSpec => ({
	from: secret.from,
	to: secret.to,
	insert: within(armor, secret.prefix),
});

/** The fence a new secret is written as. */
const fence = (armor: string): string => `\`\`\`${SECRET_LANGUAGE}\n${armor}\n\`\`\``;

/**
 * Where a new secret is written: in place of `from` to `to`, its fence after
 * `pre` and before `post`, each of its lines after `prefix`. Its panel is
 * drawn there before it is: below the line `to` is on (`side` 1), or above
 * the line `from` begins (-1).
 */
export interface Place {
	readonly from: number;
	readonly to: number;
	readonly pre: string;
	readonly post: string;
	readonly prefix: string;
	readonly side: 1 | -1;
}

/** What `place` writes for a new secret with `armor`. */
export const writtenAt = (place: Place, armor: string): string =>
	`${place.pre}${within(fence(armor), place.prefix)}${place.post}`;

/** Whether line `number` is there, with something in it besides the marks of what holds it. */
const filled = (doc: Text, number: number, prefix: string): boolean => {
	if (number < 1 || number > doc.lines) return false;
	const text = doc.line(number).text.trim();
	return text !== '' && text !== prefix.trim();
};

/** After line `number`, a blank line between the fence and what is either side. */
const after = (doc: Text, number: number, prefix: string): Place => {
	const { to } = doc.line(number);
	const blank = prefix.trimEnd();
	return {
		from: to,
		to,
		pre: `\n${blank}\n`,
		post: filled(doc, number + 1, prefix) ? `\n${blank}` : '',
		prefix,
		side: 1,
	};
};

/** Before line `number`, the same. */
const before = (doc: Text, number: number, prefix: string): Place => {
	const { from } = doc.line(number);
	const blank = prefix.trimEnd();
	return {
		from,
		to: from,
		pre: filled(doc, number - 1, prefix) ? `${blank}\n` : '',
		post: `\n${blank}\n`,
		prefix,
		side: -1,
	};
};

/** In place of empty line `number`, between blocks of the note's own. */
const onBlank = (doc: Text, number: number): Place => {
	const line = doc.line(number);
	// The note's last line, empty: it still ends with a line break.
	const last = number === doc.lines && number > 1 ? '\n' : '';
	return {
		from: line.from,
		to: line.to,
		pre: filled(doc, number - 1, '') ? '\n' : '',
		post: `${filled(doc, number + 1, '') ? '\n' : ''}${last}`,
		prefix: '',
		side: 1,
	};
};

/** What holds blocks: the note, a quote, a list's item. */
const HOLDERS = new Set(['Document', 'Blockquote', 'ListItem']);

/** The block around `node` that is one of a holder's own: a paragraph, a heading, a fence, a list. */
const blockAround = (node: SyntaxNode | null): SyntaxNode | null => {
	if (node === null || node.parent === null) return null;
	return HOLDERS.has(node.parent.name) ? node : blockAround(node.parent);
};

/** The block around `node` that is the note's own. */
const outermost = (node: SyntaxNode): SyntaxNode =>
	node.parent === null || node.parent.parent === null ? node : outermost(node.parent);

/**
 * Where a new secret could go for the cursor at `at`, best first: after the
 * block the cursor is in, as rich mode puts one, inside the list or quote
 * that holds it; before it, where it runs to the end of the note open, as an
 * unclosed fence or comment does; then the same around the note's own block;
 * then the note's end.
 */
const placesFor = (state: EditorState, at: number): Place[] => {
	const { doc } = state;
	const line = doc.lineAt(Math.min(at, doc.length));
	const tree = ensureSyntaxTree(state, line.to, 200) ?? syntaxTree(state);
	const block = blockAround(tree.resolveInner(line.to, -1));
	const end = doc.line(doc.lines);
	const atEnd = end.text.trim() === '' ? onBlank(doc, end.number) : after(doc, end.number, '');
	if (block === null) {
		return [
			line.text.trim() === '' ? onBlank(doc, line.number) : after(doc, line.number, ''),
			atEnd,
		];
	}
	const lines = (node: SyntaxNode) =>
		[
			doc.lineAt(node.from).number,
			doc.lineAt(Math.max(node.from, node.to - 1)).number,
		] as const;
	const [first, last] = lines(block);
	const prefix = prefixFor(doc.sliceString(doc.lineAt(block.from).from, block.from));
	const [top, bottom] = lines(outermost(block));
	return [
		after(doc, last, prefix),
		before(doc, first, prefix),
		after(doc, bottom, ''),
		before(doc, top, ''),
		atEnd,
	];
};

/** Armor to try a place with: any will do, as the parser reads a fence by its marks. */
const TRIED = armorOf(new Uint8Array(1)).replace(/\n$/u, '');

/**
 * Whether a new secret at `place` would be one, as the note is parsed with it
 * there: nothing, where that cannot be told in time.
 */
const holds = (state: EditorState, place: Place): boolean | undefined => {
	const parsing = state.facet(language);
	if (parsing === null) return undefined;
	const insert = writtenAt(place, TRIED);
	const doc = state.doc.replace(place.from, place.to, Text.of(insert.split('\n')));
	// A state of its own: the editor's would draw this note's panels for it.
	const tried = EditorState.create({ doc, extensions: parsing.extension });
	const tree = ensureSyntaxTree(tried, doc.length, 200);
	if (tree === null) return undefined;
	return secretsIn(tried, place.from, place.from + insert.length, TRIED, tree).length > 0;
};

/** Where a new secret goes, by the state and the cursor: worked out once for each. */
const placed = new WeakMap<EditorState, Map<number, Place>>();

/** Where a new secret goes for the cursor at `at`: the first place it would be one. */
export const placeFor = (state: EditorState, at: number): Place => {
	const each = placed.get(state) ?? new Map<number, Place>();
	placed.set(state, each);
	const kept = each.get(at);
	if (kept !== undefined) return kept;
	const places = placesFor(state, at);
	const [first] = places;
	const place = places.find((tried) => holds(state, tried) !== false) ?? first;
	if (place === undefined) throw new Error('a note has a line');
	each.set(at, place);
	return place;
};

/** What a new secret's first words replaced, and what was written around its fence. */
interface Written {
	readonly replaced: string;
	readonly pre: string;
	readonly post: string;
}

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

/**
 * A new secret taken out as it went in, where what was written around it is
 * still there; or else as `removal` takes one out.
 */
const takenOut = (state: EditorState, secret: RawSecret, written?: Written): ChangeSpec => {
	if (written === undefined) return removal(state, secret);
	const start = state.doc.lineAt(secret.opening).from;
	const from = start - written.pre.length;
	const to = secret.end + written.post.length;
	const around =
		from >= 0 &&
		to <= state.doc.length &&
		state.sliceDoc(from, start) === written.pre &&
		state.sliceDoc(secret.end, to) === written.post;
	return around ? { from, to, insert: written.replaced } : removal(state, secret);
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
 * user types. What is kept is typing (`input.type`), so the history joins
 * one word after another as it joins them typed in the note. A new secret's
 * fence is not, so it begins a step of its own rather than joining what was
 * typed in the note just before; Cancel is an edit of its own.
 */
const documentOf = (view: EditorView, gone: Readonly<{ current: boolean }>): SecretDocument => {
	/** What each new secret's first words wrote, by its armor now, so Cancel puts the note back as it was. */
	const written = new Map<string, Written>();
	return {
		closed: () => gone.current,
		has: (key) => findRawSecret(view.state, key) !== undefined,
		put: (key, armor, at) => {
			const { state } = view;
			const block = key === DRAFT ? undefined : findRawSecret(state, key);
			const effects = key === DRAFT ? setDraft.of(null) : [];
			if (block === undefined) {
				const place = placeFor(state, at ?? state.doc.length);
				written.set(armor, {
					replaced: state.sliceDoc(place.from, place.to),
					pre: place.pre,
					post: place.post,
				});
				view.dispatch({
					changes: { from: place.from, to: place.to, insert: writtenAt(place, armor) },
					effects,
					userEvent: 'input',
				});
				return;
			}
			const made = written.get(key);
			if (made !== undefined) {
				written.delete(key);
				written.set(armor, made);
			}
			view.dispatch({ changes: rearmor(block, armor), effects, userEvent: 'input.type' });
		},
		putBack: (key, from) => {
			const { state } = view;
			const block = findRawSecret(state, key);
			const made = written.get(key);
			written.delete(key);
			if (block === undefined) return;
			view.dispatch({
				changes: from === undefined ? takenOut(state, block, made) : rearmor(block, from),
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
	};
};

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
			const place = key === DRAFT && draft !== null ? placeFor(state, draft) : undefined;
			const at =
				key === DRAFT
					? place && (place.side === 1 ? place.to : place.from)
					: findRawSecret(state, key)?.end;
			if (at === undefined) return [];
			const widget = panelWidget(panel);
			const side = place?.side ?? 1;
			return [Decoration.widget({ widget, block: true, side }).range(at)];
		}),
		true
	);
};

/**
 * Reveal, and why it could not, at the end of a secret's opening line; and
 * "Add its key", where it was made with a key the device does not have.
 */
const revealWidget = (
	armor: string,
	{ hidden, problem }: { hidden: boolean; problem: NotRevealed | undefined },
	press: (armor: string) => Promise<void>,
	host: SecretHost
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
		said.append(problem === undefined ? '' : NOT_REVEALED[problem]());
		const bar = document.createElement('span');
		bar.setAttribute('class', 'secret-raw-bar');
		bar.append(button, said);
		if (problem === 'other') {
			bar.append(
				addKeyButton(host, armor, () => {
					void press(armor);
				})
			);
		}
		return bar;
	});

/** What is in each editor's panels kept, by the editor: what it does as it goes. */
const keepers = new WeakMap<EditorView, () => void>();

/**
 * What is typed in `view`'s panels kept, a character an input method is
 * still composing with it, before the editor goes: once it has, the words
 * would go with it. Its owner calls it while the editor is there to take
 * the edit and whatever saves the note is there to save it.
 */
export const keepSecrets = (view: EditorView): void => {
	keepers.get(view)?.();
};

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
			const notes = new Map<string, NotRevealed>();
			const said = () => {
				if (!gone.current) view.dispatch({ effects: panelsMoved.of(null) });
			};
			const press = async (armor: string) => {
				if (notes.delete(armor)) said();
				const problem = await reveal(doc, host, panels, armor);
				if (problem === undefined) return;
				notes.set(armor, problem);
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
							const problem = notes.get(secret.armor);
							const key = `${String(hidden)}:${problem ?? ''}:${secret.armor}`;
							const widget =
								bars.current.get(key) ??
								revealWidget(secret.armor, { hidden, problem }, press, host);
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
			keepers.set(view, () => {
				keepAll(doc, panels);
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
					keepers.delete(view);
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
