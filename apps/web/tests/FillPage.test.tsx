import '../src/jitless.js';

import { pageSite } from '@skysa/core';
import { act, cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChannelState, FillChannel } from '../src/fill/channel.js';
import { FillPage } from '../src/fill/FillPage.js';
import { BOOKMARKLET_REVISION, FILL_MESSAGE, FILL_VERSION } from '../src/fill/protocol.js';
import { freshDatabase } from './support/db.js';

/**
 * The fill window (docs/ARCHITECTURE.md §7, "Filling in on a site"): what it
 * says of the page while it does not know it, or cannot read what it says,
 * and the page's site once it does.
 */

/** A channel whose state the test moves on. */
const channelAt = (first: ChannelState) => {
	const listeners = new Set<() => void>();
	const at = { current: first };
	const channel: FillChannel = {
		current: () => at.current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		fill: () => false,
	};
	const move = (next: ChannelState) => {
		act(() => {
			at.current = next;
			listeners.forEach((listener) => {
				listener();
			});
		});
	};
	return { channel, move };
};

const hello = (origin: string, b = BOOKMARKLET_REVISION): ChannelState => {
	const site = pageSite(origin);
	if (site === undefined) throw new Error(origin);
	return {
		state: 'hello',
		origin,
		site,
		hello: {
			type: FILL_MESSAGE,
			v: FILL_VERSION,
			b,
			step: 'hello',
			username: '',
			password: '',
			newPassword: '',
			fields: { username: true, password: true, newPassword: false },
		},
		outdated: b < BOOKMARKLET_REVISION,
	};
};

describe('the fill window', () => {
	it('says it is reaching the page, then that it is still waiting, then names the site', () => {
		const { channel, move } = channelAt({ state: 'waiting', slow: false });
		render(<FillPage channel={channel} db={freshDatabase()} />);

		expect(screen.getByRole('status').textContent).toBe('Reaching the page…');
		expect(document.title).toBe('Fill in');

		move({ state: 'waiting', slow: true });
		expect(screen.getByRole('status').textContent).toMatch(/^Still waiting for the page/u);

		move(hello('https://login.example.com'));
		expect(screen.getByRole('heading', { name: 'Fill in on login.example.com' })).toBeDefined();
		expect(document.title).toBe('Fill in on login.example.com');
		expect(screen.queryByText('Not secure')).toBeNull();
	});

	it('marks a page over http as not secure, and names its port', () => {
		const { channel } = channelAt(hello('http://router.example:8080'));
		render(<FillPage channel={channel} db={freshDatabase()} />);

		expect(
			screen.getByRole('heading', { name: 'Fill in on router.example:8080' })
		).toBeDefined();
		expect(screen.getByText('Not secure')).toBeDefined();
	});

	it('says, opened by no page, how to use it, with the way to Passwords', () => {
		const { channel } = channelAt({ state: 'alone' });
		render(<FillPage channel={channel} db={freshDatabase()} />);

		expect(screen.getByText(/^This window could not reach a page/u)).toBeDefined();
		expect(screen.getByRole('button', { name: 'Open Passwords' })).toBeDefined();
	});

	it('says which is behind, the app or the bookmarklet, where it cannot read it', () => {
		const newer = channelAt({ state: 'newer' });
		render(<FillPage channel={newer.channel} db={freshDatabase()} />);
		expect(screen.getByText(/^This bookmarklet is newer than the app/u)).toBeDefined();
		cleanup();

		const older = channelAt({ state: 'older' });
		render(<FillPage channel={older.channel} db={freshDatabase()} />);
		expect(screen.getByText(/^This bookmarklet is out of date/u)).toBeDefined();
	});

	it('says where a newer bookmarklet is, for one that still works', () => {
		const { channel } = channelAt(hello('https://example.com', BOOKMARKLET_REVISION - 1));
		render(<FillPage channel={channel} db={freshDatabase()} />);

		expect(screen.getByText(/^A newer bookmarklet is in Passwords/u)).toBeDefined();
	});
});
