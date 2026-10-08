import { classifyHref, fileKind, type PreviewEmbed } from '@skysa/core';
import {
	createContext,
	type CSSProperties,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from 'react';

import {
	type AttachmentHost,
	NO_ATTACHMENTS,
	type PictureSize,
	type Shown,
} from '../editor/attachHost.js';
import { FILE_ICONS, Icon } from '../editor/icons.js';
import { t } from '../i18n/t.js';
import { type NoteRecord } from '../store/db.js';
import { useNoteAttachments } from './noteAttachments.js';

/**
 * A picture or a file's chip on a scratch card (docs/ARCHITECTURE.md §7, "The
 * scratchpad"), where it is in the note and as the editor draws it: the
 * picture itself, got as the editor gets it, and the chip with its file's
 * icon and name. A picture not shown — not got yet, or not to be got — is its
 * words, as it was before it was drawn at all.
 */

/** Where a card's pictures are got from: `CardFiles` says, and a test may. */
export const CardHost = createContext<AttachmentHost>(NO_ATTACHMENTS);

/**
 * Where a card's pictures are got from: the files beside its note, as its
 * editor gets them (`useNoteAttachments`) — from the device, and otherwise
 * downloaded, but a large one only when asked to, which a card never does.
 * Only around a card with a picture in it.
 */
export const CardFiles = ({ note, children }: { note: NoteRecord; children: ReactNode }) => {
	const host = useNoteAttachments(note);
	return <CardHost.Provider value={host}>{children}</CardHost.Provider>;
};

/** Whether `element` has been on screen: a picture is got only then, as in the editor. */
const useSeen = (element: Element | null): boolean => {
	// Where nothing can say so, as soon as it is drawn.
	const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
	useEffect(() => {
		if (seen || element === null) return undefined;
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
		});
		observer.observe(element);
		return () => {
			observer.disconnect();
		};
	}, [seen, element]);
	return seen;
};

/** A card's picture: what it is drawn from, and how large it is. */
interface CardPictureAt {
	/** Once it is on screen and got; nothing until then, or where it cannot be. */
	readonly url: string | undefined;
	/** Its own size, where this device has read it before (`AttachmentHost.size`). */
	readonly size: PictureSize | undefined;
	/** Not coming now: it was asked for, and the answer was why not. */
	readonly gone: boolean;
}

/**
 * The picture at `src`, as a card draws it: the thumb, a copy no larger than
 * the card ever draws it (#276), got once it is on screen. Its size is asked
 * for as soon as the card is drawn, seen or not. One that is not got is asked
 * for again when what links resolve to may have changed — a file arrived with
 * a pull, the network came back — and one that is, is let go of with the card.
 */
const usePicture = (src: string, element: Element | null): CardPictureAt => {
	const host = useContext(CardHost);
	const seen = useSeen(element);
	const [shown, setShown] = useState<{ src: string; url: string }>();
	const [sized, setSized] = useState<{ src: string; size: PictureSize }>();
	const [gone, setGone] = useState<string>();
	const [asks, setAsks] = useState(0);
	const kind = classifyHref(src);
	// On the web, or in the link itself, the address is the picture's.
	const direct = kind === 'https' || kind === 'data';
	const url = direct ? src : shown?.src === src ? shown.url : undefined;
	useEffect(
		() =>
			url === undefined
				? host.changed(() => {
						setAsks((count) => count + 1);
					})
				: undefined,
		[host, url]
	);
	useEffect(() => {
		if (kind !== 'relative') return undefined;
		const asking = new AbortController();
		void host.size(src).then((size) => {
			if (asking.signal.aborted || size === undefined) return;
			setSized({ src, size });
		});
		return () => {
			asking.abort();
		};
	}, [host, src, kind]);
	useEffect(() => {
		if (kind !== 'relative' || !seen) return undefined;
		const asking = new AbortController();
		const kept = { current: (): void => undefined };
		void host
			.show(src, { signal: asking.signal, fit: 'thumb' })
			.catch((): Shown => ({ state: 'failed' }))
			.then((answer) => {
				if (answer.state === 'aborted') return;
				if (answer.state !== 'ready') {
					setGone(src);
					return;
				}
				if (asking.signal.aborted) {
					answer.release();
					return;
				}
				kept.current = answer.release;
				setShown({ src, url: answer.url });
				setGone(undefined);
			});
		return () => {
			asking.abort();
			kept.current();
		};
	}, [host, src, kind, seen, asks]);
	return {
		url,
		size: sized?.src === src ? sized.size : undefined,
		gone: gone === src,
	};
};

/**
 * The room a picture takes in a card, held from the card's first drawing so
 * the wall places the card at the height it will have, and does not place it
 * again when the picture arrives: as large as it is drawn, where this device
 * has read its size before — as wide as it is, or the card, and no taller
 * than the card draws any picture — and else that tallest, the picture drawn
 * inside it, for as long as the card is drawn. A size said only as the
 * picture comes is not taken: copies are made one at a time, so on a wall
 * seen for the first time pictures come one by one, and each would place the
 * wall again. The next time, the room is the picture's own.
 */
type Room = Readonly<{ size: PictureSize }> | 'tallest';

const roomStyle = (room: Room): (CSSProperties & Record<`--${string}`, string>) | undefined =>
	room === 'tallest'
		? undefined
		: {
				'--card-picture-width': `${String(room.size.width)}px`,
				'--card-picture-ratio': `${String(room.size.width)} / ${String(room.size.height)}`,
			};

type Embedded<Kind extends PreviewEmbed['kind']> = Extract<PreviewEmbed, { kind: Kind }>;

/**
 * A picture, drawn whole at the card's width at most; its words until it is,
 * in the room it will take (`Room`) while it is coming.
 */
const CardPicture = ({ embed, words }: { embed: Embedded<'image'>; words: string }) => {
	const [element, setElement] = useState<HTMLSpanElement | null>(null);
	const { url, size, gone } = usePicture(embed.src, element);
	const [broken, setBroken] = useState<string>();
	const drawn = url !== undefined && broken !== url;
	const failed = url !== undefined && broken === url;
	// One from beside the note, while it comes and once it has; none once it
	// will not, and none for one from the web, which comes as it comes.
	const coming = classifyHref(embed.src) === 'relative' && !gone && !failed;
	const room: Room | undefined = !coming ? undefined : size === undefined ? 'tallest' : { size };
	return (
		<span
			ref={setElement}
			className="scratch-card-picture"
			data-state={drawn ? 'ready' : undefined}
			data-room={room === undefined ? undefined : room === 'tallest' ? 'tallest' : 'sized'}
			style={room === undefined ? undefined : roomStyle(room)}
		>
			{drawn ? (
				<img
					src={url}
					alt={embed.alt}
					decoding="async"
					referrerPolicy="no-referrer"
					onError={() => {
						setBroken(url);
					}}
				/>
			) : (
				words.trim() || t('scratchpad.card.picture')
			)}
		</span>
	);
};

/** A file's chip: its kind's icon and its name. */
const CardChip = ({ embed }: { embed: Embedded<'file'> }) => (
	<span className="attachment-chip scratch-card-chip">
		<span className="attachment-icon" aria-hidden="true">
			<Icon name={FILE_ICONS[fileKind(embed.fileName)]} />
		</span>
		<span className="attachment-name">{embed.name}</span>
	</span>
);

/** A picture or a chip in a card's line, where `words` is what it says. */
export const CardEmbed = ({ embed, words }: { embed: PreviewEmbed; words: string }) =>
	embed.kind === 'image' ? (
		<CardPicture embed={embed} words={words} />
	) : (
		<CardChip embed={embed} />
	);

/** Whether any of a card's lines has a picture in it, and so needs its files. */
export const hasPictures = (lines: readonly { runs: readonly { embed?: PreviewEmbed }[] }[]) =>
	lines.some((line) => line.runs.some((run) => run.embed?.kind === 'image'));
