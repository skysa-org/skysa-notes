import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstallBanner } from '../src/install/InstallBanner.js';
import { type Device, manualInstall } from '../src/install/installHow.js';
import { createInstallPrompt } from '../src/install/installPrompt.js';
import { createDatabase, type NotesDatabase } from '../src/store/db.js';
import { getInstallDismissed } from '../src/store/prefs.js';

/**
 * The offer to install the app while it runs in a browser tab
 * (docs/ARCHITECTURE.md §8, "Installing from the browser"): Chromium's own
 * prompt behind an Install button, Safari's menu item named where it has one,
 * nothing elsewhere, and once dismissed never again on this device.
 */

/** Chromium's `beforeinstallprompt`, as much of it as the app uses. */
class FakeInstallEvent extends Event {
	constructor(
		readonly prompt: () => Promise<void>,
		readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
	) {
		super('beforeinstallprompt', { cancelable: true });
	}
}

const offer = (target: EventTarget, outcome: 'accepted' | 'dismissed' = 'accepted') => {
	const prompt = vi.fn(() => Promise.resolve());
	const event = new FakeInstallEvent(prompt, Promise.resolve({ outcome }));
	act(() => {
		target.dispatchEvent(event);
	});
	return { event, prompt };
};

const UA = {
	iPhoneSafari:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
	iPhoneChrome:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
	macSafari17:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
	macSafari26:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
	macSafari16:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
	macChrome:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	macFirefox:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
	androidChrome:
		'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
	windowsEdge:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
};

const device = (userAgent: string, maxTouchPoints = 0): Device => ({ userAgent, maxTouchPoints });

describe('how a browser with no install event installs', () => {
	it.each([
		['Safari on an iPhone', device(UA.iPhoneSafari, 5), 'home-screen'],
		['Chrome on an iPhone, from iOS 16.4', device(UA.iPhoneChrome, 5), 'home-screen'],
		[
			'an iPad, which asks for desktop pages as a Mac',
			device(UA.macSafari17, 5),
			'home-screen',
		],
		['Safari 17 on a Mac', device(UA.macSafari17), 'dock'],
		['Safari 26 on a Mac', device(UA.macSafari26), 'dock'],
		['Safari 16 on a Mac, which has no Add to Dock', device(UA.macSafari16), undefined],
		['Chrome on a Mac, which says for itself', device(UA.macChrome), undefined],
		['Firefox on a Mac, which does not install', device(UA.macFirefox), undefined],
		['Chrome on Android, which says for itself', device(UA.androidChrome, 5), undefined],
		['Edge on Windows, which says for itself', device(UA.windowsEdge), undefined],
	])('%s', (_name, given, expected) => {
		expect(manualInstall(given)).toBe(expected);
	});
});

describe("Chromium's install offer, kept from the start", () => {
	it("is held, with the browser's own bubble prevented, until it is used", async () => {
		const target = new EventTarget();
		const prompt = createInstallPrompt(target);
		expect(prompt.state().kind).toBe('none');

		const { event, prompt: shown } = offer(target);
		expect(event.defaultPrevented).toBe(true);
		const state = prompt.state();
		expect(state.kind).toBe('ready');
		if (state.kind !== 'ready') return;

		expect(await state.install()).toBe('accepted');
		expect(shown).toHaveBeenCalledTimes(1);
		expect(prompt.state().kind).toBe('installed');
	});

	it('is spent once declined, until the browser offers again', async () => {
		const target = new EventTarget();
		const prompt = createInstallPrompt(target);
		offer(target, 'dismissed');
		const state = prompt.state();
		if (state.kind !== 'ready') throw new Error('not offered');

		expect(await state.install()).toBe('dismissed');
		expect(prompt.state().kind).toBe('none');
		offer(target);
		expect(prompt.state().kind).toBe('ready');
	});

	it('knows the app is installed however it was', () => {
		const target = new EventTarget();
		const prompt = createInstallPrompt(target);
		const changed = vi.fn();
		prompt.subscribe(changed);
		target.dispatchEvent(new Event('appinstalled'));
		expect(prompt.state().kind).toBe('installed');
		expect(changed).toHaveBeenCalled();
	});

	it('leaves alone an event that is not the install offer it knows', () => {
		const target = new EventTarget();
		const prompt = createInstallPrompt(target);
		const event = new Event('beforeinstallprompt', { cancelable: true });
		target.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(prompt.state().kind).toBe('none');
	});
});

/** A window as `matchMedia` answers for the display mode, which can change under it. */
const displayMode = () => {
	const browser = new Set<'yes'>(['yes']);
	const listeners = new Set<() => void>();
	Object.defineProperty(window, 'matchMedia', {
		configurable: true,
		writable: true,
		value: (query: string) => ({
			media: query,
			get matches() {
				return query === '(display-mode: browser)' && browser.has('yes');
			},
			addEventListener: (_type: string, listener: () => void) => {
				listeners.add(listener);
			},
			removeEventListener: (_type: string, listener: () => void) => {
				listeners.delete(listener);
			},
		}),
	});
	return {
		/** Opened, or moved, into a window of its own. */
		standalone: () => {
			act(() => {
				browser.delete('yes');
				listeners.forEach((listener) => {
					listener();
				});
			});
		},
	};
};

const opened: NotesDatabase[] = [];

beforeEach(() => {
	displayMode();
});

afterEach(async () => {
	cleanup();
	Reflect.deleteProperty(window, 'matchMedia');
	await Promise.all(opened.splice(0).map((db) => db.delete()));
});

const show = ({ userAgent = UA.windowsEdge, maxTouchPoints = 0 } = {}) => {
	const db = createDatabase(`install-${crypto.randomUUID()}`);
	opened.push(db);
	const target = new EventTarget();
	const prompt = createInstallPrompt(target);
	const view = () => (
		<InstallBanner
			database={db}
			prompt={prompt}
			device={device(userAgent, maxTouchPoints)}
			name="Notes"
		/>
	);
	const { rerender, unmount } = render(view());
	return { db, target, prompt, view, rerender, unmount };
};

const banner = () => screen.queryByRole('complementary', { name: 'Install Notes' });

describe('the install banner', () => {
	it("offers Chromium's install, and is gone once the app is installed", async () => {
		const { target } = show();
		expect(banner()).toBeNull();

		const { prompt } = offer(target);
		expect(
			await screen.findByText('Install Notes to open it in a window of its own, offline too.')
		).toBeDefined();
		await userEvent.setup().click(screen.getByRole('button', { name: 'Install' }));

		expect(prompt).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(banner()).toBeNull();
		});
	});

	it('goes when the install is declined, without keeping that', async () => {
		const { db, target } = show();
		offer(target, 'dismissed');
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Install' }));

		await waitFor(() => {
			expect(banner()).toBeNull();
		});
		expect(await getInstallDismissed(db)).toBe(false);
	});

	it('is dismissed for good: kept on the device, and not shown again', async () => {
		const { db, target, unmount } = show();
		offer(target);
		await userEvent.setup().click(await screen.findByRole('button', { name: 'Dismiss' }));

		await waitFor(() => {
			expect(banner()).toBeNull();
		});
		expect(await getInstallDismissed(db)).toBe(true);

		// The next page load, offered again.
		unmount();
		const again = createInstallPrompt(target);
		render(
			<InstallBanner
				database={db}
				prompt={again}
				device={device(UA.windowsEdge)}
				name="Notes"
			/>
		);
		offer(target);
		expect(again.state().kind).toBe('ready');
		// Not even for the moment before the dismissal has been read.
		expect(banner()).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(banner()).toBeNull();
	});

	it('is not shown in the installed app, and goes as a tab is moved into a window', async () => {
		const mode = displayMode();
		const { target } = show();
		offer(target);
		expect(await screen.findByRole('button', { name: 'Install' })).toBeDefined();

		mode.standalone();
		expect(banner()).toBeNull();
	});

	it('goes when the app is installed some other way', async () => {
		const { target } = show();
		offer(target);
		await screen.findByRole('button', { name: 'Install' });
		act(() => {
			target.dispatchEvent(new Event('appinstalled'));
		});
		expect(banner()).toBeNull();
	});

	it("names Safari's Add to Home Screen on an iPhone, with nothing to press but Dismiss", async () => {
		show({ userAgent: UA.iPhoneSafari, maxTouchPoints: 5 });
		expect(
			await screen.findByText('Install Notes: tap Share, then Add to Home Screen.')
		).toBeDefined();
		expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
		expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined();
	});

	it("names Safari's Add to Dock on a Mac", async () => {
		show({ userAgent: UA.macSafari17 });
		expect(
			await screen.findByText("Install Notes: in Safari's File menu, choose Add to Dock.")
		).toBeDefined();
	});

	it('says nothing where the browser cannot install the app', async () => {
		show({ userAgent: UA.macFirefox });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(banner()).toBeNull();
	});
});
