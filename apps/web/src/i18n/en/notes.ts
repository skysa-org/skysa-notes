/**
 * The notes: the list of them in the open notebook, what can be done to one,
 * and the open note around its editor.
 */
export const notes = {
	/** The middle pane, with the open notebook's notes. */
	list: {
		/** The pane's name, and its heading while no notebook is open. */
		title: 'Notes',
		/** The `+` in its header. */
		newNote: 'New note',
		loading: 'Loading…',
		/** `<create>` asks the sidebar for a new notebook, where it can. */
		noNotebook: '<create>Create a notebook</create> to start writing.',
		/** An empty notebook, or no loose notes; nothing here makes one there. */
		empty: 'No notes here yet.',
		/** `<create>` makes a note in the notebook. */
		emptyCreate: 'No notes here yet. <create>Create one</create>.',
		/** The dot on a row whose note has changes not sent to the storage. */
		notSynced: 'Not yet synced',
	},
	/** What a note's `⋯` and a right-click on its row offer. */
	menu: {
		move: 'Move to notebook',
		delete: 'Delete',
	},
	/** The open note. */
	view: {
		/** The pane's name for a screen reader. */
		label: 'Note',
		titleLabel: 'Note title',
		/** In the title field of a scratch note with no name. */
		titlePlaceholder: 'Title',
		/** The pane with no note open. `<create>` makes one in the open notebook. */
		nothingOpen: 'Select a note, or <create>create one</create>.',
		/** The same with no notebook to put one in. `<create>` asks for a notebook. */
		noNotebook: '<create>Create a notebook</create> to start writing.',
		selectNote: 'Select a note.',
		/** The name of the pair of tabs that choose the editor. */
		editor: 'Editor',
		/** A button that shows the formatting toolbar in a narrow window. */
		format: 'Format',
		showToolbar: 'Show the formatting toolbar',
		hideToolbar: 'Hide the formatting toolbar',
		/** A button that shows the note's headings beside it. */
		outline: 'Outline',
		showOutline: 'Show the outline',
		hideOutline: 'Hide the outline',
		unsaved:
			'Changes are not being saved on this device. Copy your text somewhere safe, then reload.',
		yamlError:
			'There is a YAML error in this note’s frontmatter, so its title and tags cannot be saved back to the file — the text is left exactly as it is rather than guessed at. Everything else about the note works as usual.',
		/** The editor tabs' tooltips, by the editor each tab is: rich text, or markdown. */
		mode: {
			editing: {
				rich: 'Editing as rich text',
				raw: 'Editing as markdown',
			},
			/** The rich editor refused the note, which has changed since. */
			retry: {
				rich: 'Try the rich text editor again (Ctrl/Cmd+E)',
				raw: 'Try the markdown editor again (Ctrl/Cmd+E)',
			},
			switchTo: {
				rich: 'Switch to rich text (Ctrl/Cmd+E)',
				raw: 'Switch to markdown (Ctrl/Cmd+E)',
			},
			locked: 'This note has to stay in markdown mode until it is changed',
		},
	},
	/** In the command palette, under `group`, about the open note. */
	commands: {
		group: 'Note',
		attach: 'Attach files',
		showOutline: 'Show outline',
		hideOutline: 'Hide outline',
		find: 'Find in note',
		/** By the editor it switches to. */
		editAs: {
			rich: 'Edit as rich text',
			raw: 'Edit as markdown',
		},
	},
	/**
	 * The banner over a note the rich editor cannot show, which it keeps in
	 * markdown. `<what></what>` is where what it cannot show is named: one of
	 * `what` or `names` below, which may have code of its own in it. `{line}` is
	 * a line number.
	 */
	unsupported: {
		whole: 'This note uses markdown the rich editor has no way to show, so this note stays in markdown mode. Nothing in it has been changed.',
		cannotShow:
			'The rich editor has no way to show <what></what>, so this note stays in markdown mode. Nothing in it has been changed.',
		cannotShowOnLine:
			'The rich editor has no way to show <what></what> on line {line}, so this note stays in markdown mode. Nothing in it has been changed.',
		wouldAdd:
			'The rich editor would add <what></what> that this note does not have, so this note stays in markdown mode. Nothing in it has been changed.',
		wouldAddOnLine:
			'The rich editor would add <what></what> on line {line} that this note does not have, so this note stays in markdown mode. Nothing in it has been changed.',
		/** After the banner's first sentences, once the note has changed since. */
		retry: 'Switch to rich text to try again.',
		changeFirst: 'Change it here, then switch to rich text to try again.',
		/**
		 * What is named in `<what></what>`. `<code>` is drawn as code; `{value}`
		 * is the text, as it is in the note; `{type}` is the name markdown's
		 * parser gives a kind of thing the app has no words for; `{name}` is
		 * one of `names`.
		 */
		what: {
			someHtml: 'some HTML',
			html: 'the HTML <code>{value}</code>',
			someText: 'some text',
			text: 'the text <code>“{value}”</code>',
			named: '{name} <code>“{value}”</code>',
			kind: 'markdown of the kind <code>{type}</code>',
			kindWithValue: 'markdown of the kind <code>{type}</code> <code>“{value}”</code>',
		},
		/** The things markdown is made of, by the name its parser gives each. */
		names: {
			blockquote: 'a quote',
			break: 'a line break',
			code: 'a code block',
			definition: 'a link reference definition',
			delete: 'strikethrough',
			emphasis: 'emphasis',
			footnoteDefinition: 'a footnote',
			footnoteReference: 'a footnote reference',
			heading: 'a heading',
			image: 'an image',
			imageReference: 'a reference-style image',
			inlineCode: 'inline code',
			link: 'a link',
			linkReference: 'a reference-style link',
			list: 'a list',
			listItem: 'a list item',
			paragraph: 'a paragraph',
			strong: 'bold text',
			table: 'a table',
			tableCell: 'a table cell',
			tableRow: 'a table row',
			thematicBreak: 'a divider',
			frontmatter: 'frontmatter',
		},
	},
} as const;
