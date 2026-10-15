import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSuspendShortcuts } from '../commands/context.js';
import { t } from '../i18n/t.js';
import { BROWSER_DEVICE_LOCK, type DeviceLock } from '../secrets/deviceLock.js';
import { type SecretsLock } from '../secrets/lock.js';
import { type NotesDatabase, type UnlockKind } from '../store/db.js';
import {
	enrolment,
	type EnteredKind,
	FREE_TRIES,
	isAcceptedUnlock,
	type Unlock,
	unlockKeys,
	type UnlockResult,
} from '../store/secretKeys.js';
import { ClosingContext, SecretsActions } from './SecretsActions.js';
import { type Entered, NOTHING_ENTERED, UnlockEntry, unlockOf } from './UnlockEntry.js';

/**
 * Unlocking this device's secrets for a source (docs/ARCHITECTURE.md §7,
 * "Secrets in a note"): its pattern, PIN or password, tried against the keys
 * the device holds. A wrong try says so, the last few say how many are left,
 * one too soon after the fifth waits, and the tenth leaves the recovery key.
 * Or the device's own lock, asked when Unlock is pressed, which counts its own
 * tries: where it does not answer, the recovery key is offered beside a try
 * again, since a passkey deleted and one refused look the same from here.
 * Where the unlock was changed in another tab since the form was shown, the
 * form for the new one takes its place, and says so.
 *
 * `UnlockForm` is the asking; `UnlockDialog` asks it over everything, for a
 * secret revealed while the device was locked. The setup dialog asks it within
 * its own steps.
 */

export interface UnlockFormProps {
	database: NotesDatabase;
	connectionId: string;
	kind: UnlockKind;
	lock: SecretsLock;
	onUnlocked: () => void;
	/** The device's copy is gone: only the recovery key is left. */
	onRecovery: () => void;
	now?: () => number;
	/** How the device's own lock is asked, where that is how it unlocks. */
	deviceLock?: DeviceLock;
	/** Buttons of the step the form is in, in its row after Unlock's. */
	extra?: ReactNode;
}

type Gone = 'forgotten' | 'none' | 'changed';

type Said =
	| Readonly<{ kind: 'nothing' }>
	/** The try itself failed: the device's storage, not the unlock. */
	| Readonly<{ kind: 'failed' }>
	| Readonly<{ kind: 'wrong'; left: number }>
	/** The device's own lock did not answer. */
	| Readonly<{ kind: 'unanswered' }>
	| Readonly<{ kind: 'gone'; why: Gone }>;

/** What each way of asking is given beside the form's own props. */
interface Asking {
	/** Shown in place of the form given, as the unlock changed: it says so until a try says more. */
	readonly moved: boolean;
	/** A try found the device unlocks with `kind` now. */
	readonly onOtherWay: (kind: UnlockKind) => void;
}

/** Whether to say the unlock was just changed: until a try says something else. */
const changedNow = (moved: boolean, said: Said): boolean => moved && said.kind === 'nothing';

const ASK: Readonly<Record<EnteredKind, 'pattern' | 'pin' | 'password'>> = {
	pattern: 'pattern',
	pin: 'pin',
	password: 'password',
};

/** The keys gone from the device, or no longer opened by its lock: the recovery key is what is left. */
const GoneForm = ({
	why,
	onRecovery,
	extra,
}: {
	why: Gone;
	onRecovery: () => void;
	extra: ReactNode;
}) => (
	<div className="unlock-form">
		<p role="alert">{t(`secrets.unlock.${why}`)}</p>
		<SecretsActions>
			<button type="button" className="primary" onClick={onRecovery}>
				{t('secrets.unlock.useRecovery')}
			</button>
			{extra}
		</SecretsActions>
	</div>
);

/**
 * What the device's own lock answers, tried against the keys. The prompt is
 * the app's own, so the page hidden behind it does not lock.
 */
const answered = async (
	database: NotesDatabase,
	connectionId: string,
	lock: SecretsLock,
	deviceLock: DeviceLock
): Promise<UnlockResult | 'unanswered'> => {
	const found = await enrolment(database, connectionId);
	if (found === undefined) return { status: 'none' };
	if (found.unlock !== 'device') return { status: 'otherWay', unlock: found.unlock };
	const { device } = found;
	if (device === undefined) return { status: 'changed' };
	const answer = await lock.prompting(() =>
		deviceLock.answer(device.credentialId, new Uint8Array(device.salt))
	);
	if (answer === 'refused') return 'unanswered';
	// A passkey that answers and gives nothing for the salt cannot open the keys.
	if (answer === 'unsupported') return { status: 'changed' };
	try {
		return await unlockKeys(database, connectionId, { kind: 'device', ...device, answer });
	} finally {
		answer.fill(0);
	}
};

const DeviceUnlockForm = ({
	database,
	connectionId,
	lock,
	onUnlocked,
	onRecovery,
	deviceLock,
	moved,
	onOtherWay,
	extra,
}: Omit<UnlockFormProps, 'kind' | 'now' | 'deviceLock'> & Asking & { deviceLock: DeviceLock }) => {
	const askId = useId();
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<Said>({ kind: 'nothing' });

	const attempt = async () => {
		if (busy) return;
		setBusy(true);
		setSaid({ kind: 'nothing' });
		const result = await answered(database, connectionId, lock, deviceLock).catch(
			() => undefined
		);
		setBusy(false);
		if (result === 'unanswered') {
			setSaid({ kind: 'unanswered' });
			return;
		}
		if (result?.status === 'unlocked') {
			lock.hold(result.keys);
			onUnlocked();
			return;
		}
		if (result?.status === 'none' || result?.status === 'changed') {
			setSaid({ kind: 'gone', why: result.status });
			return;
		}
		if (result?.status === 'otherWay') {
			// Another passkey, made in another tab, as well: the next try asks it.
			onOtherWay(result.unlock);
			return;
		}
		setSaid({ kind: 'failed' });
	};

	if (said.kind === 'gone') return <GoneForm why={said.why} onRecovery={onRecovery} extra={extra} />;

	return (
		<form
			className="unlock-form"
			onSubmit={(event) => {
				event.preventDefault();
				void attempt();
			}}
		>
			<p id={askId}>{t('secrets.unlock.device')}</p>
			<div className="secrets-said" role="status">
				{changedNow(moved, said) && <p>{t('secrets.unlock.otherWay')}</p>}
				{said.kind === 'failed' && <p>{t('secrets.failed')}</p>}
				{said.kind === 'unanswered' && <p>{t('secrets.unlock.unanswered')}</p>}
			</div>
			<SecretsActions>
				<button type="submit" className="primary" disabled={busy} aria-describedby={askId}>
					{t('secrets.unlock.unlock')}
				</button>
				{said.kind === 'unanswered' && (
					<button type="button" onClick={onRecovery}>
						{t('secrets.unlock.useRecovery')}
					</button>
				)}
				{extra}
			</SecretsActions>
		</form>
	);
};

/** Whole seconds until `until`, counted down while there are any. */
const useSecondsUntil = (until: number | undefined, now: () => number): number => {
	const [seconds, setSeconds] = useState(0);
	useEffect(() => {
		if (until === undefined) return undefined;
		const tick = () => {
			const left = Math.max(0, Math.ceil((until - now()) / 1000));
			setSeconds(left);
			if (left === 0) clearInterval(timer);
		};
		const timer = setInterval(tick, 250);
		queueMicrotask(tick);
		return () => {
			clearInterval(timer);
		};
	}, [until, now]);
	return until === undefined ? 0 : seconds;
};

export const UnlockForm = ({
	kind,
	now = Date.now,
	deviceLock = BROWSER_DEVICE_LOCK,
	...form
}: UnlockFormProps) => {
	// The unlock a try found the device has now, for as long as `kind` is
	// still what the form was given.
	const [found, setFound] = useState<Readonly<{ given: UnlockKind; to: UnlockKind }>>();
	const moved = found?.given === kind;
	const shown = moved ? found.to : kind;
	const asking: Asking = {
		moved,
		onOtherWay: (to) => {
			setFound({ given: kind, to });
		},
	};
	return shown === 'device' ? (
		<DeviceUnlockForm key={shown} {...form} {...asking} deviceLock={deviceLock} />
	) : (
		<EnteredUnlockForm key={shown} {...form} {...asking} kind={shown} now={now} />
	);
};

const EnteredUnlockForm = ({
	database,
	connectionId,
	kind,
	lock,
	onUnlocked,
	onRecovery,
	now,
	moved,
	onOtherWay,
	extra,
}: Omit<UnlockFormProps, 'kind' | 'now' | 'deviceLock'> &
	Asking & {
		kind: EnteredKind;
		now: () => number;
	}) => {
	const askId = useId();
	const [entered, setEntered] = useState<Entered>(NOTHING_ENTERED);
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<Said>({ kind: 'nothing' });
	const [waitUntil, setWaitUntil] = useState<number | undefined>(undefined);
	const seconds = useSecondsUntil(waitUntil, now);
	const ready = (unlock: Unlock) => isAcceptedUnlock(unlock) && !busy && seconds === 0;

	const attempt = async (unlock: Unlock = unlockOf(kind, entered)) => {
		if (!ready(unlock)) return;
		setBusy(true);
		const result = await unlockKeys(database, connectionId, unlock, now()).catch(
			() => undefined
		);
		setBusy(false);
		setEntered(NOTHING_ENTERED);
		if (result === undefined) {
			setSaid({ kind: 'failed' });
			return;
		}
		if (result.status === 'unlocked') {
			lock.hold(result.keys);
			onUnlocked();
			return;
		}
		if (result.status === 'wait') {
			setWaitUntil(result.until);
			return;
		}
		if (result.status === 'wrong') {
			setSaid({ kind: 'wrong', left: result.triesLeft });
			setWaitUntil(result.waitUntil);
			return;
		}
		if (result.status === 'otherWay') {
			onOtherWay(result.unlock);
			return;
		}
		setSaid({ kind: 'gone', why: result.status });
	};

	if (said.kind === 'gone') return <GoneForm why={said.why} onRecovery={onRecovery} extra={extra} />;

	return (
		<form
			className="unlock-form"
			onSubmit={(event) => {
				event.preventDefault();
				void attempt();
			}}
		>
			<p id={askId}>{t(`secrets.unlock.${ASK[kind]}`)}</p>
			<UnlockEntry
				kind={kind}
				entered={entered}
				onChange={setEntered}
				onDrawn={(drawn) => {
					// Let go of, a pattern is tried, as a phone's lock screen does.
					void attempt(unlockOf(kind, drawn));
				}}
				disabled={busy || seconds > 0}
				describedBy={askId}
			/>
			<div className="secrets-said" role="status">
				{changedNow(moved, said) && <p>{t('secrets.unlock.otherWay')}</p>}
				{said.kind === 'failed' && <p>{t('secrets.failed')}</p>}
				{said.kind === 'wrong' && <p>{t('secrets.unlock.wrong')}</p>}
				{said.kind === 'wrong' && said.left <= FREE_TRIES && (
					<p>{t('secrets.unlock.left', { count: said.left })}</p>
				)}
				{seconds > 0 && <p>{t('secrets.unlock.wait', { count: seconds })}</p>}
			</div>
			<SecretsActions>
				<button type="submit" className="primary" disabled={!ready(unlockOf(kind, entered))}>
					{t('secrets.unlock.unlock')}
				</button>
				{extra}
			</SecretsActions>
		</form>
	);
};

const REACHABLE = 'input, textarea, button:not(:disabled), a[href]';

/**
 * Held as the app's other dialogs are (`ConfirmDialog`): at the end of the
 * page, modal, the shortcuts held, Escape as the way out, the focus given back.
 * Tab goes between what can be used in it, and the first of that has the focus
 * to begin with. Its Cancel or Close is the last of the step's own buttons, in
 * their row (`SecretsActions`), as a confirmation's Cancel is beside its answer.
 */
export const SecretsModal = ({
	title,
	children,
	onClose,
	closeLabel = t('common.cancel'),
	status,
	returnFocus,
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
	closeLabel?: string;
	/** What is under way, said above the step's buttons. */
	status?: string | undefined;
	returnFocus?: RefObject<HTMLElement | null> | undefined;
}) => {
	const titleId = useId();
	const dialog = useRef<HTMLDivElement>(null);
	useSuspendShortcuts();

	useEffect(() => {
		// Read now: what it names is on the page for as long as the dialog is.
		const back = returnFocus?.current ?? document.activeElement;
		const first = dialog.current?.querySelector<HTMLElement>(REACHABLE);
		if (dialog.current?.contains(document.activeElement) !== true) first?.focus();
		return () => {
			if (back instanceof HTMLElement && back.isConnected) back.focus();
		};
		// Mount and unmount only: the focus is taken once and given back once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// On the document, not the dialog: a step that goes takes the focus with
	// it, to the page's body, and the keys must still reach the dialog then.
	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== 'Tab') return;
			const reachable = [...element.querySelectorAll<HTMLElement>(REACHABLE)];
			const at = reachable.indexOf(document.activeElement as HTMLElement);
			const from = at === -1 && event.shiftKey ? 0 : at;
			const next = (from + (event.shiftKey ? -1 : 1) + reachable.length) % reachable.length;
			event.preventDefault();
			reachable[next]?.focus();
		};
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('keydown', onKey);
		};
	}, [onClose]);

	// A step that goes takes the focus with it. The next one's first control
	// has it then, as the first step's did, so it is not left on the page
	// behind the dialog.
	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const observer = new MutationObserver(() => {
			if (element.contains(document.activeElement)) return;
			element.querySelector<HTMLElement>(REACHABLE)?.focus();
		});
		observer.observe(element, { childList: true, subtree: true });
		return () => {
			observer.disconnect();
		};
	}, []);

	return createPortal(
		<div className="modal-backdrop">
			<div
				ref={dialog}
				className="modal secrets-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
			>
				<h2 id={titleId}>{title}</h2>
				{/* Each step ends in its buttons and this way out, in one row (`SecretsActions`). */}
				<ClosingContext.Provider value={{ label: closeLabel, onClose, status }}>
					{children}
				</ClosingContext.Provider>
			</div>
		</div>,
		document.body
	);
};

export interface UnlockDialogProps extends Omit<UnlockFormProps, 'onUnlocked' | 'onRecovery'> {
	onUnlocked: () => void;
	onRecovery: () => void;
	onCancel: () => void;
	returnFocus?: RefObject<HTMLElement | null>;
}

export const UnlockDialog = ({ onCancel, returnFocus, ...form }: UnlockDialogProps) => (
	<SecretsModal title={t('secrets.unlock.title')} onClose={onCancel} returnFocus={returnFocus}>
		<UnlockForm {...form} />
	</SecretsModal>
);
