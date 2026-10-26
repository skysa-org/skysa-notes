import type { Node, Parent } from 'mdast';

import { dearmor, looksArmored, mentionsArmor } from '../age/armor.js';
import { firstLineEnding, toLf, withLineEnding } from './lineEndings.js';
import { parse } from './pipeline.js';

/**
 * Secrets in a note (docs/ARCHITECTURE.md §3, "Secrets", and §7): a fenced block
 * whose info string is `age` and whose text is an armored age file. After `age`
 * the fence may say what the secret is, in the user's words and in plain text
 * (`secretLabel`), and nothing else: everything about how the file was made is
 * in its own header.
 */

/** The info string of a fence that holds a secret. */
export const SECRET_LANGUAGE = 'age';

/**
 * The age file a fenced block holds, if the block is a secret: `age`, and armor
 * that reads. A fence that says `age` and holds anything else is code.
 */
export const secretFile = (
	language: string | null | undefined,
	text: string
): Uint8Array | undefined => {
	if (language !== SECRET_LANGUAGE) return undefined;
	try {
		return dearmor(text);
	} catch {
		return undefined;
	}
};

/** Whether a fenced block is a secret. */
export const isSecretBlock = (language: string | null | undefined, text: string): boolean =>
	secretFile(language, text) !== undefined;

/**
 * Whether a fenced block is kept out of what is shown or indexed of a note's
 * words: `age`, and opening as armor, whether the armor reads or not. Every
 * secret is one (`isSecretBlock`), and so is armor cut short, by a list row's
 * length or by damage, since what is left of it is ciphertext still. Search
 * (`withoutArmor`) and previews (`previewBlocks`) both ask this, so that a
 * card never shows what search has left out, nor the other way round.
 */
export const hidesAsSecret = (language: string | null | undefined, text: string): boolean =>
	language === SECRET_LANGUAGE && looksArmored(text);

/**
 * What a secret's fence calls it, from the rest of its info string after `age`
 * (a fence's `meta`): shown where the secret is closed in place of the app's
 * own word for one. Plain text, read by anyone who can read the note.
 */
export const secretLabel = (meta: string | null | undefined): string | undefined => {
	const label = meta?.trim() ?? '';
	return label === '' ? undefined : label;
};

/** The text of every secret in a note's body, in order, at any depth. */
export const secretBlocksIn = (body: string): string[] => {
	const inside = (node: Node): string[] => {
		if (node.type === 'code') {
			const { lang, value } = node as Node & { lang?: string | null; value: string };
			return isSecretBlock(lang, value) ? [value] : [];
		}
		const { children } = node as Partial<Parent>;
		return children === undefined ? [] : children.flatMap(inside);
	};
	return inside(parse(body));
};

/** Where a secret is written in a body, and the label it is to be indexed by. */
interface Written {
	readonly from: number;
	readonly to: number;
	readonly label: string;
}

/**
 * `body` with each secret in it as its label, or as nothing where it has none:
 * a note's words, for its search index (docs/ARCHITECTURE.md §7, "Secrets in a
 * note"). The armor's base64 is no word of the note's, and indexed, a short
 * query would find the note by a run of letters that happened to be in it; nor
 * is the `age` its fence opens with. An `age` fence that opens as armor and
 * does not read is taken out too, as a preview takes it (`previewBlocks`): it
 * is ciphertext still.
 *
 * A body with no armor in it is handed back as it is, unread: that is nearly
 * every note, and reading one as markdown is most of what indexing it would
 * cost (#275). Its lines end in `\n` where it has a secret.
 */
export const withoutArmor = (body: string): string => {
	if (!mentionsArmor(body)) return body;
	const inside = (node: Node): Written[] => {
		if (node.type === 'code') {
			const { lang, meta, value, position } = node as Node & {
				lang?: string | null;
				meta?: string | null;
				value: string;
			};
			const from = position?.start.offset;
			const to = position?.end.offset;
			if (!hidesAsSecret(lang, value)) return [];
			if (from === undefined || to === undefined) return [];
			return [{ from, to, label: secretLabel(meta) ?? '' }];
		}
		const { children } = node as Partial<Parent>;
		return children === undefined ? [] : children.flatMap(inside);
	};
	const text = toLf(body);
	return inside(parse(text)).reduceRight(
		(sofar, { from, to, label }) => `${sofar.slice(0, from)}${label}${sofar.slice(to)}`,
		text
	);
};

/** A secret's fence, as the lines of the body it is written on. */
interface Fence {
	readonly armor: string;
	/** The line its fence opens on, counted from 0. */
	readonly opening: number;
	/** What each of its lines begins with: the marks of the list or quote it is in. */
	readonly prefix: string;
}

/** A line of a fence inside whatever holds it. Armor has no empty line. */
const lineWithin = (line: string, prefix: string): string => `${prefix}${line}`;

/** Every secret's fence in `text`, whose lines end in `\n`, at any depth. */
const fencesIn = (text: string, lines: readonly string[]): Fence[] => {
	const inside = (node: Node): Fence[] => {
		if (node.type === 'code') {
			const { lang, value, position } = node as Node & {
				lang?: string | null;
				value: string;
			};
			if (!isSecretBlock(lang, value) || position === undefined) return [];
			const opening = position.start.line - 1;
			const lead = (lines[opening] ?? '').slice(0, position.start.column - 1);
			// A quote's mark stays, and a list's is as many spaces.
			return [{ armor: value, opening, prefix: lead.replace(/[^>\s]/gu, ' ') }];
		}
		const { children } = node as Partial<Parent>;
		return children === undefined ? [] : children.flatMap(inside);
	};
	return inside(parse(text));
};

/**
 * `body` with the armor of each secret in it replaced by what `change` gives
 * for it, inside whatever list or quote holds its fence: what encrypting a
 * note's secrets to a new key writes (docs/ARCHITECTURE.md §7, "Replacing the
 * key"). A secret it gives nothing for is left as it is, as is one whose lines
 * are not its armor under its list's or quote's marks, which only a fence
 * written by hand could be. Where a secret is rewritten, the body's lines end
 * as its first one does.
 */
export const rewriteSecrets = (
	body: string,
	change: (armor: string) => string | undefined
): string => {
	const text = toLf(body);
	const lines = text.split('\n');
	const rewritten = fencesIn(text, lines).reduceRight((sofar, fence) => {
		const held = fence.armor.split('\n');
		const from = fence.opening + 1;
		const written = held.every(
			(line, at) => sofar[from + at] === lineWithin(line, fence.prefix)
		);
		const armor = written ? change(fence.armor) : undefined;
		if (armor === undefined) return sofar;
		const replaced = armor.split('\n').map((line) => lineWithin(line, fence.prefix));
		return [...sofar.slice(0, from), ...replaced, ...sofar.slice(from + held.length)];
	}, lines);
	if (rewritten === lines) return body;
	const joined = rewritten.join('\n');
	const ending = firstLineEnding(body);
	return ending === undefined || ending === '\n' ? joined : withLineEnding(joined, ending);
};
