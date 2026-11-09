import { CLIPBOARD_FOLDER, ENCRYPTION_FILE, SCRATCHPAD_FOLDER, VAULT_FOLDER } from './config.js';
import { HIDDEN_PREFIX, isHidden, isWithin, normalizePath, pathSegments } from './paths.js';

/**
 * The app folder's own places, the ones that are not notebooks: which path is
 * the scratchpad's, the vault's, the clipboard's, or the source's key file.
 * Together, so what the app folder holds besides notebooks is listed once.
 * And what the sync engine is handed of them (docs/decisions/0018-the-shared-kit.md):
 * which hidden paths sync (`syncsHidden`), and which a pull is to say it met
 * (`NOTES_WATCH`).
 */

/**
 * The scratchpad's folder, or anything in it: a scratch note, a file beside
 * one. Never a notebook, a notebook's note or anything the tree counts.
 */
export const isScratchPath = (path: string): boolean => isWithin(path, SCRATCHPAD_FOLDER);

/**
 * The vault's passwords' folder, or anything in it: an item. Never a notebook,
 * a notebook's note or anything the tree counts.
 */
export const isVaultPath = (path: string): boolean => isWithin(path, VAULT_FOLDER);

/**
 * Whether a path is the clipboard's: its folder, or anything in it. The folder
 * itself counts, because a folder deleted whole is reported without what was
 * in it.
 */
export const isClipPath = (path: string): boolean => isWithin(path, CLIPBOARD_FOLDER);

/** Whether a path is the source's key file. */
export const isEncryptionFile = (path: string): boolean => normalizePath(path) === ENCRYPTION_FILE;

/**
 * The two dot-named folders at the root whose contents sync as notes: the
 * scratchpad's and the vault's passwords', which the scratchpad and the
 * passwords show and the notebooks do not. Their dot keeps them out of other
 * tools' lists of folders.
 */
const SYNCED_AT_ROOT: readonly string[] = [SCRATCHPAD_FOLDER, VAULT_FOLDER];

/**
 * The hidden paths this app syncs all the same, handed to the sync engine
 * (`SyncEngineOptions.syncsHidden`): either folder above, and anything in it
 * that is not itself dot-named — `.scratchpad/.DS_Store` stays hidden.
 *
 * A change to what this lets through needs every source's cursor dropped
 * once, as the web app's schema versions 10 and 12 do: a cursor moved on while
 * a folder was hidden passed over what was in it.
 */
export const syncsHidden = (path: string): boolean => {
	const [first, ...rest] = pathSegments(path);
	return (
		first !== undefined &&
		SYNCED_AT_ROOT.includes(first) &&
		!rest.some((segment) => segment.startsWith(HIDDEN_PREFIX))
	);
};

/**
 * A path this app neither shows nor syncs: hidden (`isHidden`), and not one
 * it syncs all the same (`syncsHidden`). The marker file, the clipboard, the
 * key file and another tool's bookkeeping.
 */
export const isPassedOver = (path: string): boolean => isHidden(path) && !syncsHidden(path);

/**
 * What a pull is to say it met, by name (`SyncEngineOptions.watch`), since it
 * decides nothing about either: the clipboard's folder, listed again where the
 * clipboard is shown, and the key file, read again where the device keeps
 * secrets (docs/ARCHITECTURE.md §7, "The clipboard", "Secrets in a note").
 */
export const NOTES_WATCH = { clipboard: isClipPath, encryption: isEncryptionFile } as const;
