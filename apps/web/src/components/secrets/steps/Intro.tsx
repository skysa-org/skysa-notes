import { t } from '../../../i18n/t.js';
import { DialogActions } from '../../Dialog.js';

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
