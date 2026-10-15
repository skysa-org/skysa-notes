import { readRecoveryKey } from '@skysa/core';
import { useId, useState } from 'react';

import { t } from '../i18n/t.js';

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
}

/**
 * A recovery key typed or pasted, read however it was (`readRecoveryKey`),
 * and checked where it has to be one key in particular: the source's own, in
 * its Secrets dialog, or the one a secret was made with, as a note adds it
 * (docs/ARCHITECTURE.md §7, "Secrets in a note"). One that is not is filled
 * with zeros as it is turned away.
 */
export const PasteKey = ({ text: asked, check, busy: working, onKey }: PasteKeyProps) => {
	const textId = useId();
	const [text, setText] = useState('');
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
		const identity = readRecoveryKey(text);
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
			<textarea
				className="recovery-field"
				aria-label={t('secrets.recovery.label')}
				aria-describedby={textId}
				autoComplete="off"
				autoCapitalize="characters"
				autoCorrect="off"
				spellCheck={false}
				rows={3}
				value={text}
				onChange={(event) => {
					setText(event.target.value);
					setError(undefined);
				}}
				onKeyDown={(event) => {
					if (event.key !== 'Enter' || event.shiftKey) return;
					event.preventDefault();
					void submit();
				}}
			/>
			{error !== undefined && (
				<p className="secrets-error" role="alert">
					{error}
				</p>
			)}
			<div className="secrets-buttons">
				<button type="submit" className="primary" disabled={busy || text.trim() === ''}>
					{t('secrets.recovery.continue')}
				</button>
			</div>
		</form>
	);
};
