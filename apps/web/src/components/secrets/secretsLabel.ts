import { t } from '../../i18n/t.js';
import type { KeyFileRecord } from '../../store/db.js';

/** What a source's menus call the dialog: setting it up, until it is. */
export const secretsLabel = (record: KeyFileRecord | undefined): string =>
	record === undefined || record.state === 'none'
		? t('secrets.menu.setUp')
		: t('secrets.menu.open');
