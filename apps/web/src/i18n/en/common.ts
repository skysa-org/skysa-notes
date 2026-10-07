/**
 * Words many parts of the app say the same way: the buttons every dialog has.
 * A word that only reads right in one place belongs to that place's namespace,
 * even where English happens to spell it the same, so a translator can tell
 * them apart.
 */
export const common = {
	cancel: 'Cancel',
	close: 'Close',
	dismiss: 'Dismiss',
	reload: 'Reload',
	tryAgain: 'Try again',
	later: 'Later',
} as const;
