import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useFileDropGuard } from '../src/components/useFileDropGuard.js';

/**
 * A file dragged over the app where nothing takes it is refused, rather than
 * opened by the browser in place of the app (#187).
 */

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
});

/** jsdom has no `DataTransfer`: the part of one the guard reads and writes. */
const carrying = (types: string[]) => ({ types, dropEffect: 'copy' });

const place = (html: string): HTMLElement => {
	const holder = document.createElement('div');
	holder.innerHTML = html;
	document.body.append(holder);
	return holder;
};

describe('a file dragged over the app', () => {
	it('is refused where nothing takes it, over the drag and at the drop', () => {
		renderHook(useFileDropGuard);
		const sidebar = place('<nav><button>Work</button></nav>').querySelector('button')!;
		const over = carrying(['Files']);

		const moved = fireEvent.dragOver(sidebar, { dataTransfer: over });
		const dropped = fireEvent.drop(sidebar, { dataTransfer: carrying(['Files']) });

		// `fireEvent` answers false for an event whose default was prevented.
		expect([moved, dropped]).toEqual([false, false]);
		expect(over.dropEffect).toBe('none');
	});

	it('is left to an editor, which takes a drop without saying so', () => {
		renderHook(useFileDropGuard);
		const editor = place('<div contenteditable="true"><p>text</p></div>').querySelector('p')!;
		const over = carrying(['Files']);

		expect(fireEvent.dragOver(editor, { dataTransfer: over })).toBe(true);
		expect(over.dropEffect).toBe('copy');
	});

	it('is left alone where something took it first', () => {
		renderHook(useFileDropGuard);
		const target = place('<div>target</div>').firstElementChild!;
		target.addEventListener('dragover', (event) => {
			event.preventDefault();
		});
		const over = carrying(['Files']);

		fireEvent.dragOver(target, { dataTransfer: over });

		expect(over.dropEffect).toBe('copy');
	});

	it('is not what the guard is for when it carries no files', () => {
		renderHook(useFileDropGuard);
		const row = place('<button>Work</button>').firstElementChild!;

		expect(fireEvent.dragOver(row, { dataTransfer: carrying(['text/plain']) })).toBe(true);
	});

	it('is not refused once the app has gone', () => {
		const { unmount } = renderHook(useFileDropGuard);
		unmount();
		const row = place('<button>Work</button>').firstElementChild!;

		expect(fireEvent.dragOver(row, { dataTransfer: carrying(['Files']) })).toBe(true);
	});
});
