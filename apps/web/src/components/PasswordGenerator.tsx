import {
	generatePassword,
	PASSWORD_LENGTH,
	passwordLength,
	type PasswordOptions,
} from '@skysa/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';

import { t } from '../i18n/t.js';
import { db } from '../store/db.js';
import { GENERATOR_DEFAULT, getGeneratorOptions, setGeneratorOptions } from '../store/vault.js';

/**
 * Generate, under a password being edited (docs/ARCHITECTURE.md §7,
 * "Passwords in the vault"): a new one, made by `generatePassword`, at the
 * length and with or without the symbols last chosen on this device. The
 * length is taken as it is typed and held to 8–64 once it is left, used or
 * entered, so typing "16" does not pass through 8 on the way; a box left
 * empty, or holding what is not a number, leaves it as it was.
 */
export const PasswordGenerator = ({ onMade }: { onMade: (password: string) => void }) => {
	const stored = useLiveQuery(() => getGeneratorOptions(db), []);
	/**
	 * What was chosen here, which goes before the store's: a write is not read
	 * back at once, and a length typed and a box ticked straight after would
	 * otherwise be made with the length from before.
	 */
	const [chosen, setChosen] = useState<PasswordOptions | undefined>(undefined);
	const options = chosen ?? stored ?? GENERATOR_DEFAULT;
	/** The length as it is being typed, until it is left or used. */
	const [typing, setTyping] = useState<string | undefined>(undefined);
	/** A password made, said once it is, as nothing else says so but the field. */
	const [made, setMade] = useState(false);
	const lengthId = useId();
	const length = typing ?? String(options.length);
	// Not before what was chosen last is read, which a choice made first would
	// write over.
	const reading = stored === undefined && chosen === undefined;

	/** The choices as they stand, the length held to what it may be, and kept for next time. */
	const settle = (change: Partial<PasswordOptions> = {}): PasswordOptions => {
		const typed = Number(length);
		const next = {
			length:
				length.trim() === '' || Number.isNaN(typed)
					? options.length
					: passwordLength(typed),
			symbols: options.symbols,
			...change,
		};
		setTyping(undefined);
		setChosen(next);
		void setGeneratorOptions(db, next);
		return next;
	};

	return (
		<div className="password-generator" role="group" aria-label={t('passwords.generate.group')}>
			<button
				type="button"
				disabled={reading}
				onClick={() => {
					onMade(generatePassword(settle()));
					setMade(true);
				}}
			>
				{t('passwords.generate.make')}
			</button>
			<label htmlFor={lengthId}>{t('passwords.generate.length')}</label>
			<input
				id={lengthId}
				type="number"
				inputMode="numeric"
				min={PASSWORD_LENGTH.min}
				max={PASSWORD_LENGTH.max}
				step={1}
				value={length}
				disabled={reading}
				onChange={(event) => {
					setTyping(event.target.value);
				}}
				onBlur={() => {
					settle();
				}}
				// Kept, not Done: the box is in the item's form, which Enter would close.
				onKeyDown={(event) => {
					if (event.key !== 'Enter') return;
					event.preventDefault();
					settle();
				}}
			/>
			<label className="password-generator-symbols">
				<input
					type="checkbox"
					disabled={reading}
					checked={options.symbols}
					onChange={(event) => {
						settle({ symbols: event.target.checked });
					}}
				/>
				{t('passwords.generate.symbols')}
			</label>
			<p className="password-hint" role="status">
				{made ? t('passwords.generate.made') : ''}
			</p>
		</div>
	);
};
