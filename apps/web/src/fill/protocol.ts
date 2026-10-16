import { z } from 'zod';

/**
 * What the bookmarklet and the fill window say to each other
 * (docs/ARCHITECTURE.md §7, "Filling in on a site"), by `postMessage`:
 *
 * 1. The window, as it starts, tells its opener it is `ready`, to any origin:
 *    it says nothing else, and does not yet know whose page that is.
 * 2. The bookmarklet answers `hello` to the app's origin alone, with what the
 *    page's login fields hold, so a login typed there can be remembered.
 * 3. The window, its login chosen, sends `fill` to the page's origin alone:
 *    the origin the browser stamped on the `hello`, never one the page named.
 *
 * `v` is this protocol's version, which a change the other side would
 * misread moves on; `b` the bookmarklet's revision, which moves on with any
 * change to it, so a window can say it is out of date and still take it.
 */

/** What every message of the protocol says it is. */
export const FILL_MESSAGE = 'skysa-fill';

/** The protocol's version: a `hello` with another is not read. */
export const FILL_VERSION = 1;

/** The bookmarklet's revision (`bookmarkletCode.js`), moved on with every change to it. */
export const BOOKMARKLET_REVISION = 1;

/** The most a field's value is taken at: no login is longer, and a page's message is not trusted to be short. */
const MOST = 4096;

const value = z.string().max(MOST).catch('');

/**
 * A `hello`, as this version reads one. Not strict: a later bookmarklet of the
 * same version may say more, which this one leaves unread. A value that is not
 * text, or is too long, is read as nothing.
 */
export const helloSchema = z.object({
	type: z.literal(FILL_MESSAGE),
	v: z.literal(FILL_VERSION),
	b: z.number().int().catch(0),
	step: z.literal('hello'),
	username: value,
	password: value,
	newPassword: value,
	fields: z
		.object({
			username: z.boolean().catch(false),
			password: z.boolean().catch(false),
			newPassword: z.boolean().catch(false),
		})
		.catch({ username: false, password: false, newPassword: false }),
});

export type Hello = z.infer<typeof helloSchema>;

/** Any message of the protocol, read only as far as its kind and version. */
export const messageSchema = z.object({
	type: z.literal(FILL_MESSAGE),
	v: z.number(),
	step: z.string(),
});

/** What the window sends: that it is ready, and the login to fill. */
export type WindowMessage =
	| Readonly<{ type: typeof FILL_MESSAGE; v: typeof FILL_VERSION; step: 'ready' }>
	| Readonly<{
			type: typeof FILL_MESSAGE;
			v: typeof FILL_VERSION;
			step: 'fill';
			username: string;
			password: string;
	  }>;
