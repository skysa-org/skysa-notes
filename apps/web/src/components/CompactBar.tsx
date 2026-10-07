import { parentPath, ROOT } from '@skysa/core';
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';

import { Icon } from '../editor/icons.js';
import { type NoteRecord } from '../store/db.js';
import { type LiveEdits, shownNote, useLiveEdit } from '../store/liveEdits.js';
import { type Renamings, shownFolder, useRenaming } from '../store/renaming.js';
import { folderLabel } from '../store/tree.js';
import { COMPACT, rems, useElementWidth, useFontsStatus, useMediaQuery } from './layout.js';
import { middleEllipsis } from './middleEllipsis.js';
import { ProviderIcon } from './ProviderIcon.js';
import { SearchField, type SearchFieldProps } from './SearchField.js';
import { useShowingSource } from './SourceTabs.js';

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

const PANES: readonly Pane[] = ['sources', 'notebooks', 'notes'];

/**
 * Where each pane's trigger sits across the bar, in pixels in from the bar's
 * left and right edges: the strip a panel opens out of and shuts back into.
 * The bar and the shell under it are both the frame's width, so the same
 * numbers mark the same strip across the top of the panel.
 */
export type Origins = Readonly<Record<Pane, Readonly<{ left: number; right: number }>>>;

/**
 * The origins as the stylesheet reads them, on the shell the panels are in:
 * `--notebooks-left` and the like, each panel taking its own pane's pair.
 */
const originStyle = (origins: Origins): CSSProperties =>
	Object.fromEntries(
		PANES.flatMap((pane) => [
			[`--${pane}-left`, `${String(origins[pane].left)}px`],
			[`--${pane}-right`, `${String(origins[pane].right)}px`],
		])
	);

/** The element each pane is, for telling a press inside it from one outside. */
const PANE_ELEMENT: Record<Pane, string> = {
	sources: '.source-panel',
	notebooks: '.sidebar',
	// The scratchpad is in the notes' place (docs/ARCHITECTURE.md §7, "The
	// scratchpad").
	notes: '.note-list, .scratchpad',
};

/**
 * Marks what a press may land on without shutting the open panel: the panel's
 * own triggers, which toggle it themselves.
 */
const KEEPS_PANEL = 'data-keeps-panel';

/**
 * Which way along the bar a panel is left for another: onward, from the
 * sources towards the notes, or back.
 */
export type Slide = 'onward' | 'back';

const slide = (from: Pane, to: Pane): Slide =>
	PANES.indexOf(to) > PANES.indexOf(from) ? 'onward' : 'back';

/**
 * The pane open as a dropdown, the one it took the place of if it went
 * straight from one to the other (`from`, for the stylesheet to slide them
 * along), and the ways it shuts: Escape, and a press anywhere that is neither
 * in it nor on something that keeps it.
 *
 * Shut, a pane gives way to the one under it, which is the note, or nothing —
 * except where the route says there is a pane to rest on (`setRest`): the
 * scratchpad, with no card open over it, has nothing under it but its own
 * pane, and shutting the notebooks over it goes back to it, not to an empty
 * window.
 */
export const usePanel = () => {
	const [{ panel, from }, setShown] = useState<{ panel: Pane | null; from: Pane | null }>({
		panel: null,
		from: null,
	});
	const setPanel = useCallback((next: Pane | null) => {
		setShown((shown) =>
			next === shown.panel ? shown : { panel: next, from: next === null ? null : shown.panel }
		);
	}, []);
	const rest = useRef<Pane | null>(null);
	const setRest = useCallback((pane: Pane | null) => {
		rest.current = pane;
	}, []);
	const shut = useCallback(() => {
		setPanel(rest.current);
	}, [setPanel]);

	useEffect(() => {
		if (panel === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') shut();
		};
		const away = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (target.closest(`${PANE_ELEMENT[panel]}, [${KEEPS_PANEL}]`) !== null) return;
			// Not in the app at all, but over it: a menu or a dialog, drawn on
			// the page's body (`createPortal`). Nothing outside the panel can be
			// pressed to open one without shutting the panel first, so one that
			// is open came from the panel — the notebook's `⋯`, a right-click
			// on a row — and what is chosen in it, a rename or a delete, happens
			// in the panel, which has to stay open for it. Each shuts itself.
			if (target.closest('.app-frame') === null) return;
			shut();
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('pointerdown', away);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', away);
		};
	}, [panel, shut]);

	return { panel, setPanel, from, setRest, shut };
};

/**
 * Everything the route needs to lay itself out for the window: whether it is
 * compact, which pane is open as a dropdown, and whether the search has the
 * bar. The frame's class and the shell's `data-panel` are what the stylesheet
 * reads.
 */
export const useCompactLayout = () => {
	const compact = useMediaQuery(COMPACT);
	const { panel: open, setPanel, from: openedFrom, setRest, shut } = usePanel();
	const [searchOpen, setSearchOpen] = useState(false);
	const [origins, setOrigins] = useState<Origins>();
	// Nothing is a dropdown in a wide window, and one left open there is not
	// one to find open again when the window is next narrowed.
	const panel = compact ? open : null;
	const from = panel === null ? null : openedFrom;
	/** The bar's own way to open and shut a pane: shut, it rests where `setRest` says. */
	const barPanel = useCallback(
		(pane: Pane | null) => {
			if (pane === null) shut();
			else setPanel(pane);
		},
		[setPanel, shut]
	);

	return {
		compact,
		panel,
		setPanel,
		setRest,
		barPanel,
		searchOpen,
		setSearchOpen,
		setOrigins,
		frameClassName: compact ? 'app-frame compact' : 'app-frame',
		shellProps: {
			...(panel === null ? {} : { 'data-panel': panel }),
			...(panel === null || from === null
				? {}
				: { 'data-from': from, 'data-slide': slide(from, panel) }),
			...(compact && origins !== undefined ? { style: originStyle(origins) } : {}),
		},
	};
};

/**
 * What the notebook dropdown says: its path, as the notes' heading does, so a
 * notebook inside another says which notebooks it is in. `keep` is its own
 * name, which the notebooks it is in give way before when the bar is short of
 * room (`MiddleLabel`).
 */
const notebookLabel = (folder: string | undefined): { value: string; keep?: string } => {
	if (folder === undefined) return { value: 'Notebooks' };
	const value = folderLabel(folder);
	const parent = parentPath(folder);
	return parent === ROOT ? { value } : { value, keep: value.slice(parent.length) };
};

/**
 * `value` shortened in its middle to `room` (`middleEllipsis`), keeping `keep`
 * at its end whole for longest, or `value` as it is with nothing to measure.
 * Measured by a canvas, scaled to the width the page laid `whole` — the whole
 * of `value` — out at, so the two agree about the font.
 */
const fitted = (
	whole: Element | null | undefined,
	room: number | undefined,
	value: string,
	keep: string
): string => {
	if (whole === null || whole === undefined || room === undefined) return value;
	// The whole of it fits by the page's own measure, which also laid out `room`.
	const width = whole.getBoundingClientRect().width;
	if (width <= room) return value;
	const context = document.createElement('canvas').getContext('2d');
	if (context === null) return value;
	const style = getComputedStyle(whole);
	context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	const scale = width / context.measureText(value).width;
	// A pixel to spare, for what a canvas and the page measure differently in
	// a shorter string: a fraction over, and the stylesheet's own ellipsis cut
	// the end off what was shortened already.
	return middleEllipsis(
		value,
		keep,
		(text) => context.measureText(text).width * scale <= room - 1
	);
};

/**
 * A trigger's words, shortened in their middle to the room the bar gives them
 * (`fitted`): a notebook's path, whose own name the notebooks it is in give
 * way before, and a note's name, cut alike from both ends.
 *
 * The whole of it is in the label, unseen, so the bar gives the label the
 * room the whole asks for, as it does any trigger's words, and the shortened
 * one is drawn over it — shortening what sizes the label would hand the room
 * back and ask for it again. Measured again when the room changes and once
 * the fonts have arrived; until then, and in jsdom, it is the whole, cut at
 * its end by the stylesheet.
 */
const MiddleLabel = ({ value, keep }: { value: string; keep: string }) => {
	const [label, setLabel] = useState<HTMLSpanElement | null>(null);
	const room = useElementWidth(label);
	const fonts = useFontsStatus();
	const shown = useMemo(
		() => (fonts === 'loading' ? value : fitted(label?.firstElementChild, room, value, keep)),
		[label, room, fonts, value, keep]
	);
	return (
		<span ref={setLabel} className="compact-picker-label compact-picker-middle">
			<span className="compact-picker-whole">{value}</span>
			<span className="compact-picker-shown">{shown}</span>
		</span>
	);
};

const PaneTrigger = ({
	pane,
	name,
	value,
	keep,
	icon,
	panel,
	onPanel,
}: {
	pane: Pane;
	/** What the dropdown chooses, for a screen reader: "Source", "Note". */
	name: string;
	/** What is chosen now. Truncated on screen, whole in the tooltip. */
	value: string;
	/**
	 * Given, `value` is shortened in its middle rather than at its end
	 * (`MiddleLabel`), and this, its end, is kept whole for longest: a
	 * notebook's own name after the notebooks it is in. `''` keeps nothing
	 * whole, and cuts both ends alike.
	 */
	keep?: string;
	/** Shown in place of `value`, which is then in the tooltip and the name only. */
	icon?: ReactNode;
	panel: Pane | null;
	onPanel: (panel: Pane | null) => void;
}) => (
	<button
		type="button"
		className="compact-picker"
		data-pane={pane}
		{...{ [KEEPS_PANEL]: '' }}
		aria-label={`${name}: ${value}`}
		aria-haspopup="true"
		aria-expanded={panel === pane}
		title={value}
		onClick={() => {
			onPanel(panel === pane ? null : pane);
		}}
	>
		{icon ??
			(keep === undefined ? (
				<span className="compact-picker-label">{value}</span>
			) : (
				<MiddleLabel value={value} keep={keep} />
			))}
		<span className="compact-picker-chevron">
			<Icon name="chevron" />
		</span>
	</button>
);

/**
 * A scratch card's name, open over the whole window: said, as a note's would
 * be, but not a dropdown, since a card is not one of a list to choose from.
 * Back, or its Close, is the way out of it.
 */
const CardName = ({ title }: { title: string }) => (
	<span className="compact-picker compact-picker-static" title={title}>
		<MiddleLabel value={title} keep="" />
	</span>
);

export interface CompactBarProps {
	/** The open notebook's path, or undefined when none is. */
	folder: string | undefined;
	/** The open note, if there is one. */
	note: NoteRecord | undefined;
	/** Its name as it is being typed, as the list says it (`NoteList`). */
	liveEdits?: LiveEdits;
	/** A notebook or source being renamed, so its dropdown says what is typed. */
	renamings?: Renamings;
	panel: Pane | null;
	onPanel: (panel: Pane | null) => void;
	query: string;
	onQuery: (query: string) => void;
	results: SearchFieldProps['results'];
	onChoose: SearchFieldProps['onChoose'];
	sourceName: SearchFieldProps['sourceName'];
	/**
	 * Whether the search icon has been pressed. A query still in the field
	 * keeps the search in the bar too: a window narrowed mid-search should not
	 * hide the field its answers came from.
	 */
	searchOpen: boolean;
	onSearchOpen: (open: boolean) => void;
	fieldRef: RefObject<HTMLInputElement | null>;
	/** Where the triggers are, for the panels to open out of (`Origins`). */
	onOrigins?: (origins: Origins) => void;
	/**
	 * The scratchpad is open (docs/ARCHITECTURE.md §7, "The scratchpad"): the
	 * notebook's dropdown says so, as `folderLabel` has it, and there is no
	 * note's dropdown — only the name of a card open with one, which the route
	 * gives as `note`.
	 */
	scratchpad?: boolean;
}

/**
 * The search takes the whole bar while it is open — there is no room for a
 * field beside three dropdowns — and gives it back when it is closed: by the
 * button beside it, by Escape, or by choosing an answer. Its answers hang from
 * the field (`SearchField`) and, in a compact window, fill everything under the
 * bar.
 */
export const CompactBar = ({
	folder,
	note,
	liveEdits,
	renamings,
	panel,
	onPanel,
	query,
	onQuery,
	results,
	onChoose,
	sourceName,
	searchOpen,
	onSearchOpen,
	fieldRef,
	onOrigins,
	scratchpad = false,
}: CompactBarProps) => {
	const searching = searchOpen || query !== '';
	const renaming = useRenaming(renamings);
	const source = useShowingSource(renaming);
	const edit = useDeferredValue(useLiveEdit(liveEdits, note));
	const title = note === undefined ? 'Notes' : shownNote(note, edit).title;
	// Measured rather than a container query, since it changes what is drawn.
	// Unmeasured — jsdom — is the icon: the one that fits any bar.
	const [bar, setBar] = useState<HTMLDivElement | null>(null);
	const width = useElementWidth(bar);
	const fieldFits = width !== undefined && width >= rems(SEARCH_FITS_AT);

	const notebook = notebookLabel(folder === undefined ? folder : shownFolder(folder, renaming));

	// The triggers are as wide as what they say, so they move when the bar's
	// width does or when any of them says something else — and measured then,
	// rather than when a panel opens, a panel never starts out of where its
	// trigger used to be. Not while the search has the whole bar, when the
	// triggers are not there; measured again as they come back, in case the
	// window changed meanwhile.
	useLayoutEffect(() => {
		if (bar === null || onOrigins === undefined) return;
		const trigger = (pane: Pane) => bar.querySelector(`.compact-picker[data-pane='${pane}']`);
		const sources = trigger('sources');
		const notebooks = trigger('notebooks');
		// None in the scratchpad: the scratchpad opens out of the notebook's,
		// which says "Scratchpad".
		const notes = trigger('notes') ?? notebooks;
		if (sources === null || notebooks === null || notes === null) return;
		const across = bar.getBoundingClientRect();
		const from = (each: Element) => {
			const box = each.getBoundingClientRect();
			return { left: box.left - across.left, right: across.right - box.right };
		};
		onOrigins({ sources: from(sources), notebooks: from(notebooks), notes: from(notes) });
	}, [bar, width, searching, onOrigins, source.kind, notebook.value, title]);

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
		<div className={fieldFits ? 'compact-search compact-search-beside' : 'compact-search'}>
			<SearchField
				query={query}
				onQuery={onQuery}
				results={results}
				onChoose={onChoose}
				sourceName={sourceName}
				fieldRef={fieldRef}
				onDismiss={closeSearch}
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
			<div className="compact-pickers">
				{/* The source's mark alone (2026-10-04): on a phone its name took
				    the room the notebook's and the note's need, and which storage
				    it is is what the mark says. The name is in the tooltip, the
				    button's name, and the panel it opens. */}
				<PaneTrigger
					pane="sources"
					name="Source"
					value={source.name}
					icon={<ProviderIcon kind={source.kind} />}
					panel={panel}
					onPanel={onPanel}
				/>
				<PaneTrigger
					pane="notebooks"
					name="Notebook"
					{...notebook}
					panel={panel}
					onPanel={onPanel}
				/>
				{scratchpad ? (
					note !== undefined && <CardName title={title} />
				) : (
					<PaneTrigger
						pane="notes"
						name="Note"
						value={title}
						keep=""
						panel={panel}
						onPanel={onPanel}
					/>
				)}
			</div>
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
