import { $ctx } from '@milkdown/kit/utils';

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
	/** Large enough to download only when asked to (`large: true`). */
	| { state: 'large'; size: number }
	/** The asker stopped waiting. */
	| { state: 'aborted' };

export interface ShowOptions {
	readonly signal: AbortSignal;
	/** Download it even if it is large: the user asked to see it. */
	readonly large?: boolean;
}

export interface AttachmentHost {
	/** A picture, for a link relative to the note (`classifyHref`). */
	readonly show: (href: string, options: ShowOptions) => Promise<Shown>;
	/**
	 * Called when what a link resolves to may have changed: the note moved,
	 * a file arrived with a pull, the network came back. Returns the way to stop.
	 */
	readonly changed: (listener: () => void) => () => void;
}

/** The host of an editor nobody gave one: it shows nothing beside a note. */
export const NO_ATTACHMENTS: AttachmentHost = {
	show: () => Promise.resolve({ state: 'unavailable' }),
	changed: () => () => undefined,
};

export const attachHostCtx = $ctx<AttachmentHost, 'skysaAttachHost'>(
	NO_ATTACHMENTS,
	'skysaAttachHost'
);
