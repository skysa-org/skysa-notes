import { type SchedulerEnvironment, type SchedulerEvent } from '../../../src/sync/scheduler.js';

/**
 * The browser, as the sync scheduler and the change relay see it: a clock, the
 * events they listen for, timers and locks, all moved by the test. One fake for
 * both: the relay's environment is the scheduler's without `withLock`, and
 * listens for fewer events.
 */
export const fakeEnvironment = () => {
	const state = { now: 1_000_000, online: true, visible: true, nextId: 0 };
	const handlers = new Map<SchedulerEvent, Set<() => void>>();
	const timers = new Map<number, { at: number; callback: () => void }>();
	/** Each lock's tail: the next holder waits for it. */
	const locks = new Map<string, Promise<void>>();

	const fire = (event: SchedulerEvent) => {
		handlers.get(event)?.forEach((handler) => {
			handler();
		});
	};

	const environment: SchedulerEnvironment = {
		now: () => state.now,
		isOnline: () => state.online,
		isVisible: () => state.visible,
		listen: (event, handler) => {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => {
				set.delete(handler);
			};
		},
		setTimer: (callback, ms) => {
			state.nextId += 1;
			const id = state.nextId;
			timers.set(id, { at: state.now + ms, callback });
			return () => {
				timers.delete(id);
			};
		},
		withLock: <T>(name: string, work: () => Promise<T>): Promise<T> => {
			const held = (locks.get(name) ?? Promise.resolve()).then(work);
			locks.set(
				name,
				held.then(
					() => undefined,
					() => undefined
				)
			);
			return held;
		},
	};

	return {
		environment,
		state,
		fire,
		/** How many listeners are on, across every event. */
		listening: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
		/** Hidden or shown, offline or online, and the event that says so. */
		set: (change: { visible?: boolean; online?: boolean }) => {
			if (change.visible !== undefined) {
				state.visible = change.visible;
				fire('visibilitychange');
			}
			if (change.online !== undefined) {
				state.online = change.online;
				fire(change.online ? 'online' : 'offline');
			}
		},
		/** Move the clock on, running every timer that comes due on the way. */
		advance: (ms: number) => {
			state.now += ms;
			[...timers.entries()]
				.filter(([, timer]) => timer.at <= state.now)
				.sort(([, a], [, b]) => a.at - b.at)
				.forEach(([id, timer]) => {
					timers.delete(id);
					timer.callback();
				});
		},
		/** How far away each pending timer is. */
		pending: () =>
			[...timers.values()].map((timer) => timer.at - state.now).sort((a, b) => a - b),
	};
};
