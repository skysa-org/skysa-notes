// Dexie needs a real IndexedDB; Node has none.
import 'fake-indexeddb/auto';

// jsdom has no layout, so it implements none of the scrolling API. A component
// that keeps the active row in view calls this, and an undefined method is a
// TypeError rather than the "nothing scrolled" that a page with no viewport
// should mean. Whether it was called is not the assertion anywhere — that it
// exists is.
// TypeScript's DOM types say it is always there, so this is written as a plain
// definition rather than a fallback.
Object.defineProperty(Element.prototype, 'scrollIntoView', {
	value: () => undefined,
	writable: true,
});
