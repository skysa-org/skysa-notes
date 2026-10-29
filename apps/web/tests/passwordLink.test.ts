import { describe, expect, it } from 'vitest';

import { labelLink } from '../src/components/passwords/passwordLink.js';

/**
 * A password's label that opens (docs/ARCHITECTURE.md §7, "Passwords in the
 * vault"): a web address, or a bare host taken as `https://`, and nothing else.
 */

describe('a label that is a web address', () => {
	it.each([
		['https://github.com/login', 'https://github.com/login'],
		['http://router.local.lan:8080/admin', 'http://router.local.lan:8080/admin'],
		['github.com', 'https://github.com/'],
		['www.x.co', 'https://www.x.co/'],
		['accounts.google.com/signin?hl=en', 'https://accounts.google.com/signin?hl=en'],
		['  bank.example.com  ', 'https://bank.example.com/'],
		['münchen.de', 'https://xn--mnchen-3ya.de/'],
		['GitHub.com', 'https://github.com/'],
		['notion.so', 'https://notion.so/'],
		['claude.ai', 'https://claude.ai/'],
	])('opens, %s as %s', (label, href) => {
		expect(labelLink(label)?.href).toBe(href);
	});

	it.each([
		'Mr. Smith',
		'v1.2',
		'My bank',
		'GitHub',
		'a.b',
		'.com',
		'github.',
		'ftp://files.example.com',
		'javascript:alert(1)',
		'mailto:ada@example.com',
		'example.com and more',
		'https://example.com/a b',
		// Words with a dot in them, whose last part is no top level in common use.
		'Node.js',
		'John.Smith',
		'Mr.Smith',
		'config.yaml',
		'Netflix.Family',
		'',
	])('does not, for %j', (label) => {
		expect(labelLink(label)).toBeUndefined();
	});
});
