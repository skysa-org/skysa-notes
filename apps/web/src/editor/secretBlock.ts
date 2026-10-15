import { editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import type { Node as ProseNode, NodeType } from '@milkdown/kit/prose/model';
import { type EditorState, Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { insertPoint } from '@milkdown/kit/prose/transform';
import {
	Decoration,
	DecorationSet,
	type EditorView,
	type NodeView,
} from '@milkdown/kit/prose/view';
import type { MarkdownNode, NodeSchema } from '@milkdown/kit/transformer';
import { $ctx, $nodeSchema, $view } from '@milkdown/kit/utils';
import { isSecretBlock, SECRET_LANGUAGE } from '@skysa/core';

import { t } from '../i18n/t.js';
import { selectedKeys } from './attachment.js';
import { iconElement } from './icons.js';
import { secretHostCtx } from './secretHost.js';
import {
	createSecretPanels,
	DRAFT,
	insertSecret,
	leftBehind,
	lockAll,
	NOT_REVEALED,
	reveal as revealSecret,
	type SecretDocument,
	type SecretPanels,
} from './secretPanels.js';

/**
 * A secret in the rich editor (docs/ARCHITECTURE.md §7, "Secrets in a note"):
 * an `age` fence whose text reads as an armored age file, drawn as one closed
 * block that says "Secret" and offers Reveal.
 *
 * A node of its own rather than the code block it is in markdown, and an atom:
 * its armor is an attribute, not text, so a cursor never lands in it, find
 * never matches it (`findRich.ts` walks text), and it is selected, moved and
 * deleted whole. The code block's reader is told to leave such a fence alone
 * (`codeBlockWithoutSecrets`); a fence that says `age` and holds anything else
 * is still a code block.
 *
 * **The words never enter the document.** Revealed, they are in a panel held
 * apart from the document and from the node view that shows it
 * (`secretPanels.ts`, which says what Done, Cancel, leaving, the lock and a
 * pull do). Revealing and hiding dispatch nothing. A new secret's panel is in
 * a widget where it will go.
 */

export const SECRET = 'secret';

const valueOf = (node: ProseNode): string => {
	const value: unknown = node.attrs.value;
	return typeof value === 'string' ? value : '';
};

/** A fenced block that is a secret: `age`, and armor that reads (`isSecretBlock`). */
const isSecretCode = (node: MarkdownNode): boolean =>
	node.type === 'code' &&
	isSecretBlock(
		typeof node.lang === 'string' ? node.lang : null,
		typeof node.value === 'string' ? node.value : ''
	);

/** The code block's schema, with a secret's fence left to `secretSchema`. */
export const codeBlockWithoutSecrets =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		return {
			...spec,
			parseMarkdown: {
				...spec.parseMarkdown,
				match: (node) => !isSecretCode(node) && spec.parseMarkdown.match(node),
			},
		};
	};

/**
 * A block, and a leaf: the armor is an attribute, written back exactly as it
 * was read, under the fence's one word, `age`. Copied out, it is the fence's
 * text, which is what the file holds.
 */
export const secretSchema = $nodeSchema(SECRET, () => ({
	group: 'block',
	atom: true,
	selectable: true,
	draggable: true,
	attrs: { value: { validate: 'string' } },
	parseDOM: [
		{
			tag: 'pre[data-secret]',
			// Ahead of the code block's `pre`, which would take it: a secret
			// copied, cut or dragged, and pasted, is a secret still. Milkdown
			// draws pasted markdown and reads it back, so a fence pasted as
			// text comes this way too.
			priority: 60,
			getAttrs: (dom) => {
				if (!(dom instanceof HTMLElement)) return false;
				const value = dom.textContent;
				return isSecretBlock(SECRET_LANGUAGE, value) ? { value } : false;
			},
		},
	],
	toDOM: (node) => ['pre', { 'data-secret': '' }, ['code', valueOf(node)]],
	parseMarkdown: {
		match: isSecretCode,
		runner: (state, node, type) => {
			state.addNode(type, { value: typeof node.value === 'string' ? node.value : '' });
		},
	},
	toMarkdown: {
		match: (node) => node.type.name === SECRET,
		runner: (state, node) => {
			state.addNode('code', undefined, valueOf(node), { lang: SECRET_LANGUAGE });
		},
	},
}));

export const secretPanelsCtx = $ctx<SecretPanels, 'skysaSecretPanels'>(
	createSecretPanels(),
	'skysaSecretPanels'
);

const draftKey = new PluginKey<number | null>('skysa-secret-draft');

/**
 * Where a secret goes in for the cursor at `at`: in place of the empty
 * paragraph it is in, or else after the innermost block around it that can
 * hold one, or at the end of the note.
 */
const placeFor = (doc: ProseNode, at: number, type: NodeType): { from: number; to: number } => {
	const $at = doc.resolve(Math.min(at, doc.content.size));
	const { parent } = $at;
	if ($at.depth > 0 && parent.type.name === 'paragraph' && parent.content.size === 0) {
		const before = $at.before();
		const $before = doc.resolve(before);
		if ($before.parent.canReplaceWith($before.index(), $before.index() + 1, type)) {
			return { from: before, to: $at.after() };
		}
	}
	const point = insertPoint(doc, $at.pos, type);
	if (point !== null) return { from: point, to: point };
	const after = (depth: number): number => {
		if (depth <= 0) return doc.content.size;
		const pos = $at.after(depth);
		const $pos = doc.resolve(pos);
		return $pos.parent.canReplaceWith($pos.index(), $pos.index(), type)
			? pos
			: after(depth - 1);
	};
	const pos = after($at.depth);
	return { from: pos, to: pos };
};

/** The first secret in the document with `armor`, and where it is. */
const findSecret = (
	doc: ProseNode,
	armor: string
): { pos: number; node: ProseNode } | undefined => {
	const found = new Map<'it', { pos: number; node: ProseNode }>();
	doc.descendants((node, pos) => {
		if (found.has('it')) return false;
		if (node.type.name === SECRET && valueOf(node) === armor) found.set('it', { pos, node });
		return !node.isLeaf;
	});
	return found.get('it');
};

/**
 * `armor` in the document as the user's edit: in place of the block with the
 * armor `key`, or — a new secret's first words — as a block of its own where
 * `at` says, or at the end of the note.
 */
const put = (view: EditorView, key: string, armor: string, at: number | undefined): void => {
	const type = view.state.schema.nodes[SECRET];
	if (type === undefined) return;
	const { tr, doc } = view.state;
	const block = key === DRAFT ? undefined : findSecret(doc, key);
	if (block !== undefined) {
		view.dispatch(tr.setNodeMarkup(block.pos, undefined, { value: armor }));
		return;
	}
	const place =
		at === undefined
			? { from: doc.content.size, to: doc.content.size }
			: placeFor(doc, at, type);
	const placed = tr.replaceWith(place.from, place.to, type.create({ value: armor }));
	view.dispatch(key === DRAFT ? placed.setMeta(draftKey, null) : placed);
};

/** Where a new secret's panel is: where its block goes in. */
const draftAt = (state: EditorState): number | undefined => draftKey.getState(state) ?? undefined;

/** The rich editor's document, as the panels ask for it. */
const documentOf = (view: EditorView): SecretDocument => ({
	closed: () => view.isDestroyed,
	has: (key) => findSecret(view.state.doc, key) !== undefined,
	put: (key, armor, at) => {
		put(view, key, armor, at);
	},
	putBack: (key, from) => {
		const block = findSecret(view.state.doc, key);
		if (block === undefined) return;
		const { tr } = view.state;
		view.dispatch(
			from === undefined
				? tr.delete(block.pos, block.pos + block.node.nodeSize)
				: tr.setNodeMarkup(block.pos, undefined, { value: from })
		);
	},
	draftAt: () => draftAt(view.state),
	beginDraft: () => {
		view.dispatch(view.state.tr.setMeta(draftKey, view.state.selection.from));
	},
	endDraft: () => {
		view.dispatch(view.state.tr.setMeta(draftKey, null));
	},
	focus: () => {
		view.focus();
	},
});

/** The slash menu's "Secret". */
export const insertSecretCommand = (ctx: Ctx): void => {
	void insertSecret(
		documentOf(ctx.get(editorViewCtx)),
		ctx.get(secretHostCtx.key),
		ctx.get(secretPanelsCtx.key)
	);
};

/**
 * Where a new secret's panel is, and what the lock and the palette ask of the
 * editor. The panel is a widget at the block where the secret will go.
 */
export const secretPlugin = (ctx: Ctx): Plugin<number | null> => {
	// Read once, as the plugin is made: ProseMirror can draw once more as the
	// editor is torn down, after its context has gone.
	const host = ctx.get(secretHostCtx.key);
	const panels = ctx.get(secretPanelsCtx.key);
	return new Plugin<number | null>({
		key: draftKey,
		state: {
			init: () => null,
			apply: (tr, at) => {
				const meta = tr.getMeta(draftKey) as number | null | undefined;
				if (meta !== undefined) return meta;
				return at === null ? null : tr.mapping.map(at);
			},
		},
		props: {
			decorations: (state: EditorState) => {
				const at = draftAt(state);
				const open = panels.get(DRAFT);
				const type = state.schema.nodes[SECRET];
				if (at === undefined || open === undefined || type === undefined) return null;
				const place = placeFor(state.doc, at, type);
				return DecorationSet.create(state.doc, [
					// In a holder of its own: ProseMirror takes a widget's element
					// out of wherever it is when the widget goes, and the panel
					// may be in its block's view by then.
					Decoration.widget(
						place.from,
						() => {
							const holder = document.createElement('div');
							holder.setAttribute('class', 'secret-draft');
							holder.append(open.panel.dom);
							return holder;
						},
						{
							key: 'secret-draft',
							side: -1,
							ignoreSelection: true,
							stopEvent: () => true,
						}
					),
				]);
			},
		},
		view: (view) => {
			const doc = documentOf(view);
			const stopLock = host.locked(() => {
				lockAll(doc, panels);
			});
			const stopReceiving = host.receive(() => {
				void insertSecret(doc, host, panels);
			});
			return {
				update: (updated, before) => {
					if (updated.state.doc === before.doc || panels.all().length === 0) return;
					leftBehind(doc, panels);
					// A block with the same armor as the one showing a panel may
					// be the first of them now.
					panels.refresh();
				},
				destroy: () => {
					stopLock();
					stopReceiving();
					// The editor is going: the words with it.
					panels.takeAll();
				},
			};
		},
	});
};

const secretView = (ctx: Ctx) => {
	// Read once, as `secretPlugin` reads them.
	const host = ctx.get(secretHostCtx.key);
	const panels = ctx.get(secretPanelsCtx.key);
	return (initial: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
		const doc = documentOf(view);
		const held = { current: initial };
		const gone = { current: false };

		const label = document.createElement('span');
		label.setAttribute('class', 'secret-label');
		label.append(iconElement('lock'), t('editor.secret.label'));

		const reveal = document.createElement('button');
		reveal.setAttribute('type', 'button');
		reveal.setAttribute('class', 'secret-reveal');
		reveal.append(t('editor.secret.reveal'));

		const said = document.createElement('span');
		said.setAttribute('class', 'secret-note');
		said.setAttribute('role', 'status');

		const bar = document.createElement('div');
		bar.setAttribute('class', 'secret-bar');
		bar.append(label, reveal, said);

		const slot = document.createElement('div');
		slot.setAttribute('class', 'secret-slot');

		const dom = document.createElement('div');
		dom.setAttribute('class', 'secret-block');
		dom.append(bar, slot);

		/**
		 * The panel its block has, if it is the first block with that armor:
		 * a secret pasted twice is two blocks, and one panel.
		 */
		const show = () => {
			if (gone.current) return;
			const armor = valueOf(held.current);
			const open = panels.get(armor);
			const first = open === undefined ? undefined : findSecret(view.state.doc, armor);
			if (open === undefined || first === undefined || first.pos !== getPos()) {
				slot.replaceChildren();
				reveal.removeAttribute('hidden');
				return;
			}
			if (slot.firstChild !== open.panel.dom) slot.replaceChildren(open.panel.dom);
			reveal.setAttribute('hidden', '');
		};
		const stopShowing = panels.subscribe(show);
		// Not while ProseMirror is drawing: where this block is, is known after.
		const showSoon = () => {
			queueMicrotask(show);
		};

		const open = () => {
			said.replaceChildren();
			reveal.setAttribute('disabled', '');
			void revealSecret(doc, host, panels, valueOf(held.current)).then((problem) => {
				reveal.removeAttribute('disabled');
				if (problem !== undefined) said.replaceChildren(NOT_REVEALED[problem]());
			});
		};
		reveal.addEventListener('click', open);
		selectedKeys.set(dom, {
			open: () => {
				open();
				return true;
			},
			toBar: () => {
				// Revealed, its panel is where Reveal was.
				const shown = panels.get(valueOf(held.current));
				if (shown !== undefined && slot.contains(shown.panel.dom)) {
					shown.panel.focus();
					return;
				}
				reveal.focus();
			},
		});
		showSoon();

		return {
			dom,
			update: (node) => {
				if (node.type !== held.current.type) return false;
				held.current = node;
				showSoon();
				return true;
			},
			selectNode: () => {
				dom.setAttribute('data-selected', '');
			},
			deselectNode: () => {
				dom.removeAttribute('data-selected');
			},
			/** The panel and Reveal are the view's own: pressing or typing in them is not editing. */
			stopEvent: (event) =>
				event.target instanceof Node &&
				(slot.contains(event.target) || reveal.contains(event.target)),
			ignoreMutation: () => true,
			destroy: () => {
				gone.current = true;
				stopShowing();
			},
		};
	};
};

export const secretViewPlugin = $view(secretSchema.node, secretView);
