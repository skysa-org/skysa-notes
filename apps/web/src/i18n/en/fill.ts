/**
 * The fill window, which the bookmarklet opens over a site's sign-in page
 * (docs/ARCHITECTURE.md §7, "Filling in on a site"; `src/fill/`).
 */
export const fill = {
	/** The window's title, until it knows the page's site. */
	title: 'Fill in',
	/** Its heading and title, once it knows the site: `{site}` is the site's host. */
	on: 'Fill in on {site}',
	/** Beside the heading, for a page over `http:`. */
	notSecure: 'Not secure',
	/** While the page has not answered. */
	waiting: 'Reaching the page…',
	/** The page has not answered for a while. The window goes on listening. */
	slow: 'Still waiting for the page. If it is in another tab, go back to it, or use the bookmarklet again.',
	/** Opened by no page, or cut off from the one that opened it. */
	alone: 'This window could not reach a page. Use the bookmarklet on a site’s sign-in page. Some sites keep other windows out: there, copy the password from Passwords instead.',
	openPasswords: 'Open Passwords',
	/** The bookmarklet speaks a later version than the app reads. */
	newer: 'This bookmarklet is newer than the app. Reload the app to update it, then try again.',
	/** The bookmarklet speaks an earlier version than the app reads. */
	older: 'This bookmarklet is out of date. Set it up again from Passwords, in Fill on sites.',
	/** It works, and a newer one is there to be set up. */
	outdated: 'A newer bookmarklet is in Passwords, in Fill on sites. This one still works.',
	bookmarklet: {
		/** In the site's page, in the browser's own alert, where its pop-up blocker stopped the window. */
		blocked: 'The fill window was blocked. Allow pop-ups for this site, then try again.',
	},
} as const;
