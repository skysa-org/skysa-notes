import { readRecoveryKey, RECOVERY_KEY_PREFIX } from '@skysa/core';
import { useId, useLayoutEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import { DialogActions } from './Dialog.js';
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

/**
 * How many characters each group holds: eleven of five, then three, as the key
 * is shown and printed (`recoveryKeyGroups`).
 */
const SIZES: readonly number[] = [...Array.from({ length: 11 }, () => 5), 3];

const NO_GROUPS: readonly string[] = SIZES.map(() => '');

/** The whole key, after its prefix. */
const KEY_LENGTH = SIZES.reduce((sum, size) => sum + size, 0);

/** The prefix as it reads once spaces and hyphens are taken out. */
const PREFIX_LETTERS = RECOVERY_KEY_PREFIX.replaceAll('-', '');

/** What was typed in a group, as the key spells it: no spaces or hyphens, in capitals. */
const asTyped = (text: string): string => text.replace(/[\s-]+/gu, '').toUpperCase();

/** `text` in the groups from `from` on, as far as it goes; the groups before kept. */
const filledFrom = (groups: readonly string[], from: number, text: string) => {
	// Where in `text` each group from `from` on begins.
	const starts = SIZES.map((_, index) =>
		SIZES.slice(from, index).reduce((sum, size) => sum + size, 0)
	);
	const reached = (index: number) => index >= from && (starts[index] ?? 0) < text.length;
	const next = groups.map((group, index) => {
		const start = starts[index] ?? 0;
		return reached(index) ? text.slice(start, start + (SIZES[index] ?? 0)) : group;
	});
	return { groups: next, last: SIZES.findLastIndex((_, index) => reached(index)) };
};

/**
 * What typing `value` into group `at` makes of the groups, and the group the
 * cursor goes to next. A group that fills goes on to the next, and more than
 * it holds, as a paste is, goes on into those after it. Where the key's prefix
 * is found, pasted or typed, what follows it is the whole key, from the first
 * group: the prefix ends in `1`, which no group can hold, so it is never taken
 * for one. So is a whole key without it, wherever it is pasted.
 */
export const typedIn = (
	groups: readonly string[],
	at: number,
	value: string
): Readonly<{ groups: readonly string[]; focus: number }> => {
	const typed = asTyped(value);
	const sofar = `${groups.slice(0, at).join('')}${typed}`;
	const prefix = sofar.lastIndexOf(PREFIX_LETTERS);
	const whole = prefix === -1 && typed.length >= KEY_LENGTH ? typed : undefined;
	if (prefix !== -1 || whole !== undefined) {
		const key = whole ?? sofar.slice(prefix + PREFIX_LETTERS.length);
		const filled = filledFrom(NO_GROUPS, 0, key);
		const empty = filled.groups.findIndex((group, index) => group.length < (SIZES[index] ?? 0));
		return { groups: filled.groups, focus: empty === -1 ? SIZES.length - 1 : empty };
	}
	if (typed === '') {
		return { groups: groups.map((group, index) => (index === at ? '' : group)), focus: at };
	}
	const filled = filledFrom(groups, at, typed);
	const full = (filled.groups[filled.last]?.length ?? 0) === SIZES[filled.last];
	return {
		groups: filled.groups,
		focus: full ? Math.min(filled.last + 1, SIZES.length - 1) : filled.last,
	};
};

/**
 * A recovery key typed or pasted into its twelve groups, numbered as it is
 * shown and printed, read however it was (`readRecoveryKey`), and checked where
 * it has to be one key in particular: the source's own, in its Secrets dialog,
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
	const fields = useRef<(HTMLInputElement | null)[]>([]);
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
	// The group to go on to, once what was typed is drawn: its own words
	// selected, to be typed over, unless what was typed went on into them.
	const going = useRef<Readonly<{ at: number; over: boolean }> | undefined>(undefined);
	useLayoutEffect(() => {
		const to = going.current;
		going.current = undefined;
		const field = to === undefined ? null : fields.current[to.at];
		if (to === undefined || field === null || field === undefined) return;
		field.focus();
		field.setSelectionRange(to.over ? 0 : field.value.length, field.value.length);
	});
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
				<div className="recovery-cells">
					{groups.map((group, at) => (
						// The groups are the key: their place is what tells them apart.
						<label key={at} className="recovery-cell">
							<span aria-hidden="true">{at + 1}</span>
							<input
								ref={(element) => {
									fields.current[at] = element;
								}}
								className="group-field"
								aria-label={t('secrets.check.group', { number: at + 1 })}
								autoComplete="off"
								autoCapitalize="characters"
								autoCorrect="off"
								spellCheck={false}
								value={group}
								onChange={(event) => {
									const next = typedIn(groups, at, event.target.value);
									if (next.focus !== at) {
										going.current = {
											at: next.focus,
											over: next.groups[next.focus] === groups[next.focus],
										};
									}
									setGroups(next.groups);
									setError(undefined);
								}}
								onKeyDown={(event) => {
									// Back over an empty group, to the end of the one before it.
									if (event.key !== 'Backspace' || group !== '' || at === 0)
										return;
									event.preventDefault();
									const before = fields.current[at - 1];
									before?.focus();
									before?.setSelectionRange(
										before.value.length,
										before.value.length
									);
								}}
							/>
						</label>
					))}
				</div>
			</div>
			{scanning && scanner !== undefined && (
				<ScanKey
					scanner={scanner}
					accept={read}
					onCancel={() => {
						scanned.current = 'cancelled';
						setScanning(false);
					}}
				/>
			)}
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
			>
				{scanner !== undefined && !scanning && (
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
				)}
			</DialogActions>
		</form>
	);
};
