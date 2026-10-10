import { useEffect, useState } from 'react';

/**
 * How long a note is read for before what is waiting on it says it is
 * opening: the note pane, or the scratchpad card pressed. A read takes
 * milliseconds, and words that flashed up on every note opened would be noise.
 */
export const OPENING_NOTICE_MS = 500;

/** Whether `OPENING_NOTICE_MS` has gone by since the caller was first drawn. */
export const useOpeningNotice = (): boolean => {
	const [late, setLate] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => {
			setLate(true);
		}, OPENING_NOTICE_MS);
		return () => {
			clearTimeout(timer);
		};
	}, []);
	return late;
};
