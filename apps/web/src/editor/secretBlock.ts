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
import { userEditKey } from './dirty.js';
import { iconElement } from './icons.js';
import { type SecretHost, secretHostCtx } from './secretHost.js';
import { createSecretPanel, type SecretPanel } from './secretPanel.js';

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
 * **The words never enter the document.** Revealed, they are in a panel
 * (`secretPanel.ts`) held apart from the document and from the node view
 * that shows it, in `SecretPanels`, by the armor of the block it shows.
 * Revealing and hiding dispatch nothing. What is typed is kept as the focus
 * leaves the panel, and by Done: sealed again, only where it changed, and put
 * in the block's place in one transaction — a user edit, so the note is dirty
 * then and only then, and saved as anything typed in it is. Cancel puts the
 * block back as it was revealed. A new secret ("Insert secret") is a panel in
 * a widget where it will go, and nothing typed in it inserts nothing.
 *
 * When the tab locks the source, every panel closes at once; the words in
 * any that changed are sealed and saved first, which needs only the
 * recipient, so no edit is lost to the lock. Nor to a pull: a block that
 * goes from under a panel holding new words, by a change that is not the
 * user's, has them put back where it was.
 */

export const SECRET = 'secret';

/** The key a new secret's panel is held under, which no armor can be. */
const DRAFT = '';

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

/**
 * A panel open. `from` is the armor its block had when it was revealed, which
 * Cancel puts back; none for a new secret, whose Cancel takes out the block
 * its words were kept in, if any were.
 */
interface Open {
	readonly panel: SecretPanel;
	readonly from: string | undefined;
}

/**
 * The panels open in one editor, by the armor of the block each shows — or
 * `DRAFT`, for a new secret's until its words are first kept. Apart from the
 * node views, which ProseMirror may draw again: a view drawn again shows the
 * panel its block had.
 */
export interface SecretPanels {
	readonly get: (key: string) => Open | undefined;
	readonly set: (key: string, open: Open) => void;
	/** Where `panel` is held, and what with. */
	readonly find: (panel: SecretPanel) => readonly [string, Open] | undefined;
	/** `panel` held under another key: its block's armor changed, by its own words. */
	readonly rekey: (panel: SecretPanel, key: string) => void;
	readonly remove: (panel: SecretPanel) => void;
	/** Every panel open, by its key, and none after. */
	readonly takeAll: () => readonly (readonly [string, Open])[];
	readonly all: () => readonly (readonly [string, Open])[];
	/** Every view asked to show its panel again: where the blocks are has changed. */
	readonly refresh: () => void;
	readonly subscribe: (listener: () => void) => () => void;
}

export const createSecretPanels = (): SecretPanels => {
	const open = new Map<string, Open>();
	const listeners = new Set<() => void>();
	const changed = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};
	const find = (panel: SecretPanel) =>
		[...open.entries()].find(([, each]) => each.panel === panel);
	return {
		get: (key) => open.get(key),
		set: (key, held) => {
			open.set(key, held);
			changed();
		},
		find,
		rekey: (panel, key) => {
			const found = find(panel);
			if (found === undefined) return;
			open.delete(found[0]);
			open.set(key, found[1]);
			changed();
		},
		remove: (panel) => {
			const found = find(panel);
			if (found === undefined) return;
			open.delete(found[0]);
			changed();
		},
		takeAll: () => {
			const all = [...open.entries()];
			open.clear();
			if (all.length > 0) changed();
			return all;
		},
		all: () => [...open.entries()],
		refresh: changed,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};

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
 * armor `key`, or — a new secret's first words, or a block gone, or no `key`
 * at all — as a block of its own where `at` says, or at the end of the note.
 */
const put = (
	view: EditorView,
	key: string | undefined,
	armor: string,
	at: number | undefined
): void => {
	const type = view.state.schema.nodes[SECRET];
	if (type === undefined) return;
	const { tr, doc } = view.state;
	const block = key === undefined || key === DRAFT ? undefined : findSecret(doc, key);
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

/** Each panel's keeping, one after another: a later one's words are the later words. */
const keeping = new WeakMap<SecretPanel, Promise<boolean>>();

/**
 * What is in `panel` kept, where it is new: sealed, and put in its block as
 * the user's edit, the panel left open. Whether it was, or there was nothing
 * new; not where it could not be sealed, or the panel closed meanwhile.
 */
const keep = (
	view: EditorView,
	host: SecretHost,
	panels: SecretPanels,
	panel: SecretPanel
): Promise<boolean> => {
	const after = keeping.get(panel) ?? Promise.resolve(true);
	const kept = after.then(async () => {
		if (panels.find(panel) === undefined) return false;
		if (!panel.changed()) return true;
		const words = panel.words();
		const sealed = await host.seal(words);
		// Looked for again: closed meanwhile — cancelled, or taken by the lock,
		// which keeps the words itself — it is not this to keep.
		const still = panels.find(panel);
		if (sealed.state !== 'sealed' || still === undefined || view.isDestroyed) return false;
		const [key] = still;
		// Typed in again while this was sealing: a new secret's panel moves
		// into its block's view as that is drawn, which takes the focus from it.
		const focused = panel.dom.contains(document.activeElement);
		// Held under the new armor first: the block changes under the panel as
		// it is put in, and the view showing it looks for it by that.
		panel.mark(words);
		panels.rekey(panel, sealed.armor);
		put(view, key, sealed.armor, draftAt(view.state));
		// After the view has shown it, which it does once ProseMirror has drawn.
		if (focused) {
			queueMicrotask(() => {
				panel.focus();
			});
		}
		return true;
	});
	keeping.set(
		panel,
		kept.catch(() => false)
	);
	return kept;
};

/** Done: what is in the panel kept, and the panel closed; or, where it could not be, left open. */
const done = async (
	view: EditorView,
	host: SecretHost,
	panels: SecretPanels,
	panel: SecretPanel
): Promise<void> => {
	panel.busy(true);
	const kept = await keep(view, host, panels, panel);
	panel.busy(false);
	const found = panels.find(panel);
	if (!kept || found === undefined) return;
	panels.remove(panel);
	// A new secret with nothing in it: its place let go of.
	if (found[0] === DRAFT && draftAt(view.state) !== undefined) {
		view.dispatch(view.state.tr.setMeta(draftKey, null));
	}
	view.focus();
};

/** Cancel: the panel closed, and its block put back as it was revealed. */
const cancel = (view: EditorView, panels: SecretPanels, panel: SecretPanel): void => {
	const found = panels.find(panel);
	panels.remove(panel);
	if (found === undefined) return;
	const [key, { from }] = found;
	putBack(view, key, from);
	view.focus();
};

/** The block whose armor is `key` as it was revealed: `from`, or none for a new secret. */
const putBack = (view: EditorView, key: string, from: string | undefined): void => {
	const { tr } = view.state;
	if (key === DRAFT) {
		if (draftAt(view.state) !== undefined) view.dispatch(tr.setMeta(draftKey, null));
		return;
	}
	const block = key === from ? undefined : findSecret(view.state.doc, key);
	if (block === undefined) return;
	view.dispatch(
		from === undefined
			? tr.delete(block.pos, block.pos + block.node.nodeSize)
			: tr.setNodeMarkup(block.pos, undefined, { value: from })
	);
};

const panelFor = (
	view: EditorView,
	host: SecretHost,
	panels: SecretPanels,
	words: string
): SecretPanel => {
	const panel: SecretPanel = createSecretPanel({
		words,
		onDone: () => {
			void done(view, host, panels, panel);
		},
		onLeave: () => {
			void keep(view, host, panels, panel);
		},
		onCancel: () => {
			cancel(view, panels, panel);
		},
		onCopy: host.copy,
	});
	return panel;
};

/**
 * Begin a new secret at the cursor: a panel where it will go, empty. Only
 * where one can be sealed: the host says why not, where not.
 */
export const insertSecret = async (view: EditorView, host: SecretHost, panels: SecretPanels) => {
	if (panels.get(DRAFT) === undefined && !(await host.sealable())) return;
	const begun = panels.get(DRAFT);
	if (begun !== undefined) {
		begun.panel.focus();
		return;
	}
	if (view.isDestroyed) return;
	const panel = panelFor(view, host, panels, '');
	panels.set(DRAFT, { panel, from: undefined });
	view.dispatch(view.state.tr.setMeta(draftKey, view.state.selection.from));
	panel.focus();
};

/** The slash menu's "Secret". */
export const insertSecretCommand = (ctx: Ctx): void => {
	void insertSecret(
		ctx.get(editorViewCtx),
		ctx.get(secretHostCtx.key),
		ctx.get(secretPanelsCtx.key)
	);
};

/**
 * Every panel closed as the tab locks, the words in any that changed sealed
 * and saved first. Taken out of sight at once, before the sealing, which is
 * not quick: what the lock is for is that the words are not on screen.
 */
const lockAll = (view: EditorView, host: SecretHost, panels: SecretPanels): void => {
	const at = draftAt(view.state);
	const kept = panels
		.takeAll()
		.filter(([, open]) => open.panel.changed())
		.map(([key, open]) => ({ key, words: open.panel.words() }));
	if (at !== undefined) view.dispatch(view.state.tr.setMeta(draftKey, null));
	void kept.reduce(
		(before, { key, words }) =>
			before.then(async () => {
				const sealed = await host.seal(words);
				if (sealed.state === 'sealed' && !view.isDestroyed)
					put(view, key, sealed.armor, at);
			}),
		Promise.resolve()
	);
};

/**
 * Panels whose block is no longer in the document. Gone by the user's own
 * edit, it is let go of, as anything deleted is. Gone from under it — a pull
 * that changed or removed the block — new words in it are sealed and put
 * back where the block was, beside whatever came in its place.
 */
const leftBehind = (
	view: EditorView,
	before: EditorState,
	host: SecretHost,
	panels: SecretPanels
): void => {
	const byUser = (userEditKey.getState(view.state) ?? 0) > (userEditKey.getState(before) ?? 0);
	panels.all().forEach(([key, { panel }]) => {
		if (key === DRAFT || findSecret(view.state.doc, key) !== undefined) return;
		panels.remove(panel);
		if (byUser || !panel.changed()) return;
		// After where it ended: after what came in its place, where anything did.
		const was = findSecret(before.doc, key);
		const at = was === undefined ? undefined : was.pos + was.node.nodeSize;
		void host.seal(panel.words()).then((sealed) => {
			if (sealed.state === 'sealed' && !view.isDestroyed)
				put(view, undefined, sealed.armor, at);
		});
	});
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
			const stopLock = host.locked(() => {
				lockAll(view, host, panels);
			});
			const stopReceiving = host.receive(() => {
				void insertSecret(view, host, panels);
			});
			return {
				update: (updated, before) => {
					if (updated.state.doc === before.doc || panels.all().length === 0) return;
					leftBehind(updated, before, host, panels);
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

/** Why a secret could not be revealed, said on its bar. */
const SAID: Readonly<Record<'other' | 'unreadable', () => string>> = {
	other: () => t('editor.secret.differentKey'),
	unreadable: () => t('editor.secret.unreadable'),
};

const secretView = (ctx: Ctx) => {
	// Read once, as `secretPlugin` reads them.
	const host = ctx.get(secretHostCtx.key);
	const panels = ctx.get(secretPanelsCtx.key);
	return (initial: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
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
			const armor = valueOf(held.current);
			const shown = panels.get(armor);
			if (shown !== undefined) {
				shown.panel.focus();
				return;
			}
			said.replaceChildren();
			reveal.setAttribute('disabled', '');
			void host.open(armor).then((opened) => {
				reveal.removeAttribute('disabled');
				if (opened.state === 'locked') return;
				if (opened.state !== 'opened') {
					said.replaceChildren(SAID[opened.state]());
					return;
				}
				// Revealed meanwhile, by a second press: one panel.
				if (panels.get(armor) !== undefined || view.isDestroyed) return;
				const panel = panelFor(view, host, panels, opened.words);
				panels.set(armor, { panel, from: armor });
				panel.focus();
			});
		};
		reveal.addEventListener('click', open);
		selectedKeys.set(dom, {
			open: () => {
				open();
				return true;
			},
			toBar: () => {
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
