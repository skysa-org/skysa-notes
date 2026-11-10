import type { VitePWAOptions } from 'vite-plugin-pwa';

type Workbox = VitePWAOptions['workbox'];

/** A runtime rule of the worker's. */
type Rule = NonNullable<Workbox['runtimeCaching']>[number];

/** The page the worker serves from, for a same-origin request. */
export const APP = 'https://app.example';

/** How the worker built from `workbox` answers, decided as Workbox decides it. */
export const workerOf = (
	workbox: Workbox
): Readonly<{
	shellAnswers: (pathAndSearch: string) => boolean;
	ruleFor: (href: string, method?: string) => Rule | undefined;
}> => ({
	/**
	 * Whether it answers a navigation to `pathAndSearch` with the shell, as
	 * Workbox's `NavigationRoute` decides: the denylist first, then the
	 * allowlist.
	 */
	shellAnswers: (pathAndSearch: string): boolean =>
		!(workbox.navigateFallbackDenylist ?? []).some((pattern) => pattern.test(pathAndSearch)) &&
		(workbox.navigateFallbackAllowlist ?? []).some((pattern) => pattern.test(pathAndSearch)),
	/**
	 * The runtime rule it answers a request with, as Workbox's router decides:
	 * the first whose method is the request's and whose pattern matches.
	 */
	ruleFor: (href: string, method = 'GET') => {
		const url = new URL(href);
		return (workbox.runtimeCaching ?? []).find((rule) => {
			if ((rule.method ?? 'GET') !== method) return false;
			const pattern = rule.urlPattern;
			if (pattern instanceof RegExp) return pattern.test(href);
			if (typeof pattern === 'function') {
				const asked = { url, sameOrigin: url.origin === APP } as unknown as Parameters<
					typeof pattern
				>[0];
				return Boolean(pattern(asked));
			}
			return pattern === href;
		});
	},
});
