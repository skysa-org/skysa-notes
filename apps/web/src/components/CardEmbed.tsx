import { classifyHref, fileKind, type PreviewEmbed } from '@skysa/core';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

import { type AttachmentHost, NO_ATTACHMENTS, type Shown } from '../editor/attachHost.js';
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

const CardHost = createContext<AttachmentHost>(NO_ATTACHMENTS);

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

/**
 * What the picture at `src` is drawn from, once it is on screen and got, and
 * nothing until then or where it cannot be. One that is not got is asked for
 * again when what links resolve to may have changed — a file arrived with a
 * pull, the network came back — and one that is, is let go of with the card.
 */
const usePictureUrl = (src: string, element: Element | null): string | undefined => {
	const host = useContext(CardHost);
	const seen = useSeen(element);
	const [shown, setShown] = useState<{ src: string; url: string }>();
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
		if (kind !== 'relative' || !seen) return undefined;
		const asking = new AbortController();
		const kept = { current: (): void => undefined };
		void host
			.show(src, { signal: asking.signal })
			.catch((): Shown => ({ state: 'failed' }))
			.then((answer) => {
				if (answer.state !== 'ready') return;
				if (asking.signal.aborted) {
					answer.release();
					return;
				}
				kept.current = answer.release;
				setShown({ src, url: answer.url });
			});
		return () => {
			asking.abort();
			kept.current();
		};
	}, [host, src, kind, seen, asks]);
	return url;
};

type Embedded<Kind extends PreviewEmbed['kind']> = Extract<PreviewEmbed, { kind: Kind }>;

/** A picture, drawn whole at the card's width at most; its words until it is. */
const CardPicture = ({ embed, words }: { embed: Embedded<'image'>; words: string }) => {
	const [element, setElement] = useState<HTMLSpanElement | null>(null);
	const url = usePictureUrl(embed.src, element);
	const [broken, setBroken] = useState<string>();
	const drawn = url !== undefined && broken !== url;
	return (
		<span
			ref={setElement}
			className="scratch-card-picture"
			data-state={drawn ? 'ready' : undefined}
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
