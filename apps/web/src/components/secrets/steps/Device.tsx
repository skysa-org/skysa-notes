import { useId } from 'react';

import { t } from '../../../i18n/t.js';
import type { UnlockKind } from '../../../store/db.js';
import { DialogActions, DialogOption, DialogOptions } from '../../Dialog.js';

/**
 * Whether this device shows the source's passwords under its notebooks
 * (docs/ARCHITECTURE.md §7, "Passwords in the vault"): a switch, which says
 * what it is and that it is this device's alone. `undefined` until read.
 */
const PasswordsSwitch = ({
	shown,
	onChange,
}: {
	shown: boolean | undefined;
	onChange: (shown: boolean) => void;
}) => {
	const labelId = useId();
	const textId = useId();
	return (
		<div className="dialog-options">
			<button
				type="button"
				role="switch"
				className="dialog-option dialog-switch"
				aria-checked={shown === true}
				aria-labelledby={labelId}
				aria-describedby={textId}
				disabled={shown === undefined}
				onClick={() => {
					onChange(shown !== true);
				}}
			>
				<span className="dialog-switch-words">
					<span id={labelId}>{t('passwords.toggle.label')}</span>
					<span id={textId} className="muted">
						{t('passwords.toggle.text')}
					</span>
				</span>
				<span className="switch-track" aria-hidden="true">
					<span className="switch-thumb" />
				</span>
			</button>
		</div>
	);
};

/** This device, enrolled: how it unlocks, whether it is unlocked now, and what can be done. */
export const Device = ({
	kind,
	unlocked,
	error,
	passwords,
	onUnlock,
	onLock,
	onChange,
	onReplaceKey,
	onRemove,
	onPasswords,
}: {
	kind: UnlockKind;
	unlocked: boolean;
	error: string | undefined;
	passwords: boolean | undefined;
	onUnlock: () => void;
	onLock: () => void;
	onChange: () => void;
	onReplaceKey: () => void;
	onRemove: () => void;
	onPasswords: (shown: boolean) => void;
}) => (
	<div className="secrets-step">
		<p>{t(`secrets.device.unlocksWith.${kind}`)}</p>
		<p role="status">{unlocked ? t('secrets.device.unlocked') : t('secrets.device.locked')}</p>
		{error !== undefined && (
			<p className="secrets-error" role="alert">
				{error}
			</p>
		)}
		<DialogOptions>
			<DialogOption onClick={onChange}>{t('secrets.device.change')}</DialogOption>
			<DialogOption onClick={onReplaceKey}>{t('secrets.device.replaceKey')}</DialogOption>
		</DialogOptions>
		<PasswordsSwitch shown={passwords} onChange={onPasswords} />
		{/* Unlocked, there is nothing it asks: the ✕ has the focus. */}
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
			<button type="button" className="danger" onClick={onRemove}>
				{t('secrets.device.remove')}
			</button>
		</DialogActions>
	</div>
);

/** This device holds a key, and the source's folder names none: written back, or let go of. */
export const Lost = ({
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
export const RemoveKey = ({
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
