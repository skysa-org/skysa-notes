import { siteName } from '@skysa/core';
import { type ReactNode, useEffect, useSyncExternalStore } from 'react';

import { openLink } from '../editor/links.js';
import { t } from '../i18n/t.js';
import type { ChannelState, FillChannel } from './channel.js';

/**
 * The fill window (docs/ARCHITECTURE.md §7, "Filling in on a site"), opened
 * over a site's sign-in page by the bookmarklet: what it knows of the page,
 * as its channel says (`channel.ts`), and, once the page has said who it is,
 * that page's logins.
 */

/** Passwords in the app, from the window: in a tab of its own, with no hold on this one (`openLink`). */
const openPasswords = () => {
	openLink(new URL('/#passwords', window.location.origin));
};

/** What the window says while it does not know the page, or cannot read it. */
const notYet = (at: Exclude<ChannelState, { state: 'hello' }>): ReactNode => {
	if (at.state === 'waiting') {
		return (
			<p className="muted" role="status">
				{at.slow ? t('fill.slow') : t('fill.waiting')}
			</p>
		);
	}
	if (at.state === 'alone') {
		return (
			<>
				<p>{t('fill.alone')}</p>
				<button type="button" onClick={openPasswords}>
					{t('fill.openPasswords')}
				</button>
			</>
		);
	}
	return <p>{at.state === 'newer' ? t('fill.newer') : t('fill.older')}</p>;
};

export const FillPage = ({ channel }: { channel: FillChannel }) => {
	const at = useSyncExternalStore(channel.subscribe, channel.current);
	const heading =
		at.state === 'hello' ? t('fill.on', { site: siteName(at.site) }) : t('fill.title');

	useEffect(() => {
		document.title = heading;
	}, [heading]);

	return (
		<main className="fill-page">
			<header className="fill-header">
				<h1>{heading}</h1>
				{at.state === 'hello' && !at.site.secure && (
					<span className="fill-insecure">{t('fill.notSecure')}</span>
				)}
			</header>
			{at.state === 'hello'
				? at.outdated && <p className="muted">{t('fill.outdated')}</p>
				: notYet(at)}
		</main>
	);
};
