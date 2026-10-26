import { z } from 'zod';

import { parseJson } from '../json.js';
import { joinPath, ROOT } from '../paths.js';
import { type ChangeEntry, CursorResetError, type RemoteEntry } from './types.js';

// ---------------------------------------------------------------------------
// The tree an id-based change feed is read against.
//
// Some providers name items in their change feed by id and parent id and never
// by path: Graph's delta ("the parentReference property on items won't include a
// value for path … renaming a folder doesn't result in any descendants of the
// folder being returned") and Google Drive's `changes.list` both do. So the
// adapter has to know the tree to say where anything is, and that knowledge has
// to outlive the page it was learnt from: a note edited today sits in a folder
// the feed last mentioned a month ago.
//
// It travels in the cursor, which the engine already persists per connection
// and only after the batch commits. That keeps `core` stateless, keeps the tree
// exactly as current as the cursor that goes with it, and costs a few hundred
// bytes a note in IndexedDB. Each adapter owns the rest of its cursor — where
// the feed resumes, and whatever its provider needs besides.
// ---------------------------------------------------------------------------

/**
 * One item of the tree: `[id, parentId, name, isFolder]`, and `true` after them
 * for a folder the app has left (`StorageProvider.leaveFolder`). Only a left
 * folder has the fifth, so a cursor stored before there was one still reads,
 * and a provider that never leaves a folder writes what it always did.
 */
export const nodeSchema = z.union([
	z.tuple([z.string(), z.string(), z.string(), z.boolean()]),
	z.tuple([z.string(), z.string(), z.string(), z.boolean(), z.literal(true)]),
]);

/**
 * A live item not yet reported because its parent chain does not reach the
 * root yet: `[id, version, modifiedAt, size, was]` — size `-1` for none, and
 * `was` the path it had before the round moved it, `null` if it had none. A
 * feed need not list parents before their children, and an item dropped here
 * would never be reported again. `was` travels with it because the tree no
 * longer knows it: the item's node already names its new parent.
 */
const pendingSchema = z.tuple([
	z.string(),
	z.string(),
	z.string(),
	z.number(),
	z.string().nullable(),
]);

/**
 * The fields every cursor read against a tree has: its version, the root the
 * tree hangs from, the tree, and what is held for a parent not yet placed. An
 * adapter's cursor is these and where its own feed resumes.
 */
export const treeCursorBase = {
	v: z.literal(1),
	root: z.string().min(1),
	nodes: z.array(nodeSchema),
	pending: z.array(pendingSchema),
};

/**
 * A stored cursor, read back with the adapter's schema. One that does not
 * parse, or that `accept` refuses, is not one this adapter wrote: a
 * `CursorResetError`, so the next round starts from nothing rather than from
 * a tree it cannot trust.
 */
export const readTreeCursor = <T>(
	schema: z.ZodType<T>,
	cursor: string,
	provider: string,
	accept: (read: T) => boolean = () => true
): T => {
	const result = schema.safeParse(parseJson(cursor));
	if (!result.success || !accept(result.data)) {
		throw new CursorResetError(`${provider} cursor is not one this adapter wrote`);
	}
	return result.data;
};

export type TreeRow = z.infer<typeof nodeSchema>;
type Held = z.infer<typeof pendingSchema>;

/** What an adapter carries between pages, besides where its feed resumes. */
export interface TreeState {
	root: string;
	nodes: readonly TreeRow[];
	pending: readonly Held[];
}

/**
 * One item from a feed, in the provider's terms translated to the tree's. `size`
 * is `-1` where there is none. A `version` of `''` on a file means the provider
 * gave none, and the file is left out (see `toLive`).
 */
export type TreeItem =
	| Readonly<{ id: string; gone: true }>
	| Readonly<{
			id: string;
			gone: false;
			parent: string;
			name: string;
			folder: boolean;
			/** A folder the app has left (`StorageProvider.leaveFolder`). */
			left?: true;
			version: string;
			modifiedAt: string;
			size: number;
	  }>;

interface TreeNode {
	parent: string;
	name: string;
	folder: boolean;
	left?: true;
}

type Tree = ReadonlyMap<string, TreeNode>;

interface LiveChange {
	kind: 'live';
	id: string;
	version: string;
	modifiedAt: string;
	size: number;
}

interface GoneChange {
	kind: 'gone';
	id: string;
}

type Change = LiveChange | GoneChange;

/**
 * The ids from `from` upwards, each the `up` of the one before, ending at the
 * first that has none — or `undefined` when the way up comes back on itself.
 *
 * A cycle is not a malformed feed. `A/B`, then B moved to the root and A moved
 * into it: a feed that promises no order can list A a page ahead of B, and
 * between the two pages the tree holds A under B under A. It has to read as
 * "cannot say yet", and at the cost of the loop rather than of the tree: a walk
 * that recursed until it had counted every node ran out of stack in a tree of
 * thousands, the page threw, the cursor stayed put, and every pull after it
 * fetched the same page again. Hence the one loop in this package. The set is
 * the chain itself, in order, so noticing a cycle costs nothing beside it.
 */
const chain = (from: string, up: (id: string) => string | undefined): string[] | undefined => {
	const seen = new Set([from]);
	// eslint-disable-next-line functional/no-loop-statements, functional/no-let -- see above: recursion here is the bug
	for (let at = up(from); at !== undefined; at = up(at)) {
		if (seen.has(at)) return undefined;
		seen.add(at);
	}
	return [...seen];
};

/**
 * The path `names` lead to — innermost first, as a walk up finds them — under
 * `base`. Joined once: a join per level reads the whole path so far again at
 * each, which is nothing at the depths providers allow and everything in a
 * chain of thousands.
 */
const below = (base: string, names: readonly string[]): string =>
	joinPath(...(base === ROOT ? [] : [base]), ...[...names].reverse());

/**
 * The path of an item from the tree, or `undefined` when its chain does not
 * reach the root: it ends at an item the tree does not hold, or never ends.
 */
const pathIn = (tree: Tree, root: string, id: string): string | undefined => {
	const ids = chain(id, (at) => (at === root ? undefined : tree.get(at)?.parent));
	if (ids?.at(-1) !== root) return undefined;
	return below(
		ROOT,
		ids.slice(0, -1).map((at) => tree.get(at)?.name ?? '')
	);
};

export interface Page {
	readonly root: string;
	/** The tree as the page found it, for where things *were*. */
	readonly before: Tree;
	/** Where the pending items were before the round moved them. */
	readonly was: ReadonlyMap<string, string | null>;
	/** The tree as the page leaves it. */
	readonly nodes: Map<string, TreeNode>;
	/** Keyed by id, in the order of each item's *last* appearance. */
	readonly changes: Map<string, Change>;
}

/**
 * Where an item was before this page: up the old tree, and through any pending
 * item on the way by the path *it* had. A pending folder's node already names
 * its new parent, which the tree cannot place yet, so walking through it would
 * lose the path of everything inside — and a deletion of one of those would go
 * unreported.
 */
const wasOf = (page: Page, id: string): string | undefined => {
	const ids = chain(id, (at) =>
		at === page.root || page.was.has(at) ? undefined : page.before.get(at)?.parent
	);
	const top = ids?.at(-1);
	if (ids === undefined || top === undefined) return undefined;
	const base = top === page.root ? ROOT : page.was.get(top);
	if (base === undefined || base === null) return undefined;
	return below(
		base,
		ids.slice(0, -1).map((at) => page.before.get(at)?.name ?? '')
	);
};

export const pageFrom = (from: TreeState): Page => {
	const before = new Map<string, TreeNode>(
		from.nodes.map(([id, parent, name, folder, left]) => [
			id,
			{ parent, name, folder, ...(left === true ? { left } : {}) },
		])
	);
	return {
		root: from.root,
		before,
		was: new Map(from.pending.map((held) => [held[0], held[4]])),
		nodes: new Map(before),
		// Items carried over from an earlier page go first, as they came first.
		changes: new Map(
			from.pending.map(([id, version, modifiedAt, size]) => [
				id,
				{ kind: 'live', id, version, modifiedAt, size },
			])
		),
	};
};

/**
 * Applies one item to the tree and nothing else. Where anything is, and what to
 * report, is worked out only once the whole page is in (`settlePage`): a folder
 * deleted and restored in one page, or an item moved into a folder the same
 * page then deletes, reads wrongly one item at a time.
 *
 * The root itself is not an entry, and is dropped. A deletion takes only the
 * item's own node out. Its children stay in the tree with a parent that is no
 * longer there, which is what tells `settlePage` they can no longer be placed.
 *
 * An item that appears more than once keeps its last state: deleting first
 * moves the change to the end, so the batch keeps the order in which things
 * last happened.
 */
export const applyItem = (page: Page, item: TreeItem): void => {
	if (item.id === page.root) return;
	page.changes.delete(item.id);
	if (item.gone) {
		page.nodes.delete(item.id);
		page.changes.set(item.id, { kind: 'gone', id: item.id });
		return;
	}
	page.nodes.set(item.id, {
		parent: item.parent,
		name: item.name,
		folder: item.folder,
		...(item.left === true ? { left: true } : {}),
	});
	page.changes.set(item.id, {
		kind: 'live',
		id: item.id,
		version: item.version,
		modifiedAt: item.modifiedAt,
		size: item.size,
	});
};

interface Decided {
	entry?: ChangeEntry;
	pending?: Held;
	/** A live item the round ended without placing. */
	unplaced?: boolean;
}

export interface Settled {
	entries: ChangeEntry[];
	pending: Held[];
	/** Items taken out of the tree because they can no longer be placed. */
	pruned: number;
}

/** A deletion, by id alone when the tree never placed the item. */
const gone = (path: string | undefined, id: string): ChangeEntry =>
	path === undefined ? { deleted: true, remoteId: id } : { path, deleted: true, remoteId: id };

/**
 * A file with no version cannot be an entry: the caller would store `''`, send
 * it back as the expected version on the next push, and the note could never be
 * saved again. Here it is left out rather than thrown over, since the cursor
 * moves only when a page goes through, so one such item would stop every pull,
 * and push behind it. A later change to the file that carries a version reports
 * it.
 */
const toLive = (page: Page, change: LiveChange, path: string): RemoteEntry | undefined => {
	const folder = page.nodes.get(change.id)?.folder === true;
	if (!folder && change.version === '') return undefined;
	return {
		remoteId: change.id,
		path,
		kind: folder ? 'folder' : 'file',
		version: change.version,
		modifiedAt: change.modifiedAt,
		...(folder || change.size < 0 ? {} : { size: change.size }),
	};
};

const depth = (path: string): number => path.split('/').length;

/**
 * Every path a page reports is where the item is once the whole page is in, so
 * the page is a picture of one moment and not a history — and a reader applying
 * entries in order has to be given them in an order that picture survives.
 * A file listed at `C/a.md` ahead of the folder that was at `C` moving to `A`
 * is carried off to `A/a.md` by that move. Folders first, outermost first,
 * puts every folder where the page has it before anything lands inside it;
 * everything else keeps the order it happened in.
 */
const foldersFirst = (entries: readonly ChangeEntry[]): ChangeEntry[] => {
	const folders = [
		...entries.flatMap((entry) =>
			entry.deleted !== true && entry.kind === 'folder' ? [entry] : []
		),
	].sort((one, two) => depth(one.path) - depth(two.path));
	const rest = entries.filter((entry) => entry.deleted === true || entry.kind !== 'folder');
	return [...folders, ...rest];
};

/** Every item of a page applied to the tree, in the order the feed gave them. */
export const applyAll = (page: Page, items: readonly TreeItem[]): void => {
	items.forEach((item) => {
		applyItem(page, item);
	});
};

/**
 * Turns an applied page into entries. `roundEnds` is the caller's word that the
 * feed has said everything it will say about this round — its last page — and
 * that every *ancestor* of every item the round listed is in the tree or was
 * listed too. That is weaker than "every folder under the root is known", which
 * no feed promises: Graph lists the parents of changed items and nothing else
 * (a folder moved in from elsewhere arrives without its subfolders), and Google
 * Drive lists no parents at all, so its adapter has to put the contents of an
 * arrived folder into the page itself (`arrivals`). An item whose ancestors the
 * caller has not supplied is read as having left the root.
 *
 * - A deletion is reported at the path the item had before the page, since a
 *   feed need not name a deleted item (Graph for Business does not; a Drive
 *   `removed` change has no file at all). One the tree never placed is still
 *   reported, by id alone. It may be a file this device pushed after its
 *   cursor, which another device deleted before this device pulled again: the
 *   round says only that the id is gone, and the note here is held by the id
 *   the push returned. Dropped, the note stays on this device for ever. An id
 *   nothing holds — a cold start meeting a tombstone — the engine finds nothing
 *   for.
 * - A live item that can be placed is reported where it now is.
 * - One that cannot is held until the round ends: its parent may be on a later
 *   page. When the round has ended, it cannot be: a chain that still does not
 *   reach the root left it — the user can move things out of the app's folder —
 *   and the item is reported deleted where it was, or by id alone.
 * - A deletion inside a folder also reported deleted is still reported. The
 *   engine matches it by id and finds nothing left to do, while a filter by
 *   path cannot tell which folder a path belonged to: within one round two
 *   folders can hold the same old path, and a note deleted from one was hidden
 *   by the other's deletion and stayed on the device.
 * - At the end of a round, anything else the tree can no longer place — the
 *   contents of a folder that was deleted or moved away, which the feed need
 *   not mention — is pruned without a word. Something above it that was placed
 *   before the page moved or went, and that is reported at a path covering it.
 */
export const settlePage = (page: Page, roundEnds: boolean): Settled => {
	const decided = [...page.changes.values()].map((change): Decided => {
		const was = wasOf(page, change.id);
		if (change.kind === 'gone') return { entry: gone(was, change.id) };
		const path = pathIn(page.nodes, page.root, change.id);
		if (path !== undefined) {
			const entry = toLive(page, change, path);
			return entry === undefined ? {} : { entry };
		}
		if (!roundEnds) {
			const held: Held = [
				change.id,
				change.version,
				change.modifiedAt,
				change.size,
				was ?? null,
			];
			return { pending: held };
		}
		page.nodes.delete(change.id);
		return { unplaced: true, entry: gone(was, change.id) };
	});

	const unplaced = roundEnds
		? [...page.nodes.keys()].filter((id) => pathIn(page.nodes, page.root, id) === undefined)
		: [];
	unplaced.forEach((id) => page.nodes.delete(id));

	const entries = decided.flatMap((item) => (item.entry === undefined ? [] : [item.entry]));
	return {
		entries: foldersFirst(entries),
		pending: decided.flatMap((item) => (item.pending === undefined ? [] : [item.pending])),
		pruned: unplaced.length + decided.filter((item) => item.unplaced === true).length,
	};
};

/**
 * The folders of `tree` the app has left that hold nothing it can see: placed,
 * left, and with nothing beneath them but folders left too. A file anywhere
 * beneath one keeps it, and so does a folder not left — a notebook someone
 * made — so a folder left with something still in it stays a notebook.
 *
 * Found by walking up from everything that keeps a folder, and each walk
 * stops where an earlier one got to, so the tree is walked about once
 * however deep it goes. Nothing is walked in a tree with no folder left.
 */
const hiddenIn = (tree: Tree, root: string): ReadonlySet<string> => {
	const left = [...tree].flatMap(([id, node]) => (node.left === true ? [id] : []));
	if (left.length === 0) return new Set();
	const kept = new Set<string>();
	tree.forEach((node) => {
		if (node.left === true || node.parent === root || kept.has(node.parent)) return;
		chain(node.parent, (at) =>
			at === root || kept.has(at) ? undefined : tree.get(at)?.parent
		)?.forEach((at) => {
			kept.add(at);
		});
	});
	return new Set(left.filter((id) => !kept.has(id) && pathIn(tree, root, id) !== undefined));
};

/** A folder reported where the page has no change of its own to report it from. */
const folderAt = (id: string, path: string): RemoteEntry => ({
	remoteId: id,
	path,
	kind: 'folder',
	version: '',
	modifiedAt: '',
});

/**
 * What `settlePage` reports, without the folders the app has left that hold
 * nothing it can see (`StorageProvider.leaveFolder`), for an adapter whose
 * provider marks them. Asked after `settlePage`, with the tree it settled.
 *
 * - In a scan, a folder's contents may be on a later page, so a left folder
 *   is held back from every page, and the page that ends the round reports
 *   the ones something keeps. One nothing keeps is never mentioned, so a
 *   device that holds it as a notebook loses it as it does anything else a
 *   scan did not find. What is inside a kept one may come first; the notebook
 *   made to hold it takes the folder's id when the folder's own entry comes.
 * - In a feed, what changes is whether a folder is hidden, and that can change
 *   without a word about the folder: the last note in it moved out. So the
 *   tree before the page is compared with the tree after it. A folder hidden
 *   now and not before is reported deleted, outermost first and after
 *   everything else the page says, so whatever the page moved out of it is out
 *   first. One hidden before and not now is reported as a folder again, and
 *   one hidden both times is not reported at all.
 *
 * Only what is reported changes. The tree keeps every left folder, since
 * what is inside one is placed through it.
 */
export const hideLeftFolders = (
	page: Page,
	settled: Settled,
	scan: boolean,
	roundEnds: boolean
): Settled => {
	const isLeft = (node: TreeNode): boolean => node.left === true;
	const anyLeft =
		[...page.nodes.values()].some(isLeft) || (!scan && [...page.before.values()].some(isLeft));
	if (!anyLeft) return settled;

	const now = hiddenIn(page.nodes, page.root);
	const placed = (id: string): RemoteEntry[] => {
		const path = pathIn(page.nodes, page.root, id);
		return path === undefined ? [] : [folderAt(id, path)];
	};

	if (scan) {
		const others = settled.entries.filter(
			(entry) =>
				entry.deleted === true ||
				entry.kind !== 'folder' ||
				page.nodes.get(entry.remoteId)?.left !== true
		);
		if (!roundEnds) return { ...settled, entries: others };
		const kept = [...page.nodes].flatMap(([id, node]) =>
			isLeft(node) && !now.has(id) ? placed(id) : []
		);
		return { ...settled, entries: foldersFirst([...others, ...kept]) };
	}

	const before = hiddenIn(page.before, page.root);
	const others = settled.entries.filter(
		(entry) => entry.deleted === true || !now.has(entry.remoteId)
	);
	const listed = new Set(
		others.flatMap((entry) => (entry.deleted === true ? [] : [entry.remoteId]))
	);
	const back = [...before].filter((id) => !now.has(id) && !listed.has(id)).flatMap(placed);
	const hidden = [...[...now].filter((id) => !before.has(id)).flatMap(placed)]
		.sort((one, two) => depth(one.path) - depth(two.path))
		.map((entry) => gone(entry.path, entry.remoteId));
	return { ...settled, entries: [...foldersFirst([...others, ...back]), ...hidden] };
};

/**
 * Folders this page places that were not placed before it: made in the round,
 * moved back in from outside the root, or rescued from a folder deleted earlier
 * in the round. Asked after every item is applied and before `settlePage`.
 *
 * A feed that reports a moved folder alone says nothing of what is inside one
 * that arrives from elsewhere — its subfolders included, which the tree pruned
 * when it left — so an adapter whose feed does not list them lists each of
 * these *recursively* and applies what it finds to the same page. Only the
 * top-most are returned: one inside another is covered by listing the outer.
 * On a round from nothing every folder arrives; a scan lists everything anyway,
 * so an adapter skips this there.
 *
 * Asked once per page. Applying what a listing found does not make these
 * folders stop arriving, so an adapter that asked until the answer was empty
 * would never stop.
 */
export const arrivals = (page: Page): string[] => {
	const arrived = new Set(
		[...page.changes.values()]
			.filter(
				(change) =>
					change.kind === 'live' &&
					page.nodes.get(change.id)?.folder === true &&
					pathIn(page.nodes, page.root, change.id) !== undefined &&
					wasOf(page, change.id) === undefined
			)
			.map((change) => change.id)
	);
	const underAnother = (id: string): boolean =>
		chain(id, (at) => page.nodes.get(at)?.parent)
			?.slice(1)
			.some((above) => arrived.has(above)) ?? false;
	return [...arrived].filter((id) => !underAnother(id));
};

/** Where an item is in the tree as the page has it so far, if the root reaches it. */
export const pathOf = (page: Page, id: string): string | undefined =>
	pathIn(page.nodes, page.root, id);

/** The tree as a page leaves it, in the form a cursor stores. */
export const nodesOf = (page: Page): TreeRow[] =>
	[...page.nodes].map(([id, node]) =>
		node.left === true
			? [id, node.parent, node.name, node.folder, true]
			: [id, node.parent, node.name, node.folder]
	);
