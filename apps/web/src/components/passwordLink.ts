import { openableLink } from '../editor/links.js';

/**
 * A password's label, where it is a web address (docs/ARCHITECTURE.md §7,
 * "Passwords in the vault"): an `http://` or `https://` one, or a bare host
 * such as `github.com` — no spaces, a dot, and a last part of two letters or
 * more — which opens as `https://`. Nothing else: "Mr. Smith", "v1.2" and "My
 * bank" stay words. Opened as a link's chip opens one (`openLink`).
 */

/** A host and what may follow it: labels of letters, digits and hyphens, a top level of letters. */
const BARE_HOST =
	/^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/u;

export const labelLink = (label: string): URL | undefined => {
	const text = label.trim();
	if (text === '' || /\s/u.test(text)) return undefined;
	if (/^https?:\/\//iu.test(text)) return openableLink(text);
	if (!BARE_HOST.test(text)) return undefined;
	return openableLink(`https://${text}`);
};
