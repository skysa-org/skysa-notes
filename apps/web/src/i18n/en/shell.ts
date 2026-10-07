/** The frame around everything: what it says when the app itself is in trouble. */
export const shell = {
	error: {
		title: 'Something went wrong',
		text: 'The app hit an error it could not recover from by itself. The notes saved on this device have not been touched.',
		details: 'What the error said',
	},
	update: {
		available: 'A new version is available.',
	},
	staleTab: {
		title: 'This tab is out of date',
		text: 'A newer version of the app is open in another tab, and this one can no longer save. Reload to carry on here.',
		copyFirst: 'Copy my text first',
		cannotSave: 'This tab is out of date and cannot save. Copy what you need, then reload.',
		waiting:
			'Waiting for an older tab of this app to finish. If this does not go away, close the other tabs.',
	},
	palette: {
		search: 'Search commands',
		placeholder: 'Type a command',
		list: 'Commands',
		noMatch: 'Nothing matches “{query}”.',
	},
} as const;
