import { NOTE_EXTENSION } from '../config.js';

/**
 * Two names are the same name when the provider says they are: case-folded and
 * NFC-normalized, because Drive, Dropbox and macOS all treat them that way.
 *
 * The one place that answers this question, exported so that it stays the one
 * place. Every check that asks whether a name is taken guards a renamer that
 * asks the same thing, and the two have to agree: where they disagree it is
 * always the check that fails open, handing back the very name it was asked to
 * avoid — one file on the provider, under two names nothing here can tell
 * apart. Four separate bugs of that shape came from two copies of this
 * drifting.
 *
 * Both folds, not just case. `slugify` normalizes what it produces, so a taken
 * set folded by case alone misses a name that arrived as NFD.
 */
export const foldName = (name: string): string => name.normalize('NFC').toLowerCase();

/**
 * Whether a name or path is a note's: its extension folded as `foldName` folds,
 * so `Report.MD` from a Windows tool is one. The engine, the providers and the
 * app all ask this, and must answer it the same way.
 */
export const isNoteName = (name: string): boolean => foldName(name).endsWith(NOTE_EXTENSION);
