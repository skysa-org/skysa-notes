import '../src/jitless.js';

import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bookmarkletUrl } from '../src/fill/bookmarklet.js';
import { BOOKMARKLET_REVISION, FILL_MESSAGE, FILL_VERSION } from '../src/fill/protocol.js';

/**
 * The bookmarklet (docs/ARCHITECTURE.md §7, "Filling in on a site"), run as a
 * bookmark runs it: its address decoded and run in a page of its own, a fresh
 * window with nothing in it but what a page has. So what is tested is what
 * the address holds, and that it needs nothing from the app to run.
 */

const APP = 'https://notes.example';

/** What the address runs, as the browser decodes it. */
const code = (): string => {
	const url = bookmarkletUrl(APP);
	expect(url.startsWith('javascript:')).toBe(true);
	return decodeURIComponent(url.slice('javascript:'.length));
};

/** A window the page's message event can name as its source: jsdom takes only its own. */
const from = (event: MessageEvent, source: unknown): MessageEvent => {
	Object.defineProperty(event, 'source', { value: source });
	return event;
};

/**
 * A site's page with `html` in it: a frame of its own, whose window is a
 * fresh one, with its own globals, apart from this test's. Laid out as far as
 * the bookmarklet looks: jsdom lays nothing out, so an input is drawn unless
 * it, or what holds it, is hidden.
 */
const page = (html: string) => {
	const frame = document.createElement('iframe');
	document.body.append(frame);
	const window = frame.contentWindow as (Window & typeof globalThis) | null;
	if (window === null) throw new Error('no frame window');
	window.document.body.innerHTML = html;
	const drawn = (element: HTMLElement) =>
		element.closest('[hidden]') === null && element.style.display !== 'none';
	Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', {
		value(this: HTMLElement) {
			// jsdom's own method, called on the element it measures.
			// eslint-disable-next-line functional/no-this-expressions
			return (drawn(this) ? [{}] : []) as unknown as DOMRectList;
		},
	});
	const popup = { postMessage: vi.fn() };
	const open = vi.fn<(...args: unknown[]) => unknown>(() => popup);
	const alert = vi.fn();
	Object.assign(window, { open, alert });
	const send = (data: unknown, origin = APP, source: unknown = popup) => {
		window.dispatchEvent(from(new window.MessageEvent('message', { data, origin }), source));
	};
	// Run as a bookmark runs it, in the page's own window.
	const run = (): unknown =>
		(window as unknown as { eval: (code: string) => unknown }).eval(code());
	const input = (selector: string) => window.document.querySelector<HTMLInputElement>(selector);
	return { window, popup, open, alert, send, run, input };
};

const ready = { type: FILL_MESSAGE, v: FILL_VERSION, step: 'ready' };
const filled = (username: string, password: string) => ({
	type: FILL_MESSAGE,
	v: FILL_VERSION,
	step: 'fill',
	username,
	password,
});

const LOGIN = `
	<form>
		<input id="q" type="search">
		<input id="user" autocomplete="username" value="ada">
		<input id="pw" type="password" autocomplete="current-password" value="typed">
	</form>`;

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe('the bookmarklet', () => {
	it('is the code it runs, every byte of it encoded, and answers nothing', () => {
		const url = bookmarkletUrl(APP);
		expect(url).not.toMatch(/[\s#]/u);
		expect(url).not.toMatch(/%(?![0-9A-F]{2})/u);
		expect(code()).toMatch(/^void\(\(/u);

		const { run } = page(LOGIN);
		// Anything but undefined, and the browser would put it in place of the page.
		expect(run()).toBeUndefined();
	});

	it('opens the fill window at the app’s /fill, with its opener, in a window of its own', () => {
		const { open, run } = page(LOGIN);
		run();

		expect(open).toHaveBeenCalledWith(`${APP}/fill`, '_blank', 'popup,width=440,height=640');
	});

	it('says so, in the app’s words, where the browser blocks the window', () => {
		const { open, alert, run } = page(LOGIN);
		open.mockReturnValue(null);

		run();

		expect(alert).toHaveBeenCalledWith(
			'The fill window was blocked. Allow pop-ups for this site, then try again.'
		);
	});

	it('answers ready with what the login’s fields hold, to the app’s origin alone', () => {
		const { popup, send, run } = page(LOGIN);
		run();

		send(ready);

		expect(popup.postMessage).toHaveBeenCalledWith(
			{
				type: FILL_MESSAGE,
				v: FILL_VERSION,
				b: BOOKMARKLET_REVISION,
				step: 'hello',
				username: 'ada',
				password: 'typed',
				newPassword: '',
				fields: { username: true, password: true, newPassword: false },
			},
			APP
		);
	});

	it('hears nothing but the window it opened, at the app’s origin', () => {
		const { popup, send, run, input } = page(LOGIN);
		run();

		send(ready, 'https://evil.example');
		send(ready, APP, { postMessage: vi.fn() });
		send(filled('mallory', 'x'), 'https://evil.example');
		send(filled('mallory', 'x'), APP, null);
		send({ ...ready, type: 'other' });

		expect(popup.postMessage).not.toHaveBeenCalled();
		expect(input('#user')?.value).toBe('ada');
	});

	it('fills the login it is sent, as typing would, and then stops listening', () => {
		const { window, send, run, input } = page(LOGIN);
		const heard: string[] = [];
		['input', 'change'].forEach((type) => {
			window.document.addEventListener(type, (event) => {
				heard.push(`${type}:${(event.target as HTMLInputElement).id}`);
			});
		});
		run();

		send(filled('grace', 's3cret'));
		send(filled('mallory', 'x'));

		expect(input('#user')?.value).toBe('grace');
		expect(input('#pw')?.value).toBe('s3cret');
		expect(input('#q')?.value).toBe('');
		expect(heard).toEqual(['input:user', 'change:user', 'input:pw', 'change:pw']);
	});
});

describe('the fields the bookmarklet finds', () => {
	/** The fields its `hello` says it found. */
	const found = (html: string, focus?: string) => {
		const { window, popup, send, run } = page(html);
		if (focus !== undefined) window.document.querySelector<HTMLElement>(focus)?.focus();
		run();
		send(ready);
		return popup.postMessage.mock.calls[0]?.[0] as Record<string, unknown>;
	};

	it('take the username before the password where nothing marks it', () => {
		expect(
			found(`<input name="company" value="acme"><input name="handle" value="ada">
				<input type="password" value="pw"><input name="after" value="no">`)
		).toMatchObject({ username: 'ada', password: 'pw' });
	});

	it('take a field marked username among its other marks, or named for one', () => {
		expect(
			found(`<input value="nope"><input autocomplete="username webauthn" value="ada">
				<input value="nope"><input type="password" value="pw">`)
		).toMatchObject({ username: 'ada' });
		expect(
			found(`<input id="login" value="ada"><input id="other" value="nope">
				<input type="password" value="pw">`)
		).toMatchObject({ username: 'ada' });
	});

	it('take the username alone on a page that asks for it first', () => {
		expect(found(`<input type="email" value="ada@example.com">`)).toMatchObject({
			username: 'ada@example.com',
			password: '',
			fields: { username: true, password: false, newPassword: false },
		});
	});

	it('take a new password apart from the one in use', () => {
		expect(
			found(`<input type="email" autocomplete="email" value="ada@example.com">
				<input type="password" autocomplete="new-password" value="n3w">
				<input type="password" autocomplete="new-password" value="n3w">`)
		).toMatchObject({
			username: 'ada@example.com',
			password: '',
			newPassword: 'n3w',
			fields: { username: true, password: false, newPassword: true },
		});
	});

	it('leave out what is hidden, not drawn, disabled or read only', () => {
		expect(
			found(`<input type="hidden" name="user" value="no">
				<div hidden><input type="password" value="no"></div>
				<input type="password" style="display: none" value="no">
				<input type="password" disabled value="no">
				<input type="password" readonly value="no">
				<input type="password" value="yes">`)
		).toMatchObject({ password: 'yes' });
	});

	it('are the form’s that has the focus, where it holds a password', () => {
		expect(
			found(
				`<form><input id="news" type="email" value="news"><input type="password" value="other"></form>
				<form><input id="me" autocomplete="username" value="ada"><input type="password" value="pw"></form>`,
				'#me'
			)
		).toMatchObject({ username: 'ada', password: 'pw' });
	});
});

describe('a login the bookmarklet fills', () => {
	it('reaches a form React holds, as typing would', () => {
		const seen: string[] = [];
		const Form = () => {
			const [user, setUser] = useState('');
			return (
				<form>
					<input
						aria-label="user"
						autoComplete="username"
						value={user}
						onChange={(event) => {
							seen.push(event.target.value);
							setUser(event.target.value);
						}}
					/>
					<input aria-label="pw" type="password" defaultValue="" />
				</form>
			);
		};
		render(<Form />);
		vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
			{},
		] as unknown as DOMRectList);
		const popup = { postMessage: vi.fn() };
		vi.stubGlobal(
			'open',
			vi.fn(() => popup)
		);
		// Run as the page's own script, in this window: React's, not a fresh one.
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		(new Function(code()) as () => void)();

		act(() => {
			window.dispatchEvent(
				from(
					new MessageEvent('message', { data: filled('grace', 's3cret'), origin: APP }),
					popup
				)
			);
		});

		expect(seen).toEqual(['grace']);
		expect(screen.getByLabelText<HTMLInputElement>('user').value).toBe('grace');
		expect(screen.getByLabelText<HTMLInputElement>('pw').value).toBe('s3cret');
	});
});
