/**
 * Keyboard chords, as a thing to compare against an event and a thing to print.
 *
 * Written down rather than checked inline at each listener, because a shortcut
 * has to be two things that agree: what the app listens for, and what it tells
 * the user it listens for. Those drifting apart is how a menu ends up promising
 * a key that does nothing (docs/PLAN.md §7).
 */

export interface Chord {
	/** The key itself, lower-cased. `event.key`, not `event.code`. */
	readonly key: string;
	/** Cmd on a Mac, Ctrl everywhere else. */
	readonly mod: boolean;
	readonly shift: boolean;
	readonly alt: boolean;
}

/**
 * `Mod` is Cmd *or* Ctrl, and both are accepted wherever it is asked for.
 *
 * Not a platform sniff. On macOS `Ctrl+K` is free and on Windows `Meta+K` is
 * the OS's, so accepting either costs nothing real — and a browser reporting a
 * platform we did not expect still gets a working shortcut instead of none.
 * The *label* does care which platform it is on; that is `chordLabel`.
 */
export const parseChord = (spec: string): Chord => {
	const parts = spec.split('+').map((part) => part.trim().toLowerCase());
	const key = parts[parts.length - 1] ?? '';
	return {
		key,
		mod: parts.includes('mod'),
		shift: parts.includes('shift'),
		alt: parts.includes('alt'),
	};
};

/** The event a chord describes, modifiers and all. */
export interface ChordEvent {
	readonly key: string;
	readonly metaKey: boolean;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
}

/**
 * Every modifier is checked, including the ones the chord does not want. A
 * chord of `Mod+K` that fired on `Mod+Shift+K` would swallow a shortcut the
 * browser or another chord has, and the user would meet it as one key doing two
 * things at random.
 */
export const matchesChord = (chord: Chord, event: ChordEvent): boolean =>
	event.key.toLowerCase() === chord.key &&
	(event.metaKey || event.ctrlKey) === chord.mod &&
	event.shiftKey === chord.shift &&
	event.altKey === chord.alt;

/**
 * Whether this looks like an Apple keyboard, for labelling only.
 *
 * `navigator.platform` is deprecated and `userAgentData` is Chromium-only, so
 * both are asked and either answer will do. Getting it wrong prints `Ctrl` to
 * somebody holding a Mac, which is a wrong label rather than a broken shortcut —
 * `matchesChord` accepts both modifiers whatever this says.
 */
const onApple = (): boolean => {
	if (typeof navigator === 'undefined') return false;
	const data: unknown = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
	const modern =
		typeof data === 'object' && data !== null && 'platform' in data
			? String((data as { platform?: string }).platform ?? '')
			: '';
	return /mac|iphone|ipad|ipod/i.test(`${modern} ${navigator.platform} ${navigator.userAgent}`);
};

const KEY_LABELS: Record<string, string> = {
	arrowup: '↑',
	arrowdown: '↓',
	arrowleft: '←',
	arrowright: '→',
	enter: '↵',
	escape: 'Esc',
	' ': 'Space',
};

/** A chord as the user's own keyboard spells it. */
export const chordLabel = (chord: Chord, apple = onApple()): string => {
	const key =
		KEY_LABELS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
	const parts = [
		...(chord.mod ? [apple ? '⌘' : 'Ctrl'] : []),
		...(chord.alt ? [apple ? '⌥' : 'Alt'] : []),
		...(chord.shift ? [apple ? '⇧' : 'Shift'] : []),
		key,
	];
	// No separator on a Mac, where the symbols run together as the platform
	// writes them; a `+` everywhere else, where the words need one.
	return apple ? parts.join('') : parts.join('+');
};
