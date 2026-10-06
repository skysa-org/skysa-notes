import {
	RELAY_CHANGED as CHANGED,
	RELAY_CLOSE,
	RELAY_PUSHED_INTERVAL_MS as PUSHED_INTERVAL_MS,
} from '@skysa/core';
import { describe, expect, it } from 'vitest';

import {
	MAX_FRAME_BYTES,
	onFrame,
	onRevoke,
	type RoomSocket,
	type Seat,
} from '../src/relay/room.js';

/**
 * Who hears what, on one connection's relay, apart from any runtime
 * (docs/ARCHITECTURE.md §6, "Change relay").
 */

const NOW = 1_000_000;
const HOUR = 60 * 60 * 1000;
const PUSHED = JSON.stringify({ t: 'pushed' });

const socket = (grantId: string, seat: Partial<Seat> = {}) => {
	const sent: string[] = [];
	const closed: { code: number; reason: string }[] = [];
	const state = { seat: { grantId, until: NOW + HOUR, lastPushedAt: 0, ...seat } };
	const room: RoomSocket = {
		get seat() {
			return state.seat;
		},
		reseat: (next) => {
			state.seat = next;
		},
		send: (text) => sent.push(text),
		close: (code, reason) => closed.push({ code, reason }),
	};
	return { room, sent, closed, state };
};

describe('a pushed frame', () => {
	it('tells every other device on the connection, and not the one that pushed', () => {
		const phone = socket('phone');
		const laptop = socket('laptop');
		const tablet = socket('tablet');

		onFrame(phone.room, PUSHED, [phone.room, laptop.room, tablet.room], NOW);

		expect(laptop.sent).toEqual([CHANGED]);
		expect(tablet.sent).toEqual([CHANGED]);
		expect(phone.sent).toEqual([]);
		expect(JSON.parse(CHANGED)).toEqual({ t: 'changed' });
	});

	it('leaves the pusher’s other tabs alone: they share its store', () => {
		const tab = socket('phone');
		const otherTab = socket('phone');
		const laptop = socket('laptop');

		onFrame(tab.room, PUSHED, [tab.room, otherTab.room, laptop.room], NOW);

		expect(otherTab.sent).toEqual([]);
		expect(laptop.sent).toEqual([CHANGED]);
	});

	it('passes on one a second per socket, and drops the rest', () => {
		const phone = socket('phone');
		const laptop = socket('laptop');
		const everyone = [phone.room, laptop.room];

		onFrame(phone.room, PUSHED, everyone, NOW);
		onFrame(phone.room, PUSHED, everyone, NOW + PUSHED_INTERVAL_MS - 1);
		expect(laptop.sent).toHaveLength(1);

		onFrame(phone.room, PUSHED, everyone, NOW + PUSHED_INTERVAL_MS);
		expect(laptop.sent).toHaveLength(2);
		expect(phone.closed).toEqual([]);
	});

	it('closes a recipient past its hour instead of telling it', () => {
		const phone = socket('phone');
		const stale = socket('laptop', { until: NOW });

		onFrame(phone.room, PUSHED, [phone.room, stale.room], NOW);

		expect(stale.sent).toEqual([]);
		expect(stale.closed).toEqual([{ code: RELAY_CLOSE.expired, reason: 'expired' }]);
	});

	it('closes a sender past its hour instead of hearing it', () => {
		const phone = socket('phone', { until: NOW });
		const laptop = socket('laptop');

		onFrame(phone.room, PUSHED, [phone.room, laptop.room], NOW);

		expect(phone.closed).toEqual([{ code: RELAY_CLOSE.expired, reason: 'expired' }]);
		expect(laptop.sent).toEqual([]);
	});
});

describe('anything else', () => {
	it('closes the socket that sent it, and tells nobody', () => {
		const frames: (string | ArrayBuffer)[] = [
			'pushed',
			'{}',
			JSON.stringify({ t: 'changed' }),
			JSON.stringify({ t: 'pushed', path: 'Work/Plan.md' }),
			// Valid, and too long: trailing whitespace is still JSON.
			`${PUSHED}${' '.repeat(MAX_FRAME_BYTES)}`,
			new ArrayBuffer(8),
			'not json',
		];

		frames.forEach((frame, i) => {
			const phone = socket('phone');
			const laptop = socket('laptop');

			onFrame(phone.room, frame, [phone.room, laptop.room], NOW);

			expect(phone.closed, `frame ${String(i)}`).toEqual([
				{ code: 1008, reason: 'unexpected message' },
			]);
			expect(laptop.sent).toEqual([]);
		});
	});
});

describe('a revoke', () => {
	it('closes the named grants’ sockets, every tab of them', () => {
		const phone = socket('phone');
		const phoneTab = socket('phone');
		const laptop = socket('laptop');

		onRevoke([phone.room, phoneTab.room, laptop.room], ['phone']);

		expect(phone.closed).toEqual([{ code: RELAY_CLOSE.revoked, reason: 'revoked' }]);
		expect(phoneTab.closed).toEqual([{ code: RELAY_CLOSE.revoked, reason: 'revoked' }]);
		expect(laptop.closed).toEqual([]);
	});

	it('closes every socket when the connection has gone', () => {
		const phone = socket('phone');
		const laptop = socket('laptop');

		onRevoke([phone.room, laptop.room]);

		expect([phone.closed, laptop.closed]).toEqual([
			[{ code: RELAY_CLOSE.revoked, reason: 'revoked' }],
			[{ code: RELAY_CLOSE.revoked, reason: 'revoked' }],
		]);
	});
});
