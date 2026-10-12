import { onTestFinished } from 'vitest';

/**
 * The links handed to the browser to open in a new window (`openLink`), by
 * address, for the length of the test. Taken from the click at the document,
 * so only a link clicked while it was in the page, and turned down there,
 * since jsdom would go on to say it cannot navigate.
 */
export const linksOpened = (): string[] => {
	const seen: string[] = [];
	const take = (event: MouseEvent) => {
		const link = event.target;
		if (!(link instanceof HTMLAnchorElement) || link.target !== '_blank') return;
		event.preventDefault();
		seen.push(link.href);
	};
	document.addEventListener('click', take);
	onTestFinished(() => {
		document.removeEventListener('click', take);
	});
	return seen;
};
