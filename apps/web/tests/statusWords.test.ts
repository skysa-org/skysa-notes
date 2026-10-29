import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	conflictMessage,
	lineStatus,
	statusMessage,
	syncCount,
} from '../src/components/account/statusWords.js';
import { PROGRESS_FROM } from '../src/sync/progress.js';
import type { SchedulerStatus, StuckOp } from '../src/sync/scheduler.js';

/**
 * What the storage panel says about how syncing is going, as tables: the
 * scheduler's status in, the words out (`account/statusWords.ts`). The panel's
 * own tests (`AccountPanel.test.tsx`) keep where the words are drawn — the
 * line, its tooltip under who the account is, the sentence above the line, the
 * bar — and leave every wording to these.
 */

const status = (rest: Omit<SchedulerStatus, 'conflicts'>): SchedulerStatus => ({
	conflicts: [],
	...rest,
});

const thousand = (1000).toLocaleString();

const earlier = new Date('2020-02-03T10:00:00');

describe('the status line', () => {
	it.each<[string, SchedulerStatus, { text: string; title: string | null }]>([
		[
			'names the source before the scheduler has picked it up',
			status({ phase: 'local' }),
			{ text: 'Dropbox', title: null },
		],
		[
			'says it synced, where it never has yet',
			status({ phase: 'idle' }),
			{ text: 'Synced', title: null },
		],
		[
			'gives the date of a sync that was not today',
			status({ phase: 'idle', lastSyncAt: earlier.getTime() }),
			{ text: `Synced ${earlier.toLocaleDateString()}`, title: null },
		],
		[
			'says it is syncing, a short run',
			status({ phase: 'syncing' }),
			{ text: 'Syncing…', title: null },
		],
		[
			'says when syncing is waiting for another tab, over its count',
			status({
				phase: 'syncing',
				progress: { stage: 'uploading', done: 120, total: 1000 },
				waiting: true,
			}),
			{
				text: 'Waiting for a tab',
				title: 'Syncing is waiting for another tab or window of this app to finish with the notes on this device. If this does not go away, close the app’s other tabs.',
			},
		],
		[
			'goes back to the count once it is not waiting',
			status({ phase: 'syncing', progress: { stage: 'uploading', done: 120, total: 1000 } }),
			{
				text: `120 of ${thousand} sent`,
				title: `Sending changes to Dropbox: 120 of ${thousand}.`,
			},
		],
		[
			'says it is checking for changes while it reads them',
			status({
				phase: 'syncing',
				progress: { stage: 'receiving', done: 0, total: 0, listing: true },
			}),
			{ text: 'Checking…', title: 'Checking Dropbox for changes…' },
		],
		[
			'counts the changes it is checking from enough to count',
			status({
				phase: 'syncing',
				progress: { stage: 'receiving', done: 0, total: PROGRESS_FROM, listing: true },
			}),
			{
				text: `${String(PROGRESS_FROM)} changes found`,
				title: `Checking Dropbox for changes: ${String(PROGRESS_FROM)} changed notes found so far.`,
			},
		],
		[
			'counts what it receives once it has finished checking',
			status({
				phase: 'syncing',
				progress: { stage: 'receiving', done: 0, total: 30, listing: false },
			}),
			{ text: '0 of 30 received', title: 'Receiving notes from Dropbox: 0 of 30.' },
		],
		[
			'says it is looking for notes from the start of a re-scan',
			status({
				phase: 'syncing',
				progress: { stage: 'scanning', found: 0, done: 0, listing: true },
			}),
			{ text: 'Looking for notes…', title: 'Looking for notes in Dropbox…' },
		],
		[
			'says it is offline, with the rest in the tooltip',
			status({ phase: 'offline' }),
			{
				text: 'Offline',
				title: 'Offline. Changes are kept on this device and sync when the connection is back.',
			},
		],
		[
			'says it is trying again, with why in the tooltip',
			status({ phase: 'retrying', error: 'dropbox 503: unavailable' }),
			{
				text: 'Trying again shortly',
				title: 'Could not sync with Dropbox. Trying again shortly (dropbox 503: unavailable).',
			},
		],
		[
			'says it is paused',
			status({ phase: 'paused' }),
			{
				text: 'Paused',
				title: 'Syncing with Dropbox is paused on this device. Your edits are kept here and sent when it resumes.',
			},
		],
		[
			'says only that it has stopped, where the user has something to deal with',
			status({ phase: 'attention', error: 'write a.md failed 8 times' }),
			{ text: 'Not syncing', title: null },
		],
	])('%s', (_, given, said) => {
		expect(lineStatus(given, 'Dropbox', true)).toEqual(said);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('gives the time of a sync today', () => {
		// A clock that cannot cross midnight between the sync and the asking.
		vi.useFakeTimers({ now: new Date('2026-03-04T12:00:00'), toFake: ['Date'] });
		const at = new Date();
		at.setHours(9, 5, 0, 0);
		const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

		expect(
			lineStatus(status({ phase: 'idle', lastSyncAt: at.getTime() }), 'Dropbox', true)
		).toEqual({
			text: `Synced ${time}`,
			title: null,
		});
	});
});

describe('the bar under the line', () => {
	it.each<[string, SchedulerStatus['progress'], ReturnType<typeof syncCount>]>([
		[
			'is not there for a short run',
			{ stage: 'uploading', done: 3, total: PROGRESS_FROM - 1 },
			undefined,
		],
		[
			'is not there while a round checks fewer than enough to count',
			{ stage: 'receiving', done: 0, total: 0, listing: true },
			undefined,
		],
		[
			'is not there at the start of a re-scan',
			{ stage: 'scanning', found: 0, done: 0, listing: true },
			undefined,
		],
		[
			'does not know how full it is while a round is still checking',
			{ stage: 'receiving', done: 0, total: PROGRESS_FROM, listing: true },
			{
				text: `${String(PROGRESS_FROM)} changes found`,
				sentence: `Checking Dropbox for changes: ${String(PROGRESS_FROM)} changed notes found so far.`,
				bar: null,
			},
		],
		[
			'does not know how full it is while a re-scan is still finding',
			{ stage: 'scanning', found: 40, done: 0, listing: true },
			{
				text: '40 notes found',
				sentence: 'Looking for notes in Dropbox: 40 found so far.',
				bar: null,
			},
		],
		[
			'is as full as a re-scan has read',
			{ stage: 'scanning', found: 40, done: 10, listing: false },
			{
				text: '10 of 40 received',
				sentence: 'Receiving notes from Dropbox: 10 of 40.',
				bar: { value: 10, max: 40 },
			},
		],
		[
			'is as full as a push has sent',
			{ stage: 'uploading', done: 120, total: 1000 },
			{
				text: `120 of ${thousand} sent`,
				sentence: `Sending changes to Dropbox: 120 of ${thousand}.`,
				bar: { value: 120, max: 1000 },
			},
		],
	])('%s', (_, progress, count) => {
		expect(syncCount(progress, 'Dropbox')).toEqual(count);
	});
});

const stuck = (op: StuckOp['op'], rest: Partial<StuckOp> = {}): SchedulerStatus =>
	status({
		phase: 'attention',
		stuck: {
			op,
			path: 'Work/Plan.md',
			attempts: 5,
			error: 'insufficient permissions',
			...rest,
		},
	});

const queued = 'Everything queued behind it is waiting. “Sync now” tries again.';

describe('the sentence above the line', () => {
	it.each<[string, SchedulerStatus, string | null]>([
		[
			'says nothing before the scheduler has picked the source up',
			status({ phase: 'local' }),
			null,
		],
		[
			'says when changes could not be sent',
			status({ phase: 'attention', error: 'write a.md failed 8 times' }),
			'Some changes could not be sent to Dropbox. They will be tried again (write a.md failed 8 times).',
		],
		[
			'says changes could not be sent where nothing said why',
			status({ phase: 'attention' }),
			'Some changes could not be sent to Dropbox. They will be tried again (unknown error).',
		],
		[
			'says which change is stuck, and by the name the user gave it',
			stuck('move', { path: 'Plan.md', targetPath: 'Work/Plan.md' }),
			`Dropbox would not take the rename of Work/Plan.md after 5 tries (insufficient permissions). ${queued}`,
		],
		[
			'says a stuck change this version cannot read is one (#447)',
			stuck('malformed', { path: 'Away.md', error: 'teleport' }),
			'A change to Away.md could not be sent to Dropbox after 5 tries: this version of the app cannot read it (teleport). Everything queued behind it is waiting. Updating the app may let it through.',
		],
		[
			'says a stuck edit',
			stuck('write'),
			`Dropbox would not take the edit to Work/Plan.md after 5 tries (insufficient permissions). ${queued}`,
		],
		[
			'counts a single try as one',
			stuck('write', { attempts: 1 }),
			`Dropbox would not take the edit to Work/Plan.md after 1 try (insufficient permissions). ${queued}`,
		],
		[
			'says a stuck deletion',
			stuck('delete'),
			`Dropbox would not take the deletion of Work/Plan.md after 5 tries (insufficient permissions). ${queued}`,
		],
		[
			'says a stuck new notebook',
			stuck('mkdir', { path: 'Work' }),
			`Dropbox would not take the new notebook Work after 5 tries (insufficient permissions). ${queued}`,
		],
		[
			'says a stuck notebook removal',
			stuck('rmdir', { path: 'Work' }),
			`Dropbox would not take the removal of the notebook Work after 5 tries (insufficient permissions). ${queued}`,
		],
		[
			'says a stuck upload',
			stuck('upload', { path: 'Work/photo.png' }),
			`Dropbox would not take the upload of Work/photo.png after 5 tries (insufficient permissions). ${queued}`,
		],
		[
			'says a stuck file move, by where it was going',
			stuck('move-file', { path: 'photo.png', targetPath: 'Work/photo.png' }),
			`Dropbox would not take the move of the file to Work/photo.png after 5 tries (insufficient permissions). ${queued}`,
		],
		[
			'says a stuck file deletion',
			stuck('delete-file', { path: 'Work/photo.png' }),
			`Dropbox would not take the deletion of the file Work/photo.png after 5 tries (insufficient permissions). ${queued}`,
		],
		[
			'says a stuck change failed for want of a reason where none was given',
			stuck('write', { error: undefined }),
			`Dropbox would not take the edit to Work/Plan.md after 5 tries (unknown error). ${queued}`,
		],
		[
			'says the server has no such connection',
			status({ phase: 'attention', refusal: 'not_found' }),
			'The server no longer has this Dropbox connection.',
		],
		[
			'says why the server refuses, in its policy’s kind of no',
			status({
				phase: 'attention',
				refusal: 'not_entitled',
				denial: { code: 'lapsed' },
			}),
			"This account's access to sync on this server has lapsed.",
		],
		[
			'says a refusal is one where the policy did not say which kind',
			status({ phase: 'attention', refusal: 'not_entitled' }),
			'This account cannot sync on this server.',
		],
		[
			'says nothing where connecting again is the answer, which the panel offers instead',
			status({ phase: 'attention', refusal: 'reauthorize_required' }),
			null,
		],
		[
			'says nothing for an ended authorization either',
			status({ phase: 'attention', error: 'authorization required' }),
			null,
		],
		[
			'says nothing where the device holds no credential for the source',
			status({ phase: 'attention', refusal: 'credential_required' }),
			null,
		],
		[
			'says nothing where the source’s credential was revoked',
			status({ phase: 'attention', refusal: 'credential_revoked' }),
			null,
		],
		['says it is syncing, a short run', status({ phase: 'syncing' }), 'Syncing…'],
		[
			'says it is waiting for another tab, over its count',
			status({
				phase: 'syncing',
				progress: { stage: 'uploading', done: 120, total: 1000 },
				waiting: true,
			}),
			'Syncing is waiting for another tab or window of this app to finish with the notes on this device. If this does not go away, close the app’s other tabs.',
		],
		[
			'counts a long run',
			status({ phase: 'syncing', progress: { stage: 'uploading', done: 120, total: 1000 } }),
			`Sending changes to Dropbox: 120 of ${thousand}.`,
		],
		[
			'counts the changes it is checking, over saying it checks',
			status({
				phase: 'syncing',
				progress: { stage: 'receiving', done: 0, total: PROGRESS_FROM, listing: true },
			}),
			`Checking Dropbox for changes: ${String(PROGRESS_FROM)} changed notes found so far.`,
		],
		[
			'says it is checking before it has found enough to count',
			status({
				phase: 'syncing',
				progress: { stage: 'receiving', done: 0, total: 0, listing: true },
			}),
			'Checking Dropbox for changes…',
		],
		[
			'says it is looking for notes from the start of a re-scan',
			status({
				phase: 'syncing',
				progress: { stage: 'scanning', found: 0, done: 0, listing: true },
			}),
			'Looking for notes in Dropbox…',
		],
		['says it synced, where it never has yet', status({ phase: 'idle' }), 'Synced'],
		[
			'gives the date of a sync that was not today',
			status({ phase: 'idle', lastSyncAt: earlier.getTime() }),
			`Synced ${earlier.toLocaleDateString()}`,
		],
		[
			'says it is offline',
			status({ phase: 'offline' }),
			'Offline. Changes are kept on this device and sync when the connection is back.',
		],
		[
			'says it is paused',
			status({ phase: 'paused' }),
			'Syncing with Dropbox is paused on this device. Your edits are kept here and sent when it resumes.',
		],
		[
			'says it is trying again, and why',
			status({ phase: 'retrying', error: 'dropbox 503: unavailable' }),
			'Could not sync with Dropbox. Trying again shortly (dropbox 503: unavailable).',
		],
		[
			'says it is trying again where nothing said why',
			status({ phase: 'retrying' }),
			'Could not sync with Dropbox. Trying again shortly (unknown error).',
		],
	])('%s', (_, given, said) => {
		expect(statusMessage(given, 'Dropbox', true)).toBe(said);
	});

	it.each<[string, SchedulerStatus]>([
		['an error', status({ phase: 'attention', error: 'boom' })],
		['a stuck change', stuck('write')],
		['a refusal', status({ phase: 'attention', refusal: 'not_entitled' })],
		['a missing connection', status({ phase: 'attention', refusal: 'not_found' })],
	])('says this build cannot sync the provider, over %s', (_, given) => {
		expect(statusMessage(given, 'WebDAV', false)).toBe('This app cannot sync with WebDAV yet.');
	});

	it('says nothing where connecting again is the answer, even for a provider this build cannot sync', () => {
		expect(
			statusMessage(
				status({ phase: 'attention', refusal: 'reauthorize_required' }),
				'WebDAV',
				false
			)
		).toBeNull();
	});
});

describe('conflict copies', () => {
	it.each([
		[
			1,
			'A note was edited here and elsewhere at once. Both versions are kept; the copy has "conflict" in its name.',
		],
		[
			2,
			'2 notes were edited here and elsewhere at once. Both versions of each are kept; the copies have "conflict" in their names.',
		],
	])('are counted: %i', (count, said) => {
		expect(conflictMessage(count)).toBe(said);
	});
});
