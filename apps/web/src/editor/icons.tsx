/**
 * The toolbar's icons, drawn here rather than installed.
 *
 * An icon package would be a dependency for twelve shapes, and the shapes are
 * the conventional ones — a bold "B", a chain link, three dots — so there is
 * nothing to choose between drawing them and importing them except the weight.
 * All of them are one path on a 24-unit grid, stroked in `currentColor`, so a
 * button's own colour and the dark theme reach them without a second rule.
 */

/** Every name `Icon` will draw, and the path that draws it. */
const PATHS = {
	bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
	italic: 'M18 4h-7M13 20H6M15 4 9 20',
	strike: 'M16 5H9.5a3 3 0 0 0-1.9 5.3M14.5 13A3.5 3.5 0 0 1 13 19.5H8M4 12h16',
	code: 'm15 17 5-5-5-5M9 7l-5 5 5 5',
	clear: 'M5 6V4h14v2M11 20h5M13 4 9 20M16 15l5 5M21 15l-5 5',
	bullets: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
	numbers: 'M10 6h10M10 12h10M10 18h10M4 5.5 5.5 5v4M4 13.2a1.6 1.6 0 1 1 2.6 1.2L4 17h2.8',
	tasks: 'M11 6h9M11 12h9M11 18h9M3.5 6 5 7.5 8 4.5M3.5 15 5 16.5 8 13.5',
	outdent: 'M10 6h11M10 12h11M10 18h11M7 9l-3 3 3 3',
	indent: 'M10 6h11M10 12h11M10 18h11M4 9l3 3-3 3',
	link: 'M10 17H7.5a5 5 0 0 1 0-10H10M14 7h2.5a5 5 0 0 1 0 10H14M8.5 12h7',
	more: 'M5 12h.01M12 12h.01M19 12h.01',
	chevron: 'm6 9.5 6 6 6-6',
	check: 'm5 12.5 4.5 4.5L19 7.5',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof PATHS;

/**
 * Decorative throughout: every button carries its own name in `aria-label` or
 * in text beside the icon, so an icon announced as well would be said twice.
 */
export const Icon = ({ name }: { name: IconName }) => (
	<svg
		className="toolbar-icon"
		viewBox="0 0 24 24"
		width="16"
		height="16"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		focusable="false"
	>
		<path d={PATHS[name]} />
	</svg>
);
