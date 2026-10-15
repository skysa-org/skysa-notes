import { RECOVERY_KEY_PREFIX, recoveryKeyGroups } from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';

import { t } from '../i18n/t.js';
import { type ReplaceScan } from '../secrets/age.js';
import { BROWSER_DEVICE_LOCK, type DeviceLock, setUpDeviceLock } from '../secrets/deviceLock.js';
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
	type UnlockedKeys,
} from '../store/secretKeys.js';
import { type KeyFileSync } from '../sync/keyFile.js';
import { Dialog, DialogActions } from './Dialog.js';
import { PasteKey } from './PasteKey.js';
import { UnlockForm } from './UnlockDialog.js';
import { ChooseUnlock, type Chosen } from './UnlockEntry.js';

/**
 * Secrets for a source (docs/ARCHITECTURE.md §7, "Secrets in a note"): setting
 * it up, with a new recovery key or one the user has; enrolling this device
 * with the key; and, once it is, unlocking it, changing how it unlocks,
 * replacing the source's key, and letting go of its copy.
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
	/** The device's own lock, offered where it can keep a key (`secrets/deviceLock.ts`). */
	deviceLock?: DeviceLock;
}

type Enrolled = NonNullable<Awaited<ReturnType<typeof enrolment>>>;

/** Why a recovery key is being typed. */
type Purpose = 'setup' | 'enrol' | 'replaced' | 'another' | 'rekey';

/** What a new key is made for: setting the source up, or replacing its key. */
type Making = 'setUp' | 'rekey';

type Step =
	| Readonly<{ kind: 'show'; identity: Uint8Array; making: Making }>
	| Readonly<{
			kind: 'check';
			identity: Uint8Array;
			groups: readonly [number, number];
			making: Making;
	  }>
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
	/** Replacing the source's key, and the device locked: unlocked, to begin, or to go on with the key chosen. */
	| Readonly<{ kind: 'unlock'; then: 'rekey'; identity?: Uint8Array }>
	| Readonly<{ kind: 'change' }>
	/** Replacing the source's key: what it does, and the two ways to begin. */
	| Readonly<{ kind: 'rekey' }>
	/** The new key chosen, and what replacing the key with it will do, said before it is done. */
	| Readonly<{ kind: 'rekeyReady'; identity: Uint8Array; scan: ReplaceScan }>
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

/**
 * The device's own lock, and whether it is offered: asked as the dialog
 * opens, and not offered again once making a passkey found it cannot keep a
 * key in this browser.
 */
const useDeviceLock = (given: DeviceLock | undefined) => {
	const deviceLock = given ?? BROWSER_DEVICE_LOCK;
	const [deviceOffered, setDeviceOffered] = useState(false);
	useEffect(() => {
		const open = { current: true };
		void deviceLock.offered().then((offered) => {
			if (open.current) setDeviceOffered(offered);
		});
		return () => {
			open.current = false;
		};
	}, [deviceLock]);
	return { deviceLock, deviceOffered, setDeviceOffered };
};

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
			<p className="secrets-said" role="status">
				{said}
			</p>
			<DialogActions
				primary={
					<button type="button" className="primary" onClick={onNext}>
						{t('secrets.key.next')}
					</button>
				}
			>
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
						// In its groups, as it is shown and printed: the app reads it
						// back with or without the spaces.
						copy([RECOVERY_KEY_PREFIX, ...groups].join(' ')).then(
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
			</DialogActions>
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
			<DialogActions
				primary={
					<button
						type="submit"
						className="primary"
						disabled={busy || typed.some((text) => asGroup(text) === '')}
					>
						{t('secrets.check.check')}
					</button>
				}
			>
				<button type="button" onClick={onBack}>
					{t('secrets.check.back')}
				</button>
			</DialogActions>
		</form>
	);
};

const PASTE_TEXT: Readonly<Record<Purpose, 'paste' | 'enrol' | 'replaced' | 'another' | 'rekey'>> =
	{
		setup: 'paste',
		enrol: 'enrol',
		replaced: 'replaced',
		another: 'another',
		rekey: 'rekey',
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
		<DialogActions
			primary={
				<button type="button" className="primary" onClick={onContinue}>
					{t('secrets.different.continue')}
				</button>
			}
		>
			<button type="button" onClick={onUseThat}>
				{t('secrets.different.useThat')}
			</button>
			<button type="button" onClick={onAddIt}>
				{t('secrets.different.addIt')}
			</button>
		</DialogActions>
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
		<DialogActions
			primary={
				<button type="button" className="primary" disabled={busy} onClick={onMake}>
					{t('secrets.intro.make')}
				</button>
			}
		>
			<button type="button" disabled={busy} onClick={onPaste}>
				{t('secrets.intro.paste')}
			</button>
		</DialogActions>
	</div>
);

/** Replacing the source's key: what it does, and the two ways to begin. */
const Rekey = ({
	busy,
	onMake,
	onPaste,
}: {
	busy: boolean;
	onMake: () => void;
	onPaste: () => void;
}) => (
	<div className="secrets-step">
		<h3>{t('secrets.rekey.title')}</h3>
		<p>{t('secrets.rekey.text')}</p>
		<p>{t('secrets.rekey.history')}</p>
		<DialogActions
			primary={
				<button type="button" className="primary" disabled={busy} onClick={onMake}>
					{t('secrets.rekey.make')}
				</button>
			}
		>
			<button type="button" disabled={busy} onClick={onPaste}>
				{t('secrets.rekey.paste')}
			</button>
		</DialogActions>
	</div>
);

/** What replacing the key will do, said before it is done. */
const RekeyReady = ({
	scan,
	busy,
	onReplace,
}: {
	scan: ReplaceScan;
	busy: boolean;
	onReplace: () => void;
}) => (
	<div className="secrets-step">
		<p>
			{scan.resealing > 0
				? t('secrets.rekey.resealing', { count: scan.resealing })
				: t('secrets.rekey.nothing')}
		</p>
		{scan.others > 0 && <p role="alert">{t('secrets.rekey.others', { count: scan.others })}</p>}
		{scan.others > 1 && <p>{t('secrets.different.notes', { count: scan.otherNotes })}</p>}
		<DialogActions
			primary={
				<button type="button" className="primary" disabled={busy} onClick={onReplace}>
					{t('secrets.rekey.replace')}
				</button>
			}
		/>
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
	onReplaceKey,
	onRemove,
}: {
	kind: UnlockKind;
	unlocked: boolean;
	error: string | undefined;
	onUnlock: () => void;
	onLock: () => void;
	onChange: () => void;
	onReplaceKey: () => void;
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
		{/* Unlocked, there is nothing it asks: Close has the focus. */}
		<DialogActions
			primary={
				unlocked ? undefined : (
					<button type="button" className="primary" onClick={onUnlock}>
						{t('secrets.device.unlock')}
					</button>
				)
			}
		>
			{unlocked && (
				<button type="button" onClick={onLock}>
					{t('secrets.device.lockNow')}
				</button>
			)}
			<button type="button" onClick={onChange}>
				{t('secrets.device.change')}
			</button>
			<button type="button" onClick={onReplaceKey}>
				{t('secrets.device.replaceKey')}
			</button>
			<button type="button" className="danger" onClick={onRemove}>
				{t('secrets.device.remove')}
			</button>
		</DialogActions>
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
		<DialogActions
			primary={
				<button type="button" className="primary" disabled={busy} onClick={onPutBack}>
					{t('secrets.lost.putBack')}
				</button>
			}
		>
			<button type="button" className="danger" disabled={busy} onClick={onRemove}>
				{t('secrets.device.remove')}
			</button>
		</DialogActions>
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
		{/* Its Cancel goes back to the device's step; Escape still closes the dialog. */}
		<DialogActions
			close={false}
			primary={
				<button type="button" className="danger" disabled={busy} onClick={onRemove}>
					{t('secrets.device.removeConfirm')}
				</button>
			}
		>
			<button type="button" onClick={onCancel}>
				{t('common.cancel')}
			</button>
		</DialogActions>
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
	deviceLock: givenDeviceLock,
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

	const { deviceLock, deviceOffered, setDeviceOffered } = useDeviceLock(givenDeviceLock);

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
	 * Whether the key file names `recipient` now: written here, where it named
	 * none, or `over`, the source's key being replaced; or already. A write
	 * refused because another device wrote first goes back to where the
	 * dialog starts, which is decided by what the folder says now.
	 */
	const setUp = async (recipient: string, over?: string): Promise<boolean> => {
		const written = await (over === undefined
			? keyFile.write(connectionId, recipient)
			: keyFile.write(connectionId, recipient, over));
		if (written.status === 'written') return true;
		if (written.status === 'changed') {
			// Written by this dialog on a try that failed after it.
			const now = await database.keyFiles.get(connectionId);
			if (now?.state === 'ok' && now.recipient === recipient) return true;
			go(null);
			setError(
				over === undefined ? t('secrets.written.changed') : t('secrets.rekey.changed')
			);
			return false;
		}
		if (written.status === 'unavailable') setError(t('secrets.unavailable'));
		else setError(over === undefined ? t('secrets.written.failed') : t('secrets.rekey.failed'));
		return false;
	};

	/**
	 * What `chosen` unlocks with: as it was entered, or the device's own lock,
	 * its passkey made and checked now (`setUpDeviceLock`). Nothing where that
	 * could not be, which is said; a device whose lock cannot keep a key in
	 * this browser is not offered it again.
	 */
	const unlockFor = async (chosen: Chosen): Promise<Unlock | undefined> => {
		if (chosen.kind !== 'device') return chosen;
		const name = t('secrets.device.passkeyName', { source: sourceName });
		// The device's prompt is the app's own: the page hidden behind it does not lock.
		const set = await lock.prompting(() => setUpDeviceLock(deviceLock, name));
		if (set.state === 'set') return set.unlock;
		if (set.state === 'unsupported') setDeviceOffered(false);
		setError(
			set.state === 'unsupported'
				? t('secrets.choose.deviceUnsupported')
				: t('secrets.choose.deviceRefused')
		);
		return undefined;
	};

	/** The passkey this device unlocks with now, where it unlocks with one. */
	const passkeyNow = async () => (await enrolment(database, connectionId))?.device?.credentialId;

	/**
	 * A passkey no unlock is sealed under any more, let go of
	 * (`DeviceLock.forget`): one left in a password manager looks like one
	 * that still unlocks.
	 */
	const forgetPasskey = (credentialId: ArrayBuffer | undefined) => {
		if (credentialId !== undefined) void deviceLock.forget(credentialId);
	};

	/**
	 * What `keeping` the keys under `unlock` comes to. What the device's lock
	 * answered is let go of however it ends, and its passkey too where the
	 * keys were not kept under it.
	 */
	const settled = async (
		unlock: Unlock,
		keeping: () => Promise<UnlockedKeys | undefined>
	): Promise<UnlockedKeys | undefined> => {
		const keys = await keeping().catch((error: unknown) => {
			letGo(unlock, false);
			throw error;
		});
		letGo(unlock, keys !== undefined);
		return keys;
	};

	const letGo = (unlock: Unlock, kept: boolean) => {
		if (unlock.kind !== 'device') return;
		unlock.answer.fill(0);
		if (!kept) forgetPasskey(unlock.credentialId);
	};

	/**
	 * The device's keys kept under `unlock`, the key file written first where
	 * the source is being set up, and the passkey of the unlock they replace
	 * let go of. Nothing where they were not kept: that is said, or, where the
	 * source was let go of meanwhile, the dialog closes.
	 */
	const keptUnder = async (
		identities: readonly Uint8Array[],
		first: Uint8Array,
		then: 'setUp' | 'enrol',
		unlock: Unlock
	): Promise<UnlockedKeys | undefined> => {
		const { recipientOf } = await age();
		const recipient = recipientOf(first);
		if (then === 'setUp' && !(await setUp(recipient))) return undefined;
		const before = await passkeyNow();
		const keys = await enrol(database, { connectionId, recipient, identities, unlock, rounds });
		if (keys === undefined) onClose();
		else forgetPasskey(before);
		return keys;
	};

	/** The device's keys kept under the unlock chosen (`keptUnder`). */
	const keep = (identities: readonly Uint8Array[], then: 'setUp' | 'enrol', chosen: Chosen) =>
		run(async () => {
			const [first] = identities;
			if (first === undefined) return;
			const unlock = await unlockFor(chosen);
			if (unlock === undefined) return;
			const keys = await settled(unlock, () => keptUnder(identities, first, then, unlock));
			if (keys === undefined) return;
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

	const changeTo = (chosen: Chosen) =>
		run(async () => {
			// Locked meanwhile: unlocked again, and asked again.
			if (!lock.isUnlocked(connectionId)) {
				go({ kind: 'unlock', then: 'change' });
				return;
			}
			const unlock = await unlockFor(chosen);
			if (unlock === undefined) return;
			const before = await passkeyNow().catch((error: unknown) => {
				letGo(unlock, false);
				throw error;
			});
			// Read after the device's lock was asked, and handed on with none
			// between: `changeUnlock` copies them before its own.
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				letGo(unlock, false);
				go({ kind: 'unlock', then: 'change' });
				return;
			}
			const changed = await settled(unlock, () =>
				changeUnlock(database, keys, unlock, rounds)
			);
			if (changed !== undefined) forgetPasskey(before);
			if (changed === undefined) {
				lock.lock(connectionId);
				go(null);
				setError(t('secrets.device.changedElsewhere'));
				return;
			}
			lock.hold(changed);
			go({ kind: 'done', said: t('secrets.done.changed') });
		}, t('secrets.written.saving'));

	/** The recipients of the keys the source has had, which this device holds: the ones replacing the key encrypts afresh. */
	const sourceRecipients = (keys: UnlockedKeys): readonly string[] => [
		keys.recipient,
		...(enrolled?.former ?? []),
	];

	/** What replacing the source's key with `identity` would do, said before it is done. */
	const rekeyScanned = (identity: Uint8Array) =>
		run(async () => {
			const { keysFor, scanReplacing } = await age();
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				go({ kind: 'unlock', then: 'rekey', identity });
				return;
			}
			// Copies, taken as they are read: the lock wipes its own as the page hides.
			const old = keysFor(keys.identities, sourceRecipients(keys)).map((each) =>
				Uint8Array.from(each)
			);
			try {
				const scan = await scanReplacing(database, connectionId, [identity], old);
				go({ kind: 'rekeyReady', identity, scan });
			} finally {
				old.forEach((each) => each.fill(0));
			}
		}, t('secrets.scanning'));

	/**
	 * The source's key replaced by `identity` (docs/ARCHITECTURE.md §7,
	 * "Replacing the key"). The key file first, written over the recipient
	 * this device has, so a replacement made on another device meanwhile
	 * refuses this one before anything changes; from then on, new secrets
	 * everywhere are made with the new key. Then the device's keys, the new
	 * one first and the ones it held kept beside it. Then every secret the
	 * source's old keys open, encrypted to the new one. Where that stops
	 * short, the device locked or a write failed, the rest still opens here
	 * and is encrypted afresh on a later unlock.
	 */
	const rekey = (identity: Uint8Array) =>
		run(async () => {
			const { recipientOf, keysFor, resealSecrets } = await age();
			const before = lock.keys(connectionId);
			if (before === undefined) {
				go({ kind: 'unlock', then: 'rekey', identity });
				return;
			}
			const old = sourceRecipients(before);
			const recipient = recipientOf(identity);
			if (!(await setUp(recipient, before.recipient))) return;
			// Read after that wait, and handed on with none: `replaceKeys`
			// copies them before its own, and the lock can wipe them at either.
			const keys = lock.keys(connectionId);
			if (keys === undefined) {
				go({ kind: 'unlock', then: 'rekey', identity });
				return;
			}
			const held = keys.identities.filter((each) => !sameIdentity(each, identity));
			const replaced = await replaceKeys(database, keys, recipient, [identity, ...held]);
			if (replaced === undefined) {
				lock.lock(connectionId);
				go(null);
				setError(t('secrets.device.changedElsewhere'));
				return;
			}
			// Copies to encrypt with, taken before anything is awaited.
			const [fresh = new Uint8Array(), ...kept] = replaced.identities.map((each) =>
				Uint8Array.from(each)
			);
			const former = keysFor(kept, old);
			lock.hold(replaced);
			wipeOwned();
			setDoing(t('secrets.rekey.encrypting'));
			const resealed = await resealSecrets(database, connectionId, {
				fresh: [fresh],
				recipient,
				old: former,
				going: () => lock.isUnlocked(connectionId),
			})
				.catch(() => undefined)
				.finally(() => {
					[fresh, ...kept].forEach((each) => each.fill(0));
				});
			const said = (() => {
				if (resealed === undefined || resealed.stopped)
					return t('secrets.done.rekeyedPart');
				if (resealed.secrets === 0) return t('secrets.done.rekeyedNone');
				return t('secrets.done.rekeyed', { count: resealed.secrets });
			})();
			go({ kind: 'done', said });
		}, t('secrets.written.saving'));

	const make = (making: Making) =>
		run(async () => {
			const { generateIdentity } = await age();
			go({ kind: 'show', identity: own(generateIdentity()), making });
		});

	const putBack = (recipient: string) =>
		run(async () => {
			if (await setUp(recipient)) go({ kind: 'done', said: t('secrets.lost.done') });
		});

	const remove = () =>
		run(async () => {
			lock.lock(connectionId);
			const before = await passkeyNow();
			await forgetKeys(database, connectionId);
			forgetPasskey(before);
			go(null);
		});

	/** A recovery key typed, taken on by what it was typed for. */
	const typed = (at: Extract<Step, { kind: 'paste' }>, identity: Uint8Array) => {
		own(identity);
		if (at.purpose === 'setup') {
			void scanned([identity]);
			return;
		}
		if (at.purpose === 'rekey') {
			void rekeyScanned(identity);
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

	/** Why a key typed as the source's is not `recipient`'s, where it is not. */
	const keyOf =
		(of: string) =>
		async (identity: Uint8Array): Promise<string | undefined> => {
			const { recipientOf } = await age();
			return recipientOf(identity) === of ? undefined : t('secrets.recovery.notThis');
		};

	/** Why a key typed to replace the source's, `of`, is refused: it is that one. */
	const otherThan =
		(of: string) =>
		async (identity: Uint8Array): Promise<string | undefined> => {
			const { recipientOf } = await age();
			return recipientOf(identity) === of ? t('secrets.rekey.same') : undefined;
		};

	const unlockStep = (at: Extract<Step, { kind: 'unlock' }>): ReactNode => {
		const skip =
			at.then === 'replace' ? (
				<button
					type="button"
					onClick={() => {
						go({ kind: 'choose', identities: [at.identity], then: 'enrol' });
					}}
				>
					{t('secrets.replace.skip')}
				</button>
			) : undefined;
		const form = (
			<UnlockForm
				extra={skip}
				database={database}
				connectionId={connectionId}
				kind={kind}
				lock={lock}
				deviceLock={deviceLock}
				onUnlocked={() => {
					if (at.then === 'replace') {
						void replaceWith(at.identity);
						return;
					}
					if (at.then === 'rekey') {
						if (at.identity === undefined) go({ kind: 'rekey' });
						else void rekeyScanned(at.identity);
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
							void make('setUp');
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
						onReplaceKey={() => {
							go(unlocked ? { kind: 'rekey' } : { kind: 'unlock', then: 'rekey' });
						}}
						onRemove={() => {
							go({ kind: 'remove' });
						}}
					/>
				);
			default:
				return (
					<>
						{SAID[at]()}
						<DialogActions />
					</>
				);
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
							go({
								kind: 'check',
								identity: at.identity,
								groups: pickGroups(),
								making: at.making,
							});
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
							go({ kind: 'show', identity: at.identity, making: at.making });
						}}
						onChecked={() => {
							void (at.making === 'rekey'
								? rekeyScanned(at.identity)
								: scanned([at.identity]));
						}}
					/>
				);
			case 'paste': {
				const checked = at.purpose === 'enrol' || at.purpose === 'replaced';
				// A key typed as the source's, or to replace it, is checked
				// against the key file; where the file names none now, what it
				// does say is shown.
				if ((checked || at.purpose === 'rekey') && recipient === undefined)
					return bodyOf(homeOf(record, read, enrolled));
				const check = (() => {
					if (recipient === undefined) return undefined;
					if (at.purpose === 'rekey') return otherThan(recipient);
					return checked ? keyOf(recipient) : undefined;
				})();
				return (
					<PasteKey
						key={at.purpose}
						text={t(`secrets.recovery.${PASTE_TEXT[at.purpose]}`)}
						{...(check === undefined ? {} : { check })}
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
							device={deviceOffered}
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
			case 'rekey':
				return (
					<Rekey
						busy={busy}
						onMake={() => {
							void make('rekey');
						}}
						onPaste={() => {
							go({ kind: 'paste', purpose: 'rekey' });
						}}
					/>
				);
			case 'rekeyReady':
				return (
					<RekeyReady
						scan={at.scan}
						busy={busy}
						onReplace={() => {
							void rekey(at.identity);
						}}
					/>
				);
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
				return (
					<>
						<p role="status">{at.said}</p>
						<DialogActions />
					</>
				);
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
		<Dialog
			title={t('secrets.title')}
			className="secrets-dialog"
			onClose={onClose}
			closeLabel={finished ? t('common.close') : t('common.cancel')}
			status={doing}
			returnFocus={returnFocus}
		>
			{error !== undefined && !saysOwnError && (
				<p className="secrets-error" role="alert">
					{error}
				</p>
			)}
			{bodyOf(at)}
		</Dialog>
	);
};
