import { Fragment, type ReactNode } from 'react';

import { type Args, type At, type ParamValue, type Tags, type Texts } from './catalog.js';
import { choose, type English, fill, messageAt, type MessageKey } from './t.js';

/** A function for each tag the message wraps words in, given those words. */
export type TagRenderers<M> = {
	readonly [N in Tags<Texts<M>>]: (words: string) => ReactNode;
};

const TAG = /<(\w+)>(.*?)<\/\1>/gs;

type Renderers = Readonly<Record<string, (words: string) => ReactNode>>;

type Values = Readonly<Record<string, ParamValue>>;

/**
 * Text with its tags rendered and its placeholders filled. The tags are split
 * out before the placeholders are filled, so a note named `<b>` is a name and
 * never a tag.
 */
export const markup = (text: string, renderers: Renderers, values: Values): ReactNode => {
	const parts: ReactNode[] = [];
	const end = [...text.matchAll(TAG)].reduce((at, match) => {
		const [whole, name = '', words = ''] = match;
		const render = renderers[name];
		parts.push(
			fill(text.slice(at, match.index), values),
			render === undefined ? fill(whole, values) : render(fill(words, values))
		);
		return match.index + whole.length;
	}, 0);
	parts.push(fill(text.slice(end), values));
	return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
};

/**
 * A message whose words are partly marked up: a name in bold, a link in the
 * middle of a sentence.
 */
export const rich = <K extends MessageKey>(
	key: K,
	tags: TagRenderers<At<English, K>>,
	...args: Args<At<English, K>>
): ReactNode => {
	const values = (args[0] ?? {}) as Values;
	return markup(choose(messageAt(key), values), tags as Renderers, values);
};
