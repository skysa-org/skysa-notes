import { cell, encodeIdentity, RECOVERY_KEY_PREFIX, recoveryKeyGroups } from '@skysa/core';
import { useEffect, useId, useState } from 'react';

import { t } from '../../../i18n/t.js';
import type { SecretsLock } from '../../../secrets/lock.js';
import { DialogActions } from '../../Dialog.js';
import { GroupCells, SIZES, spilled } from '../GroupCells.js';
import { RecoveryQr } from '../RecoveryQr.js';

/**
 * The page's title while the new key is shown: what a PDF saved from its
 * print is named, by Print or the browser's own, rather than after the note
 * open behind the dialog (the owner, 2026-10-15). Set again as a print
 * begins, where the note's title was put back meanwhile — renamed on another
 * device — and given back as the step goes, unless the note's title has
 * already taken its place.
 */
const usePrintTitle = (title: string): void => {
	useEffect(() => {
		const was = cell(document.title);
		document.title = title;
		const printing = () => {
			if (document.title === title) return;
			was.current = document.title;
			document.title = title;
		};
		window.addEventListener('beforeprint', printing);
		return () => {
			window.removeEventListener('beforeprint', printing);
			if (document.title === title) document.title = was.current;
		};
	}, [title]);
};

/** The new key, once, with Print and Copy. */
export const ShowKey = ({
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
	const printedFor = t('secrets.key.printedFor', { source: sourceName });
	usePrintTitle(printedFor);
	const groups = recoveryKeyGroups(identity);
	// The QR code holds the key as age writes it, with no spaces.
	const qr = <RecoveryQr text={encodeIdentity(identity)} />;
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
			{qr}
			<div className="recovery-print" aria-hidden="true">
				<h1>{printedFor}</h1>
				{key}
				{qr}
				<p>{t('secrets.key.printedNote')}</p>
			</div>
			{/* What is done with the key, by it; the row is for going on. */}
			<div className="dialog-tools">
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
				<p className="secrets-said" role="status">
					{said}
				</p>
			</div>
			<DialogActions
				primary={
					<button type="button" className="primary" onClick={onNext}>
						{t('secrets.key.next')}
					</button>
				}
			/>
		</div>
	);
};

/**
 * Two of the new key's groups, typed back: in cells side by side, numbered and
 * drawn as the whole key's are where it is typed, and going on from the first
 * to the second as it fills.
 */
export const CheckKey = ({
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
	const textId = useId();
	const all = recoveryKeyGroups(identity);
	const sizes = groups.map((group) => SIZES[group] ?? 0);
	const [typed, setTyped] = useState<readonly string[]>(['', '']);
	const [wrong, setWrong] = useState<number | undefined>(undefined);
	const check = () => {
		if (busy) return;
		const miss = groups.findIndex((group, at) => typed[at] !== all[group]);
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
			<p id={textId}>
				{t('secrets.check.text', { first: groups[0] + 1, second: groups[1] + 1 })}
			</p>
			<div
				className="recovery-entry"
				role="group"
				aria-label={t('secrets.check.label')}
				aria-describedby={textId}
			>
				<GroupCells
					numbers={groups}
					groups={typed}
					typedIn={(cells, at, value) => spilled(sizes, cells, at, value)}
					onChange={(next) => {
						setTyped(next);
						setWrong(undefined);
					}}
				/>
			</div>
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
						disabled={busy || typed.some((text) => text === '')}
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
