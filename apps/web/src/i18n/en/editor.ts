/**
 * The editors: the rich and the raw one, the formatting toolbar across them and
 * the one over a selection, the slash menu, a code block's tools, and the
 * pictures and files in a note.
 */
export const editor = {
	/** The rich editor's writing surface, as a screen reader names it. */
	noteBody: 'Note body',
	/** The two ways a note can be edited, by the names the switch between them shows. */
	mode: {
		rich: 'Rich text',
		raw: 'Markdown',
	},
	/**
	 * What the slash menu and the toolbars can do, each by its name: a menu
	 * row, a button's tooltip, what a screen reader says for it.
	 */
	commands: {
		heading1: 'Heading 1',
		heading2: 'Heading 2',
		heading3: 'Heading 3',
		heading4: 'Heading 4',
		heading5: 'Heading 5',
		heading6: 'Heading 6',
		/** A paragraph, as the text-style menu calls one that is not a heading. */
		plainText: 'Plain text',
		bulletList: 'Bulleted list',
		orderedList: 'Numbered list',
		taskList: 'Task list',
		quote: 'Quote',
		codeBlock: 'Code block',
		table: 'Table',
		/** A horizontal rule between two blocks. */
		divider: 'Divider',
		bold: 'Bold',
		italic: 'Italic',
		strikethrough: 'Strikethrough',
		/** Code inside a line of text, as against a code block. */
		code: 'Code',
		clearFormatting: 'Clear formatting',
		/** List nesting: taking an item out a level, and putting it in one. */
		outdent: 'Decrease indent',
		indent: 'Increase indent',
		/** The slash menu's: pick a picture to put in the note. */
		image: 'Image',
		/** The slash menu's: pick any file to put in the note. */
		file: 'File',
		/** The toolbar's paperclip. */
		attach: 'Attach files',
	},
	/** The formatting toolbar across the editor. */
	toolbar: {
		/** The bar, as a screen reader names it. */
		label: 'Formatting',
		/** The groups its controls are drawn in, as a screen reader names them. */
		groups: {
			textStyle: 'Text style',
			textFormatting: 'Text formatting',
			lists: 'Lists',
			indentation: 'Indentation',
			insert: 'Insert',
			link: 'Link',
		},
		/** The menu of plain text and headings. */
		textStyle: 'Text style',
		/** Its button, as a screen reader hears it: `{style}` is what it shows, "Plain text" or "Heading 2". */
		textStyleNow: 'Text style: {style}',
		/** The menu holding strikethrough, code and clearing. */
		moreFormatting: 'More formatting',
		link: 'Link',
		/** The label of the field the link's address is typed in. */
		linkTo: 'Link to',
		/** Make the selection a link to what was typed. */
		applyLink: 'Apply',
		/** Take the link off the words, which stay. */
		removeLink: 'Remove',
		/** The menu at the end of a bar too narrow for everything, holding the rest. */
		moreTools: 'More tools',
	},
	/** The toolbar over selected words, as a screen reader names it. */
	selectionToolbar: 'Selection formatting',
	/** The slash menu's list of what can be put in, as a screen reader names it. */
	slashMenu: 'Insert',
	/** The bar of tools under the code block the cursor is in. */
	codeBlock: {
		/** The bar, as a screen reader names it. */
		label: 'Code block',
		/** The menu of languages the block's code can be in. */
		language: 'Code block language',
		/** That menu's choice for a block that names no language: one is guessed from the code. */
		detect: 'Detect language',
		wrap: 'Wrap long lines',
		lineNumbers: 'Line numbers',
		copy: 'Copy code',
		delete: 'Delete code block',
	},
	/** The button under a note that ends in a code block, a way out of it. */
	tail: {
		label: 'Add a paragraph after this block',
		/** Its tooltip. */
		title: 'Add a paragraph',
	},
	/** A task's checkbox, as a screen reader names it. */
	task: {
		done: 'Done',
		notDone: 'Not done',
	},
	/** A picture in a note. */
	image: {
		/**
		 * What is said under a picture that is not shown: its alt text,
		 * `{name}`, and why. `unnamed` is for a picture with no alt text.
		 */
		status: {
			missing: {
				named: '{name}: not found beside this note',
				unnamed: 'Picture: not found beside this note',
			},
			offline: {
				named: '{name}: not downloaded yet, and this device is offline',
				unnamed: 'Picture: not downloaded yet, and this device is offline',
			},
			unavailable: {
				named: '{name}: not on this device',
				unnamed: 'Picture: not on this device',
			},
			failed: {
				named: '{name}: could not be downloaded',
				unnamed: 'Picture: could not be downloaded',
			},
			unsupported: {
				named: '{name}: not a kind of picture this app shows',
				unnamed: 'Picture: not a kind of picture this app shows',
			},
			blocked: {
				named: '{name}: its address is not one this app loads',
				unnamed: 'Picture: its address is not one this app loads',
			},
			broken: {
				named: '{name}: could not be shown',
				unnamed: 'Picture: could not be shown',
			},
			/** A large picture, waiting to be asked for: `{size}` is in megabytes. */
			large: {
				named: '{name}: {size} MB, not downloaded yet',
				unnamed: 'Picture: {size} MB, not downloaded yet',
			},
			/** A large picture being downloaded, as asked: `{size}` is in megabytes. */
			downloading: {
				named: '{name}: downloading {size} MB',
				unnamed: 'Picture: downloading {size} MB',
			},
		},
		/** The button under a large picture that downloads it. */
		show: 'Show',
	},
	/** A file in a note that is not a picture, drawn as a chip. */
	attachment: {
		/**
		 * The chip, as a screen reader names it: the file's name, `{name}`, and
		 * then what kind of file it is.
		 */
		chip: {
			image: '{name}, Image',
			pdf: '{name}, PDF',
			document: '{name}, Document',
			text: '{name}, Text',
			spreadsheet: '{name}, Spreadsheet',
			presentation: '{name}, Presentation',
			archive: '{name}, Archive',
			audio: '{name}, Audio',
			video: '{name}, Video',
			code: '{name}, Code',
			file: '{name}, File',
		},
		/** The buttons on the bar under a chip selected whole. */
		open: 'Open',
		download: 'Download',
		/** On the bar under a chip, or over a picture, selected whole. */
		remove: 'Remove from note',
	},
	/**
	 * Why a file a chip names could not be opened or saved: `{name}` is the
	 * name the chip shows. `unnamed` is for a chip that shows none.
	 */
	fileProblem: {
		missing: {
			named: '{name} could not be found beside this note.',
			unnamed: 'That file could not be found beside this note.',
		},
		offline: {
			named: '{name} is not on this device, and this device is offline.',
			unnamed: 'That file is not on this device, and this device is offline.',
		},
		unavailable: {
			named: '{name} is not on this device, and its storage cannot be read from now.',
			unnamed: 'That file is not on this device, and its storage cannot be read from now.',
		},
		failed: {
			named: '{name} could not be downloaded.',
			unnamed: 'That file could not be downloaded.',
		},
	},
	/**
	 * Files pasted, dropped or picked into a note: `{name}` is a file's name,
	 * and `unnamed` is for a file that has none.
	 */
	attach: {
		/** Where a file on its way into the note is going, until it is there. */
		adding: 'Adding {name}…',
		/** The note was left, or the other editor chosen, before a file could go in. */
		closed: {
			named: 'The editor closed before {name} could go in. Add it again to put it in.',
			unnamed: 'The editor closed before the file could go in. Add it again to put it in.',
			/** More than one file. */
			several: {
				one: 'The editor closed before {count} file could go in. Add it again to put it in.',
				other: 'The editor closed before {count} files could go in. Add them again to put them in.',
			},
		},
		failed: {
			named: '{name} could not be added to the note.',
			unnamed: 'That file could not be added to the note.',
		},
		/** `{size}` is the most a file can be, in megabytes. */
		tooLarge: {
			named: '{name} is over {size} MB, the most a file beside a note can be.',
			unnamed: 'That file is over {size} MB, the most a file beside a note can be.',
		},
		isNote: {
			named: '{name} cannot be added: a .md file beside a note is another note.',
			unnamed: 'That file cannot be added: a .md file beside a note is another note.',
		},
	},
} as const;
