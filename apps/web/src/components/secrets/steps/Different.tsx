import { t } from '../../../i18n/t.js';
import { DialogActions, DialogOption, DialogOptions } from '../../ui/Dialog.js';

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
