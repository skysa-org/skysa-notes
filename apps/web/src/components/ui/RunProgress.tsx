import { runBar } from '../../sync/progress.js';
import type { SchedulerStatus } from '../../sync/scheduler.js';

/**
 * How far a run has got, drawn: a bar, and under it, lightly, the file it is
 * on. A source's first import shows it (`ImportProgress`), and so do a run's
 * details, opened from the status line (`SyncDetails` in `account/StatusLine.tsx`).
 */

/**
 * How full a run is (`runBar`), or, where it cannot say of how many, the
 * browser's own drawing of not knowing. The status line's bar too (`SyncBar`).
 */
export const RunBar = ({
	bar,
	label,
	className,
}: {
	bar: { value: number; max: number } | null;
	label: string;
	className: string;
}) =>
	bar === null ? (
		<progress className={className} aria-label={label} />
	) : (
		<progress className={className} aria-label={label} value={bar.value} max={bar.max} />
	);

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

/** The bar, and the file the run is on. `label` names the bar. */
export const RunProgress = ({ status, label }: { status: SchedulerStatus; label: string }) => {
	const progress = status.phase === 'syncing' ? status.progress : undefined;
	const path = progress?.path;
	return (
		<>
			<RunBar bar={runBar(progress)} label={label} className="run-bar" />
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
