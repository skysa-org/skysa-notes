import { useLayoutEffect, useRef, useState } from 'react';

import { bookmarkletUrl } from '../fill/bookmarklet.js';
import { t } from '../i18n/t.js';
import { Dialog } from './ui/Dialog.js';

/**
 * Setting up the bookmarklet that fills in on sites (docs/ARCHITECTURE.md §7,
 * "Filling in on a site"), from Passwords: its link, to drag to the bookmarks
 * bar, and Copy beside it, for a phone, where a bookmark's address is pasted
 * in; and what it does, and where it does not work. It asks nothing, so the
 * ✕ is its way out and has the focus, at the top, where the link is: an
 * answer in its row would take the focus, and scroll the link out of sight.
 *
 * The link is the one `javascript:` address in the app, and is never run
 * here. React refuses to write one into an `href`, so it is made by hand; a
 * press on it in the app does nothing but say to drag it, and the app's
 * `script-src` would refuse to run it anyway. Its words become the bookmark's
 * name.
 */

export interface FillSetupDialogProps {
	onClose: () => void;
	/** Words to the system clipboard. */
	copy?: (text: string) => Promise<void>;
	/** The app's address, which the bookmarklet opens its window at. */
	origin?: string;
	/** The app's name, for the bookmark's. */
	appName?: string | undefined;
}

type Said = 'nothing' | 'copied' | 'notCopied' | 'pressed';

const copyText = (text: string): Promise<void> => navigator.clipboard.writeText(text);

/** The link, made by hand: React will not write a `javascript:` address. */
const useBookmarkletLink = (address: string, name: string, onPressed: () => void) => {
	const holder = useRef<HTMLSpanElement>(null);
	const pressed = useRef(onPressed);
	useLayoutEffect(() => {
		pressed.current = onPressed;
	});
	useLayoutEffect(() => {
		const at = holder.current;
		if (at === null) return undefined;
		const link = document.createElement('a');
		link.setAttribute('href', address);
		link.className = 'fill-bookmarklet';
		link.textContent = name;
		link.addEventListener('click', (event) => {
			event.preventDefault();
			pressed.current();
		});
		at.replaceChildren(link);
		return () => {
			at.replaceChildren();
		};
	}, [address, name]);
	return holder;
};

export const FillSetupDialog = ({
	onClose,
	copy = copyText,
	origin = window.location.origin,
	appName = import.meta.env.VITE_APP_NAME,
}: FillSetupDialogProps) => {
	const [said, setSaid] = useState<Said>('nothing');
	const address = bookmarkletUrl(origin);
	const name =
		appName === undefined || appName === ''
			? t('fill.setup.linkUnnamed')
			: t('fill.setup.link', { app: appName });
	const holder = useBookmarkletLink(address, name, () => {
		setSaid('pressed');
	});

	return (
		<Dialog
			title={t('fill.setup.title')}
			className="fill-setup-dialog"
			onClose={onClose}
			cancel={false}
		>
			<p>{t('fill.setup.intro')}</p>
			<div className="fill-bookmarklet-holder">
				<span ref={holder} />
				<button
					type="button"
					onClick={() => {
						void copy(address).then(
							() => {
								setSaid('copied');
							},
							() => {
								setSaid('notCopied');
							}
						);
					}}
				>
					{t('fill.setup.copy')}
				</button>
			</div>
			<div className="secrets-said" role="status">
				{said !== 'nothing' && <p>{t(`fill.setup.said.${said}`)}</p>}
			</div>
			<h3>{t('fill.setup.computerHeading')}</h3>
			<p>{t('fill.setup.computer')}</p>
			<h3>{t('fill.setup.phoneHeading')}</h3>
			<p>{t('fill.setup.phone')}</p>
			<p>{t('fill.setup.site')}</p>
			<p>
				<strong>{t('fill.setup.recovery')}</strong>
			</p>
			<h3>{t('fill.setup.limitsHeading')}</h3>
			<ul>
				<li>{t('fill.setup.limitsBrowsers')}</li>
				<li>{t('fill.setup.limitsHomeScreen')}</li>
				<li>{t('fill.setup.limitsPage')}</li>
				<li>{t('fill.setup.origin', { origin })}</li>
				<li>{t('fill.setup.outdated')}</li>
			</ul>
		</Dialog>
	);
};
