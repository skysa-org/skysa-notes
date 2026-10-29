import { render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { useFocusBack } from '../src/components/ui/useFocusBack.js';

/** The focus handed back as a dialog goes (#455), and only where it can go. */

const Taking = () => {
	useFocusBack();
	return null;
};

afterEach(() => {
	vi.restoreAllMocks();
});

it('is not handed to what had it once that has left the page', () => {
	const opener = document.createElement('button');
	document.body.append(opener);
	opener.focus();
	const { unmount } = render(<Taking />);

	opener.remove();
	const focus = vi.spyOn(opener, 'focus');
	unmount();

	expect(focus).not.toHaveBeenCalled();
});
