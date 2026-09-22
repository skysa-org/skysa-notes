import type { LanguageSupport } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

import type { LanguageSource } from './languages.js';

/**
 * Colouring the inside of a code block, in both editors.
 *
 * One highlighter and one set of class names serve rich mode and raw mode:
 * ProseMirror gets the classes as inline decorations, CodeMirror gets the same
 * object through `syntaxHighlighting`, and `styles.css` has one palette to
 * paint. Two lists of token colours that could disagree about what a keyword
 * looks like would be a bug nobody would ever see in a test.
 *
 * Classes rather than inline styles, because `style-src` allows inline styles
 * only grudgingly (docs/PLAN.md §9) and a stylesheet is where a theme belongs
 * anyway: the dark palette is a media query over the same names.
 */

/**
 * Which tags get a class, and so which get a colour.
 *
 * Deliberately short. A palette of thirty token kinds is a palette nobody can
 * hold in their head, and the notes this app is for are written *about* code
 * rather than in it — the job is to tell a keyword from a string at a glance.
 *
 * What is absent is as deliberate: markdown's own tags. This highlighter also
 * runs over raw mode, where the document *is* markdown, so anything listed
 * here that `@codemirror/lang-markdown` emits would tint the user's prose.
 * `tags.link`, `tags.url`, `tags.escape`, `tags.monospace`, `tags.heading`,
 * `tags.emphasis`, `tags.labelName` and `tags.processingInstruction` are all
 * markdown's, and none of them is here. `tags.meta` was, until the test below
 * caught it colouring the brackets of every link in raw mode — which is the
 * kind of thing this palette is one line away from doing at any time, and why
 * that test exists. Raw mode is characters; the only thing that gets colour
 * there is the inside of a fence, where another grammar has taken over.
 */
export const CODE_HIGHLIGHTER = tagHighlighter([
	{
		tag: [
			tags.keyword,
			tags.controlKeyword,
			tags.operatorKeyword,
			tags.definitionKeyword,
			tags.moduleKeyword,
			tags.modifier,
			tags.self,
		],
		class: 'tok-keyword',
	},
	{
		tag: [tags.string, tags.special(tags.string), tags.character, tags.attributeValue],
		class: 'tok-string',
	},
	{ tag: [tags.regexp], class: 'tok-regexp' },
	{ tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], class: 'tok-literal' },
	{ tag: [tags.comment], class: 'tok-comment' },
	{
		tag: [
			tags.function(tags.variableName),
			tags.function(tags.propertyName),
			tags.function(tags.definition(tags.variableName)),
			tags.macroName,
		],
		class: 'tok-function',
	},
	{ tag: [tags.typeName, tags.className, tags.namespace], class: 'tok-type' },
	{ tag: [tags.propertyName, tags.attributeName], class: 'tok-property' },
	{ tag: [tags.tagName, tags.angleBracket], class: 'tok-tag' },
	{ tag: [tags.operator, tags.derefOperator, tags.punctuation], class: 'tok-operator' },
	{ tag: [tags.invalid], class: 'tok-invalid' },
]);

/** One coloured run of a code block, as an offset into its text. */
export interface TokenRange {
	from: number;
	to: number;
	className: string;
}

/**
 * How much code is worth parsing. A grammar runs over the whole block on the
 * keystroke that changes it, and a note can hold a pasted file as easily as a
 * five-line example — past this, the block keeps its words and loses its
 * colours, which is the right way round. Roughly a 500-line source file.
 */
export const HIGHLIGHT_LIMIT = 20_000;

/** The coloured runs in a piece of code, as the grammar sees them. */
export const tokenize = (code: string, language: LanguageSupport): readonly TokenRange[] => {
	if (code.length > HIGHLIGHT_LIMIT) return [];

	const found = { current: [] as TokenRange[] };
	highlightTree(language.language.parser.parse(code), CODE_HIGHLIGHTER, (from, to, className) => {
		found.current = [...found.current, { from, to, className }];
	});
	return found.current;
};

const CODE_BLOCK = 'code_block';

/**
 * Tokens are cached against the node itself.
 *
 * A ProseMirror node is immutable, so the same object across two states is the
 * same text with the same language, and a typed character makes a new one. That
 * makes the node its own cache key — no invalidation to get wrong — and means
 * a keystroke in a paragraph re-parses none of the code blocks around it.
 */
const cache = new WeakMap<ProseNode, readonly TokenRange[]>();

const tokensOf = (node: ProseNode, language: LanguageSupport): readonly TokenRange[] => {
	const held = cache.get(node);
	if (held !== undefined) return held;

	const found = tokenize(node.textContent, language);
	cache.set(node, found);
	return found;
};

const decorate = (doc: ProseNode, languages: LanguageSource): DecorationSet => {
	const found = { current: [] as Decoration[] };

	doc.descendants((node, pos) => {
		if (node.type.name !== CODE_BLOCK) return true;

		const language = languages.get(node.attrs.language as string | undefined);
		// Not loaded yet, or not a language we know: plain text, and the view
		// below asks for the grammar if there is one to ask for.
		if (language !== undefined) {
			found.current = [
				...found.current,
				// `pos` is the block, so its text starts one position in.
				...tokensOf(node, language).map((token) =>
					Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, {
						class: token.className,
					})
				),
			];
		}
		// Nothing inside a code block is a block of its own.
		return false;
	});

	return DecorationSet.create(doc, found.current);
};

/** Every language named by a code block in the document, once each. */
const languagesIn = (doc: ProseNode): readonly string[] => {
	const found = new Set<string>();
	doc.descendants((node) => {
		if (node.type.name !== CODE_BLOCK) return true;
		const language = node.attrs.language as string | undefined;
		if (language !== undefined && language !== '') found.add(language);
		return false;
	});
	return [...found];
};

export const codeHighlightKey = new PluginKey<DecorationSet>('skysa-code-highlight');

/** The meta that says a grammar has arrived and the document can be coloured now. */
const LOADED = 'loaded';

/**
 * Colour every code block, and fetch the grammars they ask for.
 *
 * The fetch is the reason this is a plugin with a view rather than a plain
 * decoration source: a language arrives long after the document that wanted it,
 * and something has to ask the editor to draw again. It asks with a transaction
 * that changes no text, which is exactly why doing so cannot mark the note
 * dirty (`editor/dirty.ts` — a user edit is a document change first of all).
 */
export const codeHighlightPlugin = (languages: LanguageSource): Plugin<DecorationSet> => {
	const plugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
		key: codeHighlightKey,
		state: {
			init: (_config, state) => decorate(state.doc, languages),
			apply: (tr, current) => {
				if (tr.getMeta(codeHighlightKey) === LOADED) return decorate(tr.doc, languages);
				if (!tr.docChanged) return current;
				return decorate(tr.doc, languages);
			},
		},
		props: {
			decorations: (state) => plugin.getState(state),
		},
		view: (view) => {
			const alive = { current: true };

			const fetch = (doc: ProseNode) => {
				languagesIn(doc)
					.filter((info) => languages.get(info) === undefined)
					.forEach((info) => {
						void languages.load(info).then(() => {
							// The editor may be gone, and the language may have
							// been one we do not have — either way there is
							// nothing to redraw.
							if (!alive.current || languages.get(info) === undefined) return;
							view.dispatch(view.state.tr.setMeta(codeHighlightKey, LOADED));
						});
					});
			};

			fetch(view.state.doc);
			return {
				update: (updated, previous) => {
					if (updated.state.doc !== previous.doc) fetch(updated.state.doc);
				},
				destroy: () => {
					alive.current = false;
				},
			};
		},
	});

	return plugin;
};
