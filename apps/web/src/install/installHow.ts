/**
 * How the app is installed where no event says it can be: the browsers whose
 * install is a menu item the page cannot press for the user, and so can only
 * name (docs/ARCHITECTURE.md §8, "Installing from the browser").
 * https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
 *
 * - iPhone and iPad: "Add to Home Screen", in the Share menu — Safari's, and
 *   since iOS 16.4 every browser's there. No `beforeinstallprompt`.
 * - Safari on a Mac, from 17 (Sonoma): File › Add to Dock.
 *
 * Read from the user agent, which is all there is to read: neither has an API
 * that says so. iPadOS asks for desktop pages and calls itself a Mac, so a Mac
 * with a touch screen is an iPad. Firefox on a desktop does not install web
 * apps at all, and Chromium says for itself (`installPrompt.ts`), so neither
 * is named here.
 */

export type ManualInstall = 'home-screen' | 'dock';

export interface Device {
	readonly userAgent: string;
	readonly maxTouchPoints: number;
}

const OTHER_MAC_BROWSERS = /Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|OPR|Brave/;

export const manualInstall = ({ userAgent, maxTouchPoints }: Device): ManualInstall | undefined => {
	const mac = /Macintosh/.test(userAgent);
	if (/iPhone|iPad|iPod/.test(userAgent) || (mac && maxTouchPoints > 1)) return 'home-screen';
	if (!mac || OTHER_MAC_BROWSERS.test(userAgent)) return undefined;
	const version = /Version\/(\d+)(?:\.\d+)*.* Safari\//.exec(userAgent)?.[1];
	return version !== undefined && Number(version) >= 17 ? 'dock' : undefined;
};

export const thisDevice = (): Device =>
	typeof navigator === 'undefined'
		? { userAgent: '', maxTouchPoints: 0 }
		: { userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints };
