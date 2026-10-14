import { useEffect, useId, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import { type UnlockKind } from '../store/db.js';
import { isAcceptedUnlock, type Unlock } from '../store/secretKeys.js';
import { PatternGrid } from './PatternGrid.js';

/**
 * How this device unlocks secrets, as it is entered (docs/ARCHITECTURE.md §7,
 * "Secrets in a note"): a pattern on a grid of dots, a PIN or a password.
 * `UnlockEntry` takes one; `ChooseUnlock` has one chosen, entered twice.
 */

/** What has been entered so far, of whichever kind. */
export interface Entered {
	readonly dots: readonly number[];
	readonly text: string;
}

export const NOTHING_ENTERED: Entered = { dots: [], text: '' };

export const unlockOf = (kind: UnlockKind, entered: Entered): Unlock => {
	if (kind === 'pattern') return { kind, dots: entered.dots };
	if (kind === 'pin') return { kind, digits: entered.text };
	return { kind, text: entered.text };
};

const sameUnlock = (a: Unlock, b: Unlock): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface UnlockEntryProps {
	kind: UnlockKind;
	entered: Entered;
	onChange: (entered: Entered) => void;
	/** A drawn pattern let go of, which is a pattern entered: as drawn, which may not be rendered yet. */
	onDrawn?: (entered: Entered) => void;
	disabled?: boolean;
	/** Ids of what says what to enter, for the field to be described by. */
	describedBy?: string;
}

/**
 * The field for one kind. The browser is told to keep none of it: a password
 * manager would carry the unlock off the device, and it belongs to this one.
 */
export const UnlockEntry = ({
	kind,
	entered,
	onChange,
	onDrawn,
	disabled = false,
	describedBy,
}: UnlockEntryProps) => {
	const field = useRef<HTMLInputElement>(null);
	// The field is what was asked for, so the typing goes in it (Sidebar's
	// `NewFolderField` says why this is not `autoFocus`).
	useEffect(() => {
		field.current?.focus();
	}, []);
	if (kind === 'pattern') {
		return (
			<div className="unlock-pattern">
				<PatternGrid
					dots={entered.dots}
					disabled={disabled}
					onChange={(dots) => {
						onChange({ ...entered, dots });
					}}
					onDrawn={(dots) => {
						onDrawn?.({ ...entered, dots });
					}}
				/>
				<button
					type="button"
					disabled={disabled || entered.dots.length === 0}
					onClick={() => {
						onChange({ ...entered, dots: [] });
					}}
				>
					{t('secrets.pattern.clear')}
				</button>
			</div>
		);
	}
	return (
		<input
			ref={field}
			className="unlock-field"
			type="password"
			inputMode={kind === 'pin' ? 'numeric' : undefined}
			autoComplete="off"
			autoCapitalize="off"
			autoCorrect="off"
			spellCheck={false}
			data-1p-ignore=""
			data-lpignore="true"
			aria-label={kind === 'pin' ? t('secrets.pinLabel') : t('secrets.passwordLabel')}
			aria-describedby={describedBy}
			disabled={disabled}
			value={entered.text}
			onChange={(event) => {
				onChange({ ...entered, text: event.target.value });
			}}
		/>
	);
};

const ASK: Readonly<Record<UnlockKind, 'drawPattern' | 'typePin' | 'typePassword'>> = {
	pattern: 'drawPattern',
	pin: 'typePin',
	password: 'typePassword',
};

const KINDS: readonly UnlockKind[] = ['pattern', 'pin', 'password'];

export interface ChooseUnlockProps {
	/** The unlock chosen, entered the same way twice. */
	onChosen: (unlock: Unlock) => void;
	busy?: boolean;
	/** What is said where the choosing went wrong after it was made. */
	error?: string;
}

/** Which kind, then the unlock, then the same again. */
export const ChooseUnlock = ({ onChosen, busy = false, error }: ChooseUnlockProps) => {
	const askId = useId();
	const [kind, setKind] = useState<UnlockKind>('pin');
	const [entered, setEntered] = useState<Entered>(NOTHING_ENTERED);
	const [first, setFirst] = useState<Unlock | null>(null);
	const [mismatch, setMismatch] = useState(false);
	const unlock = unlockOf(kind, entered);
	const ready = isAcceptedUnlock(unlock) && !busy;

	const next = () => {
		if (!ready) return;
		if (first === null) {
			setFirst(unlock);
			setEntered(NOTHING_ENTERED);
			setMismatch(false);
			return;
		}
		if (!sameUnlock(first, unlock)) {
			setFirst(null);
			setEntered(NOTHING_ENTERED);
			setMismatch(true);
			return;
		}
		onChosen(unlock);
	};

	return (
		<form
			className="choose-unlock"
			onSubmit={(event) => {
				event.preventDefault();
				next();
			}}
		>
			<div className="unlock-kinds" role="radiogroup" aria-label={t('secrets.choose.title')}>
				{KINDS.map((each) => (
					<button
						key={each}
						type="button"
						role="radio"
						aria-checked={kind === each}
						disabled={busy}
						onClick={() => {
							setKind(each);
							setEntered(NOTHING_ENTERED);
							setFirst(null);
							setMismatch(false);
						}}
					>
						{t(`secrets.choose.${each}`)}
					</button>
				))}
			</div>
			<p id={askId}>
				{first === null ? t(`secrets.choose.${ASK[kind]}`) : t('secrets.choose.again')}
			</p>
			<UnlockEntry
				key={`${kind}-${first === null ? 'first' : 'again'}`}
				kind={kind}
				entered={entered}
				onChange={setEntered}
				disabled={busy}
				describedBy={askId}
			/>
			{mismatch && (
				<p className="secrets-error" role="alert">
					{t('secrets.choose.notSame')}
				</p>
			)}
			{error !== undefined && (
				<p className="secrets-error" role="alert">
					{error}
				</p>
			)}
			<button type="submit" className="primary" disabled={!ready}>
				{first === null ? t('secrets.choose.next') : t('secrets.choose.done')}
			</button>
		</form>
	);
};
