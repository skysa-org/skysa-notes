import {
	contentTypeOf,
	fileKind,
	MAX_ATTACHMENT_BYTES,
	readClipName,
	safeOpenType,
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
import { addClips, type ClipInput, listClips, removeClip } from '../store/clipboard.js';
import { type ClipRecord, type NotesDatabase } from '../store/db.js';
import { type FileRead } from '../sync/fileReads.js';
import { type SyncScheduler } from '../sync/scheduler.js';
import { sizeOf } from './AttachedFiles.js';
import {
	asPng,
	fromFiles,
	type SystemClipboard,
	systemClipboard,
	type SystemRead,
} from './systemClipboard.js';

/**
 * A source's clipboard, shared by its devices (docs/ARCHITECTURE.md §7, "The
 * clipboard"), a section of its own just before the storage panel, wherever
 * that is: at the foot of the sidebar, and at the foot of a compact window's
 * source dropdown. Shown where the user has asked for it on this device, from
 * the storage menu. It glows a little in the brand's colour while it holds
 * anything, and more while files are dragged over the window, most of all
 * over itself, where they can be dropped.
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
}

/** How long a "Copied" stays said. */
export const SAID_MS = 2500;

const MEGABYTES = MAX_ATTACHMENT_BYTES / (1024 * 1024);

const pasteKeys = (): string => chordLabel(parseChord('Mod+V'));

const tooLarge = (names: readonly string[]): string => {
	const [name] = names;
	return names.length === 1 && name !== undefined
		? `${name === '' ? 'That' : name} is larger than ${String(MEGABYTES)} MB, the most the clipboard takes.`
		: `${String(names.length)} items are larger than ${String(MEGABYTES)} MB, the most the clipboard takes.`;
};

const NOT_READ: Readonly<Record<Exclude<SystemRead['kind'], 'read'>, () => string>> = {
	empty: () => 'There is nothing on the clipboard to paste.',
	refused: () =>
		`The browser did not let the clipboard be read. Press ${pasteKeys()} here instead.`,
	unsupported: () =>
		`This browser does not let a button read the clipboard. Press ${pasteKeys()} here instead.`,
};

const NOT_HAD: Readonly<Record<Exclude<FileRead['state'], 'ready' | 'aborted'>, string>> = {
	gone: 'That is no longer on the clipboard.',
	offline: 'That is not on this device, and this device is offline.',
	unavailable: 'That is not on this device, and its storage cannot be read from now.',
	failed: 'That could not be downloaded.',
};

/** Why an item's bytes did not come, as a throw a promise chain can carry. */
class NotHad extends Error {
	constructor(readonly state: keyof typeof NOT_HAD) {
		super(NOT_HAD[state]);
	}
}

/** The bytes of a read that came, or the reason it did not. */
const bytesOf = (read: FileRead): ArrayBuffer => {
	if (read.state === 'ready') return read.bytes;
	if (read.state === 'aborted') throw new NotHad('failed');
	throw new NotHad(read.state);
};

/** "Copied." as it is shown over the item, where a full stop has no sentence to end. */
const withoutStop = (words: string): string => words.replace(/\.$/, '');

const messageOf = (error: unknown): string =>
	error instanceof NotHad ? error.message : 'That could not be put on the clipboard.';

/**
 * What is said, for a moment: a "Copied" or a "Saved", over the item it is
 * about, or what went wrong, under the list.
 */
interface Said {
	readonly words: string;
	/** The item it is about, which it is shown over. */
	readonly item?: string;
}

const SAID_NOTHING: Said = { words: '' };

const useSaying = (): readonly [Said, (words: string, item?: string) => void] => {
	const [said, setSaid] = useState<Said>(SAID_NOTHING);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(
		() => () => {
			clearTimeout(timer.current);
		},
		[]
	);
	const say = useCallback((words: string, item?: string) => {
		clearTimeout(timer.current);
		setSaid(item === undefined ? { words } : { words, item });
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

/** A picture's thumbnail, from the bytes this device holds. */
const Thumbnail = ({
	connectionId,
	name,
	bytes,
	urls,
}: {
	connectionId: string;
	name: string;
	bytes: ArrayBuffer;
	urls: ObjectUrlCache;
}) => {
	const image = useRef<HTMLImageElement>(null);
	useEffect(() => {
		// The name is stamped with the bytes' hash, so it names them as well as
		// the item, and one URL serves every view.
		const held = urls.acquire(
			`${connectionId}\u0000${name}`,
			() => new Blob([bytes], { type: safeOpenType(name) })
		);
		if (image.current !== null) image.current.src = held.url;
		return held.release;
	}, [connectionId, name, bytes, urls]);
	return <img ref={image} className="clipboard-thumb" alt="" />;
};

interface ItemProps extends Required<Omit<ClipboardPanelProps, 'pick'>> {
	clip: ClipRecord;
	say: (words: string, item?: string) => void;
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
	say,
	done,
}: ItemProps) => {
	const read = readClipName(clip.name);
	const held = useLiveQuery(
		async () =>
			read?.kind === 'image' ? database.clipBytes.get([connectionId, clip.name]) : undefined,
		[database, connectionId, clip.name, read?.kind]
	);
	if (read === undefined) return null;
	const pending = clip.state === 'pending';

	const bytes = () => sync.clipboard.read(connectionId, clip.name).then(bytesOf);

	const choose = () => {
		if (read.kind === 'file') {
			void bytes()
				.then((got) => saveBytes(got, read.label, clip.name, browser))
				.then(
					() => {
						say('Saved.', clip.name);
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
				say('Copied.', clip.name);
			},
			(error: unknown) => {
				say(messageOf(error));
			}
		);
	};

	const what =
		read.kind === 'file'
			? `Save ${read.label}`
			: `Copy ${read.kind === 'text' ? 'text' : read.label}`;

	return (
		<li className={pending ? 'clipboard-item clipboard-pending' : 'clipboard-item'}>
			<div className="clipboard-cell">
				<button
					type="button"
					className="clipboard-choose"
					aria-label={pending ? `${what}, waiting to send` : what}
					title={pending ? `${what} (waiting to send)` : what}
					onClick={choose}
				>
					{read.kind === 'text' && (
						<span className="clipboard-text">{clip.preview ?? ''}</span>
					)}
					{read.kind === 'image' &&
						(held === undefined ? (
							<span className="clipboard-icon" aria-hidden="true">
								<Icon name="image" />
							</span>
						) : (
							<Thumbnail
								connectionId={connectionId}
								name={clip.name}
								bytes={held.bytes}
								urls={urls}
							/>
						))}
					{read.kind === 'file' && (
						<>
							<span className="clipboard-icon" aria-hidden="true">
								<Icon name={FILE_ICONS[fileKind(read.label)]} />
							</span>
							<span className="clipboard-name">{read.label}</span>
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
				aria-label={`Remove ${read.kind === 'text' ? 'text' : read.label}`}
				title="Remove"
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
			aria-label="Clipboard"
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
				<span className="clipboard-title">Clipboard</span>
				<button
					type="button"
					className="icon icon-quiet"
					aria-label="Add a file"
					title="Add a file"
					onClick={() => {
						void pick().then((files) => {
							addFiles(files, false);
						});
					}}
				>
					<Icon name="paperclip" />
				</button>
				<button type="button" className="clipboard-paste" onClick={paste}>
					Paste
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
							say={say}
							done={said.item === clip.name ? withoutStop(said.words) : undefined}
						/>
					))}
				</ul>
			)}
			{clips?.length === 0 && (
				<p className="clipboard-empty muted">
					What you paste here is on your other devices too. Click or tap an item to use
					it.
				</p>
			)}
			{/* Announced either way. Shown here only for what is not about one
			    item, which is shown over that item instead. */}
			<p
				className={
					said.item === undefined
						? 'clipboard-said muted'
						: 'clipboard-said clipboard-said-quiet'
				}
				role="status"
			>
				{said.words}
			</p>
			{dragged && (
				<p className="clipboard-drop-hint" aria-hidden="true">
					Drop here to add to clipboard
				</p>
			)}
		</section>
	);
};
