import { siteOf } from '@skysa/core';

import { openableLink } from '../../editor/links.js';

/**
 * A password's label, where it is a web address (docs/ARCHITECTURE.md §7,
 * "Passwords in the vault"): an `http://` or `https://` one, or a bare host
 * such as `github.com` — no spaces, a dot, and a last part that is a country's
 * or one of the common ones — which opens as `https://`. Nothing else: "Mr.
 * Smith", "v1.2", "Node.js" and "My bank" stay words. Opened as a link's chip
 * opens one (`openLink`).
 */

/**
 * The last parts a bare host may end in: every country's, as IANA lists the
 * two-letter ones (https://data.iana.org/TLD/tlds-alpha-by-domain.txt,
 * 2026-10-15), and the generic ones in common use. Any word after a dot would
 * make "John.Smith" and "config.yaml" links; every top level there is, more
 * than a thousand, would make "Netflix.Family" one too, and weigh more than
 * the rest of the item.
 */
const TOP_LEVELS = new Set([
	...(
		'ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo ' +
		'br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk ' +
		'dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq ' +
		'gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ' +
		'ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn ' +
		'mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ' +
		'ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn ' +
		'so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us ' +
		'uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'
	).split(' '),
	...['com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro', 'app'],
	...['dev', 'page', 'blog', 'cloud', 'online', 'site', 'tech', 'store', 'shop', 'xyz', 'club'],
	...['news', 'email'],
]);

/** A host and what may follow it: labels of letters, digits and hyphens, then a top level of letters. */
const BARE_HOST =
	/^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,})(?::\d{1,5})?(?:[/?#]\S*)?$/u;

export const labelLink = (label: string): URL | undefined => {
	const text = label.trim();
	if (text === '' || /\s/u.test(text)) return undefined;
	if (/^https?:\/\//iu.test(text)) return openableLink(text);
	const topLevel = BARE_HOST.exec(text)?.[1];
	if (topLevel === undefined || !TOP_LEVELS.has(topLevel.toLowerCase())) return undefined;
	return openableLink(`https://${text}`);
};

/**
 * A password's Site, as a link to open (docs/ARCHITECTURE.md §7, "Filling in
 * on a site"): what it fills in on, where that is a site at all (`siteOf`), a
 * bare host opening as `https://`, as a label's does.
 */
export const siteLink = (site: string): URL | undefined => {
	const text = site.trim();
	if (siteOf(text) === undefined) return undefined;
	return openableLink(/^https?:\/\//iu.test(text) ? text : `https://${text}`);
};
