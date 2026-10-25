import { encodeIdentity } from '@skysa/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RecoveryQr } from '../src/components/RecoveryQr.js';
import { generateIdentity } from '../src/secrets/age.js';
import { readQr } from './qrRead.js';

/**
 * The recovery key as a QR code: what a camera reads from it is the key as
 * age writes it, and nothing else.
 */

describe('the recovery key’s QR code', () => {
	it('reads as the key, exactly as age writes it', () => {
		const text = encodeIdentity(generateIdentity());
		render(<RecoveryQr text={text} />);

		const code = screen.getByRole('img', { name: 'Recovery key as a QR code' });
		expect(readQr(code)).toBe(text);
	});

	it('is dark on white, whatever the theme, with room around it for a reader', () => {
		render(<RecoveryQr text={encodeIdentity(generateIdentity())} />);

		const code = screen.getByRole('img');
		expect(code.querySelector('rect')?.getAttribute('fill')).toBe('#fff');
		expect(code.querySelector('path')?.getAttribute('fill')).toBe('#000');
		// Four modules of white on every side: no square starts in them.
		const size = Number(code.getAttribute('viewBox')?.split(' ')[2]);
		const starts = [
			...(code.querySelector('path')?.getAttribute('d') ?? '').matchAll(/M(\d+) (\d+)/gu),
		].flatMap(([, x = '0', y = '0']) => [Number(x), Number(y)]);
		expect(Math.min(...starts)).toBe(4);
		expect(Math.max(...starts)).toBe(size - 5);
	});
});
