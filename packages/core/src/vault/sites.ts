/**
 * Which site a password is for, and whether it fills a page
 * (docs/ARCHITECTURE.md §7, "Filling in on a site"). An item's Site is kept
 * encrypted with its password (`vaultUrls`); the page is the origin the
 * browser stamps on the fill window's message, never anything the page says
 * about itself.
 *
 * A login fills the site it was saved for and the sites under it, the owner's
 * choice: one saved for `example.com` fills `login.example.com`, never the
 * other way about. One saved over `https:` never fills a page over `http:`,
 * which would send it in the clear. Nothing else fills: a look-alike name is
 * another site, as it is to the browser.
 *
 * There is no list of public suffixes, whose licence the repository does not
 * take, so a Site of `github.io` would fill every site under it. Saving from a
 * page keeps the page's own host, so a parent fills its children only where
 * the user wrote it in.
 */

/** A site, as a login is saved for one or a page is on one. */
export interface Site {
	/** Over `https:`, and not `http:`. */
	readonly secure: boolean;
	/**
	 * The host as the browser's URL parser writes it: lower case, a name in
	 * any script as its ASCII (`xn--…`) form, an IPv6 address in brackets,
	 * and no dot at the end.
	 */
	readonly host: string;
	/** The port, or `''` for the scheme's own. */
	readonly port: string;
	/**
	 * An address (`192.168.1.1`, `[::1]`) or a name of one label
	 * (`localhost`): one that has no sites under it, and matches only itself.
	 */
	readonly exact: boolean;
}

const WEB = /^https?:\/\//iu;
/** A scheme with an authority, as `ftp://` has: not a web address. */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/u;

/** `url` as a site, where it is a web address with a host and no user in it. */
const fromUrl = (text: string): Site | undefined => {
	const url = ((): URL | undefined => {
		try {
			return new URL(text);
		} catch {
			return undefined;
		}
	})();
	if (url === undefined) return undefined;
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
	// An address with a user in it reads one way and goes another:
	// `https://example.com@evil.example` is evil.example's.
	if (url.username !== '' || url.password !== '') return undefined;
	const host = url.hostname.replace(/\.$/u, '');
	if (host === '') return undefined;
	const address = host.startsWith('[') || IPV4.test(host);
	if (!address && host.split('.').some((label) => label === '')) return undefined;
	return {
		secure: url.protocol === 'https:',
		host,
		port: url.port,
		exact: address || !host.includes('.'),
	};
};

/**
 * The site an item's Site names, or `undefined` where it names none: a web
 * address, or a host with or without a port and a path, which is taken to be
 * over `https:`. Not an address with a user in it, a wildcard, words with
 * spaces, an empty part of a name, or any other scheme's address.
 */
export const siteOf = (address: string): Site | undefined => {
	const text = address.trim();
	if (text === '' || /\s/u.test(text) || text.includes('*')) return undefined;
	if (WEB.test(text)) return fromUrl(text);
	if (OTHER_SCHEME.test(text)) return undefined;
	return fromUrl(`https://${text}`);
};

/**
 * The site a page is on, from the origin its message came from
 * (`MessageEvent.origin`): `undefined` for an opaque origin (`null`, which a
 * sandboxed frame or a `data:` page has) or anything but the web's.
 */
export const pageSite = (origin: string): Site | undefined =>
	WEB.test(origin) ? fromUrl(origin) : undefined;

/** `www.` and what follows, where what follows is a name of its own (`www.example.com`). */
const wwwOf = (host: string): string | undefined => {
	const rest = host.startsWith('www.') ? host.slice('www.'.length) : '';
	return rest.includes('.') ? rest : undefined;
};

/**
 * Whether a login saved for `saved` fills a page on `page`: the same host or
 * one under it, on the same port, and over `https:` where it was saved over
 * `https:`. An address, or a name of one label, matches only itself.
 *
 * A saved `www.example.com` also fills `example.com`, the same site with or
 * without its `www.`, but not the other sites under `example.com`, which
 * saving from `www.example.com` never meant: a login saved on
 * `www.tumblr.com` does not fill `someone.tumblr.com`.
 */
export const fillsOn = (saved: Site, page: Site): boolean => {
	if (saved.secure && !page.secure) return false;
	if (saved.port !== page.port) return false;
	if (saved.host === page.host) return true;
	if (saved.exact || page.exact) return false;
	if (page.host === wwwOf(saved.host)) return true;
	return page.host.endsWith(`.${saved.host}`);
};

/** A site as an address, its scheme's port left out: what Save keeps as an item's Site. */
export const siteAddress = (site: Site): string =>
	`${site.secure ? 'https' : 'http'}://${site.host}${site.port === '' ? '' : `:${site.port}`}`;

/** A site as it is named to the user: its host, and its port where it has one of its own. */
export const siteName = (site: Site): string =>
	site.port === '' ? site.host : `${site.host}:${site.port}`;

/** What a login saved from a page is called unless the user calls it something else: its host, without `www.`. */
export const siteLabel = (site: Site): string =>
	siteName({ ...site, host: wwwOf(site.host) ?? site.host });
