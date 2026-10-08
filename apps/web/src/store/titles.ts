import { UNTITLED_TITLE } from '@skysa/core';

import { t } from '../i18n/t.js';

/**
 * A note's title as it is shown. One with nothing to take a name from is
 * `UNTITLED_TITLE` wherever the app keeps it, and `untitled.md` in the user's
 * folder, in every language, so that it can be told from a name the user gave;
 * only what is on screen says it in theirs (docs/ARCHITECTURE.md §7, "The
 * app's words").
 */
export const titleShown = (title: string): string =>
	title === UNTITLED_TITLE ? t('notes.untitled') : title;
