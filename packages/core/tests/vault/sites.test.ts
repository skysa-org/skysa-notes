import { describe, expect, it } from 'vitest';

import {
	fillsOn,
	pageSite,
	type Site,
	siteAddress,
	siteLabel,
	siteName,
	siteOf,
} from '../../src/vault/sites.js';

/** Whether a login saved as `saved` fills a page whose origin is `origin`. */
const fills = (saved: string, origin: string): boolean => {
	const site = siteOf(saved);
	const page = pageSite(origin);
	if (site === undefined || page === undefined) throw new Error(`not a site: ${saved} ${origin}`);
	return fillsOn(site, page);
};

describe('a Site', () => {
	it('is read from a web address or a bare host, which is taken to be over https', () => {
		expect(siteOf('https://login.example.com/sign-in?next=1')).toEqual<Site>({
			secure: true,
			host: 'login.example.com',
			port: '',
			exact: false,
		});
		expect(siteOf('http://example.com:8080')).toEqual<Site>({
			secure: false,
			host: 'example.com',
			port: '8080',
			exact: false,
		});
		expect(siteOf('  example.com/login ')).toEqual<Site>({
			secure: true,
			host: 'example.com',
			port: '',
			exact: false,
		});
		expect(siteOf('example.com:8443')?.port).toBe('8443');
	});

	it('is written as the browser writes a host: lower case, ASCII, no dot at the end', () => {
		expect(siteOf('HTTPS://Example.COM')?.host).toBe('example.com');
		expect(siteOf('bücher.example')?.host).toBe('xn--bcher-kva.example');
		expect(siteOf('example.com.')?.host).toBe('example.com');
		// The scheme's own port is no port.
		expect(siteOf('https://example.com:443')?.port).toBe('');
	});

	it('is an address, or a name of one label, that matches only itself', () => {
		expect(siteOf('192.168.1.1')?.exact).toBe(true);
		expect(siteOf('http://[::1]:5173')).toEqual<Site>({
			secure: false,
			host: '[::1]',
			port: '5173',
			exact: true,
		});
		expect(siteOf('localhost:8080')?.exact).toBe(true);
	});

	it('is not read from what names no site, or names one and goes to another', () => {
		expect(siteOf('')).toBeUndefined();
		expect(siteOf('My bank')).toBeUndefined();
		expect(siteOf('*.example.com')).toBeUndefined();
		expect(siteOf('a..example.com')).toBeUndefined();
		expect(siteOf('.')).toBeUndefined();
		expect(siteOf('ftp://example.com')).toBeUndefined();
		expect(siteOf('mailto:ada@example.com')).toBeUndefined();
		expect(siteOf('javascript:alert(1)')).toBeUndefined();
		// Read as example.com, it is evil.example's.
		expect(siteOf('https://example.com@evil.example')).toBeUndefined();
		expect(siteOf('ada:pw@example.com')).toBeUndefined();
	});
});

describe('the page’s site', () => {
	it('is read from a message’s origin on the web', () => {
		expect(pageSite('https://www.example.com')).toEqual<Site>({
			secure: true,
			host: 'www.example.com',
			port: '',
			exact: false,
		});
	});

	it('is none for an opaque origin or another scheme’s', () => {
		expect(pageSite('null')).toBeUndefined();
		expect(pageSite('file://')).toBeUndefined();
		expect(pageSite('chrome-extension://abcdef')).toBeUndefined();
		// Not a bare host: an origin always says its scheme.
		expect(pageSite('example.com')).toBeUndefined();
	});
});

describe('a login', () => {
	it('fills the site it was saved for, and the sites under it', () => {
		expect(fills('example.com', 'https://example.com')).toBe(true);
		expect(fills('example.com', 'https://login.example.com')).toBe(true);
		expect(fills('example.com', 'https://a.b.example.com')).toBe(true);
		expect(fills('https://example.com/login', 'https://example.com')).toBe(true);
	});

	it('does not fill the site above the one it was saved for', () => {
		expect(fills('login.example.com', 'https://example.com')).toBe(false);
		expect(fills('login.example.com', 'https://other.example.com')).toBe(false);
	});

	it('does not fill a site whose name only looks like it', () => {
		expect(fills('example.com', 'https://example.com.evil.example')).toBe(false);
		expect(fills('example.com', 'https://evilexample.com')).toBe(false);
		expect(fills('example.com', 'https://example.co')).toBe(false);
		// A Cyrillic а in place of the a: another name to the browser too.
		expect(fills('apple.com', 'https://xn--pple-43d.com')).toBe(false);
		expect(fills('аpple.com', 'https://apple.com')).toBe(false);
	});

	it('saved over https never fills a page over http; saved over http fills either', () => {
		expect(fills('https://example.com', 'http://example.com')).toBe(false);
		expect(fills('example.com', 'http://example.com')).toBe(false);
		expect(fills('http://example.com', 'http://example.com')).toBe(true);
		expect(fills('http://example.com', 'https://example.com')).toBe(true);
	});

	it('fills only on the port it was saved for', () => {
		expect(fills('example.com', 'https://example.com:8443')).toBe(false);
		expect(fills('example.com:8443', 'https://example.com')).toBe(false);
		expect(fills('example.com:8443', 'https://example.com:8443')).toBe(true);
		expect(fills('http://example.com:80', 'http://example.com')).toBe(true);
	});

	it('saved for an address or a one-label name fills only that', () => {
		expect(fills('http://192.168.1.1', 'http://192.168.1.1')).toBe(true);
		expect(fills('http://192.168.1.1', 'http://192.168.1.10')).toBe(false);
		expect(fills('http://1.1', 'http://2.1.1')).toBe(false);
		expect(fills('http://[::1]:5173', 'http://[::1]:5173')).toBe(true);
		expect(fills('http://localhost:8080', 'http://localhost:8080')).toBe(true);
		expect(fills('http://localhost:8080', 'http://a.localhost:8080')).toBe(false);
		// A bare address is taken to be over https, as any bare host is: a
		// router's page over http needs its Site written with http://.
		expect(fills('192.168.1.1', 'http://192.168.1.1')).toBe(false);
	});

	it('saved for www. fills the site without it, but not the others under it', () => {
		expect(fills('www.example.com', 'https://www.example.com')).toBe(true);
		expect(fills('www.example.com', 'https://example.com')).toBe(true);
		expect(fills('www.example.com', 'https://m.www.example.com')).toBe(true);
		expect(fills('www.tumblr.com', 'https://someone.tumblr.com')).toBe(false);
		expect(fills('example.com', 'https://www.example.com')).toBe(true);
		// `www.` before a name of one label is a name of its own.
		expect(fills('www.com', 'https://com')).toBe(false);
	});

	it('saved for what is a public suffix fills every site under it, as written', () => {
		// No list of public suffixes (see the module): saving from a page keeps
		// its own host, so only a Site written this way does this.
		expect(fills('github.io', 'https://someone.github.io')).toBe(true);
		expect(fills('co.uk', 'https://bank.co.uk')).toBe(true);
		expect(fills('someone.github.io', 'https://another.github.io')).toBe(false);
	});

	it('matches a page whose origin ends in a dot as the same site', () => {
		expect(fills('example.com', 'https://example.com.')).toBe(true);
	});
});

describe('a site, written', () => {
	it('as an address keeps its scheme and its own port', () => {
		const page = pageSite('https://www.example.com:8443');
		expect(page && siteAddress(page)).toBe('https://www.example.com:8443');
		const plain = pageSite('http://example.com');
		expect(plain && siteAddress(plain)).toBe('http://example.com');
	});

	it('as a name is its host, and its port where it has one', () => {
		const page = pageSite('https://www.example.com:8443');
		expect(page && siteName(page)).toBe('www.example.com:8443');
	});

	it('as a label leaves out www.', () => {
		const page = pageSite('https://www.example.com');
		expect(page && siteLabel(page)).toBe('example.com');
		const other = pageSite('https://www.com');
		expect(other && siteLabel(other)).toBe('www.com');
		const local = pageSite('http://localhost:8080');
		expect(local && siteLabel(local)).toBe('localhost:8080');
	});
});
