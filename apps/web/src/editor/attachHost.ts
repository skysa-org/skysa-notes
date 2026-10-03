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

/** What showing a picture came to. */
export type Shown =
	/** A URL to draw it from, and the way to let it go once nothing shows it. */
	| { state: 'ready'; url: string; release: () => void }
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
			/** Made by this add, not found already there: what `withdraw` may take back. */
			created: boolean;
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
	/** Take back a file `add` made that the editor had nowhere to link. */
	readonly withdraw: (fileId: string) => Promise<void>;
	/**
	 * Called when what a link resolves to may have changed: the note moved,
	 * a file arrived with a pull, the network came back. Returns the way to stop.
	 */
	readonly changed: (listener: () => void) => () => void;
}

/** The host of an editor nobody gave one: it shows nothing beside a note. */
export const NO_ATTACHMENTS: AttachmentHost = {
	show: () => Promise.resolve({ state: 'unavailable' }),
	fetchFile: () => Promise.resolve({ state: 'unavailable' }),
	report: () => undefined,
	add: () => Promise.resolve({ state: 'unavailable' }),
	withdraw: () => Promise.resolve(),
	changed: () => () => undefined,
};

export const attachHostCtx = $ctx<AttachmentHost, 'skysaAttachHost'>(
	NO_ATTACHMENTS,
	'skysaAttachHost'
);
