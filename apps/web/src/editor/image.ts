import type { Ctx } from '@milkdown/kit/ctx';
import { imageSchema } from '@milkdown/kit/preset/commonmark';
import { Fragment, type Node as ProseNode, type Schema, Slice } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView, NodeView } from '@milkdown/kit/prose/view';
import type { NodeSchema } from '@milkdown/kit/transformer';
import { $prose, $view } from '@milkdown/kit/utils';
import { classifyHref } from '@skysa/core';

import { t } from '../i18n/t.js';
import { attachHostCtx, type AttachmentHost, type Shown } from './attachHost.js';
import { barButton, nameIn, selectedKeys } from './attachment.js';
import { openFile, saveFile } from './fileActions.js';

/**
 * A picture in a note (#187), shown where the markdown says it is.
 *
 * Milkdown's image is an `<img>` with the `src` as written, which for a file
 * beside the note — `photo-1a2b3c4d.png` — is a request to the app's own
 * origin for a file that is not there. This view asks the editor's host for
 * the picture instead (`attachHost.ts`), the first time it scrolls into view,
 * and says in words why it cannot be shown where it cannot.
 *
 * Showing a picture never dispatches. What the user sees of one is never an
 * edit, and the dirty rule (a note is dirty only on a user's editing
 * transaction) would be one careless line away from broken. The one edit it
 * makes is the user's own: Remove from note, on the bar a picture selected
 * whole shows, as a chip's does (2026-10-04). On an Android phone a picture
 * tapped, and outlined as selected, stayed put on Backspace — the keyboard
 * edits the page's text, and a picture is none — so a phone needs a way to take
 * one out that is not a key.
 *
 * On the web (`https:`) and in the link itself (`data:`), the address is the
 * picture's, and the `<img>` loads it, sending no referrer: which note a
 * picture was looked at from is nobody's business. Any other address — `http:`,
 * which the page's CSP refuses anyway, a path from the root, another scheme —
 * is not loaded at all.
 */

type State = Shown['state'] | 'loading' | 'blocked' | 'broken';

/** What is said under a picture that is not shown: its alt text, where it has one, and why. */
const REASONS: Readonly<Partial<Record<State, (alt: string) => string>>> = {
	missing: (alt) =>
		alt === ''
			? t('editor.image.status.missing.unnamed')
			: t('editor.image.status.missing.named', { name: alt }),
	offline: (alt) =>
		alt === ''
			? t('editor.image.status.offline.unnamed')
			: t('editor.image.status.offline.named', { name: alt }),
	unavailable: (alt) =>
		alt === ''
			? t('editor.image.status.unavailable.unnamed')
			: t('editor.image.status.unavailable.named', { name: alt }),
	failed: (alt) =>
		alt === ''
			? t('editor.image.status.failed.unnamed')
			: t('editor.image.status.failed.named', { name: alt }),
	unsupported: (alt) =>
		alt === ''
			? t('editor.image.status.unsupported.unnamed')
			: t('editor.image.status.unsupported.named', { name: alt }),
	blocked: (alt) =>
		alt === ''
			? t('editor.image.status.blocked.unnamed')
			: t('editor.image.status.blocked.named', { name: alt }),
	broken: (alt) =>
		alt === ''
			? t('editor.image.status.broken.unnamed')
			: t('editor.image.status.broken.named', { name: alt }),
};

/** What the button under a picture that is not shown does about it, where anything can. */
const OFFERS: Readonly<Partial<Record<State, string>>> = {
	large: t('editor.image.show'),
	failed: t('common.tryAgain'),
	offline: t('common.tryAgain'),
};

/** A size in megabytes, to a tenth of one. */
const megabytes = (size: number): number => Math.round((size / (1024 * 1024)) * 10) / 10;

const attributeOf = (node: ProseNode, name: 'src' | 'alt' | 'title'): string => {
	const value: unknown = node.attrs[name];
	return typeof value === 'string' ? value : '';
};

/**
 * The nearest of `element` and its ancestors that scrolls, or none where the
 * page itself does. An observer's margin widens only its root: watched against
 * the viewport, a picture in an editor that scrolls inside the page is not
 * seen until it is on screen, however wide the margin.
 */
const scrollerOf = (element: Element | null): Element | null => {
	if (element === null) return null;
	const { overflowY } = getComputedStyle(element);
	return /^(?:auto|scroll|overlay)$/.test(overflowY)
		? element
		: scrollerOf(element.parentElement);
};

/**
 * Start `work` once `element` is within a screen of being seen in `editor`, or
 * at once where nothing can say when.
 */
const whenVisible = (element: Element, editor: Element, work: () => void): (() => void) => {
	if (typeof IntersectionObserver === 'undefined') {
		work();
		return () => undefined;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			work();
		},
		// A screen ahead, so a picture is on its way before it is reached.
		{ root: scrollerOf(editor), rootMargin: '100% 0px' }
	);
	observer.observe(element);
	return () => {
		observer.disconnect();
	};
};

const imageView =
	(host: AttachmentHost, view: EditorView, getPos: () => number | undefined) =>
	(initial: ProseNode): NodeView => {
		const editor = view.dom;
		const held = { current: initial };
		// What the picture shown is, and how to let go of it: the request out
		// for it, the URL it was drawn from, the wait for it to be on screen.
		const showing = {
			current: { src: '', stop: (): void => undefined },
		};
		const state = { current: 'loading' as State };
		// A large picture's size, kept for saying it again when the alt changes.
		const size = { current: 0 };
		// The user asked for this one whatever its size (Show). Kept for asking
		// again — Try again, a notice — until the link names another picture.
		const wanted = { current: false };

		const img = document.createElement('img');
		img.setAttribute('referrerpolicy', 'no-referrer');
		img.setAttribute('decoding', 'async');
		const reason = document.createElement('span');
		reason.setAttribute('class', 'note-image-status');
		const action = document.createElement('button');
		action.setAttribute('type', 'button');
		action.setAttribute('class', 'note-image-action');
		action.setAttribute('hidden', '');

		const opener = barButton('open', t('editor.image.openFull'));
		const saver = barButton('download', t('editor.attachment.download'));
		const remover = barButton('trash', t('editor.attachment.remove'));
		const actions = document.createElement('span');
		actions.setAttribute('class', 'attachment-actions note-image-actions');
		actions.setAttribute('hidden', '');
		actions.append(opener, saver, remover);

		const dom = document.createElement('span');
		dom.setAttribute('class', 'note-image');
		dom.append(img, reason, action, actions);

		const reasonFor = (next: State, alt: string): string | undefined => {
			const mb = megabytes(size.current);
			if (next === 'large') {
				return alt === ''
					? t('editor.image.status.large.unnamed', { size: mb })
					: t('editor.image.status.large.named', { name: alt, size: mb });
			}
			// A download the user waits on, which may be long, says so.
			if (next === 'loading' && wanted.current) {
				return alt === ''
					? t('editor.image.status.downloading.unnamed', { size: mb })
					: t('editor.image.status.downloading.named', { name: alt, size: mb });
			}
			return REASONS[next]?.(alt);
		};

		const say = (next: State, bytes?: number) => {
			if (bytes !== undefined) size.current = bytes;
			state.current = next;
			dom.setAttribute('data-state', next);
			if (next === 'loading') dom.setAttribute('aria-busy', 'true');
			else dom.removeAttribute('aria-busy');
			reason.replaceChildren(reasonFor(next, attributeOf(held.current, 'alt')) ?? '');
			const offer = OFFERS[next];
			action.toggleAttribute('hidden', offer === undefined);
			action.replaceChildren(offer ?? '');
		};

		const draw = (url: string) => {
			img.setAttribute('src', url);
			say('ready');
		};

		/** Ask the host for the picture, and show whatever it answers. */
		const ask = (src: string, large: boolean): (() => void) => {
			const asking = new AbortController();
			const kept = { current: (): void => undefined };
			say('loading');
			void host
				.show(src, { signal: asking.signal, large })
				// A host that throws — a store that cannot be read — is a picture
				// that could not be got, and worth asking for again.
				.catch((): Shown => ({ state: 'failed' }))
				.then((shown) => {
					if (asking.signal.aborted) {
						if (shown.state === 'ready') shown.release();
						return;
					}
					if (shown.state === 'ready') {
						kept.current = shown.release;
						draw(shown.url);
						return;
					}
					say(shown.state, shown.state === 'large' ? shown.size : undefined);
				});
			return () => {
				asking.abort();
				kept.current();
			};
		};

		/** Show what `src` says, letting go of whatever was shown before. */
		const show = (src: string) => {
			showing.current.stop();
			showing.current = { src, stop: () => undefined };
			img.removeAttribute('src');
			const kind = classifyHref(src);
			if (kind === 'https' || kind === 'data') {
				draw(src);
				return;
			}
			if (kind === 'other') {
				say('blocked');
				return;
			}
			say('loading');
			const asked = { current: (): void => undefined };
			const unwatch = whenVisible(dom, editor, () => {
				asked.current = ask(src, wanted.current);
			});
			showing.current = {
				src,
				stop: () => {
					unwatch();
					asked.current();
				},
			};
		};

		/**
		 * A picture beside the note, which opens full size and saves as a
		 * chip's file does. One on the web, or in the link, does neither: it is
		 * not the note's to hand over.
		 */
		const own = () => classifyHref(attributeOf(held.current, 'src')) === 'relative';

		const describe = () => {
			const alt = attributeOf(held.current, 'alt');
			const title = attributeOf(held.current, 'title');
			img.setAttribute('alt', alt);
			if (title === '') img.removeAttribute('title');
			else img.setAttribute('title', title);
			opener.toggleAttribute('hidden', !own());
			saver.toggleAttribute('hidden', !own());
		};

		/** The file, as a chip asks for one: by the name the user knows it by. */
		const request = () => {
			const src = attributeOf(held.current, 'src');
			const alt = attributeOf(held.current, 'alt');
			return { host, href: src, label: alt === '' ? nameIn(src) : alt };
		};

		/** Say the bar is busy while `work` runs: the whole picture may be a download. */
		const busy = (work: () => Promise<void>) => {
			actions.setAttribute('aria-busy', 'true');
			void work().finally(() => {
				actions.removeAttribute('aria-busy');
			});
		};

		/** In a tab of its own, at the size it is, whatever this view shows of it. */
		const openFull = (): boolean => {
			if (!own()) return false;
			busy(() => openFile(request()));
			return true;
		};

		img.addEventListener('error', () => {
			if (img.hasAttribute('src')) say('broken');
		});
		action.addEventListener('mousedown', (event) => {
			// The editor's selection stays where it was.
			event.preventDefault();
		});
		action.addEventListener('click', () => {
			if (state.current === 'large') wanted.current = true;
			show(showing.current.src);
		});
		actions.addEventListener('mousedown', (event) => {
			// The picture stays selected, and with it the bar.
			event.preventDefault();
		});
		opener.addEventListener('click', () => {
			openFull();
		});
		saver.addEventListener('click', () => {
			busy(() => saveFile(request()));
		});
		// Back to the picture, still selected, from a bar reached with Tab.
		actions.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			view.focus();
		});
		selectedKeys.set(dom, {
			open: openFull,
			toBar: () => {
				(own() ? opener : remover).focus();
			},
		});
		// The user taking the picture out of the note: an edit like any other,
		// so the note is dirty and saved.
		remover.addEventListener('click', () => {
			const at = getPos();
			if (at === undefined) return;
			view.dispatch(view.state.tr.delete(at, at + held.current.nodeSize));
			view.focus();
		});

		// What a link resolves to can change under a picture that is not shown —
		// a file that arrives with a pull, a network that comes back — and is
		// asked again then. One that is shown is the file it was, wherever the
		// note goes: a move takes its files with it.
		const unsubscribe = host.changed(() => {
			if (state.current !== 'ready') show(showing.current.src);
		});

		describe();
		show(attributeOf(initial, 'src'));

		return {
			dom,

			// Only ever handed an image: ProseMirror offers a view a node of
			// another type only when its spec says `multiType`.
			update: (node) => {
				const before = attributeOf(held.current, 'src');
				held.current = node;
				describe();
				if (attributeOf(node, 'src') !== before) {
					wanted.current = false;
					show(attributeOf(node, 'src'));
					return true;
				}
				// The alt text may have changed, and with it what is said.
				if (state.current !== 'ready') say(state.current);
				return true;
			},

			// What ProseMirror does for a node selected whole, and the bar.
			selectNode: () => {
				dom.classList.add('ProseMirror-selectednode');
				actions.removeAttribute('hidden');
			},

			deselectNode: () => {
				dom.classList.remove('ProseMirror-selectednode');
				actions.setAttribute('hidden', '');
			},

			/** The buttons are the view's own; pressing one is not editing. */
			stopEvent: (event) =>
				event.target === action ||
				(event.target instanceof Node && actions.contains(event.target)),

			destroy: () => {
				unsubscribe();
				showing.current.stop();
			},
		};
	};

export const imageViewPlugin = $view(
	imageSchema.node,
	(ctx: Ctx) => (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
		imageView(ctx.get(attachHostCtx.key), view, getPos)(node)
);

/**
 * Where an `<img>` cannot have come from anything a person could open again:
 * a picture copied out of another app carries one of these, which no page can
 * load, and kept, it would be a link to nothing in the user's file.
 */
const UNLOADABLE = /^\s*(?:blob|webkit-fake-url|file):/i;

const unloadable = (node: ProseNode): boolean =>
	node.type.name === 'image' && UNLOADABLE.test(attributeOf(node, 'src'));

/** `fragment` with each picture no page can load as its alt text, or nothing. */
const inWords = (fragment: Fragment, schema: Schema): Fragment =>
	Fragment.from(
		fragment.content.flatMap((node): ProseNode[] => {
			if (!unloadable(node))
				return [node.isLeaf ? node : node.copy(inWords(node.content, schema))];
			const alt = attributeOf(node, 'alt');
			return alt === '' ? [] : [schema.text(alt, node.marks)];
		})
	);

/**
 * A pasted picture whose source no page can load (`UNLOADABLE`) — Word's and
 * Outlook's `file:` pictures, a web app's `blob:` preview — is kept as its alt
 * text: the words were the author's, and the address is nothing. Not for a
 * picture dragged within the note, which is the user's own and only moving.
 * And not where that would leave nothing: a paste that only deleted what it
 * replaced would be worse than a picture saying it cannot be loaded.
 */
export const unloadablePicturesInWords = $prose(
	() =>
		new Plugin({
			key: new PluginKey('SKYSA_UNLOADABLE_PICTURES'),
			props: {
				transformPasted: (slice, view) => {
					if (view.dragging !== null) return slice;
					const content = inWords(slice.content, view.state.schema);
					if (content.size === 0 && slice.content.size > 0) return slice;
					return new Slice(content, slice.openStart, slice.openEnd);
				},
			},
		})
);

/** A picture's attribute as remark read it, or the schema's own default where it has none. */
const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Milkdown's image, read from markdown and from and to the DOM — the
 * clipboard — with three changes:
 *
 * - Read from markdown, a picture with no title has the title `''`, not the
 *   `null` remark gives it. The schema says a title is a string, and
 *   ProseMirror checks that as a node is made from 1.25.12, not only when a
 *   document is checked: Milkdown's own reader handed it `null`, the parse
 *   threw, and every note with a picture in it failed the rich editor's check
 *   once it was opened again — a picture just put in was made with `''`, and
 *   was fine until then (2026-10-04). Its alt the same, for a picture remark
 *   gives none. Nothing is written differently: an empty title was never
 *   written.
 *
 * - An `alt` is not copied into `title` when an `<img>` is pasted. Milkdown's
 *   own rule does, and a picture pasted from a web page came back
 *   `![a cat](cat.png "a cat")`: a title nobody wrote.
 * - A picture this app's file is drawn from is written as `data-src`, not
 *   `src`. Copied out as HTML, an `<img src="photo.png">` is a request to
 *   whatever page it is pasted into for a file relative to that page; and read
 *   back, `data-src` is what it was. Any other is written with the same
 *   `referrerpolicy` the view loads it with.
 *
 * https://github.com/Milkdown/milkdown/blob/v7.22.1/packages/plugins/preset-commonmark/src/node/image.ts
 * https://github.com/ProseMirror/prosemirror-model/blob/1.25.12/src/schema.ts (`computeAttrs`)
 */
export const imageWithoutStrayTitles =
	(schema: (ctx: Ctx) => NodeSchema) =>
	(ctx: Ctx): NodeSchema => {
		const spec = schema(ctx);
		return {
			...spec,
			parseMarkdown: {
				...spec.parseMarkdown,
				runner: (state, node, type) => {
					state.addNode(type, {
						src: stringOf(node.url),
						alt: stringOf(node.alt),
						title: stringOf(node.title),
					});
				},
			},
			parseDOM: [
				{
					tag: 'img',
					getAttrs: (dom) => {
						if (!(dom instanceof HTMLElement)) return false;
						const src = dom.getAttribute('src') ?? dom.getAttribute('data-src') ?? '';
						if (src === '') return false;
						return {
							src,
							alt: dom.getAttribute('alt') ?? '',
							title: dom.getAttribute('title') ?? '',
						};
					},
				},
			],
			toDOM: (node) => {
				const src = attributeOf(node, 'src');
				const own = classifyHref(src) === 'relative';
				return [
					'img',
					{
						...(own ? { 'data-src': src } : { src, referrerpolicy: 'no-referrer' }),
						alt: attributeOf(node, 'alt'),
						...(attributeOf(node, 'title') === ''
							? {}
							: { title: attributeOf(node, 'title') }),
					},
				];
			},
		};
	};
