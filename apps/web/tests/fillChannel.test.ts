import '../src/jitless.js';

import { describe, expect, it, vi } from 'vitest';

import { type ChannelWindow, openChannel } from '../src/fill/channel.js';
import { BOOKMARKLET_REVISION, FILL_MESSAGE, FILL_VERSION } from '../src/fill/protocol.js';

/**
 * The fill window's side of the bookmarklet's protocol (docs/ARCHITECTURE.md
 * §7, "Filling in on a site", and §9): a page is told only its own logins,
 * because the window takes the page to be the origin the browser stamped on
 * its `hello`, takes a `hello` only from its opener and only once, and sends
 * the login back to that origin alone.
 */

const APP = 'https://notes.example';
const SITE = 'https://login.example.com';

const hello = (more: Record<string, unknown> = {}) => ({
	type: FILL_MESSAGE,
	v: FILL_VERSION,
	b: BOOKMARKLET_REVISION,
	step: 'hello',
	username: 'ada',
	password: 'typed',
	newPassword: '',
	fields: { username: true, password: true, newPassword: false },
	...more,
});

/** The opener's `postMessage`, as the test watches it. */
const post = () => vi.fn<(message: unknown, targetOrigin: string) => void>();

/** A window with an opener, or none, and a way to deliver it a message. */
const windowWith = (opener: { postMessage: ReturnType<typeof post>; closed?: boolean } | null) => {
	const listeners = new Set<(event: MessageEvent) => void>();
	const win: ChannelWindow = {
		opener,
		location: { origin: APP },
		addEventListener: (_type, listener) => {
			listeners.add(listener);
		},
	};
	const deliver = (data: unknown, from: Readonly<{ source: unknown; origin: string }>) => {
		// jsdom's MessageEvent takes only its own windows for `source`.
		const event = { data, origin: from.origin, source: from.source } as unknown as MessageEvent;
		listeners.forEach((listener) => {
			listener(event);
		});
	};
	return { win, deliver };
};

const opened = (options: Parameters<typeof openChannel>[1] = {}) => {
	const opener = { postMessage: post(), closed: false };
	const { win, deliver } = windowWith(opener);
	const channel = openChannel(win, { setTimer: () => undefined, ...options });
	const fromOpener = (data: unknown, origin = SITE) => {
		deliver(data, { source: opener, origin });
	};
	return { opener, channel, deliver, fromOpener };
};

describe('the fill window, as it opens', () => {
	it('tells its opener it is ready, saying nothing else, to any origin', () => {
		const { opener, channel } = opened();

		expect(opener.postMessage).toHaveBeenCalledWith(
			{ type: FILL_MESSAGE, v: FILL_VERSION, step: 'ready' },
			'*'
		);
		expect(channel.current()).toEqual({ state: 'waiting', slow: false });
	});

	it('is alone where no page opened it, or one cut it off', () => {
		const { win } = windowWith(null);

		expect(openChannel(win).current()).toEqual({ state: 'alone' });
	});

	it('says it is waiting once a while has passed, and still takes the page’s answer', () => {
		const timers: (() => void)[] = [];
		const { channel, fromOpener } = opened({
			setTimer: (run) => {
				timers.push(run);
			},
		});
		const heard = vi.fn();
		channel.subscribe(heard);

		timers.forEach((run) => {
			run();
		});
		expect(channel.current()).toEqual({ state: 'waiting', slow: true });

		fromOpener(hello());
		expect(channel.current().state).toBe('hello');
		expect(heard).toHaveBeenCalledTimes(2);
	});
});

describe('a hello', () => {
	it('names the page by the origin the browser stamped on it', () => {
		const { channel, fromOpener } = opened();

		fromOpener(hello({ origin: 'https://bank.example', site: 'bank.example' }));

		expect(channel.current()).toMatchObject({
			state: 'hello',
			origin: SITE,
			site: { secure: true, host: 'login.example.com', port: '', exact: false },
			hello: { username: 'ada', password: 'typed', newPassword: '' },
			outdated: false,
		});
	});

	it('is not taken from any window but the opener', () => {
		const { channel, deliver } = opened();

		deliver(hello(), { source: { postMessage: post() }, origin: SITE });
		deliver(hello(), { source: null, origin: SITE });

		expect(channel.current().state).toBe('waiting');
	});

	it('is not taken from the app’s own origin, an opaque one, or one off the web', () => {
		const { channel, fromOpener } = opened();

		fromOpener(hello(), APP);
		fromOpener(hello(), 'null');
		fromOpener(hello(), 'file://');
		fromOpener(hello(), 'chrome-extension://abcdef');

		expect(channel.current().state).toBe('waiting');
	});

	it('is not taken where it is not the protocol’s, or not a hello', () => {
		const { channel, fromOpener } = opened();

		fromOpener('hello');
		fromOpener(null);
		fromOpener({ ...hello(), type: 'other' });
		fromOpener({ ...hello(), step: 'fill' });
		fromOpener({ ...hello(), v: '1' });

		expect(channel.current().state).toBe('waiting');
	});

	it('is taken only once: the page is fixed by the first', () => {
		const { channel, fromOpener } = opened();

		fromOpener(hello());
		// The opener gone on to another site, or a frame in it, answering again.
		fromOpener(hello({ username: 'mallory' }), 'https://evil.example');

		expect(channel.current()).toMatchObject({ origin: SITE, hello: { username: 'ada' } });
	});

	it('reads a value that is not text, or too long, as nothing, and what it does not know not at all', () => {
		const { channel, fromOpener } = opened();

		fromOpener(
			hello({
				username: 42,
				password: 'x'.repeat(5000),
				fields: 'all',
				later: 'unread',
			})
		);

		const at = channel.current();
		expect(at).toMatchObject({
			state: 'hello',
			hello: {
				username: '',
				password: '',
				fields: { username: false, password: false, newPassword: false },
			},
		});
		expect(at.state === 'hello' && 'later' in at.hello).toBe(false);
	});

	it('from an older bookmarklet that still works says so', () => {
		const { channel, fromOpener } = opened();

		fromOpener(hello({ b: BOOKMARKLET_REVISION - 1 }));

		expect(channel.current()).toMatchObject({ state: 'hello', outdated: true });
	});

	it('of a later version is not read, and says the app is behind', () => {
		const { channel, fromOpener } = opened();

		fromOpener({ type: FILL_MESSAGE, v: FILL_VERSION + 1, step: 'hello', anything: true });

		expect(channel.current()).toEqual({ state: 'newer' });
	});

	it('of an earlier version than any this app reads says the bookmarklet is', () => {
		const { channel, fromOpener } = opened();

		fromOpener(hello({ v: FILL_VERSION - 1 }));

		expect(channel.current()).toEqual({ state: 'older' });
	});
});

describe('a login filled', () => {
	it('goes to the opener, to the origin as the browser said it', () => {
		const { opener, channel, fromOpener } = opened();
		fromOpener(hello(), 'https://example.com.');

		expect(channel.fill({ username: 'ada', password: 's3cret' })).toBe(true);

		expect(opener.postMessage).toHaveBeenLastCalledWith(
			{
				type: FILL_MESSAGE,
				v: FILL_VERSION,
				step: 'fill',
				username: 'ada',
				password: 's3cret',
			},
			'https://example.com.'
		);
	});

	it('goes nowhere before the page has said who it is, or once it has gone', () => {
		const { opener, channel, fromOpener } = opened();

		expect(channel.fill({ username: 'ada', password: 's3cret' })).toBe(false);
		fromOpener(hello());
		opener.closed = true;
		expect(channel.fill({ username: 'ada', password: 's3cret' })).toBe(false);

		expect(opener.postMessage).toHaveBeenCalledTimes(1);
	});
});
