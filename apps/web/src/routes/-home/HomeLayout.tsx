import type { CSSProperties, ReactNode } from 'react';

import { t } from '../../i18n/t.js';
import { InstallBanner } from '../../install/InstallBanner.js';
import type { SyncStateRecord } from '../../store/db.js';
import { PROVIDER_LABELS, sourceName } from '../../sync/account.js';

/**
 * What the banner across the top says while a disconnected source is showing:
 * by its name and its storage's, where it has them (`sourceName`, which has a
 * name for every source with a provider).
 */
const detachedText = (source: SyncStateRecord): string => {
	const name = sourceName(source);
	return source.provider === undefined || name === undefined
		? t('shell.detached.unnamed')
		: t('shell.detached.named', { source: name, provider: PROVIDER_LABELS[source.provider] });
};

/**
 * The shell's frame, with the parts `Home` makes put in their places: the bar,
 * the banners and the palette above the panes, the three columns, and what
 * floats over the page.
 */
export const HomeLayout = ({
	frameClassName,
	inert,
	source,
	shell,
	bar,
	palette,
	sourceDropdown,
	sidebar,
	list,
	note,
	overlays,
	floating,
}: Readonly<{
	frameClassName: string;
	/** The page behind an import or a card's dialog (`covered`). */
	inert: boolean;
	/** The source showing, whose banner says if it is detached. */
	source: SyncStateRecord | null | undefined;
	/**
	 * What the stylesheet reads off the shell: the panel open, a card, and in a
	 * compact window where the panels open from. Never a class: the grid's is
	 * the layout's own.
	 */
	shell: Readonly<Record<`data-${string}`, string | undefined> & { style?: CSSProperties }>;
	bar: ReactNode;
	palette: ReactNode;
	sourceDropdown: ReactNode;
	sidebar: ReactNode;
	/** The middle column: the notes, the scratchpad or the passwords. */
	list: ReactNode;
	/** The third column: the note open, or the password. */
	note: ReactNode;
	overlays: ReactNode;
	floating: ReactNode;
}>) => (
	// `app-shell` is a three-column grid with exactly three children. A banner
	// put inside it becomes a fourth grid item, takes the sidebar's column and
	// pushes the note view into a clipped second row, so anything that sits
	// above the panes goes in the frame around them instead. The toasts are
	// not laid out at all — they are fixed to the viewport — but they are
	// here for the same reason: a stack in the grid would take a column.
	<div className={frameClassName} inert={inert}>
		{/*
		 * Above everything, because it says which app this is: each source
		 * is its own notes, its own notebooks and its own sync (§6), so the
		 * panes below all mean something different depending on which of
		 * these is lit.
		 */}
		{bar}
		{/*
		 * Under the bar rather than over it: the bar is the top of the window
		 * to a compact window's search, which hangs from it to the foot.
		 */}
		<InstallBanner />
		{/*
		 * For as long as a detached source is the one showing, and not
		 * dismissable: its notes look like any others, can be opened and
		 * written in like any others, and sync nowhere. `role="note"` rather
		 * than `status`, as a standing remark about what is on screen and not
		 * news of something that has just happened.
		 */}
		{source?.detached !== undefined && (
			<p className="banner" role="note">
				{detachedText(source)}
			</p>
		)}
		{palette}

		{/* `data-panel` is which pane a compact window is showing as a
		    dropdown; the stylesheet ignores it in a wide one. */}
		<div className="app-shell" {...shell}>
			{/* Positioned, like the two panes in a compact window, so it is
			    never a grid item and takes no column. */}
			{sourceDropdown}
			{sidebar}
			{list}
			{note}
		</div>

		{overlays}

		{/* One stack for everything the screen floats over the page (`Home`). */}
		{floating}
	</div>
);
