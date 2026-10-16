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
 * Generate, beside a password being edited (docs/ARCHITECTURE.md §7,
 * "Passwords in the vault"): a new one, made by `generatePassword`, at the
 * length and with or without the symbols last chosen on this device. The
 * length is taken as it is typed and held to 8–64 once it is left or used, so
 * typing "16" does not pass through 8 on the way.
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
	const lengthId = useId();
	const length = typing ?? String(options.length);

	/** The choices as they stand, the length held to what it may be, and kept for next time. */
	const settle = (change: Partial<PasswordOptions> = {}): PasswordOptions => {
		const next = {
			length: passwordLength(Number(length)),
			symbols: options.symbols,
			...change,
		};
		setTyping(undefined);
		setChosen(next);
		void setGeneratorOptions(db, next);
		return next;
	};

	return (
		<div className="password-generator">
			<button
				type="button"
				onClick={() => {
					onMade(generatePassword(settle()));
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
				onChange={(event) => {
					setTyping(event.target.value);
				}}
				onBlur={() => {
					settle();
				}}
			/>
			<label className="password-generator-symbols">
				<input
					type="checkbox"
					checked={options.symbols}
					onChange={(event) => {
						settle({ symbols: event.target.checked });
					}}
				/>
				{t('passwords.generate.symbols')}
			</label>
		</div>
	);
};
