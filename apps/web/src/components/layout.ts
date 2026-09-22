import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * How much room the window has, asked of the browser rather than worked out.
 *
 * The layout's breakpoints live here and not in the stylesheet, because two of
 * them change what is *rendered* and not only how it looks: a compact window
 * has a different bar across the top, and a window too narrow for the outline
 * opens notes without one. A width decided twice — once in a media query and
 * once in a component — is two answers that can disagree by a pixel, and at
 * that pixel the sidebar would be a column and a dropdown at once. So the
 * components ask here, and the stylesheet follows a class the route sets
 * (`.app-frame.compact`) rather than a width of its own.
 *
 * The one width the stylesheet does keep for itself is where the two side
 * columns start to narrow, which is a `clamp()` on `.app-shell` and changes
 * nothing but their size.
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

/**
 * Narrow enough that a 13rem outline rail costs the note more than it gives.
 * The rail starts collapsed below this, and is still there to be opened.
 */
export const OUTLINE_CRAMPED = '(width < 1400px)';

const noSubscription = () => () => undefined;

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
