import { type Site, siteName } from '@skysa/core';
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

import { copyText } from '../components/clipboard/systemClipboard.js';
import { UnlockDialog } from '../components/secrets/UnlockDialog.js';
import { openLink } from '../editor/features/links/links.js';
import { t } from '../i18n/t.js';
import { type Age, loadAge } from '../secrets/loadAge.js';
import type { SecretsLock } from '../secrets/lock.js';
import { tabLock } from '../secrets/tabLock.js';
import { useDb } from '../store/database.js';
import type { UnlockedKeys } from '../store/secretKeys.js';
import type { FillChannel } from './channel.js';
import {
	type FillSource,
	type FillSources,
	fillSources,
	findMatches,
	type Found,
	type Login,
	loginFor,
	type Match,
} from './matches.js';
import type { Hello } from './protocol.js';
import { Remember } from './Remember.js';
import {
	offerFor,
	saveLogin,
	type Saving,
	typedLogin,
	updateLogin,
	type Wrote,
} from './remembering.js';

/**
 * The fill window's logins, once the page has said who it is
 * (docs/ARCHITECTURE.md §7, "Filling in on a site"): each source with
 * passwords in it unlocked in turn, as the app's own unlock asks, and the
 * passwords whose Site fills in on the page listed, to fill in with, or to
 * copy where the page had no fields to fill; and a password typed on the
 * page offered to be saved, or put in place of the one saved (`Remember`).
 *
 * Asked for only now, after a page's `hello`: a page that opens the window
 * without the bookmarklet's answer never sets off the device's lock. The
 * window never asks for the recovery key, which is the app's to ask. And it
 * is used once: filled, it closes; locked, as a tab of the app locks (hidden,
 * or idle), it closes too.
 */

export interface FillLoginsOptions {
	lock?: SecretsLock;
	age?: () => Promise<Age>;
	/** Words to the system clipboard. */
	copy?: (text: string) => Promise<void>;
	/** Shut the window. */
	close?: () => void;
	now?: () => number;
}

interface FillLoginsProps extends FillLoginsOptions {
	site: Site;
	hello: Hello;
	channel: FillChannel;
}

/**
 * How long after the window is shown or focused, or what it lists changes,
 * that a press on a login is let be: a press meant for what was there before,
 * or one a page timed to land as the window opened, fills in nothing.
 */
export const PRESS_GUARD_MS = 500;

/** One source's passwords, as far as the window has got with them. */
type Opening =
	| Readonly<{ state: 'unlocking' }>
	| Readonly<{ state: 'opening' }>
	| Readonly<{ state: 'opened'; found: Found }>
	/** Its unlock was closed. */
	| Readonly<{ state: 'locked' }>
	/** The device's copy of its key is gone: only the recovery key, in the app, is left. */
	| Readonly<{ state: 'recovery' }>
	| Readonly<{ state: 'failed' }>;

type Answer = 'unlocked' | 'locked' | 'recovery';

/** An unlock asked for, and whoever is waiting on it. */
interface Asking {
	readonly source: FillSource;
	readonly answer: (answer: Answer) => void;
}

type Said = 'nothing' | 'copied' | 'notCopied' | 'changed' | 'pageGone';

const closeWindow = () => {
	window.close();
};

/** Passwords in the app, from the window: in a tab of its own, with no hold on this one (`openLink`). */
export const openPasswords = () => {
	openLink(new URL('/#passwords', window.location.origin));
};

/** Copies of the keys' identities: the lock wipes its own in place, the moment the page hides. */
const copied = (keys: UnlockedKeys | undefined): Uint8Array[] | undefined =>
	keys?.identities.map((identity) => identity.slice());

const wipe = (identities: readonly Uint8Array[]) => {
	identities.forEach((identity) => identity.fill(0));
};

/** Whether a source is still being unlocked or opened. */
const isBusy = (at: Opening | undefined): boolean =>
	at === undefined || at.state === 'unlocking' || at.state === 'opening';

/**
 * `run`, unless the window was shown or focused, or what it lists or asks
 * changed, less than `PRESS_GUARD_MS` ago.
 *
 * Timed from as what it lists is drawn, in a layout effect, before the browser
 * paints it. A passive effect runs after the paint, so on a slow device a
 * press on rows just drawn could come before it, and be timed from before
 * they were.
 */
const usePressGuard = (now: () => number, listed: unknown, asked: unknown) => {
	const shownAt = useRef(0);
	useLayoutEffect(() => {
		shownAt.current = now();
	}, [now, listed, asked]);
	useEffect(() => {
		const again = () => {
			shownAt.current = now();
		};
		window.addEventListener('focus', again);
		document.addEventListener('visibilitychange', again);
		return () => {
			window.removeEventListener('focus', again);
			document.removeEventListener('visibilitychange', again);
		};
	}, [now]);
	return (run: () => void) => () => {
		if (now() - shownAt.current >= PRESS_GUARD_MS) run();
	};
};

interface RowProps {
	match: Match;
	page: Site;
	/** The source it is in, where there is more than one to say it of. */
	source: FillSource | undefined;
	/** Fill in with it, rather than copy it. */
	fills: boolean;
	press: (run: () => void) => () => void;
	onFill: (match: Match) => void;
	onCopy: (match: Match, field: keyof Login) => void;
}

const LoginRow = ({ match, page, source, fills, press, onFill, onCopy }: RowProps) => {
	const labelId = useId();
	const above = siteName(match.savedFor) !== siteName(page);
	return (
		<li className="fill-login">
			<div className="fill-login-text">
				<span id={labelId} className="fill-login-label">
					{match.label}
				</span>
				{match.username !== '' && <span>{match.username}</span>}
				{above && (
					<span className="muted">
						{t('fill.savedFor', { site: siteName(match.savedFor) })}
					</span>
				)}
				{source !== undefined && (
					<span className="muted">{t('fill.inSource', { source: source.name })}</span>
				)}
			</div>
			<div className="fill-login-actions">
				{fills ? (
					<button
						type="button"
						className="primary"
						aria-describedby={labelId}
						onClick={press(() => {
							onFill(match);
						})}
					>
						{t('fill.fill')}
					</button>
				) : (
					<>
						{match.username !== '' && (
							<button
								type="button"
								aria-describedby={labelId}
								onClick={press(() => {
									onCopy(match, 'username');
								})}
							>
								{t('passwords.item.copyUsername')}
							</button>
						)}
						<button
							type="button"
							aria-describedby={labelId}
							onClick={press(() => {
								onCopy(match, 'password');
							})}
						>
							{t('passwords.item.copyPassword')}
						</button>
					</>
				)}
			</div>
		</li>
	);
};

/** What the window says of a source it could not open the passwords of. */
const SourceLine = ({
	source,
	at,
	onUnlock,
}: {
	source: FillSource;
	at: Opening | undefined;
	onUnlock: (source: FillSource) => void;
}) => {
	if (at?.state === 'locked') {
		return (
			<p>
				{t('fill.locked', { source: source.name })}{' '}
				<button
					type="button"
					className="link-button"
					onClick={() => {
						onUnlock(source);
					}}
				>
					{t('fill.unlock')}
				</button>
			</p>
		);
	}
	if (at?.state === 'recovery') {
		return (
			<>
				<p>{t('fill.recovery', { source: source.name })}</p>
				<button type="button" onClick={openPasswords}>
					{t('fill.openPasswords')}
				</button>
			</>
		);
	}
	return at?.state === 'failed' ? (
		<p role="alert">{t('fill.sourceFailed', { source: source.name })}</p>
	) : null;
};

/** No source shows its passwords in this browser. */
const NoSources = () => (
	<>
		<p>{t('fill.noSources')}</p>
		<p className="muted">{t('fill.homeScreen')}</p>
		<button type="button" onClick={openPasswords}>
			{t('fill.openPasswords')}
		</button>
	</>
);

/** None of the passwords looked in fills in on the page. */
const NoLogins = ({ page }: { page: Site }) => (
	<>
		<p>{t('fill.none', { site: siteName(page) })}</p>
		<p className="muted">{t('fill.noneHint')}</p>
		<button type="button" onClick={openPasswords}>
			{t('fill.openPasswords')}
		</button>
	</>
);

/** How far the window has got with the sources, all told. */
const summarize = (sources: readonly FillSource[], opening: ReadonlyMap<string, Opening>) => {
	const found = sources.flatMap((source) => {
		const at = opening.get(source.connectionId);
		return at?.state === 'opened' ? [{ source, found: at.found }] : [];
	});
	const states = sources.map((source) => opening.get(source.connectionId));
	return {
		matches: found.flatMap(({ source, found: { matches: each } }) =>
			each.map((match) => ({ source, match }))
		),
		unopened: found.reduce((sum, each) => sum + each.found.unopened, 0),
		busy: states.some(isBusy),
		allOpened: states.every((at) => at?.state === 'opened'),
	};
};

interface ShownProps extends Omit<RowProps, 'match' | 'source'> {
	sources: FillSources;
	opening: ReadonlyMap<string, Opening>;
	said: Said;
	onUnlock: (source: FillSource) => void;
	/** What is offered for a password typed on the page, under the logins. */
	children?: ReactNode;
}

/** The logins, and what the window says of the sources it looked in. */
const LoginsShown = ({ sources, opening, said, onUnlock, children, ...row }: ShownProps) => {
	const many = sources.sources.length > 1;
	const { matches, unopened, busy, allOpened } = summarize(sources.sources, opening);
	const looked = sources.sources.length > 0 || sources.notSetUp === 0;
	return (
		<>
			{matches.length > 0 && (
				<ul className="fill-logins">
					{matches.map(({ source, match }) => (
						<LoginRow
							key={`${match.connectionId}/${match.noteId}`}
							{...row}
							match={match}
							source={many ? source : undefined}
						/>
					))}
				</ul>
			)}
			<div className="fill-said" role="status">
				{busy && <p className="muted">{t('fill.reading')}</p>}
				{said !== 'nothing' && <p>{t(`fill.said.${said}`)}</p>}
			</div>
			{sources.sources.map((source) => (
				<SourceLine
					key={source.connectionId}
					source={source}
					at={opening.get(source.connectionId)}
					onUnlock={onUnlock}
				/>
			))}
			{allOpened && looked && matches.length === 0 && <NoLogins page={row.page} />}
			{children}
			{unopened > 0 && <p className="muted">{t('fill.unopened', { count: unopened })}</p>}
			{sources.notSetUp > 0 && (
				<p className="muted">{t('fill.notSetUp', { count: sources.notSetUp })}</p>
			)}
		</>
	);
};

export const FillLogins = ({
	site,
	hello,
	channel,
	lock = tabLock,
	age = loadAge,
	copy = copyText,
	close = closeWindow,
	now = Date.now,
}: FillLoginsProps) => {
	const db = useDb();
	const [sources, setSources] = useState<FillSources | 'failed'>();
	const [opening, setOpening] = useState<ReadonlyMap<string, Opening>>(() => new Map());
	const [asking, setAsking] = useState<Asking | null>(null);
	const [said, setSaid] = useState<Said>('nothing');
	/** The sources this window has unlocked: one locking closes it. */
	const unlocked = useRef(new Set<string>());
	const press = usePressGuard(now, opening, asking);
	const typed = typedLogin(hello);

	const set = useCallback((connectionId: string, to: Opening) => {
		setOpening((before) => new Map(before).set(connectionId, to));
	}, []);

	const ask = (source: FillSource) =>
		new Promise<Answer>((resolve) => {
			setAsking({
				source,
				answer: (answer) => {
					setAsking(null);
					resolve(answer);
				},
			});
		});

	/** A source's passwords that fill in on the page, unlocked first where it is locked. */
	const open = async (source: FillSource) => {
		const { connectionId } = source;
		// Nothing in it to look at: only to save to, which needs no unlock.
		if (source.items === 0) {
			set(connectionId, { state: 'opened', found: { matches: [], unopened: 0 } });
			return;
		}
		if (!lock.isUnlocked(connectionId)) {
			set(connectionId, { state: 'unlocking' });
			const answer = await ask(source);
			if (answer !== 'unlocked') {
				set(connectionId, { state: answer });
				return;
			}
		}
		unlocked.current.add(connectionId);
		const identities = copied(lock.keys(connectionId));
		if (identities === undefined) {
			set(connectionId, { state: 'locked' });
			return;
		}
		set(connectionId, { state: 'opening' });
		try {
			const found = await findMatches(
				db,
				await age(),
				connectionId,
				identities,
				site,
				typed?.password
			);
			set(connectionId, { state: 'opened', found });
		} catch {
			set(connectionId, { state: 'failed' });
		} finally {
			wipe(identities);
		}
	};

	// Once, as the page's hello is taken: a strict mode's second mount is the
	// same window, and asks nothing more.
	const started = useRef(false);
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		void (async () => {
			const read = await fillSources(db).catch(() => 'failed' as const);
			setSources(read);
			if (read === 'failed') return;
			await read.sources.reduce<Promise<void>>(async (before, source) => {
				await before;
				await open(source);
			}, Promise.resolve());
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Locked, as a tab of the app locks, the window has done its part.
	useEffect(
		() =>
			lock.subscribe(() => {
				if ([...unlocked.current].some((id) => !lock.isUnlocked(id))) close();
			}),
		[lock, close]
	);

	/** `match`'s login, read from its item again, as it is now. */
	const reading = async (match: Match): Promise<Login | undefined> => {
		const identities = copied(lock.keys(match.connectionId));
		if (identities === undefined) return undefined;
		try {
			return await loginFor(db, await age(), match, identities, site);
		} catch {
			return undefined;
		} finally {
			wipe(identities);
		}
	};

	const fill = async (match: Match) => {
		const login = await reading(match);
		if (login === undefined) {
			setSaid('changed');
			return;
		}
		if (channel.fill(login)) {
			close();
			return;
		}
		setSaid('pageGone');
	};

	const copyField = async (match: Match, field: keyof Login) => {
		const login = await reading(match);
		if (login === undefined) {
			setSaid('changed');
			return;
		}
		const done = await copy(login[field]).then(
			() => true,
			() => false
		);
		setSaid(done ? 'copied' : 'notCopied');
	};

	/** Save a password typed on the page; once saved, the window has done its part. */
	const save = async (saving: Saving): Promise<Wrote | 'failed'> => {
		try {
			const wrote = await saveLogin(db, await age(), saving);
			if (wrote.state === 'written') close();
			return wrote;
		} catch {
			return 'failed';
		}
	};

	/** Put the password typed on the page in place of `match`'s own, which it keeps. */
	const update = async (match: Match): Promise<Wrote | 'failed'> => {
		const identities = copied(lock.keys(match.connectionId));
		if (identities === undefined || typed === undefined) return 'failed';
		try {
			const wrote = await updateLogin(db, await age(), match, typed.password, identities);
			if (wrote.state === 'written') close();
			return wrote;
		} catch {
			return 'failed';
		} finally {
			wipe(identities);
		}
	};

	if (sources === undefined) {
		return (
			<p className="muted" role="status">
				{t('fill.reading')}
			</p>
		);
	}
	if (sources === 'failed') return <p role="alert">{t('fill.failed')}</p>;
	if (!sources.shown) return <NoSources />;

	const { fields } = hello;
	const { matches, busy } = summarize(sources.sources, opening);
	return (
		<>
			<LoginsShown
				sources={sources}
				opening={opening}
				said={said}
				page={site}
				fills={(fields.username || fields.password) && said !== 'pageGone'}
				press={press}
				onFill={(match) => {
					void fill(match);
				}}
				onCopy={(match, field) => {
					void copyField(match, field);
				}}
				onUnlock={(source) => {
					void open(source);
				}}
			>
				{typed !== undefined && !busy && (
					<Remember
						page={site}
						typed={typed}
						offer={offerFor(
							typed,
							matches.map(({ match }) => match),
							site
						)}
						sources={sources.sources}
						press={press}
						onSave={save}
						onUpdate={update}
						onOpenPasswords={openPasswords}
					/>
				)}
			</LoginsShown>
			{asking !== null && (
				<UnlockDialog
					key={asking.source.connectionId}
					connectionId={asking.source.connectionId}
					kind={asking.source.unlock}
					lock={lock}
					{...(sources.sources.length > 1
						? { title: t('fill.unlockSource', { source: asking.source.name }) }
						: {})}
					onUnlocked={() => {
						asking.answer('unlocked');
					}}
					onRecovery={() => {
						asking.answer('recovery');
					}}
					onCancel={() => {
						asking.answer('locked');
					}}
				/>
			)}
		</>
	);
};
