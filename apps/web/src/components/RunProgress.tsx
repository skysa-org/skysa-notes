import { type SchedulerStatus } from '../sync/scheduler.js';

/**
 * How far a run has got, drawn: a bar, and under it, lightly, the file it is
 * on. A source's first import shows it (`ImportProgress`), and so do a run's
 * details, opened from the status line (`SyncDetails` in `AccountPanel`).
 */

/** How full the bar is, or nothing for a bar that cannot know. */
const fraction = (status: SchedulerStatus): { value: number; max: number } | undefined => {
	const { progress } = status;
	if (status.phase !== 'syncing' || progress === undefined) return undefined;
	if (progress.stage === 'receiving' && progress.listing) return undefined;
	if (progress.stage !== 'scanning') return { value: progress.done, max: progress.total };
	if (progress.listing || progress.found === 0) return undefined;
	return { value: progress.done, max: progress.found };
};

/** How much of a path's end is kept whole when it is cut. */
const KEPT_END = 24;

/**
 * A path too long for its line, cut in the middle: its start says where the
 * file is and its end which file it is, and the end is the half that matters.
 * CSS cuts only the end of a line, so the text is two spans and only the first
 * gives way (`.run-file-start`); a path that fits shows whole. Split by code
 * point, so a character outside the BMP is never cut in half.
 */
const MiddleCut = ({ text }: { text: string }) => {
	const points = [...text];
	const at = Math.max(0, points.length - KEPT_END);
	return (
		<>
			<span className="run-file-start">{points.slice(0, at).join('')}</span>
			<span className="run-file-end">{points.slice(at).join('')}</span>
		</>
	);
};

/**
 * The bar, a fraction or, where the run cannot say of how many, the browser's
 * own drawing of not knowing; and the file it is on. `label` names the bar.
 */
export const RunProgress = ({ status, label }: { status: SchedulerStatus; label: string }) => {
	const path = status.phase === 'syncing' ? status.progress?.path : undefined;
	const bar = fraction(status);
	return (
		<>
			{bar === undefined ? (
				<progress className="run-bar" aria-label={label} />
			) : (
				<progress
					className="run-bar"
					aria-label={label}
					value={bar.value}
					max={Math.max(bar.max, 1)}
				/>
			)}
			{/* Not live: it changes with every file, faster than anyone could
			    listen, and the count above already says how far it has got. A
			    space holds its line, so the buttons do not jump as it comes and
			    goes. */}
			<p className="run-file" title={path}>
				{path === undefined ? ' ' : <MiddleCut text={path} />}
			</p>
		</>
	);
};
