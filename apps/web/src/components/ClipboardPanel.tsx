import {
	type ClipName,
	contentTypeOf,
	fileKind,
	MAX_ATTACHMENT_BYTES,
	readClipName,
} from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	type ClipboardEvent,
	type DragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';

import { chordLabel, parseChord } from '../commands/chord.js';
import { filesToAttach } from '../editor/addFiles.js';
import { browserFiles, type FileBrowser, saveBytes } from '../editor/fileActions.js';
import { FILE_ICONS, Icon } from '../editor/icons.js';
import { createObjectUrlCache, type ObjectUrlCache } from '../editor/objectUrls.js';
import { pickFiles } from '../editor/pickFiles.js';
import { t } from '../i18n/t.js';
import { type PictureShrinker, pictureShrinker } from '../pictures/shrinker.js';
import { addClips, type ClipInput, listClips, removeClip } from '../store/clipboard.js';
import { type ClipRecord, type NotesDatabase } from '../store/db.js';
import { type FileRead } from '../sync/fileReads.js';
import { type SyncScheduler } from '../sync/scheduler.js';
import { sizeOf } from './AttachedFiles.js';
import { clipPicture } from './clipPictures.js';
import {
	asPng,
	fromFiles,
	type SystemClipboard,
	systemClipboard,
	type SystemRead,
} from './systemClipboard.js';

/**
 * A source's clipboard, shared by its devices (docs/ARCHITECTURE.md §7, "The
 * clipboard"), a full-width region of its own just before the storage panel,
 * wherever that is: at the foot of the sidebar, and at the foot of a compact
 * window's source dropdown. Shown where the user has asked for it on this
 * device, from the storage menu. Holding anything, it is featured, edged and
 * glowing in the brand's colour; the edge thickens inward while files are
 * dragged over the window, most of all over itself, where they can be dropped
 * (`styles.css`).
 *
 * Things come in by Paste, which reads the browser's clipboard (text or a
 * picture); by a keyboard paste or a drop on the panel, and by "Add a file",
 * which bring files too. Pressing an item puts it back on the clipboard, or,
 * for a file — which no browser puts on a clipboard — saves it.
 */

type Sync = Pick<SyncScheduler, 'clipboard'>;

export interface ClipboardPanelProps {
	connectionId: string;
	database: NotesDatabase;
	sync: Sync;
	/** The browser's clipboard. Injected: jsdom has none. */
	system?: SystemClipboard;
	/** How a file is picked for "Add a file". Injected: jsdom opens no picker. */
	pick?: typeof pickFiles;
	/** How a file item is saved. Injected: jsdom cannot make a blob URL. */
	browser?: FileBrowser;
	/** Where a picture's URL comes from. Injected for the same reason. */
	urls?: ObjectUrlCache;
	/** What makes a picture's thumb (#276). Injected: jsdom has no worker to make one. */
	shrinker?: PictureShrinker;
}

/** How long a "Copied" stays said. */
export const SAID_MS = 2500;

const MEGABYTES = MAX_ATTACHMENT_BYTES / (1024 * 1024);

const pasteKeys = (): string => chordLabel(parseChord('Mod+V'));

const tooLarge = (names: readonly string[]): string => {
	const [name] = names;
	if (names.length !== 1 || name === undefined) {
		return t('clipboard.tooLarge.several', { count: names.length, megabytes: MEGABYTES });
	}
	return name === ''
		? t('clipboard.tooLarge.unnamed', { megabytes: MEGABYTES })
		: t('clipboard.tooLarge.named', { name, megabytes: MEGABYTES });
};

const NOT_READ: Readonly<Record<Exclude<SystemRead['kind'], 'read'>, () => string>> = {
	empty: () => t('clipboard.notRead.empty'),
	refused: () => t('clipboard.notRead.refused', { keys: pasteKeys() }),
	unsupported: () => t('clipboard.notRead.unsupported', { keys: pasteKeys() }),
};

const NOT_HAD: Readonly<Record<Exclude<FileRead['state'], 'ready' | 'aborted'>, () => string>> = {
	gone: () => t('clipboard.notHad.gone'),
	offline: () => t('clipboard.notHad.offline'),
	unavailable: () => t('clipboard.notHad.unavailable'),
	failed: () => t('clipboard.notHad.failed'),
};

/** Why an item's bytes did not come, as a throw a promise chain can carry. */
class NotHad extends Error {
	constructor(readonly state: keyof typeof NOT_HAD) {
		super(NOT_HAD[state]());
	}
}

/** The bytes of a read that came, or the reason it did not. */
const bytesOf = (read: FileRead): ArrayBuffer => {
	if (read.state === 'ready') return read.bytes;
	if (read.state === 'aborted') throw new NotHad('failed');
	throw new NotHad(read.state);
};

const messageOf = (error: unknown): string =>
	error instanceof NotHad ? error.message : t('clipboard.notCopied');

/**
 * What is said of one item: the item, and the words shown over it — "Copied"
 * as against the "Copied." announced, since there a full stop has no sentence
 * to end.
 */
interface About {
	readonly item: string;
	readonly mark: string;
}

/**
 * What is said, for a moment: a "Copied" or a "Saved", over the item it is
 * about, or what went wrong, under the list.
 */
interface Said {
	readonly words: string;
	/** The item it is about, which it is shown over. */
	readonly about?: About;
}

const SAID_NOTHING: Said = { words: '' };

const useSaying = (): readonly [Said, (words: string, about?: About) => void] => {
	const [said, setSaid] = useState<Said>(SAID_NOTHING);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(
		() => () => {
			clearTimeout(timer.current);
		},
		[]
	);
	const say = useCallback((words: string, about?: About) => {
		clearTimeout(timer.current);
		setSaid(about === undefined ? { words } : { words, about });
		timer.current = setTimeout(() => {
			setSaid(SAID_NOTHING);
		}, SAID_MS);
	}, []);
	return [said, say] as const;
};

/** Files a drag carries, and not a note or a notebook dragged in the sidebar. */
const holdsFiles = (data: DataTransfer | null): boolean => data?.types.includes('Files') === true;

const carriesFiles = (event: DragEvent): boolean => holdsFiles(event.dataTransfer);

/**
 * How long a drag over the window can go without a `dragover` before it is
 * taken to have gone. A drag held still goes on sending them, a few a second.
 */
export const DRAG_GONE_MS = 1000;

/**
 * Whether files are being dragged over the window, anywhere in it, so the panel
 * can say where they can be dropped. Each element a drag enters and leaves says
 * so, bubbling to the window, and the two are counted. A drop ends it, and so
 * does a drag that stops sending `dragover`: one let go of where nothing takes
 * it, or out of the window, may leave the count where it was.
 */
const useFilesDragged = (): boolean => {
	const [dragged, setDragged] = useState(false);
	const depth = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		const end = () => {
			depth.current = 0;
			clearTimeout(timer.current);
			setDragged(false);
		};
		const alive = () => {
			clearTimeout(timer.current);
			timer.current = setTimeout(end, DRAG_GONE_MS);
		};
		const enter = (event: globalThis.DragEvent) => {
			if (!holdsFiles(event.dataTransfer)) return;
			depth.current += 1;
			setDragged(true);
			alive();
		};
		const over = (event: globalThis.DragEvent) => {
			if (holdsFiles(event.dataTransfer)) alive();
		};
		const leave = (event: globalThis.DragEvent) => {
			if (!holdsFiles(event.dataTransfer)) return;
			depth.current -= 1;
			if (depth.current <= 0) end();
		};
		window.addEventListener('dragenter', enter);
		window.addEventListener('dragover', over);
		window.addEventListener('dragleave', leave);
		// Caught on the way down: whatever takes the drop may stop it there.
		window.addEventListener('drop', end, true);
		window.addEventListener('dragend', end, true);
		return () => {
			window.removeEventListener('dragenter', enter);
			window.removeEventListener('dragover', over);
			window.removeEventListener('dragleave', leave);
			window.removeEventListener('drop', end, true);
			window.removeEventListener('dragend', end, true);
			clearTimeout(timer.current);
		};
	}, []);
	return dragged;
};

/** The default cache: a URL per picture, kept for every view of it. */
const thumbnails = createObjectUrlCache();

/**
 * A picture on the clipboard, drawn from its thumb (`clipPicture`) once this
 * device holds its bytes or the thumb, and its icon until then. What is
 * watched is whether they are here, by key, never the bytes themselves.
 */
const ClipPicture = ({
	connectionId,
	name,
	version,
	database,
	urls,
	shrinker,
}: {
	connectionId: string;
	name: string;
	/** The version of it this device has (`ClipAt`). */
	version: string | undefined;
	database: NotesDatabase;
	urls: ObjectUrlCache;
	shrinker: PictureShrinker;
}) => {
	const here = useLiveQuery(async () => {
		const key: [string, string] = [connectionId, name];
		const [bytes, thumbs] = await Promise.all([
			database.clipBytes.where('[connectionId+name]').equals(key).count(),
			database.clipThumbs.where('[connectionId+name]').equals(key).count(),
		]);
		return bytes + thumbs > 0;
	}, [database, connectionId, name]);
	const [shown, setShown] = useState<{ name: string; url: string }>();
	// Gone with its bytes and thumb, as a pull reads it again: its URL was let
	// go of then, and may be revoked by the time they are back.
	if (here === false && shown !== undefined) setShown(undefined);
	useEffect(() => {
		if (here !== true) return undefined;
		const asking = new AbortController();
		const kept = { current: (): void => undefined };
		void clipPicture(database, shrinker, { connectionId, name, version }, asking.signal)
			.catch(() => undefined)
			.then((drawable) => {
				if (drawable === undefined || asking.signal.aborted) return;
				const held = urls.acquire(drawable.key, drawable.blob);
				kept.current = held.release;
				setShown({ name, url: held.url });
			});
		return () => {
			asking.abort();
			kept.current();
		};
	}, [here, database, shrinker, connectionId, name, version, urls]);
	// Not once neither is here: another device wrote over it, and it is read again.
	return here === true && shown?.name === name ? (
		<img className="clipboard-thumb" src={shown.url} alt="" />
	) : (
		<span className="clipboard-icon" aria-hidden="true">
			<Icon name="image" />
		</span>
	);
};

/** What an item is called, on screen and saved: its own name, or the app's for a picture with none. */
const nameOf = ({ label }: ClipName): string => label ?? t('clipboard.image');

/**
 * What an item's buttons are called: what pressing it does — a text or a
 * picture is copied, a file saved — and, until it has gone up, that it is
 * waiting to.
 */
const itemWords = (
	read: ClipName,
	pending: boolean
): { label: string; title: string; remove: string } => {
	const name = nameOf(read);
	switch (read.kind) {
		case 'text':
			return {
				label: t(pending ? 'clipboard.item.copyTextPending' : 'clipboard.item.copyText'),
				title: t(
					pending ? 'clipboard.item.copyTextPendingTitle' : 'clipboard.item.copyText'
				),
				remove: t('clipboard.item.removeText'),
			};
		case 'image':
			return {
				label: t(pending ? 'clipboard.item.copyPending' : 'clipboard.item.copy', { name }),
				title: t(pending ? 'clipboard.item.copyPendingTitle' : 'clipboard.item.copy', {
					name,
				}),
				remove: t('clipboard.item.remove', { name }),
			};
		case 'file':
			return {
				label: t(pending ? 'clipboard.item.savePending' : 'clipboard.item.save', { name }),
				title: t(pending ? 'clipboard.item.savePendingTitle' : 'clipboard.item.save', {
					name,
				}),
				remove: t('clipboard.item.remove', { name }),
			};
	}
};

interface ItemProps extends Required<Omit<ClipboardPanelProps, 'pick'>> {
	clip: ClipRecord;
	say: (words: string, about?: About) => void;
	/** What was just said of this item — "Copied", "Saved" — shown over it. */
	done: string | undefined;
}

const ClipItem = ({
	clip,
	connectionId,
	database,
	sync,
	system,
	browser,
	urls,
	shrinker,
	say,
	done,
}: ItemProps) => {
	const read = readClipName(clip.name);
	if (read === undefined) return null;
	const pending = clip.state === 'pending';

	const bytes = () => sync.clipboard.read(connectionId, clip.name).then(bytesOf);

	const choose = () => {
		if (read.kind === 'file') {
			void bytes()
				.then((got) => saveBytes(got, nameOf(read), clip.name, browser))
				.then(
					() => {
						say(t('clipboard.saved'), {
							item: clip.name,
							mark: t('clipboard.savedMark'),
						});
					},
					(error: unknown) => {
						say(messageOf(error));
					}
				);
			return;
		}
		// Asked inside the press, with the bytes still to come: see `write`.
		const blob =
			read.kind === 'text'
				? bytes().then((got) => new Blob([got], { type: 'text/plain' }))
				: bytes().then((got) => asPng(got, contentTypeOf(clip.name) ?? ''));
		void system.write(read.kind === 'text' ? 'text/plain' : 'image/png', blob).then(
			() => {
				say(t('clipboard.copied'), { item: clip.name, mark: t('clipboard.copiedMark') });
			},
			(error: unknown) => {
				say(messageOf(error));
			}
		);
	};

	const what = itemWords(read, pending);

	return (
		<li className={pending ? 'clipboard-item clipboard-pending' : 'clipboard-item'}>
			<div className="clipboard-cell">
				<button
					type="button"
					className="clipboard-choose"
					aria-label={what.label}
					title={what.title}
					onClick={choose}
				>
					{read.kind === 'text' && (
						<span className="clipboard-text">{clip.preview ?? ''}</span>
					)}
					{read.kind === 'image' && (
						<ClipPicture
							connectionId={connectionId}
							name={clip.name}
							version={clip.version}
							database={database}
							urls={urls}
							shrinker={shrinker}
						/>
					)}
					{read.kind === 'file' && (
						<>
							<span className="clipboard-icon" aria-hidden="true">
								<Icon name={FILE_ICONS[fileKind(nameOf(read))]} />
							</span>
							<span className="clipboard-name">{nameOf(read)}</span>
							<span className="clipboard-size muted">{sizeOf(clip.size)}</span>
						</>
					)}
				</button>
				{/* Said by the button's name; drawn over it, which is greyed out
				    until it is up, so the spinner is not. */}
				{pending && <span className="clipboard-progress" aria-hidden="true" />}
				{done !== undefined && (
					<span className="clipboard-done" aria-hidden="true">
						<Icon name="check" />
						{done}
					</span>
				)}
			</div>
			<button
				type="button"
				className="icon icon-quiet clipboard-remove"
				aria-label={what.remove}
				title={t('clipboard.item.removeTitle')}
				onClick={() => {
					void removeClip(database, connectionId, clip.name).then(() =>
						sync.clipboard.flush(connectionId)
					);
				}}
			>
				<Icon name="close" />
			</button>
		</li>
	);
};

export const ClipboardPanel = ({
	connectionId,
	database,
	sync,
	system = systemClipboard(),
	pick = pickFiles,
	browser = browserFiles,
	urls = thumbnails,
	shrinker = pictureShrinker(),
}: ClipboardPanelProps) => {
	const clips = useLiveQuery(() => listClips(database, connectionId), [database, connectionId]);
	const [said, say] = useSaying();
	const dragged = useFilesDragged();
	// Over the panel itself, counted as the window's drag is: a drag moving
	// from one of its items to the next enters the one before it leaves the other.
	const [over, setOver] = useState(false);
	const overDepth = useRef(0);
	const notOver = () => {
		overDepth.current = 0;
		setOver(false);
	};

	const add = useCallback(
		async (inputs: readonly ClipInput[]) => {
			if (inputs.length === 0) return;
			const { added, tooLarge: refused } = await addClips(database, connectionId, inputs);
			if (refused.length > 0) say(tooLarge(refused));
			if (added.length > 0) void sync.clipboard.flush(connectionId);
		},
		[database, connectionId, sync, say]
	);

	/** Files brought in: those too large said no to by their size, before their bytes are read. */
	const addFiles = (files: readonly File[], pasted: boolean) => {
		const large = files.filter((file) => file.size > MAX_ATTACHMENT_BYTES);
		if (large.length > 0) say(tooLarge(large.map((file) => file.name)));
		void fromFiles(
			files.filter((file) => file.size <= MAX_ATTACHMENT_BYTES),
			pasted
		).then(add);
	};

	const paste = () => {
		void system.read().then(
			(got) => (got.kind === 'read' ? add(got.inputs) : say(NOT_READ[got.kind]())),
			() => {
				say(NOT_READ.refused());
			}
		);
	};

	/** A keyboard paste with the focus in the panel: files where it carries them, else text. */
	const onPaste = (event: ClipboardEvent) => {
		const files = filesToAttach(event.clipboardData, 'paste');
		const text = event.clipboardData.getData('text/plain');
		if (files.length === 0 && text === '') return;
		event.preventDefault();
		if (files.length > 0) addFiles(files, true);
		else void add([{ kind: 'text', text }]);
	};

	const classes = [
		'clipboard',
		clips !== undefined && clips.length > 0 ? 'clipboard-filled' : '',
		dragged ? 'clipboard-drop-ready' : '',
		dragged && over ? 'clipboard-drop-over' : '',
	].filter((name) => name !== '');

	return (
		<section
			className={classes.join(' ')}
			aria-label={t('clipboard.title')}
			// Focusable by a click anywhere in it, so a keyboard paste lands here.
			tabIndex={-1}
			onPaste={onPaste}
			onDragEnter={(event) => {
				if (!carriesFiles(event)) return;
				overDepth.current += 1;
				setOver(true);
			}}
			onDragLeave={(event) => {
				if (!carriesFiles(event)) return;
				overDepth.current -= 1;
				if (overDepth.current <= 0) notOver();
			}}
			onDragOver={(event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = 'copy';
			}}
			onDrop={(event) => {
				if (!carriesFiles(event)) return;
				event.preventDefault();
				notOver();
				addFiles(filesToAttach(event.dataTransfer, 'drop'), false);
			}}
		>
			<div className="clipboard-head">
				<span className="clipboard-title">{t('clipboard.title')}</span>
				<button
					type="button"
					className="icon icon-quiet"
					aria-label={t('clipboard.addFile')}
					title={t('clipboard.addFile')}
					onClick={() => {
						void pick().then((files) => {
							addFiles(files, false);
						});
					}}
				>
					<Icon name="paperclip" />
				</button>
				<button type="button" className="clipboard-paste" onClick={paste}>
					{t('clipboard.paste')}
				</button>
			</div>
			{clips !== undefined && clips.length > 0 && (
				<ul className="clipboard-items">
					{clips.map((clip) => (
						<ClipItem
							key={clip.name}
							clip={clip}
							connectionId={connectionId}
							database={database}
							sync={sync}
							system={system}
							browser={browser}
							urls={urls}
							shrinker={shrinker}
							say={say}
							done={said.about?.item === clip.name ? said.about.mark : undefined}
						/>
					))}
				</ul>
			)}
			{clips?.length === 0 && <p className="clipboard-empty muted">{t('clipboard.empty')}</p>}
			{/* Announced either way. Shown here only for what is not about one
			    item, which is shown over that item instead. */}
			<p
				className={
					said.about === undefined
						? 'clipboard-said muted'
						: 'clipboard-said clipboard-said-quiet'
				}
				role="status"
			>
				{said.words}
			</p>
			{dragged && (
				<p className="clipboard-drop-hint" aria-hidden="true">
					{t('clipboard.dropHint')}
				</p>
			)}
		</section>
	);
};
