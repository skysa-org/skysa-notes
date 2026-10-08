// Medians and spreads of samples, and the tables that compare targets.

const quantile = (sorted, q) => {
	if (sorted.length === 0) return 0;
	const at = (sorted.length - 1) * q;
	const low = Math.floor(at);
	return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
};

/** `{ metric: [samples] }` to `{ metric: { median, p25, p75, min, max, samples } }`. */
export const summarize = (metrics) =>
	Object.fromEntries(
		Object.entries(metrics).map(([name, samples]) => {
			if (name === 'errors') return [name, samples];
			const sorted = [...samples].sort((a, b) => a - b);
			return [
				name,
				{
					median: quantile(sorted, 0.5),
					p25: quantile(sorted, 0.25),
					p75: quantile(sorted, 0.75),
					min: sorted[0],
					max: sorted.at(-1),
					samples,
				},
			];
		})
	);

const round = (value) =>
	Math.abs(value) >= 100
		? String(Math.round(value))
		: Math.abs(value) >= 10
			? value.toFixed(1)
			: value.toFixed(2);

/** Counts of things the app does, which move by less from run to run than a time does. */
const COUNTS = new Set([
	'idbRows',
	'idbNotes',
	'idbNoteKeys',
	'idbWrites',
	'nodes',
	'drawn',
	'allDrawn',
]);

/** Higher is better for these. */
const MORE = new Set(['drawn', 'allDrawn', 'scrolledPx', 'reachedEnd']);

/** No better or worse for these: they say what a run did, or what it started from. */
const NEUTRAL = new Set(['taps', 'idleRendererMB']);

/** Every sample on both sides the same: nothing to tell from noise. */
const exact = (a, b) => a.min === a.max && b.min === b.max;

/**
 * A's and B's medians, and what the change is: better or worse only when it
 * moved by more than the noise allows — 10% for times and sizes, 5% for
 * counts — and the interquartile ranges do not overlap, unless every sample on
 * each side was the same.
 */
export const verdict = (name, a, b) => {
	if (a === undefined || b === undefined || NEUTRAL.has(name)) return '';
	if (a.median === b.median) return '≈';
	const change = a.median === 0 ? Infinity : (b.median - a.median) / a.median;
	const threshold = COUNTS.has(name) ? 0.05 : 0.1;
	const apart = b.p75 < a.p25 || b.p25 > a.p75;
	if (Math.abs(change) < threshold || !(apart || exact(a, b))) return '≈';
	return change < 0 !== MORE.has(name) ? 'better' : 'worse';
};

/** One row per scenario and metric, one column per target, and the change from the first. */
export const table = (out, { markdown = false } = {}) => {
	const names = Object.keys(out.results);
	const scenarios = [...new Set(names.flatMap((name) => Object.keys(out.results[name])))];
	const rows = [];
	for (const scenario of scenarios) {
		const metrics = [
			...new Set(names.flatMap((name) => Object.keys(out.results[name][scenario] ?? {}))),
		].filter((metric) => metric !== 'errors');
		for (const metric of metrics) {
			const cells = names.map((name) => out.results[name][scenario]?.[metric]);
			const shown = cells.map((cell) =>
				cell === undefined
					? '—'
					: `${round(cell.median)} [${round(cell.p25)}–${round(cell.p75)}]`
			);
			const first = cells[0];
			const changes = cells.slice(1).map((cell) => {
				if (first === undefined || cell === undefined) return '';
				const moved = verdict(metric, first, cell);
				if (first.median === 0) {
					// No percentage of nothing: the change itself.
					const by = cell.median - first.median;
					return `${by >= 0 ? '+' : ''}${round(by)} ${moved}`.trim();
				}
				const pct = ((cell.median - first.median) / first.median) * 100;
				return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% ${moved}`.trim();
			});
			rows.push([scenario, metric, ...shown, ...changes]);
		}
		const errors = names.flatMap((name) =>
			(out.results[name][scenario]?.errors ?? []).map((error) => `${name}: ${error}`)
		);
		if (errors.length > 0) rows.push([scenario, 'errors', errors.join('; ')]);
	}
	const header = [
		'scenario',
		'metric',
		...names,
		...names.slice(1).map((name) => `${name} vs ${names[0]}`),
	];
	if (markdown) {
		return [header, header.map(() => '---'), ...rows]
			.map((row) => `| ${row.join(' | ')} |`)
			.join('\n');
	}
	const widths = header.map((_, at) =>
		Math.max(...[header, ...rows].map((row) => String(row[at] ?? '').length))
	);
	return [header, ...rows]
		.map((row) => row.map((cell, at) => String(cell ?? '').padEnd(widths[at])).join('  '))
		.join('\n');
};
