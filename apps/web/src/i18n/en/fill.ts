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
	/** While the window reads which sources to look in, and opens their passwords. */
	reading: 'Looking for this site’s passwords…',
	/** Reading which sources to look in failed: the device's storage. */
	failed: 'The passwords could not be read. Close this window and try again.',
	/** No source shows its passwords in this browser. */
	noSources:
		'Passwords are not turned on in this browser. Turn them on in a source’s Vault dialog, in the app.',
	/** Beside `noSources`: where the passwords may be instead. */
	homeScreen:
		'On an iPhone, iPad or Mac, an app added to the Home Screen or the Dock keeps its own storage, apart from Safari’s. Turn Passwords on in the app opened in Safari.',
	notSetUp: {
		one: 'One source shows its passwords in this browser, but this device cannot open its vault yet. Set this device up in its Vault dialog, in the app.',
		other: '{count} sources show their passwords in this browser, but this device cannot open their vaults yet. Set this device up in their Vault dialogs, in the app.',
	},
	/** The unlock's title, where there is more than one source to unlock: `{source}` is its tab's name. */
	unlockSource: 'Unlock {source}’s vault',
	/** A source whose unlock was closed. */
	locked: '{source}’s vault stayed locked.',
	unlock: 'Unlock',
	/** A source whose device copy of its key is gone: the window never asks for the recovery key. */
	recovery:
		'This device needs {source}’s recovery key. The fill window never asks for it: use it in the app, in Passwords.',
	sourceFailed: '{source}’s passwords could not be read.',
	/** None of the passwords looked in fills in on the page: `{site}` is its host. */
	none: 'No passwords for {site}.',
	noneHint:
		'A password fills in on the web address in its Site, and the sites under it. Add one in Passwords.',
	unopened: {
		one: 'One password could not be opened here, so it was not looked at.',
		other: '{count} passwords could not be opened here, so they were not looked at.',
	},
	/** A login's button. */
	fill: 'Fill in',
	/** Under a login whose Site is a site above the page's: `{site}` is its host. */
	savedFor: 'For {site}',
	/** Under a login, where there is more than one source: `{source}` is its tab's name. */
	inSource: 'In {source}',
	said: {
		copied: 'Copied.',
		notCopied: 'That could not be put on the clipboard.',
		changed:
			'That password has changed, or no longer fills in here. Use the bookmarklet again.',
		pageGone:
			'The page has gone on to somewhere else, so it was not filled in. Copy the password instead.',
	},
	bookmarklet: {
		/** In the site's page, in the browser's own alert, where its pop-up blocker stopped the window. */
		blocked: 'The fill window was blocked. Allow pop-ups for this site, then try again.',
	},
} as const;
