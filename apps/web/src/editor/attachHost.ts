import { $ctx } from '@milkdown/kit/utils';
import type { AttachmentKind } from '@skysa/core';

import type { AttachmentRefusal } from '../store/files.js';

/**
 * What the rich editor asks of the app about the files beside a note (#187).
 *
 * The editor deals only in what the markdown says — an image's `src`, a link's
 * `href` — and never in rows, sources or bytes. Turning one into something to
 * show is the app's: which note the editor holds, where that note is now, which
 * source it is in, and whether the bytes are here. So the editor is handed a
 * host, and a note that moves, is renamed or is bound to a source never needs
 * an editor rebuilt.
 *
 * A Milkdown ctx slice, as the slash menu's spec is, since what needs it — the
 * node views, the view's props, the commands — is built by Milkdown rather
 * than by the component that has the host.
 */

/** A picture's width and height as drawn, in its own pixels. */
export interface PictureSize {
	readonly width: number;
	readonly height: number;
}

/** What showing a picture came to. */
export type Shown =
	/**
	 * A URL to draw it from, and the way to let it go once nothing shows it.
	 * With the picture's own size where it is known, which the box it is drawn
	 * in takes whichever copy of it the URL is (#276).
	 */
	| ({ state: 'ready'; url: string; release: () => void } & Partial<PictureSize>)
	/** The link names no file beside the note, or the source no longer has it. */
	| { state: 'missing' }
	| { state: 'offline' }
	/** Not on this device, and its source cannot be read from now. */
	| { state: 'unavailable' }
	/** The download went wrong. Worth asking again. */
	| { state: 'failed' }
	/** A file no browser can be relied on to draw (`showsInline`): not downloaded. */
	| { state: 'unsupported' }
	/** Large enough to download only when asked to (`large: true`). */
	| { state: 'large'; size: number }
	/** The asker stopped waiting. */
	| { state: 'aborted' };

export interface ShowOptions {
	readonly signal: AbortSignal;
	/** Download it even if it is large: the user asked to see it. */
	readonly large?: boolean;
	/**
	 * The most the view draws it at, in device pixels: `'thumb'` for a card's
	 * box, or a width. A copy that size is drawn in its place where one is
	 * worth having (`pictureVariant`). Without it, the picture as it is.
	 */
	readonly fit?: 'thumb' | Readonly<{ width: number }>;
}

/**
 * A file's bytes, for opening or saving it: a `File` named as it is stored and
 * typed as this origin may open it (`safeOpenType`), or why there is none.
 */
export type Fetched =
	| { state: 'ready'; file: File }
	| { state: 'missing' }
	| { state: 'offline' }
	| { state: 'unavailable' }
	| { state: 'failed' }
	| { state: 'aborted' };

/** What adding a file to the note came to. */
export type Added =
	/** Beside the note: what links it, as a node or as markdown. */
	| {
			state: 'added';
			fileId: string;
			href: string;
			label: string;
			kind: AttachmentKind;
			markdown: string;
	  }
	/** Not a file that can go beside a note: too large, or a note itself. */
	| { state: 'refused'; reason: AttachmentRefusal }
	| { state: 'failed' }
	/** Nowhere to put it: an editor with no note behind it. */
	| { state: 'unavailable' };

/** Something the editor could not do with a file, for the app to tell the user. */
export interface AttachmentProblem {
	readonly message: string;
	readonly tone: 'warning' | 'error';
}

export interface AttachmentHost {
	/** A picture, for a link relative to the note (`classifyHref`). */
	readonly show: (href: string, options: ShowOptions) => Promise<Shown>;
	/**
	 * A picture's size, where this device has read it before: for the box it
	 * is drawn in to be held before it is shown, so what is below it does not
	 * move when it is.
	 */
	readonly size: (href: string) => Promise<PictureSize | undefined>;
	/**
	 * Any file, for a link relative to the note, whatever its size: the user
	 * asked for it by opening or saving it.
	 */
	readonly fetchFile: (href: string, signal?: AbortSignal) => Promise<Fetched>;
	/** Tell the user, where the editor has nowhere to say it. */
	readonly report: (problem: AttachmentProblem) => void;
	/**
	 * Put a file beside the note, as the user has just asked to: pasted —
	 * a picture from the clipboard has no name of its own — or not.
	 */
	readonly add: (file: File, options: Readonly<{ pasted: boolean }>) => Promise<Added>;
	/**
	 * Offer this editor as where files the user picks from outside it go — the
	 * palette's "Attach files", which serves both editors. The one open now
	 * offers itself; the returned function takes it back.
	 */
	readonly receive: (receiver: FileReceiver) => () => void;
	/**
	 * Called when what a link resolves to may have changed: the note moved,
	 * a file arrived with a pull, the network came back. Returns the way to stop.
	 */
	readonly changed: (listener: () => void) => () => void;
}

/** Where files the user has picked go: into the editor open now, at its selection. */
export type FileReceiver = (files: readonly File[]) => void;

/** The host of an editor nobody gave one: it shows nothing beside a note. */
export const NO_ATTACHMENTS: AttachmentHost = {
	show: () => Promise.resolve({ state: 'unavailable' }),
	size: () => Promise.resolve(undefined),
	fetchFile: () => Promise.resolve({ state: 'unavailable' }),
	report: () => undefined,
	add: () => Promise.resolve({ state: 'unavailable' }),
	receive: () => () => undefined,
	changed: () => () => undefined,
};

export const attachHostCtx = $ctx<AttachmentHost, 'skysaAttachHost'>(
	NO_ATTACHMENTS,
	'skysaAttachHost'
);
