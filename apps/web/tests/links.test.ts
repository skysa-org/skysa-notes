import { afterEach, describe, expect, it, onTestFinished } from 'vitest';

import { linkAddress, linkChip, openableLink, openLink } from '../src/editor/links.js';

/**
 * A link in a note, opened in the browser (docs/ARCHITECTURE.md §7, "Links
 * open in the browser"): what opens, what the chip says of it, and how it is
 * handed to the browser.
 */

afterEach(() => {
	document.body.replaceChildren();
});

/** Every link clicked, by its address, target and rel, taken at the document: so only one in the page. */
const clicks = () => {
	const seen: { href: string; target: string | null; rel: string | null }[] = [];
	const take = (event: MouseEvent) => {
		if (!(event.target instanceof HTMLAnchorElement)) return;
		// jsdom would go on to say it cannot navigate.
		event.preventDefault();
		seen.push({
			href: event.target.href,
			target: event.target.getAttribute('target'),
			rel: event.target.getAttribute('rel'),
		});
	};
	document.addEventListener('click', take);
	onTestFinished(() => {
		document.removeEventListener('click', take);
	});
	return seen;
};

describe('a link that opens', () => {
	it('goes to the web, an e-mail address or a phone number', () => {
		expect(openableLink('https://example.com/a?b#c')?.href).toBe('https://example.com/a?b#c');
		expect(openableLink('http://example.com')?.href).toBe('http://example.com/');
		expect(openableLink('mailto:ann@example.com')?.protocol).toBe('mailto:');
		expect(openableLink('tel:+441234567890')?.protocol).toBe('tel:');
		expect(openableLink('  HTTPS://Example.com  ')?.href).toBe('https://example.com/');
	});

	it('is never a scheme that runs or reads anything, however it is spelled', () => {
		for (const href of [
			'javascript:alert(1)',
			'JavaScript:alert(1)',
			'java\tscript:alert(1)',
			'\u0001javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'file:///etc/passwd',
			'vbscript:msgbox(1)',
			'blob:https://example.com/1',
		]) {
			expect(openableLink(href), href).toBeUndefined();
		}
	});

	it('is never relative: a file or a note beside this one is not a page on the web', () => {
		for (const href of [
			'other.md',
			'../a/b.pdf',
			'/root',
			'//example.com/a',
			'#heading',
			'?q',
			'',
		]) {
			expect(openableLink(href), href).toBeUndefined();
		}
	});
});

describe('where the chip says a link goes', () => {
	const address = (href: string) => {
		const url = openableLink(href);
		if (url === undefined) throw new Error(`${href} does not open`);
		return linkAddress(url);
	};

	it('is the site and the page, with no scheme and no www.', () => {
		expect(address('https://www.example.com/')).toBe('example.com');
		expect(address('https://example.com/a/b?c=d#e')).toBe('example.com/a/b?c=d#e');
		expect(address('http://example.com:8080/a')).toBe('example.com:8080/a');
	});

	it('reads an escape as what it stands for, and the host as the parser has it', () => {
		expect(address('https://example.com/Caf%C3%A9%20menu')).toBe('example.com/Café menu');
		expect(address('https://example.com/100%')).toBe('example.com/100%');
		expect(address('https://exаmple.com/')).toBe('xn--exmple-4nf.com');
	});

	it('is an e-mail address or a phone number alone', () => {
		expect(address('mailto:ann@example.com?subject=Hi')).toBe('ann@example.com');
		expect(address('tel:+441234567890')).toBe('+441234567890');
	});
});

describe('opening a link', () => {
	it('clicks a link to a new window that has no hold on this one, and takes it out again', () => {
		const seen = clicks();
		openLink(new URL('https://example.com/a'));
		expect(seen).toEqual([
			{
				href: 'https://example.com/a',
				target: '_blank',
				rel: 'noopener noreferrer',
			},
		]);
		expect(document.querySelector('a')).toBeNull();
	});
});

describe('the chip', () => {
	it('says where the link goes and opens it when pressed', () => {
		const seen = clicks();
		const chip = linkChip();
		document.body.append(chip.dom);
		expect(chip.dom.hidden).toBe(true);

		chip.show(new URL('https://www.example.com/docs'));
		const button = chip.dom.querySelector('button');
		expect(chip.dom.hidden).toBe(false);
		expect(button?.getAttribute('aria-label')).toBe('Open example.com/docs');
		expect(button?.getAttribute('title')).toBe('https://www.example.com/docs');
		expect(chip.dom.querySelector('.link-chip-address')?.textContent).toBe('example.com/docs');
		expect(chip.dom.querySelector('.link-chip-hint')?.textContent).toMatch(/^(⌘|Ctrl)\+click$/);
		expect(chip.dom.querySelector('.link-chip-hint')?.getAttribute('aria-hidden')).toBe('true');

		button?.click();
		expect(seen.map((each) => each.href)).toEqual(['https://www.example.com/docs']);

		chip.show(undefined);
		expect(chip.dom.hidden).toBe(true);
	});

	it('keeps the focus where it was when pressed', () => {
		const chip = linkChip();
		document.body.append(chip.dom);
		const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		chip.dom.querySelector('button')?.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);
	});
});
