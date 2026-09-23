/**
 * The toolbar's icons, drawn here rather than installed.
 *
 * An icon package would be a dependency for twenty shapes, and the shapes are
 * the conventional ones — a bold "B", a chain link, three dots — so there is
 * nothing to choose between drawing them and importing them except the weight.
 * All of them are one path on a 24-unit grid, stroked in `currentColor`, so a
 * button's own colour and the dark theme reach them without a second rule.
 *
 * Two ways to draw one, because not every button in this app is React: the
 * `Icon` component below, and `iconElement` for the node views, which build
 * their DOM by hand. One list of paths either way.
 */

/** Every name `Icon` will draw, and the path that draws it. */
const PATHS = {
	bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
	italic: 'M18 4h-7M13 20H6M15 4 9 20',
	strike: 'M16 5H9.5a3 3 0 0 0-1.9 5.3M14.5 13A3.5 3.5 0 0 1 13 19.5H8M4 12h16',
	code: 'm15 17 5-5-5-5M9 7l-5 5 5 5',
	'code-block': 'M4 5h16v14H4zM10 10l-2 2 2 2M14 10l2 2-2 2',
	clear: 'M5 6V4h14v2M11 20h5M13 4 9 20M16 15l5 5M21 15l-5 5',
	bullets: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
	numbers: 'M10 6h10M10 12h10M10 18h10M4 5.5 5.5 5v4M4 13.2a1.6 1.6 0 1 1 2.6 1.2L4 17h2.8',
	tasks: 'M11 6h9M11 12h9M11 18h9M3.5 6 5 7.5 8 4.5M3.5 15 5 16.5 8 13.5',
	outdent: 'M10 6h11M10 12h11M10 18h11M7 9l-3 3 3 3',
	indent: 'M10 6h11M10 12h11M10 18h11M4 9l3 3-3 3',
	link: 'M10 17H7.5a5 5 0 0 1 0-10H10M14 7h2.5a5 5 0 0 1 0 10H14M8.5 12h7',
	wrap: 'M4 6h16M4 12h13a3 3 0 0 1 0 6h-6M13 15l-3 3 3 3',
	'line-numbers': 'M4 5v14M9 7h11M9 12h11M9 17h8',
	copy: 'M9 9h10v11H9zM15 9V4H5v11h4',
	trash: 'M4 7h16M10 4h4M6.5 7 7.5 20h9l1-13M10 11v5M14 11v5',
	more: 'M5 12h.01M12 12h.01M19 12h.01',
	// Vertical: the toolbar's overflow, and the options for a note or a notebook.
	// Three solid dots of radius 2, as Material's MoreVert draws them: a circle
	// of radius 1 under the 2-unit stroke every icon here has is filled to the
	// middle. A dot drawn as a zero-length line, as `more` is, is 2 units across
	// and read as barely there at 16px.
	overflow:
		'M11 6a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 18a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
	chevron: 'm6 9.5 6 6 6-6',
	check: 'm5 12.5 4.5 4.5L19 7.5',
	search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
	close: 'M6 6l12 12M18 6 6 18',
	// The note's header: the two editors, the toolbar, and the outline.
	'rich-text': 'M5 7V5h14v2M12 5v14M9 19h6',
	format: 'M6 16 12 4l6 12M8 12h8M4 20h16',
	outline: 'M4 6h16M8 12h12M12 18h8',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof PATHS;

/** What both drawings share, so the two cannot drift apart. */
const SVG_ATTRIBUTES = {
	viewBox: '0 0 24 24',
	width: '16',
	height: '16',
	fill: 'none',
	stroke: 'currentColor',
	'stroke-width': '2',
	'stroke-linecap': 'round',
	'stroke-linejoin': 'round',
	'aria-hidden': 'true',
	focusable: 'false',
} as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The same icon as an element, for the parts of the editor that are node views
 * rather than components — built with `createElementNS` and `setAttribute`
 * rather than assigned as markup, so nothing in this app ever parses a string
 * into DOM.
 */
export const iconElement = (name: IconName): SVGElement => {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'toolbar-icon');
	Object.entries(SVG_ATTRIBUTES).forEach(([attribute, value]) => {
		svg.setAttribute(attribute, value);
	});

	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', PATHS[name]);
	svg.append(path);
	return svg;
};

/**
 * Decorative throughout: every button carries its own name in `aria-label` or
 * in text beside the icon, so an icon announced as well would be said twice.
 */
export const Icon = ({ name }: { name: IconName }) => (
	<svg
		className="toolbar-icon"
		viewBox={SVG_ATTRIBUTES.viewBox}
		width={SVG_ATTRIBUTES.width}
		height={SVG_ATTRIBUTES.height}
		fill={SVG_ATTRIBUTES.fill}
		stroke={SVG_ATTRIBUTES.stroke}
		strokeWidth={SVG_ATTRIBUTES['stroke-width']}
		strokeLinecap={SVG_ATTRIBUTES['stroke-linecap']}
		strokeLinejoin={SVG_ATTRIBUTES['stroke-linejoin']}
		aria-hidden="true"
		focusable="false"
	>
		<path d={PATHS[name]} />
	</svg>
);
