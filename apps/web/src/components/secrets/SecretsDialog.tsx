import type { ReactNode } from 'react';

import { t } from '../../i18n/t.js';
import { loadAge } from '../../secrets/loadAge.js';
import { useDb } from '../../store/database.js';
import type { KeyFileRecord } from '../../store/db.js';
import { PBKDF2_ROUNDS } from '../../store/secretKeys.js';
import { setPasswordsShown } from '../../store/vault.js';
import { copyText } from '../clipboard/systemClipboard.js';
import { Dialog, DialogActions } from '../ui/Dialog.js';
import { PasteKey } from './PasteKey.js';
import { Device, Lost, RemoveKey } from './steps/Device.js';
import { Different } from './steps/Different.js';
import { Intro } from './steps/Intro.js';
import { CheckKey, ShowKey } from './steps/NewKey.js';
import { Rekey, RekeyReady } from './steps/Rekey.js';
import type { Enrolled, Home, Purpose, SecretsDialogProps, Step } from './types.js';
import { UnlockForm } from './UnlockDialog.js';
import { ChooseUnlock } from './UnlockEntry.js';
import { useSecretsFlow } from './useSecretsFlow.js';

/**
 * A source's vault (docs/ARCHITECTURE.md §7, "The vault"): setting
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

const PASTE_TEXT: Readonly<Record<Purpose, 'paste' | 'enrol' | 'replaced' | 'another' | 'rekey'>> =
	{
		setup: 'paste',
		enrol: 'enrol',
		replaced: 'replaced',
		another: 'another',
		rekey: 'rekey',
	};

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

export const SecretsDialog = ({
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
	const database = useDb();
	const {
		read,
		step,
		busy,
		doing,
		error,
		record,
		enrolled,
		unlocked,
		passwordsShown,
		deviceLock,
		deviceOffered,
		go,
		scanned,
		keep,
		replaceWith,
		changeTo,
		rekeyScanned,
		rekey,
		make,
		putBack,
		remove,
		typed,
	} = useSecretsFlow({
		connectionId,
		sourceName,
		keyFile,
		lock,
		rounds,
		age,
		givenDeviceLock,
		onClose,
	});

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
						passwords={passwordsShown}
						onPasswords={(shown) => {
							void setPasswordsShown(database, connectionId, shown);
						}}
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
			cancel={!finished}
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
