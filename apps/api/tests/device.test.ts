import { describe, expect, it } from 'vitest';

import { deviceLabel } from '../src/device.js';

/**
 * What the device list calls a device (`deviceLabel`), from User-Agents the
 * browsers people sign in from actually send.
 */

describe('a device’s label', () => {
	it.each<[string, string]>([
		[
			'Safari on iPhone',
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
		],
		[
			// Added to the home screen: no `Safari/`, still Safari.
			'Safari on iPhone',
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
		],
		[
			'Chrome on iPhone',
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
		],
		[
			'Firefox on iPad',
			'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
		],
		[
			'Safari on Mac',
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
		],
		[
			'Chrome on Mac',
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
		],
		[
			'Chrome on Android',
			'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
		],
		[
			'Samsung Internet on Android',
			'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
		],
		[
			'Edge on Windows',
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
		],
		[
			'Opera on Windows',
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0',
		],
		[
			'Firefox on Windows',
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
		],
		[
			'Firefox on Linux',
			'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
		],
		[
			'Chrome on ChromeOS',
			'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
		],
	])('is “%s”', (label, userAgent) => {
		expect(deviceLabel(userAgent)).toBe(label);
	});

	it('says what it can name, and nothing at all when it can name nothing', () => {
		expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) SomeBrowser/1.0')).toBe('Windows');
		expect(deviceLabel('curl/8.6.0')).toBeUndefined();
		expect(deviceLabel(undefined)).toBeUndefined();
	});
});
