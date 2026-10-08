/**
 * Elements of a given width, for the parts of the app that size themselves by
 * the room their own part of the screen has (`useElementWidth` in
 * `src/components/layout.ts`).
 *
 * jsdom lays nothing out: every element is 0px wide, which the app reads as
 * "plenty of room", and it has no `ResizeObserver`. This gives the elements a
 * selector names a width, and a `ResizeObserver` that tells whoever is
 * watching one of them when that width changes — as the browser would when
 * the window is dragged, or the columns beside the note fold away.
 */

export interface FakeWidths {
	/** Give every element `selector` matches this width, and tell its observers. */
	resize: (selector: string, width: number) => void;
	/**
	 * Tell the observers of every element `selector` matches that its border
	 * box is `width` wide, as a browser's observer does, and leave what
	 * `getBoundingClientRect` says as it was: an element drawn under a
	 * transform, whose box the observer gives without it.
	 */
	report: (selector: string, width: number) => void;
	/** How many observers watch an element `selector` matches. */
	watching: (selector: string) => number;
	/** Put jsdom back as it was. */
	restore: () => void;
}

export const elementWidths = (initial: Record<string, number>): FakeWidths => {
	const widths = new Map(Object.entries(initial));
	type Told = (entries?: readonly ResizeObserverEntry[]) => void;
	const observers = new Set<{ callback: Told; watched: Set<Element> }>();

	const widthOf = (element: Element): number =>
		[...widths].find(([selector]) => element.matches(selector))?.[1] ?? 0;

	// The one way to answer for any element is on the prototype, and a getter
	// there is told which element through `this`.
	const original = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
	Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
		configurable: true,
		writable: true,
		/* eslint-disable functional/no-this-expressions -- see above */
		value(this: Element) {
			const width = widthOf(this);
			if (width !== 0) return new DOMRect(0, 0, width, 0);
			const fallback = original?.value as ((this: Element) => DOMRect) | undefined;
			return fallback?.call(this) ?? new DOMRect();
		},
		/* eslint-enable functional/no-this-expressions */
	});

	const observer = (callback: Told) => {
		const entry = { callback, watched: new Set<Element>() };
		observers.add(entry);
		return {
			observe: (element: Element) => {
				entry.watched.add(element);
			},
			unobserve: (element: Element) => {
				entry.watched.delete(element);
			},
			disconnect: () => {
				observers.delete(entry);
			},
		};
	};

	// A class only so that `new` works on it; what `new` gives is the object
	// its constructor returns.
	class FakeResizeObserver {
		// eslint-disable-next-line functional/prefer-tacit -- a constructor cannot be one
		constructor(callback: Told) {
			return observer(callback);
		}
	}

	Object.defineProperty(window, 'ResizeObserver', {
		configurable: true,
		writable: true,
		value: FakeResizeObserver,
	});

	return {
		resize: (selector, width) => {
			widths.set(selector, width);
			[...observers]
				.filter(({ watched }) => [...watched].some((element) => element.matches(selector)))
				.forEach(({ callback }) => {
					callback();
				});
		},
		report: (selector, width) => {
			[...observers].forEach(({ callback, watched }) => {
				const told = [...watched].filter((element) => element.matches(selector));
				if (told.length === 0) return;
				callback(
					told.map(
						(target) =>
							({
								target,
								borderBoxSize: [{ inlineSize: width, blockSize: 0 }],
							}) as unknown as ResizeObserverEntry
					)
				);
			});
		},
		watching: (selector) =>
			[...observers].filter(({ watched }) =>
				[...watched].some((element) => element.matches(selector))
			).length,
		restore: () => {
			if (original !== undefined) {
				Object.defineProperty(Element.prototype, 'getBoundingClientRect', original);
			}
			Reflect.deleteProperty(window, 'ResizeObserver');
		},
	};
};
