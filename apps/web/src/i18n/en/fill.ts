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
	/** Setting the bookmarklet up, from Passwords (`FillSetupDialog`). */
	setup: {
		/** The button in Passwords, and the dialog's title. */
		title: 'Fill on sites',
		intro: 'Fill in a site’s sign-in form with a password from here. It asks for this device’s unlock each time.',
		/** The link's words, which become the bookmark's name: `{app}` is the app's name. */
		link: 'Fill with {app}',
		/** The same, where the app has no name of its own. */
		linkUnnamed: 'Fill in',
		computerHeading: 'On a computer',
		computer:
			'Drag the link above to your bookmarks bar. Then, on a site’s sign-in page, press it.',
		phoneHeading: 'On a phone or tablet',
		phone: 'Copy the bookmarklet. Bookmark any page, then edit the bookmark: name it, and paste in place of its address. In Safari, open it from Bookmarks. In Chrome, type its name in the address bar and choose it there.',
		site: 'Only a password with a Site fills in: on that site, and the sites under it. To give one a Site, edit it.',
		recovery:
			'The fill window never asks for your recovery key. A window that does is not this app’s.',
		limitsHeading: 'Where it works',
		limitsBrowsers:
			'Chrome and Edge run it on every site. Firefox, and sometimes Safari, do not run it on a site that blocks scripts it did not write, such as GitHub’s sign-in page: copy the password there instead. Firefox for Android does not run it reliably.',
		limitsHomeScreen:
			'On an iPhone, iPad or Mac, an app added to the Home Screen or the Dock keeps its passwords apart from Safari’s. The bookmarklet, in Safari, sees the passwords turned on in Safari.',
		limitsPage: 'The site’s own scripts see what is filled in, as they see what you type.',
		/** `{origin}` is the app's address. */
		origin: 'It works with the app at {origin} only.',
		outdated: 'If the fill window says the bookmarklet is out of date, set it up again here.',
		copy: 'Copy bookmarklet',
		said: {
			copied: 'Copied. Paste it as a bookmark’s address.',
			notCopied: 'That could not be put on the clipboard.',
			/** The link pressed in the app, where it does nothing. */
			pressed: 'Drag it to your bookmarks bar instead. Here, in the app, it does nothing.',
		},
	},
	bookmarklet: {
		/** In the site's page, in the browser's own alert, where its pop-up blocker stopped the window. */
		blocked: 'The fill window was blocked. Allow pop-ups for this site, then try again.',
	},
} as const;
