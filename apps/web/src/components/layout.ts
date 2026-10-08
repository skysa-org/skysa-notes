import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * How much room there is, asked of the browser rather than worked out — and
 * asked of the thing that needs the room, wherever that is not the window.
 *
 * **The window** decides one thing: whether it is compact, which changes what
 * is *rendered* — a different bar across the top, the side columns as
 * dropdowns. That lives here and not in the stylesheet, because a width
 * decided twice — once in a media query and once in a component — is two
 * answers that can disagree by a pixel, and at that pixel the sidebar would
 * be a column and a dropdown at once. So the components ask here, and the
 * stylesheet follows a class the route sets (`.app-frame.compact`).
 *
 * **Everything else** is sized by the room its own part of the screen has,
 * not the window: the same window gives the note very different room with the
 * columns beside it and without them, and a rule keyed to the window hid
 * things that had room for them. What only changes how something looks is a
 * container query in the stylesheet (`@container note`); what changes what is
 * rendered, or what a control says it is doing, is measured here
 * (`useElementWidth`), since a container query has no answer a component can
 * read.
 *
 * Every query is phrased as the *smaller* case, so that a browser with no
 * `matchMedia` — jsdom, in every test — answers "no" and gets the layout the
 * app has always had.
 */

/**
 * Narrow enough that the three panes do not fit side by side. The notebooks and
 * the notes become dropdowns in the bar, and the note takes the whole window.
 *
 * 60rem because it is where the stacked layout this replaced began: at that
 * width the two narrowed side columns are about 26rem between them, and the
 * note beside them is already narrower than either of them was at full size.
 */
export const COMPACT = '(max-width: 60rem)';

/** A finger rather than a mouse: where focusing an editor raises a keyboard. */
export const COARSE_POINTER = '(pointer: coarse)';

/**
 * The note's own width, in rems, at which the outline starts open: a 13rem
 * rail beside a note of 40rem or so. It is the room the note had beside the
 * two columns in a 1400px window, and is now the same rule wherever that room
 * comes from.
 */
export const OUTLINE_OPENS_AT = 53.5;

/**
 * The note's own width, in rems, below which the outline is not offered at
 * all: the rail would leave the note narrower than it is itself.
 */
export const OUTLINE_FITS_AT = 36;

const noSubscription = () => () => undefined;

/** Rems, in pixels, against the root font size the stylesheet's rems use. */
export const rems = (count: number): number => {
	const root =
		typeof document === 'undefined'
			? Number.NaN
			: Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
	return count * (Number.isFinite(root) && root > 0 ? root : 16);
};

/**
 * An element's width, and a re-render whenever it changes, or `undefined`
 * until there is an element with a width to report.
 *
 * `undefined` is also what jsdom gets, having no layout, and the callers read
 * it as "plenty of room" — so every test that does not ask for a width gets
 * the layout the app has always had, as it does from `useMediaQuery`.
 *
 * Measured when the element is first watched, and then each time the observer
 * says it changed, which it says just after the browser has laid the page out.
 * Measured on every draw instead, as it was, it made the browser lay the page
 * out there and then: on every keystroke in a note, for the note's own width.
 */
export const useElementWidth = (element: Element | null): number | undefined => {
	const store = useMemo(() => {
		const measured: { current: number | undefined } = { current: undefined };
		const measure = () => {
			const width = element?.getBoundingClientRect().width ?? 0;
			measured.current = width > 0 ? width : undefined;
		};
		return {
			subscribe: (changed: () => void) => {
				measure();
				if (element === null || typeof ResizeObserver === 'undefined') {
					return noSubscription();
				}
				const observer = new ResizeObserver((entries?: readonly ResizeObserverEntry[]) => {
					// The border box, as `getBoundingClientRect` gives it, without
					// a transform the element is drawn under for a moment, which the
					// observer would never say had gone.
					const box = entries?.at(-1)?.borderBoxSize.at(0)?.inlineSize;
					if (box === undefined) measure();
					else measured.current = box > 0 ? box : undefined;
					changed();
				});
				observer.observe(element, { box: 'border-box' });
				return () => {
					observer.disconnect();
				};
			},
			width: () => measured.current,
		};
	}, [element]);

	return useSyncExternalStore(store.subscribe, store.width);
};

/**
 * The page's fonts, where there are any to ask about. Asked of the value
 * rather than the type: the lib says it is always there, and jsdom has none.
 */
const pageFonts = (): FontFaceSet | undefined =>
	typeof document === 'undefined' ? undefined : (document as Partial<Document>).fonts;

const fontsLoading = (changed: () => void) => {
	const fonts = pageFonts();
	if (fonts === undefined) return noSubscription();
	fonts.addEventListener('loadingdone', changed);
	return () => {
		fonts.removeEventListener('loadingdone', changed);
	};
};

const fontsStatus = (): FontFaceSetLoadStatus => pageFonts()?.status ?? 'loaded';

/**
 * Whether the page's fonts are still arriving, and a re-render as each one
 * does: text measured outside the layout, as a canvas measures it, was
 * measured in the fallback font until then. A brand can bring its own
 * (docs/ARCHITECTURE.md §8, "Brand").
 */
export const useFontsStatus = (): FontFaceSetLoadStatus =>
	useSyncExternalStore(fontsLoading, fontsStatus);

/**
 * Whether `query` matches now, for code outside React that asks each time it
 * needs to know rather than following the answer.
 */
export const mediaMatches = (query: string): boolean =>
	typeof window !== 'undefined' &&
	typeof window.matchMedia === 'function' &&
	window.matchMedia(query).matches;

/**
 * Whether `query` matches, and a re-render whenever that changes.
 *
 * Read synchronously on the first render, so the first frame is already the
 * right layout rather than the wide one corrected a frame later.
 */
export const useMediaQuery = (query: string): boolean => {
	// One list per query, not per render: `matchMedia` hands back a new object
	// every time it is called, and a new object would be a new subscription.
	const media = useMemo(
		() =>
			typeof window === 'undefined' || typeof window.matchMedia !== 'function'
				? undefined
				: window.matchMedia(query),
		[query]
	);

	const subscribe = useCallback(
		(changed: () => void) => {
			if (media === undefined) return noSubscription();
			media.addEventListener('change', changed);
			return () => {
				media.removeEventListener('change', changed);
			};
		},
		[media]
	);

	const matches = useCallback(() => media?.matches ?? false, [media]);

	return useSyncExternalStore(subscribe, matches);
};
