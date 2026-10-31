/**
 * An element, as the node views and panels build them: they are not React, so
 * each is made by hand. By attribute rather than property, which is how the
 * repo's rules would rather a DOM object were built (`functional/immutable-data`).
 */
export const el = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attributes: Readonly<Record<string, string>> = {},
	...children: readonly (Node | string)[]
): HTMLElementTagNameMap[K] => {
	const element = document.createElement(tag);
	Object.entries(attributes).forEach(([name, value]) => {
		element.setAttribute(name, value);
	});
	element.append(...children);
	return element;
};

/** A button that is only ever a button: in a form, one with no type would submit it. */
export const buttonEl = (
	attributes: Readonly<Record<string, string>> = {},
	...children: readonly (Node | string)[]
): HTMLButtonElement => el('button', { ...attributes, type: 'button' }, ...children);
