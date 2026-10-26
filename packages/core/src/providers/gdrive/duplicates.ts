import {
	conflictFilename,
	conflictFolderName,
	conflictNameKeepingExtension,
} from '../../names/conflicts.js';
import { isNoteName } from '../../names/fold.js';
import { jsonBody } from '../http.js';
import { applyItem, type Page, pathOf } from '../idTree.js';
import { byAge, type DriveClient, type DriveFile, isFolder, treeItemOf } from './wire.js';

/**
 * Two items at one path, which Drive allows and the engine cannot hold: found
 * among what a page touched (`clashes`) and made one again (`createSeparate`).
 */

/**
 * Two files at one name with the same bytes: one is a copy of the other, and
 * the copy can go to the trash without anything of the user's going with it.
 * Two devices uploading the same picture beside a note while offline is the
 * ordinary way to get here — an attachment's name is stamped with its content
 * (issue #187) — and renaming the second would leave a file nobody links to
 * beside the one every note does.
 *
 * Never a note. Two notes with the same bytes are still two rows on whichever
 * devices hold them, and a note that disappears is a remote delete to each;
 * renaming keeps both, as it always has. Never a folder, which has no bytes.
 */
const sameBytes = (canonical: DriveFile, other: DriveFile): boolean =>
	!isFolder(canonical) &&
	!isFolder(other) &&
	!isNoteName(other.name ?? '') &&
	canonical.md5Checksum !== undefined &&
	canonical.md5Checksum === other.md5Checksum &&
	canonical.size === other.size;

/**
 * How a duplicate is renamed: a folder with no extension, a note with `.md`,
 * and any other file with the extension it had — `conflictFilename` would make
 * `photo.png (conflict …).md` of a picture, which the engine would then take for
 * a note.
 */
const nameBeside = (file: DriveFile, name: string, at: Date, taken: readonly string[]): string => {
	if (isFolder(file)) return conflictFolderName(name, at, taken);
	return isNoteName(name)
		? conflictFilename(name, at, taken)
		: conflictNameKeepingExtension(name, at, taken);
};

/** Placed items sharing a folder and a name. */
interface Clash {
	parent: string;
	name: string;
	ids: readonly string[];
}

/** Groups of placed items sharing a folder and a name, where this page touched one. */
export const clashes = (page: Page): Clash[] => {
	const groups = new Map<string, { parent: string; name: string; ids: string[] }>();
	page.nodes.forEach((node, id) => {
		const key = `${node.parent}/${node.name}`;
		const group = groups.get(key) ?? { parent: node.parent, name: node.name, ids: [] };
		groups.set(key, { ...group, ids: [...group.ids, id] });
	});
	return [...groups.values()]
		.filter((group) => group.ids.length > 1)
		.filter((group) => group.ids.some((id) => page.changes.has(id)))
		.map((group) => ({
			...group,
			ids: group.ids.filter((id) => pathOf(page, id) !== undefined),
		}))
		.filter((group) => group.ids.length > 1);
};

export const createSeparate = (client: DriveClient, now: () => Date) => {
	const { attempt, call, raise, fileUrl, named, childrenOf, trash } = client;

	/**
	 * Two items at one path, made one again under §7's rule for a conflict: the
	 * canonical one keeps the name, and each other is renamed beside it as a
	 * conflict copy would be — or, where it is a file that is not a note and
	 * holds the same bytes, goes to the trash as the copy it is (`sameBytes`) and
	 * is reported deleted. Asked of Drive as it is *now*, not of the tree: a
	 * tree that still holds a file under a name it has since left is not a
	 * duplicate, and the page that says so may be the next one.
	 *
	 * Without this the engine, which holds one note per path, moves one note
	 * aside locally on every pull, alternately, and an edit to the one moved
	 * aside is written to a path with no file behind it for ever.
	 */
	const separate = async (page: Page, { parent, name, ids }: Clash): Promise<void> => {
		/** The file as it is now, if it is still in the clash. */
		const stillHere = async (id: string): Promise<DriveFile | undefined> => {
			const result = await attempt<DriveFile>('GET', fileUrl(id));
			if (!result.ok && result.failure.status === 404) return undefined;
			if (!result.ok) return raise(result.failure);
			const file = result.value;
			const here =
				file.trashed !== true && file.name === name && file.parents?.[0] === parent;
			return here ? file : undefined;
		};

		const found = await named(parent, name);
		// The feed can announce a file before the search index lists it, and a
		// clash passed over now is not asked about again until one of them next
		// changes. So what the search leaves out is asked of each file itself.
		const confirmed = await Promise.all(
			ids
				.filter((id) => !found.some((file) => file.id === id))
				.map(async (id) => {
					const file = await stillHere(id);
					return file === undefined ? [] : [file];
				})
		);
		const [canonical, ...others] = byAge([...found, ...confirmed.flat()]);
		if (canonical === undefined || others.length === 0) return;
		const taken = (await childrenOf(parent)).map((child) => child.name ?? '');
		await others.reduce<Promise<readonly string[]>>(async (chosen, listed) => {
			const names = await chosen;
			// Drive has no conditional trash, and a trash is a delete to every
			// device, where a stray rename is only a name. So a copy is looked at
			// once more just before: one moved, trashed or rewritten since it was
			// listed is not trashed for what it was. That narrows the window to
			// the length of one request; it cannot close it, and what lands in it
			// is in Drive's trash for thirty days rather than gone.
			const other = sameBytes(canonical, listed) ? await stillHere(listed.id ?? '') : listed;
			// Gone or moved since: no longer a duplicate, and the feed says where.
			if (other === undefined) return names;
			if (sameBytes(canonical, other)) {
				await trash(other.id ?? '');
				applyItem(page, { id: other.id ?? '', gone: true });
				return names;
			}
			const renamed = nameBeside(other, name, now(), [...taken, ...names]);
			const result = await call<DriveFile>(
				'PATCH',
				fileUrl(other.id ?? ''),
				jsonBody({ name: renamed })
			);
			applyItem(page, treeItemOf(result));
			return [...names, renamed];
		}, Promise.resolve([]));
	};

	return separate;
};
