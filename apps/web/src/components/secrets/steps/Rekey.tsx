import { t } from '../../../i18n/t.js';
import type { ReplaceScan } from '../../../secrets/age.js';
import { DialogActions } from '../../Dialog.js';

/** Replacing the source's key: what it does, and the two ways to begin. */
export const Rekey = ({
	busy,
	onMake,
	onPaste,
}: {
	busy: boolean;
	onMake: () => void;
	onPaste: () => void;
}) => (
	<div className="secrets-step">
		<h3>{t('secrets.rekey.title')}</h3>
		<p>{t('secrets.rekey.text')}</p>
		<p>{t('secrets.rekey.history')}</p>
		<DialogActions
			primary={
				<button type="button" className="primary" disabled={busy} onClick={onMake}>
					{t('secrets.rekey.make')}
				</button>
			}
		>
			<button type="button" disabled={busy} onClick={onPaste}>
				{t('secrets.rekey.paste')}
			</button>
		</DialogActions>
	</div>
);

/** What replacing the key will do, said before it is done. */
export const RekeyReady = ({
	scan,
	busy,
	onReplace,
}: {
	scan: ReplaceScan;
	busy: boolean;
	onReplace: () => void;
}) => (
	<div className="secrets-step">
		<p>
			{scan.resealing > 0
				? t('secrets.rekey.resealing', { count: scan.resealing })
				: t('secrets.rekey.nothing')}
		</p>
		{scan.others > 0 && <p role="alert">{t('secrets.rekey.others', { count: scan.others })}</p>}
		{scan.others > 1 && <p>{t('secrets.different.notes', { count: scan.otherNotes })}</p>}
		<DialogActions
			primary={
				<button type="button" className="primary" disabled={busy} onClick={onReplace}>
					{t('secrets.rekey.replace')}
				</button>
			}
		/>
	</div>
);
