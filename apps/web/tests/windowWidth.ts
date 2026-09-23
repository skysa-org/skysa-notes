/**
 * A window of a given width, for the parts of the app that ask
 * `matchMedia` how much room there is (`src/components/layout.ts`).
 *
 * jsdom has no `matchMedia` at all, which the app reads as a wide window — so
 * every other test gets the layout it always had, and only a test that wants
 * a narrower one installs this. It understands exactly the one shape of query
 * the layout asks, and throws on any other question about width rather than
 * answering one it cannot read: a new breakpoint should fail here loudly, not
 * be told "no" and test the wide layout under a narrow name.
 */

const REM = 16;

const answers = (query: string, width: number): boolean => {
	const max = /^\(max-width: ([\d.]+)(px|rem)\)$/.exec(query);
	if (max !== null) {
		const [, value = '', unit] = max;
		return width <= Number(value) * (unit === 'rem' ? REM : 1);
	}
	// Other code asks other questions — CodeMirror asks about `print` — and a
	// screen is not print, nor anything else that is not about its width.
	if (!query.includes('width')) return false;
	throw new Error(`windowWidth cannot answer ${query}`);
};

export interface FakeWindow {
	/** Resize, and tell every query whose answer changed. */
	resize: (width: number) => void;
	/** Put jsdom back as it was: no `matchMedia` at all. */
	restore: () => void;
}

export const windowWidth = (initial: number): FakeWindow => {
	let width = initial;
	const lists: { query: string; matches: boolean; listeners: Set<() => void> }[] = [];

	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => {
			const entry = {
				query,
				matches: answers(query, width),
				listeners: new Set<() => void>(),
			};
			lists.push(entry);
			return {
				media: query,
				get matches() {
					return entry.matches;
				},
				addEventListener: (_type: 'change', listener: () => void) => {
					entry.listeners.add(listener);
				},
				removeEventListener: (_type: 'change', listener: () => void) => {
					entry.listeners.delete(listener);
				},
			};
		},
	});

	return {
		resize: (next) => {
			width = next;
			for (const entry of lists) {
				const matches = answers(entry.query, width);
				if (matches === entry.matches) continue;
				entry.matches = matches;
				entry.listeners.forEach((listener) => {
					listener();
				});
			}
		},
		restore: () => {
			Reflect.deleteProperty(window, 'matchMedia');
		},
	};
};
