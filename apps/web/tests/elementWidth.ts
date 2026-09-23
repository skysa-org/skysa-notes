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
	/** Put jsdom back as it was. */
	restore: () => void;
}

export const elementWidths = (initial: Record<string, number>): FakeWidths => {
	const widths = new Map(Object.entries(initial));
	const observers = new Set<{ callback: () => void; watched: Set<Element> }>();

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

	const observer = (callback: () => void) => {
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
		constructor(callback: () => void) {
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
		restore: () => {
			if (original !== undefined) {
				Object.defineProperty(Element.prototype, 'getBoundingClientRect', original);
			}
			Reflect.deleteProperty(window, 'ResizeObserver');
		},
	};
};
