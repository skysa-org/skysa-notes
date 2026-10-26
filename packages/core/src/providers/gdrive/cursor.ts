import { z } from 'zod';

import {
	applyAll,
	applyItem,
	arrivals,
	hideLeftFolders,
	nodesOf,
	type Page,
	pageFrom,
	readTreeCursor,
	settlePage,
	treeCursorBase,
	type TreeItem,
} from '../idTree.js';
import {
	type ChangeEntry,
	type ChangeSet,
	CursorResetError,
	ProviderResponseError,
} from '../types.js';
import { clashes, createSeparate } from './duplicates.js';
import type { AppFolder } from './root.js';
import {
	type ChangeList,
	CHANGES,
	type DriveChange,
	type DriveClient,
	type DriveFailure,
	type DriveFile,
	FIELDS,
	type FileList,
	FILES,
	isFolder,
	MAX_DEPTH,
	PAGE_SIZE,
	treeItemOf,
	WRITES_AT_ONCE,
} from './wire.js';

/**
 * Folders whose contents are asked for at once (`listArrivals`), as many as
 * notes are sent. A list is 100 of the 325,000 quota units a user has a
 * minute, so four at a time is nowhere near the limit.
 * https://developers.google.com/workspace/drive/api/guides/limits
 */
const LISTS_AT_ONCE = WRITES_AT_ONCE;

/**
 * `drive` changes are about shared drives, which `drive.file` never reaches.
 * A `removed` change is "deletion or loss of access", and carries no file.
 */
const changeItem = (change: DriveChange): TreeItem[] => {
	if (change.changeType === 'drive') return [];
	const id = change.fileId ?? change.file?.id;
	if (id === undefined || id === '')
		throw new ProviderResponseError('gdrive sent a change with no file id');
	if (change.removed === true || change.file === undefined) return [{ id, gone: true }];
	return [treeItemOf({ ...change.file, id })];
};

// ---------------------------------------------------------------------------
// The cursor.
//
// A round from nothing is a scan — every file the app can see, by `files.list`
// — and every round after it follows the change feed. The start token is asked
// for *before* the scan, so a change made while the scan runs is reported
// again afterwards rather than missed. The tree travels with it (`idTree.ts`).
// ---------------------------------------------------------------------------

const cursorSchema = z.object({
	...treeCursorBase,
	phase: z.enum(['scan', 'feed']),
	/** The page to fetch: a `files.list` page token in a scan, a changes token after. */
	token: z.string(),
	/** Where the feed begins once the scan is done. */
	start: z.string().min(1),
	/**
	 * Pages of the feed this round has read, on a cursor written mid-round
	 * (`feedLimit`). Absent at a round's start, and on every cursor written
	 * before it was added, which are read as one.
	 */
	walked: z.number().int().positive().optional(),
});

type DriveCursor = z.infer<typeof cursorSchema>;

/** A cursor for a page after its round's first: one this adapter wrote mid-round. */
const midRound = (cursor: DriveCursor): boolean =>
	cursor.phase === 'scan' ? cursor.token !== '' : cursor.walked !== undefined;

/**
 * How many pages of the change feed a round reads before it scans instead.
 *
 * `drive.file` hides every change the app cannot see, but Drive still pages
 * through them: a phone away for a day while the account was busy elsewhere
 * read 60 empty pages, two requests each, about 45 s of "Checking for
 * changes…" with nothing found, before the 16 that held the notes another
 * device had imported (measured on a Pixel against a live account,
 * 2026-10-14). A scan lists only what the app can see, a page per thousand, so
 * past twice what one would take the feed is the longer way round, and the
 * round becomes a scan. The engine's answer to a reset is that scan, and a
 * feed round is read whole before any of it is applied, so nothing read is
 * half kept. The tree's size stands in for the scan's: it is what the app
 * can see, near enough.
 */
const feedLimit = (nodes: number): number => 2 * Math.max(1, Math.ceil(nodes / PAGE_SIZE)) + 2;

const parseCursor = (cursor: string): DriveCursor => readTreeCursor(cursorSchema, cursor, 'gdrive');

/**
 * On a token we stored, Drive's answer to one it cannot use is not documented.
 * A 404 or 410 is read as that, and so is a 400 that names the page token — in
 * its `location`, its reason or its message, since which of them Drive fills is
 * not documented either, and a dead token not recognised is a sync that fails
 * for ever. Any other 400 is a mistake in the request, and resetting over it
 * would rescan everything on every sync. On a round from nothing they are
 * failures like any other, since starting again would ask the same thing.
 */
const namesPageToken = (failure: DriveFailure): boolean =>
	failure.locations.includes('pageToken') ||
	[...failure.reasons, failure.message].some((text) => /page ?token/i.test(text));

const isDeadToken = (failure: DriveFailure, stored: boolean): boolean =>
	stored &&
	([404, 410].includes(failure.status) || (failure.status === 400 && namesPageToken(failure)));

interface Fetched {
	items: TreeItem[];
	roundEnds: boolean;
	/** The token the next page is fetched with. */
	next: string;
	/** The page says the app folder was trashed, or is out of reach. */
	rootGone: boolean;
}

/** `StorageProvider.changes`: a page of a scan or of the feed, read against the tree. */
export const createChanges = (client: DriveClient, appFolder: AppFolder, now: () => Date) => {
	const { attempt, call, raise, childrenOf } = client;
	const { establishRoot, confirmRoot, foundId, forget } = appFolder;
	const separate = createSeparate(client, now);

	const freshRound = async (): Promise<DriveCursor> => {
		const root = await establishRoot();
		const { startPageToken } = await call<{ startPageToken?: string }>(
			'GET',
			`${CHANGES}/startPageToken`
		);
		if (startPageToken === undefined || startPageToken === '') {
			throw new ProviderResponseError('gdrive sent no start page token');
		}
		return {
			v: 1,
			phase: 'scan',
			token: '',
			start: startPageToken,
			root,
			nodes: [],
			pending: [],
		};
	};

	const scanPage = async (from: DriveCursor, stored: boolean): Promise<Fetched> => {
		const params = new URLSearchParams({
			q: 'trashed = false',
			fields: `nextPageToken,files(${FIELDS})`,
			pageSize: String(PAGE_SIZE),
			spaces: 'drive',
			...(from.token === '' ? {} : { pageToken: from.token }),
		});
		const result = await attempt<FileList>('GET', `${FILES}?${params.toString()}`);
		if (!result.ok && isDeadToken(result.failure, stored && from.token !== '')) {
			throw new CursorResetError(result.failure.reasons.join('/') || result.failure.message);
		}
		if (!result.ok) return raise(result.failure);
		const next = result.value.nextPageToken;
		return {
			items: (result.value.files ?? []).map(treeItemOf),
			roundEnds: next === undefined,
			next: next ?? from.start,
			// A scan lists only what is not in the trash; a folder trashed
			// meanwhile is found by the next round.
			rootGone: false,
		};
	};

	const feedPage = async (from: DriveCursor, stored: boolean): Promise<Fetched> => {
		const params = new URLSearchParams({
			pageToken: from.token,
			pageSize: String(PAGE_SIZE),
			spaces: 'drive',
			includeRemoved: 'true',
			fields: `nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file(${FIELDS}))`,
		});
		const result = await attempt<ChangeList>('GET', `${CHANGES}?${params.toString()}`);
		if (!result.ok && isDeadToken(result.failure, stored)) {
			throw new CursorResetError(result.failure.reasons.join('/') || result.failure.message);
		}
		if (!result.ok) return raise(result.failure);
		const next = result.value.nextPageToken ?? result.value.newStartPageToken;
		if (next === undefined || next === '') {
			throw new ProviderResponseError(
				'gdrive changes sent neither a next nor a new start token'
			);
		}
		const changes = result.value.changes ?? [];
		return {
			items: changes.flatMap(changeItem),
			roundEnds: result.value.nextPageToken === undefined,
			next,
			// From what Drive sent, not from the tree's reading of it, which also
			// takes a name no path can hold as gone: the folder is the root
			// whatever the user calls it.
			rootGone: changes.some(
				(change) =>
					(change.fileId ?? change.file?.id) === from.root &&
					(change.removed === true || change.file?.trashed === true)
			),
		};
	};

	/**
	 * Everything under the folders that have arrived from elsewhere, into the
	 * page. The feed reports a moved folder alone, and a folder moved back in
	 * from outside the app folder — or out from under one that was deleted —
	 * has contents the tree has forgotten, subfolders and all.
	 *
	 * A folder made on another device since the last look arrives too, and
	 * after notebooks moved there, every folder of them has: a request each,
	 * one after another, was a wait of seconds per folder before the round
	 * could say anything. So a level is asked at a time, `LISTS_AT_ONCE`
	 * folders together. What it finds goes into the page in the order a
	 * listing of one folder at a time, all the way down, put it: so nothing
	 * the page makes of its order moves.
	 */
	const listArrivals = async (page: Page, arrived: readonly string[]): Promise<void> => {
		const listed = new Map<string, DriveFile[]>();
		const listLevel = async (ids: readonly string[], depth: number): Promise<void> => {
			// A folder under two parents is asked about once.
			const asked = [...new Set(ids)].filter((id) => !listed.has(id));
			if (asked.length === 0 || depth > MAX_DEPTH) return;
			const waves = Array.from({ length: Math.ceil(asked.length / LISTS_AT_ONCE) }, (_, at) =>
				asked.slice(at * LISTS_AT_ONCE, (at + 1) * LISTS_AT_ONCE)
			);
			await waves.reduce(async (done, wave) => {
				await done;
				const answers = await Promise.all(wave.map(childrenOf));
				wave.forEach((id, at) => {
					listed.set(id, answers[at] ?? []);
				});
			}, Promise.resolve());
			const below = asked.flatMap((id) =>
				(listed.get(id) ?? []).filter(isFolder).map((child) => child.id ?? '')
			);
			await listLevel(below, depth + 1);
		};
		await listLevel(arrived, 0);
		const applyUnder = (folderId: string, depth: number) => {
			if (depth > MAX_DEPTH) return;
			const children = listed.get(folderId) ?? [];
			children.forEach((child) => {
				applyItem(page, treeItemOf(child));
			});
			children.filter(isFolder).forEach((child) => {
				applyUnder(child.id ?? '', depth + 1);
			});
		};
		arrived.forEach((id) => {
			applyUnder(id, 0);
		});
	};

	const changes = async (cursor?: string): Promise<ChangeSet> => {
		const stored = cursor !== undefined && cursor !== '';
		const from = stored ? parseCursor(cursor) : await freshRound();
		// Once a round, at its first page. Asked again on every page, it was a
		// search beside each, doubling a long round's requests; and mid-round the
		// feed itself says when the folder goes to the trash (`rootGone`). A
		// cursor this adapter did not find the folder for this round — one
		// stored mid-round and read by the next session — is asked again.
		if (stored && !(midRound(from) && foundId() === from.root)) {
			await confirmRoot(from.root);
		}

		const fetched =
			from.phase === 'scan' ? await scanPage(from, stored) : await feedPage(from, stored);
		// The app folder itself in the trash, or out of reach: nothing under it
		// can be placed, and the next round has to find or make another.
		if (fetched.rootGone) {
			forget();
			throw new CursorResetError('gdrive app folder is gone');
		}
		const walked = from.phase === 'feed' ? (from.walked ?? 0) + 1 : undefined;
		if (walked !== undefined && !fetched.roundEnds && walked >= feedLimit(from.nodes.length)) {
			throw new CursorResetError('gdrive change feed is longer than a scan');
		}

		const page = pageFrom(from);
		applyAll(page, fetched.items);
		// A scan lists everything already, so only a feed round lists arrivals.
		if (from.phase === 'feed') await listArrivals(page, arrivals(page));
		await clashes(page).reduce(async (done, clash) => {
			await done;
			await separate(page, clash);
		}, Promise.resolve());

		// Drive lists no parents, so a round's end means only what `settlePage`
		// asks once arrivals are listed: every ancestor of what the round
		// listed is in the tree. A parent it still does not know is outside the
		// app folder, or a folder the user made in Drive, which `drive.file`
		// cannot see — and either way the item has left.
		// A folder the app has left is still in the tree, since what is inside
		// it is placed through it, but is not reported while it holds nothing
		// the app can see (`leaveFolder`).
		const settled = hideLeftFolders(
			page,
			settlePage(page, fetched.roundEnds),
			from.phase === 'scan',
			fetched.roundEnds
		);
		const scanning = from.phase === 'scan' && !fetched.roundEnds;
		const written: DriveCursor = {
			v: 1,
			phase: scanning ? 'scan' : 'feed',
			token: fetched.next,
			start: from.start,
			root: from.root,
			nodes: nodesOf(page),
			pending: settled.pending,
			...(walked === undefined || fetched.roundEnds ? {} : { walked }),
		};
		const entries: ChangeEntry[] = settled.entries;
		return { entries, cursor: JSON.stringify(written), more: !fetched.roundEnds };
	};

	return changes;
};
