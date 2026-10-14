import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSuspendShortcuts } from '../commands/context.js';
import { t } from '../i18n/t.js';
import { type SecretsLock } from '../secrets/lock.js';
import { type NotesDatabase, type UnlockKind } from '../store/db.js';
import { FREE_TRIES, isAcceptedUnlock, type Unlock, unlockKeys } from '../store/secretKeys.js';
import { type Entered, NOTHING_ENTERED, UnlockEntry, unlockOf } from './UnlockEntry.js';

/**
 * Unlocking this device's secrets for a source (docs/ARCHITECTURE.md §7,
 * "Secrets in a note"): its pattern, PIN or password, tried against the keys
 * the device holds. A wrong try says so, the last few say how many are left,
 * one too soon after the fifth waits, and the tenth leaves the recovery key.
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
}

type Said =
	| Readonly<{ kind: 'nothing' }>
	| Readonly<{ kind: 'wrong'; left: number }>
	| Readonly<{ kind: 'gone'; why: 'forgotten' | 'none' }>;

const ASK: Readonly<Record<UnlockKind, 'pattern' | 'pin' | 'password'>> = {
	pattern: 'pattern',
	pin: 'pin',
	password: 'password',
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
	database,
	connectionId,
	kind,
	lock,
	onUnlocked,
	onRecovery,
	now = Date.now,
}: UnlockFormProps) => {
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
		const result = await unlockKeys(database, connectionId, unlock, now());
		setBusy(false);
		setEntered(NOTHING_ENTERED);
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
		setSaid({ kind: 'gone', why: result.status });
	};

	if (said.kind === 'gone') {
		return (
			<div className="unlock-form">
				<p role="alert">
					{said.why === 'forgotten'
						? t('secrets.unlock.forgotten')
						: t('secrets.unlock.none')}
				</p>
				<button type="button" className="primary" onClick={onRecovery}>
					{t('secrets.unlock.useRecovery')}
				</button>
			</div>
		);
	}

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
				{said.kind === 'wrong' && <p>{t('secrets.unlock.wrong')}</p>}
				{said.kind === 'wrong' && said.left <= FREE_TRIES && (
					<p>{t('secrets.unlock.left', { count: said.left })}</p>
				)}
				{seconds > 0 && <p>{t('secrets.unlock.wait', { count: seconds })}</p>}
			</div>
			<button type="submit" className="primary" disabled={!ready(unlockOf(kind, entered))}>
				{t('secrets.unlock.unlock')}
			</button>
		</form>
	);
};

const REACHABLE = 'input, textarea, button:not(:disabled), a[href]';

/**
 * Held as the app's other dialogs are (`ConfirmDialog`): at the end of the
 * page, modal, the shortcuts held, Escape as the way out, the focus given back.
 * Tab goes between what can be used in it, and the first of that has the focus
 * to begin with.
 */
export const SecretsModal = ({
	title,
	children,
	onClose,
	closeLabel = t('common.cancel'),
	returnFocus,
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
	closeLabel?: string;
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

	useEffect(() => {
		const element = dialog.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
				return;
			}
			if (event.key !== 'Tab') return;
			const reachable = [...element.querySelectorAll<HTMLElement>(REACHABLE)];
			const at = reachable.indexOf(document.activeElement as HTMLElement);
			const next = (at + (event.shiftKey ? -1 : 1) + reachable.length) % reachable.length;
			event.preventDefault();
			reachable[next]?.focus();
		};
		element.addEventListener('keydown', onKey);
		return () => {
			element.removeEventListener('keydown', onKey);
		};
	}, [onClose]);

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
				{children}
				<div className="modal-actions">
					<button type="button" onClick={onClose}>
						{closeLabel}
					</button>
				</div>
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
