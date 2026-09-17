import { z } from 'zod';

import { joinPath, ROOT } from '../paths.js';
import type { ChangeEntry, RemoteEntry } from './types.js';

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

/** One item of the tree: `[id, parentId, name, isFolder]`. */
export const nodeSchema = z.tuple([z.string(), z.string(), z.string(), z.boolean()]);

/**
 * A live item not yet reported because its parent chain does not reach the
 * root yet: `[id, version, modifiedAt, size, was]` — size `-1` for none, and
 * `was` the path it had before the round moved it, `null` if it had none. A
 * feed need not list parents before their children, and an item dropped here
 * would never be reported again. `was` travels with it because the tree no
 * longer knows it: the item's node already names its new parent.
 */
export const pendingSchema = z.tuple([
	z.string(),
	z.string(),
	z.string(),
	z.number(),
	z.string().nullable(),
]);

export type TreeRow = z.infer<typeof nodeSchema>;
export type Held = z.infer<typeof pendingSchema>;

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
			version: string;
			modifiedAt: string;
			size: number;
	  }>;

interface TreeNode {
	parent: string;
	name: string;
	folder: boolean;
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
 * The path of an item from the tree, or `undefined` when its chain does not
 * reach the root. The depth bound turns a cycle — which a well-formed feed never
 * produces — into "cannot say" rather than a stack overflow.
 */
const pathIn = (tree: Tree, root: string, id: string, depth = 0): string | undefined => {
	if (id === root) return ROOT;
	const node = tree.get(id);
	if (node === undefined || depth > tree.size) return undefined;
	const above = pathIn(tree, root, node.parent, depth + 1);
	return above === undefined ? undefined : joinPath(above, node.name);
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
const wasOf = (page: Page, id: string, depth = 0): string | undefined => {
	if (id === page.root) return ROOT;
	if (page.was.has(id)) return page.was.get(id) ?? undefined;
	const node = page.before.get(id);
	if (node === undefined || depth > page.before.size) return undefined;
	const above = wasOf(page, node.parent, depth + 1);
	return above === undefined ? undefined : joinPath(above, node.name);
};

export const pageFrom = (from: TreeState): Page => {
	const before = new Map(
		from.nodes.map(([id, parent, name, folder]) => [id, { parent, name, folder }])
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
	page.nodes.set(item.id, { parent: item.parent, name: item.name, folder: item.folder });
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

	return {
		entries: decided.flatMap((item) => (item.entry === undefined ? [] : [item.entry])),
		pending: decided.flatMap((item) => (item.pending === undefined ? [] : [item.pending])),
		pruned: unplaced.length + decided.filter((item) => item.unplaced === true).length,
	};
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
	const underAnother = (id: string, depth = 0): boolean => {
		const parent = page.nodes.get(id)?.parent;
		if (parent === undefined || depth > page.nodes.size) return false;
		return arrived.has(parent) || underAnother(parent, depth + 1);
	};
	return [...arrived].filter((id) => !underAnother(id));
};

/** Where an item is in the tree as the page has it so far, if the root reaches it. */
export const pathOf = (page: Page, id: string): string | undefined =>
	pathIn(page.nodes, page.root, id);

/** The tree as a page leaves it, in the form a cursor stores. */
export const nodesOf = (page: Page): TreeRow[] =>
	[...page.nodes].map(([id, node]) => [id, node.parent, node.name, node.folder]);
