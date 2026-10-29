import { parentPath, ROOT } from '@skysa/core';
import {
	type ReactNode,
	type RefObject,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

import { Icon } from '../editor/icons.js';
import { t } from '../i18n/t.js';
import type { Origins, Pane } from '../routes/panel.js';
import { KEEPS_PANEL, PANES } from '../routes/panel.js';
import type { NoteRecord } from '../store/db.js';
import { type LiveEdit, type LiveEdits, shownNote, useLiveEdit } from '../store/liveEdits.js';
import { type Renamings, shownFolder, useRenaming } from '../store/renaming.js';
import { nameless, shownName } from '../store/titles.js';
import { folderLabel } from '../store/tree.js';
import { middleEllipsis } from './middleEllipsis.js';
import { ProviderIcon } from './ProviderIcon.js';
import { NoteSearchField, type SearchFieldProps } from './SearchField.js';
import { useShowingSource } from './sources/useShowingSource.js';
import { rems, useElementWidth, useFontsStatus } from './ui/layout.js';

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

/**
 * Whether `pane`'s trigger comes after the open one's along the bar. What it
 * says is what the open panel is there to choose — a source being chosen has
 * no notebook yet to name, nor a notebook a note — so it says nothing until
 * the panel shuts (2026-10-13). It keeps its room, so opening a panel moves
 * nothing along the bar, and is `inert`, out of reach of a press, the focus
 * and a screen reader; the stylesheet hides it.
 */
const afterOpen = (pane: Pane, panel: Pane | null): boolean =>
	panel !== null && PANES.indexOf(pane) > PANES.indexOf(panel);

/**
 * What the notebook dropdown says: its path, as the notes' heading does, so a
 * notebook inside another says which notebooks it is in. `keep` is its own
 * name, which the notebooks it is in give way before when the bar is short of
 * room (`MiddleLabel`).
 */
const notebookLabel = (folder: string | undefined): { value: string; keep?: string } => {
	if (folder === undefined) return { value: t('shell.compact.noNotebook') };
	const value = folderLabel(folder);
	const parent = parentPath(folder);
	return parent === ROOT ? { value } : { value, keep: value.slice(parent.length) };
};

/**
 * `value` shortened in its middle to the room `label` has (`middleEllipsis`),
 * keeping `keep` at its end whole for longest, or `value` as it is with
 * nothing to measure. Measured by a canvas, scaled to the width the page laid
 * the whole of `value` out at, so the two agree about the font.
 *
 * The room is the label's own `getBoundingClientRect`, taken with the whole's,
 * and not the observer's width (`useElementWidth`), which says only when to
 * measure again: where the page is laid out zoomed, as a phone lays it out at
 * its pixel ratio, the observer's width is cut down to a 64th of a pixel, and
 * a label exactly as wide as its whole came out a hair narrower — every name
 * cut where it fitted, `Bugs` to `B…s`.
 */
const fitted = (label: Element | null, value: string, keep: string): string => {
	const whole = label?.firstElementChild;
	if (label === null || whole === null || whole === undefined) return value;
	// The whole of it fits by the page's own measure, which also laid out the room.
	const room = label.getBoundingClientRect().width;
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
 *
 * Written in once the page has the new words in the label, before it is
 * drawn, as the options menu is placed (`OptionsMenu`): worked out as the
 * label was drawn again, the page still had the last words in it, and another
 * note's name, given the same room as the one before, stayed cut as though it
 * were as long as that one.
 */
const MiddleLabel = ({ value, keep }: { value: string; keep: string }) => {
	const [label, setLabel] = useState<HTMLSpanElement | null>(null);
	const shown = useRef<HTMLSpanElement>(null);
	const room = useElementWidth(label);
	const fonts = useFontsStatus();
	useLayoutEffect(() => {
		if (shown.current === null) return;
		shown.current.textContent =
			fonts === 'loading' || room === undefined ? value : fitted(label, value, keep);
	}, [label, room, fonts, value, keep]);
	return (
		<span ref={setLabel} className="compact-picker-label compact-picker-middle">
			<span className="compact-picker-whole">{value}</span>
			<span ref={shown} className="compact-picker-shown" />
		</span>
	);
};

/**
 * A trigger's words: shortened in their middle where `keep` is given
 * (`MiddleLabel`), and otherwise at their end, by the stylesheet.
 */
const Words = ({ value, keep }: { value: string; keep: string | undefined }) =>
	keep === undefined ? (
		<span className="compact-picker-label">{value}</span>
	) : (
		<MiddleLabel value={value} keep={keep} />
	);

const PaneTrigger = ({
	pane,
	label,
	value,
	keep,
	icon,
	panel,
	onPanel,
}: {
	pane: Pane;
	/** What the dropdown chooses and what is chosen, for a screen reader: "Note: Q3 plan". */
	label: string;
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
		inert={afterOpen(pane, panel)}
		{...{ [KEEPS_PANEL]: '' }}
		aria-label={label}
		aria-haspopup="true"
		aria-expanded={panel === pane}
		title={value}
		onClick={() => {
			onPanel(panel === pane ? null : pane);
		}}
	>
		{icon ?? <Words value={value} keep={keep} />}
		<span className="compact-picker-chevron">
			<Icon name="chevron" />
		</span>
	</button>
);

/**
 * What the bar calls the note open: its name as it is typed, and with none its
 * first words as they were last stored (`shownName`). The bar is as wide as
 * what it says, and the panels open out of where its triggers are, which the
 * shell holds (`onOrigins`): words that changed with every keystroke drew the
 * whole shell again with each.
 */
const barName = (note: NoteRecord | undefined, edit: LiveEdit | undefined) => {
	if (note === undefined) return undefined;
	const shown = shownNote(note, edit);
	return shownName(nameless(shown) ? note : shown);
};

/**
 * What the source dropdown says of the source showing, in its tooltip and to a
 * screen reader: its name, and that it needs connecting again where the red
 * dot on its mark says so in colour.
 */
const sourceWords = (source: { name: string; reconnect: boolean }): string =>
	source.reconnect ? t('sources.reconnect', { source: source.name }) : source.name;

/**
 * A scratch card's name, open over the whole window: said, as a note's would
 * be, but not a dropdown, since a card is not one of a list to choose from.
 * Back, or its Close, is the way out of it. It is in the notes' place, and
 * says nothing while a panel before it is open, as their trigger would not
 * (`afterOpen`).
 */
const CardName = ({
	title,
	keep,
	panel,
}: {
	title: string;
	keep: string | undefined;
	panel: Pane | null;
}) => (
	<span
		className="compact-picker compact-picker-static"
		title={title}
		inert={afterOpen('notes', panel)}
	>
		<Words value={title} keep={keep} />
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
	onChoose: SearchFieldProps['onChoose'];
	sourceName: SearchFieldProps['sourceName'];
	/** The note on screen, as a `noteRef`, which the notes opened lately leave out. */
	showing?: string | undefined;
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
	 * note's dropdown — only the name of a card open, which the route gives as
	 * `note`, or with none its first words.
	 */
	scratchpad?: boolean;
	/**
	 * The passwords are open (docs/ARCHITECTURE.md §7, "Passwords in the
	 * vault"): the notebook's dropdown says so, and the note's is there only
	 * while an item is open, to go back to the list from; with none, the list
	 * is what shows.
	 */
	passwords?: boolean;
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
	onChoose,
	sourceName,
	showing,
	searchOpen,
	onSearchOpen,
	fieldRef,
	onOrigins,
	scratchpad = false,
	passwords = false,
}: CompactBarProps) => {
	const searching = searchOpen || query !== '';
	const renaming = useRenaming(renamings);
	const source = useShowingSource(renaming);
	const sourceValue = sourceWords(source);
	const edit = useDeferredValue(useLiveEdit(liveEdits, note));
	const name = barName(note, edit);
	const title = name?.text ?? t('shell.compact.noNote');
	// Words are cut at their end, since how they start is what says which note
	// it is; a name in its middle, its end telling two alike apart.
	const keep = name?.from === 'words' ? undefined : '';
	// A card with neither a name nor words is said by "Scratchpad" alone.
	const card = scratchpad && name !== undefined && name.from !== 'nothing';
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
		// which says "Scratchpad". Nor in the passwords with no item open.
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
			<NoteSearchField
				query={query}
				onQuery={onQuery}
				onChoose={onChoose}
				sourceName={sourceName}
				showing={showing}
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
					aria-label={t('shell.compact.closeSearch')}
					title={t('shell.compact.closeSearch')}
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
					label={t('shell.compact.source', { value: sourceValue })}
					value={sourceValue}
					icon={<ProviderIcon kind={source.kind} alert={source.reconnect} />}
					panel={panel}
					onPanel={onPanel}
				/>
				<PaneTrigger
					pane="notebooks"
					label={t('shell.compact.notebook', { value: notebook.value })}
					{...notebook}
					panel={panel}
					onPanel={onPanel}
				/>
				{scratchpad ? (
					card && <CardName title={title} keep={keep} panel={panel} />
				) : passwords && note === undefined ? null : (
					<PaneTrigger
						pane="notes"
						label={t('shell.compact.note', { value: title })}
						value={title}
						keep={keep}
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
					aria-label={t('shell.compact.search')}
					title={t('shell.compact.search')}
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
