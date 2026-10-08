/**
 * The offer to install the app, across the top of it in a browser tab. `{app}`
 * is the app's name, or `thisApp` where the build gives it none.
 */
export const install = {
	/** Said in the app's name's place where it has none: "Install this app". */
	thisApp: 'this app',
	/** The banner, named for a screen reader. */
	label: 'Install {app}',
	/** Where the browser can install it from the page, beside an Install button. */
	offer: 'Install {app} to open it in a window of its own, offline too.',
	/** On an iPhone or iPad. Share and Add to Home Screen are the names Safari gives them. */
	homeScreen: 'Install {app}: tap Share, then Add to Home Screen.',
	/** Safari on a Mac. File and Add to Dock are the names Safari gives them. */
	dock: "Install {app}: in Safari's File menu, choose Add to Dock.",
	install: 'Install',
	/** The tooltip on the banner's close button: it is not offered again. */
	dontShowAgain: "Don't show this again",
} as const;
