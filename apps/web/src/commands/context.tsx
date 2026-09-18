import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from 'react';

import { type Chord, matchesChord } from './chord.js';
import {
	type Command,
	type CommandRegistry,
	createCommandRegistry,
	reachable,
} from './registry.js';

/**
 * The registry as React sees it: a provider around the app, a hook for
 * declaring a command, and a hook for reading the list.
 *
 * Deliberately not a store module with a singleton in it. A test renders the
 * app more than once in a file, and a registry outliving one render would carry
 * the previous test's commands into the next.
 */

const CommandsContext = createContext<CommandRegistry | undefined>(undefined);

export const CommandsProvider = ({ children }: { children: ReactNode }) => {
	// `useState`'s lazy initialiser rather than `useMemo`: both give one registry
	// for the life of the component, but `useMemo` is documented as a cache React
	// may throw away, and a registry thrown away would take every registration
	// with it.
	const [registry] = useState(createCommandRegistry);
	return <CommandsContext.Provider value={registry}>{children}</CommandsContext.Provider>;
};

const useRegistry = (): CommandRegistry => {
	const registry = useContext(CommandsContext);
	if (registry === undefined) {
		throw new Error('Commands are only available inside a CommandsProvider');
	}
	return registry;
};

/**
 * Declaring a command where nothing collects them is allowed, and does nothing.
 *
 * The two sides of the registry are not symmetric. A component that *offers* a
 * command should not require the collector to exist: it is describing what it
 * can do, and a screen rendered on its own — a test, a future route that has no
 * palette — is not wrong for having nobody listening. Reading the list is the
 * other way round: `useCommands` and `useShortcuts` exist only to serve a
 * registry, so asking for one that is not there is a mistake and says so. The
 * shell is where the provider goes, and that is where a missing one shows up.
 */
const useOptionalRegistry = (): CommandRegistry | undefined => useContext(CommandsContext);

/**
 * Declare a command for as long as this component is mounted.
 *
 * The command is re-registered whenever any part of it changes, which is every
 * render for a `run` that is not memoised — cheap, since registering is a `Map`
 * write, and right, since a stale `run` closes over stale state.
 */
export const useCommand = (command: Command): void => {
	const registry = useOptionalRegistry();
	const { id, label, group, chord, enabled, run } = command;
	useEffect(() => {
		if (registry === undefined) return;
		return registry.register({ id, label, group, chord, enabled, run });
	}, [registry, id, label, group, chord, enabled, run]);
};

export const useCommands = (): readonly Command[] => {
	const registry = useRegistry();
	return useSyncExternalStore(registry.subscribe, registry.list, registry.list);
};

/**
 * One listener for every chord in the app.
 *
 * One, rather than a listener per shortcut, because two listeners for the same
 * chord both fire and the second one's `preventDefault` comes too late to mean
 * anything. Here the first match wins and nothing after it runs.
 *
 * A disabled command still *takes* its chord. Otherwise pressing it would fall
 * through to the browser's own — `Mod+N` opening a window — which is a stranger
 * answer than nothing happening.
 */
export const useShortcuts = (): void => {
	// The registry is read when a key is pressed, not subscribed to. Subscribing
	// would re-render the component that calls this on every registration — and
	// since a command's `run` is a fresh closure each render, that component
	// re-registers as it renders, which is a loop: register, notify, render,
	// register. The keyboard needs the commands as they are at the moment of the
	// keystroke, which is exactly what asking then gives it.
	const registry = useRegistry();
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const hit = registry
				.list()
				.find(
					(command): command is Command & { chord: Chord } =>
						command.chord !== undefined &&
						matchesChord(command.chord, event) &&
						reachable(command.chord, event.target)
				);
			if (hit === undefined) return;
			event.preventDefault();
			if (hit.enabled) hit.run();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => {
			window.removeEventListener('keydown', onKeyDown);
		};
	}, [registry]);
};
