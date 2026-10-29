import { t } from '../../../i18n/t.js';
import { DialogActions, DialogOption, DialogOptions } from '../../Dialog.js';

/** Secrets already in the source that the key does not open, said before it is used. */
export const Different = ({
	secrets,
	notes,
	onUseThat,
	onAddIt,
	onContinue,
}: {
	secrets: number;
	notes: number;
	onUseThat: () => void;
	onAddIt: () => void;
	onContinue: () => void;
}) => (
	<div className="secrets-step">
		<p role="alert">{t('secrets.different.secrets', { count: secrets })}</p>
		{secrets > 1 && <p>{t('secrets.different.notes', { count: notes })}</p>}
		<DialogOptions>
			<DialogOption onClick={onUseThat}>{t('secrets.different.useThat')}</DialogOption>
			<DialogOption onClick={onAddIt}>{t('secrets.different.addIt')}</DialogOption>
		</DialogOptions>
		<DialogActions
			primary={
				<button type="button" className="primary" onClick={onContinue}>
					{t('secrets.different.continue')}
				</button>
			}
		/>
	</div>
);

/** Not set up: what secrets are, and the two ways to begin. */
export const Intro = ({
	busy,
	onMake,
	onPaste,
}: {
	busy: boolean;
	onMake: () => void;
	onPaste: () => void;
}) => (
	<div className="secrets-step">
		<p>{t('secrets.intro.what')}</p>
		<p>{t('secrets.intro.key')}</p>
		<DialogActions
			primary={
				<button type="button" className="primary" disabled={busy} onClick={onMake}>
					{t('secrets.intro.make')}
				</button>
			}
		>
			<button type="button" disabled={busy} onClick={onPaste}>
				{t('secrets.intro.paste')}
			</button>
		</DialogActions>
	</div>
);
