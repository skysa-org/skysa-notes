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

// The same gap, one level down. jsdom's `Range` implements neither
// `getClientRects` nor `getBoundingClientRect` at all — not "returns zeros",
// but absent — and both editors reach for them the moment they are asked to
// bring something on screen: CodeMirror measures the text to work out where a
// line is, ProseMirror measures the selection it has just read back from the
// DOM. Both throw from inside a measure callback, so it surfaces as an
// unhandled error rather than a failing assertion, and the editor abandons
// whatever it was half-way through.
//
// Filling it in adds to jsdom what every browser has and takes nothing away.
// Zeros are the honest answer for a page with no layout, and no test asserts on
// a rectangle — only that measuring one does not blow up.
const EMPTY_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
const EMPTY_RECTS = Object.assign([EMPTY_RECT], {
	item: () => EMPTY_RECT,
}) as unknown as DOMRectList;

Object.defineProperty(Range.prototype, 'getClientRects', {
	value: () => EMPTY_RECTS,
	writable: true,
});
Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
	value: () => EMPTY_RECT as DOMRect,
	writable: true,
});
