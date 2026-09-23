import { basename, ROOT } from '@skysa/core';
import { type RefObject, useEffect, useState } from 'react';

import { Icon } from '../editor/icons.js';
import { type NoteRecord } from '../store/db.js';
import { folderLabel } from '../store/tree.js';
import { COMPACT, rems, useElementWidth, useMediaQuery } from './layout.js';
import { SearchField } from './SearchField.js';
import { useShowingSourceName } from './SourceTabs.js';

/**
 * The bar across the top of a compact window, where the sources, the notebooks
 * and the notes are each a dropdown and the search is an icon — or, on a bar
 * with the room for it (`SEARCH_FITS_AT`), the search field itself.
 *
 * Only the triggers are here. What the notebook and note dropdowns open is the
 * sidebar and the note list themselves — the same components a wide window
 * shows as columns, drawn as a panel under the bar (`.app-frame.compact` in the
 * stylesheet). The source dropdown opens `SourcePanel`, the tabs drawn as a
 * list, with the storage panel that a wide window keeps under the notebooks. Everything the columns can do, the panels can do: the notebook
 * menu, the storage panel at the sidebar's foot, a move's destinations. Two
 * copies of the notebook tree, one for each width, would be two places for the
 * next change to be made once.
 *
 * They stay mounted while shut, and that is load-bearing: both register
 * commands in the palette, and a notebook rename asked for from there has to
 * find the sidebar that holds it.
 */

/**
 * The bar's own width, in rems, from which the search is a field beside the
 * dropdowns rather than an icon that swaps them for one: room for the field
 * and for three dropdowns that still say something. A compact window can be
 * a tablet as easily as a phone, and on a tablet the field has the room.
 */
const SEARCH_FITS_AT = 40;

/** Which pane is open as a dropdown. */
export type Pane = 'sources' | 'notebooks' | 'notes';

/** The element each pane is, for telling a press inside it from one outside. */
const PANE_ELEMENT: Record<Pane, string> = {
	sources: '.source-panel',
	notebooks: '.sidebar',
	notes: '.note-list',
};

/**
 * Marks what a press may land on without shutting the open panel: the panel's
 * own triggers, which toggle it themselves, and the search field, which is
 * where the results in the notes panel are being asked for.
 */
const KEEPS_PANEL = 'data-keeps-panel';

/**
 * The pane open as a dropdown, and the ways it shuts: Escape, and a press
 * anywhere that is neither in it nor on something that keeps it.
 */
export const usePanel = () => {
	const [panel, setPanel] = useState<Pane | null>(null);

	useEffect(() => {
		if (panel === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setPanel(null);
		};
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest(`${PANE_ELEMENT[panel]}, [${KEEPS_PANEL}]`) !== null) return;
			setPanel(null);
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', away);
		};
	}, [panel]);

	return [panel, setPanel] as const;
};

/**
 * Everything the route needs to lay itself out for the window: whether it is
 * compact, which pane is open as a dropdown, and whether the search has the
 * bar. The frame's class and the shell's `data-panel` are what the stylesheet
 * reads.
 */
export const useCompactLayout = () => {
	const compact = useMediaQuery(COMPACT);
	const [open, setPanel] = usePanel();
	const [searchOpen, setSearchOpen] = useState(false);
	// Nothing is a dropdown in a wide window, and one left open there is not
	// one to find open again when the window is next narrowed.
	const panel = compact ? open : null;

	return {
		compact,
		panel,
		setPanel,
		searchOpen,
		setSearchOpen,
		frameClassName: compact ? 'app-frame compact' : 'app-frame',
		shellProps: panel === null ? {} : { 'data-panel': panel },
	};
};

/** What the notebook dropdown says: the notebook's own name, not its path. */
const notebookLabel = (folder: string | undefined): string => {
	if (folder === undefined) return 'Notebooks';
	return folder === ROOT ? folderLabel(folder) : basename(folder);
};

const PaneTrigger = ({
	pane,
	name,
	value,
	panel,
	onPanel,
}: {
	pane: Pane;
	/** What the dropdown chooses, for a screen reader: "Source", "Note". */
	name: string;
	/** What is chosen now. Truncated on screen, whole in the tooltip. */
	value: string;
	panel: Pane | null;
	onPanel: (panel: Pane | null) => void;
}) => (
	<button
		type="button"
		className="compact-picker"
		{...{ [KEEPS_PANEL]: '' }}
		aria-label={`${name}: ${value}`}
		aria-haspopup="true"
		aria-expanded={panel === pane}
		title={value}
		onClick={() => {
			onPanel(panel === pane ? null : pane);
		}}
	>
		<span className="compact-picker-label">{value}</span>
		<Icon name="chevron" />
	</button>
);

export interface CompactBarProps {
	/** The open notebook's path, or undefined when none is. */
	folder: string | undefined;
	/** The open note, if there is one. */
	note: NoteRecord | undefined;
	panel: Pane | null;
	onPanel: (panel: Pane | null) => void;
	query: string;
	onQuery: (query: string) => void;
	/**
	 * Whether the search icon has been pressed. A query still in the field
	 * keeps the search in the bar too: a window narrowed mid-search should not
	 * hide the field its answers came from.
	 */
	searchOpen: boolean;
	onSearchOpen: (open: boolean) => void;
	fieldRef: RefObject<HTMLInputElement | null>;
}

/**
 * The search takes the whole bar while it is open — there is no room for a
 * field beside three dropdowns — and gives it back when it is closed, by the
 * button beside it or by Escape. Its answers are the note list, as they are in
 * a wide window, opened as the notes panel.
 */
export const CompactBar = ({
	folder,
	note,
	panel,
	onPanel,
	query,
	onQuery,
	searchOpen,
	onSearchOpen,
	fieldRef,
}: CompactBarProps) => {
	const searching = searchOpen || query !== '';
	const source = useShowingSourceName();
	// Measured rather than a container query, since it changes what is drawn.
	// Unmeasured — jsdom — is the icon: the one that fits any bar.
	const [bar, setBar] = useState<HTMLDivElement | null>(null);
	const width = useElementWidth(bar);
	const fieldFits = width !== undefined && width >= rems(SEARCH_FITS_AT);

	// The field appears because the icon was pressed, so the cursor goes into
	// it; a keyboard user would otherwise have to find what they just opened.
	useEffect(() => {
		if (searching) fieldRef.current?.focus();
	}, [searching, fieldRef]);

	const closeSearch = () => {
		onQuery('');
		onSearchOpen(false);
		onPanel(null);
	};

	const field = (
		<div
			className={fieldFits ? 'compact-search compact-search-beside' : 'compact-search'}
			{...{ [KEEPS_PANEL]: '' }}
		>
			<SearchField
				query={query}
				onQuery={onQuery}
				fieldRef={fieldRef}
				onDismiss={closeSearch}
				onFocus={() => {
					if (query.trim() !== '') onPanel('notes');
				}}
			/>
		</div>
	);

	if (searching && !fieldFits) {
		return (
			<div className="compact-bar" ref={setBar}>
				{field}
				<button
					type="button"
					className="compact-icon"
					aria-label="Close search"
					title="Close search"
					onClick={closeSearch}
				>
					<Icon name="close" />
				</button>
			</div>
		);
	}

	return (
		<div className="compact-bar" ref={setBar}>
			<PaneTrigger
				pane="sources"
				name="Source"
				value={source}
				panel={panel}
				onPanel={onPanel}
			/>
			<PaneTrigger
				pane="notebooks"
				name="Notebook"
				value={notebookLabel(folder)}
				panel={panel}
				onPanel={onPanel}
			/>
			<PaneTrigger
				pane="notes"
				name="Note"
				value={note?.title ?? 'Notes'}
				panel={panel}
				onPanel={onPanel}
			/>
			{fieldFits ? (
				field
			) : (
				<button
					type="button"
					className="compact-icon"
					aria-label="Search notes"
					title="Search notes"
					onClick={() => {
						onSearchOpen(true);
					}}
				>
					<Icon name="search" />
				</button>
			)}
		</div>
	);
};
