import { Plugin } from '@milkdown/kit/prose/state';

import { codeBlockAround } from './codeTools.js';
import { detectLanguage } from './detect.js';
import { isUserTransaction } from './dirty.js';

/**
 * A code block that has no language works out what it is as it is typed into.
 *
 * The picker on an unnamed block reads "Detect language", and this is what
 * makes that a promise rather than a label: paste a query into an empty block
 * and it becomes SQL, type three lines of Python and it becomes Python — at the
 * moment `editor/detect.ts` is confident and not before.
 *
 * Three rules keep it from being a nuisance, and each is a line below:
 *
 * **Only the block being typed in.** The block holding the cursor after the
 * edit, not every unnamed block in the note — otherwise a keystroke in the
 * first paragraph would go off and label a fence further down that the user
 * has not touched.
 *
 * **Only when the user typed it.** A body arriving from sync, a mode switch or
 * the initial load is the app putting text in, and a note nobody edited must
 * come back byte for byte (docs/PLAN.md §7). Detection on a load would rewrite
 * fences in files that were only ever opened.
 *
 * **Only while the block has no language.** A block that names one — because
 * it came that way, because the user picked one, or because this ran a moment
 * ago — is never second-guessed. That also makes this terminate: the guess
 * turns the block into one it no longer applies to.
 *
 * The change is appended to the user's own transaction, so it is part of the
 * edit that prompted it: one undo takes back the language with the text that
 * suggested it, and the dirty rule attributes it to the user, which is right —
 * it is their keystroke that put a word in their file.
 */
export const autoLanguagePlugin = new Plugin({
	appendTransaction: (transactions, _before, state) => {
		if (!transactions.some(isUserTransaction)) return null;

		const here = codeBlockAround(state);
		if (here === null || here.node.attrs.language !== '') return null;

		const language = detectLanguage(here.node.textContent);
		if (language === undefined) return null;

		return state.tr.setNodeMarkup(here.pos, undefined, { ...here.node.attrs, language });
	},
});
