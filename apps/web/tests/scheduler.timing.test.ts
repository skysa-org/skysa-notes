import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNote, saveNoteBody } from '../src/store/notes.js';
import type { SyncPhase, SyncSchedulerOptions } from '../src/sync/scheduler.js';
import { lazily } from './noteRows.js';
import {
	bound,
	DEBOUNCE,
	focused,
	INTERVAL,
	quiet,
	reaches,
	started,
	stopSchedulers,
} from './support/scheduler.js';

/**
 * When a push goes (docs/ARCHITECTURE.md §7, "When a push goes"): an edit's a moment
 * after the typing stops, which is all this app queues, and a lazy write's —
 * an app whose changes come every few seconds queues those — with the next
 * sync. The debounce on its own is `scheduler.test.ts`'s.
 */

afterEach(stopSchedulers);

/** How long a lazy write may wait, where the app says (`lazyMs`). */
const LAZY = 30_000;

/** A note the remote already has, and the scheduler idle after sending it. */
const syncedNote = async (overrides: Partial<SyncSchedulerOptions> = {}) => {
	const db = await bound();
	const note = await createNote(db, { title: 'Plan', body: '# Plan\n\none\n' });
	const h = started(db, overrides);
	await vi.waitFor(() => {
		expect(h.remote.fake.contentAt(note.path)).toContain('one');
	});
	await reaches(h.scheduler, 'idle');
	return { ...h, note };
};

const hide = (h: Awaited<ReturnType<typeof syncedNote>>) => {
	h.env.state.visible = false;
	h.env.fire('visibilitychange');
};

describe('when a push goes, in this app', () => {
	it('sends a write queued lazily at the debounce, given no lazyMs', async () => {
		const h = await syncedNote();
		const before = h.remote.pulls();

		await lazily(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();
		expect(h.env.pending()).toEqual([DEBOUNCE, INTERVAL]);

		h.env.advance(DEBOUNCE);
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		});
		await reaches(h.scheduler, 'idle');
		expect(h.remote.pulls()).toBe(before + 1);
	});

	it('starts no run when the page is hidden with nothing waiting to be sent', async () => {
		const h = await syncedNote();
		const before = h.remote.pulls();
		const phases: SyncPhase[] = [];
		h.scheduler.subscribe((status) => {
			phases.push(status.phase);
		});

		hide(h);
		await quiet();

		expect(h.remote.pulls()).toBe(before);
		expect(phases).toEqual([]);
		expect(h.env.pending()).toEqual([INTERVAL]);
	});

	it('sends an edit at once when the page is hidden before its debounce', async () => {
		// A phone may not run the page again for hours once it is out of sight.
		const h = await syncedNote();
		const before = h.remote.pulls();
		await saveNoteBody(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();
		expect(h.env.pending()).toEqual([DEBOUNCE, INTERVAL]);

		hide(h);

		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		});
		await reaches(h.scheduler, 'idle');
		expect(h.remote.pulls()).toBe(before + 1);
		expect(h.env.pending()).toEqual([INTERVAL]);
	});
});

describe('when a lazy write goes, where an app queues them', () => {
	it('sends it when its wait is over, and not at the debounce', async () => {
		const h = await syncedNote({ lazyMs: LAZY });
		const before = h.remote.pulls();

		await lazily(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();
		expect((await h.db.opQueue.toArray()).map((op) => op.lazy)).toEqual([true]);
		expect(h.env.pending()).toEqual([LAZY, INTERVAL]);

		h.env.advance(DEBOUNCE);
		await quiet();
		expect(h.remote.pulls()).toBe(before);
		h.env.advance(LAZY - DEBOUNCE - 1);
		await quiet();
		expect(h.remote.pulls()).toBe(before);

		h.env.advance(1);
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		});
		await reaches(h.scheduler, 'idle');
		expect(h.remote.pulls()).toBe(before + 1);
		expect(await h.db.opQueue.count()).toBe(0);
	});

	it('does not put the wait off for a lazy write that follows', async () => {
		const db = await bound();
		const first = await createNote(db, { title: 'One', body: '# One\n' });
		const second = await createNote(db, { title: 'Two', body: '# Two\n' });
		const h = started(db, { lazyMs: LAZY });
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(second.path)).toContain('Two');
		});
		await reaches(h.scheduler, 'idle');
		const before = h.remote.pulls();

		await lazily(db, first.id, '# One\n\nlater\n');
		await quiet();
		h.env.advance(LAZY / 2);
		// Another note's, so a new op, and lazy as the first is.
		await lazily(db, second.id, '# Two\n\nlater\n');
		await quiet();
		expect(h.env.pending()).toEqual([LAZY / 2, INTERVAL - LAZY / 2]);

		h.env.advance(LAZY / 2);
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(first.path)).toContain('later');
			expect(h.remote.fake.contentAt(second.path)).toContain('later');
		});
		expect(h.remote.pulls()).toBe(before + 1);
	});

	it('sends at the debounce once the note waiting is edited', async () => {
		const h = await syncedNote({ lazyMs: LAZY });
		const before = h.remote.pulls();
		await lazily(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();
		const [lazy] = await h.db.opQueue.toArray();

		// `queueWrite`, finding only a lazy write queued for the note, puts one
		// that is not in its place, at the back of the queue.
		await saveNoteBody(h.db, h.note.id, '# Plan\n\nthree\n');
		const [edited] = await h.db.opQueue.toArray();
		expect(edited?.lazy).toBeUndefined();
		expect(edited?.seq).toBeGreaterThan(lazy?.seq ?? Infinity);
		await quiet();
		expect(h.env.pending()).toEqual([DEBOUNCE, LAZY, INTERVAL]);

		h.env.advance(DEBOUNCE - 1);
		await quiet();
		expect(h.remote.pulls()).toBe(before);
		h.env.advance(1);
		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(h.note.path)).toContain('three');
		});
		await reaches(h.scheduler, 'idle');
		expect(h.remote.pulls()).toBe(before + 1);
		// The run sent what was waiting, and its wait went with it.
		expect(await h.db.opQueue.count()).toBe(0);
		expect(h.env.pending()).toEqual([INTERVAL]);
	});

	it('sends it at the debounce once another note is edited', async () => {
		const h = await syncedNote({ lazyMs: LAZY });
		const before = h.remote.pulls();
		await lazily(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();

		const other = await createNote(h.db, { title: 'Other', body: '# Other\n' });
		await quiet();
		expect(h.env.pending()).toEqual([DEBOUNCE, LAZY, INTERVAL]);
		h.env.advance(DEBOUNCE);

		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(other.path)).toContain('Other');
			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		});
		await reaches(h.scheduler, 'idle');
		expect(h.remote.pulls()).toBe(before + 1);
		expect(h.env.pending()).toEqual([INTERVAL]);
	});

	it('sends it with the poll while the page is in sight, before its own wait is over', async () => {
		const h = await syncedNote({ lazyMs: 5 * INTERVAL });
		const before = h.remote.pulls();
		await lazily(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();
		expect(h.env.pending()).toEqual([INTERVAL, 5 * INTERVAL]);

		h.env.advance(INTERVAL);

		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		});
		await reaches(h.scheduler, 'idle');
		expect(h.remote.pulls()).toBe(before + 1);
		expect(h.env.pending()).toEqual([INTERVAL]);
	});

	it('sends it at once when the page is hidden', async () => {
		const h = await syncedNote({ lazyMs: LAZY });
		const before = h.remote.pulls();
		await lazily(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();
		expect(h.env.pending()).toEqual([LAZY, INTERVAL]);

		hide(h);

		await vi.waitFor(() => {
			expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		});
		await reaches(h.scheduler, 'idle');
		expect(h.remote.pulls()).toBe(before + 1);
		// Nothing is left waiting, and hidden, the poll does nothing.
		expect(h.env.pending()).toEqual([INTERVAL]);
		h.env.advance(INTERVAL);
		await quiet();
		expect(h.remote.pulls()).toBe(before + 1);
	});

	it('ends the wait with any run that sends it', async () => {
		const h = await syncedNote({ lazyMs: LAZY });
		const before = h.remote.pulls();
		await lazily(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();
		expect(h.env.pending()).toEqual([LAZY, INTERVAL]);

		await focused(h);

		expect(h.remote.fake.contentAt(h.note.path)).toContain('two');
		expect(h.env.pending()).toEqual([INTERVAL]);
		h.env.advance(LAZY);
		await quiet();
		expect(h.remote.pulls()).toBe(before + 1);
	});

	it('lets the wait go with the session', async () => {
		const h = await syncedNote({ lazyMs: LAZY });
		await lazily(h.db, h.note.id, '# Plan\n\ntwo\n');
		await quiet();
		expect(h.env.pending()).toEqual([LAZY, INTERVAL]);

		h.scheduler.stop();

		expect(h.env.pending()).toEqual([]);
	});
});
