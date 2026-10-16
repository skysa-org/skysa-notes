import { t } from '../i18n/t.js';
import source from './bookmarkletCode.js?raw';
import { BOOKMARKLET_REVISION, FILL_MESSAGE, FILL_VERSION } from './protocol.js';

/**
 * The bookmarklet (docs/ARCHITECTURE.md §7, "Filling in on a site"): a
 * `javascript:` address the user keeps as a bookmark, run in the page of the
 * site they are on when they choose it.
 *
 * What it runs is `bookmarkletCode.js`, plain JavaScript taken as it is written
 * (`?raw`), so what the tests run is what a bookmark holds: built from a
 * function's `toString()`, it would be whatever the bundler made of it, which
 * a test, unbundled, never sees. It is one function of what it is told, with
 * nothing from outside it but the page's own globals, which its lint block
 * names (`eslint.config.js`).
 *
 * In the page it finds the login's fields, opens the fill window at the app's
 * `/fill` with an opener, and listens only to that window, at the app's
 * origin: to `ready` it answers `hello` with what the fields hold, to the
 * app's origin alone; to `fill` it puts the login in the fields, as typing
 * would (the value set by the input's own setter, then `input` and `change`,
 * which React and Vue hear), and stops listening. It shows nothing in the
 * page, and answers nothing, so the page is not replaced by what it returns
 * (`void`). Where the browser blocks the window, the browser's own alert says
 * so, in the words of the app's catalog, written in as the address is made.
 *
 * Every byte is percent-encoded, so a `%` or a `#` in it is itself, and a line
 * ending the browser would otherwise drop keeps a comment from running on.
 */
export const bookmarkletUrl = (app: string): string => {
	const told = {
		app,
		type: FILL_MESSAGE,
		v: FILL_VERSION,
		b: BOOKMARKLET_REVISION,
		blocked: t('fill.bookmarklet.blocked'),
	};
	const run = source.trim().replace(/;$/u, '');
	return `javascript:${encodeURIComponent(`void((${run})(${JSON.stringify(told)}))`)}`;
};
