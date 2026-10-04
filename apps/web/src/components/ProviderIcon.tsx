import { type ProviderKind } from '@skysa/core';

import dropbox from '../assets/providers/dropbox.svg';
import gdrive16 from '../assets/providers/gdrive-16.png';
import gdrive32 from '../assets/providers/gdrive-32.png';
import gdrive48 from '../assets/providers/gdrive-48.png';
import onedrive from '../assets/providers/onedrive.svg';
import { Icon } from '../editor/icons.js';
import { type ConnectedSource } from '../store/connection.js';
import { LOCAL_CONNECTION_ID } from '../store/db.js';

/**
 * Which storage a source is, in front of its name: on a tab, on a row of a
 * compact window's source dropdown, and on each provider the `+` offers — and
 * alone, in place of the name, on that dropdown's trigger, where a phone has
 * no room for it (2026-10-04).
 *
 * Each provider's own mark, as the provider publishes it, in its own colours:
 * a name the user gave ("Work") says nothing about where the notes are, and a
 * mark redrawn in this app's line style would be one nobody recognises at a
 * glance, which is what it is for. The files are the vendors', unaltered —
 * the brand rules each one sets ask for that — and stay their trademarks: they
 * are here to say which service a source is, which is the use each allows,
 * and are not covered by this repository's licence (`TRADEMARK.md`).
 *
 * - Dropbox: the glyph from https://brand.dropbox.com/ (the logo page's own
 *   path), in Dropbox Blue as that page fills it. Use of it is under
 *   https://docs.dropboxapi.com/dropbox-api/docs/developer-resources/branding-guide.
 * - OneDrive: Microsoft's icon (2025) at the size it draws for small use, from
 *   https://www.microsoft.com/content/dam/microsoft/bade/images/icons/en-us/456100-icon-onedrive-17x17.svg.
 * - Google Drive: Google's logo (2026), which Google publishes as images only,
 *   from https://www.gstatic.com/images/branding/productlogos/drive_2026/v2/,
 *   where https://developers.google.com/workspace/drive/api/guides/branding
 *   links it: `web-16dp/logo_drive_2026_color_1x_web_16dp.png` and `_2x_`,
 *   and `web-24dp/logo_drive_2026_color_2x_web_24dp.png` for a 3x screen.
 *
 * This device's notes, and a source that no longer says whose it was
 * (`ensureDetached`), have no mark to show and get a glyph in the text's
 * colour. So does WebDAV, which is no one's.
 *
 * An `<img>`, not markup inlined into the page: the marks are drawn exactly as
 * published, an id inside one cannot meet the same id in another copy of it,
 * and nothing about them reaches the page's scripts. Decorative everywhere —
 * the name is beside it, or the button it is in says it — so `alt` is empty.
 */

/** What a source's mark is chosen by: its provider, or this device. */
export type SourceKind = ProviderKind | 'local' | undefined;

export const sourceKind = (
	source: Pick<ConnectedSource, 'connectionId' | 'provider'>
): SourceKind => (source.connectionId === LOCAL_CONNECTION_ID ? 'local' : source.provider);

const MARKS: Partial<Record<ProviderKind, { src: string; srcSet?: string }>> = {
	dropbox: { src: dropbox },
	onedrive: { src: onedrive },
	gdrive: { src: gdrive32, srcSet: `${gdrive16} 1x, ${gdrive32} 2x, ${gdrive48} 3x` },
};

export const ProviderIcon = ({ kind }: { kind: SourceKind }) => {
	const mark = kind === undefined || kind === 'local' ? undefined : MARKS[kind];
	if (mark === undefined)
		return <Icon name={kind === 'local' ? 'device' : 'storage'} className="provider-icon" />;
	return (
		<img
			className="provider-icon"
			src={mark.src}
			{...(mark.srcSet === undefined ? {} : { srcSet: mark.srcSet })}
			alt=""
			width={16}
			height={16}
			// A press on a tab is not the start of dragging its picture away.
			draggable={false}
		/>
	);
};
