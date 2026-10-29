import type { ProviderKind } from '@skysa/core';
import { Fragment, type RefObject } from 'react';

import { rich } from '../../i18n/rich.js';
import { t } from '../../i18n/t.js';
import type { SyncStateRecord } from '../../store/db.js';
import { LEFT_AT_PROVIDER, UNSEEN_AT_PROVIDER } from '../../sync/account.js';
import { InfoDialog } from '../InfoDialog.js';
import type { OptionsMenuItem } from '../OptionsMenu.js';

/** How many of the files that could not be read are named before "and N more". */
const UNREADABLE_NAMED = 5;

const byName = (one: string, two: string): number => one.localeCompare(two);

/**
 * `a.md, b.md, … and 3 more`. Each path is its own `<bdi>`, so a name written
 * right-to-left cannot reorder the list around it or swallow the comma after
 * it — the path is data, and the sentence is not.
 */
const PathList = ({ paths }: { paths: readonly string[] }) => {
	const named = paths.slice(0, UNREADABLE_NAMED);
	const more = paths.length - named.length;
	const list = named.map((path, at) => (
		<Fragment key={path}>
			{at > 0 && t('account.paths.separator')}
			<bdi>{path}</bdi>
		</Fragment>
	));
	return (
		<>{more > 0 ? rich('account.paths.more', { list: () => list }, { count: more }) : list}</>
	);
};

/**
 * The files in this source that are not UTF-8 text, which sync leaves alone
 * (docs/ARCHITECTURE.md §7). Said because nothing else does: such a file is not in the
 * list of notes, and a note whose file became one has gone from this device.
 * By path, since that is how the user finds the file in the tool that wrote it,
 * and with what to do about it, since nothing here can do it for them.
 *
 * And where a note of theirs went when one of these files took its name
 * (`movedAside`). That is not a conflict — nothing was edited twice and no copy
 * was made — so it is said here, beside the file that caused it, rather than in
 * the conflicts line above.
 */
export const UnreadableNotice = ({
	files = [],
	label,
}: {
	files: SyncStateRecord['unreadable'];
	label: string;
}) => {
	const paths = files.map((file) => file.path).sort(byName);
	const moved = [...new Set(files.flatMap((file) => file.movedAside ?? []))].sort(byName);
	const [only] = paths;
	if (only === undefined) return null;
	return (
		<p className="muted wrap-anywhere">
			{rich(
				'account.unreadable.files',
				{
					path: (words) => <bdi>{words}</bdi>,
					paths: () => <PathList paths={paths} />,
				},
				{ count: paths.length, path: only, provider: label }
			)}
			{/* A sentence of its own, with a count of its own. */}
			{moved.length > 0 && (
				<>
					{' '}
					{rich(
						'account.unreadable.moved',
						{ paths: () => <PathList paths={moved} /> },
						{ count: moved.length }
					)}
				</>
			)}
		</p>
	);
};

/**
 * Where to withdraw the app's access by hand, for a provider that gives the
 * server no way to. The links open elsewhere, so the confirmation — and the
 * address — are still here to come back to.
 */
export const LeftAtProvider = ({ provider }: { provider: ProviderKind | undefined }) => {
	if (provider !== 'onedrive') return null;
	const pages = LEFT_AT_PROVIDER.onedrive;
	return (
		<p className="muted">
			{rich('account.leftAtProvider.onedrive', {
				consent: (words) => (
					<a href={pages.consent} target="_blank" rel="noreferrer">
						{words}
					</a>
				),
				myApps: (words) => (
					<a href={pages.myApps} target="_blank" rel="noreferrer">
						{words}
					</a>
				),
			})}
		</p>
	);
};

/**
 * What this source's app folder holds that the app cannot see: a user who
 * copies notes into the folder by hand otherwise finds nothing arrived, and
 * nothing to say why (`UNSEEN_AT_PROVIDER`). An item of the gear's menu or the
 * `⋯`, that opens it over everything: it is the same for every Drive source
 * for good, and said in the panel it would be a paragraph there for good.
 */
export const unseenItem = (
	provider: ProviderKind | undefined,
	label: string,
	onOpen: () => void
): OptionsMenuItem[] =>
	provider !== undefined && UNSEEN_AT_PROVIDER[provider] !== undefined
		? [{ label: t('account.menu.about', { provider: label }), onChoose: onOpen }]
		: [];

export const UnseenDialog = ({
	provider,
	onClose,
	returnFocus,
}: {
	provider: ProviderKind | undefined;
	onClose: () => void;
	returnFocus: RefObject<HTMLElement | null>;
}) => {
	const unseen = provider === undefined ? undefined : UNSEEN_AT_PROVIDER[provider];
	if (unseen === undefined) return null;
	return (
		<InfoDialog title={unseen.summary} onClose={onClose} returnFocus={returnFocus}>
			<p>{unseen.detail}</p>
		</InfoDialog>
	);
};
