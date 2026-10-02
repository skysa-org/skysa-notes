/**
 * What a device is, from its browser's User-Agent: "Safari on iPhone", "Chrome
 * on Windows". What a list of signed-in devices says about each one everywhere
 * accounts are kept, and the one thing that tells a user which row is the
 * tablet in a drawer and which is a device they do not know.
 *
 * Kept on the grant at sign-in (`grants.device`) as this label and nothing
 * else: the User-Agent itself says far more than which device it is (versions,
 * build numbers), and the address it came from would be a place. A short list
 * of the browsers and systems people sign in from, written out rather than a
 * parsing library's thousand rules, because a label that is wrong now and then
 * costs nothing and a dependency costs every deployment.
 *
 * What it cannot tell: an iPad asks for desktop sites by default and says it
 * is a Mac, and every browser on an iPhone is Safari underneath — only the
 * ones that say otherwise (`CriOS`, `FxiOS`, `EdgiOS`) are named otherwise.
 */

/** In order: each name's tokens appear in the User-Agents of those after it. */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
	[/\bEdg(e|A|iOS)?\//, 'Edge'],
	[/\bOPR\/|\bOpera\b/, 'Opera'],
	[/\bSamsungBrowser\//, 'Samsung Internet'],
	[/\bFirefox\/|\bFxiOS\//, 'Firefox'],
	[/\bCriOS\/|\bChrome\//, 'Chrome'],
	// A home-screen app on an iPhone drops the `Safari/` token and keeps
	// WebKit's; it is Safari all the same.
	[/\bVersion\/[\d.]+.*\bSafari\/|\(i(Phone|Pad|Pod)\b.*\bAppleWebKit\//, 'Safari'],
];

/** In order: an iPhone says it is "like Mac OS X", and Android is Linux. */
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
	[/\biPhone\b|\biPod\b/, 'iPhone'],
	[/\biPad\b/, 'iPad'],
	[/\bAndroid\b/, 'Android'],
	[/\bCrOS\b/, 'ChromeOS'],
	[/\bWindows\b/, 'Windows'],
	[/\bMacintosh\b|\bMac OS X\b/, 'Mac'],
	[/\bLinux\b/, 'Linux'],
];

const first = (from: readonly (readonly [RegExp, string])[], userAgent: string) =>
	from.find(([pattern]) => pattern.test(userAgent))?.[1];

/** "Browser on system", either alone, or nothing when it names neither. */
export const deviceLabel = (userAgent: string | undefined): string | undefined => {
	if (userAgent === undefined) return undefined;
	const browser = first(BROWSERS, userAgent);
	const system = first(SYSTEMS, userAgent);
	if (browser !== undefined && system !== undefined) return `${browser} on ${system}`;
	return browser ?? system;
};
