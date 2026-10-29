import { type RouterHistory, useRouter, useRouterState } from '@tanstack/react-router';
import { type CSSProperties, useCallback, useLayoutEffect, useRef, useState } from 'react';

import { COMPACT, useMediaQuery } from '../components/ui/layout.js';
import { useEscapeKey } from '../components/ui/useEscapeKey.js';
import { usePressAway } from '../components/ui/usePressAway.js';

/**
 * The compact window's dropdowns as the history holds them: which pane is
 * open over a place and whether opening it made the entry, so that Back
 * retraces them (docs/ARCHITECTURE.md §7, "A dropdown is a step on a phone");
 * and the layout hook that keeps the bar, the shell and the history in step.
 */

/** Which pane is open as a dropdown. */
export type Pane = 'sources' | 'notebooks' | 'notes';

export const PANES: readonly Pane[] = ['sources', 'notebooks', 'notes'];

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
	// The passwords' list is a `.note-list`.
	notes: '.note-list, .scratchpad',
};

/**
 * Marks what a press may land on without shutting the open panel: the panel's
 * own triggers, which toggle it themselves.
 */
export const KEEPS_PANEL = 'data-keeps-panel';

/**
 * Which way along the bar a panel is left for another: onward, from the
 * sources towards the notes, or back.
 */
type Slide = 'onward' | 'back';

const slide = (from: Pane, to: Pane): Slide =>
	PANES.indexOf(to) > PANES.indexOf(from) ? 'onward' : 'back';

/**
 * What a history entry holds about the dropdowns, beside its place
 * (`routes/place.ts`): which one is open over the place, and whether opening
 * it was the step that made the entry (docs/ARCHITECTURE.md §7, "A dropdown
 * is a step on a phone").
 */
declare module '@tanstack/react-router' {
	interface HistoryState {
		panel?: Pane;
		opened?: true;
	}
}

/**
 * The dropdown an entry holds open, or none. Anything can be in
 * `history.state`, so it is taken only in the shape written here.
 */
export const heldPanel = (state: unknown): Pane | null => {
	if (typeof state !== 'object' || state === null || !('panel' in state)) return null;
	const { panel } = state;
	return PANES.find((pane) => pane === panel) ?? null;
};

/** Whether opening the entry's dropdown was the step that made the entry. */
export const openedHere = (state: unknown): boolean =>
	typeof state === 'object' && state !== null && 'opened' in state && state.opened === true;

/**
 * What a place put in place of the entry keeps of its dropdown: the dropdown,
 * and that opening it made the entry only while the place is the one it was
 * opened over. Once it is not, the entry before is another place, and Back to
 * it is no way to shut a dropdown.
 */
export const panelKept = (state: unknown, samePlace: boolean): { panel?: Pane; opened?: true } => {
	const panel = heldPanel(state);
	if (panel === null) return {};
	return samePlace && openedHere(state) ? { panel, opened: true } : { panel };
};

/**
 * Open `next` over the entry's place, or shut what is open, in the history.
 * Opened over nothing, it is a step, pushed, so Back shuts it; one swapped for
 * another takes its place. Shut, it is Back where opening it made the entry,
 * and taken out of the entry where it came with a place, as a notebook chosen
 * comes with its notes. Resolves once the history says so, which for Back is
 * a moment later: a step pushed before then would be the one Back undid.
 */
const holdPanel = (history: RouterHistory, next: Pane | null): Promise<void> => {
	const { href, state } = history.location;
	const now = heldPanel(state);
	if (next === now) return Promise.resolve();
	const { panel: _panel, opened: _opened, ...rest } = state;
	if (next !== null) {
		if (now === null) history.push(href, { ...rest, panel: next, opened: true });
		else
			history.replace(href, {
				...rest,
				panel: next,
				...(openedHere(state) ? { opened: true } : {}),
			});
		return Promise.resolve();
	}
	if (!openedHere(state)) {
		history.replace(href, rest);
		return Promise.resolve();
	}
	return new Promise((landed) => {
		const stop = history.subscribe(() => {
			stop();
			landed();
		});
		history.back();
	});
};

/**
 * The pane open as a dropdown, the one it took the place of if it went
 * straight from one to the other (`from`, for the stylesheet to slide them
 * along), and the ways it shuts: Escape, and a press anywhere that is neither
 * in it nor on something that keeps it.
 *
 * It is the history entry's (`holdPanel`), so that Back on a phone goes back
 * through what was on screen: from a note to the notes it was chosen from, to
 * the notebooks before them, and from a dropdown open to the note under it.
 * Back was a step between places only, and Chrome on Android, which shows the
 * entry Back is going to while the swipe is under way, showed the dropdown it
 * had been left from, so that the place Back opened looked like a row the
 * swipe had tapped.
 *
 * Shut, a pane gives way to the one under it, which is the note, or nothing —
 * except where the route says there is a pane to rest on (`setRest`): the
 * scratchpad, with no card open over it, has nothing under it but its own
 * pane, and shutting the notebooks over it goes back to it, not to an empty
 * window. Nothing is a dropdown in a wide window, where an entry's is not
 * shown, and nothing opens one.
 */
const usePanel = (compact: boolean) => {
	const router = useRouter();
	const held = useRouterState({ select: (state) => heldPanel(state.location.state) });
	const [rest, setRest] = useState<Pane | null>(null);
	const panel = compact ? (held ?? rest) : null;
	// What it went straight from, worked out as it changes, in render, so
	// that no frame shows the panel without it.
	const [shown, setShown] = useState<{ panel: Pane | null; from: Pane | null }>({
		panel,
		from: null,
	});
	if (shown.panel !== panel) setShown({ panel, from: panel === null ? null : shown.panel });
	const latest = useRef({ compact, rest });
	useLayoutEffect(() => {
		latest.current = { compact, rest };
	});
	/** Open a pane, or shut one with `null`, resolving once the history has it. */
	const showPanel = useCallback(
		(next: Pane | null): Promise<void> => {
			const { compact: narrow, rest: under } = latest.current;
			if (!narrow) return Promise.resolve();
			// The pane rested on is there with nothing open over it.
			return holdPanel(router.history, next === under ? null : next);
		},
		[router]
	);
	const setPanel = useCallback(
		(next: Pane | null) => {
			void showPanel(next);
		},
		[showPanel]
	);
	const shut = useCallback(() => showPanel(null), [showPanel]);

	usePressAway(
		[],
		(event) => {
			// Not in the app at all, but over it: a menu or a dialog, drawn on
			// the page's body (`createPortal`). Nothing outside the panel can be
			// pressed to open one without shutting the panel first, so one that
			// is open came from the panel — the notebook's `⋯`, a right-click
			// on a row — and what is chosen in it, a rename or a delete, happens
			// in the panel, which has to stay open for it. Each shuts itself.
			const target = event.target;
			if (!(target instanceof Element) || target.closest('.app-frame') === null) return;
			void shut();
		},
		{
			enabled: panel !== null,
			inside: panel === null ? undefined : `${PANE_ELEMENT[panel]}, [${KEEPS_PANEL}]`,
		}
	);
	// Not an Escape something over the panel has answered: a dialog, or the
	// menu a row's `⋯` opened, shuts itself and leaves the panel open.
	useEscapeKey(
		() => {
			void shut();
		},
		{ enabled: panel !== null }
	);

	return { panel, setPanel, from: panel === null ? null : shown.from, setRest, shut };
};

/**
 * Everything the route needs to lay itself out for the window: whether it is
 * compact, which pane is open as a dropdown, and whether the search has the
 * bar. The frame's class and the shell's `data-panel` are what the stylesheet
 * reads.
 */
export const useCompactLayout = () => {
	const compact = useMediaQuery(COMPACT);
	const { panel, setPanel, from, setRest, shut } = usePanel(compact);
	const [searchOpen, setSearchOpen] = useState(false);
	const [origins, setOrigins] = useState<Origins>();

	return {
		compact,
		panel,
		setPanel,
		/** Shut the dropdown, resolving once the history has it shut (`holdPanel`). */
		shutPanel: shut,
		setRest,
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
