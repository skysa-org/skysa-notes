import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CardEmbed, CardHost } from '../src/components/CardEmbed.js';
import {
	type AttachmentHost,
	NO_ATTACHMENTS,
	type PictureSize,
	type Shown,
	type ShowOptions,
} from '../src/editor/attachHost.js';

/**
 * A picture on a scratch card as its host answers for it (docs/ARCHITECTURE.md
 * §7, "Drawn from a copy"): the thumb asked for, and the room it takes held
 * from before it comes, so the wall does not place the card again when it does.
 */

afterEach(cleanup);

interface Asked {
	readonly href: string;
	readonly options: ShowOptions;
	readonly answer: (shown: Shown) => void;
}

/** A host whose answers the test gives, when it gives them. */
const fakeHost = () => {
	const asked: Asked[] = [];
	const sizes: ((size: PictureSize | undefined) => void)[] = [];
	const listeners = new Set<() => void>();
	const host: AttachmentHost = {
		...NO_ATTACHMENTS,
		show: (href, options) =>
			new Promise((resolve) => {
				asked.push({ href, options, answer: resolve });
			}),
		size: () =>
			new Promise((resolve) => {
				sizes.push(resolve);
			}),
		changed: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const change = () => {
		listeners.forEach((listener) => {
			listener();
		});
	};
	return { host, asked, sizes, change };
};

const drawBay = (host: AttachmentHost, src = 'bay-1a2b3c4d.jpg', note?: string) =>
	render(
		<CardHost.Provider value={note === undefined ? { host } : { host, note }}>
			<CardEmbed embed={{ kind: 'image', src, alt: 'The bay' }} words="The bay" />
		</CardHost.Provider>
	);

const picture = () => {
	const found = document.querySelector<HTMLElement>('.scratch-card-picture');
	if (found === null) throw new Error('no picture');
	return found;
};

const roomOf = (element: HTMLElement) => {
	const room = element.getAttribute('data-room');
	return room === 'sized'
		? {
				width: element.style.getPropertyValue('--card-picture-width'),
				ratio: element.style.getPropertyValue('--card-picture-ratio'),
			}
		: (room ?? undefined);
};

const PHOTO = { width: 4000, height: 3000 };

describe('a picture on a card', () => {
	it('is asked for as the thumb', async () => {
		const { host, asked } = fakeHost();
		drawBay(host);
		await waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		expect(asked[0]?.href).toBe('bay-1a2b3c4d.jpg');
		expect(asked[0]?.options.fit).toBe('thumb');
	});

	it('takes the tallest room a card gives a picture, from the first, until its size is known', async () => {
		const { host, asked, sizes } = fakeHost();
		drawBay(host);
		expect(roomOf(picture())).toBe('tallest');
		expect(picture().textContent).toBe('The bay');
		await waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		sizes[0]?.(undefined);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(roomOf(picture())).toBe('tallest');
	});

	it('takes its room before it comes, where this device knows its size', async () => {
		const { host, asked, sizes } = fakeHost();
		drawBay(host);
		await waitFor(() => {
			expect(sizes).toHaveLength(1);
		});
		sizes[0]?.(PHOTO);
		await waitFor(() => {
			expect(roomOf(picture())).toEqual({ width: '4000px', ratio: '4000 / 3000' });
		});
		// Its words meanwhile, in it.
		expect(picture().textContent).toBe('The bay');
		expect(screen.queryByRole('img')).toBeNull();

		asked[0]?.answer({ state: 'ready', url: 'blob:bay', release: () => undefined, ...PHOTO });
		const drawn = await screen.findByRole('img', { name: 'The bay' });
		expect(drawn.getAttribute('src')).toBe('blob:bay');
		expect(roomOf(picture())).toEqual({ width: '4000px', ratio: '4000 / 3000' });
	});

	it('keeps the tallest room once it comes, where its size was not known before', async () => {
		const { host, asked, sizes } = fakeHost();
		drawBay(host);
		await waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		sizes[0]?.(undefined);
		// Its size said as it comes, one picture among others coming one by one.
		asked[0]?.answer({
			state: 'ready',
			url: 'blob:bay',
			release: () => undefined,
			width: 1200,
			height: 1600,
		});
		await screen.findByRole('img', { name: 'The bay' });
		expect(roomOf(picture())).toBe('tallest');
	});

	it('takes no room once it is not coming, whatever is known later', async () => {
		const { host, asked, sizes } = fakeHost();
		drawBay(host);
		await waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		asked[0]?.answer({ state: 'offline' });
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Its size, read only now: the card is not held open for it.
		sizes[0]?.(PHOTO);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(roomOf(picture())).toBeUndefined();
		expect(picture().textContent).toBe('The bay');
	});

	it('takes its room again once it comes after all', async () => {
		const { host, asked, sizes, change } = fakeHost();
		drawBay(host);
		await waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		sizes[0]?.(PHOTO);
		asked[0]?.answer({ state: 'offline' });
		await waitFor(() => {
			expect(roomOf(picture())).toBeUndefined();
		});

		// The network came back.
		change();
		await waitFor(() => {
			expect(asked).toHaveLength(2);
		});
		asked[1]?.answer({ state: 'ready', url: 'blob:bay', release: () => undefined, ...PHOTO });

		await screen.findByRole('img', { name: 'The bay' });
		expect(roomOf(picture())).toEqual({ width: '4000px', ratio: '4000 / 3000' });
	});

	it('keeps its room whatever an ask it has stopped waiting on says', async () => {
		const { host, asked, change } = fakeHost();
		drawBay(host);
		await waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		// A file arrived with a pull: asked again, and the first ask let go of.
		change();
		await waitFor(() => {
			expect(asked).toHaveLength(2);
		});
		asked[1]?.answer({ state: 'ready', url: 'blob:bay', release: () => undefined, ...PHOTO });
		await screen.findByRole('img', { name: 'The bay' });
		// The first ask, answered last, from before the file was there.
		asked[0]?.answer({ state: 'missing' });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(roomOf(picture())).toBe('tallest');
		expect(screen.getByRole('img', { name: 'The bay' })).toBeDefined();
	});

	it('takes its room from its first frame when drawn again, its size read before', async () => {
		const note = `c1\u0000notes/${crypto.randomUUID()}.md`;
		const first = fakeHost();
		const { unmount } = drawBay(first.host, 'bay-1a2b3c4d.jpg', note);
		await waitFor(() => {
			expect(first.sizes).toHaveLength(1);
		});
		first.sizes[0]?.(PHOTO);
		await waitFor(() => {
			expect(roomOf(picture())).not.toBe('tallest');
		});
		unmount();

		// The scratchpad come back to: nothing read yet, this time.
		drawBay(fakeHost().host, 'bay-1a2b3c4d.jpg', note);

		expect(roomOf(picture())).toEqual({ width: '4000px', ratio: '4000 / 3000' });
	});

	it('takes the size it said as it came, the next time it is drawn', async () => {
		const note = `c1\u0000notes/${crypto.randomUUID()}.md`;
		const first = fakeHost();
		const { unmount } = drawBay(first.host, 'bay-1a2b3c4d.jpg', note);
		await waitFor(() => {
			expect(first.asked).toHaveLength(1);
		});
		first.sizes[0]?.(undefined);
		first.asked[0]?.answer({
			state: 'ready',
			url: 'blob:bay',
			release: () => undefined,
			...PHOTO,
		});
		await screen.findByRole('img', { name: 'The bay' });
		expect(roomOf(picture())).toBe('tallest');
		unmount();

		drawBay(fakeHost().host, 'bay-1a2b3c4d.jpg', note);

		expect(roomOf(picture())).toEqual({ width: '4000px', ratio: '4000 / 3000' });
	});

	it('takes no room for an SVG, which comes as it is', async () => {
		const { host, asked } = fakeHost();
		drawBay(host, 'map-1a2b3c4d.svg');
		expect(roomOf(picture())).toBeUndefined();
		await waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		asked[0]?.answer({
			state: 'ready',
			url: 'data:image/svg+xml,map',
			release: () => undefined,
		});
		await screen.findByRole('img', { name: 'The bay' });
		expect(roomOf(picture())).toBeUndefined();
	});

	it('keeps the tallest room where its size cannot be read', async () => {
		const { host } = fakeHost();
		drawBay({ ...host, size: () => Promise.reject(new Error('gone')) });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(roomOf(picture())).toBe('tallest');
	});

	it('gives its room back when the browser cannot draw it', async () => {
		const { host, asked, sizes } = fakeHost();
		drawBay(host);
		await waitFor(() => {
			expect(asked).toHaveLength(1);
		});
		sizes[0]?.(PHOTO);
		asked[0]?.answer({ state: 'ready', url: 'blob:bay', release: () => undefined, ...PHOTO });
		fireEvent.error(await screen.findByRole('img', { name: 'The bay' }));
		expect(screen.queryByRole('img')).toBeNull();
		expect(roomOf(picture())).toBeUndefined();
		expect(picture().textContent).toBe('The bay');
	});

	it('on the web, is asked nothing of the host', async () => {
		const { host, asked, sizes } = fakeHost();
		drawBay(host, 'https://example.com/bay.jpg');
		await screen.findByRole('img', { name: 'The bay' });
		expect(asked).toHaveLength(0);
		expect(sizes).toHaveLength(0);
		expect(roomOf(picture())).toBeUndefined();
	});
});
