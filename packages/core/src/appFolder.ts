import { CLIPBOARD_FOLDER, ENCRYPTION_FILE, SCRATCHPAD_FOLDER, VAULT_FOLDER } from './config.js';
import { isWithin, normalizePath } from './paths.js';

/**
 * The app folder's own places, the ones that are not notebooks: which path is
 * the scratchpad's, the vault's, the clipboard's, or the source's key file.
 * Together, so what the app folder holds besides notebooks is listed once.
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
