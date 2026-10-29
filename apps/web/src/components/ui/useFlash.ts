import { useCallback, useEffect, useRef, useState } from 'react';

/** How long something said for a moment stays said: a "Copied", a "Saved". */
export const FLASH_MS = 3000;

/**
 * Something said for a moment (`FLASH_MS`), then `nothing` again. Said again
 * before then, the new words get the whole moment; unmounted, nothing is left
 * to clear.
 */
export const useFlash = <T>(nothing: T): readonly [T, (said: T) => void] => {
	const [said, setSaid] = useState<T>(nothing);
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
				setSaid(nothing);
			}, FLASH_MS);
		},
		[nothing]
	);
	return [said, flash] as const;
};
