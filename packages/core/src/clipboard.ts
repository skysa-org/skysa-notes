import { showsInline } from './attachments.js';
import { CLIPBOARD_FOLDER, NOTE_EXTENSION } from './config.js';
import { extensionOf } from './markdown/attachments.js';
import { attachmentName } from './markdown/slug.js';
import { isWithin, joinPath } from './paths.js';

/**
 * The clipboard a connection's devices share (docs/ARCHITECTURE.md §7, "The
 * clipboard"): one file per item in `CLIPBOARD_FOLDER`, and everything the app
 * knows about an item read from its name. No index file: two devices pasting at
 * once would each write their own version of it, and one would be lost. A name
 * is written once, by the device that pasted, and never written into again.
 *
 * `<stamp>-<attachmentName>` — `20261006T153012123Z-pasted-image-3f9a1c2b.png`.
 * The stamp orders the items, newest first, and the hash says when a paste is
 * one already there, which then goes to the top rather than in twice.
 */

/** What an item shows as: a preview, a thumbnail, or a card that saves. */
export type ClipKind = 'text' | 'image' | 'file';

export interface ClipName {
	/** When it was pasted, in milliseconds, from the stamp. */
	at: number;
	/** The hex of its SHA-256 the name carries, 8 to 16 characters. */
	hash: string;
	kind: ClipKind;
	/**
	 * Its own name, as it is shown and saved: `q3-report.pdf`. None for text, or
	 * for a picture pasted with no name of its own, which the app calls
	 * something in the user's language.
	 */
	label: string | undefined;
}

/** The name the stem of a pasted text takes. */
const TEXT_STEM = 'text';

/** The stem `attachmentName` gives a picture with no name of its own. */
const PASTED_IMAGE_STEM = 'pasted-image';

/**
 * `20261006T153012123Z`: UTC to the millisecond, with nothing a provider or a
 * filesystem refuses in a name, and sorting as it reads.
 */
const stampOf = (at: number): string => new Date(at).toISOString().replace(/[-:.]/g, '');

const NAME =
	/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-(.+)-([0-9a-f]{8,16})\.([a-z0-9]{1,16})$/;

/**
 * When a paste is stamped: now, or just after the newest item this device
 * knows of if that is later. A device whose clock is behind would otherwise
 * stamp its own paste older than the items already there, and the cap would
 * let go of it as the oldest the moment it went up.
 */
export const clipStamp = (now: number, newest: number | undefined): number =>
	newest === undefined ? now : Math.max(now, newest + 1);

/**
 * The name an item is stored under. Text is `text-<hash>.txt`; a picture from
 * the clipboard, whose own name says nothing, `pasted-image-<hash>.png`; any
 * other file its own name's slug, as an attachment's is (`attachmentName`).
 *
 * A `.md` file keeps `.md`, which `attachmentName` refuses beside a note: in
 * the hidden folder it is no note to any device, since the engine asks
 * `isHidden` before it asks anything else.
 */
export const clipName = ({
	at,
	hash,
	name = '',
	type = '',
	text = false,
	pasted = false,
}: {
	at: number;
	hash: string;
	name?: string;
	type?: string;
	text?: boolean;
	pasted?: boolean;
}): string => {
	const stamp = stampOf(at);
	if (text) return `${stamp}-${attachmentName({ name: `${TEXT_STEM}.txt`, hash })}`;
	const named = attachmentName({ name, type, hash, pasted });
	if (named !== undefined) return `${stamp}-${named}`;
	// `.md`, named as `.txt` would be and given its own extension back. The
	// shorter extension fits wherever the longer one did.
	const stem = name.slice(0, -NOTE_EXTENSION.length);
	const asText = attachmentName({ name: `${stem}.txt`, hash }) ?? `attachment-${hash}.txt`;
	return `${stamp}-${asText.slice(0, -'.txt'.length)}${NOTE_EXTENSION}`;
};

/**
 * What a name in the folder says, or `undefined` for one the app did not
 * write, which the clipboard leaves alone: another tool's file, or one a
 * provider renamed aside.
 */
export const readClipName = (name: string): ClipName | undefined => {
	const match = NAME.exec(name);
	if (match === null) return undefined;
	const [, year, month, day, hour, minute, second, ms, stem = '', hash = '', extension = ''] =
		match;
	const at = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second),
		Number(ms)
	);
	// A month or an hour that is no such thing, which `Date.UTC` rolls over.
	if (Number.isNaN(at) || stampOf(at) !== name.slice(0, 19)) return undefined;
	if (stem === TEXT_STEM && extension === 'txt') {
		return { at, hash, kind: 'text', label: undefined };
	}
	const label = stem === PASTED_IMAGE_STEM ? undefined : `${stem}.${extension}`;
	// A picture the browser draws, and not an SVG: a picture here is drawn from
	// a `blob:` URL, which is this app's origin (§9).
	const image = showsInline(name) && extensionOf(name) !== 'svg';
	return { at, hash, kind: image ? 'image' : 'file', label };
};

/** Where an item is, from the root of the app folder. */
export const clipPath = (name: string): string => joinPath(CLIPBOARD_FOLDER, name);

/**
 * Whether a path is the clipboard's: its folder, or anything in it. The folder
 * itself counts, because a folder deleted whole is reported without what was
 * in it.
 */
export const isClipPath = (path: string): boolean => isWithin(path, CLIPBOARD_FOLDER);
