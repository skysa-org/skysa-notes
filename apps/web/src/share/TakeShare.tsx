import { MAX_ATTACHMENT_BYTES } from '@skysa/core';
import { useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { InfoDialog } from '../components/InfoDialog.js';
import { LOCALE, t } from '../i18n/t.js';
import { addClips, setClipboardShown, showsClipboard } from '../store/clipboard.js';
import { type ConnectedSource } from '../store/connection.js';
import { db as appDatabase, type NotesDatabase, type SyncStateRecord } from '../store/db.js';
import { tabName } from '../sync/account.js';
import { syncScheduler } from '../sync/runtime.js';
import { type SyncScheduler } from '../sync/scheduler.js';
import { forgetShare, readShare, type Received } from './received.js';

/**
 * Something shared to the app from the system's share sheet
 * (docs/ARCHITECTURE.md §8, "Shared to the app"), arriving as `?share=<id>`
 * once the service worker has kept it (`receiveShare` in `pwa.ts`).
 *
 * **The user is always asked**, the clipboard shown or not. The worker cannot
 * tell the share sheet's POST from a form another site submits to `/share`:
 * the `Sec-Fetch-*` headers are added after it, and a referrer can be left
 * out. Taken without asking, any page the user visited could put what it liked
 * on a clipboard every one of their devices shows. So what came is named, and
 * nothing goes on the clipboard until the user says so.
 *
 * It goes to the source showing, whose clipboard the answer turns on where it
 * is off. The device's own notes, and a source no longer connected, have no
 * clipboard: the user is told so and what was shared is let go of.
 */

export interface TakeShareProps {
	/** The `share` in the URL. */
	share: string | undefined;
	/** The source showing; `null` for the device's own notes, `undefined` while it is read. */
	source: SyncStateRecord | null | undefined;
	/** Every source, for what the one showing is called on screen. */
	sources: readonly ConnectedSource[] | undefined;
	/** Take `share` out of the URL, once it has been read. */
	onRead: () => void;
	/** What was shared is on the clipboard: show it, where it is out of sight. */
	onAdded: () => void;
	database?: NotesDatabase;
	sync?: Pick<SyncScheduler, 'clipboard'>;
	/** Where the worker kept it. Injected: jsdom has no Cache Storage. */
	storage?: CacheStorage;
}

const MEGABYTES = MAX_ATTACHMENT_BYTES / (1024 * 1024);

/** How much of a shared text the question quotes. */
const EXCERPT_CHARS = 80;

const excerpt = (text: string): string => {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS).trimEnd()}…` : line;
};

/**
 * What came, in a phrase: `“Meeting at 3pm…” and q3.pdf`. The text and the
 * files, and the files' names, are listed as the language lists things
 * (`Intl.ListFormat`), which is where its "and" and its commas come from.
 */
export const whatCame = ({ inputs }: Received): string => {
	const text = inputs.find((input) => input.kind === 'text');
	const files = inputs.flatMap((input) => (input.kind === 'file' ? [input.name] : []));
	const [only] = files;
	const named =
		files.length === 0
			? undefined
			: files.length === 1 && only !== undefined
				? only
				: t('share.came.files', {
						count: files.length,
						names: new Intl.ListFormat(LOCALE, { type: 'unit' }).format(files),
					});
	const quoted =
		text === undefined ? undefined : t('share.came.text', { text: excerpt(text.text) });
	return new Intl.ListFormat(LOCALE).format([quoted, named].filter((part) => part !== undefined));
};

const leftOut = (names: readonly string[]): string => {
	const [name] = names;
	return names.length === 1 && name !== undefined
		? t('share.tooLarge.named', { name, size: MEGABYTES })
		: t('share.tooLarge.counted', { count: names.length, size: MEGABYTES });
};

/** Why a source has no clipboard to take a share. */
const notConnected = (source: SyncStateRecord | null, name: string): string =>
	source === null ? t('share.noClipboard') : t('share.notConnected', { source: name });

/** A source whose clipboard a share can go on: connected, and not let go of. */
const takesClips = (source: SyncStateRecord | null): source is SyncStateRecord =>
	source !== null && source.detached === undefined && source.provider !== undefined;

interface Held {
	readonly id: string;
	readonly received: Received;
	/** The clipboard would not take it. */
	readonly failed?: true;
}

export const TakeShare = ({
	share,
	source,
	sources,
	onRead,
	onAdded,
	database = appDatabase,
	sync = syncScheduler,
	storage,
}: TakeShareProps) => {
	const [held, setHeld] = useState<Held | null>(null);
	// An id is read once, however often the effect runs before the URL lets go of it.
	const read = useRef(new Set<string>());

	useEffect(() => {
		if (share === undefined || read.current.has(share)) return;
		read.current.add(share);
		void readShare(share, storage)
			.catch(() => undefined)
			.then((received) => {
				if (received !== undefined) setHeld({ id: share, received });
				onRead();
			});
	}, [share, storage, onRead]);

	if (held === null || source === undefined) return null;

	const done = () => {
		setHeld(null);
		void forgetShare(held.id, storage);
	};
	const { received } = held;
	const name = source === null ? '' : tabName(source, sources ?? []);

	if (held.failed === true || !takesClips(source) || received.inputs.length === 0) {
		const why =
			held.failed === true
				? t('share.notKept')
				: received.inputs.length === 0
					? leftOut(received.tooLarge)
					: notConnected(source, name);
		return (
			<InfoDialog title={t('share.notAdded')} onClose={done}>
				<p>{why}</p>
			</InfoDialog>
		);
	}

	const shown = showsClipboard(source);
	const add = async () => {
		const connectionId = source.connectionId;
		if (!shown) await setClipboardShown(database, connectionId, true);
		await addClips(database, connectionId, received.inputs);
		void sync.clipboard.flush(connectionId);
		if (!shown) void sync.clipboard.refresh(connectionId);
		onAdded();
	};

	return (
		<ConfirmDialog
			title={t('share.ask')}
			confirmLabel={shown ? t('share.add') : t('share.showAndAdd')}
			tone="primary"
			onConfirm={() => {
				void add().then(done, () => {
					setHeld({ ...held, failed: true });
				});
			}}
			onCancel={done}
		>
			{/* Whole sentences, one after another. */}
			{t('share.goesOn', { what: whatCame(received), source: name })}
			{shown ? '' : ` ${t('share.showsHere')}`}
			{received.tooLarge.length > 0 ? ` ${leftOut(received.tooLarge)}` : ''}
		</ConfirmDialog>
	);
};
