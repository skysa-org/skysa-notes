import {
	encodeIdentity,
	readRecoveryKey,
	RECOVERY_KEY_PREFIX,
	recoveryKeyGroups,
} from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';

import { t } from '../i18n/t.js';
import { type Age, loadAge } from '../secrets/loadAge.js';
import { type SecretsLock } from '../secrets/lock.js';
import { type KeyFileRecord, type NotesDatabase, type UnlockKind } from '../store/db.js';
import {
	changeUnlock,
	enrol,
	enrolment,
	forgetKeys,
	PBKDF2_ROUNDS,
	replaceKeys,
	type Unlock,
} from '../store/secretKeys.js';
import { type KeyFileSync } from '../sync/keyFile.js';
import { SecretsModal, UnlockForm } from './UnlockDialog.js';
import { ChooseUnlock } from './UnlockEntry.js';

/**
 * Secrets for a source (docs/ARCHITECTURE.md §7, "Secrets in a note"): setting
 * it up, with a new recovery key or one the user has; enrolling this device
 * with the key; and, once it is, unlocking it, changing how it unlocks, and
 * letting go of its copy.
 *
 * Where it starts is what the source's key file and this device's keys say,
 * read again as it opens: not set up, set up by a newer build, something else
 * at the key file's name, set up and this device not enrolled (or enrolled
 * with a key since replaced), or enrolled. A flow begun from there is its own
 * until it ends.
 *
 * What needs the curve is loaded as the first step that needs it is taken.
 */

export interface SecretsDialogProps {
	database: NotesDatabase;
	connectionId: string;
	/** What the source is called, printed above its key. */
	sourceName: string;
	keyFile: Pick<KeyFileSync, 'refresh' | 'write'>;
	lock: SecretsLock;
	onClose: () => void;
	returnFocus?: RefObject<HTMLElement | null>;
	/** PBKDF2's rounds; fewer in a test, where the full count takes most of a second. */
	rounds?: number;
	age?: () => Promise<Age>;
	/** Which two groups of a new key are asked back, counted from 0. */
	pickGroups?: () => readonly [number, number];
	print?: () => Promise<void>;
	copy?: (text: string) => Promise<void>;
}

type Enrolled = NonNullable<Awaited<ReturnType<typeof enrolment>>>;

/** Why a recovery key is being typed. */
type Purpose = 'setup' | 'enrol' | 'replaced' | 'another';

type Step =
	| Readonly<{ kind: 'show'; identity: Uint8Array }>
	| Readonly<{ kind: 'check'; identity: Uint8Array; groups: readonly [number, number] }>
	| Readonly<{ kind: 'paste'; purpose: Purpose; base?: readonly Uint8Array[] }>
	| Readonly<{
			kind: 'different';
			identities: readonly Uint8Array[];
			secrets: number;
			notes: number;
	  }>
	/** Choosing how this device unlocks, then keeping the keys: `setUp` writes the key file first. */
	| Readonly<{ kind: 'choose'; identities: readonly Uint8Array[]; then: 'setUp' | 'enrol' }>
	| Readonly<{ kind: 'unlock'; then: 'device' | 'change' }>
	/** The source's new key typed, and the device locked: unlocked, to keep what it holds beside it. */
	| Readonly<{ kind: 'unlock'; then: 'replace'; identity: Uint8Array }>
	| Readonly<{ kind: 'change' }>
	| Readonly<{ kind: 'remove' }>
	| Readonly<{ kind: 'done'; said: string }>;

const GROUPS = 12;

const randomGroups = (): readonly [number, number] => {
	const [a = 0, b = 1] = crypto.getRandomValues(new Uint32Array(2));
	const first = a % GROUPS;
	const second = (first + 1 + (b % (GROUPS - 1))) % GROUPS;
	return first < second ? [first, second] : [second, first];
};

/** Print the page, as long as the browser's own dialog is up for it. */
const printPage = (): Promise<void> =>
	new Promise((resolve) => {
		const done = () => {
			window.removeEventListener('afterprint', done);
			clearTimeout(timer);
			resolve();
		};
		// Not every browser says when its dialog has gone.
		const timer = setTimeout(done, 60_000);
		window.addEventListener('afterprint', done);
		window.print();
	});

const copyText = (text: string): Promise<void> => navigator.clipboard.writeText(text);

/** A group as typed back: in either case, spaces and hyphens no matter. */
const asGroup = (text: string): string => text.replace(/[\s-]+/gu, '').toUpperCase();

/** The new key, once, with Print and Copy. */
const ShowKey = ({
	identity,
	sourceName,
	onNext,
	print,
	copy,
	lock,
}: {
	identity: Uint8Array;
	sourceName: string;
	onNext: () => void;
	print: () => Promise<void>;
	copy: (text: string) => Promise<void>;
	lock: SecretsLock;
}) => {
	const [said, setSaid] = useState<string | undefined>(undefined);
	const groups = recoveryKeyGroups(identity);
	const key = (
		<div className="recovery-key" role="group" aria-label={t('secrets.key.label')}>
			<span className="recovery-prefix">{RECOVERY_KEY_PREFIX}</span>
			<ol className="recovery-groups">
				{groups.map((group, at) => (
					// The groups are the key: their place is what tells them apart.
					<li key={at}>{group}</li>
				))}
			</ol>
		</div>
	);
	return (
		<div className="secrets-step">
			<h3>{t('secrets.key.title')}</h3>
			<p>{t('secrets.key.text')}</p>
			{key}
			<div className="recovery-print" aria-hidden="true">
				<h1>{t('secrets.key.printedFor', { source: sourceName })}</h1>
				{key}
				<p>{t('secrets.key.printedNote')}</p>
			</div>
			<div className="secrets-buttons">
				<button
					type="button"
					onClick={() => {
						void lock.prompting(print);
					}}
				>
					{t('secrets.key.print')}
				</button>
				<button
					type="button"
					onClick={() => {
						copy(encodeIdentity(identity)).then(
							() => {
								setSaid(t('secrets.key.copied'));
							},
							() => {
								setSaid(t('secrets.key.notCopied'));
							}
						);
					}}
				>
					{t('secrets.key.copy')}
				</button>
				<button type="button" className="primary" onClick={onNext}>
					{t('secrets.key.next')}
				</button>
			</div>
			<p className="secrets-said" role="status">
				{said}
			</p>
		</div>
	);
};

/** Two of the new key's groups, typed back. */
const CheckKey = ({
	identity,
	groups,
	busy,
	onBack,
	onChecked,
}: {
	identity: Uint8Array;
	groups: readonly [number, number];
	busy: boolean;
	onBack: () => void;
	onChecked: () => void;
}) => {
	const all = recoveryKeyGroups(identity);
	const [typed, setTyped] = useState<readonly [string, string]>(['', '']);
	const [wrong, setWrong] = useState<number | undefined>(undefined);
	const check = () => {
		if (busy) return;
		const miss = groups.findIndex((group, at) => asGroup(typed[at] ?? '') !== all[group]);
		if (miss === -1) {
			onChecked();
			return;
		}
		setWrong(groups[miss]);
	};
	return (
		<form
			className="secrets-step"
			onSubmit={(event) => {
				event.preventDefault();
				check();
			}}
		>
			<p>{t('secrets.check.text')}</p>
			{groups.map((group, at) => (
				<label key={group} className="secrets-field">
					<span>{t('secrets.check.group', { number: group + 1 })}</span>
					<input
						className="group-field"
						autoComplete="off"
						autoCapitalize="characters"
						autoCorrect="off"
						spellCheck={false}
						maxLength={8}
						value={typed[at]}
						onChange={(event) => {
							const value = event.target.value;
							setTyped(at === 0 ? [value, typed[1]] : [typed[0], value]);
							setWrong(undefined);
						}}
					/>
				</label>
			))}
			{wrong !== undefined && (
				<p className="secrets-error" role="alert">
					{t('secrets.check.wrong', { number: wrong + 1 })}
				</p>
			)}
			<div className="secrets-buttons">
				<button type="button" onClick={onBack}>
					{t('secrets.check.back')}
				</button>
				<button
					type="submit"
					className="primary"
					disabled={busy || typed.some((text) => asGroup(text) === '')}
				>
					{t('secrets.check.check')}
				</button>
			</div>
		</form>
	);
};

const PASTE_TEXT: Readonly<Record<Purpose, 'paste' | 'enrol' | 'replaced' | 'another'>> = {
	setup: 'paste',
	enrol: 'enrol',
	replaced: 'replaced',
	another: 'another',
};

/** A recovery key typed or pasted, read however it was, and checked where it has to be the source's. */
const PasteKey = ({
	purpose,
	recipient,
	age,
	busy: working,
	onKey,
}: {
	purpose: Purpose;
	/** The source's, where the key has to be its. */
	recipient: string | undefined;
	age: () => Promise<Age>;
	/** While what the last key was typed for is still under way. */
	busy: boolean;
	onKey: (identity: Uint8Array) => void;
}) => {
	const textId = useId();
	const [text, setText] = useState('');
	const [error, setError] = useState<string | undefined>(undefined);
	const [checking, setChecking] = useState(false);
	const busy = working || checking;
	/** Whose key it is, where that matters: the source's own, or not. */
	const isTheSources = async (identity: Uint8Array): Promise<boolean> => {
		if (recipient === undefined) return true;
		setChecking(true);
		try {
			const { recipientOf } = await age();
			return recipientOf(identity) === recipient;
		} finally {
			setChecking(false);
		}
	};
	const submit = async () => {
		if (busy) return;
		const identity = readRecoveryKey(text);
		if (identity === undefined) {
			setError(t('secrets.recovery.notKey'));
			return;
		}
		const its = await isTheSources(identity).catch(() => undefined);
		if (its === true) {
			onKey(identity);
			return;
		}
		identity.fill(0);
		setError(its === false ? t('secrets.recovery.notThis') : t('secrets.failed'));
	};
	return (
		<form
			className="secrets-step"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<p id={textId}>{t(`secrets.recovery.${PASTE_TEXT[purpose]}`)}</p>
			<textarea
				className="recovery-field"
				aria-label={t('secrets.recovery.label')}
				aria-describedby={textId}
				autoComplete="off"
				autoCapitalize="characters"
				autoCorrect="off"
				spellCheck={false}
				rows={3}
				value={text}
				onChange={(event) => {
					setText(event.target.value);
					setError(undefined);
				}}
				onKeyDown={(event) => {
					if (event.key !== 'Enter' || event.shiftKey) return;
					event.preventDefault();
					void submit();
				}}
			/>
			{error !== undefined && (
				<p className="secrets-error" role="alert">
					{error}
				</p>
			)}
			<div className="secrets-buttons">
				<button type="submit" className="primary" disabled={busy || text.trim() === ''}>
					{t('secrets.recovery.continue')}
				</button>
			</div>
		</form>
	);
};

/** Secrets already in the source that the key does not open, said before it is used. */
const Different = ({
	secrets,
	notes,
	onUseThat,
	onAddIt,
	onContinue,
}: {
	secrets: number;
	notes: number;
	onUseThat: () => void;
	onAddIt: () => void;
	onContinue: () => void;
}) => (
	<div className="secrets-step">
		<p role="alert">{t('secrets.different.secrets', { count: secrets })}</p>
		{secrets > 1 && <p>{t('secrets.different.notes', { count: notes })}</p>}
		<div className="secrets-buttons">
			<button type="button" onClick={onUseThat}>
				{t('secrets.different.useThat')}
			</button>
			<button type="button" onClick={onAddIt}>
				{t('secrets.different.addIt')}
			</button>
			<button type="button" className="primary" onClick={onContinue}>
				{t('secrets.different.continue')}
			</button>
		</div>
	</div>
);

/** Not set up: what secrets are, and the two ways to begin. */
const Intro = ({
	busy,
	onMake,
	onPaste,
}: {
	busy: boolean;
	onMake: () => void;
	onPaste: () => void;
}) => (
	<div className="secrets-step">
		<p>{t('secrets.intro.what')}</p>
		<p>{t('secrets.intro.key')}</p>
		<div className="secrets-buttons">
			<button type="button" className="primary" disabled={busy} onClick={onMake}>
				{t('secrets.intro.make')}
			</button>
			<button type="button" disabled={busy} onClick={onPaste}>
				{t('secrets.intro.paste')}
			</button>
		</div>
	</div>
);

/** This device, enrolled: how it unlocks, whether it is unlocked now, and what can be done. */
const Device = ({
	kind,
	unlocked,
	error,
	onUnlock,
	onLock,
	onChange,
	onRemove,
}: {
	kind: UnlockKind;
	unlocked: boolean;
	error: string | undefined;
	onUnlock: () => void;
	onLock: () => void;
	onChange: () => void;
	onRemove: () => void;
}) => (
	<div className="secrets-step">
		<p>{t(`secrets.device.unlocksWith.${kind}`)}</p>
		<p role="status">{unlocked ? t('secrets.device.unlocked') : t('secrets.device.locked')}</p>
		{error !== undefined && (
			<p className="secrets-error" role="alert">
				{error}
			</p>
		)}
		<div className="secrets-buttons">
			{unlocked ? (
				<button type="button" onClick={onLock}>
					{t('secrets.device.lockNow')}
				</button>
			) : (
				<button type="button" className="primary" onClick={onUnlock}>
					{t('secrets.device.unlock')}
				</button>
			)}
			<button type="button" onClick={onChange}>
				{t('secrets.device.change')}
			</button>
			<button type="button" className="danger" onClick={onRemove}>
				{t('secrets.device.remove')}
			</button>
		</div>
	</div>
);

/** This device holds a key, and the source's folder names none: written back, or let go of. */
const Lost = ({
	busy,
	onPutBack,
	onRemove,
}: {
	busy: boolean;
	onPutBack: () => void;
	onRemove: () => void;
}) => (
	<div className="secrets-step">
		<p>{t('secrets.lost.text')}</p>
		<div className="secrets-buttons">
			<button type="button" className="primary" disabled={busy} onClick={onPutBack}>
				{t('secrets.lost.putBack')}
			</button>
			<button type="button" className="danger" disabled={busy} onClick={onRemove}>
				{t('secrets.device.remove')}
			</button>
		</div>
	</div>
);

/** Letting go of this device's copy of the keys, asked first. */
const RemoveKey = ({
	busy,
	onRemove,
	onCancel,
}: {
	busy: boolean;
	onRemove: () => void;
	onCancel: () => void;
}) => (
	<div className="secrets-step">
		<h3>{t('secrets.device.removeTitle')}</h3>
		<p>{t('secrets.device.removeText')}</p>
		<div className="secrets-buttons">
			<button type="button" className="danger" disabled={busy} onClick={onRemove}>
				{t('secrets.device.removeConfirm')}
			</button>
			<button type="button" onClick={onCancel}>
				{t('common.cancel')}
			</button>
		</div>
	</div>
);

/** What a source's menus call the dialog: setting it up, until it is. */
export const secretsLabel = (record: KeyFileRecord | undefined): string =>
	record === undefined || record.state === 'none'
		? t('secrets.menu.setUp')
		: t('secrets.menu.open');

/** Where the dialog is when no flow is under way, as a step or a state to say. */
type Home = Step | 'checking' | 'unavailable' | 'intro' | 'newer' | 'invalid' | 'device' | 'lost';

const homeOf = (
	record: KeyFileRecord | undefined,
	read: boolean,
	enrolled: Enrolled | null | undefined
): Home => {
	if (record === undefined) return read ? 'unavailable' : 'checking';
	if (record.state === 'newer' || record.state === 'invalid') return record.state;
	if (enrolled === undefined) return 'checking';
	// The folder names no key, and this device holds one: setting up again
	// would put another in its place, and leave what it opens locked.
	if (record.state === 'none') return enrolled === null ? 'intro' : 'lost';
	if (enrolled === null) return { kind: 'paste', purpose: 'enrol' };
	if (enrolled.recipient !== record.recipient) return { kind: 'paste', purpose: 'replaced' };
	return 'device';
};

/** What is only said, with nothing to do but close. */
const SAID: Readonly<Record<'checking' | 'unavailable' | 'newer' | 'invalid', () => ReactNode>> = {
	checking: () => <p role="status">{t('secrets.checking')}</p>,
	unavailable: () => <p>{t('secrets.unavailable')}</p>,
	newer: () => <p>{t('secrets.newer')}</p>,
	invalid: () => <p>{t('secrets.invalid')}</p>,
};

/** Keys filled with zeros, and let go of. */
const wipe = (identities: Set<Uint8Array>) => {
	identities.forEach((identity) => identity.fill(0));
	identities.clear();
};

const sameIdentity = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);

export const SecretsDialog = ({
	database,
	connectionId,
	sourceName,
	keyFile,
	lock,
	onClose,
	returnFocus,
	rounds = PBKDF2_ROUNDS,
	age = loadAge,
	pickGroups = randomGroups,
	print = printPage,
	copy = copyText,
}: SecretsDialogProps) => {
	const [read, setRead] = useState(false);
	const [step, setStep] = useState<Step | null>(null);
	const [busy, setBusy] = useState(false);
	/** What is under way, said while it is; nothing where that is quick. */
	const [doing, setDoing] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const record = useLiveQuery(
		() => database.keyFiles.get(connectionId),
		[database, connectionId]
	);
	const enrolled = useLiveQuery(
		() => enrolment(database, connectionId).then((found) => found ?? null),
		[database, connectionId]
	);
	const unlocked = useSyncExternalStore(lock.subscribe, () => lock.isUnlocked(connectionId));

	/**
	 * The keys this dialog made or read from what was typed: filled with zeros
	 * once they are kept, sealed, on the device, and as it closes. Its own
	 * copies only; the lock's are the lock's to wipe.
	 */
	const owned = useRef(new Set<Uint8Array>());
	const own = (identity: Uint8Array): Uint8Array => {
		owned.current.add(identity);
		return identity;
	};
	const wipeOwned = () => {
		wipe(owned.current);
	};
	useEffect(() => {
		const identities = owned.current;
		return () => {
			wipe(identities);
		};
	}, []);

	useEffect(() => {
		// What the folder says now, which another device may have changed.
		void keyFile.refresh(connectionId).finally(() => {
			setRead(true);
		});
	}, [keyFile, connectionId]);

	const go = (next: Step | null) => {
		setError(undefined);
		setStep(next);
	};

	/**
	 * `work`, with the dialog busy until it ends, however it ends: one that
	 * fails says so, rather than leaving every button disabled and nothing said.
	 */
	const run = async (work: () => Promise<void>, saying?: string) => {
		setBusy(true);
		setDoing(saying);
		try {
			await work();
		} catch {
			setError(t('secrets.failed'));
		} finally {
			setBusy(false);
			setDoing(undefined);
		}
	};

	/** The secrets `identities` would leave locked, said where there are any; and on, where not. */
	const scanned = (identities: readonly Uint8Array[]) =>
		run(async () => {
			const { scanSecrets } = await age();
			const scan = await scanSecrets(database, connectionId, identities);
			go(
				scan.others > 0
					? {
							kind: 'different',
							identities,
							secrets: scan.others,
							notes: scan.otherNotes,
						}
					: { kind: 'choose', identities, then: 'setUp' }
			);
		}, t('secrets.scanning'));

	/**
	 * Whether the key file names `recipient` now: written here, or already. A
	 * write refused because another device wrote first goes back to where
	 * the dialog starts, which is decided by what the folder says now.
	 */
	const setUp = async (recipient: string): Promise<boolean> => {
		const written = await keyFile.write(connectionId, recipient);
		if (written.status === 'written') return true;
		if (written.status === 'changed') {
			// Written by this dialog on a try that failed after it.
			const now = await database.keyFiles.get(connectionId);
			if (now?.state === 'ok' && now.recipient === recipient) return true;
			go(null);
			setError(t('secrets.written.changed'));
			return false;
		}
		setError(
			written.status === 'unavailable'
				? t('secrets.unavailable')
				: t('secrets.written.failed')
		);
		return false;
	};

	/** The device's keys kept under `unlock`, the key file written first where the source is being set up. */
	const keep = (identities: readonly Uint8Array[], then: 'setUp' | 'enrol', unlock: Unlock) =>
		run(async () => {
			const [first] = identities;
			if (first === undefined) return;
			const { recipientOf } = await age();
			const recipient = recipientOf(first);
			if (then === 'setUp' && !(await setUp(recipient))) return;
			const keys = await enrol(database, {
				connectionId,
				recipient,
				identities,
				unlock,
				rounds,
			});
			// The source was let go of meanwhile.
			if (keys === undefined) {
				onClose();
				return;
			}
			wipeOwned();
			lock.hold(keys);
			go({
				kind: 'done',
				said: then === 'setUp' ? t('secrets.done.setUp') : t('secrets.done.enrolled'),
			});
		}, t('secrets.written.saving'));

	/**
	 * The source's new key kept with the keys this device holds, under the
	 * unlock it has: unlocked first where it is locked.
	 */
	const replaceWith = (identity: Uint8Array) =>
		run(async () => {
			const { recipientOf } = await age();
			// Read after that wait, and handed on with none: `replaceKeys`
			// copies them before its own, and the lock can wipe them at either.
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				go({ kind: 'unlock', then: 'replace', identity });
				return;
			}
			const held = keys.identities.filter((each) => !sameIdentity(each, identity));
			const replaced = await replaceKeys(database, keys, recipientOf(identity), [
				identity,
				...held,
			]);
			if (replaced === undefined) {
				lock.lock(connectionId);
				go(null);
				setError(t('secrets.device.changedElsewhere'));
				return;
			}
			wipeOwned();
			lock.hold(replaced);
			go({ kind: 'done', said: t('secrets.done.replaced') });
		});

	const changeTo = (unlock: Unlock) =>
		run(async () => {
			const keys = lock.keys(connectionId);
			// Locked meanwhile: unlocked again, and asked again.
			if (keys === undefined) {
				go({ kind: 'unlock', then: 'change' });
				return;
			}
			const changed = await changeUnlock(database, keys, unlock, rounds);
			if (changed === undefined) {
				lock.lock(connectionId);
				go(null);
				setError(t('secrets.device.changedElsewhere'));
				return;
			}
			lock.hold(changed);
			go({ kind: 'done', said: t('secrets.done.changed') });
		}, t('secrets.written.saving'));

	const make = () =>
		run(async () => {
			const { generateIdentity } = await age();
			go({ kind: 'show', identity: own(generateIdentity()) });
		});

	const putBack = (recipient: string) =>
		run(async () => {
			if (await setUp(recipient)) go({ kind: 'done', said: t('secrets.lost.done') });
		});

	const remove = () =>
		run(async () => {
			lock.lock(connectionId);
			await forgetKeys(database, connectionId);
			go(null);
		});

	/** A recovery key typed, taken on by what it was typed for. */
	const typed = (at: Extract<Step, { kind: 'paste' }>, identity: Uint8Array) => {
		own(identity);
		if (at.purpose === 'setup') {
			void scanned([identity]);
			return;
		}
		// The keys this device holds are kept beside the new one: unlocked
		// first, where it is locked.
		if (at.purpose === 'replaced' && enrolled !== null && enrolled !== undefined) {
			void replaceWith(identity);
			return;
		}
		if (at.purpose !== 'another') {
			go({ kind: 'choose', identities: [identity], then: 'enrol' });
			return;
		}
		const base = at.base ?? [];
		const known = base.some((held) => sameIdentity(held, identity));
		go({ kind: 'choose', identities: known ? base : [...base, identity], then: 'setUp' });
	};

	const recipient = record?.state === 'ok' ? record.recipient : undefined;
	const kind = enrolled?.unlock ?? 'pin';

	const unlockStep = (at: Extract<Step, { kind: 'unlock' }>): ReactNode => {
		const form = (
			<UnlockForm
				database={database}
				connectionId={connectionId}
				kind={kind}
				lock={lock}
				onUnlocked={() => {
					if (at.then === 'replace') {
						void replaceWith(at.identity);
						return;
					}
					go(at.then === 'change' ? { kind: 'change' } : null);
				}}
				onRecovery={() => {
					// The device's copy is gone: the new key is all there is to keep.
					go(
						at.then === 'replace'
							? { kind: 'choose', identities: [at.identity], then: 'enrol' }
							: { kind: 'paste', purpose: 'enrol' }
					);
				}}
			/>
		);
		if (at.then !== 'replace') return form;
		return (
			<div className="secrets-step">
				<p>{t('secrets.replace.text')}</p>
				{form}
				<div className="secrets-buttons">
					<button
						type="button"
						onClick={() => {
							go({ kind: 'choose', identities: [at.identity], then: 'enrol' });
						}}
					>
						{t('secrets.replace.skip')}
					</button>
				</div>
			</div>
		);
	};

	const homeBody = (at: Exclude<Home, Step>): ReactNode => {
		switch (at) {
			case 'intro':
				return (
					<Intro
						busy={busy}
						onMake={() => {
							void make();
						}}
						onPaste={() => {
							go({ kind: 'paste', purpose: 'setup' });
						}}
					/>
				);
			case 'lost':
				return (
					<Lost
						busy={busy}
						onPutBack={() => {
							if (enrolled !== null && enrolled !== undefined) {
								void putBack(enrolled.recipient);
							}
						}}
						onRemove={() => {
							go({ kind: 'remove' });
						}}
					/>
				);
			case 'device':
				return (
					<Device
						kind={kind}
						unlocked={unlocked}
						error={error}
						onUnlock={() => {
							go({ kind: 'unlock', then: 'device' });
						}}
						onLock={() => {
							lock.lock(connectionId);
						}}
						onChange={() => {
							go(unlocked ? { kind: 'change' } : { kind: 'unlock', then: 'change' });
						}}
						onRemove={() => {
							go({ kind: 'remove' });
						}}
					/>
				);
			default:
				return SAID[at]();
		}
	};

	const bodyOf = (at: Home): ReactNode => {
		if (typeof at === 'string') return homeBody(at);
		switch (at.kind) {
			case 'show':
				return (
					<ShowKey
						identity={at.identity}
						sourceName={sourceName}
						print={print}
						copy={copy}
						lock={lock}
						onNext={() => {
							go({ kind: 'check', identity: at.identity, groups: pickGroups() });
						}}
					/>
				);
			case 'check':
				return (
					<CheckKey
						identity={at.identity}
						groups={at.groups}
						busy={busy}
						onBack={() => {
							go({ kind: 'show', identity: at.identity });
						}}
						onChecked={() => {
							void scanned([at.identity]);
						}}
					/>
				);
			case 'paste': {
				const checked = at.purpose === 'enrol' || at.purpose === 'replaced';
				// A key typed as the source's is checked against the key file;
				// where the file names none now, what it does say is shown.
				if (checked && recipient === undefined)
					return bodyOf(homeOf(record, read, enrolled));
				return (
					<PasteKey
						key={at.purpose}
						purpose={at.purpose}
						recipient={checked ? recipient : undefined}
						age={age}
						busy={busy}
						onKey={(identity) => {
							typed(at, identity);
						}}
					/>
				);
			}
			case 'different':
				return (
					<Different
						secrets={at.secrets}
						notes={at.notes}
						onUseThat={() => {
							go({ kind: 'paste', purpose: 'setup' });
						}}
						onAddIt={() => {
							go({ kind: 'paste', purpose: 'another', base: at.identities });
						}}
						onContinue={() => {
							go({ kind: 'choose', identities: at.identities, then: 'setUp' });
						}}
					/>
				);
			case 'choose':
			case 'change':
				return (
					<div className="secrets-step">
						<h3>{t('secrets.choose.title')}</h3>
						<p>{t('secrets.choose.text')}</p>
						<ChooseUnlock
							busy={busy}
							error={error}
							onChosen={(unlock) => {
								void (at.kind === 'change'
									? changeTo(unlock)
									: keep(at.identities, at.then, unlock));
							}}
						/>
					</div>
				);
			case 'unlock':
				return unlockStep(at);
			case 'remove':
				return (
					<RemoveKey
						busy={busy}
						onRemove={() => {
							void remove();
						}}
						onCancel={() => {
							go(null);
						}}
					/>
				);
			case 'done':
				return <p role="status">{at.said}</p>;
		}
	};

	const at = step ?? homeOf(record, read, enrolled);
	// Where nothing is under way, there is nothing to cancel.
	const finished = typeof at === 'string' || at.kind === 'done' || at.kind === 'remove';
	// The device's step and choosing an unlock say what went wrong in their own place.
	const saysOwnError =
		at === 'device' ||
		(typeof at !== 'string' && (at.kind === 'choose' || at.kind === 'change'));

	return (
		<SecretsModal
			title={t('secrets.title')}
			onClose={onClose}
			closeLabel={finished ? t('common.close') : t('common.cancel')}
			returnFocus={returnFocus}
		>
			{error !== undefined && !saysOwnError && (
				<p className="secrets-error" role="alert">
					{error}
				</p>
			)}
			{bodyOf(at)}
			{doing !== undefined && (
				<p className="secrets-said" role="status">
					{doing}
				</p>
			)}
		</SecretsModal>
	);
};
