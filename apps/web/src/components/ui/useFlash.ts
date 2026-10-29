import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * How long something said for a moment stays said: a "Copied" beside a
 * password or over a clipboard item. A dialog's status line is not one; it
 * stays until something else is said.
 */
export const FLASH_MS = 3000;

/**
 * Something said for a moment (`FLASH_MS`), then `nothing` again — the first
 * `nothing` given, so `flash` stays the same function whatever is passed later.
 * Said again before then, the new words get the whole moment; unmounted,
 * nothing is left to clear.
 */
export const useFlash = <T>(nothing: T): readonly [T, (said: T) => void] => {
	const [cleared] = useState<T>(() => nothing);
	const [said, setSaid] = useState<T>(() => nothing);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(
		() => () => {
			clearTimeout(timer.current);
		},
		[]
	);
	const flash = useCallback(
		(next: T) => {
			clearTimeout(timer.current);
			setSaid(next);
			timer.current = setTimeout(() => {
				setSaid(cleared);
			}, FLASH_MS);
		},
		[cleared]
	);
	return [said, flash] as const;
};
