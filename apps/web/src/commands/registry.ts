import { type Chord } from './chord.js';

/**
 * The things the app can be asked to do, as a list rather than as a pile of
 * click handlers.
 *
 * One list serves two callers that must never disagree: the keyboard, which
 * runs a command when its chord is pressed, and the palette, which shows the
 * user what there is and what each one's chord is. A shortcut that exists only
 * in a listener is one nobody can discover; a palette entry with a chord typed
 * into its label is one that goes stale the day the listener changes.
 *
 * Commands are *registered by whoever owns the action*, not collected in one
 * place. Switching a note between rich and raw needs the pending edit flushed
 * first, and what is pending is known only inside `NoteView` — hoisting that
 * into a central list would mean hoisting the state it depends on. So each
 * component declares what it can do, and this holds the union.
 */

export interface Command {
	/** Stable, and unique across the app: it is the registration key. */
	readonly id: string;
	/** What the palette shows. Sentence case, no trailing period. */
	readonly label: string;
	/** Where it belongs in the palette, and a word to search it by. */
	readonly group: string;
	readonly chord?: Chord;
	/**
	 * False when the command exists but cannot be run now — no notebook open, no
	 * note selected. It stays *visible* and is shown as unavailable rather than
	 * quietly vanishing: a palette whose contents change as the user moves around
	 * cannot be learned, and "why is it not there" is a worse question than "why
	 * is it greyed out".
	 */
	readonly enabled: boolean;
	readonly run: () => void;
}

export interface CommandRegistry {
	/** Add a command, and hand back the way to take it out again. */
	readonly register: (command: Command) => () => void;
	readonly list: () => readonly Command[];
	readonly subscribe: (listener: () => void) => () => void;
	/**
	 * Hold every chord until the returned release is called.
	 *
	 * For whoever is in front of the user: a modal dialog is the app saying "this
	 * first", and a shortcut that fires behind it acts on a screen the user
	 * cannot see. `Mod+E` pressed out of habit over an open palette would flip
	 * the note underneath between editors, and the palette would then run
	 * whatever row Enter was resting on, on top of that.
	 *
	 * Counted rather than a flag, so two overlapping holders cannot release each
	 * other's.
	 */
	readonly suspend: () => () => void;
	readonly suspended: () => boolean;
}

export const createCommandRegistry = (): CommandRegistry => {
	// A Map keyed by id, so a component re-registering the same command as its
	// closures change replaces rather than duplicates.
	const commands = new Map<string, Command>();
	const listeners = new Set<() => void>();
	// Each holder is its own object, so releasing one twice is not releasing
	// somebody else's.
	const holds = new Set<object>();
	// `list` must return the *same* array until something actually changes:
	// `useSyncExternalStore` compares snapshots by identity and would otherwise
	// re-render forever.
	const snapshot = { current: [] as readonly Command[] };

	const changed = () => {
		snapshot.current = [...commands.values()];
		listeners.forEach((listener) => {
			listener();
		});
	};

	return {
		register: (command) => {
			commands.set(command.id, command);
			changed();
			return () => {
				// Only if it is still ours. Under React's strict-mode double
				// mount the new registration lands before the old cleanup runs,
				// and an unconditional delete would remove the live one.
				if (commands.get(command.id) === command) {
					commands.delete(command.id);
					changed();
				}
			};
		},
		list: () => snapshot.current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		suspend: () => {
			const hold = {};
			holds.add(hold);
			return () => {
				holds.delete(hold);
			};
		},
		suspended: () => holds.size > 0,
	};
};

/**
 * Whether a keystroke should be allowed to reach a chord, given where it
 * landed.
 *
 * `Mod+K` always may: it is not something anybody types into a field. A bare key
 * never may while the user is in a text box, or every shortcut without a
 * modifier would be unreachable from the one place people spend their time —
 * writing. Alt is asked the same question as a bare key rather than waved
 * through: on macOS `Option+<letter>` types a character, so an Alt chord in a
 * field is the user writing.
 */
export const reachable = (chord: Chord, target: EventTarget | null): boolean => {
	if (chord.mod) return true;
	if (!(target instanceof HTMLElement)) return true;
	const name = target.tagName.toLowerCase();
	return !(
		name === 'input' ||
		name === 'textarea' ||
		name === 'select' ||
		target.isContentEditable
	);
};
