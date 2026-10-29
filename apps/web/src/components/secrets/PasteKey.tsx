import { readRecoveryKey, RECOVERY_KEY_PREFIX } from '@skysa/core';
import { useId, useLayoutEffect, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import { DialogActions } from '../ui/Dialog.js';
import { asTyped, GroupCells, SIZES, spilled, type Typed } from './GroupCells.js';
import { browserScanner, ScanKey, type Scanner } from './ScanKey.js';

export interface PasteKeyProps {
	/** What is asked for, over the field. */
	text: string;
	/**
	 * Why the key typed is not the one wanted, where it is not; nothing where
	 * it is. It throws where it cannot say.
	 */
	check?: (identity: Uint8Array) => Promise<string | undefined>;
	/** While what the last key was typed for is still under way. */
	busy: boolean;
	onKey: (identity: Uint8Array) => void;
	/** The camera a key's QR code is scanned with: the browser's, where it has one to offer. */
	scanner?: Scanner | undefined;
}

const NO_GROUPS: readonly string[] = SIZES.map(() => '');

/** Each group's place in the key: all twelve, in order. */
const NUMBERS: readonly number[] = SIZES.map((_, at) => at);

/** The whole key, after its prefix. */
const KEY_LENGTH = SIZES.reduce((sum, size) => sum + size, 0);

/** The prefix as it reads once spaces and hyphens are taken out. */
const PREFIX_LETTERS = RECOVERY_KEY_PREFIX.replaceAll('-', '');

/**
 * What typing `value` into group `at` makes of the groups, and the group the
 * cursor goes to next. A group that fills goes on to the next, and more than
 * it holds, as a paste is, goes on into those after it. Where the key's prefix
 * is found, pasted or typed, what follows it is the whole key, from the first
 * group: the prefix ends in `1`, which no group can hold, so it is never taken
 * for one. So is a whole key without it, wherever it is pasted.
 */
export const typedIn = (groups: readonly string[], at: number, value: string): Typed => {
	const typed = asTyped(value);
	const sofar = `${groups.slice(0, at).join('')}${typed}`;
	const prefix = sofar.lastIndexOf(PREFIX_LETTERS);
	const whole = prefix === -1 && typed.length >= KEY_LENGTH ? typed : undefined;
	if (prefix !== -1 || whole !== undefined) {
		const key = whole ?? sofar.slice(prefix + PREFIX_LETTERS.length);
		const filled = spilled(SIZES, NO_GROUPS, 0, key);
		const empty = filled.groups.findIndex((group, index) => group.length < (SIZES[index] ?? 0));
		return { groups: filled.groups, focus: empty === -1 ? SIZES.length - 1 : empty };
	}
	return spilled(SIZES, groups, at, typed);
};

/**
 * A recovery key typed or pasted into its twelve groups, numbered as it is
 * shown and printed, read however it was (`readRecoveryKey`), and checked where
 * it has to be one key in particular: the source's own, in its Vault dialog,
 * or the one a secret was made with, as a note adds it (docs/ARCHITECTURE.md
 * §7, "Secrets in a note"). One that is not is filled with zeros as it is
 * turned away. Or scanned, from the QR code printed and shown beside it
 * (`ScanKey`), which fills the groups as a paste would, for Continue.
 */
export const PasteKey = ({
	text: asked,
	check,
	busy: working,
	onKey,
	scanner: given,
}: PasteKeyProps) => {
	const textId = useId();
	const [groups, setGroups] = useState<readonly string[]>(NO_GROUPS);
	const [scanner] = useState(() => given ?? browserScanner());
	const [scanning, setScanning] = useState(false);
	const scan = useRef<HTMLButtonElement>(null);
	const proceed = useRef<HTMLButtonElement>(null);
	// Where the focus goes once a scan ends: on to Continue with a key read,
	// back to Scan QR code without one.
	const scanned = useRef<'read' | 'cancelled' | undefined>(undefined);
	useLayoutEffect(() => {
		const after = scanned.current;
		scanned.current = undefined;
		if (after === 'read') proceed.current?.focus();
		if (after === 'cancelled') scan.current?.focus();
	});
	/** A code's text taken where it spells a key: in the groups, as a paste puts it. */
	const read = (text: string): boolean => {
		const identity = readRecoveryKey(text);
		if (identity === undefined) return false;
		identity.fill(0);
		setGroups(typedIn(NO_GROUPS, 0, text).groups);
		setError(undefined);
		scanned.current = 'read';
		setScanning(false);
		return true;
	};
	const [error, setError] = useState<string | undefined>(undefined);
	const [checking, setChecking] = useState(false);
	const busy = working || checking;
	const wrongWith = async (identity: Uint8Array): Promise<string | undefined> => {
		if (check === undefined) return undefined;
		setChecking(true);
		try {
			return await check(identity);
		} finally {
			setChecking(false);
		}
	};
	const submit = async () => {
		if (busy) return;
		const identity = readRecoveryKey(`${RECOVERY_KEY_PREFIX}${groups.join('')}`);
		if (identity === undefined) {
			setError(t('secrets.recovery.notKey'));
			return;
		}
		const wrong = await wrongWith(identity).catch(() => t('secrets.failed'));
		if (wrong === undefined) {
			onKey(identity);
			return;
		}
		identity.fill(0);
		setError(wrong);
	};
	return (
		<form
			className="secrets-step"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<p id={textId}>{asked}</p>
			<div
				className="recovery-entry"
				role="group"
				aria-label={t('secrets.recovery.label')}
				aria-describedby={textId}
			>
				<span className="recovery-prefix" aria-hidden="true">
					{RECOVERY_KEY_PREFIX}
				</span>
				<GroupCells
					numbers={NUMBERS}
					groups={groups}
					typedIn={typedIn}
					onChange={(next) => {
						setGroups(next);
						setError(undefined);
					}}
				/>
			</div>
			{scanner !== undefined &&
				(scanning ? (
					<ScanKey
						scanner={scanner}
						accept={read}
						onCancel={() => {
							scanned.current = 'cancelled';
							setScanning(false);
						}}
					/>
				) : (
					// Another way to fill the groups, so beside them: the row is for
					// what is done with them once they are.
					<div className="dialog-tools">
						<button
							ref={scan}
							type="button"
							disabled={busy}
							onClick={() => {
								setError(undefined);
								setScanning(true);
							}}
						>
							{t('secrets.recovery.scan')}
						</button>
					</div>
				))}
			{error !== undefined && (
				<p className="secrets-error" role="alert">
					{error}
				</p>
			)}
			<DialogActions
				primary={
					<button
						ref={proceed}
						type="submit"
						className="primary"
						disabled={busy || groups.every((group) => group === '')}
					>
						{t('secrets.recovery.continue')}
					</button>
				}
			/>
		</form>
	);
};
