import { describe, expect, it } from 'vitest';

import { buttonEl, el } from '../src/editor/shared/dom.js';

describe('el', () => {
	it('makes the element with its attributes and children, in order', () => {
		const inner = document.createElement('b');
		const element = el('span', { class: 'a', 'aria-label': 'b', hidden: '' }, 'text', inner);

		expect(element.tagName).toBe('SPAN');
		expect(element.getAttribute('class')).toBe('a');
		expect(element.getAttribute('aria-label')).toBe('b');
		expect(element.hasAttribute('hidden')).toBe(true);
		expect(element.innerHTML).toBe('text<b></b>');
	});

	it('makes a bare element when asked for nothing else', () => {
		expect(el('div').outerHTML).toBe('<div></div>');
	});
});

describe('buttonEl', () => {
	it('is of type button, so it cannot submit a form it is put in', () => {
		expect(buttonEl().getAttribute('type')).toBe('button');
		expect(buttonEl({ class: 'a' }, 'Go').outerHTML).toBe(
			'<button type="button" class="a">Go</button>'
		);
	});
});
