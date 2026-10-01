// Dexie needs a real IndexedDB; Node has none.
import 'fake-indexeddb/auto';

import { afterAll, vi } from 'vitest';

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

// Milkdown times each step of an editor's start (`createTimer` in
// `@milkdown/ctx`): when a step begins it listens on the window for the step
// to say it is done, and sets a timeout to give up on it. The timeout is never
// cleared. Three seconds later it fires whether the step finished or not, and
// takes its listener off the window with a bare `removeEventListener`. In a
// file that started an editor in its last three seconds, that can be after
// jsdom has been torn down, when there is no `removeEventListener` to call: an
// unhandled ReferenceError, reported against whichever file was running, that
// fails a run in which every test passed (CI, 2026-10-01, `app.test.tsx`).
//
// So each step's start is noted, by the listener it adds, and the file is not
// let go until three seconds after the last: every timeout has fired while the
// window it reaches for is still there. A file that started no editor, or none
// near its end, waits for nothing.
const MILKDOWN_TIMERS = new Set([
	'ConfigReady',
	'InitReady',
	'SchemaReady',
	'CommandsReady',
	'KeymapReady',
	'ParserReady',
	'SerializerReady',
	'EditorStateReady',
	'PasteRuleReady',
	'EditorViewReady',
]);
/** `createTimer`'s default, which none of Milkdown's own timers change. */
const MILKDOWN_TIMEOUT = 3000;
const lastTimerStart = { at: Number.NEGATIVE_INFINITY };
const addListener = globalThis.addEventListener;
globalThis.addEventListener = ((...args: Parameters<typeof addEventListener>) => {
	if (MILKDOWN_TIMERS.has(args[0])) lastTimerStart.at = performance.now();
	Reflect.apply(addListener, window, args);
}) as typeof addEventListener;

afterAll(async () => {
	const left = lastTimerStart.at + MILKDOWN_TIMEOUT + 50 - performance.now();
	if (left <= 0) return;
	// Real time, whatever a test left the clock as.
	vi.useRealTimers();
	await new Promise((resolve) => setTimeout(resolve, left));
});
